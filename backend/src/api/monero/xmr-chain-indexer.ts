import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import logger from '../../logger';
import { MoneroEventBus } from './monero-event-bus';
import { MoneroApi } from './monero-api';
import { IMoneroApi } from './monero-api.interface';

/**
 * XmrChainIndexer
 *
 * Per-block historical snapshot used to power the upstream mining
 * graphs (block fees, block rewards, block fee-rates, block sizes,
 * hashrate, difficulty). Hydrates from a mix of public sources and
 * persists to a small JSON file so subsequent boots are instant.
 *
 *   xmrchain.net /api/block/:height  →  size, num_txs, reward,
 *                                       totalFees, per-tx fee/byte
 *                                       distribution
 *   monerod      block_header        →  difficulty (xmrchain doesn't
 *                                       expose this)
 *
 * Hashrate is derived as `difficulty / 120` (Monero's 2-minute target
 * blocktime). That's the same definition monerod uses for the
 * `hash_rate` field on /get_info — exact, not an estimate.
 *
 * Storage: an in-memory Map keyed by height + a JSON dump at
 *   ~/.xmr-space/blocks-index.json
 * One sample is ~250 bytes; 1y of hourly samples (~8800 entries) is
 * ~2 MB. Cheaper than a SQLite dependency for what we need.
 *
 * We do NOT store full tx-level detail here. The percentile fields
 * are pre-computed at hydration time so the file stays small even
 * for blocks with hundreds of txs.
 *
 * ## Sampling strategy
 *
 * A naive "fetch every block" backfill is 720 calls/day; over 1y
 * that's 262k calls. Far too many. Instead we sparse-sample at a
 * stride that matches the granularity each graph period needs:
 *
 *   24h view  →  1 sample / 30 blocks  (≈1/hr)   24 samples
 *   1m view   →  1 sample / 30 blocks            720 samples
 *   1y view   →  1 sample / 720 blocks (≈1/day)  365 samples
 *
 * On boot we do the 30-block stride for the last 30 days first
 * (immediate UX), then background-deepen to 1y at the 720 stride.
 *
 * Live updates index every new block (via the bus 'block' event)
 * at full granularity — those are the points that animate.
 */

export interface BlockSample {
  height: number;
  timestamp: number;        // unix seconds (block timestamp)
  hash: string;
  size: number;             // bytes
  numTxs: number;
  reward: number;           // atomic (= base subsidy + total fees)
  totalFees: number;        // atomic
  // Per-tx fee-rate (atomic/byte) distribution. p0 = min, p100 = max.
  // Computed at hydration time so the wire payload stays small.
  feeP0: number;
  feeP10: number;
  feeP25: number;
  feeP50: number;
  feeP75: number;
  feeP90: number;
  feeP100: number;
  difficulty: number;
  hashRate: number;         // difficulty / 120
}

interface XmrChainBlockTx {
  coinbase: boolean;
  tx_fee: number;
  tx_size: number;
  xmr_outputs: number;
}

interface XmrChainBlock {
  block_height: number;
  hash: string;
  size: number;
  timestamp: number;
  txs: XmrChainBlockTx[];
}

const XMRCHAIN_BASE = process.env.XMRCHAIN_BASE_URL ?? 'https://xmrchain.net';
const PERSIST_DIR = process.env.XMR_INDEX_DIR ?? path.join(os.homedir(), '.xmr-space');
const PERSIST_FILE = path.join(PERSIST_DIR, 'blocks-index.json');
const SAMPLE_STRIDE_FAST = 30;      // 30 blocks ≈ 1 hour
const SAMPLE_STRIDE_DEEP = 720;     // 720 blocks ≈ 1 day
const FAST_PASS_DAYS = 30;
const DEEP_PASS_DAYS = 365;
// Concurrency: be a good citizen on xmrchain.net (a free public service)
// and the cakewallet remote daemon. 3 parallel keeps the backfill
// snappy without earning us a rate-limit / TLS-reset.
const BACKFILL_CONCURRENCY = 3;
const PERSIST_INTERVAL_MS = 60_000;
// Retry parameters for individual block hydration. xmrchain and the
// remote daemon both occasionally drop a connection mid-request; one
// retry recovers nearly all of those without slowing the happy path.
const HYDRATE_RETRIES = 2;
const HYDRATE_RETRY_BACKOFF_MS = 750;
// Bulk header range cap (monerod limit is 999).
const HEADERS_RANGE_CAP = 999;

