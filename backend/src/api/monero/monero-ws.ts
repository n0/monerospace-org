import { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { MoneroApi } from './monero-api';
import { MoneroEventBus } from './monero-event-bus';
import { IMoneroApi } from './monero-api.interface';
import { getLatestXmrPrice, priceToConversions } from './xmr-price';
import { shapeXmrDifficultyAdjustment } from './xmr-difficulty';
import { identifyXmrMinerPool, unknownXmrMinerPool } from './xmr-miner-fingerprint';

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
 *   {track-tx: txid}                 → mark the tracked tx confirmed when a new block contains it
 *   {track-address, ...}             → no-op (private/address-shaped upstream flows)
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
const HEX64 = /^[a-f0-9]{64}$/i;

interface ConnState {
  trackingMempoolBlock: number;
  trackingTx: string | null;
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
    let hb: NodeJS.Timeout | null = null;
    const cleanup = (): void => {
      closed = true;
      this.connState.delete(ws);
      if (hb) {
        clearInterval(hb);
        hb = null;
      }
    };
    // Per-connection state — which projected-mempool-block (if any) the
    // client has subscribed to. -1 = not tracking. The dashboard's
    // mempool tile sends `{track-mempool-block: 0}` to ask for the
    // next-block tile contents.
    const state: ConnState = {
      trackingMempoolBlock: -1,
      trackingTx: null,
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
      if ('track-tx' in msg) {
        const txid = typeof msg['track-tx'] === 'string' ? msg['track-tx'].toLowerCase() : '';
        state.trackingTx = HEX64.test(txid) ? txid : null;
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
      // All other track-* messages (track-address, track-rbf,
      // track-accelerations, etc.) accepted but ignored — they don't
      // translate to Monero's data model.
    });

    ws.on('close', cleanup);
    ws.on('error', cleanup);

    // Push an initial snapshot immediately. Clients that don't send
    // `init` (e.g. some embedded views) still get bootstrapped.
    void this.sendSnapshot(ws).catch(() => {});

    // Periodic heartbeat — upstream's ping logic measures latency, but
    // for our case keeping the socket alive against proxies is enough.
    hb = setInterval(() => {
      if (closed || ws.readyState !== ws.OPEN) {
        cleanup();
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
    const [info, fees, pool, recentBlocks, latestPrice] = await Promise.all([
      this.api.getInfo(),
      this.api.getFeeEstimate(),
      this.api.getTransactionPool(),
      this.recentBlocks(RECENT_BLOCKS_TO_PUSH),
      getLatestXmrPrice(),
    ]);

    const tipBlock = recentBlocks.at(-1) ?? null;
    const previousBlock = recentBlocks.at(-2) ?? null;
    const previousPreviousBlock = recentBlocks.at(-3) ?? null;

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
      bytesPerSecond: pool.transactions && pool.transactions.length
        ? Math.round(pool.transactions.reduce((acc, t) => acc + t.weight, 0) / 120)
        : 0,
      fees: this.shapeFees(fees),
      da: shapeXmrDifficultyAdjustment(tipBlock, previousBlock, previousPreviousBlock),
      transactions: this.shapeRecentMempoolTxs(pool, 6),
      conversions: priceToConversions(latestPrice),
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
    const confirmedTxids = new Set([
      ...(block?.tx_hashes ?? []),
      block?.miner_tx_hash,
    ].filter((txid): txid is string => typeof txid === 'string').map((txid) => txid.toLowerCase()));
    const fees = block?.tx_hashes?.length
      ? await this.api.getBlockFeeStats(header.hash, block.tx_hashes).catch(() => null)
      : null;
    const shaped = this.shapeBlock(headerForShape, numTxes, fees ?? undefined, identifyXmrMinerPool(block));
    this.lastBroadcastHeight = header.height;
    // Also push refreshed mempool info and difficulty state — confirming
    // a block drains the pool, and Monero retargets on every new block.
    const [pool, previousBlock, previousPreviousBlock] = await Promise.all([
      this.api.getTransactionPool().catch(() => null),
      header.height > 0 ? this.api.getBlockByHeight(header.height - 1).catch(() => null) : Promise.resolve(null),
      header.height > 1 ? this.api.getBlockByHeight(header.height - 2).catch(() => null) : Promise.resolve(null),
    ]);
    const broadcastPayload: Record<string, unknown> = {
      block: shaped,
      da: shapeXmrDifficultyAdjustment(
        headerForShape,
        previousBlock?.block_header ?? null,
        previousPreviousBlock?.block_header ?? null,
      ),
    };
    if (pool) {
      broadcastPayload['mempool-blocks'] = this.projectedMempoolBlocks(pool);
      const fees = await this.api.getFeeEstimate().catch(() => undefined);
      broadcastPayload['mempoolInfo'] = this.shapeMempoolInfo(pool, fees);
    }
    this.broadcastBlock(broadcastPayload, confirmedTxids);
    // After a block confirms, the projected blocks shift and any
    // tracking client needs a fresh per-tx tile snapshot.
    if (pool) {
      await this.refreshTrackedProjectedBlocks(pool);
    }
  }

  /**
   * Send the per-tx contents of a projected mempool block to a single
   * subscribed client. Format: `{index, sequence, blockTransactions}`
   * where each tx is the XMR TransactionCompressed tuple
   * `[txid, fee, vsize, value, rate, flags, time]`.
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
   */
  private async sendProjectedBlockTransactions(
    ws: WebSocket,
    blockIndex: number,
    state: { sequence: number },
  ): Promise<void> {
    const pool = await this.api.getTransactionPool();
    // Use the same projected-block helper as the broadcast path so
    // the WebGL wall and the summary cards describe the same tx set.
    const buckets = this.projectPool(pool);
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
      bytesPerSecond: pool.transactions && pool.transactions.length
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
    // Project the pool once, reuse across connections.
    const buckets = this.projectPool(pool);
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
            t.txid, t.fee, t.weight, 0, t.rate, t.flags ?? 0, t.receiveTime || Math.floor(Date.now() / 1000),
          ]),
        },
      });
    }
  }

  /**
   * Project the pool into candidate blocks. For Monero, the honest
   * default is one "next block" candidate: sort pending txs by fee per
   * byte and fill up to the dynamic-weight proxy. Only create index 1,
   * 2, ... when the mempool truly overflows that weight.
   *
   * This intentionally avoids the old fee-tier buckets. Monero exposes
   * four wallet fee recommendations, but those are not four separate
   * future blocks; splitting the wall by tier made the UI look fuller
   * while implying a queue structure that does not actually exist.
   */
  private projectPool(pool: IMoneroApi.TransactionPool): Array<Array<{
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

    txs.sort((a, b) => {
      if (b.rate !== a.rate) return b.rate - a.rate;
      if (a.receiveTime !== b.receiveTime) return a.receiveTime - b.receiveTime;
      return a.txid.localeCompare(b.txid);
    });

    const buckets: Tx[][] = [];
    let current: Tx[] = [];
    let currentWeight = 0;

    for (const tx of txs) {
      if (current.length > 0 && currentWeight + tx.weight > PROJECTED_BLOCK_WEIGHT_LIMIT) {
        buckets.push(current);
        current = [];
        currentWeight = 0;
      }
      current.push(tx);
      currentWeight += tx.weight;
    }
    if (current.length > 0) {
      buckets.push(current);
    }

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

  private broadcastBlock(payload: Record<string, unknown>, confirmedTxids: Set<string>): void {
    if (!this.wss) return;
    for (const client of this.wss.clients) {
      if (client.readyState !== client.OPEN) {
        continue;
      }
      const state = this.connState.get(client);
      const txConfirmed = state?.trackingTx && confirmedTxids.has(state.trackingTx)
        ? state.trackingTx
        : undefined;
      const clientPayload = txConfirmed
        ? { ...payload, txConfirmed }
        : payload;
      if (txConfirmed && state) {
        state.trackingTx = null;
      }
      try { client.send(JSON.stringify(clientPayload)); } catch { /* ignore */ }
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
      return this.shapeBlock(b.block_header, b.tx_hashes?.length, fees ?? undefined, identifyXmrMinerPool(b));
    }));
    return shapes;
  }

  private shapeBlock(
    h: IMoneroApi.BlockHeader,
    numTxes?: number,
    fees?: { totalFees: number; medianFee: number; minFee: number; maxFee: number; feeRange: number[] },
    pool = unknownXmrMinerPool(),
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
        pool,
      },
    };
  }

  /**
   * Summarise projected block candidates produced by `projectPool`.
   * In ordinary Monero conditions this returns one block. Additional
   * entries mean the mempool actually exceeds one projected block.
   */
  private projectedMempoolBlocks(pool: IMoneroApi.TransactionPool): UpstreamMempoolBlock[] {
    const buckets = this.projectPool(pool);
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
        // The `index` field stays as the visual position in the strip:
        // 0 is the next block candidate, 1+ are true overflow buckets.
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
