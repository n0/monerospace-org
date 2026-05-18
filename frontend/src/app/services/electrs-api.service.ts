import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { BehaviorSubject, Observable, catchError, filter, of, shareReplay, take, tap } from 'rxjs';
import { Transaction, Outspend, Recent, Asset, TxProofRequest, TxProofResponse } from '@interfaces/electrs.interface';
import { StateService } from '@app/services/state.service';
import { BlockExtended } from '@interfaces/node-api.interface';

@Injectable({
  providedIn: 'root'
})
export class ElectrsApiService {
  private apiBaseUrl: string; // base URL is protocol, hostname, and port
  private apiBasePath: string; // network path is /testnet, etc. or '' for mainnet

  private requestCache = new Map<string, { subject: BehaviorSubject<any>, expiry: number }>;

  constructor(
    private httpClient: HttpClient,
    private stateService: StateService,
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

  getBlock$(hash: string): Observable<BlockExtended> {
    return this.httpClient.get<BlockExtended>(this.apiBaseUrl + this.apiBasePath + '/api/block/' + hash);
  }

  listBlocks$(height?: number): Observable<BlockExtended[]> {
    return this.httpClient.get<BlockExtended[]>(this.apiBaseUrl + this.apiBasePath + '/api/blocks/' + (height || ''));
  }

  getTransaction$(txId: string): Observable<Transaction> {
    return this.httpClient.get<Transaction>(this.apiBaseUrl + this.apiBasePath + '/api/tx/' + txId);
  }

  getTransactionHex$(txId: string): Observable<string> {
    return this.httpClient.get(this.apiBaseUrl + this.apiBasePath + '/api/tx/' + txId + '/hex', { responseType: 'text' });
  }

  verifyTxProof$(txId: string, proof: TxProofRequest): Observable<TxProofResponse> {
    return this.httpClient.post<TxProofResponse>(this.apiBaseUrl + this.apiBasePath + '/api/tx/' + txId + '/verify-proof', proof);
  }

  getRecentTransaction$(): Observable<Recent[]> {
    return this.httpClient.get<Recent[]>(this.apiBaseUrl + this.apiBasePath + '/api/mempool/recent');
  }

  getOutspend$(hash: string, vout: number): Observable<Outspend> {
    return this.httpClient.get<Outspend>(this.apiBaseUrl + this.apiBasePath + '/api/tx/' + hash + '/outspend/' + vout);
  }

  getOutspends$(hash: string): Observable<Outspend[]> {
    return this.httpClient.get<Outspend[]>(this.apiBaseUrl + this.apiBasePath + '/api/tx/' + hash + '/outspends');
  }

  getOutspendsBatched$(txids: string[]): Observable<Outspend[][]> {
    let params = new HttpParams();
    params = params.append('txids', txids.join(','));
    return this.httpClient.get<Outspend[][]>(this.apiBaseUrl + this.apiBasePath + '/api/txs/outspends', { params });
  }

  getBlockTransactions$(hash: string, index: number = 0): Observable<Transaction[]> {
    return this.httpClient.get<Transaction[]>(this.apiBaseUrl + this.apiBasePath + '/api/block/' + hash + '/txs/' + index);
  }

  getBlockHashFromHeight$(height: number): Observable<string> {
    return this.httpClient.get(this.apiBaseUrl + this.apiBasePath + '/api/block-height/' + height, {responseType: 'text'});
  }

  getBlockTxId$(hash: string, index: number): Observable<string> {
    return this.httpClient.get(this.apiBaseUrl + this.apiBasePath + '/api/block/' + hash + '/txid/' + index, { responseType: 'text' });
  }

  getAsset$(assetId: string): Observable<Asset> {
    return this.httpClient.get<Asset>(this.apiBaseUrl + this.apiBasePath + '/api/asset/' + assetId);
  }

  getAssetTransactions$(assetId: string): Observable<Transaction[]> {
    return this.httpClient.get<Transaction[]>(this.apiBaseUrl + this.apiBasePath + '/api/asset/' + assetId + '/txs');
  }

  getAssetTransactionsFromHash$(assetId: string, txid: string): Observable<Transaction[]> {
    return this.httpClient.get<Transaction[]>(this.apiBaseUrl + this.apiBasePath + '/api/asset/' + assetId + '/txs/chain/' + txid);
  }

}
