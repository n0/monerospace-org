import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, from, of, switchMap } from 'rxjs';
import { StateService } from '@app/services/state.service';
import { Address, AddressTxSummary, ScriptHash, Transaction, Utxo } from '@interfaces/electrs.interface';
import { calcScriptHash$ } from '@app/bitcoin.utils';
import { AddressInformation, Treasury, WalletAddress } from '@interfaces/node-api.interface';

@Injectable({
  providedIn: 'root'
})
export class AddressApiService {
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

  getAddress$(address: string): Observable<Address> {
    return this.httpClient.get<Address>(this.apiBaseUrl + this.apiBasePath + '/api/address/' + address);
  }

  validateAddress$(address: string): Observable<AddressInformation> {
    return this.httpClient.get<AddressInformation>(this.apiBaseUrl + this.apiBasePath + '/api/v1/validate-address/' + address);
  }

  getPubKeyAddress$(pubkey: string): Observable<Address> {
    const scriptpubkey = (pubkey.length === 130 ? '41' : '21') + pubkey + 'ac';
    return this.getScriptHash$(scriptpubkey).pipe(
      switchMap((scripthash: ScriptHash) => {
        return of({
          ...scripthash,
          address: pubkey,
          is_pubkey: true,
        });
      })
    );
  }

  getScriptHash$(script: string): Observable<ScriptHash> {
    return from(calcScriptHash$(script)).pipe(
      switchMap(scriptHash => this.httpClient.get<ScriptHash>(this.apiBaseUrl + this.apiBasePath + '/api/scripthash/' + scriptHash))
    );
  }

  getAddressTransactions$(address: string, txid?: string): Observable<Transaction[]> {
    let params = new HttpParams();
    if (txid) {
      params = params.append('after_txid', txid);
    }
    return this.httpClient.get<Transaction[]>(this.apiBaseUrl + this.apiBasePath + '/api/address/' + address + '/txs', { params });
  }

  getAddressesTransactions$(addresses: string[], txid?: string): Observable<Transaction[]> {
    let params = new HttpParams();
    if (txid) {
      params = params.append('after_txid', txid);
    }
    return this.httpClient.post<Transaction[]>(
      this.apiBaseUrl + this.apiBasePath + '/api/addresses/txs',
      addresses,
      { params }
    );
  }

  getAddressSummary$(address: string, txid?: string): Observable<AddressTxSummary[]> {
    let params = new HttpParams();
    if (txid) {
      params = params.append('after_txid', txid);
    }
    return this.httpClient.get<AddressTxSummary[]>(this.apiBaseUrl + this.apiBasePath + '/api/address/' + address + '/txs/summary', { params });
  }

  getAddressesSummary$(addresses: string[], txid?: string): Observable<AddressTxSummary[]> {
    let params = new HttpParams();
    if (txid) {
      params = params.append('after_txid', txid);
    }
    return this.httpClient.post<AddressTxSummary[]>(this.apiBaseUrl + this.apiBasePath + '/api/addresses/txs/summary', addresses, { params });
  }

  getScriptHashTransactions$(script: string, txid?: string): Observable<Transaction[]> {
    let params = new HttpParams();
    if (txid) {
      params = params.append('after_txid', txid);
    }
    return from(calcScriptHash$(script)).pipe(
      switchMap(scriptHash => this.httpClient.get<Transaction[]>(this.apiBaseUrl + this.apiBasePath + '/api/scripthash/' + scriptHash + '/txs', { params })),
    );
  }

  getScriptHashesTransactions$(scripts: string[], txid?: string): Observable<Transaction[]> {
    let params = new HttpParams();
    if (txid) {
      params = params.append('after_txid', txid);
    }
    return from(Promise.all(scripts.map(script => calcScriptHash$(script)))).pipe(
      switchMap(scriptHashes => this.httpClient.post<Transaction[]>(this.apiBaseUrl + this.apiBasePath + '/api/scripthashes/txs', scriptHashes, { params })),
    );
  }

  getScriptHashSummary$(script: string, txid?: string): Observable<AddressTxSummary[]> {
    let params = new HttpParams();
    if (txid) {
      params = params.append('after_txid', txid);
    }
    return from(calcScriptHash$(script)).pipe(
      switchMap(scriptHash => this.httpClient.get<AddressTxSummary[]>(this.apiBaseUrl + this.apiBasePath + '/api/scripthash/' + scriptHash + '/txs/summary', { params })),
    );
  }

  getAddressUtxos$(address: string): Observable<Utxo[]> {
    return this.httpClient.get<Utxo[]>(this.apiBaseUrl + this.apiBasePath + '/api/address/' + address + '/utxo');
  }

  getScriptHashUtxos$(script: string): Observable<Utxo[]> {
    return from(calcScriptHash$(script)).pipe(
      switchMap(scriptHash => this.httpClient.get<Utxo[]>(this.apiBaseUrl + this.apiBasePath + '/api/scripthash/' + scriptHash + '/utxo')),
    );
  }

  getScriptHashesSummary$(scripts: string[], txid?: string): Observable<AddressTxSummary[]> {
    let params = new HttpParams();
    if (txid) {
      params = params.append('after_txid', txid);
    }
    return from(Promise.all(scripts.map(script => calcScriptHash$(script)))).pipe(
      switchMap(scriptHashes => this.httpClient.post<AddressTxSummary[]>(this.apiBaseUrl + this.apiBasePath + '/api/scripthashes/txs/summary', scriptHashes, { params })),
    );
  }

  getAddressesByPrefix$(prefix: string): Observable<string[]> {
    if (prefix.toLowerCase().indexOf('bc1') === 0) {
      prefix = prefix.toLowerCase();
    }
    return this.httpClient.get<string[]>(this.apiBaseUrl + this.apiBasePath + '/api/address-prefix/' + prefix);
  }

  getTreasuries$(): Observable<Treasury[]> {
    return this.httpClient.get<Treasury[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/treasuries`
    );
  }

  getWallet$(walletName: string): Observable<Record<string, WalletAddress>> {
    return this.httpClient.get<Record<string, WalletAddress>>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/wallet/${walletName}`
    );
  }
}
