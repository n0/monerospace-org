import { Inject, Injectable, InjectionToken, Optional } from '@angular/core';
import { Transaction } from '@interfaces/electrs.interface';
import { StateService } from '@app/services/state.service';

type MoneroTsModule = typeof import('monero-ts');
type MoneroWalletFull = import('monero-ts').MoneroWalletFull;
export type XmrMoneroTsLoader = () => Promise<MoneroTsModule>;

export const XMR_MONERO_TS_LOADER = new InjectionToken<XmrMoneroTsLoader>('XMR_MONERO_TS_LOADER', {
  providedIn: 'root',
  factory: () => () => import('monero-ts'),
});

declare global {
  interface Window {
    Cypress?: unknown;
    __xmrMoneroTsLoader?: XmrMoneroTsLoader;
  }
}

export interface XmrLocalTxVerificationResult {
  ok: boolean;
  message: string;
  receivedAtomic?: string;
  received?: number;
  confirmations?: number;
  in_pool?: boolean;
  unsupported?: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class XmrLocalTxVerifierService {
  private readonly hex64 = /^[a-f0-9]{64}$/i;
  private readonly moneroMainnetAddress = /^[48][1-9A-HJ-NP-Za-km-z]{94,105}$/;
  private readonly walletOpenTimeoutMs = 10_000;
  private readonly walletScanTimeoutMs = 10_000;
  private readonly walletCloseTimeoutMs = 3_000;
  private network = '';

  constructor(
    private stateService: StateService,
    @Optional() @Inject(XMR_MONERO_TS_LOADER) private moneroTsLoader: XmrMoneroTsLoader,
  ) {
    this.stateService.networkChanged$.subscribe((network) => {
      this.network = network;
    });
  }

  async verifyReceivedTx(tx: Transaction, address: string, privateViewKey: string): Promise<XmrLocalTxVerificationResult> {
    this.assertBrowser();
    this.assertTx(tx);
    this.assertAddress(address);
    this.assertPrivateViewKey(privateViewKey);

    if (address.trim().startsWith('8')) {
      return {
        ok: false,
        unsupported: true,
        message: 'Subaddress receive scanning is not supported from only a subaddress and private view key in this browser flow. Use the tx_secret_key check for subaddress payments.',
      };
    }

    let wallet: MoneroWalletFull | null = null;
    try {
      const moneroTs = await this.loadMoneroTs();
      wallet = await this.withTimeout(moneroTs.createWalletFull({
        path: '',
        password: '',
        networkType: this.getNetworkType(moneroTs),
        server: this.getDaemonServer(),
        primaryAddress: address.trim(),
        privateViewKey: privateViewKey.trim(),
        restoreHeight: this.getRestoreHeight(tx),
        proxyToWorker: true,
        accountLookahead: 1,
        subaddressLookahead: 1,
      }), this.walletOpenTimeoutMs, 'Local verification timed out while opening the browser wallet.');

      await this.withTimeout(
        wallet.scanTxs([tx.txid]),
        this.walletScanTimeoutMs,
        'Local verification timed out while scanning this transaction.',
      );
      const walletTxs = await this.withTimeout(
        wallet.getTxs({ hash: tx.txid, isIncoming: true }),
        this.walletScanTimeoutMs,
        'Local verification timed out while reading the scan result.',
      );
      const walletTx = walletTxs?.[0];
      const received = walletTx?.getIncomingAmount?.() ?? 0n;

      return this.buildResult(received, tx, received > 0n
        ? 'This transaction contains an output for the supplied address and view key.'
        : 'No output was found for the supplied address and view key.', {
        confirmations: walletTx?.getNumConfirmations?.(),
        in_pool: walletTx?.getInTxPool?.(),
      });
    } catch (error) {
      return this.errorResult(error);
    } finally {
      await this.closeWallet(wallet);
    }
  }

  async verifyTxSecretKey(tx: Transaction, address: string, txSecretKey: string): Promise<XmrLocalTxVerificationResult> {
    this.assertBrowser();
    this.assertTx(tx);
    this.assertAddress(address);
    this.assertTxSecretKey(txSecretKey);

    let wallet: MoneroWalletFull | null = null;
    try {
      const moneroTs = await this.loadMoneroTs();
      wallet = await this.withTimeout(moneroTs.createWalletFull({
        path: '',
        password: '',
        networkType: this.getNetworkType(moneroTs),
        server: this.getDaemonServer(),
        restoreHeight: this.getRestoreHeight(tx),
        proxyToWorker: true,
      }), this.walletOpenTimeoutMs, 'Local verification timed out while opening the browser wallet.');

      const check = await this.withTimeout(
        wallet.checkTxKey(tx.txid, txSecretKey.trim(), address.trim()),
        this.walletScanTimeoutMs,
        'Local verification timed out while checking the tx_secret_key.',
      );
      const received = check?.getReceivedAmount?.() ?? 0n;

      return this.buildResult(received, tx, received > 0n
        ? 'The tx_secret_key proves this transaction paid the supplied address.'
        : 'The tx_secret_key did not prove a payment to the supplied address.', {
        confirmations: check?.getNumConfirmations?.(),
        in_pool: check?.getInTxPool?.(),
      });
    } catch (error) {
      return this.errorResult(error);
    } finally {
      await this.closeWallet(wallet);
    }
  }

  private async loadMoneroTs(): Promise<MoneroTsModule> {
    const cypressLoader = this.getCypressMoneroTsLoader();
    if (cypressLoader) {
      return cypressLoader();
    }
    return this.moneroTsLoader();
  }

  private getCypressMoneroTsLoader(): XmrMoneroTsLoader | null {
    if (!this.stateService.isBrowser || typeof window === 'undefined' || !window.Cypress) {
      return null;
    }
    return typeof window.__xmrMoneroTsLoader === 'function' ? window.__xmrMoneroTsLoader : null;
  }

  private assertBrowser(): void {
    if (!this.stateService.isBrowser) {
      throw new Error('Browser-local transaction verification is not available during server rendering.');
    }
  }

  private assertTx(tx: Transaction): void {
    if (!tx?.txid || !this.hex64.test(tx.txid)) {
      throw new Error('A valid transaction hash is required.');
    }
  }

  private assertAddress(address: string): void {
    if (!this.moneroMainnetAddress.test(address.trim())) {
      throw new Error('Enter a valid-looking Monero mainnet address.');
    }
  }

  private assertPrivateViewKey(privateViewKey: string): void {
    if (!this.hex64.test(privateViewKey.trim())) {
      throw new Error('Enter a 64-character hexadecimal private view key.');
    }
  }

  private assertTxSecretKey(txSecretKey: string): void {
    const trimmed = txSecretKey.trim();
    if (!/^[a-f0-9]{64,4096}$/i.test(trimmed) || trimmed.length % 64 !== 0) {
      throw new Error('Enter the hexadecimal tx_secret_key from the sending wallet.');
    }
  }

  private getNetworkType(moneroTs: MoneroTsModule): number {
    if (this.network === 'testnet' || this.network === 'testnet4') {
      return moneroTs.MoneroNetworkType.TESTNET;
    }
    if (this.network === 'stagenet') {
      return moneroTs.MoneroNetworkType.STAGENET;
    }
    return moneroTs.MoneroNetworkType.MAINNET;
  }

  private getDaemonServer(): string {
    const networkPath = this.network && this.network !== this.stateService.env.ROOT_NETWORK ? `/${this.network}` : '';
    if (this.stateService.isBrowser) {
      return `${window.location.origin}${networkPath}/api/v1/monerod`;
    }
    return `${this.stateService.env.NGINX_PROTOCOL}://${this.stateService.env.NGINX_HOSTNAME}:${this.stateService.env.NGINX_PORT}${networkPath}/api/v1/monerod`;
  }

  private getRestoreHeight(tx: Transaction): number {
    const height = tx.status?.block_height;
    return typeof height === 'number' && height > 0 ? Math.max(0, height - 1) : 0;
  }

  private buildResult(
    received: bigint,
    tx: Transaction,
    message: string,
    overrides: Partial<Pick<XmrLocalTxVerificationResult, 'confirmations' | 'in_pool'>> = {},
  ): XmrLocalTxVerificationResult {
    const receivedAtomic = received.toString();
    const receivedNumber = received <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(received) : undefined;
    const confirmations = overrides.confirmations ?? this.getConfirmations(tx);
    const inPool = overrides.in_pool ?? !tx.status?.confirmed;

    return {
      ok: received > 0n,
      message,
      receivedAtomic,
      ...(receivedNumber !== undefined ? { received: receivedNumber } : {}),
      ...(confirmations !== undefined ? { confirmations } : {}),
      in_pool: inPool,
    };
  }

  private getConfirmations(tx: Transaction): number | undefined {
    return tx.status?.confirmed ? undefined : 0;
  }

  private errorResult(error: unknown): XmrLocalTxVerificationResult {
    const message = error instanceof Error ? error.message : String(error || 'Unable to verify this transaction locally.');
    const unsupported = /not supported|not implemented|browser-local|failed to fetch|network/i.test(message);
    return {
      ok: false,
      unsupported,
      message: unsupported
        ? `Local verification could not complete in this browser: ${message}`
        : message,
    };
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
  }

  private async closeWallet(wallet: MoneroWalletFull | null): Promise<void> {
    if (!wallet) {
      return;
    }
    try {
      await this.withTimeout(
        wallet.close(false),
        this.walletCloseTimeoutMs,
        'Timed out while closing the in-memory wallet.',
      );
    } catch {
      // Best effort cleanup for the in-memory WASM wallet.
    }
  }
}
