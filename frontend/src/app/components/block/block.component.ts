import { Component, OnInit, OnDestroy, ViewChildren, QueryList, ChangeDetectorRef } from '@angular/core';
import { Location } from '@angular/common';
import { ActivatedRoute, ParamMap, Params, Router } from '@angular/router';
import { ElectrsApiService } from '@app/services/electrs-api.service';
import { switchMap, tap, throttleTime, catchError, shareReplay, startWith, take } from 'rxjs/operators';
import { Observable, of, Subscription, asyncScheduler, EMPTY, combineLatest, forkJoin } from 'rxjs';
import { StateService } from '@app/services/state.service';
import { SeoService } from '@app/services/seo.service';
import { WebsocketService } from '@app/services/websocket.service';
import { RelativeUrlPipe } from '@app/shared/pipes/relative-url/relative-url.pipe';
import { BlockExtended, TransactionStripped } from '@interfaces/node-api.interface';
import { ApiService } from '@app/services/api.service';
import { BlockOverviewGraphComponent } from '@components/block-overview-graph/block-overview-graph.component';
import { detectWebGL } from '@app/shared/graphs.utils';
import { PriceService, Price } from '@app/services/price.service';
import { CacheService } from '@app/services/cache.service';
import { PreloadService } from '@app/services/preload.service';

interface ComparisonStats {
  totalFees: number;
  totalWeight: number;
  totalVsize: number;
  txCount: number;
  feeDelta: number;
  weightDelta: number;
  txDelta: number;
}

@Component({
  selector: 'app-block',
  templateUrl: './block.component.html',
  standalone: false,
  styleUrls: ['./block.component.scss'],
  styles: [`
    .loadingGraphs {
      position: absolute;
      top: 50%;
      left: calc(50% - 15px);
      z-index: 100;
    }
  `],
})
export class BlockComponent implements OnInit, OnDestroy {
  network = '';
  block: BlockExtended;
  blockHeight: number;
  lastBlockHeight: number;
  nextBlockHeight: number;
  blockHash: string;
  isLoadingBlock = true;
  latestBlock: BlockExtended;
  latestBlocks: BlockExtended[] = [];
  strippedTransactions: TransactionStripped[];
  overviewTransitionDirection: string;
  isLoadingOverview = true;
  error: any;
  blockSubsidy: number;
  fees: number;
  block$: Observable<any>;
  showDetails = false;
  showPreviousBlocklink = true;
  showNextBlocklink = true;
  overviewError: any = null;
  webGlEnabled = true;
  isMobile = window.innerWidth <= 767.98;
  hoverTx: string;
  paginationMaxSize = window.matchMedia('(max-width: 670px)').matches ? 3 : 5;
  mode: 'actual' | 'stale' = 'actual';
  currentQueryParams: Params;

  overviewSubscription: Subscription;
  canonicalSubscription: Subscription;
  keyNavigationSubscription: Subscription;
  blocksSubscription: Subscription;
  cacheBlocksSubscription: Subscription;
  networkChangedSubscription: Subscription;
  queryParamsSubscription: Subscription;
  timeLtrSubscription: Subscription;
  timeLtr: boolean;
  childChangeSubscription: Subscription;
  priceSubscription: Subscription;
  blockConversion: Price;
  canonicalBlock: BlockExtended;
  canonicalTransactions: TransactionStripped[];
  staleTransactions: TransactionStripped[];
  staleStats: ComparisonStats | null = null;
  canonicalStats: ComparisonStats | null = null;

  @ViewChildren('blockGraphProjected') blockGraphProjected: QueryList<BlockOverviewGraphComponent>;
  @ViewChildren('blockGraphActual') blockGraphActual: QueryList<BlockOverviewGraphComponent>;

