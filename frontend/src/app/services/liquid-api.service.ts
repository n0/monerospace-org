import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { StateService } from '@app/services/state.service';
import {
  AuditStatus,
  CurrentPegs,
  FederationAddress,
  FederationUtxo,
  LiquidPegs,
  PegsVolume,
  RecentPeg,
} from '@interfaces/node-api.interface';

@Injectable({
  providedIn: 'root'
})
export class LiquidApiService {
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

  liquidPegs$(): Observable<CurrentPegs> {
    return this.httpClient.get<CurrentPegs>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/pegs');
  }

  pegsVolume$(): Observable<PegsVolume[]> {
    return this.httpClient.get<PegsVolume[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/pegs/volume');
  }

  listLiquidPegsMonth$(): Observable<LiquidPegs[]> {
    return this.httpClient.get<LiquidPegs[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/pegs/month');
  }

  liquidReserves$(): Observable<CurrentPegs> {
    return this.httpClient.get<CurrentPegs>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves');
  }

  listLiquidReservesMonth$(): Observable<LiquidPegs[]> {
    return this.httpClient.get<LiquidPegs[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/month');
  }

  federationAuditSynced$(): Observable<AuditStatus> {
    return this.httpClient.get<AuditStatus>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/status');
  }

  federationAddresses$(): Observable<FederationAddress[]> {
    return this.httpClient.get<FederationAddress[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/addresses');
  }

  federationUtxos$(): Observable<FederationUtxo[]> {
    return this.httpClient.get<FederationUtxo[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/utxos');
  }

  expiredUtxos$(): Observable<FederationUtxo[]> {
    return this.httpClient.get<FederationUtxo[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/utxos/expired');
  }

  emergencySpentUtxos$(): Observable<FederationUtxo[]> {
    return this.httpClient.get<FederationUtxo[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/utxos/emergency-spent');
  }

  recentPegsList$(count: number = 0): Observable<RecentPeg[]> {
    return this.httpClient.get<RecentPeg[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/pegs/list/' + count);
  }

  pegsCount$(): Observable<any> {
    return this.httpClient.get<number>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/pegs/count');
  }

  federationAddressesNumber$(): Observable<any> {
    return this.httpClient.get<any>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/addresses/total');
  }

  federationUtxosNumber$(): Observable<any> {
    return this.httpClient.get<any>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/utxos/total');
  }

  emergencySpentUtxosStats$(): Observable<any> {
    return this.httpClient.get<any>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/utxos/emergency-spent/stats');
  }

  listFeaturedAssets$(network: string = 'liquid'): Observable<any[]> {
    if (network === 'liquid') {
      return this.httpClient.get<any[]>(this.apiBaseUrl + '/api/v1/assets/featured');
    }
    return of([]);
  }

  getAssetGroup$(id: string): Observable<any> {
    return this.httpClient.get<any[]>(this.apiBaseUrl + '/api/v1/assets/group/' + id);
  }
}
