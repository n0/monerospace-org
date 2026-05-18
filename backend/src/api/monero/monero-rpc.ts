import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { MoneroDaemonConfig, MoneroRpcError } from './monero-api.interface';

const RPC_RETRIES = Math.max(0, Number(process.env.MONEROD_RPC_RETRIES ?? 2));
const RPC_RETRY_BACKOFF_MS = Math.max(0, Number(process.env.MONEROD_RPC_RETRY_BACKOFF_MS ?? 500));

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
    const { data } = await this.postWithRetry<{ result?: T; error?: MoneroRpcError }>('/json_rpc', body);
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
    const { data } = await this.postWithRetry<T>(normalized, body);
    return data;
  }

  /**
   * Proxy a public binary daemon endpoint. Monero wallet2 uses a few
   * portable-binary daemon calls for scanning; this keeps the transport
   * generic while the route layer owns the public-method whitelist.
   */
  public async rawBytes(path: string, body: Buffer | Uint8Array): Promise<{ data: Buffer; contentType: string }> {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const { data, headers } = await this.postWithRetry<ArrayBuffer>(normalized, body, {
      headers: { 'Content-Type': 'application/octet-stream' },
      responseType: 'arraybuffer',
    });
    return {
      data: Buffer.from(data),
      contentType: String(headers['content-type'] || 'application/octet-stream'),
    };
  }

  private async postWithRetry<T>(
    path: string,
    body: unknown,
    requestConfig?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RPC_RETRIES; attempt++) {
      try {
        return await this.client.post<T>(path, body, requestConfig);
      } catch (err) {
        lastError = err;
        if (attempt >= RPC_RETRIES || !isTransientRpcError(err)) {
          throw err;
        }
        await sleep(RPC_RETRY_BACKOFF_MS * (attempt + 1));
      }
    }
    throw lastError;
  }
}

function isTransientRpcError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) {
    return false;
  }
  const status = err.response?.status;
  if (status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }
  const code = err.code;
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) {
    return true;
  }
  return /socket hang up|timeout|network error/i.test(err.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
