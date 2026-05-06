import { Application, Request, Response } from 'express';
import { handleError } from '../../utils/api';
import logger from '../../logger';
import { MoneroApi } from './monero-api';
import { IMoneroApi } from './monero-api.interface';

const HEX64 = /^[a-f0-9]{64}$/i;
const MAX_RECENT_BLOCKS = 25;

/**
 * REST surface for the Monero side of xmr-space. Mirrors mempool.space's
 * `/api/v1/*` URL shapes where the data is meaningfully comparable, and
 * deliberately omits routes that don't translate (address balance,
 * scripthash, UTXO endpoints, RBF, accelerator).
 *
 * All responses return ONLY public chain data — no amounts, no recipients.
 * Recipient/amount disclosure happens client-side in the frontend's reveal
 * flows; the server never sees keys.
 */
export class MoneroRoutes {
  constructor(private api: MoneroApi, private prefix = '/api/v1/') {}

  public initRoutes(app: Application): void {
    app
      .get(this.prefix + 'info', (req, res) => this.getInfo(req, res))
      .get(this.prefix + 'blocks', (req, res) => this.getRecentBlocks(req, res))
      // /api/v1/blocks/:height — N blocks ending at :height (newest
      // first). Mirrors mempool.space's pagination style. Used by the
      // /blocks list page.
      .get(this.prefix + 'blocks/:height', (req, res) => this.getBlocksFromHeight(req, res))
      .get(this.prefix + 'block/:hash', (req, res) => this.getBlock(req, res))
      // /api/v1/block/:hash/summary — per-tx stripped data for the
      // upstream BlockComponent's WebGL tile visualization. Returns
      // the same TransactionStripped[] shape upstream expects:
      //   [{ txid, fee, vsize, value, rate, flags, time, acc }, …]
      .get(this.prefix + 'block/:hash/summary', (req, res) => this.getBlockSummary(req, res))
      // Audit endpoint always 404 — Bitcoin-only feature; the upstream
      // BlockComponent is OK with a missing audit and just hides the
      // 'Expected vs Actual' comparison.
      .get(this.prefix + 'block/:hash/audit-summary', (_req, res) => res.status(404).json({ error: 'audit not available on Monero' }))
      // /api/v1/tx/:hash returns the upstream Bitcoin-shape Transaction
      // (txid + vin + vout + status). The dev-server proxy rewrites
      // /api/tx/* to /api/v1/tx/* so this single route serves both
      // electrsApiService.getTransaction$ (which hits /api/tx/) and
      // direct /api/v1/tx/ consumers. The old Monero-shape response
      // was used by our deprecated XmrTxDetail; that module now lives
      // on disk only, no live consumer reads it.
      .get(this.prefix + 'tx/:hash', (req, res) => this.getTxBitcoinShape(req, res))
      .get(this.prefix + 'mempool', (req, res) => this.getMempool(req, res))
      .get(this.prefix + 'fees/recommended', (req, res) => this.getFeesRecommended(req, res));

    // Upstream's electrs-style endpoint — used by BlockComponent to
    // resolve a height-based deep-link to a block hash. Plain-text
    // response; the upstream client requests it via responseType: 'text'.
    app.get('/api/block-height/:height', (req, res) => this.getBlockHashByHeight(req, res));
    // Paginated tx list for a block. Upstream TransactionsList expects
    // Bitcoin-shape Transaction[] (txid + vin + vout + status). We
    // populate what we can publicly: txid, fee, size, weight, status,
    // and synthetic vin/vout entries that flag RingCT-hidden values
    // so upstream's vin/vout decoder doesn't crash on empty arrays.
    app.get('/api/block/:hash/txs/:index', (req, res) => this.getBlockTxsByPage(req, res, false));
    app.get('/api/block/:hash/txs', (req, res) => this.getBlockTxsByPage(req, res, false));
    // Also handle the v1 prefix the master-page-preview uses.
    app.get(this.prefix + 'block/:hash/txs/:index', (req, res) => this.getBlockTxsByPage(req, res, false));
    app.get(this.prefix + 'block/:hash/txs', (req, res) => this.getBlockTxsByPage(req, res, false));

    // /api/tx/:txid is rewritten by the dev-server proxy to
    // /api/v1/tx/:txid, so the route above serves both. Keeping a
    // direct registration as a no-op safety net for any deployment
    // that doesn't use that proxy rewrite (production nginx may
    // forward unrewritten).
    app.get('/api/tx/:txid', (req, res) => this.getTxBitcoinShape(req, res));
    // Hex blob — required by some upstream tools but irrelevant for us;
    // return a small empty hex blob to satisfy 200 expectations.
    app.get('/api/tx/:txid/hex', (_req, res) => res.type('text/plain').send(''));
    // /api/v1/transaction-times — array of receive_time per txid request.
    app.get(this.prefix + 'transaction-times', (req, res) => this.getTransactionTimes(req, res));
    // CPFP info — Bitcoin-only (child-pays-for-parent fee strategy).
    // Return an empty struct so upstream's CPFP panel hides itself.
    app.get(this.prefix + 'cpfp/:txid', (_req, res) => res.json({ ancestors: [], descendants: [], bestDescendant: null, sigops: 0, adjustedVsize: 0, effectiveFeePerVsize: 0 }));
    // RBF history endpoints — Bitcoin-only. Return null so the upstream
    // RBF panel doesn't render any timeline.
    app.get(this.prefix + 'tx/:txid/rbf', (_req, res) => res.status(204).end());
    app.get(this.prefix + 'tx/:txid/cached', (_req, res) => res.status(204).end());
    // Outspends — was this output spent? On Monero we can't tell without
    // wallet keys; always return null entries so upstream's "spent / unspent"
    // labels don't render misleading state.
    app.get('/api/tx/:txid/outspends', (_req, res) => res.json([]));
    app.get('/api/tx/:txid/outspend/:vout', (_req, res) => res.status(204).end());
    // Stubs for upstream endpoints we haven't built and probably won't:
    // historical XMR/USD price feed (out of scope), mining-pool ranking
    // (we don't index pools), accelerator endpoints. Returning 200 with
    // empty / null payloads keeps the upstream component subscriptions
    // alive without spamming console errors.
    app.get(this.prefix + 'historical-price', (_req, res) => res.json([]));
    app.get(this.prefix + 'mining/pools/:period', (_req, res) => res.json({ pools: [] }));
    app.get(this.prefix + 'mining/pool/:slug', (_req, res) => res.json(null));
    app.get(this.prefix + 'difficulty-adjustment', (_req, res) => res.json({
      progressPercent: 100, difficultyChange: 0, estimatedRetargetDate: Date.now(),
      remainingBlocks: 0, remainingTime: 0, previousRetarget: 0,
      nextRetargetHeight: 0, timeAvg: 120_000, adjustedTimeAvg: 120_000,
      timeOffset: 0, expectedBlocks: 0,
    }));
    app.get(this.prefix + 'accelerations', (_req, res) => res.json([]));
    app.get(this.prefix + 'accelerator', (_req, res) => res.json({ enabled: false }));
  }