  constructor(
    private route: ActivatedRoute,
    private location: Location,
    private router: Router,
    private electrsApiService: ElectrsApiService,
    public stateService: StateService,
    private seoService: SeoService,
    private websocketService: WebsocketService,
    private relativeUrlPipe: RelativeUrlPipe,
    private apiService: ApiService,
    private priceService: PriceService,
    private cacheService: CacheService,
    private cd: ChangeDetectorRef,
    private preloadService: PreloadService,
  ) {
    this.webGlEnabled = this.stateService.isBrowser && detectWebGL();
  }

  get showComparison() {
    return !!this.block?.stale;
  }

  ngOnInit(): void {
    this.websocketService.want(['blocks', 'mempool-blocks']);
    this.network = this.stateService.network;

    this.timeLtrSubscription = this.stateService.timeLtr.subscribe((ltr) => {
      this.timeLtr = !!ltr;
    });

    this.cacheBlocksSubscription = this.cacheService.loadedBlocks$.subscribe((block) => {
      this.loadedCacheBlock(block);
    });

    this.blocksSubscription = this.stateService.blocks$
      .subscribe((blocks) => {
        this.latestBlock = blocks[0];
        this.latestBlocks = blocks;
        this.setNextAndPreviousBlockLink();

        for (const block of blocks) {
          if (block.id === this.blockHash) {
            this.block = block;
            if (block.extras) {
              block.extras.minFee = this.getMinBlockFee(block);
              block.extras.maxFee = this.getMaxBlockFee(block);
              if (block?.extras?.reward != undefined) {
                this.fees = block.extras.reward / 100000000 - this.blockSubsidy;
              }
            }
          } else if (block.height === this.block?.height) {
            this.block.stale = true;
            this.block.canonical = block.id;
            this.fetchCanonicalBlock();
          }
        }
      });

    this.block$ = this.route.paramMap.pipe(
      switchMap((params: ParamMap) => {
        const blockHash: string = params.get('id') || '';
        this.block = undefined;
        this.error = undefined;
        this.fees = undefined;
        if (history.state.data && history.state.data.blockHeight) {
          this.blockHeight = history.state.data.blockHeight;
        }

        let isBlockHeight = false;
        if (/^[0-9]+$/.test(blockHash)) {
          isBlockHeight = true;
          this.stateService.markBlock$.next({ blockHeight: parseInt(blockHash, 10)});
        } else {
          this.blockHash = blockHash;
        }
        document.body.scrollTo(0, 0);

        if (history.state.data && history.state.data.block) {
          this.blockHeight = history.state.data.block.height;
          return of(history.state.data.block);
        } else {
          this.isLoadingBlock = true;
          this.isLoadingOverview = true;
          this.strippedTransactions = undefined;
          let blockInCache: BlockExtended;
          if (isBlockHeight) {
            blockInCache = this.latestBlocks.find((block) => block.height === parseInt(blockHash, 10));
            if (blockInCache) {
              return of(blockInCache);
            }
            return this.electrsApiService.getBlockHashFromHeight$(parseInt(blockHash, 10))
              .pipe(
                switchMap((hash) => {
                  this.blockHash = hash;
                  this.location.replaceState(
                    this.router.createUrlTree([(this.network ? '/' + this.network : '') + '/block/', hash]).toString()
                  );
                  this.seoService.updateCanonical(this.location.path());
                  return this.apiService.getBlock$(hash).pipe(
                    catchError((err) => {
                      this.error = err;
                      this.isLoadingBlock = false;
                      this.isLoadingOverview = false;
                      this.seoService.logSoft404();
                      return EMPTY;
                    })
                  );
                }),
                catchError((err) => {
                  this.error = err;
                  this.isLoadingBlock = false;
                  this.isLoadingOverview = false;
                  this.seoService.logSoft404();
                  return EMPTY;
                }),
              );
          }

          blockInCache = this.latestBlocks.find((block) => block.id === this.blockHash);
          if (blockInCache) {
            return of(blockInCache);
          }

          return this.apiService.getBlock$(blockHash).pipe(
            catchError((err) => {
              this.error = err;
              this.isLoadingBlock = false;
              this.isLoadingOverview = false;
              this.seoService.logSoft404();
              return EMPTY;
            })
          );
        }
      }),
      tap((block: BlockExtended) => {
        if (block.previousblockhash) {
          this.preloadService.block$.next(block.previousblockhash);
        }
        this.block = block;
        if (block.extras) {
          block.extras.minFee = this.getMinBlockFee(block);
          block.extras.maxFee = this.getMaxBlockFee(block);
        }
        this.blockHeight = block.height;
        this.lastBlockHeight = this.blockHeight;
        this.nextBlockHeight = block.height + 1;
        this.setNextAndPreviousBlockLink();

        this.seoService.setTitle($localize`:@@block.component.browser-title:Block ${block.height}:BLOCK_HEIGHT:: ${block.id}:BLOCK_ID:`);
        this.seoService.setDescription($localize`:@@meta.description.xmr.block:See Monero block size, weight, fees, reward, included transaction hashes, and public chain metadata for block ${block.height}:BLOCK_HEIGHT: (${block.id}:BLOCK_ID:).`);
        this.isLoadingBlock = false;
        this.setBlockSubsidy();
        if (block?.extras?.reward !== undefined) {
          this.fees = block.extras.reward / 100000000 - this.blockSubsidy;
        }
        this.isLoadingOverview = true;
        this.overviewError = null;

        if (!block.stale) {
          this.stateService.markBlock$.next({ blockHeight: this.blockHeight });
          const cachedBlock = this.cacheService.getCachedBlock(block.height);
          if (!cachedBlock) {
            this.cacheService.loadBlock(block.height);
          } else {
            this.loadedCacheBlock(cachedBlock);
          }
        }
      }),
      throttleTime(300, asyncScheduler, { leading: true, trailing: true }),
      shareReplay({ bufferSize: 1, refCount: true })
    );

    this.overviewSubscription = this.block$.pipe(
      switchMap((block) => {
        return forkJoin([
          of(block),
          this.apiService.getStrippedBlockTransactions$(block.id)
            .pipe(
              catchError((err) => {
                this.overviewError = err;
                return of(null);
              })
            ),
          block.stale ? this.electrsApiService.getBlockHashFromHeight$(block.height)
            .pipe(
              switchMap((hash) => {
                return forkJoin([
                  this.apiService.getBlock$(hash).pipe(
                    catchError((err) => {
                      console.error('Error fetching canonical block:', err);
                      this.overviewError = err;
                      return of(null);
                    })
                  ),
                  this.apiService.getStrippedBlockTransactions$(hash).pipe(
                    catchError((err) => {
                      console.error('Error fetching canonical transactions:', err);
                      this.overviewError = err;
                      return of(null);
                    })
                  )
                ]);
              }),
              catchError((err) => {
                console.error('Error fetching canonical block:', err);
                return of([null, null]);
              })
            ) : of([null, null]),
        ]);
      })
    )
    .subscribe(([block, transactions, [canonicalBlock, canonicalTransactions]]) => {
      if (transactions) {
        this.strippedTransactions = transactions;
      } else {
        this.strippedTransactions = [];
      }

      // Handle canonical block data from the overviewSubscription (when block.stale is true from backend)
      if (block.stale && canonicalBlock && canonicalTransactions) {
        this.canonicalBlock = canonicalBlock;
        this.canonicalTransactions = canonicalTransactions;
        this.staleTransactions = JSON.parse(JSON.stringify(transactions));
        this.setupStaleComparison();
      } else if (!block.stale) {
        // Clear stale-related data when viewing a non-stale block
        this.staleTransactions = null;
        this.canonicalBlock = null;
        this.canonicalTransactions = null;
      }

      this.setupBlockGraphs();
      this.cd.markForCheck();
      this.isLoadingOverview = false;
    });

    this.networkChangedSubscription = this.stateService.networkChanged$
      .subscribe((network) => this.network = network);

    this.queryParamsSubscription = this.route.queryParams.subscribe((params) => {
      this.currentQueryParams = params;
      if (params.showDetails === 'true') {
        this.showDetails = true;
      } else {
        this.showDetails = false;
      }
      switch (params.view) {
        case 'stale':
          this.mode = 'stale';
          break;
        default:
          this.mode = 'actual';
          break;
      }
      this.setupBlockGraphs();
    });

    this.keyNavigationSubscription = this.stateService.keyNavigation$.subscribe((event) => {
      const prevKey = this.timeLtr ? 'ArrowLeft' : 'ArrowRight';
      const nextKey = this.timeLtr ? 'ArrowRight' : 'ArrowLeft';
      if (this.showPreviousBlocklink && event.key === prevKey && this.nextBlockHeight - 2 >= 0) {
        this.navigateToPreviousBlock();
      }
      if (event.key === nextKey) {
        if (this.showNextBlocklink) {
          this.navigateToNextBlock();
        } else {
          this.router.navigate([this.relativeUrlPipe.transform('/mempool-block'), '0']);
        }
      }
    });

    if (this.priceSubscription) {
      this.priceSubscription.unsubscribe();
    }
    this.priceSubscription = combineLatest([this.stateService.fiatCurrency$, this.block$]).pipe(
      switchMap(([currency, block]) => {
        return this.priceService.getBlockPrice$(block.timestamp, true, currency).pipe(
          tap((price) => {
            this.blockConversion = price;
          })
        );
      })
    ).subscribe();
  }

