import { Injectable } from '@angular/core';
import { HttpClient, HttpResponse } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { PoolsStats, SinglePoolStats } from '@interfaces/node-api.interface';
import { StateService } from '@app/services/state.service';

interface PoolDirectoryStat extends SinglePoolStats {
  unique_id?: number;
}

@Injectable({
  providedIn: 'root'
})
export class MiningPoolStatsApiService {
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

  listPools$(interval: string): Observable<HttpResponse<PoolsStats>>;
  listPools$(interval: undefined): Observable<HttpResponse<SinglePoolStats[]>>;
  listPools$(interval: string | undefined): Observable<HttpResponse<PoolsStats | SinglePoolStats[]>> {
    return this.httpClient.get<PoolsStats | SinglePoolStats[]>(
      this.apiBaseUrl + this.apiBasePath + '/api/v1/mining/pools' +
      (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
    )
    .pipe(
      map((response) => {
        const pools = interval !== undefined
          ? ((response.body as PoolsStats | null)?.pools ?? [])
          : ((response.body as SinglePoolStats[] | null) ?? []);

        pools.forEach((pool) => {
          if ((interval !== undefined && pool.poolUniqueId === 0) || (interval === undefined && (pool as PoolDirectoryStat).unique_id === 0)) {
            pool.name = $localize`:@@e5d8bb389c702588877f039d72178f219453a72d:Unknown`;
          }
        });

        return response;
      })
    );
  }
}
