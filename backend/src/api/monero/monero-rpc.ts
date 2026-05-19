import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { IMoneroApi, MoneroDaemonConfig, MoneroRpcError } from './monero-api.interface';

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
  public readonly rpcUrl: string;

  constructor(private config: MoneroDaemonConfig) {
    this.rpcUrl = config.rpcUrl.replace(/\/$/, '');
    this.client = axios.create({
      baseURL: this.rpcUrl,
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

/**
 * Sync-aware primary/fallback transport. The primary is normally the local
 * monerod; the fallback is a public daemon used while the local node is still
 * syncing or briefly unavailable.
 */
export class MoneroRpcPool {
  private primary: MoneroRpc;
  private fallbacks: MoneroRpc[];
  private primaryUsable: boolean | null = null;
  private primaryCheckedAt = 0;
  private lastWarning = '';
  private lastWarningAt = 0;

  constructor(private config: MoneroDaemonConfig) {
    this.primary = new MoneroRpc(config);
    this.fallbacks = (config.fallbackRpcUrls ?? [])
      .filter((url) => url.trim().length > 0)
      .map((rpcUrl) => new MoneroRpc({
        ...config,
        rpcUrl,
        fallbackRpcUrls: [],
        rpcUser: undefined,
        rpcPassword: undefined,
        requirePrimarySync: false,
      }));
  }

  public async jsonRpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.withFallback((rpc) => rpc.jsonRpc<T>(method, params), `json-rpc ${method}`);
  }

  public async raw<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    return this.withFallback((rpc) => rpc.raw<T>(path, body), `raw ${path}`);
  }

  public async rawBytes(path: string, body: Buffer | Uint8Array): Promise<{ data: Buffer; contentType: string }> {
    return this.withFallback((rpc) => rpc.rawBytes(path, body), `raw-bytes ${path}`);
  }

  private async withFallback<T>(call: (rpc: MoneroRpc) => Promise<T>, label: string): Promise<T> {
    const selected = await this.selectRpc();
    try {
      return await call(selected);
    } catch (err) {
      const fallback = this.fallbacks[0];
      if (selected === this.primary && fallback) {
        this.primaryUsable = false;
        this.primaryCheckedAt = Date.now();
        this.warn(`primary ${this.primary.rpcUrl} failed ${label}; using fallback ${fallback.rpcUrl}: ${formatError(err)}`);
        return call(fallback);
      }
      throw err;
    }
  }

  private async selectRpc(): Promise<MoneroRpc> {
    const fallback = this.fallbacks[0];
    if (!fallback) {
      return this.primary;
    }
    if (!this.config.requirePrimarySync) {
      return this.primary;
    }
    return await this.isPrimaryUsable() ? this.primary : fallback;
  }

  private async isPrimaryUsable(): Promise<boolean> {
    const now = Date.now();
    const interval = Math.max(1_000, this.config.primaryHealthCheckIntervalMs ?? 15_000);
    if (this.primaryUsable !== null && now - this.primaryCheckedAt < interval) {
      return this.primaryUsable;
    }

    this.primaryCheckedAt = now;
    try {
      const info = await this.primary.jsonRpc<IMoneroApi.Info>('get_info');
      const status = daemonSyncStatus(info, this.config.maxPrimaryHeightLag ?? 10);
      this.primaryUsable = status.usable;
      if (!status.usable) {
        this.warn(`primary ${this.primary.rpcUrl} not ready (${status.reason}); using fallback ${this.fallbacks[0]?.rpcUrl}`);
      }
      return status.usable;
    } catch (err) {
      this.primaryUsable = false;
      this.warn(`primary ${this.primary.rpcUrl} health check failed; using fallback ${this.fallbacks[0]?.rpcUrl}: ${formatError(err)}`);
      return false;
    }
  }

  private warn(message: string): void {
    const now = Date.now();
    if (message === this.lastWarning && now - this.lastWarningAt < 60_000) {
      return;
    }
    this.lastWarning = message;
    this.lastWarningAt = now;
    // eslint-disable-next-line no-console
    console.warn(`[xmr-space] monerod fallback: ${message}`);
  }
}

function daemonSyncStatus(info: IMoneroApi.Info, maxLag: number): { usable: boolean; reason: string } {
  if (info.status && info.status !== 'OK') {
    return { usable: false, reason: `status=${info.status}` };
  }
  if (info.busy_syncing === true) {
    return { usable: false, reason: 'busy_syncing=true' };
  }
  if (info.synchronized === false) {
    return { usable: false, reason: 'synchronized=false' };
  }
  const height = Number(info.height ?? 0);
  const targetHeight = Number(info.target_height ?? 0);
  if (targetHeight > 0 && height + maxLag < targetHeight) {
    return { usable: false, reason: `height=${height}, target_height=${targetHeight}` };
  }
  return { usable: true, reason: 'ready' };
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

function formatError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ? ` HTTP ${err.response.status}` : '';
    return `${err.code ?? 'axios'}${status} ${err.message}`.trim();
  }
  return err instanceof Error ? err.message : String(err);
}
