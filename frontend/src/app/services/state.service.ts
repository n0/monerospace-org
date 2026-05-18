import { Inject, Injectable, PLATFORM_ID, LOCALE_ID } from '@angular/core';
import { ReplaySubject, BehaviorSubject, Subject, fromEvent, Observable } from 'rxjs';
import { Transaction } from '@interfaces/electrs.interface';
import { HealthCheckHost, IBackendInfo, MempoolBlock, MempoolBlockUpdate, MempoolInfo, Recommendedfees, isMempoolState } from '@interfaces/websocket.interface';
import { BlockExtended, CpfpInfo, DifficultyAdjustment, MempoolPosition, OptimizedMempoolStats, TransactionStripped } from '@interfaces/node-api.interface';
import { Router, NavigationStart, NavigationEnd } from '@angular/router';
import { isPlatformBrowser } from '@angular/common';
import { filter, map, scan, share, shareReplay } from 'rxjs/operators';
import { StorageService } from '@app/services/storage.service';
import { hasTouchScreen } from '@app/shared/pipes/bytes-pipe/utils';
import { ActiveFilter } from '@app/shared/filters.utils';

export interface MarkBlockState {
  blockHeight?: number;
  txid?: string;
  mempoolBlockIndex?: number;
  txFeePerVSize?: number;
  mempoolPosition?: MempoolPosition;
}

export interface ILoadingIndicators { [name: string]: number; }

export type ViewAmountMode = 'xmr' | 'atomic' | 'fiat';

export interface Customization {
  theme: string;
  enterprise?: string;
  branding: {
    name: string;
    site_id?: number;
    title: string;
    img?: string;
    header_img?: string;
    footer_img?: string;
    rounded_corner: boolean;
    cobranded?: boolean;
  },
  dashboard: {
    widgets: {
      component: string;
      mobileOrder?: number;
      props: { [key: string]: any };
    }[];
  };
}

export type SignaturesMode = 'all' | 'interesting' | 'none' | null;

export interface Env {
  MAINNET_ENABLED: boolean;
  TESTNET_ENABLED: boolean;
  TESTNET4_ENABLED: boolean;
  SIGNET_ENABLED: boolean;
  REGTEST_ENABLED: boolean;
  LIQUID_ENABLED: boolean;
  LIQUID_TESTNET_ENABLED: boolean;
  ITEMS_PER_PAGE: number;
  KEEP_BLOCKS_AMOUNT: number;
  OFFICIAL_MEMPOOL_SPACE: boolean;
  BASE_MODULE: string;
  ROOT_NETWORK: string;
  NGINX_PROTOCOL?: string;
  NGINX_HOSTNAME?: string;
  NGINX_PORT?: string;
  BLOCK_WEIGHT_UNITS: number;
  MEMPOOL_BLOCKS_AMOUNT: number;
  GIT_COMMIT_HASH: string;
  PACKAGE_JSON_VERSION: string;
  MEMPOOL_WEBSITE_URL: string;
  LIQUID_WEBSITE_URL: string;
  MINING_DASHBOARD: boolean;
  MAINNET_TX_FIRST_SEEN_START_HEIGHT: number;
  TESTNET_TX_FIRST_SEEN_START_HEIGHT: number;
  TESTNET4_TX_FIRST_SEEN_START_HEIGHT: number;
  SIGNET_TX_FIRST_SEEN_START_HEIGHT: number;
  REGTEST_TX_FIRST_SEEN_START_HEIGHT: number;
  HISTORICAL_PRICE: boolean;
  ADDITIONAL_CURRENCIES: boolean;
  GIT_COMMIT_HASH_MEMPOOL_SPACE?: string;
  PACKAGE_JSON_VERSION_MEMPOOL_SPACE?: string;
  SERVICES_API?: string;
  customize?: Customization;
  PROD_DOMAINS: string[];
}