  ngAfterViewInit(): void {
    this.childChangeSubscription = combineLatest([this.blockGraphProjected.changes.pipe(startWith(null)), this.blockGraphActual.changes.pipe(startWith(null))]).subscribe(() => {
      this.setupBlockGraphs();
    });
  }

  ngOnDestroy(): void {
    this.stateService.markBlock$.next({});
    this.overviewSubscription?.unsubscribe();
    this.canonicalSubscription?.unsubscribe();
    this.keyNavigationSubscription?.unsubscribe();
    this.blocksSubscription?.unsubscribe();
    this.cacheBlocksSubscription?.unsubscribe();
    this.networkChangedSubscription?.unsubscribe();
    this.queryParamsSubscription?.unsubscribe();
    this.timeLtrSubscription?.unsubscribe();
    this.childChangeSubscription?.unsubscribe();
    this.priceSubscription?.unsubscribe();
    this.blockGraphProjected.forEach(graph => {
      graph.destroy();
    });
    this.blockGraphActual.forEach(graph => {
      graph.destroy();
    });
  }

  setBlockSubsidy(): void {
    this.blockSubsidy = 0;
  }

  toggleShowDetails(): void {
    if (this.showDetails) {
      this.showDetails = false;
      this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { showDetails: false, view: this.mode },
        queryParamsHandling: 'merge',
        fragment: 'block'
      });
    } else {
      this.showDetails = true;
      this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { showDetails: true, view: this.mode },
        queryParamsHandling: 'merge',
        fragment: 'details'
      });
    }
  }

  navigateToPreviousBlock(): void  {
    if (!this.block) {
      return;
    }
    const block = this.latestBlocks.find((b) => b.height === this.nextBlockHeight - 2);
    this.router.navigate([this.relativeUrlPipe.transform('/block/'),
      block ? block.id : this.block.previousblockhash], { state: { data: { block, blockHeight: this.nextBlockHeight - 2 } } });
  }

  navigateToNextBlock(): void  {
    const block = this.latestBlocks.find((b) => b.height === this.nextBlockHeight);
    this.router.navigate([this.relativeUrlPipe.transform('/block/'),
      block ? block.id : this.nextBlockHeight], { state: { data: { block, blockHeight: this.nextBlockHeight } } });
  }

  setNextAndPreviousBlockLink(): void {
    if (this.latestBlock) {
      if (!this.blockHeight){
        this.showPreviousBlocklink = false;
      } else {
        this.showPreviousBlocklink = true;
      }
      if (this.latestBlock.height != null && this.latestBlock.height === this.blockHeight) {
        this.showNextBlocklink = false;
      } else {
        this.showNextBlocklink = true;
      }
    }
  }

  fetchCanonicalBlock(): void {
    if (!this.block?.stale || !this.block?.height) {
      return;
    }

    this.electrsApiService.getBlockHashFromHeight$(this.block.height)
      .pipe(
        switchMap((hash) => {
          return forkJoin([
            this.apiService.getBlock$(hash).pipe(
              catchError((err) => {
                console.error('Error fetching canonical block:', err);
                this.overviewError = err;
                return of(null);
              })
            ),
            this.apiService.getStrippedBlockTransactions$(hash).pipe(
              catchError((err) => {
                console.error('Error fetching canonical transactions:', err);
                this.overviewError = err;
                return of(null);
              })
            )
          ]);
        }),
        catchError((err) => {
          console.error('Error fetching canonical block hash:', err);
          return of([null, null]);
        })
      )
      .subscribe(([canonicalBlock, canonicalTransactions]) => {
        this.canonicalBlock = canonicalBlock;
        this.canonicalTransactions = canonicalTransactions;

        if (canonicalBlock && canonicalTransactions && this.strippedTransactions) {
          this.staleTransactions = JSON.parse(JSON.stringify(this.strippedTransactions));
          this.setupStaleComparison();
          this.setupBlockGraphs();
        }
      });
  }

  setupStaleComparison(): void {
    this.staleStats = {
      totalFees: 0,
      totalWeight: 0,
      totalVsize: 0,
      txCount: 0,
      feeDelta: 0,
      weightDelta: 0,
      txDelta: 0,
    };
    this.canonicalStats = {
      totalFees: 0,
      totalWeight: 0,
      totalVsize: 0,
      txCount: 0,
      feeDelta: 0,
      weightDelta: 0,
      txDelta: 0,
    };
    const staleTransactions = this.staleTransactions || [];
    const canonicalTransactions = this.canonicalTransactions || [];

    const inStale = {};
    const inCanonical = {};

    for (const tx of staleTransactions) {
      inStale[tx.txid] = tx;
      this.staleStats.totalFees += tx.fee;
      this.staleStats.totalWeight += tx.vsize * 4;
      this.staleStats.totalVsize += tx.vsize;
      this.staleStats.txCount++;
    }
    for (const tx of canonicalTransactions) {
      inCanonical[tx.txid] = tx;
      this.canonicalStats.totalFees += tx.fee;
      this.canonicalStats.totalWeight += tx.vsize * 4;
      this.canonicalStats.totalVsize += tx.vsize;
      this.canonicalStats.txCount++;
    }

    for (const tx of staleTransactions) {
      tx.context = 'stale';
      if (inCanonical[tx.txid]) {
        tx.status = 'matched';
        // opportunistically fix missing timestamps
        if (inCanonical[tx.txid].time && (!tx.time || tx.time > inCanonical[tx.txid].time)) {
          tx.time = inCanonical[tx.txid].time;
        }
      } else {
        tx.status = 'unmatched';
      }
    }

    for (const tx of canonicalTransactions) {
      tx.context = 'canonical';
      if (inStale[tx.txid]) {
        tx.status = 'matched';
        // opportunistically fix missing timestamps
        if (inStale[tx.txid].time && (!tx.time || tx.time > inStale[tx.txid].time)) {
          tx.time = inStale[tx.txid].time;
        }
      } else {
        tx.status = 'unmatched';
      }
    }

    // if vsize was rounded, the total weight we calculated isn't exact and can exceed the 4MB limit
    this.staleStats.totalWeight = Math.min(this.staleStats.totalWeight, 4_000_000);
    this.canonicalStats.totalWeight = Math.min(this.canonicalStats.totalWeight, 4_000_000);

    this.staleStats.feeDelta = this.canonicalStats.totalFees > 0 ? (this.staleStats.totalFees - this.canonicalStats.totalFees) / this.canonicalStats.totalFees : (this.canonicalStats.totalFees > 0 ? Infinity : -Infinity);
    this.staleStats.weightDelta = this.canonicalStats.totalWeight > 0 ? (this.staleStats.totalWeight - this.canonicalStats.totalWeight) / this.canonicalStats.totalWeight : (this.canonicalStats.totalWeight > 0 ? Infinity : -Infinity);
    this.staleStats.txDelta = this.canonicalStats.txCount > 0 ? (this.staleStats.txCount - this.canonicalStats.txCount) / this.canonicalStats.txCount : (this.canonicalStats.txCount > 0 ? Infinity : -Infinity);

    this.canonicalStats.feeDelta = this.staleStats.totalFees > 0 ? (this.canonicalStats.totalFees - this.staleStats.totalFees) / this.staleStats.totalFees : (this.staleStats.totalFees > 0 ? Infinity : -Infinity);
    this.canonicalStats.weightDelta = this.staleStats.totalWeight > 0 ? (this.canonicalStats.totalWeight - this.staleStats.totalWeight) / this.staleStats.totalWeight : (this.staleStats.totalWeight > 0 ? Infinity : -Infinity);
    this.canonicalStats.txDelta = this.staleStats.txCount > 0 ? (this.canonicalStats.txCount - this.staleStats.txCount) / this.staleStats.txCount : (this.staleStats.txCount > 0 ? Infinity : -Infinity);
  }

  setupBlockGraphs(): void {
    if (this.block?.stale && this.staleTransactions && this.canonicalTransactions) {
      this.blockGraphProjected.forEach(graph => {
        graph.destroy();
        if (this.isMobile && this.mode === 'actual') {
          graph.setup(this.canonicalTransactions || []);
        } else {
          graph.setup(this.staleTransactions || []);
        }
      });
      this.blockGraphActual.forEach(graph => {
        graph.destroy();
        graph.setup(this.canonicalTransactions || []);
      });
    } else if (this.strippedTransactions) {
      this.blockGraphActual.forEach(graph => {
        graph.destroy();
        graph.setup(this.strippedTransactions || []);
      });
    }
  }

  onResize(event: Event): void {
    const target = event.target as Window;
    const isMobile = target.innerWidth <= 767.98;
    const changed = isMobile !== this.isMobile;
    this.isMobile = isMobile;
    this.paginationMaxSize = target.innerWidth < 670 ? 3 : 5;

    if (changed) {
      this.changeMode(this.mode);
    }
  }

  changeMode(mode: 'actual' | 'stale'): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { showDetails: this.showDetails, view: mode },
      queryParamsHandling: 'merge',
      fragment: 'overview'
    });
  }

  onTxClick(event: { tx: TransactionStripped, keyModifier: boolean }): void {
    const url = new RelativeUrlPipe(this.stateService).transform(`/tx/${event.tx.txid}`);
    if (!event.keyModifier) {
      this.router.navigate([url]);
    } else {
      window.open(url, '_blank');
    }
  }

  onTxHover(txid: string): void {
    if (txid && txid.length) {
      this.hoverTx = txid;
    } else {
      this.hoverTx = null;
    }
  }

  getMinBlockFee(block: BlockExtended): number {
    if (block?.extras?.feeRange) {
      // heuristic to check if feeRange is adjusted for effective rates
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

  loadedCacheBlock(block: BlockExtended): void {
    if (this.block && block.height === this.block.height && block.id !== this.block.id) {
      this.block.stale = true;
      this.block.canonical = block.id;
      this.fetchCanonicalBlock();
    }
  }

  updateBlockReward(blockReward: number): void {
    if (this.fees === undefined) {
       this.fees = blockReward;
    }
  }
}
