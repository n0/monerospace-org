import memoryCache from '../memory-cache';
import { IMoneroApi, MoneroDaemonConfig } from './monero-api.interface';
import { MoneroRpc } from './monero-rpc';

/**
 * High-level monerod accessor with per-call server-side caching. The cache
 * windows are deliberately short (5–10s) — Monero blocks target 2 minutes,
 * but mempool / fee data churns fast enough that we want fresh reads while
 * still flattening burst traffic from many websocket clients hitting the
 * same endpoint at once.
 *
 * Cache windows by call:
 *   getInfo            — 5s   (used by the dashboard top bar)
 *   getBlockCount      — 5s
 *   getBlockByHash     — 60s  (immutable once confirmed; safe to cache long)
 *   getBlockByHeight   — 60s  (same)
 *   getTransactionPool — 5s   (mempool wall, mostly visualised)
 *   getFeeEstimate     — 10s  (fee tiers move slowly)
 *
 * NB: nothing here writes user-supplied keys anywhere. The daemon doesn't
 * have wallet endpoints exposed and we never proxy them.
 */
export class MoneroApi {
  private rpc: MoneroRpc;

  constructor(config: MoneroDaemonConfig) {
    this.rpc = new MoneroRpc(config);
  }

  /** Daemon info: height, hashrate-derivable difficulty, mempool size, version. */
  public async getInfo(): Promise<IMoneroApi.Info> {
    const cached = memoryCache.get<IMoneroApi.Info>('xmr', 'info');
    if (cached) {
      return cached;
    }
    const info = await this.rpc.jsonRpc<IMoneroApi.Info>('get_info');
    memoryCache.set('xmr', 'info', info, 5);
    return info;
  }

  /** Just the height — cheaper than `getInfo` when that's all the caller needs. */
  public async getBlockCount(): Promise<number> {
    const cached = memoryCache.get<number>('xmr', 'blockcount');
    if (cached !== null) {
      return cached;
    }
    const result = await this.rpc.jsonRpc<IMoneroApi.BlockCount>('get_block_count');
    memoryCache.set('xmr', 'blockcount', result.count, 5);
    return result.count;
  }

  /** Full block by hash (header + miner tx + tx hashes). */
  public async getBlockByHash(hash: string): Promise<IMoneroApi.Block> {
    const cached = memoryCache.get<IMoneroApi.Block>('xmr-block-hash', hash);
    if (cached) {
      return cached;
    }
    const block = await this.rpc.jsonRpc<IMoneroApi.Block>('get_block', { hash });
    memoryCache.set('xmr-block-hash', hash, block, 60);
    return block;
  }

  /** Full block by height. */
  public async getBlockByHeight(height: number): Promise<IMoneroApi.Block> {
    const cached = memoryCache.get<IMoneroApi.Block>('xmr-block-height', String(height));
    if (cached) {
      return cached;
    }
    const block = await this.rpc.jsonRpc<IMoneroApi.Block>('get_block', { height });
    memoryCache.set('xmr-block-height', String(height), block, 60);
    return block;
  }

  /** Mempool snapshot — list of pending txs with fees, weights, ages. */
  public async getTransactionPool(): Promise<IMoneroApi.TransactionPool> {
    const cached = memoryCache.get<IMoneroApi.TransactionPool>('xmr', 'mempool');
    if (cached) {
      return cached;
    }
    const pool = await this.rpc.raw<IMoneroApi.TransactionPool>('/get_transaction_pool');
    memoryCache.set('xmr', 'mempool', pool, 5);
    return pool;
  }

  /**
   * Look up confirmed transactions by hash via `/get_transactions`. Returns
   * the entries the daemon was able to find — callers should match by
   * `tx_hash` since the daemon will silently omit unknowns.
   *
   * `decode_as_json=true` instructs the daemon to populate `as_json` on
   * each entry: a string that JSON-parses to `{version, unlock_time, vin,
   * vout, extra, rct_signatures}`. We pass `prune=true` so we don't pull
   * the giant rangeproof / bulletproof blobs we have no use for.
   *
   * Cache window: 30s. Confirmed tx data is immutable — could be cached
   * forever — but the wrapper response carries `confirmations`, which IS
   * dynamic. 30s is a reasonable compromise.
   */
  public async getTransactionsByHashes(hashes: string[]): Promise<IMoneroApi.TransactionEntry[]> {
    if (hashes.length === 0) {
      return [];
    }
    // Cache by sorted hash list; for single-hash lookups (the common case
    // in tx-detail views) this still hits the same key on repeated reads.
    const cacheKey = hashes.slice().sort().join(',');
    const cached = memoryCache.get<IMoneroApi.TransactionEntry[]>('xmr-tx', cacheKey);
    if (cached) {
      return cached;
    }
    const resp = await this.rpc.raw<{ txs?: IMoneroApi.TransactionEntry[]; status: string }>(
      '/get_transactions',
      { txs_hashes: hashes, decode_as_json: true, prune: true },
    );
    const txs = resp.txs ?? [];
    memoryCache.set('xmr-tx', cacheKey, txs, 30);
    return txs;
  }