export class XmrChainIndexer {
  private samples: Map<number, BlockSample> = new Map();
  private headerCache: Map<number, IMoneroApi.BlockHeader> = new Map();
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private currentDifficulty = 0;
  private currentHashRate = 0;
  private fetchTip: number = 0;

  constructor(private api: MoneroApi, private bus: MoneroEventBus) {}

  public async start(): Promise<void> {
    await this.loadFromDisk();
    // Live: index every new block as it arrives.
    this.bus.on('block', (header: IMoneroApi.BlockHeader) => {
      void this.hydrateBlock(header.height).catch((err) => {
        logger.warn(`xmr-indexer: live hydrate ${header.height} failed: ${err instanceof Error ? err.message : err}`);
      });
      this.currentDifficulty = header.difficulty;
      this.currentHashRate = header.difficulty / 120;
    });
    // Periodic persist to avoid losing live updates on crash.
    this.persistTimer = setInterval(() => {
      if (this.dirty) void this.persist();
    }, PERSIST_INTERVAL_MS);
    this.persistTimer.unref?.();
    // Kick off backfill in background — don't block server startup.
    void this.backfill().catch((err) => {
      logger.err(`xmr-indexer: backfill aborted: ${err instanceof Error ? err.message : err}`);
    });
  }

  public stop(): void {
    if (this.persistTimer) clearInterval(this.persistTimer);
  }

  /** Snapshot of the indexer state — handy for /healthz and tests. */
  public stats(): { samples: number; minHeight: number; maxHeight: number; currentHashRate: number; currentDifficulty: number } {
    const heights = [...this.samples.keys()];
    return {
      samples: this.samples.size,
      minHeight: heights.length ? Math.min(...heights) : 0,
      maxHeight: heights.length ? Math.max(...heights) : 0,
      currentHashRate: this.currentHashRate,
      currentDifficulty: this.currentDifficulty,
    };
  }

  /** All samples as a sorted-by-height array. Cheap (Map iteration). */
  public allSamples(): BlockSample[] {
    return [...this.samples.values()].sort((a, b) => a.height - b.height);
  }

  /** Subset of samples in the given inclusive time window (unix seconds). */
  public samplesBetween(fromSec: number, toSec: number): BlockSample[] {
    const out: BlockSample[] = [];
    for (const s of this.samples.values()) {
      if (s.timestamp >= fromSec && s.timestamp <= toSec) out.push(s);
    }
    return out.sort((a, b) => a.timestamp - b.timestamp);
  }

  // ---- backfill ----

