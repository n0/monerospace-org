import { Component, OnDestroy, OnInit, ViewChildren, AfterViewInit, QueryList } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Subscription, of } from 'rxjs';
import { catchError, switchMap, startWith } from 'rxjs/operators';
import { BlockOverviewGraphComponent } from '@components/block-overview-graph/block-overview-graph.component';

/**
 * Block detail. We surface what the chain alone proves:
 *   - height, hash, prev_hash, depth
 *   - timestamp + age
 *   - block_size, block_weight (in Monero these are equal — no segwit)
 *   - num_txes, the full tx-hash list as links
 *   - miner_tx_hash + the block reward (from the coinbase output's
 *     amount, which IS public — coinbase outputs are not RingCT-hidden
 *     until they're spent)
 *   - difficulty, cumulative_difficulty, nonce, version
 *
 * What we deliberately omit:
 *   - per-tx fee / amount totals (would require fetching every tx in
 *     the block; even if we did, only the reward is publicly known —
 *     individual tx amounts stay hidden)
 *   - mining pool fingerprint (would require parsing the coinbase
 *     `extra` field for known pool tags; backlog item)
 */

interface XmrStrippedTx {
  txid: string;
  fee: number;
  vsize: number;
  value: number;
  rate: number;
  flags: number;
  time: number;
  acc: boolean;
}

interface XmrBlockDetail {
  hash: string;
  height: number;
  timestamp: number;
  age_s: number;
  depth: number;
  prev_hash: string;
  reward: number;
  block_size: number;
  block_weight: number;
  num_txes: number;
  difficulty: number;
  cumulative_difficulty: number;
  major_version: number;
  minor_version: number;
  nonce: number;
  orphan_status: boolean;
  miner_tx_hash: string;
  tx_hashes: string[];
  total_fees: number;
  median_fee: number;
  min_fee: number;
  max_fee: number;
  fee_range: number[];
  stripped_txs: XmrStrippedTx[];
}

@Component({
  selector: 'app-xmr-block-detail',
  templateUrl: './xmr-block-detail.component.html',
  styleUrls: ['./xmr-block-detail.component.scss'],
  standalone: false,
})
export class XmrBlockDetailComponent implements OnInit, AfterViewInit, OnDestroy {
  loading = true;
  error: string | null = null;
  block: XmrBlockDetail | null = null;
  hashOrHeight = '';
  webGlEnabled = true;
  /** Pending stripped-tx data when the graph view-child arrives after data. */
  private pendingStripped: XmrStrippedTx[] | null = null;

  /**
   * ViewChildren (not ViewChild) so we can subscribe to its `.changes`
   * observable. Upstream's block.component does the same pattern: the
   * graph is inside an *ngIf that flips false→true once data loads, so
   * the child reference appears asynchronously. Subscribing to
   * `.changes` is the only reliable way to know "the canvas exists
   * now and its scene is initialised."
   */
  @ViewChildren('blockGraph') blockGraphList!: QueryList<BlockOverviewGraphComponent>;

  private routeSub?: Subscription;
  private graphChangeSub?: Subscription;

  constructor(
    private route: ActivatedRoute,
    private http: HttpClient,
  ) {}

  ngOnInit(): void {
    this.routeSub = this.route.params
      .pipe(
        switchMap((params) => {
          const id = params['id'] ?? params['hash'] ?? '';
          this.hashOrHeight = id;
          this.loading = true;
          this.error = null;
          // include_txs=1 asks the backend to also resolve stripped
          // per-tx data (fee/weight) for the WebGL tile visualization.
          return this.http
            .get<XmrBlockDetail>(`/api/v1/block/${id}?include_txs=1`)
            .pipe(catchError(() => of(null)));
        }),
      )
      .subscribe((b) => {
        this.loading = false;
        if (!b) {
          this.error = 'block not found';
          return;
        }
        this.block = b;
        // Park the data; installGraph() runs both on initial view-init
        // and on every subsequent ViewChildren change (e.g. when the
        // *ngIf flips on after async data loads).
        this.pendingStripped = b.stripped_txs ?? [];
        this.installGraph();
      });
  }

  ngAfterViewInit(): void {
    // Subscribe to graph appearance/disappearance so we re-install the
    // dataset whenever the canvas mounts. `startWith(null)` triggers an
    // initial check in case the graph is already present.
    this.graphChangeSub = this.blockGraphList.changes
      .pipe(startWith(null))
      .subscribe(() => this.installGraph());
  }

  private installGraph(): void {
    if (!this.pendingStripped) return;
    const graph = this.blockGraphList?.first;
    if (!graph) return;
    // Defer to the next microtask so the child component's own
    // ngAfterViewInit (which initialises its WebGL scene) has run.
    Promise.resolve().then(() => {
      graph.setup(this.pendingStripped ?? []);
      this.pendingStripped = null;
    });
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
    this.graphChangeSub?.unsubscribe();
  }

  formatXmr(atomic: number): string {
    return (atomic / 1e12).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 12 });
  }

  formatHashrateFromDifficulty(diff: number): string {
    // 2-minute target → hashrate ≈ difficulty / 120 H/s
    const hps = diff / 120;
    if (hps > 1e9) return (hps / 1e9).toFixed(2) + ' GH/s';
    if (hps > 1e6) return (hps / 1e6).toFixed(2) + ' MH/s';
    if (hps > 1e3) return (hps / 1e3).toFixed(2) + ' kH/s';
    return hps.toFixed(0) + ' H/s';
  }
}