const defaultEnv: Env = {
  'MAINNET_ENABLED': true,
  'TESTNET_ENABLED': false,
  'TESTNET4_ENABLED': false,
  'SIGNET_ENABLED': false,
  'REGTEST_ENABLED': false,
  'LIQUID_ENABLED': false,
  'LIQUID_TESTNET_ENABLED': false,
  'BASE_MODULE': 'mempool',
  'ROOT_NETWORK': '',
  'ITEMS_PER_PAGE': 10,
  'KEEP_BLOCKS_AMOUNT': 8,
  'OFFICIAL_MEMPOOL_SPACE': false,
  'NGINX_PROTOCOL': 'http',
  'NGINX_HOSTNAME': '127.0.0.1',
  'NGINX_PORT': '80',
  'BLOCK_WEIGHT_UNITS': 4000000,
  'MEMPOOL_BLOCKS_AMOUNT': 8,
  'GIT_COMMIT_HASH': '',
  'PACKAGE_JSON_VERSION': '',
  'MEMPOOL_WEBSITE_URL': '',
  'LIQUID_WEBSITE_URL': '',
  // xmr-space: enabled now that XmrChainIndexer hydrates per-block
  // size/fees/reward from xmrchain.net and difficulty from monerod.
  // Pool-related dropdowns (pools-ranking, pools-dominance) stay stripped
  // from graphs.component.html until the best-effort pool stats have a
  // retargeted frontend surface; the non-pool mining graphs are real.
  'MINING_DASHBOARD': true,
  'MAINNET_TX_FIRST_SEEN_START_HEIGHT': 0,
  'TESTNET_TX_FIRST_SEEN_START_HEIGHT': 0,
  'TESTNET4_TX_FIRST_SEEN_START_HEIGHT': 0,
  'SIGNET_TX_FIRST_SEEN_START_HEIGHT': 0,
  'REGTEST_TX_FIRST_SEEN_START_HEIGHT': 0,
  // xmr-space: current XMR fiat conversions are wired over the websocket,
  // while /api/v1/historical-price serves the durable local XMR price series.
  'HISTORICAL_PRICE': true,
  'ADDITIONAL_CURRENCIES': false,
  'SERVICES_API': '/api/v1/services',
  'PROD_DOMAINS': [],
};

@Injectable({
  providedIn: 'root'
})
export class StateService {
  referrer: string = '';
  isBrowser: boolean = isPlatformBrowser(this.platformId);
  isMempoolSpaceBuild = window['isMempoolSpaceBuild'] ?? false;
  isProdDomain: boolean;
  backend: 'esplora' | 'electrum' | 'none' = 'esplora';
  network = '';
  blockVSize: number;
  env: Env;
  latestBlockHeight = -1;
  blocks: BlockExtended[] = [];
  mempoolSequence: number;
  mempoolBlockState: { block: number, transactions: { [txid: string]: TransactionStripped} };

  backend$ = new BehaviorSubject<'esplora' | 'electrum' | 'none'>('esplora');
  networkChanged$ = new ReplaySubject<string>(1);
  signaturesMode$: BehaviorSubject<SignaturesMode>;
  blocksSubject$ = new BehaviorSubject<BlockExtended[]>([]);
  blocks$: Observable<BlockExtended[]>;
  transactions$ = new BehaviorSubject<TransactionStripped[]>(null);
  conversions$ = new ReplaySubject<Record<string, number>>(1);
  mempoolInfo$ = new ReplaySubject<MempoolInfo>(1);
  mempoolBlocks$ = new ReplaySubject<MempoolBlock[]>(1);
  mempoolBlockUpdate$ = new Subject<MempoolBlockUpdate>();
  liveMempoolBlockTransactions$: Observable<{ block: number, transactions: { [txid: string]: TransactionStripped} }>;
  txConfirmed$ = new Subject<[string, BlockExtended]>();
  difficultyAdjustment$ = new ReplaySubject<DifficultyAdjustment>(1);
  mempoolTransactions$ = new Subject<Transaction>();
  mempoolTxPosition$ = new BehaviorSubject<{ txid: string, position: MempoolPosition, cpfp: CpfpInfo | null }>(null);
  blockTransactions$ = new Subject<Transaction>();
  isLoadingWebSocket$ = new ReplaySubject<boolean>(1);
  isLoadingMempool$ = new BehaviorSubject<boolean>(true);
  bytesPerSecond$ = new ReplaySubject<number>(1);
  previousRetarget$ = new ReplaySubject<number>(1);
  backendInfo$ = new ReplaySubject<IBackendInfo>(1);
  servicesBackendInfo$ = new ReplaySubject<IBackendInfo>(1);
  loadingIndicators$ = new ReplaySubject<ILoadingIndicators>(1);
  recommendedFees$ = new ReplaySubject<Recommendedfees>(1);
  chainTip$ = new ReplaySubject<number>(-1);
  serverHealth$ = new Subject<HealthCheckHost[]>();

