import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { StateService } from '@app/services/state.service';
import { CpfpInfo, SubmitPackageResult, TestMempoolAcceptResult } from '@interfaces/node-api.interface';

@Injectable({
  providedIn: 'root'
})
export class TransactionToolsApiService {
  private apiBaseUrl: string;
  private apiBasePath: string;

  constructor(
    private httpClient: HttpClient,
    private stateService: StateService,
  ) {
    this.apiBaseUrl = '';
    if (!stateService.isBrowser) {
      this.apiBaseUrl = this.stateService.env.NGINX_PROTOCOL + '://' + this.stateService.env.NGINX_HOSTNAME + ':' + this.stateService.env.NGINX_PORT;
    }
    this.apiBasePath = '';
    this.stateService.networkChanged$.subscribe((network) => {
      this.apiBasePath = network && network !== this.stateService.env.ROOT_NETWORK ? '/' + network : '';
    });
  }

  getCpfpinfo$(txid: string): Observable<CpfpInfo> {
    return this.httpClient.get<CpfpInfo>(this.apiBaseUrl + this.apiBasePath + '/api/v1/cpfp/' + txid);
  }

  postTransaction$(hexPayload: string): Observable<any> {
    return this.httpClient.post<any>(this.apiBaseUrl + this.apiBasePath + '/api/tx', hexPayload, { responseType: 'text' as 'json' });
  }

  testTransactions$(rawTxs: string[], maxfeerate?: number): Observable<TestMempoolAcceptResult[]> {
    return this.httpClient.post<TestMempoolAcceptResult[]>(this.apiBaseUrl + this.apiBasePath + `/api/txs/test${maxfeerate != null ? '?maxfeerate=' + maxfeerate.toFixed(8) : ''}`, rawTxs);
  }

  submitPackage$(rawTxs: string[], maxfeerate?: number, maxburnamount?: number): Observable<SubmitPackageResult> {
    const queryParams = [];

    if (maxfeerate) {
      queryParams.push(`maxfeerate=${maxfeerate}`);
    }

    if (maxburnamount) {
      queryParams.push(`maxburnamount=${maxburnamount}`);
    }
    return this.httpClient.post<SubmitPackageResult>(this.apiBaseUrl + this.apiBasePath + '/api/v1/txs/package' + (queryParams.length > 0 ? `?${queryParams.join('&')}` : ''), rawTxs);
  }

  getPrevouts$(outpoints: { txid: string; vout: number }[]): Observable<any> {
    return this.httpClient.post(this.apiBaseUrl + this.apiBasePath + '/api/v1/prevouts', outpoints);
  }

  getCpfpLocalTx$(tx: any[]): Observable<CpfpInfo[]> {
    return this.httpClient.post<CpfpInfo[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/cpfp', tx);
  }
}
