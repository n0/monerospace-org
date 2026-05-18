import { Component, ViewChild, Input, Output, EventEmitter,
  OnInit, OnDestroy, OnChanges, ChangeDetectionStrategy, ChangeDetectorRef, AfterViewInit } from '@angular/core';
import { StateService } from '@app/services/state.service';
import { MempoolBlock, MempoolBlockDelta, isMempoolDelta } from '@interfaces/websocket.interface';
import { TransactionStripped } from '@interfaces/node-api.interface';
import { BlockOverviewGraphComponent } from '@components/block-overview-graph/block-overview-graph.component';
import { Subscription, BehaviorSubject } from 'rxjs';
import { WebsocketService } from '@app/services/websocket.service';
import { RelativeUrlPipe } from '@app/shared/pipes/relative-url/relative-url.pipe';
import { Router } from '@angular/router';
import { Color } from '@components/block-overview-graph/sprite-types';
import TxView from '@components/block-overview-graph/tx-view';
import { FilterMode, GradientMode } from '@app/shared/filters.utils';
import { XMR_VISUAL_BLOCK_WEIGHT_LIMIT } from '@app/shared/block-weight.utils';

@Component({
  selector: 'app-mempool-block-overview',
  templateUrl: './mempool-block-overview.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class MempoolBlockOverviewComponent implements OnInit, OnDestroy, OnChanges, AfterViewInit {
  @Input() index: number;
  @Input() resolution = 86;
  @Input() showFilters: boolean = false;
  @Input() overrideColors: ((tx: TxView) => Color) | null = null;
  @Input() filterFlags: bigint | undefined = undefined;
  @Input() filterMode: FilterMode = 'and';
  @Input() gradientMode: GradientMode = 'fee';
  @Output() txPreviewEvent = new EventEmitter<TransactionStripped | void>();

  @ViewChild('blockGraph') blockGraph: BlockOverviewGraphComponent;

  lastBlockHeight: number;
  blockIndex: number;
  isLoading$ = new BehaviorSubject<boolean>(false);
  timeLtrSubscription: Subscription;
  timeLtr: boolean;
  chainDirection: string = 'right';
  poolDirection: string = 'left';
  visualBlockWeightLimit = XMR_VISUAL_BLOCK_WEIGHT_LIMIT;

  blockSub: Subscription;
  fallbackSub: Subscription;
  firstLoad: boolean = true;
  destroyed: boolean = false;

  constructor(
    public stateService: StateService,
    private websocketService: WebsocketService,
    private router: Router,
    private cd: ChangeDetectorRef,
  ) { }

  ngOnInit(): void {
    this.timeLtrSubscription = this.stateService.timeLtr.subscribe((ltr) => {
      this.timeLtr = !!ltr;
      this.chainDirection = ltr ? 'left' : 'right';
      this.poolDirection = ltr ? 'right' : 'left';
      this.cd.markForCheck();
    });
  }

  ngAfterViewInit(): void {
    this.blockSub = this.stateService.mempoolBlockUpdate$.subscribe((update) => {
      // process update
      if (isMempoolDelta(update)) {
        // delta
        this.updateBlock(update);
      } else {
        const transactionsStripped = update.transactions;
        // new transactions
        if (this.firstLoad) {
          this.replaceBlock(transactionsStripped);
        } else {
          const inOldBlock = {};
          const inNewBlock = {};
          const added: TransactionStripped[] = [];
          const changed: { txid: string, rate: number | undefined, flags: number }[] = [];
          const removed: string[] = [];
          for (const tx of transactionsStripped) {
            inNewBlock[tx.txid] = true;
          }
          for (const txid of Object.keys(this.blockGraph?.scene?.txs || {})) {
            inOldBlock[txid] = true;
            if (!inNewBlock[txid]) {
              removed.push(txid);
            }
          }
          for (const tx of transactionsStripped) {
            if (!inOldBlock[tx.txid]) {
              added.push(tx);
            } else {
              changed.push({
                txid: tx.txid,
                rate: tx.rate,
                flags: tx.flags
              });
            }
          }
          this.updateBlock({
            block: this.blockIndex,
            removed,
            changed,
            added
          });
        }
      }
    });
    this.fallbackSub = this.stateService.mempoolBlocks$.subscribe((blocks) => {
      if (!this.firstLoad || this.index == null) {
        return;
      }
      const block = blocks?.[this.index];
      if (block?.nTx > 0 && block.blockVSize > 0) {
        this.replaceBlock(this.syntheticTransactions(block));
      }
    });
    const cached = this.stateService.mempoolBlockState;
    if (cached && cached.block === this.index) {
      this.resumeBlock(Object.values(cached.transactions));
    } else if (this.index != null) {
      this.isLoading$.next(true);
      this.websocketService.startTrackMempoolBlock(this.index, true);
    }
  }

  ngOnChanges(changes): void {
    if (changes.index) {
      this.firstLoad = true;
      if (this.blockGraph) {
        this.blockGraph.clear(changes.index.currentValue > changes.index.previousValue ? this.chainDirection : this.poolDirection);
      }
      if (!this.blockSub) {
        this.isLoading$.next(true);
      } else if (!this.websocketService.startTrackMempoolBlock(changes.index.currentValue) && this.stateService.mempoolBlockState && this.stateService.mempoolBlockState.block === changes.index.currentValue) {
        this.resumeBlock(Object.values(this.stateService.mempoolBlockState.transactions));
      } else {
        this.isLoading$.next(true);
      }
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.blockGraph?.destroy();
    this.blockSub?.unsubscribe();
    this.fallbackSub?.unsubscribe();
    this.timeLtrSubscription?.unsubscribe();
    this.websocketService.stopTrackMempoolBlock();
  }

  replaceBlock(transactionsStripped: TransactionStripped[]): void {
    if (this.destroyed) {
      return;
    }
    if (!this.blockGraph?.scene) {
      requestAnimationFrame(() => this.replaceBlock(transactionsStripped));
      return;
    }

    const blockMined = (this.stateService.latestBlockHeight > this.lastBlockHeight);
    if (this.blockIndex !== this.index) {
      const direction = (this.blockIndex == null || this.index < this.blockIndex) ? this.poolDirection : this.chainDirection;
      this.blockGraph.enter(transactionsStripped, direction);
    } else {
      this.blockGraph.replace(transactionsStripped, blockMined ? this.chainDirection : this.poolDirection);
    }

    this.lastBlockHeight = this.stateService.latestBlockHeight;
    this.blockIndex = this.index;
    this.firstLoad = false;
    this.isLoading$.next(false);
    this.blockGraph.run(performance.now());
  }

  updateBlock(delta: MempoolBlockDelta): void {
    if (this.destroyed) {
      return;
    }
    if (!this.blockGraph?.scene) {
      requestAnimationFrame(() => this.updateBlock(delta));
      return;
    }

    const blockMined = (this.stateService.latestBlockHeight > this.lastBlockHeight);
    if (this.blockIndex !== this.index) {
      const direction = (this.blockIndex == null || this.index < this.blockIndex) ? this.poolDirection : this.chainDirection;
      this.blockGraph.replace(delta.added, direction);
    } else {
      if (blockMined) {
        this.blockGraph.update(delta.added, delta.removed, delta.changed || [], blockMined ? this.chainDirection : this.poolDirection, blockMined);
      } else {
        this.blockGraph.deferredUpdate(delta.added, delta.removed, delta.changed || [], this.poolDirection);
      }
    }

    this.lastBlockHeight = this.stateService.latestBlockHeight;
    this.blockIndex = this.index;
    this.isLoading$.next(false);
    this.blockGraph.run(performance.now());
  }

  resumeBlock(transactionsStripped: TransactionStripped[]): void {
    if (this.destroyed) {
      return;
    }
    if (this.blockGraph?.scene) {
      this.firstLoad = false;
      this.blockGraph.setup(transactionsStripped, true);
      this.blockIndex = this.index;
      this.isLoading$.next(false);
      this.blockGraph.run(performance.now());
    } else {
      requestAnimationFrame(() => {
        this.resumeBlock(transactionsStripped);
      });
    }
  }

  onTxClick(event: { tx: TransactionStripped, keyModifier: boolean }): void {
    if (event.tx.txid.startsWith('synthetic-xmr-')) {
      return;
    }
    const url = new RelativeUrlPipe(this.stateService).transform(`/tx/${event.tx.txid}`);
    if (!event.keyModifier) {
      this.router.navigate([url]);
    } else {
      window.open(url, '_blank');
    }
  }

  private syntheticTransactions(block: MempoolBlock): TransactionStripped[] {
    const count = Math.max(1, block.nTx);
    const txSize = Math.max(1, Math.floor(block.blockVSize / count));
    const feeRange = block.feeRange?.length ? block.feeRange : [block.medianFee || 0];

    return Array.from({ length: count }, (_, index) => {
      const rate = feeRange[Math.min(feeRange.length - 1, Math.floor(index * feeRange.length / count))] || block.medianFee || 0;
      return {
        txid: `synthetic-xmr-${this.index}-${index}`,
        fee: Math.round(rate * txSize),
        vsize: txSize,
        value: 0,
        rate,
        flags: 0,
        time: Math.floor(Date.now() / 1000),
        context: 'projected',
      };
    });
  }
}
