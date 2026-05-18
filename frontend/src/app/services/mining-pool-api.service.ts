import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { BlockExtended, PoolStat } from '@interfaces/node-api.interface';
import { StateService } from '@app/services/state.service';

export interface PoolHashrateRow {
  timestamp: number;
  avgHeight: number;
  avgHashRate: number;
  avgHashrate: number;
  share: number;
  poolName: string;
  poolSlug: string;
}

@Injectable({
  providedIn: 'root'
})
export class MiningPoolApiService {
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

  listPools$(interval: string | undefined): Observable<any> {
    return this.httpClient.get<any>(
      this.apiBaseUrl + this.apiBasePath + '/api/v1/mining/pools' +
      (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
    )
    .pipe(
      map((response) => {
        const pools = interval !== undefined ? response.body.pools : response.body;
        pools.forEach((pool) => {
          if ((interval !== undefined && pool.poolUniqueId === 0) || (interval === undefined && pool.unique_id === 0)) {
            pool.name = $localize`:@@e5d8bb389c702588877f039d72178f219453a72d:Unknown`;
          }
        });
        return response;
      })
    );
  }

  getPoolStats$(slug: string): Observable<PoolStat> {
    return this.httpClient.get<PoolStat>(this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/pool/${slug}`)
      .pipe(
        map((poolStats) => {
          if (poolStats.pool.unique_id === 0) {
            poolStats.pool.name = $localize`:@@e5d8bb389c702588877f039d72178f219453a72d:Unknown`;
          }
          return poolStats;
        })
      );
  }

  getPoolHashrate$(slug: string): Observable<PoolHashrateRow[]> {
    return this.httpClient.get<PoolHashrateRow[]>(this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/pool/${slug}/hashrate`);
  }

  getPoolBlocks$(slug: string, fromHeight?: number): Observable<BlockExtended[]> {
    return this.httpClient.get<BlockExtended[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/pool/${slug}/blocks` +
      (fromHeight !== undefined ? `/${fromHeight}` : '')
    );
  }

  getHistoricalPoolsHashrate$(interval: string | undefined): Observable<any> {
    return this.httpClient.get<any[]>(
      this.apiBaseUrl + this.apiBasePath + '/api/v1/mining/hashrate/pools' +
      (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
    );
  }
}
