import { Component, OnInit, AfterViewInit, OnDestroy, HostListener, ViewChild, Inject, ChangeDetectorRef } from '@angular/core';
import { ElectrsApiService } from '@app/services/electrs-api.service';
import { ActivatedRoute, ParamMap, Router } from '@angular/router';
import { TransactionsListComponent } from '@components/transactions-list/transactions-list.component';
import {
  switchMap,
  filter,
  catchError,
  tap,
  map,
  retry,
  startWith,
  repeat,
  take,
  distinctUntilChanged
} from 'rxjs/operators';
import { Transaction, TxProofResponse } from '@interfaces/electrs.interface';
import { of, merge, Subscription, Observable, Subject, combineLatest, BehaviorSubject } from 'rxjs';
import { StateService } from '@app/services/state.service';
import { CacheService } from '@app/services/cache.service';
import { WebsocketService } from '@app/services/websocket.service';
import { AudioService } from '@app/services/audio.service';
import { ApiService } from '@app/services/api.service';
import { SeoService } from '@app/services/seo.service';
import { BlockExtended, MempoolPosition } from '@interfaces/node-api.interface';
import { RelativeUrlPipe } from '@app/shared/pipes/relative-url/relative-url.pipe';
import { PriceService } from '@app/services/price.service';
import { EnterpriseService } from '@app/services/enterprise.service';
import { ZONE_SERVICE } from '@app/injection-tokens';
import { ETA, EtaService } from '@app/services/eta.service';
import { XmrLocalTxVerifierService, XmrLocalTxVerificationResult } from '@app/services/xmr-local-tx-verifier.service';

type XmrVerificationMode = 'proof' | 'view-key' | 'tx-secret-key';
type XmrVerificationStatus = 'idle' | 'loading' | 'success' | 'error';

@Component({
  selector: 'app-transaction',
  templateUrl: './transaction.component.html',
  styleUrls: ['./transaction.component.scss'],
  standalone: false,
})
export class TransactionComponent implements OnInit, AfterViewInit, OnDestroy {
  network = '';
  tx: Transaction;
  txId: string;
  mempoolPosition: MempoolPosition;
  gotInitialPosition = false;
  isLoadingTx = true;
  error: any = undefined;
  waitingForTransaction = false;
  latestBlock: BlockExtended;
  transactionTime = -1;
  subscription: Subscription;
  transactionTimesSubscription: Subscription;
  mempoolPositionSubscription: Subscription;
  networkChangedSubscription: Subscription;
  queryParamsSubscription: Subscription;
  urlFragmentSubscription: Subscription;
  blocksSubscription: Subscription;
  txConfirmedSubscription: Subscription;
  currencyChangeSubscription: Subscription;
  fragmentParams: URLSearchParams = new URLSearchParams(window.location.hash.slice(1));
  transactionTimes$ = new Subject<string>();
  txChanged$ = new BehaviorSubject<boolean>(false); // triggered whenever this.tx changes (long term, we should refactor to make this.tx an observable itself)
  ETA$: Observable<ETA | null>;
  isCached: boolean = false;
  now = Date.now();
  inputIndex: number;
  outputIndex: number;
  xmrRingctTx: boolean = false;
  isDetailsOpen: boolean = false;
  tooltipPosition: { x: number, y: number };
  isMobile: boolean;
  isLoadingFirstSeen = false;
  xmrProof = {
    address: '',
    signature: '',
    message: '',
  };
  xmrVerificationMode: XmrVerificationMode = 'proof';
  xmrLocalReceive = {
    address: '',
    privateViewKey: '',
  };
  xmrTxSecret = {
    address: '',
    txSecretKey: '',
  };
  readonly xmrProofMessageMaxLength = 1024;
  readonly xmrProofSignatureMaxLength = 4096;
  readonly xmrSecretKeyMaxLength = 4096;
  xmrProofStatus: XmrVerificationStatus = 'idle';
  xmrProofResult: TxProofResponse | null = null;
  xmrProofError = '';
  xmrLocalStatus: XmrVerificationStatus = 'idle';
  xmrLocalResult: XmrLocalTxVerificationResult | null = null;
  xmrLocalError = '';

