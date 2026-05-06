import { Application, Request, Response } from 'express';
import { handleError } from '../../utils/api';
import { BlockSample, XmrChainIndexer } from './xmr-chain-indexer';

/**
 * Mining/historical-graph REST surface, served from the in-memory
 * XmrChainIndexer. Mirrors the upstream mempool.space `/api/v1/mining/*`
 * URL shapes so the existing Angular graph components render without
 * retargeting their request signatures or response parsers.
 *
 * What's powered (what the Monero chain actually exposes):
 *   - blocks/fees           ← totalFees per block (xmrchain)
 *   - blocks/rewards        ← coinbase out per block (xmrchain)
 *   - blocks/fee-rates      ← per-tx fee/byte percentiles per block
 *   - blocks/sizes-weights  ← block size (weight == size on Monero)
 *   - hashrate              ← difficulty / 120
 *   - difficulty-adjustments→ rolling per-period difficulty deltas
 *
 * What's NOT powered (deliberately 200-empty):
 *   - pools, hashrate/pools, pool/* — Monero has no canonical
 *     pool tagging in coinbase txs. These return the empty shape
 *     the upstream consumer expects so the dropdowns don't error.
 */

const PERIODS: Record<string, number> = {
  '24h':  1 * 24 * 60 * 60,
  '3d':   3 * 24 * 60 * 60,
  '1w':   7 * 24 * 60 * 60,
  '1m':  30 * 24 * 60 * 60,
  '3m':  90 * 24 * 60 * 60,
  '6m': 180 * 24 * 60 * 60,
  '1y': 365 * 24 * 60 * 60,
  '2y': 730 * 24 * 60 * 60,
  '3y':1095 * 24 * 60 * 60,
  'all': Number.MAX_SAFE_INTEGER,
};

// Target sample density per graph view. Aggregating to ~120 buckets
// keeps the chart readable without overwhelming echarts.
const TARGET_BUCKETS = 120;

export class XmrMiningRoutes {
  constructor(
    private indexer: XmrChainIndexer,
    private prefix = '/api/v1/',
  ) {}

  public initRoutes(app: Application): void {
    const p = this.prefix;

    // Hashrate + difficulty time series — graphs/mining/hashrate-difficulty.
    app.get(p + 'mining/hashrate/:period', (req, res) => this.hashrate(req, res));
    app.get(p + 'mining/hashrate', (req, res) => this.hashrate(req, res));
    // Pool-aware hashrate breakdown isn't possible on Monero — return
    // a degraded shape that satisfies the consumer (empty pools array,
    // current network total).
    app.get(p + 'mining/hashrate/pools/:period', (req, res) => this.hashratePools(req, res));
    app.get(p + 'mining/hashrate/pools', (req, res) => this.hashratePools(req, res));

    // Per-block aggregates — one entry per time bucket.
    app.get(p + 'mining/blocks/fees/:period', (req, res) => this.blockFees(req, res));
    app.get(p + 'mining/blocks/rewards/:period', (req, res) => this.blockRewards(req, res));
    app.get(p + 'mining/blocks/fee-rates/:period', (req, res) => this.blockFeeRates(req, res));
    app.get(p + 'mining/blocks/sizes-weights/:period', (req, res) => this.blockSizesWeights(req, res));

    // Difficulty-adjustments table on graphs/mining/hashrate-difficulty.
    app.get(p + 'mining/difficulty-adjustments', (req, res) => this.difficultyAdjustments(req, res));
    app.get(p + 'mining/difficulty-adjustments/:period', (req, res) => this.difficultyAdjustments(req, res));

    // Mining-pool surface — empty payloads to keep upstream subscribers alive.
    // Note: more specific routes that exist elsewhere (mining/pools/:period
    // in monero.routes) take precedence due to registration order.
    app.get(p + 'mining/pools', (_req, res) => res.json({ pools: [] }));
    app.get(p + 'mining/blocks/predictions/:period', (_req, res) => res.json({}));
    app.get(p + 'mining/blocks/predictions', (_req, res) => res.json({}));
    // Reward stats + audit endpoints — we don't audit; return zero.
    app.get(p + 'mining/reward-stats/:blockCount', (_req, res) => res.json({
      startBlock: 0, endBlock: 0, totalReward: 0, totalFee: 0, totalTx: 0,
    }));
  }

  // ---- handlers ----

  private hashrate(req: Request, res: Response): void {
    try {
      const samples = this.windowFor(req);
      const stats = this.indexer.stats();
      const series = this.bucketAvg(samples, (s) => s.hashRate, 'hashRate');
      const diff = this.bucketAvg(samples, (s) => s.difficulty, 'difficulty');

      res.json({
        oldestIndexedBlockTimestamp: samples[0]?.timestamp ?? 0,
        currentHashrate: stats.currentHashRate || (samples.at(-1)?.hashRate ?? 0),
        currentDifficulty: stats.currentDifficulty || (samples.at(-1)?.difficulty ?? 0),
        hashrates: series.map((b) => ({
          timestamp: b.timestamp,
          avgHashrate: b.value,
          avgHeight: b.avgHeight,
        })),
        difficulty: diff.map((b) => ({
          timestamp: b.timestamp,
          difficulty: b.value,
          height: b.avgHeight,
          adjustment: 0,           // Monero retargets every block — adjustment is per-block only
        })),
      });
    } catch (err) {
      handleError(req, res, 500, err instanceof Error ? err.message : 'hashrate failed');
    }
  }

