import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { StateService } from '@app/services/state.service';
import { Transaction } from '@interfaces/electrs.interface';
import { RbfTree } from '@interfaces/node-api.interface';

@Injectable({
  providedIn: 'root'
})
export class RbfApiService {
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

  getRbfHistory$(txid: string): Observable<{ replacements: RbfTree, replaces: string[] }> {
    return this.httpClient.get<{ replacements: RbfTree, replaces: string[] }>(
      this.apiBaseUrl + this.apiBasePath + '/api/v1/tx/' + txid + '/rbf'
    );
  }

  getRbfCachedTx$(txid: string): Observable<Transaction> {
    return this.httpClient.get<Transaction>(
      this.apiBaseUrl + this.apiBasePath + '/api/v1/tx/' + txid + '/cached'
    );
  }

  getRbfList$(fullRbf: boolean, after?: string): Observable<RbfTree[]> {
    return this.httpClient.get<RbfTree[]>(
      this.apiBaseUrl + this.apiBasePath + '/api/v1/' + (fullRbf ? 'fullrbf/' : '') + 'replacements/' + (after || '')
    );
  }
}
