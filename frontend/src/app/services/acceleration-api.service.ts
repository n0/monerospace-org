import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { StateService } from '@app/services/state.service';
import { AccelerationInfo } from '@interfaces/node-api.interface';

@Injectable({
  providedIn: 'root'
})
export class AccelerationApiService {
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

  getAccelerationsByPool$(slug: string): Observable<AccelerationInfo[]> {
    return this.httpClient.get<AccelerationInfo[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/accelerations/pool/${slug}`
    );
  }

  getAccelerationsByHeight$(height: number): Observable<AccelerationInfo[]> {
    return this.httpClient.get<AccelerationInfo[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/accelerations/block/${height}`
    );
  }

  getRecentAccelerations$(interval: string | undefined): Observable<AccelerationInfo[]> {
    return this.httpClient.get<AccelerationInfo[]>(
      this.apiBaseUrl + this.apiBasePath + '/api/v1/accelerations/interval' + (interval !== undefined ? `/${interval}` : '')
    );
  }

  getAccelerationTotals$(pool?: string, interval?: string): Observable<{ cost: number, count: number }> {
    const queryParams = new URLSearchParams();
    if (pool) {
      queryParams.append('pool', pool);
    }
    if (interval) {
      queryParams.append('interval', interval);
    }
    const queryString = queryParams.toString();
    return this.httpClient.get<{ cost: number, count: number }>(
      this.apiBaseUrl + this.apiBasePath + '/api/v1/accelerations/total' + (queryString?.length ? '?' + queryString : '')
    );
  }

  logAccelerationRequest$(txid: string): Observable<any> {
    return this.httpClient.post(this.apiBaseUrl + this.apiBasePath + '/api/v1/acceleration/request/' + txid, '');
  }
}
