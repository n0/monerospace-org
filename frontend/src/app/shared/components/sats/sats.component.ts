import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-sats',
  templateUrl: './sats.component.html',
  styleUrls: ['./sats.component.scss'],
  standalone: false,
})
export class SatsComponent {
  @Input() satoshis: number;
  @Input() digitsInfo = '1.0-0';
  @Input() addPlus = false;
  @Input() valueOverride: string | undefined = undefined;
}
