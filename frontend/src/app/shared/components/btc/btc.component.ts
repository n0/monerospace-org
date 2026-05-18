import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';

@Component({
  selector: 'app-btc',
  templateUrl: './btc.component.html',
  styleUrls: ['./btc.component.scss'],
  standalone: false,
})
export class BtcComponent implements OnChanges {
  @Input() satoshis: number;
  @Input() addPlus = false;
  @Input() valueOverride: string | undefined = undefined;

  value: number;
  unit: string;

  ngOnChanges(changes: SimpleChanges): void {
    if (this.satoshis >= 1_000_000_000_000) {
      this.value = (this.satoshis / 1_000_000_000_000);
      this.unit = 'XMR';
    } else {
      this.value = Math.round(this.satoshis);
      this.unit = 'atomic';
    }
  }
}
