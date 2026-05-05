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
