import { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { MoneroApi } from './monero-api';
import { MoneroEventBus } from './monero-event-bus';
import { IMoneroApi } from './monero-api.interface';

/**
 * Speaks the upstream mempool/mempool websocket protocol so the existing
 * Angular frontend "just works" without retargeting StateService /
 * WebsocketService. Every dashboard component subscribes to observables
 * that this WS feeds: blocks, block, mempool-blocks, mempoolInfo, fees,
 * transactions, da (difficulty adjustment).
 *
 * Client → server messages (we accept these but most are no-ops in xmr-space):
 *   {action: 'init'}                 → we send the full snapshot
 *   {action: 'want', data: [...]}    → subscribe to a feed (we ignore filters)
 *   {action: 'ping'}                 → reply {action: 'pong'}
 *   {track-tx, track-address, ...}   → no-op (no per-tx tracking in iter 8)
 *
 * Server → client messages: top-level keys mirror upstream's protocol.
 * The frontend's WebsocketService.handleResponse() picks them apart.
 */

interface UpstreamBlock {
  id: string;
  height: number;
  version: number;
  timestamp: number;
  bits: number;
  nonce: number;
  difficulty: number;
  merkle_root: string;
  tx_count: number;
  size: number;
  weight: number;
  previousblockhash: string;
  extras?: {
    reward?: number;
    totalFees?: number;
    medianFee?: number;
    minFee?: number;
    maxFee?: number;
    feeRange?: number[];
    pool?: { id: number; name: string; slug: string; minerNames?: string[] };
  };
}

interface UpstreamMempoolBlock {
  blockSize: number;
  blockVSize: number;
  nTx: number;
  medianFee: number;
  totalFees: number;
  feeRange: number[];
  index: number;
}

interface UpstreamRecommendedFees {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}

interface UpstreamMempoolInfo {
  loaded: boolean;
  size: number;
  bytes: number;
  usage: number;
  maxmempool: number;
  mempoolminfee: number;
  minrelaytxfee: number;
  total_fee?: number;
}

/**
 * In Monero a block targets 2 minutes; the median block weight is roughly
 * 300 KB and the dynamic limit is `2 * median` — we use 600 KB as a stable
 * proxy for "what fits in one block" when projecting mempool blocks.
 */
const PROJECTED_BLOCK_WEIGHT_LIMIT = 600_000;

const RECENT_BLOCKS_TO_PUSH = 8;

interface ConnState {
  trackingMempoolBlock: number;
  sequence: number;
}

export class MoneroWs {
  private wss?: WebSocketServer;
  /**
   * Highest block height we've already broadcast to clients. Used to
   * drop stale `block` events that lose a race against a later one —
   * `broadcastNewBlock` is async (fetches the full block via daemon
   * RPC) and bus events can fire 3s apart, so two in flight at once
   * can finish out of order.
   */
  private lastBroadcastHeight = -1;
  /**
   * Serialise broadcasts behind a single promise chain. Cheap insurance
   * against the race described above; without this the dashboard's
   * blocks list ends up in chaotic order ([tip-2, tip, tip-3, tip-1, …])
   * after a few tip changes.
   */
  private broadcastQueue: Promise<unknown> = Promise.resolve();
  /**
   * Per-connection state — needed at broadcast time so we know which
   * projected-block index each client is tracking. Without this map the
   * `mempool-delta` and `block` events would fire but the WebGL tile
   * subscribed via `track-mempool-block` would never receive updated
   * per-tx data, so the next-block tile would freeze on its initial
   * snapshot.
   */
  private connState = new Map<WebSocket, ConnState>();

  constructor(private api: MoneroApi, private bus: MoneroEventBus) {}

  public attach(httpServer: HttpServer, path = '/api/v1/ws'): void {
    this.wss = new WebSocketServer({ server: httpServer, path });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

    // Forward bus events to all connected clients. Each broadcast is
    // chained behind the previous one so order is deterministic.
    this.bus.on('block', (header: IMoneroApi.BlockHeader) => {
      this.broadcastQueue = this.broadcastQueue
        .catch(() => undefined)
        .then(() => this.broadcastNewBlock(header).catch(() => undefined));
    });
    this.bus.on('mempool-delta', () => {
      this.broadcastQueue = this.broadcastQueue
        .catch(() => undefined)
        .then(() => this.broadcastMempoolUpdate().catch(() => undefined));
    });
    // MoneroStats samples the mempool every minute. Each new sample is
    // pushed to subscribed clients as `live-2h-chart` so the
    // dashboard's "Incoming Transactions" graph extends in real time
    // rather than freezing at the value returned by the initial
    // /api/v1/statistics/2h fetch.
    this.bus.on('stats-sample', (sample: unknown) => {
      this.broadcast({ 'live-2h-chart': sample });
    });
  }

  private handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    let closed = false;
    // Per-connection state — which projected-mempool-block (if any) the
    // client has subscribed to. -1 = not tracking. The dashboard's
    // mempool tile sends `{track-mempool-block: 0}` to ask for the
    // next-block tile contents.
    const state: ConnState = {
      trackingMempoolBlock: -1,
      sequence: 0,
    };
    this.connState.set(ws, state);

    ws.on('message', (raw) => {
      let msg: Record<string, unknown> = {};
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.action === 'init' || msg.action === 'want') {
        void this.sendSnapshot(ws).catch(() => {});
        return;
      }
      if (msg.action === 'ping') {
        this.safeSend(ws, { action: 'pong' });
        return;
      }
      if ('track-mempool-block' in msg) {
        const block = Number(msg['track-mempool-block']);
        if (Number.isInteger(block) && block >= 0) {
          state.trackingMempoolBlock = block;
          state.sequence = 0;
          void this.sendProjectedBlockTransactions(ws, block, state).catch(() => {});
        } else {
          state.trackingMempoolBlock = -1;
        }
        return;
      }
      // The frontend sends this when it detects a height skip in the
      // block stream (e.g. tip jumped from 100 → 102 instead of 101).
      // We re-fetch the recent-blocks list and push it as `blocks`,
      // which causes resetBlocks() to install a fresh ordered list.
      if ('refresh-blocks' in msg) {
        void this.recentBlocks(RECENT_BLOCKS_TO_PUSH).then((blocks) => {
          this.safeSend(ws, { blocks });
        }).catch(() => undefined);
        return;
      }
      // All other track-* messages (track-tx, track-address, track-rbf,
      // track-accelerations, etc.) accepted but ignored — they don't
      // translate to Monero's data model.
    });

    ws.on('close', () => { closed = true; this.connState.delete(ws); });
    ws.on('error', () => { closed = true; this.connState.delete(ws); });

    // Push an initial snapshot immediately. Clients that don't send
    // `init` (e.g. some embedded views) still get bootstrapped.
    void this.sendSnapshot(ws).catch(() => {});

    // Periodic heartbeat — upstream's ping logic measures latency, but
    // for our case keeping the socket alive against proxies is enough.
    const hb = setInterval(() => {
      if (closed || ws.readyState !== ws.OPEN) {
        clearInterval(hb);
        return;
      }
      try { ws.ping(); } catch { /* ignore */ }
    }, 25_000);
  }

  private safeSend(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== ws.OPEN) {
      return;
    }
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Drop on send errors; the close handler will clean up.
    }
  }

  /**
   * Build and send the initial snapshot: recent blocks, mempool info,
   * projected mempool blocks, recommended fees, and the per-iteration
   * `backendInfo` so the frontend's git-commit reload check is satisfied.
   */
  private async sendSnapshot(ws: WebSocket): Promise<void> {
    const snapshot = await this.buildSnapshot();
    this.safeSend(ws, snapshot);
  }

  /**
   * Same payload as `sendSnapshot` builds but returned directly.
   * Used by the `/api/v1/init-data` REST route so SSR renders a fully
   * populated dashboard without waiting on the WebSocket subscription.
   * Keep this in lock-step with `sendSnapshot` — both must produce the
   * same shape so the first render matches the first ws message.
   */
  public async buildSnapshot(): Promise<Record<string, unknown>> {
    const [info, fees, pool, recentBlocks] = await Promise.all([
      this.api.getInfo(),
      this.api.getFeeEstimate(),
      this.api.getTransactionPool(),
      this.recentBlocks(RECENT_BLOCKS_TO_PUSH),
    ]);

    return {
      backend: 'esplora',  // upstream gates some logic on backend !== 'none'
      backendInfo: {
        hostname: 'xmr-space',
        version: 'xmr-0.1',
        gitCommit: 'xmr',
        lightning: false,
      },
      loadingIndicators: { mempool: 100 },
      blocks: recentBlocks,
      'mempool-blocks': this.projectedMempoolBlocks(pool),
      mempoolInfo: this.shapeMempoolInfo(pool, fees),
      vBytesPerSecond: pool.transactions && pool.transactions.length
        ? Math.round(pool.transactions.reduce((acc, t) => acc + t.weight, 0) / 120)
        : 0,
      fees: this.shapeFees(fees),
      da: {
        progressPercent: 100,
        difficultyChange: 0,
        estimatedRetargetDate: Date.now(),
        remainingBlocks: 0,
        remainingTime: 0,
        previousRetarget: 0,
        previousTime: info.start_time ?? 0,
        nextRetargetHeight: info.height,
        timeAvg: 120_000, // 2-minute target
        adjustedTimeAvg: 120_000,
        timeOffset: 0,
        expectedBlocks: info.height,
      },
      transactions: this.shapeRecentMempoolTxs(pool, 6),
      conversions: { USD: 1, EUR: 0.92 }, // placeholder; price feed not in scope yet
    };
  }

  /**
   * Broadcast a new block to all clients. Called from MoneroEventBus's
   * `block` event. We re-fetch the full block to pull in `block_size` and
   * `num_txes` (the bus emits the header which has both, but the daemon's
   * `get_block_header_by_hash` doesn't always populate `block_weight` —
   * we go through `get_block` for completeness).
   */
  private async broadcastNewBlock(header: IMoneroApi.BlockHeader): Promise<void> {
    if (!this.wss || this.wss.clients.size === 0) {
      return;
    }
    // Drop stale events. After we serialise via broadcastQueue, the
    // event ordering at the entry point IS the daemon's wall-clock
    // ordering — but if the daemon ever returned the same hash twice
    // (orphan ingestion, replay) we still want to no-op.
    if (header.height <= this.lastBroadcastHeight) {
      return;
    }
    const block = await this.api.getBlockByHash(header.hash).catch(() => null);
    const headerForShape = block?.block_header ?? header;
    const numTxes = block?.tx_hashes?.length ?? header.num_txes;
    const fees = block?.tx_hashes?.length
      ? await this.api.getBlockFeeStats(header.hash, block.tx_hashes).catch(() => null)
      : null;
    const shaped = this.shapeBlock(headerForShape, numTxes, fees ?? undefined);
    this.lastBroadcastHeight = header.height;
    // Also push refreshed mempool info — confirming a block drains the pool.
    const pool = await this.api.getTransactionPool().catch(() => null);
    const broadcastPayload: Record<string, unknown> = {
      block: shaped,
      txConfirmed: undefined,
    };
    if (pool) {
      broadcastPayload['mempool-blocks'] = this.projectedMempoolBlocks(pool);
      const fees = await this.api.getFeeEstimate().catch(() => undefined);
      broadcastPayload['mempoolInfo'] = this.shapeMempoolInfo(pool, fees);
    }
    this.broadcast(broadcastPayload);
    // After a block confirms, the projected blocks shift and any
    // tracking client needs a fresh per-tx tile snapshot.
    if (pool) {
      await this.refreshTrackedProjectedBlocks(pool);
    }
  }

  /**
   * Send the per-tx contents of a projected mempool block to a single
   * subscribed client. Format: `{index, sequence, blockTransactions}`
   * where each tx is the upstream's TransactionCompressed tuple
   * `[txid, fee, vsize, value, rate, flags, time, acc?]`.
   *
   * For Monero:
   *   - txid    : id_hash
   *   - fee     : atomic units
   *   - vsize   : weight (== blob_size; no segwit)
   *   - value   : 0 (RingCT-hidden, never exposed)
   *   - rate    : fee / weight
   *   - flags   : 0 (Bitcoin-only flag bits — RBF, fullrbf, sigops,
   *                  consolidation, coinjoin, data — none apply to XMR)
   *   - time    : receive_time
   *   - acc     : 0 (no acceleration market on XMR)
   */
  private async sendProjectedBlockTransactions(
    ws: WebSocket,
    blockIndex: number,
    state: { sequence: number },
  ): Promise<void> {
    const pool = await this.api.getTransactionPool();
    // Use the shared bucketPool helper so we get computed Monero
    // filter flags per tx (ring16 / view_tags / rct_v6) and the same
    // 16-bucket cap as the broadcast path.
    const buckets = this.bucketPool(pool);
    const target = buckets[blockIndex] ?? [];
    state.sequence += 1;

    this.safeSend(ws, {
      'projected-block-transactions': {
        index: blockIndex,
        sequence: state.sequence,
        blockTransactions: target.map((t) => [
          t.txid,
          t.fee,
          t.weight,
          0, // value — RingCT-hidden
          t.rate,
          t.flags ?? 0, // packed Monero filter flags (xmr_ring16/xmr_view_tags/xmr_rct_v6)
          t.receiveTime || Math.floor(Date.now() / 1000),
        ]),
      },
    });
  }

  private async broadcastMempoolUpdate(): Promise<void> {
    if (!this.wss || this.wss.clients.size === 0) {
      return;
    }
    const pool = await this.api.getTransactionPool().catch(() => null);
    if (!pool) {
      return;
    }
    const fees = await this.api.getFeeEstimate().catch(() => undefined);
    this.broadcast({
      'mempool-blocks': this.projectedMempoolBlocks(pool),
      mempoolInfo: this.shapeMempoolInfo(pool, fees),
      transactions: this.shapeRecentMempoolTxs(pool, 6),
      vBytesPerSecond: pool.transactions && pool.transactions.length
        ? Math.round(pool.transactions.reduce((acc, t) => acc + t.weight, 0) / 120)
        : 0,
    });
    // Push fresh per-tx data to any client subscribed to a projected
    // block — without this, new mempool txs never appear as new tiles.
    await this.refreshTrackedProjectedBlocks(pool);
  }

  /**
   * For each connected client that's tracking a projected block,
   * recompute that block's tx list from the latest pool snapshot and
   * push a fresh `projected-block-transactions` payload. Keeps the
   * WebGL next-block tile live: new txs become tiles, confirmed-and-
   * removed txs disappear, both without a page reload.
   *
   * We send the FULL snapshot rather than a delta because
   *   (a) Monero mempools are small (typically <200 txs) so the cost
   *       is negligible
   *   (b) the upstream client's delta path requires monotonic
   *       sequence numbers and exact added/removed/changed bookkeeping;
   *       full snapshots side-step that complexity at the cost of a
   *       few KB per push.
   */
  private async refreshTrackedProjectedBlocks(pool: IMoneroApi.TransactionPool): Promise<void> {
    if (!this.wss || this.connState.size === 0) return;
    // Bucket the pool once, reuse across connections.
    const buckets = this.bucketPool(pool);
    for (const [ws, state] of this.connState.entries()) {
      if (ws.readyState !== ws.OPEN) continue;
      if (state.trackingMempoolBlock < 0) continue;
      const target = buckets[state.trackingMempoolBlock] ?? [];
      state.sequence += 1;
      this.safeSend(ws, {
        'projected-block-transactions': {
          index: state.trackingMempoolBlock,
          sequence: state.sequence,
          blockTransactions: target.map((t) => [
            t.txid, t.fee, t.weight, 0, t.rate, 0, t.receiveTime || Math.floor(Date.now() / 1000),
          ]),
        },
      });
    }
  }

  /**
   * Group mempool txs by Monero's 4 fee tiers (slow / normal / fast /
   * fastest). Returns 4 buckets — fastest first since the dashboard
   * strip renders index 0 closest to the chain tip. Each bucket also
   * carries computed Monero filter flags per tx.
   *
   * Why fee-tier-buckets instead of upstream's greedy-weight-fill:
   *   - Bitcoin's mempool normally has 100MB+ of txs, fills many
   *     blocks ahead — greedy fill produces 5-10 tiles naturally.
   *   - Monero mempools rarely exceed 500KB; greedy fill produces
   *     ONE tile, which looks broken next to mempool.space's
   *     5-tile strip.
   *   - Tier-bucketing always shows 4 tiles when there's any mempool,
   *     and the bucket sizes grow visibly with congestion. More
   *     informative AND more visually balanced.
   *
   * Tier thresholds match monerod's `get_fee_estimate` output for
   * default values [20000, 80000, 320000, 4000000] atomic/byte. A tx
   * lands in the bucket whose threshold it most closely matches at or
   * exceeds.
   */
  private bucketPool(pool: IMoneroApi.TransactionPool): Array<Array<{
    txid: string; weight: number; fee: number; receiveTime: number; rate: number; flags: number;
  }>> {
    type Tx = { txid: string; weight: number; fee: number; receiveTime: number; rate: number; flags: number };
    const txs: Tx[] = (pool.transactions ?? [])
      .map((t) => ({
        txid: t.id_hash,
        weight: t.weight,
        fee: t.fee,
        receiveTime: t.receive_time,
        rate: t.weight > 0 ? t.fee / t.weight : 0,
        flags: this.computeXmrFlags(t),
      }));

    // 4 fee tiers, fastest first (so dashboard's index 0 = highest
    // priority, matching mempool.space's "next block" semantics).
    const FASTEST = 4_000_000;
    const FAST = 320_000;
    const NORMAL = 80_000;
    // anything below NORMAL falls into the slow bucket
    const buckets: Tx[][] = [[], [], [], []];
    for (const t of txs) {
      if (t.rate >= FASTEST) buckets[0].push(t);
      else if (t.rate >= FAST) buckets[1].push(t);
      else if (t.rate >= NORMAL) buckets[2].push(t);
      else buckets[3].push(t);
    }
    // Sort within each bucket by rate desc so the largest-fee txs sit
    // at the top of each tile.
    for (const b of buckets) b.sort((a, c) => c.rate - a.rate);
    return buckets;
  }

  /**
   * Pull the Monero-relevant filter flags out of a mempool entry's
   * embedded tx_json. The daemon already populates tx_json on every
   * /get_transaction_pool entry, so this needs no extra RPC call.
   *
   * Bits MUST match `TransactionFlags.xmr_*` in
   * frontend/src/app/shared/filters.utils.ts:
   *   bit 28 (xmr_ring16)     — vin[0].key.key_offsets.length === 16
   *   bit 29 (xmr_view_tags)  — at least one vout has target.tagged_key.view_tag
   *   bit 30 (xmr_rct_v6)     — rct_signatures.type === 6 (CLSAG + BP+)
   *
   * We pack into a Number because the upstream TransactionStripped
   * tuple stores `flags` as Number; tx-view.ts then converts via
   * BigInt(tx.flags) for the bitwise comparison. Bits 28-30 stay
   * within 32-bit unsigned int range so the round-trip is lossless.
   */
  private computeXmrFlags(t: IMoneroApi.MempoolEntry): number {
    let flags = 0;
    if (!t.tx_json) return flags;
    let parsed: IMoneroApi.TransactionJson | null = null;
    try {
      parsed = JSON.parse(t.tx_json) as IMoneroApi.TransactionJson;
    } catch {
      return flags;
    }
    const vin = parsed.vin ?? [];
    const vout = parsed.vout ?? [];
    const ringSize = vin[0]?.key?.key_offsets?.length ?? 0;
    if (ringSize === 16) flags |= 1 << 28;
    const hasViewTag = vout.some((v) => v.target?.tagged_key?.view_tag !== undefined);
    if (hasViewTag) flags |= 1 << 29;
    if (parsed.rct_signatures?.type === 6) flags |= 1 << 30;
    return flags;
  }

  private broadcast(payload: Record<string, unknown>): void {
    if (!this.wss) return;
    const data = JSON.stringify(payload);
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) {
        try { client.send(data); } catch { /* ignore */ }
      }
    }
  }

  // ---- shapes ----

  /**
   * Recent N blocks in **oldest-first** order. Upstream's
   * `StateService.resetBlocks()` does `blocks.reverse()` on receipt and
   * then `addBlock()` (called for each new tip) `unshift`s onto the
   * front — so the contract is: WS pushes oldest→newest, frontend
   * stores newest→oldest. Sending newest-first here causes blocks to
   * appear in chaotic order after a few real-time tip updates.
   */
  private async recentBlocks(n: number): Promise<UpstreamBlock[]> {
    const tipCount = await this.api.getBlockCount();
    const tipHeight = tipCount - 1;
    const heights: number[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const h = tipHeight - i;
      if (h >= 0) heights.push(h);
    }
    const blocks = await Promise.all(heights.map((h) => this.api.getBlockByHeight(h)));
    // Resolve each block's fee stats in parallel. The per-block call is
    // cached for 24h after first compute, so repeated snapshots after
    // boot are nearly free.
    const shapes = await Promise.all(blocks.map(async (b) => {
      const fees = await this.api.getBlockFeeStats(b.block_header.hash, b.tx_hashes ?? [])
        .catch(() => null);
      return this.shapeBlock(b.block_header, b.tx_hashes?.length, fees ?? undefined);
    }));
    return shapes;
  }

  private shapeBlock(
    h: IMoneroApi.BlockHeader,
    numTxes?: number,
    fees?: { totalFees: number; medianFee: number; minFee: number; maxFee: number; feeRange: number[] },
  ): UpstreamBlock {
    return {
      id: h.hash,
      height: h.height,
      version: h.major_version,
      timestamp: h.timestamp,
      bits: 0,
      nonce: h.nonce,
      difficulty: h.difficulty,
      // Monero has no Merkle tree of full txs the way Bitcoin does;
      // stand in with the miner tx hash so the frontend doesn't break
      // on null. Not displayed prominently in the dashboard.
      merkle_root: h.miner_tx_hash,
      // num_txes excludes coinbase per daemon convention; total tx count
      // including the miner tx is +1 to match upstream block.tx_count
      // semantics ("number of transactions in the block").
      tx_count: (numTxes ?? h.num_txes) + 1,
      size: h.block_size,
      weight: h.block_weight,
      previousblockhash: h.prev_hash,
      extras: {
        reward: h.reward,
        // Real fee aggregates resolved per-block via getBlockFeeStats.
        // Caller passes them in (or omits for the rare path that
        // wants a header-only shape).
        totalFees: fees?.totalFees ?? 0,
        medianFee: fees?.medianFee ?? 0,
        minFee: fees?.minFee ?? 0,
        maxFee: fees?.maxFee ?? 0,
        feeRange: fees?.feeRange ?? [0, 0, 0, 0, 0, 0, 0],
        // Frontend's block / blockchain-blocks templates dereference
        // `block.extras.pool.slug` unconditionally — without a non-null
        // pool the dashboard's blockchain row throws and stops rendering
        // the entire block strip. Surface 'unknown' until we have a
        // miner-fingerprint table (parsing `extra` for known pool tags
        // is in the backlog).
        pool: { id: 0, name: 'unknown', slug: 'unknown', minerNames: [] },
      },
    };
  }

  /**
   * Summarise the per-tier buckets produced by `bucketPool`. Returns
   * one UpstreamMempoolBlock per non-empty fee tier, fastest first.
   * Empty tiers are omitted so the dashboard strip shows only the
   * tiers that actually have pending txs.
   */
  private projectedMempoolBlocks(pool: IMoneroApi.TransactionPool): UpstreamMempoolBlock[] {
    const buckets = this.bucketPool(pool);
    const blocks: UpstreamMempoolBlock[] = [];
    buckets.forEach((bucket, idx) => {
      if (bucket.length === 0) return;
      const fees = bucket.map((t) => t.rate).sort((a, b) => a - b);
      const weight = bucket.reduce((acc, t) => acc + t.weight, 0);
      const totalFee = bucket.reduce((acc, t) => acc + t.fee, 0);
      const median = fees[Math.floor(fees.length / 2)] ?? 0;
      const range = fees.length === 0
        ? [0, 0, 0, 0, 0, 0, 0]
        : [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1].map((p) => fees[Math.min(fees.length - 1, Math.floor(p * (fees.length - 1)))]);
      blocks.push({
        blockSize: weight,
        blockVSize: weight,
        nTx: bucket.length,
        medianFee: median,
        totalFees: totalFee,
        feeRange: range,
        // The `index` field stays as the visual position in the strip
        // (0 = closest to chain tip), regardless of underlying tier.
        // We push fastest first, so index 0 = fastest tier.
        index: blocks.length,
      });
    });
    return blocks;
  }

  /**
   * Shape mempool info to satisfy upstream's MempoolInfo interface, which
   * was modeled on bitcoind's `getmempoolinfo`. We reuse `usage` to mean
   * "actual mempool bytes" and `maxmempool` to mean "node-configured cap".
   * Cake daemon's default cap is 600 MB; we surface that as a reasonable
   * stand-in. `mempoolminfee`/`minrelaytxfee` come from monerod's slow
   * fee tier so the dashboard's "Minimum fee" display has a real number.
   */
  private shapeMempoolInfo(
    pool: IMoneroApi.TransactionPool,
    fees?: IMoneroApi.FeeEstimate,
  ): UpstreamMempoolInfo {
    const txs = pool.transactions ?? [];
    const bytes = txs.reduce((acc, t) => acc + t.weight, 0);
    const totalFee = txs.reduce((acc, t) => acc + t.fee, 0);
    // Convert atomic-per-byte slow tier to BTC/kB-equivalent by multiplying
    // by 1000 — frontend treats the unit as "minor / kB" for display.
    const minFeeRate = fees?.fees ? fees.fees[0] : 0;
    return {
      loaded: true,
      size: txs.length,
      bytes,
      usage: bytes,                  // actual occupied mempool bytes
      maxmempool: 600 * 1024 * 1024, // monerod default 600 MB pool cap
      mempoolminfee: minFeeRate,
      minrelaytxfee: minFeeRate,
      total_fee: totalFee,
    };
  }

  private shapeFees(fees: IMoneroApi.FeeEstimate): UpstreamRecommendedFees {
    const tiers = fees.fees ?? [fees.fee, fees.fee, fees.fee, fees.fee];
    return {
      fastestFee: tiers[3],
      halfHourFee: tiers[2],
      hourFee: tiers[1],
      economyFee: tiers[0],
      minimumFee: tiers[0],
    };
  }

  /**
   * Recent mempool txs in upstream's compact dashboard shape. The upstream
   * dashboard reads `txid, fee, vsize, value` — we provide the first three
   * truthfully and 0 for value (RingCT-hidden).
   */
  private shapeRecentMempoolTxs(pool: IMoneroApi.TransactionPool, n: number) {
    const txs = pool.transactions ?? [];
    return txs
      .slice()
      .sort((a, b) => b.receive_time - a.receive_time)
      .slice(0, n)
      .map((t) => ({
        txid: t.id_hash,
        fee: t.fee,
        vsize: t.weight,
        value: 0,
        rate: t.weight > 0 ? t.fee / t.weight : 0,
      }));
  }
}