  /** Convenience wrapper for the single-hash case. Returns `null` if not found. */
  public async getTransactionByHash(hash: string): Promise<IMoneroApi.TransactionEntry | null> {
    const txs = await this.getTransactionsByHashes([hash]);
    return txs.find((t) => t.tx_hash === hash) ?? null;
  }

  /**
   * Compute aggregated public fee statistics for a confirmed block:
   * totalFees, medianFee (atomic/byte), minFee, maxFee, and a 7-bucket
   * feeRange [p0, p20, p40, p50, p60, p80, p100] used by the dashboard's
   * block tile to render the fee-tier color span.
   *
   * Cache forever-within-process: confirmed-block fees are immutable. The
   * cost without cache is proportional to (#txs × 1 daemon round trip)
   * because /get_transactions accepts the full list in one call up to
   * its server-configured batch limit (usually ~256 hashes). For typical
   * Monero blocks (10-200 txs) one call is enough.
   */
  public async getBlockFeeStats(blockHash: string, txHashes: string[]): Promise<{
    totalFees: number;
    medianFee: number;
    minFee: number;
    maxFee: number;
    feeRange: number[];
    nTx: number;
  }> {
    if (txHashes.length === 0) {
      return { totalFees: 0, medianFee: 0, minFee: 0, maxFee: 0, feeRange: [0, 0, 0, 0, 0, 0, 0], nTx: 0 };
    }
    const cached = memoryCache.get<{
      totalFees: number; medianFee: number; minFee: number; maxFee: number; feeRange: number[]; nTx: number;
    }>('xmr-block-fees', blockHash);
    if (cached) {
      return cached;
    }
    // /get_transactions has a server-side batch limit; chunk to be safe.
    const CHUNK = 100;
    const chunks: string[][] = [];
    for (let i = 0; i < txHashes.length; i += CHUNK) {
      chunks.push(txHashes.slice(i, i + CHUNK));
    }
    const allTxs: IMoneroApi.TransactionEntry[] = [];
    for (const chunk of chunks) {
      const got = await this.getTransactionsByHashes(chunk);
      allTxs.push(...got);
    }
    // Per-tx fee/byte rate. Each tx's wire blob length (pruned_as_hex
    // when present, else as_hex) gives bytes; rct_signatures.txnFee
    // gives fee. Skip the few entries that fail to JSON-parse.
    const rates: number[] = [];
    let totalFees = 0;
    for (const t of allTxs) {
      let fee = 0;
      try {
        const parsed = t.as_json ? JSON.parse(t.as_json) as IMoneroApi.TransactionJson : null;
        fee = parsed?.rct_signatures?.txnFee ?? 0;
      } catch {
        fee = 0;
      }
      const blobBytes = t.pruned_as_hex
        ? Math.floor(t.pruned_as_hex.length / 2)
        : t.as_hex
          ? Math.floor(t.as_hex.length / 2)
          : 0;
      if (blobBytes > 0 && fee > 0) {
        rates.push(fee / blobBytes);
      }
      totalFees += fee;
    }
    rates.sort((a, b) => a - b);
    const median = rates.length ? rates[Math.floor(rates.length / 2)] : 0;
    const minFee = rates.length ? rates[0] : 0;
    const maxFee = rates.length ? rates[rates.length - 1] : 0;
    const feeRange = rates.length
      ? [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1].map((p) => rates[Math.min(rates.length - 1, Math.floor(p * (rates.length - 1)))])
      : [0, 0, 0, 0, 0, 0, 0];
    const result = { totalFees, medianFee: median, minFee, maxFee, feeRange, nTx: allTxs.length };
    // 24h cache — block fees never change but we don't want unbounded
    // memory growth across many days of uptime; the block-by-hash cache
    // already shares this lifecycle.
    memoryCache.set('xmr-block-fees', blockHash, result, 86_400);
    return result;
  }

  /**
   * Monero's 4-tier fee model. Returns the base atomic-per-byte fee plus a
   * `fees` array `[slow, normal, fast, fastest]` of multipliers — the
   * frontend uses this directly for the fee-tier color buckets.
   *
   * `grace_blocks=10` mirrors the wallet default and produces a slightly
   * more conservative slow tier.
   */
  public async getFeeEstimate(): Promise<IMoneroApi.FeeEstimate> {
    const cached = memoryCache.get<IMoneroApi.FeeEstimate>('xmr', 'fees');
    if (cached) {
      return cached;
    }
    const fees = await this.rpc.jsonRpc<IMoneroApi.FeeEstimate>('get_fee_estimate', { grace_blocks: 10 });
    memoryCache.set('xmr', 'fees', fees, 10);
    return fees;
  }
}

/**
 * Build a configured singleton from environment. Kept as a separate
 * factory (rather than `export default new MoneroApi(...)`) so tests can
 * construct their own instance against a mock URL.
 */
export function moneroApiFromEnv(env: NodeJS.ProcessEnv = process.env): MoneroApi {
  const rpcUrl = env.MONEROD_RPC_URL ?? 'https://xmr-node.cakewallet.com:18081';
  const timeoutMs = Number(env.MONEROD_RPC_TIMEOUT_MS ?? 10_000);
  return new MoneroApi({
    rpcUrl,
    rpcUser: env.MONEROD_RPC_USER,
    rpcPassword: env.MONEROD_RPC_PASSWORD,
    timeoutMs,
  });
}