  private async backfill(): Promise<void> {
    const tipCount = await this.api.getBlockCount();
    const tip = tipCount - 1;
    this.fetchTip = tip;

    // Pre-warm the header cache. monerod's get_block_headers_range
    // returns up to 999 headers per call, so we can collect difficulty
    // for the entire backfill window in a handful of calls instead of
    // one-call-per-height. Saves the cakewallet remote daemon ~720
    // RPC calls during fast pass alone.
    const fastFrom = Math.max(0, tip - (FAST_PASS_DAYS * 720));
    await this.prefetchHeaderDifficulties(fastFrom, tip);

    const fastHeights = this.heightsToSample(fastFrom, tip, SAMPLE_STRIDE_FAST)
      .filter((h) => !this.samples.has(h));

    logger.notice(`xmr-indexer: fast backfill ${fastHeights.length} blocks (${fastFrom}-${tip}, stride ${SAMPLE_STRIDE_FAST})`);
    await this.runBatched(fastHeights);
    logger.notice(`xmr-indexer: fast backfill done; ${this.samples.size} samples held`);
    void this.persist();

    // Retry any heights that failed first time round (transient TLS,
    // throttling). A second pass at lower concurrency usually clears
    // most of them.
    const retryHeights = fastHeights.filter((h) => !this.samples.has(h));
    if (retryHeights.length) {
      logger.notice(`xmr-indexer: retrying ${retryHeights.length} failed fast-pass heights`);
      await this.runBatched(retryHeights);
      void this.persist();
    }

    // Deep pass: last DEEP_PASS_DAYS at SAMPLE_STRIDE_DEEP, skipping
    // anything already covered by the fast pass.
    const deepFrom = Math.max(0, tip - (DEEP_PASS_DAYS * 720));
    await this.prefetchHeaderDifficulties(deepFrom, fastFrom);
    const deepHeights = this.heightsToSample(deepFrom, fastFrom, SAMPLE_STRIDE_DEEP)
      .filter((h) => !this.samples.has(h));

    logger.notice(`xmr-indexer: deep backfill ${deepHeights.length} blocks (${deepFrom}-${fastFrom}, stride ${SAMPLE_STRIDE_DEEP})`);
    await this.runBatched(deepHeights);
    logger.notice(`xmr-indexer: deep backfill done; ${this.samples.size} samples held`);
    void this.persist();
  }

  /**
   * Bulk-fetch BlockHeader objects for every height in the inclusive
   * range and cache them in `this.headerCache`. Subsequent
   * `hydrateBlock` calls read difficulty from the cache instead of
   * issuing per-height RPCs.
   */
  private async prefetchHeaderDifficulties(fromHeight: number, toHeight: number): Promise<void> {
    if (toHeight < fromHeight) return;
    let cur = fromHeight;
    while (cur <= toHeight) {
      const end = Math.min(toHeight, cur + HEADERS_RANGE_CAP - 1);
      try {
        const headers = await this.api.getBlockHeadersRange(cur, end);
        for (const h of headers) this.headerCache.set(h.height, h);
      } catch (err) {
        logger.warn(`xmr-indexer: header range ${cur}-${end} failed: ${err instanceof Error ? err.message : err}`);
      }
      cur = end + 1;
    }
  }

  private heightsToSample(from: number, to: number, stride: number): number[] {
    const out: number[] = [];
    // Anchor on the latest block so the most-recent samples line up
    // with what the dashboard sees, then walk back at stride. This
    // keeps "now" pinned even though the chain keeps growing.
    for (let h = to; h >= from; h -= stride) out.push(h);
    return out;
  }

  private async runBatched(heights: number[]): Promise<void> {
    let i = 0;
    const workers = Array.from({ length: BACKFILL_CONCURRENCY }, async () => {
      while (i < heights.length) {
        const idx = i++;
        const h = heights[idx];
        try {
          await this.hydrateBlock(h);
        } catch (err) {
          logger.warn(`xmr-indexer: skip ${h}: ${err instanceof Error ? err.message : err}`);
        }
      }
    });
    await Promise.all(workers);
  }

  // ---- hydration ----

