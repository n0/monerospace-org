import { ChangeDetectionStrategy, Component, Inject, Input, LOCALE_ID, OnDestroy, OnInit } from '@angular/core';
import { formatNumber } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { EChartsOption } from '@app/graphs/echarts';
import { BehaviorSubject, Observable, Subscription, of } from 'rxjs';
import { catchError, distinctUntilChanged, map, share, switchMap, tap } from 'rxjs/operators';
import { BlockExtended, PoolStat } from '@interfaces/node-api.interface';
import { StateService } from '@app/services/state.service';
import { AmountShortenerPipe } from '@app/shared/pipes/amount-shortener.pipe';
import { SeoService } from '@app/services/seo.service';
import type { PoolHashrateRow } from '@app/services/mining-pool-api.service';
import { MiningPoolDetailApiService } from '@app/services/mining-pool-detail-api.service';
import { getVisualBlockWeightPercentStyle } from '@app/shared/block-weight.utils';

interface PoolDetails extends PoolStat {
  logo: string;
  tags: string[];
}

@Component({
  selector: 'app-pool',
  templateUrl: './pool.component.html',
  styleUrls: ['./pool.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PoolComponent implements OnInit, OnDestroy {
  @Input() right: number | string = 45;
  @Input() left: number | string = 75;

  formatNumber = formatNumber;
  slugSubscription: Subscription | null = null;
  poolStats$: Observable<PoolDetails | null>;
  blocks$: Observable<BlockExtended[]>;
  isLoading = true;
  error: HttpErrorResponse | null = null;

  chartOptions: EChartsOption = {};
  chartInitOptions = {
    renderer: 'svg',
  };

  blocks: BlockExtended[] = [];
  slug: string | undefined = undefined;

  loadMoreSubject: BehaviorSubject<number | undefined> = new BehaviorSubject<number | undefined>(undefined);

  constructor(
    @Inject(LOCALE_ID) public locale: string,
    private miningPoolDetailApiService: MiningPoolDetailApiService,
    private route: ActivatedRoute,
    public stateService: StateService,
    private seoService: SeoService,
    public amountShortenerPipe: AmountShortenerPipe,
  ) {}

  ngOnInit(): void {
    this.slugSubscription = this.route.params.pipe(map((params) => params.slug)).subscribe((slug) => {
      this.isLoading = true;
      this.error = null;
      this.blocks = [];
      this.chartOptions = {};
      this.slug = slug;
      this.loadMoreSubject.next(undefined);
      this.initializeObservables();
    });
  }

  initializeObservables(): void {
    const slug = this.slug ?? '';
    this.poolStats$ = this.miningPoolDetailApiService.getPoolHashrate$(slug)
      .pipe(
        tap((data) => {
          this.isLoading = false;
          this.prepareChartOptions(data);
        }),
        switchMap(() => this.miningPoolDetailApiService.getPoolStats$(slug)),
        map((poolStats) => this.toPoolDetails(poolStats)),
        catchError((err: HttpErrorResponse) => {
          this.isLoading = false;
          this.error = err;
          this.seoService.logSoft404();
          return of(null);
        }),
      );

    this.blocks$ = this.loadMoreSubject
      .pipe(
        distinctUntilChanged(),
        switchMap(() => {
          if (this.slug === undefined) {
            return of([]);
          }
          return this.miningPoolDetailApiService.getPoolBlocks$(this.slug, this.blocks[this.blocks.length - 1]?.height);
        }),
        catchError((err: HttpErrorResponse) => {
          this.error = err;
          return of([]);
        }),
        tap((newBlocks) => {
          this.blocks = this.blocks.concat(newBlocks);
        }),
        map(() => this.blocks),
        share(),
      );
  }

  prepareChartOptions(rows: PoolHashrateRow[]): void {
    const hashrate = rows.map((row) => [row.timestamp * 1000, row.avgHashrate]);
    const share = rows.map((row) => [row.timestamp * 1000, row.share * 100]);
    let title: object;

    if (hashrate.length <= 1) {
      title = {
        textStyle: {
          color: 'grey',
          fontSize: 15
        },
        text: $localize`Not enough data yet`,
        left: 'center',
        top: 'center'
      };
    }

    this.chartOptions = {
      title: title,
      animation: false,
      color: ['#FFB300', '#D81B60'],
      grid: {
        right: this.right,
        left: this.left,
        bottom: 60,
      },
      tooltip: {
        show: !this.isMobile(),
        trigger: 'axis',
        axisPointer: {
          type: 'line'
        },
        backgroundColor: 'rgba(17, 19, 31, 1)',
        borderRadius: 4,
        shadowColor: 'rgba(0, 0, 0, 0.5)',
        textStyle: {
          color: 'var(--tooltip-grey)',
          align: 'left',
        },
        borderColor: '#000',
        formatter: (ticks: Array<{ seriesIndex: number; marker: string; seriesName: string; data: [number, number]; axisValueLabel: string }>): string => {
          let hashrateString = '';
          let dominanceString = '';

          for (const tick of ticks) {
            if (tick.seriesIndex === 0) {
              hashrateString = `${tick.marker} ${tick.seriesName}: ${this.amountShortenerPipe.transform(tick.data[1], 3, 'H/s', false, true)}<br>`;
            } else if (tick.seriesIndex === 1) {
              dominanceString = `${tick.marker} ${tick.seriesName}: ${formatNumber(tick.data[1], this.locale, '1.0-2')}%`;
            }
          }

          return `
            <b style="color: white; margin-left: 18px">${ticks[0].axisValueLabel}</b><br>
            <span>${hashrateString}</span>
            <span>${dominanceString}</span>
          `;
        }
      },
      xAxis: hashrate.length <= 1 ? undefined : {
        type: 'time',
        splitNumber: (this.isMobile()) ? 5 : 10,
        axisLabel: {
          hideOverlap: true,
        }
      },
      legend: hashrate.length <= 1 ? undefined : {
        data: [
          {
            name: $localize`:@@79a9dc5b1caca3cbeb1733a19515edacc5fc7920:Hashrate`,
            inactiveColor: 'rgb(110, 112, 121)',
            textStyle: {
              color: 'var(--fg)',
            },
            icon: 'roundRect',
          },
          {
            name: $localize`:mining.pool-dominance:Pool Dominance`,
            inactiveColor: 'rgb(110, 112, 121)',
            textStyle: {
              color: 'var(--fg)',
            },
            icon: 'roundRect',
          },
        ],
      },
      yAxis: hashrate.length <= 1 ? undefined : [
        {
          min: (value) => value.min * 0.9,
          type: 'value',
          axisLabel: {
            color: 'rgb(110, 112, 121)',
            formatter: (val): string => this.amountShortenerPipe.transform(val, 3, 'H/s', false, true).toString(),
          },
          splitLine: {
            show: false,
          }
        },
        {
          type: 'value',
          axisLabel: {
            color: 'rgb(110, 112, 121)',
            formatter: (val): string => `${val}%`,
          },
          splitLine: {
            show: false,
          }
        }
      ],
      series: hashrate.length <= 1 ? undefined : [
        {
          zlevel: 1,
          name: $localize`:@@79a9dc5b1caca3cbeb1733a19515edacc5fc7920:Hashrate`,
          showSymbol: false,
          symbol: 'none',
          data: hashrate,
          type: 'line',
          lineStyle: {
            width: 2,
          },
        },
        {
          zlevel: 0,
          name: $localize`:mining.pool-dominance:Pool Dominance`,
          showSymbol: false,
          symbol: 'none',
          data: share,
          type: 'line',
          yAxisIndex: 1,
          lineStyle: {
            width: 2,
          },
        }
      ],
      dataZoom: hashrate.length <= 1 ? undefined : [{
        type: 'inside',
        realtime: true,
        zoomLock: true,
        maxSpan: 100,
        minSpan: 10,
        moveOnMouseMove: false,
      }, {
        fillerColor: '#aaaaff15',
        borderColor: 'var(--transparent-fg)',
        showDetail: false,
        show: true,
        type: 'slider',
        brushSelect: false,
        realtime: true,
        bottom: 0,
        left: 20,
        right: 15,
        selectedDataBackground: {
          lineStyle: {
            color: 'var(--fg)',
            opacity: 0.45,
          },
          areaStyle: {
            opacity: 0,
          },
        },
      }],
    };
  }

  isMobile(): boolean {
    return window.innerWidth <= 767.98;
  }

  loadMore(): void {
    this.loadMoreSubject.next(this.blocks[this.blocks.length - 1]?.height);
  }

  trackByBlock(_index: number, block: BlockExtended): number {
    return block.height;
  }

  blockWeightProgress(block: BlockExtended): string {
    return getVisualBlockWeightPercentStyle(block.weight);
  }

  ngOnDestroy(): void {
    this.slugSubscription?.unsubscribe();
  }

  private toPoolDetails(poolStats: PoolStat): PoolDetails {
    this.seoService.setTitle(poolStats.pool.name);
    this.seoService.setDescription(`Best-effort Monero mining pool attribution for ${poolStats.pool.name}.`);

    return {
      ...poolStats,
      logo: `/resources/mining-pools/${poolStats.pool.slug}.svg`,
      tags: this.normalizeList(poolStats.pool.regexes),
    };
  }

  private normalizeList(value: string | string[]): string[] {
    if (Array.isArray(value)) {
      return value.filter(Boolean);
    }
    if (!value) {
      return [];
    }
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [value];
    } catch {
      return [value];
    }
  }
}
