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
      .get(this.prefix + 'tx/:hash', (req, res) => this.getTx(req, res))
      .get(this.prefix + 'mempool', (req, res) => this.getMempool(req, res))
      .get(this.prefix + 'fees/recommended', (req, res) => this.getFeesRecommended(req, res));
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
      res.json(blocks.map((b) => this.shapeBlockHeader(b.block_header, b.tx_hashes?.length)));
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
      res.json(blocks.map((b) => this.shapeBlockHeader(b.block_header, b.tx_hashes?.length)));
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
        total_fees: fees?.totalFees ?? 0,
        median_fee: fees?.medianFee ?? 0,
        min_fee: fees?.minFee ?? 0,
        max_fee: fees?.maxFee ?? 0,
        fee_range: fees?.feeRange ?? [0, 0, 0, 0, 0, 0, 0],
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
      hash: h.hash,
      height: h.height,
      timestamp: h.timestamp,
      age_s: Math.floor(Date.now() / 1000) - h.timestamp,
      depth: h.depth,
      prev_hash: h.prev_hash,
      reward: h.reward,
      block_size: h.block_size,
      block_weight: h.block_weight,
      // For block detail, tx_hashes excludes coinbase; daemon's `num_txes`
      // also excludes coinbase. Keep both consistent.
      num_txes: numTxes ?? h.num_txes,
      difficulty: h.difficulty,
      cumulative_difficulty: h.cumulative_difficulty,
      major_version: h.major_version,
      minor_version: h.minor_version,
      nonce: h.nonce,
      orphan_status: h.orphan_status,
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
