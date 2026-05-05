import axios, { AxiosInstance } from 'axios';
import { MoneroDaemonConfig, MoneroRpcError } from './monero-api.interface';

/**
 * Thin transport for the monerod daemon. Two flavours of endpoint:
 *
 *   - JSON-RPC 2.0 at `POST /json_rpc` — `get_info`, `get_block_count`,
 *     `get_block`, `get_block_header_by_*`, `get_fee_estimate`, etc.
 *   - Plain JSON POST at `POST /<method>` — `get_transaction_pool`,
 *     `get_transactions`, `get_outs`, `is_key_image_spent`. These do NOT
 *     wrap responses in a `result` envelope.
 *
 * monerod accepts digest auth (when `--rpc-login` is set) but most public
 * nodes (cakewallet, xmr.node.live, etc.) are open. We support both via
 * axios's built-in `auth` option.
 */
export class MoneroRpc {
  private client: AxiosInstance;

  constructor(private config: MoneroDaemonConfig) {
    this.client = axios.create({
      baseURL: config.rpcUrl.replace(/\/$/, ''),
      timeout: config.timeoutMs,
      headers: { 'Content-Type': 'application/json' },
      auth: config.rpcUser && config.rpcPassword
        ? { username: config.rpcUser, password: config.rpcPassword }
        : undefined,
    });
  }

  /** Issue a JSON-RPC 2.0 call against `/json_rpc`. */
  public async jsonRpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const body = { jsonrpc: '2.0', id: '0', method, params };
    const { data } = await this.client.post<{ result?: T; error?: MoneroRpcError }>('/json_rpc', body);
    if (data.error) {
      throw new Error(`monerod RPC error (${method}) ${data.error.code}: ${data.error.message}`);
    }
    if (data.result === undefined) {
      throw new Error(`monerod RPC ${method} returned no result`);
    }
    return data.result;
  }

  /**
   * Issue a request against a non-JSON-RPC endpoint (e.g. `/get_transaction_pool`).
   * The daemon responds with the bare JSON object — no `result` wrapper.
   */
  public async raw<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const { data } = await this.client.post<T>(normalized, body);
    return data;
  }
}
