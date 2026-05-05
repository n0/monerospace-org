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
  }

  private handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    let closed = false;
    // Per-connection state — which projected-mempool-block (if any) the
    // client has subscribed to. -1 = not tracking. The dashboard's
    // mempool tile sends `{track-mempool-block: 0}` to ask for the
    // next-block tile contents.
    const state: { trackingMempoolBlock: number; sequence: number } = {
      trackingMempoolBlock: -1,
      sequence: 0,
    };

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

    ws.on('close', () => { closed = true; });
    ws.on('error', () => { closed = true; });

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
    const [info, fees, pool, recentBlocks] = await Promise.all([
      this.api.getInfo(),
      this.api.getFeeEstimate(),
      this.api.getTransactionPool(),
      this.recentBlocks(RECENT_BLOCKS_TO_PUSH),
    ]);

    this.safeSend(ws, {
      backend: 'esplora',  // upstream gates some logic on backend !== 'none'
      backendInfo: {
        hostname: 'xmr-space',
        version: 'xmr-0.1',
        gitCommit: 'xmr',
        lightning: false,
      },
      // loadingIndicators tells the frontend mempool/connection are ready.
      // Several dashboard components gate on `mempool === 100` before
      // rendering — without this they stay in skeleton state forever.
      loadingIndicators: { mempool: 100 },
      blocks: recentBlocks,
      'mempool-blocks': this.projectedMempoolBlocks(pool),
      mempoolInfo: this.shapeMempoolInfo(pool, fees),
      // vBytesPerSecond drives the "Incoming Transactions" chart's
      // current-rate readout. We approximate from the daemon's tx_count
      // delta over the polling interval — for the initial snapshot just
      // surface a current-pool average so the UI doesn't read "0".
      vBytesPerSecond: pool.transactions && pool.transactions.length
        ? Math.round(pool.transactions.reduce((acc, t) => acc + t.weight, 0) / 120)
        : 0,
      fees: this.shapeFees(fees),
      // Difficulty-adjustment widget reads `da`. Monero retargets every
      // block, so the upstream concept of "next adjustment in N blocks"
      // doesn't apply. Surface `progressPercent: 100` so the bar is full.
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
    });
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
    const txs = (pool.transactions ?? [])
      .map((t) => ({
        txid: t.id_hash,
        weight: t.weight,
        fee: t.fee,
        receiveTime: t.receive_time,
        rate: t.weight > 0 ? t.fee / t.weight : 0,
      }))
      .sort((a, b) => b.rate - a.rate);

    // Slice to the requested block — same greedy fill as projectedMempoolBlocks.
    const buckets: typeof txs[] = [];
    let bucket: typeof txs = [];
    let bucketWeight = 0;
    for (const t of txs) {
      if (bucketWeight + t.weight > PROJECTED_BLOCK_WEIGHT_LIMIT && bucket.length) {
        buckets.push(bucket);
        if (buckets.length >= 8) break;
        bucket = [];
        bucketWeight = 0;
      }
      bucket.push(t);
      bucketWeight += t.weight;
    }
    if (bucket.length && buckets.length < 8) buckets.push(bucket);

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
          0, // flags
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
   * Build projected mempool blocks from the current pool snapshot.
   * Algorithm: sort txs by fee_per_byte descending, greedily fill blocks
   * up to PROJECTED_BLOCK_WEIGHT_LIMIT until the pool is empty. Return up
   * to 8 blocks (matches upstream's mempool-blocks UI cap).
   */
  private projectedMempoolBlocks(pool: IMoneroApi.TransactionPool): UpstreamMempoolBlock[] {
    const txs = (pool.transactions ?? [])
      .map((t) => ({
        weight: t.weight,
        fee: t.fee,
        rate: t.weight > 0 ? t.fee / t.weight : 0,
      }))
      .sort((a, b) => b.rate - a.rate);

    const blocks: UpstreamMempoolBlock[] = [];
    let bucket: typeof txs = [];
    let bucketWeight = 0;

    const flush = (index: number): void => {
      if (bucket.length === 0) return;
      const fees = bucket.map((t) => t.rate).sort((a, b) => a - b);
      const totalFee = bucket.reduce((acc, t) => acc + t.fee, 0);
      const median = fees[Math.floor(fees.length / 2)] ?? 0;
      // 7-bucket fee range: slowest, p20, p40, median, p60, p80, fastest
      const range = (
        fees.length === 0
          ? [0, 0, 0, 0, 0, 0, 0]
          : [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1].map((p) => fees[Math.min(fees.length - 1, Math.floor(p * (fees.length - 1)))])
      );
      blocks.push({
        blockSize: bucketWeight,
        blockVSize: bucketWeight,
        nTx: bucket.length,
        medianFee: median,
        totalFees: totalFee,
        feeRange: range,
        index,
      });
      bucket = [];
      bucketWeight = 0;
    };

    for (const tx of txs) {
      if (bucketWeight + tx.weight > PROJECTED_BLOCK_WEIGHT_LIMIT && bucket.length > 0) {
        flush(blocks.length);
        if (blocks.length >= 8) break;
      }
      bucket.push(tx);
      bucketWeight += tx.weight;
    }
    if (blocks.length < 8) flush(blocks.length);

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
