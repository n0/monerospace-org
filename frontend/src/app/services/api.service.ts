import { Injectable } from '@angular/core';
import { HttpClient, HttpParams, HttpResponse } from '@angular/common/http';
import { OptimizedMempoolStats, BlockExtended, TransactionStripped, RewardStats, BlockSizesAndWeights } from '@interfaces/node-api.interface';
import { BehaviorSubject, Observable, catchError, filter, of, shareReplay, take, tap } from 'rxjs';
import { StateService } from '@app/services/state.service';
import { Conversion } from '@app/services/price.service';
import { StorageService } from '@app/services/storage.service';
import { WebsocketResponse } from '@interfaces/websocket.interface';

export interface XmrBackendHealth {
  ok: boolean;
  service: string;
}

export interface XmrDaemonInfo {
  height: number;
  target_height: number;
  difficulty: number;
  hashrate_hs: number;
  mempool_size: number;
  tx_count: number;
  nettype: string;
  top_block_hash: string;
  block_size_limit: number;
  version?: string;
  daemon_status?: string;
  synced: boolean;
  offline?: boolean;
  untrusted: boolean;
  outgoing_connections_count?: number;
  incoming_connections_count?: number;
  rpc_connections_count?: number;
  white_peerlist_size?: number;
  grey_peerlist_size?: number;
  start_time?: number;
  uptime_s?: number | null;
  database_size?: number;
  free_space?: number;
  height_without_bootstrap?: number;
  bootstrap_daemon_address?: string;
  was_bootstrap_ever_used?: boolean;
  update_available?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private apiBaseUrl: string; // base URL is protocol, hostname, and port
  private apiBasePath: string; // network path is /testnet, etc. or '' for mainnet

  private requestCache = new Map<string, { subject: BehaviorSubject<any>, expiry: number }>;
  public blockSummaryLoaded: { [hash: string]: boolean } = {};

  constructor(
    private httpClient: HttpClient,
    private stateService: StateService,
    private storageService: StorageService
  ) {
    this.apiBaseUrl = ''; // use relative URL by default
    if (!stateService.isBrowser) { // except when inside AU SSR process
      this.apiBaseUrl = this.stateService.env.NGINX_PROTOCOL + '://' + this.stateService.env.NGINX_HOSTNAME + ':' + this.stateService.env.NGINX_PORT;
    }
    this.apiBasePath = ''; // assume mainnet by default
    this.stateService.networkChanged$.subscribe((network) => {
      this.apiBasePath = network && network !== this.stateService.env.ROOT_NETWORK ? '/' + network : '';
    });
  }

  private generateCacheKey(functionName: string, params: any[]): string {
    return functionName + JSON.stringify(params);
  }

  // delete expired cache entries
  private cleanExpiredCache(): void {
    this.requestCache.forEach((value, key) => {
      if (value.expiry < Date.now()) {
        this.requestCache.delete(key);
      }
    });
  }

  cachedRequest<T, F extends (...args: any[]) => Observable<T>>(
    apiFunction: F,
    expireAfter: number, // in ms
    ...params: Parameters<F>
  ): Observable<T> {
    this.cleanExpiredCache();

    const cacheKey = this.generateCacheKey(apiFunction.name, params);
    if (!this.requestCache.has(cacheKey)) {
      const subject = new BehaviorSubject<T | null>(null);
      this.requestCache.set(cacheKey, { subject, expiry: Date.now() + expireAfter });

      apiFunction.bind(this)(...params).pipe(
        tap(data => {
          subject.next(data as T);
        }),
        catchError((error) => {
          subject.error(error);
          return of(null);
        }),
        shareReplay(1),
      ).subscribe();
    }

    return this.requestCache.get(cacheKey).subject.asObservable().pipe(filter(val => val !== null), take(1));
  }

