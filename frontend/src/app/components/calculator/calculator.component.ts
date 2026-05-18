import { ChangeDetectionStrategy, Component, Inject, LOCALE_ID, OnInit } from '@angular/core';
import { FormBuilder, FormGroup } from '@angular/forms';
import { BehaviorSubject, combineLatest, Observable } from 'rxjs';
import { distinctUntilChanged, map, shareReplay, switchMap } from 'rxjs/operators';
import { StateService } from '@app/services/state.service';
import { ApiService } from '@app/services/api.service';
import { Price } from '@app/services/price.service';
import { WebsocketService } from '@app/services/websocket.service';
import { NgbDateStruct } from '@ng-bootstrap/ng-bootstrap';

const XMR_DECIMALS = 12;
const ATOMIC_UNITS_PER_XMR = 1_000_000_000_000n;

@Component({
  selector: 'app-calculator',
  templateUrl: './calculator.component.html',
  styleUrls: ['./calculator.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CalculatorComponent implements OnInit {
  dateModel: NgbDateStruct;
  todayDateModel: NgbDateStruct;

  form: FormGroup;
  currentPrice: number | undefined = undefined;
  currentCurrency = 'USD';
  currencyDecimals = 2;

  currency$ = this.stateService.fiatCurrency$;
  price$: Observable<number>;
  lastFiatPrice$: Observable<number>;
  timestamp$ = new BehaviorSubject<number>(new Date().getTime() / 1000);

  constructor(
    @Inject(LOCALE_ID) private locale: string,
    private stateService: StateService,
    private formBuilder: FormBuilder,
    private websocketService: WebsocketService,
    private apiService: ApiService
  ) {
    const now = new Date();
    this.todayDateModel = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
    this.dateModel = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
  }

  ngOnInit(): void {
    this.form = this.formBuilder.group({
      fiat: [0],
      xmr: [0],
      atomicUnits: [0],
    });

    this.lastFiatPrice$ = this.stateService.conversions$.asObservable()
      .pipe(
        map((conversions) => conversions.time)
      );

    this.price$ = combineLatest({
      currency: this.currency$.pipe(distinctUntilChanged()),
      timestamp: this.timestamp$.pipe(distinctUntilChanged())
    }).pipe(
      switchMap(({ currency, timestamp }) => {
        this.currentCurrency = currency;
        this.updateCurrencyDecimals();

        return this.todaySelected
          ? this.stateService.conversions$.asObservable()
          : this.apiService.getHistoricalPrice$(timestamp, currency).pipe(
            map((p: any) => {
              const formatted: { time: number; [key: string]: number } = {
                time: p.prices[0].time
              };
              formatted[this.currentCurrency] = Math.max(0, p.prices[0][this.currentCurrency]);
              return formatted;
            })
          );
      }),
      map((conversions) => {
        return conversions[this.currentCurrency];
      }),
      // Share one latest price stream across all form subscriptions to avoid duplicate API calls.
      shareReplay({ bufferSize: 1, refCount: true })
    );

    combineLatest([
      this.price$,
      this.form.get('fiat').valueChanges
    ]).subscribe(([price, value]) => {
      this.currentPrice = price;
      const rate = parseFloat((value / price).toFixed(XMR_DECIMALS));
      if (isNaN(value)) {
        return;
      }
      const xmrValue = rate.toFixed(XMR_DECIMALS);
      this.form.get('xmr').setValue(xmrValue, { emitEvent: false });
      this.form.get('atomicUnits').setValue(this.toAtomicUnits(xmrValue), { emitEvent: false } );
    });

    combineLatest([
      this.price$,
      this.form.get('xmr').valueChanges
    ]).subscribe(([price, value]) => {
      this.currentPrice = price;
      const rate = parseFloat((value * price).toFixed(8));
      if (isNaN(value)) {
        return;
      }
      this.form.get('fiat').setValue(this.formatFiat(rate), { emitEvent: false } );
      this.form.get('atomicUnits').setValue(this.toAtomicUnits(value), { emitEvent: false } );
    });

    combineLatest([
      this.price$,
      this.form.get('atomicUnits').valueChanges
    ]).subscribe(([price, value]) => {
      this.currentPrice = price;
      if (isNaN(value)) {
        return;
      }
      const xmrValue = this.atomicUnitsToXmr(value);
      const rate = parseFloat((parseFloat(xmrValue) * price).toFixed(8));
      this.form.get('fiat').setValue(this.formatFiat(rate), { emitEvent: false } );
      this.form.get('xmr').setValue(xmrValue, { emitEvent: false });
    });

    // Default form with 1 XMR.
    this.form.get('xmr').setValue(1, { emitEvent: true });
  }

  transformInput(name: string): void {
    const formControl = this.form.get(name);
    if (!formControl.value) {
      return formControl.setValue('', {emitEvent: false});
    }
    let value = String(formControl.value ?? '').replace(',', '.').replace(/[^0-9.]/g, '');
    if (value === '.') {
      value = '0';
    }
    let sanitizedValue = this.removeExtraDots(value);
    if (name === 'xmr' && this.countDecimals(sanitizedValue) > XMR_DECIMALS) {
      sanitizedValue = this.toFixedWithoutRounding(sanitizedValue, XMR_DECIMALS);
    }
    if (name === 'fiat') {
      const decimals = this.getCurrencyDecimals();
      if (this.countDecimals(sanitizedValue) > decimals) {
        sanitizedValue = this.toFixedWithoutRounding(sanitizedValue, decimals);
      }
    }
    if (sanitizedValue === '') {
      sanitizedValue = '0';
    }
    if (name === 'atomicUnits') {
      sanitizedValue = sanitizedValue.split('.')[0] || '0';
    }
    formControl.setValue(sanitizedValue, {emitEvent: true});
  }

  removeExtraDots(str: string): string {
    const [beforeDot, afterDot] = str.split('.', 2);
    if (afterDot === undefined) {
      return str;
    }
    const afterDotReplaced = afterDot.replace(/\./g, '');
    return `${beforeDot}.${afterDotReplaced}`;
  }

  countDecimals(numberString: string): number {
    const decimalPos = numberString.indexOf('.');
    if (decimalPos === -1) {return 0;}
    return numberString.length - decimalPos - 1;
  }

  toFixedWithoutRounding(numStr: string, fixed: number): string {
    const re = new RegExp(`^-?\\d+(?:.\\d{0,${(fixed || -1)}})?`);
    const result = numStr.match(re);
    return result ? result[0] : numStr;
  }

  selectAll(event): void {
    event.target.select();
  }

  formatFiat(num: number): string | number {
    // Get the number of decimal places for the current currency
    const decimals = this.getCurrencyDecimals();

    if (decimals === 0) {
      return Math.round(num);
    }

    if (Math.abs(num) >= 1000) {
      // For values >= 1000: show currency-specific decimals, or 0 if whole number
      if (num % 1 === 0) {
        return Math.round(num);
      }
      const factor = Math.pow(10, decimals);
      return (Math.round(num * factor) / factor).toFixed(decimals);
    }
    if (num % 1 === 0) {
      return Math.round(num);
    }
    // For small values (< 1), show more precision
    if (Math.abs(num) < 1 && num !== 0) {
      return num.toFixed(8);
    }
    const factor = Math.pow(10, decimals);
    return (Math.round(num * factor) / factor).toFixed(decimals);
  }

  updatePrice(): void {
    this.timestamp$.next(Date.UTC(this.dateModel.year, this.dateModel.month - 1, this.dateModel.day + 1) / 1000);
  }

  get todaySelected() {
    return this.dateModel.day === this.todayDateModel.day && this.dateModel.month === this.todayDateModel.month && this.dateModel.year === this.todayDateModel.year;
  }

  private updateCurrencyDecimals(): void {
    try {
      const formatter = new Intl.NumberFormat(this.locale, {
        style: 'currency',
        currency: this.currentCurrency
      });
      this.currencyDecimals = formatter.resolvedOptions().maximumFractionDigits;
    } catch {
      this.currencyDecimals = 2; // Default to 2 decimal places
    }
  }

  getCurrencyDecimals(): number {
    return this.currencyDecimals;
  }

  toAtomicUnits(value: string | number): string {
    const clean = String(value ?? '0').replace(',', '.').replace(/[^0-9.]/g, '');
    const [wholeRaw, fractionRaw = ''] = this.removeExtraDots(clean || '0').split('.');
    const whole = wholeRaw || '0';
    const fraction = (fractionRaw + '0'.repeat(XMR_DECIMALS)).slice(0, XMR_DECIMALS);
    return (BigInt(whole) * ATOMIC_UNITS_PER_XMR + BigInt(fraction || '0')).toString();
  }

  atomicUnitsToXmr(value: string | number): string {
    const clean = String(value ?? '0').replace(/[^0-9]/g, '') || '0';
    const atomic = BigInt(clean);
    const whole = atomic / ATOMIC_UNITS_PER_XMR;
    const fraction = (atomic % ATOMIC_UNITS_PER_XMR).toString().padStart(XMR_DECIMALS, '0');
    return `${whole}.${fraction}`;
  }

  formatXmrForDisplay(value: string | number): string {
    const clean = String(value ?? '0').replace(',', '.').replace(/[^0-9.]/g, '') || '0';
    const [wholeRaw, fractionRaw = ''] = this.removeExtraDots(clean).split('.');
    const whole = (wholeRaw || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const fraction = (fractionRaw + '0'.repeat(XMR_DECIMALS)).slice(0, XMR_DECIMALS);
    return `${whole}.${fraction.slice(0, 3)} ${fraction.slice(3, 6)} ${fraction.slice(6, 9)} ${fraction.slice(9)}`;
  }

  formatAtomicUnits(value: string | number): string {
    return String(value ?? '0').replace(/[^0-9]/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, ' ') || '0';
  }

  get blockConversion(): Price | undefined {
    if (this.todaySelected || this.currentPrice === undefined) {
      return undefined;
    }
    return {
      price: { [this.currentCurrency]: this.currentPrice } as any,
      exchangeRates: {} as any,
    };
  }
}