  /**
   * Fetch a single block's metrics and store the sample.
   * No-ops if the height is already indexed and the data looks valid.
   * Retries transient failures up to HYDRATE_RETRIES times.
   */
  public async hydrateBlock(height: number): Promise<void> {
    if (this.samples.has(height)) return;

    let chainBlock: XmrChainBlock | null = null;
    let header: IMoneroApi.BlockHeader | null = this.headerCache.get(height) ?? null;

    for (let attempt = 0; attempt <= HYDRATE_RETRIES; attempt++) {
      const tasks: Promise<unknown>[] = [];
      if (!chainBlock) tasks.push(this.fetchXmrchainBlock(height).then((b) => { chainBlock = b; }));
      if (!header) tasks.push(this.api.getBlockByHeight(height).then((b) => { header = b.block_header; }).catch(() => undefined));
      await Promise.all(tasks);
      if (chainBlock && header) break;
      if (attempt < HYDRATE_RETRIES) {
        await sleep(HYDRATE_RETRY_BACKOFF_MS * (attempt + 1));
      }
    }

    if (!chainBlock || !header) {
      throw new Error(`incomplete data for height ${height}`);
    }

    const txs = chainBlock.txs ?? [];
    const coinbase = txs.find((t) => t.coinbase);
    const nonCoinbase = txs.filter((t) => !t.coinbase);
    const reward = coinbase?.xmr_outputs ?? header.reward ?? 0;
    const totalFees = nonCoinbase.reduce((acc, t) => acc + (t.tx_fee ?? 0), 0);

    // Per-tx fee/byte rate distribution — used by the fee-rates graph.
    // Coinbase has no fee, exclude. Empty blocks (only coinbase) → all 0.
    const rates = nonCoinbase
      .filter((t) => t.tx_size > 0)
      .map((t) => t.tx_fee / t.tx_size)
      .sort((a, b) => a - b);

    const sample: BlockSample = {
      height,
      timestamp: chainBlock.timestamp ?? header.timestamp,
      hash: chainBlock.hash ?? header.hash,
      size: chainBlock.size ?? header.block_size ?? 0,
      numTxs: txs.length - (coinbase ? 1 : 0),
      reward,
      totalFees,
      feeP0: percentile(rates, 0),
      feeP10: percentile(rates, 0.10),
      feeP25: percentile(rates, 0.25),
      feeP50: percentile(rates, 0.50),
      feeP75: percentile(rates, 0.75),
      feeP90: percentile(rates, 0.90),
      feeP100: percentile(rates, 1.0),
      difficulty: header.difficulty,
      hashRate: header.difficulty / 120,
    };

    this.samples.set(height, sample);
    this.dirty = true;
    if (height > this.fetchTip) {
      this.fetchTip = height;
      this.currentDifficulty = sample.difficulty;
      this.currentHashRate = sample.hashRate;
    }
  }

  private async fetchXmrchainBlock(height: number): Promise<XmrChainBlock | null> {
    const url = `${XMRCHAIN_BASE}/api/block/${height}`;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      const body = await res.json() as { data?: XmrChainBlock; status?: string };
      if (!body || body.status === 'error' || !body.data) return null;
      return body.data;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---- persistence ----

  private async loadFromDisk(): Promise<void> {
    try {
      const raw = await fs.readFile(PERSIST_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as { samples: BlockSample[]; currentDifficulty?: number; currentHashRate?: number };
      for (const s of parsed.samples ?? []) this.samples.set(s.height, s);
      this.currentDifficulty = parsed.currentDifficulty ?? 0;
      this.currentHashRate = parsed.currentHashRate ?? 0;
      logger.notice(`xmr-indexer: loaded ${this.samples.size} samples from ${PERSIST_FILE}`);
    } catch (err: unknown) {
      // First run: no file yet. Anything else is logged but not fatal —
      // we'll just rebuild the index from scratch.
      const e = err as NodeJS.ErrnoException;
      if (e?.code !== 'ENOENT') {
        logger.warn(`xmr-indexer: load failed (${e?.code ?? e?.message}); starting fresh`);
      }
    }
  }

  private async persist(): Promise<void> {
    if (!this.dirty) return;
    try {
      await fs.mkdir(PERSIST_DIR, { recursive: true });
      const tmp = PERSIST_FILE + '.tmp';
      const payload = JSON.stringify({
        version: 1,
        savedAt: Math.floor(Date.now() / 1000),
        currentDifficulty: this.currentDifficulty,
        currentHashRate: this.currentHashRate,
        samples: this.allSamples(),
      });
      await fs.writeFile(tmp, payload);
      await fs.rename(tmp, PERSIST_FILE);
      this.dirty = false;
    } catch (err) {
      logger.warn(`xmr-indexer: persist failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Linear-interpolated percentile on a pre-sorted array. Returns 0 for empty. */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[sorted.length - 1];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
