import { AfterViewInit, ChangeDetectionStrategy, Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { combineLatest, merge, Observable, of, Subscription } from 'rxjs';
import { catchError, filter, map, scan, shareReplay, switchMap } from 'rxjs/operators';
import { BlockExtended, OptimizedMempoolStats } from '@interfaces/node-api.interface';
import { MempoolInfo } from '@interfaces/websocket.interface';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { ActiveFilter, FilterMode, GradientMode, toFlags } from '@app/shared/filters.utils';
import { detectWebGL } from '@app/shared/graphs.utils';
import { getVisualBlockWeightPercentStyle } from '@app/shared/block-weight.utils';

interface MempoolInfoData {
  memPoolInfo: MempoolInfo;
  bytesPerSecond: number;
  progressWidth: string;
  progressColor: string;
  mempoolSizeProgress: string;
}

interface MempoolStatsData {
  mempool: OptimizedMempoolStats[];
  weightPerSecond: any;
}

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardComponent implements OnInit, OnDestroy, AfterViewInit {
  mempoolInfoData$: Observable<MempoolInfoData>;
  bytesPerSecondLimit = 1667;
  blocks$: Observable<BlockExtended[]>;
  mempoolStats$: Observable<MempoolStatsData>;
  isLoadingWebSocket$: Observable<boolean>;
  filterSubscription: Subscription;
  mempoolInfoSubscription: Subscription;
  incomingGraphHeight: number = 300;
  webGlEnabled = true;

  goggleResolution = 82;
  // xmr-space: Bitcoin's Mempool Goggles (Consolidation / Coinjoin /
  // Data) don't translate to Monero — those filters detect on-chain
  // patterns visible only because Bitcoin txs are transparent. For
  // Monero we filter on what IS publicly observable: ring size, view
  // tags, RingCT version. The flag bits are defined in
  // filters.utils.ts (xmr_ring16 / xmr_view_tags / xmr_rct_v6) and
  // set per-tx by the backend WS adapter when it ships per-tx data.
  goggleCycle: { index: number, name: string, mode: FilterMode, filters: string[], gradient: GradientMode }[] = [
    { index: 0, name: $localize`:@@dfc3c34e182ea73c5d784ff7c8135f087992dac1:All`,                                  mode: 'and', filters: [],                  gradient: 'fee' },
    { index: 1, name: $localize`:@@xmr.goggle.ring16:Standard ring (16)`,                                          mode: 'and', filters: ['xmr_ring16'],     gradient: 'fee' },
    { index: 2, name: $localize`:@@xmr.goggle.view-tags:View tags`,                                                mode: 'and', filters: ['xmr_view_tags'],  gradient: 'fee' },
    { index: 3, name: $localize`:@@xmr.goggle.rct6:RCT v6 (latest)`,                                               mode: 'and', filters: ['xmr_rct_v6'],     gradient: 'fee' },
  ];
  goggleFlags = 0n;
  goggleMode: FilterMode = 'and';
  gradientMode: GradientMode = 'age';
  goggleIndex = 0;

  constructor(
    public stateService: StateService,
    private apiService: ApiService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) {
    this.webGlEnabled = this.stateService.isBrowser && detectWebGL();
  }

  ngAfterViewInit(): void {
    this.stateService.focusSearchInputDesktop();
  }

  ngOnDestroy(): void {
    this.filterSubscription.unsubscribe();
    this.mempoolInfoSubscription.unsubscribe();
  }

  ngOnInit(): void {
    this.onResize();
    this.isLoadingWebSocket$ = this.stateService.isLoadingWebSocket$;
    this.seoService.resetTitle();
    this.seoService.resetDescription();
    this.websocketService.want(['blocks', 'stats', 'mempool-blocks', 'live-2h-chart']);

    this.filterSubscription = this.stateService.activeGoggles$.subscribe((active: ActiveFilter) => {
      const activeFilters = active.filters.sort().join(',');
      for (const goggle of this.goggleCycle) {
        if (goggle.mode === active.mode) {
          const goggleFilters = goggle.filters.sort().join(',');
          if (goggleFilters === activeFilters) {
            this.goggleIndex = goggle.index;
            this.goggleFlags = toFlags(goggle.filters);
            this.goggleMode = goggle.mode;
            this.gradientMode = active.gradient;
            return;
          }
        }
      }
      this.goggleCycle.push({
        index: this.goggleCycle.length,
        name: 'Custom',
        mode: active.mode,
        filters: active.filters,
        gradient: active.gradient,
      });
      this.goggleIndex = this.goggleCycle.length - 1;
      this.goggleFlags = toFlags(active.filters);
      this.goggleMode = active.mode;
    });

    this.mempoolInfoData$ = combineLatest([
      this.stateService.mempoolInfo$,
      this.stateService.bytesPerSecond$
    ]).pipe(
      map(([mempoolInfo, bytesPerSecond]) => {
        const percent = Math.round((Math.min(bytesPerSecond, this.bytesPerSecondLimit) / this.bytesPerSecondLimit) * 100);

        let progressColor = 'bg-success';
        if (bytesPerSecond > 1667) {
          progressColor = 'bg-warning';
        }
        if (bytesPerSecond > 3000) {
          progressColor = 'bg-danger';
        }

        const mempoolSizePercentage = (mempoolInfo.usage / mempoolInfo.maxmempool * 100);
        let mempoolSizeProgress = 'bg-danger';
        if (mempoolSizePercentage <= 50) {
          mempoolSizeProgress = 'bg-success';
        } else if (mempoolSizePercentage <= 75) {
          mempoolSizeProgress = 'bg-warning';
        }

        return {
          memPoolInfo: mempoolInfo,
          bytesPerSecond,
          progressWidth: percent + '%',
          progressColor: progressColor,
          mempoolSizeProgress: mempoolSizeProgress,
        };
      })
    );

    this.mempoolInfoSubscription = this.mempoolInfoData$.subscribe();

    this.blocks$ = this.stateService.blocks$
      .pipe(
        map((blocks) => blocks.slice(0, 6))
      );

    this.mempoolStats$ = this.stateService.connectionState$
      .pipe(
        filter((state) => state === 2),
        switchMap(() => this.apiService.list2HStatistics$().pipe(
          catchError((e) => {
            return of(null);
          })
        )),
        switchMap((mempoolStats) => {
          return merge(
            this.stateService.live2Chart$
              .pipe(
                scan((acc, stats) => {
                  const now = Date.now() / 1000;
                  const start = now - (2 * 60 * 60);
                  acc.unshift(stats);
                  acc = acc.filter(p => p.added >= start);
                  return acc;
                }, (mempoolStats || []))
              ),
            of(mempoolStats)
          );
        }),
        map((mempoolStats) => {
          if (mempoolStats) {
            return {
              mempool: mempoolStats,
              weightPerSecond: this.handleNewMempoolData(mempoolStats.concat([])),
            };
          } else {
            return null;
          }
        }),
        shareReplay(1),
      );
  }

  handleNewMempoolData(mempoolStats: OptimizedMempoolStats[]) {
    mempoolStats.reverse();
    const labels = mempoolStats.map(stats => stats.added);

    return {
      labels: labels,
      series: [mempoolStats.map((stats) => [stats.added * 1000, stats.vbytes_per_second])],
    };
  }

  trackByBlock(index: number, block: BlockExtended) {
    return block.height;
  }

  blockWeightProgress(block: BlockExtended): string {
    return getVisualBlockWeightPercentStyle(block.weight);
  }

  setFilter(index): void {
    const selected = this.goggleCycle[index];
    this.stateService.activeGoggles$.next(selected);
  }

  @HostListener('window:resize', ['$event'])
  onResize(): void {
    if (window.innerWidth >= 992) {
      this.incomingGraphHeight = 300;
      this.goggleResolution = 82;
    } else if (window.innerWidth >= 768) {
      this.incomingGraphHeight = 215;
      this.goggleResolution = 80;
    } else {
      this.incomingGraphHeight = 180;
      this.goggleResolution = 86;
    }
  }
}