  live2Chart$ = new Subject<OptimizedMempoolStats>();

  viewAmountMode$: BehaviorSubject<ViewAmountMode>;
  timezone$: BehaviorSubject<string>;
  connectionState$ = new BehaviorSubject<0 | 1 | 2>(2);
  isTabHidden$: Observable<boolean>;

  markBlock$ = new BehaviorSubject<MarkBlockState>({});
  keyNavigation$ = new Subject<KeyboardEvent>();
  searchText$ = new BehaviorSubject<string>('');

  blockScrolling$: Subject<boolean> = new Subject<boolean>();
  resetScroll$: Subject<boolean> = new Subject<boolean>();
  timeLtr: BehaviorSubject<boolean>;
  hideFlow: BehaviorSubject<boolean>;
  fiatCurrency$: BehaviorSubject<string>;
  rateUnits$: BehaviorSubject<string>;
  blockDisplayMode$: BehaviorSubject<string>;

  searchFocus$: Subject<boolean> = new Subject<boolean>();
  menuOpen$: BehaviorSubject<boolean> = new BehaviorSubject(false);

  activeGoggles$: BehaviorSubject<ActiveFilter> = new BehaviorSubject({ mode: 'and', filters: [], gradient: 'age' });

  constructor(
    @Inject(PLATFORM_ID) private platformId: any,
    @Inject(LOCALE_ID) private locale: string,
    private router: Router,
    private storageService: StorageService,
  ) {
    this.referrer = window.document.referrer;

    const browserWindow = window || {};
    // @ts-ignore
    const browserWindowEnv = browserWindow.__env || {};
    if (browserWindowEnv.PROD_DOMAINS && typeof(browserWindowEnv.PROD_DOMAINS) === 'string') {
      browserWindowEnv.PROD_DOMAINS = browserWindowEnv.PROD_DOMAINS.split(',');
    }

    this.env = Object.assign(defaultEnv, browserWindowEnv);

    if (defaultEnv.BASE_MODULE !== 'mempool') {
      this.env.MINING_DASHBOARD = false;
    }

    if (this.isBrowser) {
      this.setNetworkBasedonUrl(window.location.pathname);
      this.isTabHidden$ = fromEvent(document, 'visibilitychange').pipe(map(() => this.isHidden()), shareReplay());
    } else {
      this.setNetworkBasedonUrl('/');
      this.isTabHidden$ = new BehaviorSubject(false);
    }

    this.isProdDomain = this.testIsProdDomain(this.env.PROD_DOMAINS);

    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        this.setNetworkBasedonUrl(event.url);
      } else if (event instanceof NavigationEnd) {
        this.setNetworkBasedonUrl(event.urlAfterRedirects);
      }
    });

    this.liveMempoolBlockTransactions$ = this.mempoolBlockUpdate$.pipe(scan((acc: { block: number, transactions: { [txid: string]: TransactionStripped } }, change: MempoolBlockUpdate): { block: number, transactions: { [txid: string]: TransactionStripped } } => {
      if (isMempoolState(change)) {
        const txMap = {};
        change.transactions.forEach(tx => {
          txMap[tx.txid] = tx;
        });
        this.mempoolBlockState = {
          block: change.block,
          transactions: txMap
        };
        return this.mempoolBlockState;
      } else {
        change.added.forEach(tx => {
          acc.transactions[tx.txid] = tx;
        });
        change.removed.forEach(txid => {
          delete acc.transactions[txid];
        });
        change.changed.forEach(tx => {
          if (acc.transactions[tx.txid]) {
            acc.transactions[tx.txid].rate = tx.rate;
          }
        });
        this.mempoolBlockState = {
          block: change.block,
          transactions: acc.transactions
        };
        return this.mempoolBlockState;
      }
    }, {}),
    share()
    );
    this.liveMempoolBlockTransactions$.subscribe();

    this.networkChanged$.subscribe((network) => {
      this.transactions$ = new BehaviorSubject<TransactionStripped[]>(null);
      this.blocksSubject$.next([]);
    });

    this.signaturesMode$ = new BehaviorSubject<SignaturesMode>(this.storageService.getValue('signatures-mode') as SignaturesMode || null);

    this.blockVSize = this.env.BLOCK_WEIGHT_UNITS / 4;

    this.blocks$ = this.blocksSubject$.pipe(filter(blocks => blocks != null && blocks.length > 0));

    const savedTimePreference = this.storageService.getValue('time-preference-ltr');
    const rtlLanguage = (this.locale.startsWith('ar') || this.locale.startsWith('fa') || this.locale.startsWith('he'));
    // default time direction is right-to-left, unless locale is a RTL language
    this.timeLtr = new BehaviorSubject<boolean>(savedTimePreference === 'true' || (savedTimePreference == null && rtlLanguage));
    this.timeLtr.subscribe((ltr) => {
      this.storageService.setValue('time-preference-ltr', ltr ? 'true' : 'false');
    });

    const savedFlowPreference = this.storageService.getValue('flow-preference');
    this.hideFlow = new BehaviorSubject<boolean>(savedFlowPreference === 'hide');
    this.hideFlow.subscribe((hide) => {
      if (hide) {
        this.storageService.setValue('flow-preference', hide ? 'hide' : 'show');
      } else {
        this.storageService.removeItem('flow-preference');
      }
    });

    const fiatPreference = this.storageService.getValue('fiat-preference');
    this.fiatCurrency$ = new BehaviorSubject<string>(fiatPreference || 'USD');

    const rateUnitPreference = this.storageService.getValue('rate-unit-preference');
    this.rateUnits$ = new BehaviorSubject<string>(rateUnitPreference || 'vb');

    const blockDisplayModePreference = this.storageService.getValue('block-display-mode-preference');
    this.blockDisplayMode$ = new BehaviorSubject<string>(blockDisplayModePreference || 'fees');

    const storedViewAmountMode = this.storageService.getValue('view-amount-mode');
    const viewAmountModePreference: ViewAmountMode =
      storedViewAmountMode === 'atomic' ? 'atomic' :
      storedViewAmountMode === 'fiat' ? 'fiat' :
      'xmr';
    this.viewAmountMode$ = new BehaviorSubject<ViewAmountMode>(viewAmountModePreference);

    const timezonePreference = this.storageService.getValue('timezone-preference');
    this.timezone$ = new BehaviorSubject<string>(timezonePreference || 'local');

    this.backend$.subscribe(backend => {
      this.backend = backend;
    });
  }

  setNetworkBasedonUrl(_url: string) {
    if (this.network !== '') {
      this.network = '';
      this.networkChanged$.next('');
    }
  }

  get networkDisplayName(): string {
    return 'Mainnet';
  }
  getHiddenProp(){
    const prefixes = ['webkit', 'moz', 'ms', 'o'];
    if ('hidden' in document) { return 'hidden'; }
    for (const prefix of prefixes) {
      if ((prefix + 'Hidden') in document) {
        return prefix + 'Hidden';
      }
    }
    return null;
  }

  isHidden() {
    const prop = this.getHiddenProp();
    if (!prop) { return false; }
    return document[prop];
  }

  setBlockScrollingInProgress(value: boolean) {
    this.blockScrolling$.next(value);
  }

  isMainnet(): boolean {
    return true;
  }

  isAnyTestnet(): boolean {
    return false;
  }
  resetChainTip() {
    this.latestBlockHeight = -1;
    this.chainTip$.next(-1);
  }

  updateChainTip(height) {
    if (height > this.latestBlockHeight) {
      this.latestBlockHeight = height;
      this.chainTip$.next(height);
    }
  }

  resetBlocks(blocks: BlockExtended[]): void {
    this.blocks = blocks.reverse();
    this.blocksSubject$.next(blocks);
  }

  addBlock(block: BlockExtended): void {
    this.blocks.unshift(block);
    this.blocks = this.blocks.slice(0, this.env.KEEP_BLOCKS_AMOUNT);
    this.blocksSubject$.next(this.blocks);
  }

  focusSearchInputDesktop() {
    if (!hasTouchScreen()) {
      this.searchFocus$.next(true);
    }
  }
  private testIsProdDomain(prodDomains: string[]): boolean {
    const hostname = document.location.hostname;
    return prodDomains.some(domain =>
      hostname === domain || hostname.endsWith('.' + domain)
    );
  }
}
