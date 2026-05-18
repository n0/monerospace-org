import { Component, OnInit, Input, ChangeDetectionStrategy, OnChanges, Output, EventEmitter, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { StateService, ViewAmountMode } from '@app/services/state.service';
import { CacheService } from '@app/services/cache.service';
import { Observable, BehaviorSubject, Subscription } from 'rxjs';
import { Transaction, Vin, Vout, XmrRingMember } from '@interfaces/electrs.interface';
import { ElectrsApiService } from '@app/services/electrs-api.service';
import { map, tap } from 'rxjs/operators';
import { BlockExtended } from '@interfaces/node-api.interface';
import { PriceService } from '@app/services/price.service';
import { StorageService } from '@app/services/storage.service';

const XMR_LARGE_AMOUNT_ATOMIC = 10_000_000_000_000;

@Component({
  selector: 'app-transactions-list',
  templateUrl: './transactions-list.component.html',
  styleUrls: ['./transactions-list.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TransactionsListComponent implements OnInit, OnChanges, OnDestroy {
  showMoreIncrement = 1000;

  @Input() transactions: Transaction[];
  @Input() cached: boolean = false;
  @Input() showConfirmations = false;
  @Input() transactionPage = false;
  @Input() paginated = false;
  @Input() inputIndex: number;
  @Input() outputIndex: number;
  @Input() rowLimit = 12;
  @Input() blockTime: number = 0;
  @Input() txPreview = false;

  @Output() loadMore = new EventEmitter();

  latestBlock$: Observable<BlockExtended>;
  currencyChangeSubscription: Subscription;
  currency: string;
  showDetails$ = new BehaviorSubject<boolean>(false);
  inputRowLimit: number = 12;
  outputRowLimit: number = 12;

  constructor(
    private stateService: StateService,
    private cacheService: CacheService,
    private electrsApiService: ElectrsApiService,
    private ref: ChangeDetectorRef,
    private priceService: PriceService,
    private storageService: StorageService,
  ) { }

  ngOnInit(): void {
    this.latestBlock$ = this.stateService.blocks$.pipe(map((blocks) => blocks[0]));

    this.currencyChangeSubscription = this.stateService.fiatCurrency$
      .subscribe(currency => {
        this.currency = currency;
        this.refreshPrice();
      });
  }

  refreshPrice(): void {
    if (!this.transactions?.length || !this.currency) {
      return;
    }

    const confirmedTxs = this.transactions.filter((tx) => tx.status.confirmed).length;
    if (!this.blockTime) {
      this.transactions.forEach((tx) => {
        if (tx.status.block_time) {
          this.priceService.getBlockPrice$(tx.status.block_time, confirmedTxs < 3, this.currency).pipe(
            tap((price) => tx.price = price),
          ).subscribe();
        }
      });
      return;
    }

    this.priceService.getBlockPrice$(this.blockTime, true, this.currency).pipe(
      tap((price) => this.transactions?.forEach((tx) => tx.price = price)),
    ).subscribe();
  }

  ngOnChanges(changes): void {
    if (changes.inputIndex || changes.outputIndex || changes.rowLimit) {
      this.inputRowLimit = Math.max(this.rowLimit, (this.inputIndex ?? 0) + 3);
      this.outputRowLimit = Math.max(this.rowLimit, (this.outputIndex ?? 0) + 3);
      if ((this.inputIndex !== undefined || this.outputIndex !== undefined) && !changes.transactions) {
        setTimeout(() => {
          const selectedRows = document.getElementsByClassName('assetBox');
          if (selectedRows?.[0]) {
            selectedRows[0].scrollIntoView({ block: 'center' });
          }
        }, 10);
      }
    }

    if (changes.transactions) {
      if (!this.transactions?.length) {
        return;
      }

      if (!this.txPreview) {
        this.cacheService.setTxCache(this.transactions);
      }

      this.transactions.forEach((tx) => this.prepareTransaction(tx));
      this.refreshPrice();
    }
  }

  prepareTransaction(tx: Transaction): void {
    tx['@voutLimit'] = true;
    tx['@vinLimit'] = true;
    tx.largeInput = tx.vin.some((vin) => (vin.prevout?.value ?? 0) > XMR_LARGE_AMOUNT_ATOMIC);
    tx.largeOutput = tx.vout.some((vout) => (vout.value ?? 0) > XMR_LARGE_AMOUNT_ATOMIC);
  }

  onScroll(): void {
    this.loadMore.emit();
  }

  getTotalTxOutput(tx: Transaction): number {
    return tx.vout.map((v: Vout) => v.value || 0).reduce((a: number, b: number) => a + b, 0);
  }

  hasRingctOutputs(tx: Transaction): boolean {
    return tx.vout.some((v: Vout & { ringct?: boolean }) => v.ringct === true);
  }

  isCoinbase(tx: Transaction): boolean {
    return !!tx.vin?.[0]?.is_coinbase;
  }

  inputAmount(vin: Vin): number {
    return vin.prevout?.value ?? 0;
  }

  inputAmountHidden(vin: Vin): boolean {
    return !!vin.ringct || !!(vin.prevout as Vout & { ringct?: boolean })?.ringct;
  }

  outputAmountHidden(vout: Vout): boolean {
    return !!(vout as Vout & { ringct?: boolean })?.ringct;
  }

  inputLabel(vin: Vin): string {
    if (vin.is_coinbase) {
      return 'Coinbase';
    }
    if (vin.ringct) {
      return 'RingCT input';
    }
    return 'Input';
  }

  outputLabel(vout: Vout): string {
    if (vout.ringct) {
      return 'RingCT output';
    }
    if (vout.scriptpubkey_type === 'fee') {
      return 'Fee';
    }
    if (vout.scriptpubkey_type) {
      return vout.scriptpubkey_type.replace(/_/g, ' ').toUpperCase();
    }
    return 'Output';
  }

  ringOffsetsPreview(vin: Vin): string {
    if (!vin.ring_offsets?.length) {
      return '';
    }
    const offsets = vin.ring_offsets.slice(0, 24).map((offset) => offset.toLocaleString()).join(', ');
    return vin.ring_offsets.length > 24 ? `${offsets}, ...` : offsets;
  }

  ringMemberLabel(member: XmrRingMember): string {
    if (member.height !== null && member.height !== undefined) {
      return `h ${member.height.toLocaleString()}`;
    }
    return `#${member.global_index.toLocaleString()}`;
  }

  ringMemberTooltip(member: XmrRingMember): string {
    const parts = [`global output ${member.global_index.toLocaleString()}`];
    if (member.height !== null && member.height !== undefined) {
      parts.push(`height ${member.height.toLocaleString()}`);
    }
    if (member.age_blocks !== null && member.age_blocks !== undefined) {
      parts.push(`${member.age_blocks.toLocaleString()} blocks before spend`);
    }
    if (member.unlocked === false) {
      parts.push('locked');
    }
    return parts.join(' | ');
  }

  switchCurrency(): void {
    const modes: ViewAmountMode[] = ['xmr', 'atomic', 'fiat'];
    const oldIndex = modes.indexOf(this.stateService.viewAmountMode$.value);
    const newIndex = (oldIndex + 1) % modes.length;
    this.stateService.viewAmountMode$.next(modes[newIndex]);
    this.storageService.setValue('view-amount-mode', modes[newIndex]);
  }

  trackByFn(index: number, tx: Transaction): string {
    return `${tx.txid}:${tx.status.confirmed}:${tx.vin.length}:${tx.vout.length}`;
  }

  trackByIndexFn(index: number): number {
    return index;
  }

  toggleDetails(): void {
    this.showDetails$.next(!this.showDetails$.value);
  }

  setDetailsOpen(open: boolean): void {
    if (open !== this.showDetails$.value) {
      this.toggleDetails();
    }
  }

  loadMoreInputs(tx: Transaction): void {
    if (!tx['@vinLoaded'] && !this.txPreview) {
      this.electrsApiService.getTransaction$(tx.txid)
        .subscribe((newTx) => {
          tx['@vinLoaded'] = true;
          tx.vin = newTx.vin;
          tx.fee = newTx.fee;
          this.prepareTransaction(tx);
          this.ref.markForCheck();
        });
    }
  }

  showMoreInputs(tx: Transaction): void {
    this.loadMoreInputs(tx);
    tx['@vinLimit'] = this.getVinLimit(tx, true);
  }

  showMoreOutputs(tx: Transaction): void {
    tx['@voutLimit'] = this.getVoutLimit(tx, true);
  }

  getVinLimit(tx: Transaction, next = false): number {
    let limit;
    if ((tx['@vinLimit'] || 0) > this.inputRowLimit) {
      limit = Math.min(tx['@vinLimit'] + (next ? this.showMoreIncrement : 0), tx.vin.length);
    } else {
      limit = Math.min((next ? this.showMoreIncrement : this.inputRowLimit), tx.vin.length);
    }
    if (tx.vin.length - limit <= 5) {
      limit = tx.vin.length;
    }
    return limit;
  }

  getVoutLimit(tx: Transaction, next = false): number {
    let limit;
    if ((tx['@voutLimit'] || 0) > this.outputRowLimit) {
      limit = Math.min(tx['@voutLimit'] + (next ? this.showMoreIncrement : 0), tx.vout.length);
    } else {
      limit = Math.min((next ? this.showMoreIncrement : this.outputRowLimit), tx.vout.length);
    }
    if (tx.vout.length - limit <= 5) {
      limit = tx.vout.length;
    }
    return limit;
  }

  ngOnDestroy(): void {
    this.currencyChangeSubscription?.unsubscribe();
  }
}