  featuresEnabled: boolean;
  private txList: TransactionsListComponent;
  private xmrLocalVerificationRun = 0;

  @ViewChild('txList')
  set txListSetter(component: TransactionsListComponent | undefined) {
    if (component) {
      this.txList = component;
      this.txList.setDetailsOpen(this.isDetailsOpen);
    }
  }

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private relativeUrlPipe: RelativeUrlPipe,
    private electrsApiService: ElectrsApiService,
    public stateService: StateService,
    private cacheService: CacheService,
    private websocketService: WebsocketService,
    private audioService: AudioService,
    private apiService: ApiService,
    private seoService: SeoService,
    private priceService: PriceService,
    private enterpriseService: EnterpriseService,
    private etaService: EtaService,
    private xmrLocalTxVerifier: XmrLocalTxVerifierService,
    private cd: ChangeDetectorRef,
    @Inject(ZONE_SERVICE) private zoneService: any,
  ) {}

  ngOnInit() {
    this.enterpriseService.page();
    this.isDetailsOpen = this.route.snapshot.queryParams['showDetails'] === 'true';

    this.websocketService.want(['blocks', 'mempool-blocks']);
    this.networkChangedSubscription = this.stateService.networkChanged$.subscribe(
      (network) => {
        this.network = network;
      }
    );

    this.urlFragmentSubscription = this.route.fragment.subscribe((fragment) => {
      this.updateFragmentParams(fragment);
    });

    this.blocksSubscription = this.stateService.blocks$.subscribe((blocks) => {
      this.latestBlock = blocks[0];
    });

    this.transactionTimesSubscription = this.transactionTimes$.pipe(
      tap(() => {
        this.isLoadingFirstSeen = true;
      }),
      switchMap((txid) => this.apiService.getTransactionTimes$([txid]).pipe(
        retry({ count: 2, delay: 2000 }),
        // Try again until we either get a valid response, or the transaction is confirmed
        repeat({ delay: 2000 }),
        filter((transactionTimes) => transactionTimes?.[0] > 0 || this.tx.status?.confirmed),
        take(1),
      )),
    )
    .subscribe((transactionTimes) => {
      this.isLoadingFirstSeen = false;
      if (transactionTimes?.length && transactionTimes[0]) {
        this.transactionTime = transactionTimes[0];
      }
    });

    this.mempoolPositionSubscription = this.stateService.mempoolTxPosition$.subscribe(txPosition => {
      this.now = Date.now();
      if (txPosition && txPosition.txid === this.txId && txPosition.position) {
        this.mempoolPosition = txPosition.position;
        if (this.tx && !this.tx.status.confirmed) {
          const txFeePerVSize = this.getTxFeeRate(this.tx);
          this.stateService.markBlock$.next({
            txid: txPosition.txid,
            txFeePerVSize,
            mempoolPosition: this.mempoolPosition,
          });
        }
        this.gotInitialPosition = true;
      } else {
        this.mempoolPosition = null;
      }
    });

    this.subscription = this.zoneService.wrapObservable(this.route.paramMap
      .pipe(
        switchMap((params: ParamMap) => {
          const urlMatch = (params.get('id') || '').split(':');
          if (urlMatch.length === 2 && urlMatch[1].length === 64) {
            const vin = parseInt(urlMatch[0], 10);
            this.txId = urlMatch[1];
            // rewrite legacy vin syntax
            if (!isNaN(vin)) {
              this.fragmentParams.set('vin', vin.toString());
              this.fragmentParams.delete('vout');
            }
            this.router.navigate([this.relativeUrlPipe.transform('/tx'), this.txId], {
              queryParamsHandling: 'merge',
              fragment: this.fragmentParams.toString(),
            });
          } else {
            this.txId = urlMatch[0];
            const vout = parseInt(urlMatch[1], 10);
            if (urlMatch.length > 1 && !isNaN(vout)) {
              // rewrite legacy vout syntax
              this.fragmentParams.set('vout', vout.toString());
              this.fragmentParams.delete('vin');
              this.router.navigate([this.relativeUrlPipe.transform('/tx'), this.txId], {
                queryParamsHandling: 'merge',
                fragment: this.fragmentParams.toString(),
              });
            }
          }
          if (window.innerWidth <= 767.98) {
            this.router.navigate([this.relativeUrlPipe.transform('/tx'), this.txId], {
              queryParamsHandling: 'merge',
              preserveFragment: true,
              queryParams: { mode: 'details' },
              replaceUrl: true,
            });
          }
          this.seoService.setTitle(
            $localize`:@@xmr.transaction.browser-title:Transaction: ${this.txId}:INTERPOLATION:`
          );
          this.seoService.setDescription($localize`:@@meta.description.xmr.transaction:Get real-time Monero transaction status, fee, size, ring information, key images, and confirmations for txid ${this.txId}. Amounts and recipients stay hidden by RingCT.`);
          this.resetTransaction();

          return merge(
            of(true),
            this.stateService.connectionState$.pipe(
              filter(
                (state) => state === 2 && this.tx && !this.tx.status?.confirmed
              )
            )
          );
        }),
        switchMap(() => {
          let transactionObservable$: Observable<Transaction>;
          const cached = this.cacheService.getTxFromCache(this.txId);
          if (cached && cached.fee !== -1) {
            transactionObservable$ = of(cached);
          } else {
            transactionObservable$ = this.electrsApiService
              .getTransaction$(this.txId)
              .pipe(
                catchError(this.handleLoadElectrsTransactionError.bind(this))
              );
          }
          return merge(
            transactionObservable$,
            this.stateService.mempoolTransactions$
          );
        }),
      ))
      .subscribe((tx: Transaction) => {
          if (!tx) {
            this.seoService.logSoft404();
            return;
          }
          this.seoService.clearSoft404();

          this.tx = tx;
          this.setFeatures();
          this.isCached = false;
          if (tx.fee === undefined) {
            this.tx.fee = 0;
          }
          this.tx.feePerVsize = this.getTxFeeRate(tx);
          this.txChanged$.next(true);
          this.isLoadingTx = false;
          this.error = undefined;
          this.waitingForTransaction = false;
          this.websocketService.startTrackTransaction(tx.txid);

          if (!tx.status?.confirmed) {
            if (tx.firstSeen) {
              this.transactionTime = tx.firstSeen;
            } else {
              this.transactionTimes$.next(tx.txid);
            }
          } else {
            this.transactionTime = 0;
          }

          if (this.tx?.status?.confirmed) {
            this.stateService.markBlock$.next({
              blockHeight: tx.status.block_height,
            });
          } else {
            const txFeePerVSize = this.getTxFeeRate(this.tx);
            this.stateService.markBlock$.next({
              txid: tx.txid,
              txFeePerVSize,
              mempoolPosition: this.mempoolPosition,
            });
          }
          this.currencyChangeSubscription?.unsubscribe();
          this.currencyChangeSubscription = this.stateService.fiatCurrency$.pipe(
            switchMap((currency) => {
              return tx.status.block_time ? this.priceService.getBlockPrice$(tx.status.block_time, true, currency).pipe(
                tap((price) => tx['price'] = price),
              ) : of(undefined);
            })
          ).subscribe();

          this.cd.detectChanges();
        },
        (error) => {
          this.error = error;
          this.seoService.logSoft404();
          this.isLoadingTx = false;
        }
      );

    this.txConfirmedSubscription = this.stateService.txConfirmed$.subscribe(([txConfirmed, block]) => {
      if (txConfirmed && this.tx && !this.tx.status.confirmed && txConfirmed === this.tx.txid) {
        this.tx.status = {
          confirmed: true,
          block_height: block.height,
          block_hash: block.id,
          block_time: block.timestamp,
        };
        this.txChanged$.next(true);
        this.stateService.markBlock$.next({ blockHeight: block.height });
        this.audioService.playSound('magic');
      }
    });

    this.queryParamsSubscription = this.route.queryParams.subscribe((params) => {
      this.isDetailsOpen = params.showDetails === 'true';
      this.txList?.setDetailsOpen(this.isDetailsOpen);
    });

    this.ETA$ = combineLatest([
      this.stateService.mempoolTxPosition$.pipe(startWith(null)),
      this.stateService.mempoolBlocks$.pipe(startWith(null)),
      this.stateService.difficultyAdjustment$.pipe(startWith(null)),
      this.txChanged$,
    ]).pipe(
      map(([position, mempoolBlocks, da]) => {
        if (!this.tx || !position || position.txid !== this.tx.txid) {
          return null;
        }
        return this.etaService.calculateETA(
          this.tx,
          mempoolBlocks,
          position,
          da,
        );
      }),
      distinctUntilChanged((prev: ETA | null, curr: ETA | null) => {
        return prev === curr || (prev && curr && prev.time === curr.time && prev.blocks === curr.blocks);
      })
    );
  }

  ngAfterViewInit(): void {
    this.updateViewportState();
  }

  toggleDetailsFromTxPage(): void {
    this.isDetailsOpen = !this.isDetailsOpen;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { showDetails: this.isDetailsOpen ? 'true' : null },
      queryParamsHandling: 'merge',
      preserveFragment: true,
      replaceUrl: true,
    });
    this.txList?.setDetailsOpen(this.isDetailsOpen);
  }

  handleLoadElectrsTransactionError(error: any): Observable<any> {
    if (error.status === 404 && /^[a-fA-F0-9]{64}$/.test(this.txId)) {
      this.websocketService.startMultiTrackTransaction(this.txId);
      this.waitingForTransaction = true;
    }
    this.error = error;
    this.seoService.logSoft404();
    this.isLoadingTx = false;
    return of(false);
  }

  setFeatures(): void {
    this.xmrRingctTx = this.tx ? this.isXmrRingctTransaction(this.tx) : false;
    this.featuresEnabled = this.xmrRingctTx;
  }

  isXmrRingctTransaction(tx: Transaction): boolean {
    return !!tx?.vin?.some((vin) => vin.ringct) || !!tx?.vout?.some((vout) => vout.ringct);
  }

  private getFeeRateDenominator(tx: Transaction): number {
    return Math.max(this.xmrRingctTx ? tx.weight : (tx.weight / 4), 1);
  }

  private getTxFeeRate(tx: Transaction): number {
    return tx.fee / this.getFeeRateDenominator(tx);
  }

  updateXmrProofField(field: 'address' | 'signature' | 'message', value: string): void {
    this.xmrProof[field] = value;
    if (this.xmrProofStatus !== 'loading') {
      this.xmrProofStatus = 'idle';
      this.xmrProofResult = null;
      this.xmrProofError = '';
    }
  }

  setXmrVerificationMode(mode: XmrVerificationMode): void {
    this.xmrVerificationMode = mode;
    this.resetXmrVerificationResults();
  }

  updateXmrLocalReceiveField(field: 'address' | 'privateViewKey', value: string): void {
    this.xmrLocalReceive[field] = value;
    this.cancelXmrLocalVerification();
    this.resetXmrLocalResult(true);
  }

  updateXmrTxSecretField(field: 'address' | 'txSecretKey', value: string): void {
    this.xmrTxSecret[field] = value;
    this.cancelXmrLocalVerification();
    this.resetXmrLocalResult(true);
  }

  verifyXmrProof(): void {
    const address = this.xmrProof.address.trim();
    const signature = this.xmrProof.signature.trim();
    const message = this.xmrProof.message.trim();

    if (!address || !signature) {
      this.xmrProofStatus = 'error';
      this.xmrProofResult = null;
      this.xmrProofError = 'Address and tx_proof signature are required.';
      return;
    }

    if (!this.isProbablyMoneroAddress(address)) {
      this.xmrProofStatus = 'error';
      this.xmrProofResult = null;
      this.xmrProofError = 'Enter a valid-looking Monero mainnet address.';
      return;
    }

    if (signature.length < 80 || signature.length > this.xmrProofSignatureMaxLength) {
      this.xmrProofStatus = 'error';
      this.xmrProofResult = null;
      this.xmrProofError = 'Enter the tx_proof signature generated by a Monero wallet.';
      return;
    }

    if (message.length > this.xmrProofMessageMaxLength) {
      this.xmrProofStatus = 'error';
      this.xmrProofResult = null;
      this.xmrProofError = `Proof messages must be ${this.xmrProofMessageMaxLength} characters or less.`;
      return;
    }

    this.xmrProofStatus = 'loading';
    this.xmrProofResult = null;
    this.xmrProofError = '';

    this.electrsApiService.verifyTxProof$(this.txId, {
      address,
      signature,
      ...(message ? { message } : {}),
    }).pipe(take(1)).subscribe({
      next: (result) => {
        this.xmrProofResult = result;
        this.xmrProofStatus = result.ok ? 'success' : 'error';
        this.xmrProofError = result.ok ? '' : (result.message || 'The proof did not verify for this transaction and address.');
        this.cd.markForCheck();
      },
      error: (error) => {
        this.xmrProofResult = null;
        this.xmrProofStatus = 'error';
        this.xmrProofError = error?.error?.message || error?.message || 'Unable to verify proof.';
        this.cd.markForCheck();
      },
    });
  }

  verifyXmrLocalReceive(): void {
    const address = this.xmrLocalReceive.address.trim();
    const privateViewKey = this.xmrLocalReceive.privateViewKey.trim();
    const tx = this.tx;
    const txid = tx?.txid;

    if (!address || !privateViewKey) {
      this.setXmrLocalError('Address and private view key are required.');
      return;
    }
    if (!txid) {
      this.setXmrLocalError('Load a transaction before running local verification.');
      return;
    }
    if (!this.isProbablyMoneroAddress(address)) {
      this.setXmrLocalError('Enter a valid-looking Monero mainnet address.');
      return;
    }
    if (!this.isHex64(privateViewKey)) {
      this.setXmrLocalError('Enter a 64-character hexadecimal private view key.');
      return;
    }

    this.xmrLocalStatus = 'loading';
    this.xmrLocalResult = null;
    this.xmrLocalError = '';
    const run = ++this.xmrLocalVerificationRun;

    this.xmrLocalTxVerifier.verifyReceivedTx(tx, address, privateViewKey)
      .then((result) => this.applyXmrLocalResult(result, run, txid))
      .catch((error) => this.applyXmrLocalError(error, run, txid));
  }

  verifyXmrTxSecretKey(): void {
    const address = this.xmrTxSecret.address.trim();
    const txSecretKey = this.xmrTxSecret.txSecretKey.trim();
    const tx = this.tx;
    const txid = tx?.txid;

    if (!address || !txSecretKey) {
      this.setXmrLocalError('Address and tx_secret_key are required.');
      return;
    }
    if (!txid) {
      this.setXmrLocalError('Load a transaction before running local verification.');
      return;
    }
    if (!this.isProbablyMoneroAddress(address)) {
      this.setXmrLocalError('Enter a valid-looking Monero mainnet address.');
      return;
    }
    if (!this.isTxSecretKey(txSecretKey)) {
      this.setXmrLocalError('Enter the hexadecimal tx_secret_key from the sending wallet.');
      return;
    }

    this.xmrLocalStatus = 'loading';
    this.xmrLocalResult = null;
    this.xmrLocalError = '';
    const run = ++this.xmrLocalVerificationRun;

    this.xmrLocalTxVerifier.verifyTxSecretKey(tx, address, txSecretKey)
      .then((result) => this.applyXmrLocalResult(result, run, txid))
      .catch((error) => this.applyXmrLocalError(error, run, txid));
  }

  private applyXmrLocalResult(result: XmrLocalTxVerificationResult, run: number, txid: string): void {
    if (!this.isCurrentXmrLocalVerification(run, txid)) {
      return;
    }
    this.xmrLocalResult = result;
    this.xmrLocalStatus = result.ok ? 'success' : 'error';
    this.xmrLocalError = result.ok ? '' : result.message;
    this.cd.markForCheck();
  }

  private applyXmrLocalError(error: unknown, run: number, txid: string): void {
    if (!this.isCurrentXmrLocalVerification(run, txid)) {
      return;
    }
    this.xmrLocalResult = null;
    this.xmrLocalStatus = 'error';
    this.xmrLocalError = error instanceof Error ? error.message : 'Unable to verify this transaction locally.';
    this.cd.markForCheck();
  }

  private setXmrLocalError(message: string): void {
    this.xmrLocalStatus = 'error';
    this.xmrLocalResult = null;
    this.xmrLocalError = message;
  }

  private resetXmrProof(): void {
    this.xmrProof = { address: '', signature: '', message: '' };
    this.xmrProofStatus = 'idle';
    this.xmrProofResult = null;
    this.xmrProofError = '';
  }

  private resetXmrLocalVerification(): void {
    this.cancelXmrLocalVerification();
    this.xmrLocalReceive = { address: '', privateViewKey: '' };
    this.xmrTxSecret = { address: '', txSecretKey: '' };
    this.resetXmrLocalResult(true);
  }

  private resetXmrLocalResult(force = false): void {
    if (force || this.xmrLocalStatus !== 'loading') {
      this.xmrLocalStatus = 'idle';
      this.xmrLocalResult = null;
      this.xmrLocalError = '';
    }
  }

  private resetXmrVerificationResults(): void {
    if (this.xmrProofStatus !== 'loading') {
      this.xmrProofStatus = 'idle';
      this.xmrProofResult = null;
      this.xmrProofError = '';
    }
    this.cancelXmrLocalVerification();
    this.resetXmrLocalResult(true);
  }

  private cancelXmrLocalVerification(): void {
    this.xmrLocalVerificationRun += 1;
  }

  private isCurrentXmrLocalVerification(run: number, txid: string): boolean {
    return run === this.xmrLocalVerificationRun && this.tx?.txid === txid;
  }

  private isProbablyMoneroAddress(address: string): boolean {
    return /^[48][1-9A-HJ-NP-Za-km-z]{94,105}$/.test(address.trim());
  }

  private isHex64(value: string): boolean {
    return /^[a-f0-9]{64}$/i.test(value.trim());
  }

  private isTxSecretKey(value: string): boolean {
    const trimmed = value.trim();
    return /^[a-f0-9]{64,4096}$/i.test(trimmed) && trimmed.length % 64 === 0;
  }

  resetTransaction() {
    this.gotInitialPosition = false;
    this.error = undefined;
    this.tx = null;
    this.txChanged$.next(true);
    this.setFeatures();
    this.waitingForTransaction = false;
    this.isLoadingTx = true;
    this.transactionTime = -1;
    this.mempoolPosition = null;
    this.isDetailsOpen = this.route.snapshot.queryParams['showDetails'] === 'true';
    this.resetXmrProof();
    this.resetXmrLocalVerification();
    document.body.scrollTo(0, 0);
    this.leaveTransaction();
  }

  leaveTransaction() {
    this.websocketService.stopTrackingTransaction();
    this.stateService.markBlock$.next({});
  }

  // simulate normal anchor fragment behavior
  applyFragment(): void {
    const anchor = Array.from(this.fragmentParams.entries()).find(([frag, value]) => value === '');
    if (anchor?.length) {
      const anchorElement = document.getElementById(anchor[0]);
      if (anchorElement) {
        anchorElement.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }

  updateFragmentParams(fragment: string | null): void {
    this.fragmentParams = new URLSearchParams(fragment || '');
    const vin = parseInt(this.fragmentParams.get('vin'), 10);
    const vout = parseInt(this.fragmentParams.get('vout'), 10);
    this.inputIndex = (!isNaN(vin) && vin >= 0) ? vin : null;
    this.outputIndex = (!isNaN(vout) && vout >= 0) ? vout : null;
    setTimeout(() => { this.applyFragment(); }, 0);
  }

  @HostListener('window:resize', ['$event'])
  updateViewportState(): void {
    this.isMobile = window.innerWidth < 850;
  }

  ngOnDestroy() {
    this.subscription.unsubscribe();
    this.transactionTimesSubscription.unsubscribe();
    this.networkChangedSubscription.unsubscribe();
    this.queryParamsSubscription.unsubscribe();
    this.urlFragmentSubscription.unsubscribe();
    this.mempoolPositionSubscription.unsubscribe();
    this.blocksSubscription.unsubscribe();
    this.txConfirmedSubscription?.unsubscribe();
    this.currencyChangeSubscription?.unsubscribe();
    this.resetXmrProof();
    this.resetXmrLocalVerification();
    this.leaveTransaction();
  }
}
