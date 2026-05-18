import { Component, OnInit, OnDestroy, Input, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { StateService, ViewAmountMode } from '@app/services/state.service';
import { Observable, Subscription } from 'rxjs';
import { Price } from '@app/services/price.service';

@Component({
  selector: 'app-amount',
  templateUrl: './amount.component.html',
  styleUrls: ['./amount.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class AmountComponent implements OnInit, OnDestroy {
  conversions$: Observable<any>;
  currency: string;
  viewAmountMode$: Observable<ViewAmountMode>;
  network = '';

  stateSubscription: Subscription;
  currencySubscription: Subscription;

  @Input() satoshis: number;
  @Input() digitsInfo = '1.8-8';
  @Input() noFiat = false;
  @Input() addPlus = false;
  @Input() blockConversion: Price;
  @Input() forceBtc: boolean = false;
  @Input() ignoreViewMode: boolean = false;
  @Input() forceBlockConversion: boolean = false; // true = displays fiat price as 0 if blockConversion is undefined instead of falling back to conversions
  @Input() blurHiddenAmount: boolean = false;
  @Input() unitStyle: any;

  constructor(
    private stateService: StateService,
    private cd: ChangeDetectorRef,
  ) {
    this.currencySubscription = this.stateService.fiatCurrency$.subscribe((fiat) => {
      this.currency = fiat;
      this.cd.markForCheck();
    });
  }

  ngOnInit() {
    this.viewAmountMode$ = this.stateService.viewAmountMode$.asObservable();
    this.conversions$ = this.stateService.conversions$.asObservable();
    this.stateSubscription = this.stateService.networkChanged$.subscribe((network) => this.network = network);
  }

  ngOnDestroy() {
    if (this.stateSubscription) {
      this.stateSubscription.unsubscribe();
    }
    this.currencySubscription.unsubscribe();
  }

  /**
   * Generate a stable, plausibly-shaped fake amount to render under the
   * blur-out treatment when this entry is explicitly marked RingCT-hidden.
   *
   * Why a fake instead of just showing nothing:
   *   - 'amount: 0.00000000 XMR' is misleading for synthetic tx
   *     vin/vout placeholders — it suggests the value IS zero, which is
   *     wrong; it's hidden by RingCT. Real zero-fee block rows must still
   *     render as zero, so callers opt into this behavior.
   *   - empty cells let the eye think the row is broken / loading.
   *   - blurred fake digits visually convey 'something is here, by
   *     design you can't see it.' Same UX pattern as iOS notification
   *     previews on the lock screen.
   *
   * The number is generated from the unitStyle / DOM context so the
   * same row stays stable across CD cycles. We keep it in a typical
   * Monero range (0.001-50 XMR) so it doesn't look out of place.
   */
  blurredFake(): string {
    // Stable per-instance: hash the component's identity (we use the
    // unitStyle reference and digitsInfo as a stable seed) into a
    // pseudo-random 7-decimal amount in [0.0001000, 49.9999999].
    if (this._cachedFake) return this._cachedFake;
    let h = 2166136261 ^ (this.digitsInfo?.length ?? 0);
    for (const ch of (this.unitStyle ? JSON.stringify(this.unitStyle) : Math.random().toString())) {
      h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    }
    h = h >>> 0;
    const whole = (h % 50);
    const frac = ((h >>> 8) % 9_999_999).toString().padStart(7, '0');
    this._cachedFake = `${whole}.${frac}`;
    return this._cachedFake;
  }
  private _cachedFake?: string;
}
