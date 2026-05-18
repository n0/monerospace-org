import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { Transaction } from '@interfaces/electrs.interface';
import { WebsocketService } from '@app/services/websocket.service';
import { LegacyWebsocketTrackingMessage, StratumJob } from '@interfaces/legacy-websocket.interface';

@Injectable({
  providedIn: 'root'
})
export class LegacyWebsocketTrackingService {
  readonly stratumJobs$ = new BehaviorSubject<Record<string, StratumJob>>({});
  readonly utxoSpent$ = new Subject<object>();
  readonly mempoolRemovedTransactions$ = new Subject<Transaction>();
  readonly multiAddressTransactions$ = new Subject<{ [address: string]: { mempool: Transaction[], confirmed: Transaction[], removed: Transaction[] }}>();
  readonly walletTransactions$ = new Subject<Transaction[]>();

  constructor(
    private websocketService: WebsocketService,
  ) {}

  want(data: string[], force = false): void {
    this.websocketService.want(data, force);
  }

  startTrackAddress(address: string): void {
    this.send({ 'track-address': address });
  }

  stopTrackingAddress(): void {
    this.send({ 'track-address': 'stop' });
  }

  startTrackAddresses(addresses: string[]): void {
    this.send({ 'track-addresses': addresses });
  }

  stopTrackingAddresses(): void {
    this.send({ 'track-addresses': [] });
  }

  startTrackingWallet(walletName: string): void {
    this.send({ 'track-wallet': walletName });
  }

  stopTrackingWallet(): void {
    this.send({ 'track-wallet': 'stop' });
  }

  startTrackAsset(asset: string): void {
    this.send({ 'track-asset': asset });
  }

  stopTrackingAsset(): void {
    this.send({ 'track-asset': 'stop' });
  }

  startTrackStratum(pool: number | string): void {
    this.send({ 'track-stratum': pool });
  }

  stopTrackStratum(): void {
    this.send({ 'track-stratum': null });
  }

  private send(message: LegacyWebsocketTrackingMessage): void {
    this.websocketService.send(message);
  }
}
