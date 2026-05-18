import { Component, ChangeDetectionStrategy, Input } from '@angular/core';
import { Transaction } from '@interfaces/electrs.interface';

@Component({
  selector: 'app-tx-features',
  templateUrl: './tx-features.component.html',
  styleUrls: ['./tx-features.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TxFeaturesComponent {
  @Input() tx: Transaction;
}
