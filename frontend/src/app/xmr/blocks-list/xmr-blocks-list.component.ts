import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Subscription, of } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { MinerProof } from '@interfaces/node-api.interface';

interface XmrBlockSummary {
  hash: string;
  height: number;
  timestamp: number;
  age_s: number;
  reward: number;
  block_size: number;
  block_weight: number;
  num_txes: number;
  difficulty: number;
  extras?: {
    minerProof?: MinerProof;
  };
}

const PAGE_SIZE = 25;

/**
 * Paginated /blocks list page. Replaces upstream's BlocksList which
 * required Bitcoin extras (mining-pool slug, fees-range). We surface
 * the public Monero block fields as a clean table; pagination uses
 * `/api/v1/blocks/:height` (height = newest block on that page).
 */
@Component({
  selector: 'app-xmr-blocks-list',
  templateUrl: './xmr-blocks-list.component.html',
  styleUrls: ['./xmr-blocks-list.component.scss'],
  standalone: false,
})
export class XmrBlocksListComponent implements OnInit, OnDestroy {
  loading = true;
  error: string | null = null;
  blocks: XmrBlockSummary[] = [];
  /** Newest-block height in the current page; equals tip on page 1. */
  pageHeight: number | null = null;
  /** Tip height — used to know if "newer" should be enabled. */
  tipHeight: number | null = null;

  private routeSub?: Subscription;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private http: HttpClient,
  ) {}

  ngOnInit(): void {
    this.routeSub = this.route.params
      .pipe(
        switchMap((params) => {
          const heightParam = params['page'] ?? params['height'];
          this.loading = true;
          this.error = null;
          // Hit /api/v1/info first to know tip height for pagination
          // navigation; cheap and cacheable so we always have the
          // current tip available.
          return this.http.get<{ height: number }>('/api/v1/info').pipe(
            catchError(() => of(null)),
            switchMap((info) => {
              this.tipHeight = info ? info.height - 1 : null;
              const target = heightParam ? Number(heightParam) : (this.tipHeight ?? 0);
              const path = heightParam ? `/api/v1/blocks/${target}` : '/api/v1/blocks';
              return this.http
                .get<XmrBlockSummary[]>(heightParam ? path : `${path}?count=${PAGE_SIZE}`)
                .pipe(catchError(() => of(null)));
            }),
          );
        }),
      )
      .subscribe((blocks) => {
        this.loading = false;
        if (!blocks) {
          this.error = 'failed to load blocks';
          return;
        }
        this.blocks = blocks;
        this.pageHeight = blocks[0]?.height ?? null;
      });
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
  }

  hasNewerPage(): boolean {
    return this.tipHeight !== null && this.pageHeight !== null && this.pageHeight < this.tipHeight;
  }

  hasOlderPage(): boolean {
    if (!this.blocks.length) return false;
    return this.blocks[this.blocks.length - 1].height > 0;
  }

  goNewer(): void {
    if (!this.hasNewerPage() || this.pageHeight === null) return;
    const target = Math.min(this.tipHeight ?? 0, this.pageHeight + PAGE_SIZE);
    this.router.navigate(['/blocks', target]);
  }

  goOlder(): void {
    if (!this.blocks.length) return;
    const oldest = this.blocks[this.blocks.length - 1].height;
    const target = Math.max(0, oldest - 1);
    this.router.navigate(['/blocks', target]);
  }

  goLatest(): void {
    this.router.navigate(['/blocks']);
  }

  formatXmr(atomic: number): string {
    return (atomic / 1e12).toFixed(4);
  }

  proofBadgeLabel(proof?: MinerProof | null): string {
    if (!proof) return 'Unlisted';
    if (proof.status === 'verified') return proof.type ? `Verified (${proof.type})` : 'Verified';
    if (proof.status === 'missing') return 'Missing';
    if (proof.status === 'unavailable') return 'Unavailable';
    return 'Unknown';
  }

  proofBadgeClass(proof?: MinerProof | null): string {
    return `miner-proof-${proof?.status ?? 'unknown'}`;
  }

  proofTitle(proof?: MinerProof | null): string {
    if (!proof) return 'No miner proof registry entry for this block';
    const pool = proof.poolName ? `${proof.poolName}: ` : '';
    if (proof.status === 'verified') {
      return `${pool}cryptographic miner proof verified by ${proof.sourceName}`;
    }
    if (proof.status === 'missing') {
      return `${pool}pool attribution found, but miner proof is missing`;
    }
    if (proof.status === 'unavailable') {
      return `${pool}no miner proof is available for this block`;
    }
    return `${pool}miner proof status unknown`;
  }
}
