import { Component, OnInit, OnDestroy, ChangeDetectionStrategy, Inject, PLATFORM_ID, ChangeDetectorRef } from '@angular/core';
import { detectWebGL } from '@app/shared/graphs.utils';
import { StateService } from '@app/services/state.service';
import { ActivatedRoute, ParamMap } from '@angular/router';
import { switchMap, map, tap, filter } from 'rxjs/operators';
import { MempoolBlock } from '@interfaces/websocket.interface';
import { TransactionStripped } from '@interfaces/node-api.interface';
import { Observable, BehaviorSubject } from 'rxjs';
import { SeoService } from '@app/services/seo.service';
import { seoDescriptionNetwork } from '@app/shared/common.utils';
import { WebsocketService } from '@app/services/websocket.service';
import { XMR_VISUAL_BLOCK_WEIGHT_LIMIT, getVisualBlockWeightPercent, getVisualBlockWeightPercentStyle } from '@app/shared/block-weight.utils';
import { formatCompactFeeRateRange } from '@app/shared/fee-rate.utils';

@Component({
  selector: 'app-mempool-block',
  templateUrl: './mempool-block.component.html',
  styleUrls: ['./mempool-block.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MempoolBlockComponent implements OnInit, OnDestroy {
  network$: Observable<string>;
  mempoolBlockIndex: number;
  mempoolBlock$: Observable<MempoolBlock>;
  mempoolBlockTransactions$: Observable<TransactionStripped[]>;
  ordinal$: BehaviorSubject<string> = new BehaviorSubject('');
  previewTx: TransactionStripped | void;
  webGlEnabled: boolean;
  visualBlockWeightLimit = XMR_VISUAL_BLOCK_WEIGHT_LIMIT;

  constructor(
    private route: ActivatedRoute,
    public stateService: StateService,
    private seoService: SeoService,
    private websocketService: WebsocketService,
  ) {
    this.webGlEnabled = this.stateService.isBrowser && detectWebGL();
  }

  ngOnInit(): void {
    this.websocketService.want(['blocks', 'mempool-blocks']);

    this.mempoolBlock$ = this.route.paramMap
      .pipe(
        switchMap((params: ParamMap) => {
          this.mempoolBlockIndex = parseInt(params.get('id'), 10) || 0;
          return this.stateService.mempoolBlocks$
            .pipe(
              map((blocks) => {
                if (!blocks.length) {
                  return [{ index: 0, blockSize: 0, blockVSize: 0, feeRange: [0, 0], medianFee: 0, nTx: 0, totalFees: 0 }];
                }
                return blocks;
              }),
              filter((mempoolBlocks) => mempoolBlocks.length > 0),
              map((mempoolBlocks) => {
                while (!mempoolBlocks[this.mempoolBlockIndex]) {
                  this.mempoolBlockIndex--;
                }
                const ordinal = this.getOrdinal(mempoolBlocks[this.mempoolBlockIndex]);
                this.ordinal$.next(ordinal);
                this.seoService.setTitle(ordinal);
                this.seoService.setDescription($localize`:@@meta.description.mempool-block:See live Monero mempool-block stats: atomic-per-byte fee range, aggregate byte size, transaction count, and total fees. Mempool blocks update in real time as the network receives new transactions.`);
                mempoolBlocks[this.mempoolBlockIndex].isStack = mempoolBlocks[this.mempoolBlockIndex].blockVSize > this.visualBlockWeightLimit;
                return mempoolBlocks[this.mempoolBlockIndex];
              })
            );
        }),
        tap(() => {
          this.stateService.markBlock$.next({ mempoolBlockIndex: this.mempoolBlockIndex });
          this.websocketService.startTrackMempoolBlock(this.mempoolBlockIndex);
        })
      );

    this.mempoolBlockTransactions$ = this.stateService.liveMempoolBlockTransactions$.pipe(map(({transactions}) => Object.values(transactions)));

    this.network$ = this.stateService.networkChanged$;
  }

  ngOnDestroy(): void {
    this.stateService.markBlock$.next({});
    this.websocketService.stopTrackMempoolBlock();
  }

  getOrdinal(mempoolBlock: MempoolBlock): string {
    const blocksInBlock = Math.ceil(mempoolBlock.blockVSize / this.visualBlockWeightLimit);
    if (this.mempoolBlockIndex === 0) {
      return $localize`:@@bdf0e930eb22431140a2eaeacd809cc5f8ebd38c:Next Block`;
    } else if (this.mempoolBlockIndex === this.stateService.env.KEEP_BLOCKS_AMOUNT - 1 && blocksInBlock > 1) {
      return $localize`:@@mempool-block.stack.of.blocks:Stack of ${blocksInBlock}:INTERPOLATION: mempool blocks`;
    } else {
      return $localize`:@@mempool-block.block.no:Mempool block ${this.mempoolBlockIndex + 1}:INTERPOLATION:`;
    }
  }

  setTxPreview(event: TransactionStripped | void): void {
    this.previewTx = event;
  }

  compactFeeRange(mempoolBlock: MempoolBlock): string {
    return formatCompactFeeRateRange(
      mempoolBlock.feeRange?.[0],
      mempoolBlock.feeRange?.length ? mempoolBlock.feeRange[mempoolBlock.feeRange.length - 1] : undefined
    );
  }

  blockFillStyle(mempoolBlock: MempoolBlock): string {
    return getVisualBlockWeightPercentStyle(mempoolBlock.blockVSize);
  }

  blockFillPercent(mempoolBlock: MempoolBlock): number {
    return getVisualBlockWeightPercent(mempoolBlock.blockVSize);
  }

}