  list2HStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/2h');
  }

  list24HStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/24h');
  }

  list1WStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/1w');
  }

  list1MStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/1m');
  }

  list3MStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/3m');
  }

  list6MStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/6m');
  }

  list1YStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/1y');
  }

  list2YStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/2y');
  }

  list3YStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/3y');
  }

  list4YStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/4y');
  }

  listAllTimeStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/all');
  }

  getTransactionTimes$(txIds: string[]): Observable<number[]> {
    let params = new HttpParams();
    txIds.forEach((txId: string) => {
      params = params.append('txId[]', txId);
    });
    return this.httpClient.get<number[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/transaction-times', { params });
  }

  getInitData$(): Observable<WebsocketResponse> {
    return this.httpClient.get<WebsocketResponse>(this.apiBaseUrl + this.apiBasePath + '/api/v1/init-data');
  }

  getXmrBackendHealth$(): Observable<XmrBackendHealth> {
    return this.httpClient.get<XmrBackendHealth>(this.apiBaseUrl + '/healthz');
  }

  getXmrDaemonInfo$(): Observable<XmrDaemonInfo> {
    return this.httpClient.get<XmrDaemonInfo>(this.apiBaseUrl + this.apiBasePath + '/api/v1/info');
  }

  getTransactionStatus$(txid: string): Observable<any> {
    return this.httpClient.get<any>(this.apiBaseUrl + this.apiBasePath + '/api/tx/' + txid + '/status');
  }

  getBlocks$(from: number): Observable<BlockExtended[]> {
    return this.httpClient.get<BlockExtended[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/blocks` +
      (from !== undefined ? `/${from}` : ``)
    );
  }

  getBlock$(hash: string): Observable<BlockExtended> {
    return this.httpClient.get<BlockExtended>(this.apiBaseUrl + this.apiBasePath + '/api/v1/block/' + hash);
  }

  getBlockDataFromTimestamp$(timestamp: number): Observable<any> {
    return this.httpClient.get<number>(this.apiBaseUrl + this.apiBasePath + '/api/v1/mining/blocks/timestamp/' + timestamp);
  }

  getStrippedBlockTransactions$(hash: string): Observable<TransactionStripped[]> {
    this.setBlockSummaryLoaded(hash);
    return this.httpClient.get<TransactionStripped[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/block/' + hash + '/summary');
  }

  getStrippedBlockTransaction$(hash: string, txid: string): Observable<TransactionStripped> {
    return this.httpClient.get<TransactionStripped>(this.apiBaseUrl + this.apiBasePath + '/api/v1/block/' + hash + '/tx/' + txid + '/summary');
  }

  getDifficultyAdjustments$(interval: string | undefined): Observable<any> {
    return this.httpClient.get<any[]>(
        this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/difficulty-adjustments` +
        (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
      );
  }

  getHistoricalHashrate$(interval: string | undefined): Observable<any> {
    return this.httpClient.get<any[]>(
        this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/hashrate` +
        (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
      );
  }

  getHistoricalBlockFees$(interval: string | undefined) : Observable<any> {
    return this.httpClient.get<any[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/blocks/fees` +
      (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
    );
  }

  getBlockFeesFromTimespan$(from: number, to: number): Observable<any> {
    return this.httpClient.get<any[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/blocks/fees?from=${from}&to=${to}`, { observe: 'response' }
    );
  }

  getHistoricalBlockRewards$(interval: string | undefined) : Observable<any> {
    return this.httpClient.get<any[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/blocks/rewards` +
      (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
    );
  }

  getHistoricalBlockFeeRates$(interval: string | undefined) : Observable<any> {
    return this.httpClient.get<any[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/blocks/fee-rates` +
      (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
    );
  }

  getHistoricalBlockSizesAndWeights$(interval: string | undefined) : Observable<HttpResponse<BlockSizesAndWeights>> {
    return this.httpClient.get<BlockSizesAndWeights>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/blocks/sizes-weights` +
      (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
    );
  }

  getRewardStats$(blockCount: number = 144): Observable<RewardStats> {
    return this.httpClient.get<RewardStats>(this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/reward-stats/${blockCount}`);
  }

  getHistoricalPrice$(timestamp: number | undefined, currency?: string): Observable<Conversion> {
    if (this.stateService.isAnyTestnet()) {
      return of({
        prices: [],
        exchangeRates: {
          USDEUR: 0,
          USDGBP: 0,
          USDCAD: 0,
          USDCHF: 0,
          USDAUD: 0,
          USDJPY: 0,
          USDBGN: 0,
          USDBRL: 0,
          USDCNY: 0,
          USDCZK: 0,
          USDDKK: 0,
          USDHKD: 0,
          USDHRK: 0,
          USDHUF: 0,
          USDIDR: 0,
          USDILS: 0,
          USDINR: 0,
          USDISK: 0,
          USDKRW: 0,
          USDMXN: 0,
          USDMYR: 0,
          USDNOK: 0,
          USDNZD: 0,
          USDPHP: 0,
          USDPLN: 0,
          USDRON: 0,
          USDRUB: 0,
          USDSEK: 0,
          USDSGD: 0,
          USDTHB: 0,
          USDTRY: 0,
          USDZAR: 0,
        }
      });
    }
    const queryParams = [];

    if (timestamp) {
      queryParams.push(`timestamp=${timestamp}`);
    }

    if (currency) {
      queryParams.push(`currency=${currency}`);
    }
    return this.httpClient.get<Conversion>(
      `${this.apiBaseUrl}${this.apiBasePath}/api/v1/historical-price` +
        (queryParams.length > 0 ? `?${queryParams.join('&')}` : '')
    );
  }

  // Cache methods
  async setBlockSummaryLoaded(hash: string) {
    this.blockSummaryLoaded[hash] = true;
  }

  getBlockSummaryLoaded(hash) {
    return this.blockSummaryLoaded[hash];
  }
}
