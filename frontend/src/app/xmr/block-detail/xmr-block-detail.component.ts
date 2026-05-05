import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Subscription, of } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';

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
}

@Component({
  selector: 'app-xmr-block-detail',
  templateUrl: './xmr-block-detail.component.html',
  styleUrls: ['./xmr-block-detail.component.scss'],
  standalone: false,
})
export class XmrBlockDetailComponent implements OnInit, OnDestroy {
  loading = true;
  error: string | null = null;
  block: XmrBlockDetail | null = null;
  hashOrHeight = '';

  private routeSub?: Subscription;

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
          // The /api/v1/block/:hash endpoint accepts only hashes today.
          // If the route param is numeric (height), we'd need to resolve
          // height → hash first via /api/v1/blocks?count=N — out of
          // scope for iter-13; height-based deep links are rare since
          // block-tile clicks always land hashes.
          return this.http
            .get<XmrBlockDetail>(`/api/v1/block/${id}`)
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
      });
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
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
