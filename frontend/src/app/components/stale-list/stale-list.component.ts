import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { BehaviorSubject, Observable, Subscription } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { StaleTip, BlockExtended } from '@interfaces/node-api.interface';
import { ChainTipsApiService } from '@app/services/chain-tips-api.service';
import { StateService } from '@app/services/state.service';
import { SeoService } from '@app/services/seo.service';
import { seoDescriptionNetwork } from '@app/shared/common.utils';
import { getVisualBlockWeightPercent } from '@app/shared/block-weight.utils';
import { formatCompactFeeRateRange } from '@app/shared/fee-rate.utils';

@Component({
  selector: 'app-stale-list',
  templateUrl: './stale-list.component.html',
  styleUrls: ['./stale-list.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StaleList implements OnInit {
  chainTips$: Observable<StaleTip[]>;
  nextChainTipSubject = new BehaviorSubject(null);
  urlFragmentSubscription: Subscription;
  isLoading = true;

  gradientColors = {
    '': ['var(--mainnet-alt)', 'var(--primary)'],
    liquid: ['var(--liquid)', 'var(--testnet-alt)'],
    'liquidtestnet': ['var(--liquidtestnet)', 'var(--liquidtestnet-alt)'],
    testnet: ['var(--testnet)', 'var(--testnet-alt)'],
    testnet4: ['var(--testnet)', 'var(--testnet-alt)'],
    signet: ['var(--signet)', 'var(--signet-alt)'],
    regtest: ['var(--regtest)', 'var(--regtest-alt)'],
  };

  constructor(
    private chainTipsApiService: ChainTipsApiService,
    public stateService: StateService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    this.chainTips$ = this.chainTipsApiService.getStaleTips$().pipe(
      map((chainTips) => {
        const filtered = chainTips.filter((chainTip) => chainTip.status !== 'active') as StaleTip[];

        filtered.forEach((chainTip) => {
          if (chainTip.stale?.extras) {
            chainTip.stale.extras.minFee = this.getMinBlockFee(chainTip.stale);
            chainTip.stale.extras.maxFee = this.getMaxBlockFee(chainTip.stale);
          }
          if (chainTip.canonical?.extras) {
            chainTip.canonical.extras.minFee = this.getMinBlockFee(chainTip.canonical);
            chainTip.canonical.extras.maxFee = this.getMaxBlockFee(chainTip.canonical);
          }
        });

        return filtered;
      }),
      tap(() => {
        this.isLoading = false;
      })
    );

    this.seoService.setTitle($localize`:@@page.stale-chain-tips:Stale Chain Tips`);
    this.seoService.setDescription($localize`:@@meta.description.stale-chain-tips:See the most recent stale chain tips on the Bitcoin${seoDescriptionNetwork(this.stateService.network)} network.`);
  }

  getBlockGradient(block: BlockExtended): string {
    if (!block || !block.weight) {
      return 'var(--secondary)';
    }

    const backgroundHeight = 100 - getVisualBlockWeightPercent(block.weight);
    const network = this.stateService.network || '';

    return `repeating-linear-gradient(
      var(--secondary),
      var(--secondary) ${backgroundHeight}%,
      ${this.gradientColors[network][0]} ${Math.max(backgroundHeight, 0)}%,
      ${this.gradientColors[network][1]} 100%
    )`;
  }

  getMinBlockFee(block: BlockExtended): number {
    if (block?.extras?.feeRange) {
      if (block.extras.medianFee === block.extras.feeRange[3]) {
        return block.extras.feeRange[1];
      } else {
        return block.extras.feeRange[0];
      }
    }
    return 0;
  }

  getMaxBlockFee(block: BlockExtended): number {
    if (block?.extras?.feeRange) {
      return block.extras.feeRange[block.extras.feeRange.length - 1];
    }
    return 0;
  }

  compactFeeRange(minFee: number | null | undefined, maxFee: number | null | undefined): string {
    return formatCompactFeeRateRange(minFee, maxFee);
  }
}