  /** GET /api/v1/transaction-times — first-seen timestamps for the given txids. */
  private async getTransactionTimes(req: Request, res: Response): Promise<void> {
    const raw = req.query['txId[]'];
    const arr: unknown[] = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
    const list: string[] = arr.filter((x): x is string => typeof x === 'string');
    if (list.length === 0) {
      res.json([]);
      return;
    }
    try {
      const pool = await this.api.getTransactionPool();
      const lookup = new Map((pool.transactions ?? []).map((t) => [t.id_hash, t.receive_time || 0]));
      // For confirmed txs we don't track first-seen separately; return 0
      // (frontend treats 0 as "unknown" and falls back to block time).
      res.json(list.map((id) => lookup.get(id) ?? 0));
    } catch {
      res.json(list.map(() => 0));
    }
  }

  /** GET /api/tx/:txid — single tx in upstream Bitcoin-shape. */
  private async getTxBitcoinShape(req: Request, res: Response): Promise<void> {
    // Both route patterns hit this handler: /api/v1/tx/:hash uses :hash,
    // /api/tx/:txid uses :txid. Accept either param name.
    const txid = req.params.txid ?? req.params.hash;
    if (!txid || !HEX64.test(txid)) {
      handleError(req, res, 400, 'invalid tx hash');
      return;
    }
    try {
      // Mempool first.
      const pool = await this.api.getTransactionPool();
      const inMempool = pool.transactions?.find((t) => t.id_hash === txid);
      if (inMempool) {
        res.json({
          txid,
          version: 2,
          locktime: 0,
          size: inMempool.weight,
          weight: inMempool.weight,
          fee: inMempool.fee,
          vin: [{ is_coinbase: false, ringct: true, prevout: null, scriptsig: '', sequence: 0, witness: [] }],
          vout: [{ ringct: true, value: 0, scriptpubkey: '', scriptpubkey_address: '', scriptpubkey_type: 'ringct' }],
          status: { confirmed: false },
          firstSeen: inMempool.receive_time || 0,
        });
        return;
      }
      // Confirmed via /get_transactions.
      const confirmed = await this.api.getTransactionByHash(txid);
      if (!confirmed) {
        handleError(req, res, 404, 'tx not found');
        return;
      }
      // Parse the as_json payload to grab vin/vout counts + fee.
      let parsed: IMoneroApi.TransactionJson | null = null;
      try {
        parsed = confirmed.as_json ? JSON.parse(confirmed.as_json) as IMoneroApi.TransactionJson : null;
      } catch { /* keep null */ }
      const fee = parsed?.rct_signatures?.txnFee ?? 0;
      const blobBytes = confirmed.pruned_as_hex
        ? Math.floor(confirmed.pruned_as_hex.length / 2)
        : confirmed.as_hex
          ? Math.floor(confirmed.as_hex.length / 2)
          : 0;
      const numInputs = parsed?.vin?.length ?? 1;
      const numOutputs = parsed?.vout?.length ?? 1;
      const blockHeight = confirmed.block_height ?? 0;
      const blockTimestamp = confirmed.block_timestamp ?? 0;
      // Resolve block hash for status.
      let blockHash = '';
      if (blockHeight > 0) {
        const b = await this.api.getBlockByHeight(blockHeight).catch(() => null);
        blockHash = b?.block_header.hash ?? '';
      }
      res.json({
        txid,
        version: parsed?.version ?? 2,
        locktime: parsed?.unlock_time ?? 0,
        size: blobBytes,
        weight: blobBytes,
        fee,
        // One vin per Monero input — helps the upstream input decoder
        // render a row per ring rather than a single placeholder.
        vin: Array.from({ length: numInputs }, (_, i) => ({
          is_coinbase: false,
          ringct: true,
          ring_size: parsed?.vin?.[i]?.key?.key_offsets?.length ?? null,
          key_image: parsed?.vin?.[i]?.key?.k_image ?? '',
          ring_offsets: parsed?.vin?.[i]?.key?.key_offsets ?? [],
          prevout: null,
          scriptsig: '',
          sequence: 0,
          witness: [],
        })),
        vout: Array.from({ length: numOutputs }, () => ({
          ringct: true,
          value: 0,
          scriptpubkey: '',
          scriptpubkey_address: '',
          scriptpubkey_type: 'ringct',
        })),
        status: {
          confirmed: true,
          block_height: blockHeight,
          block_hash: blockHash,
          block_time: blockTimestamp,
        },
        // Monero-only extras the upstream component will ignore but
        // our reveal-flow shim can read.
        rct_type: parsed?.rct_signatures?.type ?? null,
      });
    } catch (err) {
      logger.err(`xmr getTxBitcoinShape failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /**
   * GET /api/block/:hash/txs/:index — page of transactions in this
   * block. Upstream's electrs-style pagination: 25 per page, index 0
   * is the first 25, index 25 the next, and so on.
   *
   * Response shape mirrors Bitcoin's Transaction interface enough that
   * the upstream TransactionsList renders cleanly:
   *   { txid, version, locktime, fee, size, weight, vin[], vout[], status }
   * vin/vout are populated with synthetic single-entry placeholders
   * tagged 'ringct' so consumers can't decode amounts but don't crash
   * on empty arrays either.
   */
  private async getBlockTxsByPage(req: Request, res: Response, _useV1: boolean): Promise<void> {
    const hash = req.params.hash;
    if (!HEX64.test(hash)) {
      handleError(req, res, 400, 'invalid block hash');
      return;
    }
    const index = Math.max(0, Number(req.params.index ?? 0));
    if (!Number.isFinite(index)) {
      handleError(req, res, 400, 'invalid index');
      return;
    }
    try {
      const block = await this.api.getBlockByHash(hash);
      const blockTime = block.block_header.timestamp;
      const blockHeight = block.block_header.height;
      const tipCount = await this.api.getBlockCount();
      const confirmations = tipCount - blockHeight;
      // Tx list including coinbase first (matches upstream).
      const allHashes = [block.miner_tx_hash, ...(block.tx_hashes ?? [])];
      const PAGE = 25;
      const sliceHashes = allHashes.slice(index, index + PAGE);
      const stripped = sliceHashes.length
        ? await this.api.getBlockStrippedTxs(block.block_header.hash, sliceHashes, blockTime)
            .catch(() => [] as Awaited<ReturnType<typeof this.api.getBlockStrippedTxs>>)
        : [];
      // Build txs in upstream Transaction shape.
      const out = sliceHashes.map((h, i) => {
        const isCoinbase = i === 0 && index === 0;
        const stat = stripped.find((s) => s.txid === h);
        const fee = isCoinbase ? 0 : stat?.fee ?? 0;
        const size = stat?.vsize ?? 0;
        return {
          txid: h,
          version: 2,
          locktime: 0,
          size,
          weight: size,
          fee,
          // Synthetic vin/vout — we don't know the real input ring or
          // output addresses without keys. Each entry is a placeholder
          // tagged with `ringct: true` so consumers know to render
          // 'hidden' rather than '0'.
          vin: stat
            ? Array.from({ length: 1 }, () => ({
                is_coinbase: isCoinbase,
                ringct: true,
                prevout: null,
                scriptsig: '',
                sequence: 0,
                witness: [],
              }))
            : [],
          vout: stat
            ? Array.from({ length: 1 }, () => ({
                ringct: true,
                value: 0,
                scriptpubkey: '',
                scriptpubkey_address: '',
                scriptpubkey_type: 'ringct',
              }))
            : [],
          status: {
            confirmed: true,
            block_height: blockHeight,
            block_hash: block.block_header.hash,
            block_time: blockTime,
          },
          confirmations,
        };
      });
      res.json(out);
    } catch (err) {
      logger.err(`xmr getBlockTxsByPage failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /** GET /api/v1/block/:hash/summary — stripped txs for WebGL viz. */
  private async getBlockSummary(req: Request, res: Response): Promise<void> {
    const hash = req.params.hash;
    if (!HEX64.test(hash)) {
      handleError(req, res, 400, 'invalid block hash');
      return;
    }
    try {
      const block = await this.api.getBlockByHash(hash);
      const txHashes = block.tx_hashes ?? [];
      const stripped = txHashes.length
        ? await this.api.getBlockStrippedTxs(block.block_header.hash, txHashes, block.block_header.timestamp)
        : [];
      res.json(stripped);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found|invalid|hash/i.test(msg)) {
        handleError(req, res, 404, 'block not found');
        return;
      }
      logger.err(`xmr getBlockSummary failed: ${msg}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /** GET /api/block-height/:height — text response, just the hash. */
  private async getBlockHashByHeight(req: Request, res: Response): Promise<void> {
    const requested = Number(req.params.height);
    if (!Number.isFinite(requested) || requested < 0) {
      handleError(req, res, 400, 'invalid height');
      return;
    }
    try {
      const block = await this.api.getBlockByHeight(requested);
      res.type('text/plain').send(block.block_header.hash);
    } catch (err) {
      logger.err(`xmr getBlockHashByHeight failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /**
   * GET /api/v1/blocks/:height — return up to 25 block headers ending at
   * (and including) the requested height, newest first. If the height
   * exceeds the chain tip we clamp to the tip. Used by the /blocks list
   * page for pagination.
   */
  private async getBlocksFromHeight(req: Request, res: Response): Promise<void> {
    const requested = Number(req.params.height);
    if (!Number.isFinite(requested) || requested < 0) {
      handleError(req, res, 400, 'invalid height');
      return;
    }
    try {
      const tipCount = await this.api.getBlockCount();
      const tipHeight = tipCount - 1;
      const startHeight = Math.min(requested, tipHeight);
      const heights: number[] = [];
      for (let i = 0; i < MAX_RECENT_BLOCKS; i++) {
        const h = startHeight - i;
        if (h < 0) break;
        heights.push(h);
      }
      const blocks = await Promise.all(heights.map((h) => this.api.getBlockByHeight(h)));
      // Same upstream-compat extras envelope as getRecentBlocks.
      const shaped = await Promise.all(blocks.map(async (b) => {
        const fees = b.tx_hashes?.length
          ? await this.api.getBlockFeeStats(b.block_header.hash, b.tx_hashes).catch(() => null)
          : null;
        return {
          ...this.shapeBlockHeader(b.block_header, b.tx_hashes?.length),
          extras: {
            reward: b.block_header.reward,
            totalFees: fees?.totalFees ?? 0,
            medianFee: fees?.medianFee ?? 0,
            minFee: fees?.minFee ?? 0,
            maxFee: fees?.maxFee ?? 0,
            feeRange: fees?.feeRange ?? [0, 0, 0, 0, 0, 0, 0],
            pool: { id: 0, name: 'unknown', slug: 'unknown', minerNames: [] },
          },
        };
      }));
      res.json(shaped);
    } catch (err) {
      logger.err(`xmr getBlocksFromHeight failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /** GET /api/v1/info — height, difficulty, mempool count, nettype. */
  private async getInfo(req: Request, res: Response): Promise<void> {
    try {
      const info = await this.api.getInfo();
      // Hashrate isn't a daemon field — derive from difficulty / target_blocktime (120s).
      const hashrateHs = info.difficulty / 120;
      res.json({
        height: info.height,
        target_height: info.target_height,
        difficulty: info.difficulty,
        hashrate_hs: hashrateHs,
        mempool_size: info.tx_pool_size,
        tx_count: info.tx_count,
        nettype: info.nettype,
        top_block_hash: info.top_block_hash,
        block_size_limit: info.block_size_limit,
        version: info.version,
        synced: info.height === info.target_height || info.target_height === 0,
        untrusted: info.untrusted,
      });
    } catch (err) {
      logger.err(`xmr getInfo failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /**
   * GET /api/v1/blocks — last N block headers (default 10, max 25).
   * Tail of the chain only; for deep history clients should request by hash.
   */
  private async getRecentBlocks(req: Request, res: Response): Promise<void> {
    const requested = Number(req.query.count ?? 10);
    const count = Math.max(1, Math.min(MAX_RECENT_BLOCKS, Number.isFinite(requested) ? requested : 10));
    try {
      const tipCount = await this.api.getBlockCount();
      const tipHeight = tipCount - 1;
      const heights: number[] = [];
      for (let i = 0; i < count; i++) {
        if (tipHeight - i < 0) {
          break;
        }
        heights.push(tipHeight - i);
      }
      const blocks = await Promise.all(heights.map((h) => this.api.getBlockByHeight(h)));
      // Resolve fee stats per block (cached after first lookup) so the
      // /blocks list page renders fee-tier color spans, total fees,
      // and median ɱ/B columns. Without this every row reads zeros.
      const shaped = await Promise.all(blocks.map(async (b) => {
        const fees = b.tx_hashes?.length
          ? await this.api.getBlockFeeStats(b.block_header.hash, b.tx_hashes).catch(() => null)
          : null;
        return {
          ...this.shapeBlockHeader(b.block_header, b.tx_hashes?.length),
          extras: {
            reward: b.block_header.reward,
            totalFees: fees?.totalFees ?? 0,
            medianFee: fees?.medianFee ?? 0,
            minFee: fees?.minFee ?? 0,
            maxFee: fees?.maxFee ?? 0,
            feeRange: fees?.feeRange ?? [0, 0, 0, 0, 0, 0, 0],
            pool: { id: 0, name: 'unknown', slug: 'unknown', minerNames: [] },
          },
        };
      }));
      res.json(shaped);
    } catch (err) {
      logger.err(`xmr getRecentBlocks failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /**
   * GET /api/v1/block/:hash — single block detail.
   * Returns header + tx hashes only (no amounts, no decoded txs).
   */
  private async getBlock(req: Request, res: Response): Promise<void> {
    const hash = req.params.hash;
    if (!HEX64.test(hash)) {
      handleError(req, res, 400, 'invalid block hash');
      return;
    }
    try {
      const block = await this.api.getBlockByHash(hash);
      const txHashes = block.tx_hashes ?? [];
      const includeTxs = req.query.include_txs === '1' || req.query.include_txs === 'true';
      // Always resolve fees (cheap thanks to caching). Optionally also
      // resolve stripped per-tx data if the client asked for it — used
      // by the block-detail page's tile visualization.
      const [fees, stripped] = await Promise.all([
        txHashes.length ? this.api.getBlockFeeStats(block.block_header.hash, txHashes).catch(() => null) : Promise.resolve(null),
        includeTxs && txHashes.length
          ? this.api.getBlockStrippedTxs(block.block_header.hash, txHashes, block.block_header.timestamp).catch(() => null)
          : Promise.resolve(null),
      ]);
      const payload: Record<string, unknown> = {
        ...this.shapeBlockHeader(block.block_header, txHashes.length),
        miner_tx_hash: block.miner_tx_hash,
        tx_hashes: txHashes,
        // Snake-case fields kept for backwards compat with our
        // XmrBlockDetail; upstream BlockExtended reads from extras.
        total_fees: fees?.totalFees ?? 0,
        median_fee: fees?.medianFee ?? 0,
        min_fee: fees?.minFee ?? 0,
        max_fee: fees?.maxFee ?? 0,
        fee_range: fees?.feeRange ?? [0, 0, 0, 0, 0, 0, 0],
        // The `extras` envelope is what mempool.space's BlockComponent
        // reads — block.extras.totalFees / medianFee / feeRange / pool.
        // 'unknown' pool stub until coinbase-extra fingerprinting lands.
        extras: {
          reward: block.block_header.reward,
          totalFees: fees?.totalFees ?? 0,
          medianFee: fees?.medianFee ?? 0,
          minFee: fees?.minFee ?? 0,
          maxFee: fees?.maxFee ?? 0,
          feeRange: fees?.feeRange ?? [0, 0, 0, 0, 0, 0, 0],
          pool: { id: 0, name: 'unknown', slug: 'unknown', minerNames: [] },
        },
      };
      if (includeTxs) {
        payload.stripped_txs = stripped ?? [];
      }
      res.json(payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found|invalid|hash/i.test(msg)) {
        handleError(req, res, 404, 'block not found');
        return;
      }
      logger.err(`xmr getBlock failed: ${msg}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /**
   * GET /api/v1/tx/:hash — public-only tx data.
   *
   * Returns size, weight, fee, ring info, in/out counts, confirmations.
   * NEVER returns amounts or recipients — those are RingCT-hidden by design.
   * The frontend's blur+reveal UI surfaces those client-side via monero-ts.
   *
   * Looks up the tx in two places:
   *   1. mempool — exposes weight/fee/receive_time
   *   2. confirmed (via /get_transactions) — exposes block_height/timestamp/confirmations
   *
   * If neither matches we 404. Note: monerod's /get_transactions returns a
   * pruned-friendly hex blob plus a JSON decode of the unprunable bits
   * (vin/vout shapes, ring offsets) — exactly what we need to surface ring
   * info publicly.
   */
  private async getTx(req: Request, res: Response): Promise<void> {
    const hash = req.params.hash;
    if (!HEX64.test(hash)) {
      handleError(req, res, 400, 'invalid tx hash');
      return;
    }
    try {
      const pool = await this.api.getTransactionPool();
      const inMempool = pool.transactions?.find((t) => t.id_hash === hash);
      if (inMempool) {
        res.json({ status: 'mempool', ...this.shapeMempoolTx(inMempool) });
        return;
      }
      const confirmed = await this.api.getTransactionByHash(hash);
      if (confirmed) {
        res.json({ status: 'confirmed', ...this.shapeConfirmedTx(confirmed) });
        return;
      }
      handleError(req, res, 404, 'tx not found');
    } catch (err) {
      logger.err(`xmr getTx failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /**
   * GET /api/v1/mempool — full current mempool, public fields only.
   * Sorted by fee descending so the frontend's tile layout has a deterministic
   * top-of-list. The mempool wall does its own sizing/binning client-side.
   */
  private async getMempool(req: Request, res: Response): Promise<void> {
    try {
      const pool = await this.api.getTransactionPool();
      const txs = (pool.transactions ?? [])
        .map((t) => this.shapeMempoolTx(t))
        .sort((a, b) => b.fee - a.fee);
      res.json({
        count: txs.length,
        total_weight: txs.reduce((acc, t) => acc + t.weight, 0),
        total_fee: txs.reduce((acc, t) => acc + t.fee, 0),
        txs,
      });
    } catch (err) {
      logger.err(`xmr getMempool failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /**
   * GET /api/v1/fees/recommended — Monero's 4-tier fee model.
   *
   * Returns `{ slow, normal, fast, fastest }` in atomic units per byte.
   * Frontend uses these directly for the fee-tier color buckets.
   */
  private async getFeesRecommended(req: Request, res: Response): Promise<void> {
    try {
      const fees = await this.api.getFeeEstimate();
      const tiers = fees.fees ?? [fees.fee, fees.fee, fees.fee, fees.fee];
      res.json({
        slow: tiers[0],
        normal: tiers[1],
        fast: tiers[2],
        fastest: tiers[3],
        quantization_mask: fees.quantization_mask,
      });
    } catch (err) {
      logger.err(`xmr getFeesRecommended failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  // ---- shaping helpers ----

  private shapeBlockHeader(h: IMoneroApi.BlockHeader, numTxes?: number) {
    return {
      // upstream's BlockExtended interface uses `id` for the hash. Keep
      // both keys: id is the upstream-canonical name (used by the
      // mempool.space frontend's BlockComponent), hash is the
      // Monero-canonical name (used by our XmrBlockDetail and tests).
      // Pointing them at the same string costs ~64 bytes per response
      // and removes a whole class of "field not found" bugs.
      id: h.hash,
      hash: h.hash,
      height: h.height,
      timestamp: h.timestamp,
      age_s: Math.floor(Date.now() / 1000) - h.timestamp,
      depth: h.depth,
      // Both naming conventions for the prev hash, same reason as id/hash.
      prev_hash: h.prev_hash,
      previousblockhash: h.prev_hash,
      reward: h.reward,
      block_size: h.block_size,
      block_weight: h.block_weight,
      // upstream Block interface uses `size` and `weight`; Monero's
      // wire fields are `block_size` and `block_weight`. Map both.
      size: h.block_size,
      weight: h.block_weight,
      // tx_count includes the coinbase per upstream convention. num_txes
      // excludes it (Monero daemon convention). Keep both.
      tx_count: (numTxes ?? h.num_txes) + 1,
      num_txes: numTxes ?? h.num_txes,
      difficulty: h.difficulty,
      cumulative_difficulty: h.cumulative_difficulty,
      major_version: h.major_version,
      minor_version: h.minor_version,
      // upstream BlockExtended.version is generic; map to major_version.
      version: h.major_version,
      nonce: h.nonce,
      orphan_status: h.orphan_status,
      // Monero has no Merkle root of all txs; the miner_tx_hash is the
      // closest analogue and is what our WS adapter has been using.
      merkle_root: h.miner_tx_hash,
      bits: 0,
      miner_tx_hash: h.miner_tx_hash,
    };
  }

  /**
   * Shape a confirmed tx into public-only fields. Crucially, this includes:
   *   - ring_size: length of vin[0].key.key_offsets (16 in modern Monero)
   *   - num_inputs / num_outputs: counts only, never amounts
   *   - ring_offsets_per_input: delta-encoded global output indices for
   *     each input. Frontend can resolve these to block heights via a
   *     follow-up call once we wire /get_outs.
   *   - has_view_tags: derived from any vout with `target.tagged_key.view_tag`
   *     set — a privacy/scanning-speed signal.
   *   - rct_type: ringct version (0=none, 1=full, 2=simple, 3=bulletproof, 4=clsag, 5=bulletproof+, 6=clsag-bp+)
   *
   * NEVER includes amounts (vout[].amount is always 0 in RingCT post-v4
   * anyway, but we don't even forward that field) or recipient addresses.
   */
  private shapeConfirmedTx(t: IMoneroApi.TransactionEntry) {
    let parsed: IMoneroApi.TransactionJson | null = null;
    if (t.as_json) {
      try {
        parsed = JSON.parse(t.as_json) as IMoneroApi.TransactionJson;
      } catch (e) {
        // Daemon should always return valid JSON; if not, surface what we can.
      }
    }
    const numInputs = parsed?.vin?.length ?? 0;
    const numOutputs = parsed?.vout?.length ?? 0;
    const ringSizes = (parsed?.vin ?? [])
      .map((v) => v.key?.key_offsets?.length ?? 0)
      .filter((n) => n > 0);
    const ringSize = ringSizes.length ? ringSizes[0] : null;
    const allRingsConsistent = ringSizes.every((n) => n === ringSize);
    const hasViewTags = (parsed?.vout ?? []).some(
      (v) => v.target?.tagged_key?.view_tag !== undefined,
    );
    // Tx blob size = pruned_as_hex bytes (or as_hex if not pruned). The
    // daemon doesn't return tx_weight directly on /get_transactions, but
    // the wire blob length is what the wallet/daemon use as "weight" for
    // fee-per-byte calculations. /2 because hex is 2 chars per byte.
    const blobBytes = t.pruned_as_hex
      ? Math.floor(t.pruned_as_hex.length / 2)
      : t.as_hex
        ? Math.floor(t.as_hex.length / 2)
        : 0;
    const fee = parsed?.rct_signatures?.txnFee ?? null;
    const feePerByte = fee && blobBytes > 0 ? Math.floor(fee / blobBytes) : 0;
    return {
      hash: t.tx_hash,
      block_height: t.block_height,
      block_timestamp: t.block_timestamp,
      age_s: t.block_timestamp ? Math.floor(Date.now() / 1000) - t.block_timestamp : null,
      confirmations: t.confirmations,
      double_spend_seen: t.double_spend_seen,
      version: parsed?.version,
      unlock_time: parsed?.unlock_time,
      num_inputs: numInputs,
      num_outputs: numOutputs,
      ring_size: ringSize,
      ring_size_consistent: allRingsConsistent,
      ring_offsets_per_input: (parsed?.vin ?? [])
        .map((v) => v.key?.key_offsets ?? [])
        .filter((arr) => arr.length > 0),
      key_images: (parsed?.vin ?? [])
        .map((v) => v.key?.k_image)
        .filter((k): k is string => typeof k === 'string'),
      has_view_tags: hasViewTags,
      rct_type: parsed?.rct_signatures?.type ?? null,
      weight: blobBytes,
      blob_size: blobBytes,
      fee,
      fee_per_byte: feePerByte,
    };
  }

  private shapeMempoolTx(t: IMoneroApi.MempoolEntry) {
    return {
      hash: t.id_hash,
      weight: t.weight,
      blob_size: t.blob_size,
      fee: t.fee,
      // fee_per_byte is the bucket the frontend will color-code against.
      fee_per_byte: t.weight > 0 ? Math.floor(t.fee / t.weight) : 0,
      receive_time: t.receive_time || null,
      relayed: t.relayed,
      double_spend_seen: t.double_spend_seen,
    };
  }
}