  private hashratePools(req: Request, res: Response): void {
    const stats = this.indexer.stats();
    res.json({
      oldestIndexedBlockTimestamp: 0,
      pools: [],
      hashrates: [],
      difficulty: [],
      currentHashrate: stats.currentHashRate,
      currentDifficulty: stats.currentDifficulty,
    });
  }

  private blockFees(req: Request, res: Response): void {
    const samples = this.windowFor(req);
    const buckets = this.bucketAvg(samples, (s) => s.totalFees, 'fees');
    res.json(buckets.map((b) => ({
      timestamp: b.timestamp,
      avgFees: b.value,
      avgHeight: b.avgHeight,
      // Fiat columns are blank — we don't have a historical price feed.
      USD: 0, EUR: 0, GBP: 0, CAD: 0, CHF: 0, AUD: 0, JPY: 0,
    })));
  }

  private blockRewards(req: Request, res: Response): void {
    const samples = this.windowFor(req);
    const buckets = this.bucketAvg(samples, (s) => s.reward, 'rewards');
    res.json(buckets.map((b) => ({
      timestamp: b.timestamp,
      avgRewards: b.value,
      avgHeight: b.avgHeight,
      USD: 0, EUR: 0, GBP: 0, CAD: 0, CHF: 0, AUD: 0, JPY: 0,
    })));
  }

  private blockFeeRates(req: Request, res: Response): void {
    const samples = this.windowFor(req);
    // Aggregate fee percentiles by averaging each percentile across
    // the bucket. Pre-computed percentiles per block are good enough —
    // we don't need to re-percentile across all txs in the window.
    const buckets = this.bucketGrouped(samples, (group) => ({
      avgFee_0:   avg(group.map((s) => s.feeP0)),
      avgFee_10:  avg(group.map((s) => s.feeP10)),
      avgFee_25:  avg(group.map((s) => s.feeP25)),
      avgFee_50:  avg(group.map((s) => s.feeP50)),
      avgFee_75:  avg(group.map((s) => s.feeP75)),
      avgFee_90:  avg(group.map((s) => s.feeP90)),
      avgFee_100: avg(group.map((s) => s.feeP100)),
    }));
    res.json(buckets.map((b) => ({
      timestamp: b.timestamp,
      avgHeight: b.avgHeight,
      ...b.value,
    })));
  }

  private blockSizesWeights(req: Request, res: Response): void {
    const samples = this.windowFor(req);
    // weight == size on Monero (no segwit). Upstream chart subtracts
    // weight/4 from size to plot a "discount" line — that line will be
    // flat at size*0.75 here, which is the honest reading.
    const sizes = this.bucketAvg(samples, (s) => s.size, 'size');
    res.json({
      sizes: sizes.map((b) => ({
        timestamp: b.timestamp,
        avgSize: b.value,
        avgHeight: b.avgHeight,
      })),
      weights: sizes.map((b) => ({
        timestamp: b.timestamp,
        avgWeight: b.value,
        avgHeight: b.avgHeight,
      })),
    });
  }

  private difficultyAdjustments(req: Request, res: Response): void {
    const samples = this.windowFor(req);
    // Each entry: [timestamp, height, difficulty, adjustment%].
    // Monero retargets every block, so each sample IS an adjustment.
    let prev: BlockSample | undefined;
    const out: [number, number, number, number][] = [];
    for (const s of samples) {
      const adj = prev && prev.difficulty > 0
        ? (s.difficulty - prev.difficulty) / prev.difficulty
        : 0;
      out.push([s.timestamp, s.height, s.difficulty, adj]);
      prev = s;
    }
    res.json(out);
  }

  // ---- helpers ----

  private windowFor(req: Request): BlockSample[] {
    const period = req.params['period'] ?? '24h';
    const seconds = PERIODS[period] ?? PERIODS['24h'];
    const now = Math.floor(Date.now() / 1000);
    return this.indexer.samplesBetween(now - seconds, now);
  }

  /** Bucket samples into ~TARGET_BUCKETS time bins and average a single field. */
  private bucketAvg(samples: BlockSample[], pick: (s: BlockSample) => number, _field: string): { timestamp: number; value: number; avgHeight: number }[] {
    return this.bucketGrouped(samples, (group) => avg(group.map(pick))).map((b) => ({
      timestamp: b.timestamp,
      value: b.value as number,
      avgHeight: b.avgHeight,
    }));
  }

  /** Same as bucketAvg but the reducer can produce an arbitrary object. */
  private bucketGrouped<T>(samples: BlockSample[], reduce: (group: BlockSample[]) => T): { timestamp: number; avgHeight: number; value: T }[] {
    if (!samples.length) return [];
    const tFrom = samples[0].timestamp;
    const tTo = samples[samples.length - 1].timestamp;
    const span = Math.max(1, tTo - tFrom);
    const bucketSize = Math.max(60, Math.ceil(span / TARGET_BUCKETS));

    const buckets = new Map<number, BlockSample[]>();
    for (const s of samples) {
      const key = Math.floor((s.timestamp - tFrom) / bucketSize);
      const arr = buckets.get(key) ?? [];
      arr.push(s);
      buckets.set(key, arr);
    }
    const out: { timestamp: number; avgHeight: number; value: T }[] = [];
    for (const [key, group] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      out.push({
        timestamp: tFrom + key * bucketSize + Math.floor(bucketSize / 2),
        avgHeight: Math.round(avg(group.map((g) => g.height))),
        value: reduce(group),
      });
    }
    return out;
  }
}

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
