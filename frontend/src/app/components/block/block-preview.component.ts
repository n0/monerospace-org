import { Component, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { ActivatedRoute, ParamMap } from '@angular/router';
import { ElectrsApiService } from '@app/services/electrs-api.service';
import { switchMap, tap, throttleTime, catchError, shareReplay, startWith, pairwise, filter } from 'rxjs/operators';
import { of, Subscription, asyncScheduler } from 'rxjs';
import { StateService } from '@app/services/state.service';
import { SeoService } from '@app/services/seo.service';
import { OpenGraphService } from '@app/services/opengraph.service';
import { BlockExtended, TransactionStripped } from '@interfaces/node-api.interface';
import { ApiService } from '@app/services/api.service';
import { BlockOverviewGraphComponent } from '@components/block-overview-graph/block-overview-graph.component';

@Component({
  selector: 'app-block-preview',
  templateUrl: './block-preview.component.html',
  styleUrls: ['./block-preview.component.scss'],
  standalone: false,
})
export class BlockPreviewComponent implements OnInit, OnDestroy {
  network = '';
  block: BlockExtended;
  blockHeight: number;
  blockHash: string;
  rawId: string;
  isLoadingBlock = true;
  strippedTransactions: TransactionStripped[];
  overviewTransitionDirection: string;
  isLoadingOverview = true;
  error: any;
  blockSubsidy: number;
  fees: number;
  overviewError: any = null;

  overviewSubscription: Subscription;
  networkChangedSubscription: Subscription;

  ogSession: number;

  @ViewChild('blockGraph') blockGraph: BlockOverviewGraphComponent;

  constructor(
    private route: ActivatedRoute,
    private electrsApiService: ElectrsApiService,
    public stateService: StateService,
    private seoService: SeoService,
    private openGraphService: OpenGraphService,
    private apiService: ApiService,
  ) { }

  ngOnInit() {
    this.network = this.stateService.network;

    const block$ = this.route.paramMap.pipe(
      switchMap((params: ParamMap) => {
        this.rawId = params.get('id') || '';
        this.ogSession = this.openGraphService.waitFor('block-viz-' + this.rawId);
        this.ogSession = this.openGraphService.waitFor('block-data-' + this.rawId);

        const blockHash: string = params.get('id') || '';
        this.block = undefined;
        this.error = undefined;
        this.overviewError = undefined;
        this.fees = undefined;

        let isBlockHeight = false;
        if (/^[0-9]+$/.test(blockHash)) {
          isBlockHeight = true;
        } else {
          this.blockHash = blockHash;
        }

        this.isLoadingBlock = true;
        this.isLoadingOverview = true;

        if (isBlockHeight) {
          return this.electrsApiService.getBlockHashFromHeight$(parseInt(blockHash, 10))
            .pipe(
              switchMap((hash) => {
                if (hash) {
                  this.blockHash = hash;
                  return this.apiService.getBlock$(hash);
                } else {
                  return null;
                }
              }),
              catchError((err) => {
                this.error = err;
                this.seoService.logSoft404();
                this.openGraphService.fail({ event: 'block-data-' + this.rawId, sessionId: this.ogSession });
                this.openGraphService.fail({ event: 'block-viz-' + this.rawId, sessionId: this.ogSession });
                return of(null);
              }),
            );
        }
        return this.apiService.getBlock$(blockHash);
      }),
      filter((block: BlockExtended | void) => block != null),
      tap((block: BlockExtended) => {
        this.block = block;
        this.blockHeight = block.height;

        this.seoService.setTitle($localize`:@@block.component.browser-title:Block ${block.height}:BLOCK_HEIGHT:: ${block.id}:BLOCK_ID:`);
        this.seoService.setDescription($localize`:@@meta.description.xmr.block:See Monero block size, weight, fees, reward, included transaction hashes, and public chain metadata for block ${block.height}:BLOCK_HEIGHT: (${block.id}:BLOCK_ID:).`);
        this.isLoadingBlock = false;
        this.setBlockSubsidy();
        if (block?.extras?.reward !== undefined) {
          this.fees = block.extras.reward / 100000000 - this.blockSubsidy;
        }
        this.stateService.markBlock$.next({ blockHeight: this.blockHeight });
        this.isLoadingOverview = true;
        this.overviewError = null;

        this.openGraphService.waitOver({ event: 'block-data-' + this.rawId, sessionId: this.ogSession });
      }),
      throttleTime(50, asyncScheduler, { leading: true, trailing: true }),
      shareReplay({ bufferSize: 1, refCount: true })
    );

    this.overviewSubscription = block$.pipe(
      startWith(null),
      pairwise(),
      switchMap(([prevBlock, block]) => {
          return this.apiService.getStrippedBlockTransactions$(block.id)
            .pipe(
              catchError((err) => {
                this.overviewError = err;
                this.openGraphService.fail({ event: 'block-viz-' + this.rawId, sessionId: this.ogSession });
                return of([]);
              })
            );
        }
      ),
    )
    .subscribe((transactions) => {
      this.strippedTransactions = transactions;

      this.isLoadingOverview = false;
      if (this.blockGraph) {
        this.blockGraph.destroy();
        this.blockGraph.setup(this.strippedTransactions);
      }
    },
    (error) => {
      this.error = error;
      this.isLoadingOverview = false;
      this.seoService.logSoft404();
      this.openGraphService.fail({ event: 'block-viz-' + this.rawId, sessionId: this.ogSession });
      this.openGraphService.fail({ event: 'block-data-' + this.rawId, sessionId: this.ogSession });
      if (this.blockGraph) {
        this.blockGraph.destroy();
      }
    });

    this.networkChangedSubscription = this.stateService.networkChanged$
      .subscribe((network) => this.network = network);
  }

  ngOnDestroy() {
    if (this.overviewSubscription) {
      this.overviewSubscription.unsubscribe();
    }
    if (this.networkChangedSubscription) {
      this.networkChangedSubscription.unsubscribe();
    }
  }

  setBlockSubsidy() {
    this.blockSubsidy = 0;
  }

  onGraphReady(): void {
    this.openGraphService.waitOver({ event: 'block-viz-' + this.rawId, sessionId: this.ogSession });
  }
}
