import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { StateService } from '@app/services/state.service';
import { ChainTip, StaleTip } from '@interfaces/node-api.interface';

@Injectable({
  providedIn: 'root'
})
export class ChainTipsApiService {
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

  getChainTips$(): Observable<ChainTip[]> {
    return this.httpClient.get<ChainTip[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/chain-tips');
  }

  getStaleTips$(): Observable<StaleTip[]> {
    return this.httpClient.get<StaleTip[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/stale-tips');
  }
}
