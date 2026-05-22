import { Component, Input, OnInit } from '@angular/core';
import { Observable } from 'rxjs';
import { StateService } from '@app/services/state.service';
import { FeeRoundingPipe } from '@app/shared/pipes/fee-rounding/fee-rounding.pipe';

@Component({
  selector: 'app-fee-rate',
  templateUrl: './fee-rate.component.html',
  styleUrls: ['./fee-rate.component.scss'],
  standalone: false,
})
export class FeeRateComponent implements OnInit {
  @Input() fee: number | undefined;
  // xmr-space: upstream segwit weight units are 4 per vByte, so the
  // upstream default divides by 4 to convert sat/WU → sat/vB. Monero
  // has no weight discount (weight == blob_size in bytes), so the
  // displayed atomic-per-byte rate must NOT divide. Default to 1.
  // Callers that explicitly pass [weight]="X" (e.g. for unit tests)
  // still take their override.
  @Input() weight: number = 1;
  @Input() rounding: string = null;
  @Input() dp: number = null;
  @Input() softDecimals: boolean = false;
  @Input() showUnit: boolean = true;
  @Input() unitClass: string = 'symbol';
  @Input() unitStyle: any;

  rateUnits$: Observable<string>;

  constructor(
    private stateService: StateService,
    private feeRoundingPipe: FeeRoundingPipe,
  ) { }

  ngOnInit() {
    this.rateUnits$ = this.stateService.rateUnits$;
  }

  getIntegerPart(rate: number): string {
    const formatted = this.feeRoundingPipe.transform(rate, this.rounding, this.dp);
    const decimalIndex = formatted.indexOf('.');
    return decimalIndex === -1 ? formatted : formatted.substring(0, decimalIndex);
  }

  getDecimalPart(rate: number): string {
    const formatted = this.feeRoundingPipe.transform(rate, this.rounding, this.dp);
    const decimalIndex = formatted.indexOf('.');
    return decimalIndex === -1 ? ' ' : formatted.substring(decimalIndex) + ' ';
  }
}
