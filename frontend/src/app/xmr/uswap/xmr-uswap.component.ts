import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { OpenGraphService } from '@app/services/opengraph.service';
import { SeoService } from '@app/services/seo.service';

@Component({
  selector: 'app-xmr-uswap',
  templateUrl: './xmr-uswap.component.html',
  styleUrls: ['./xmr-uswap.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class XmrUswapComponent implements OnInit {
  readonly uswapAppUrl = 'https://app.uswap.net/';
  readonly telegramUrl = 'https://t.me/hiss';

  constructor(
    private seoService: SeoService,
    private ogService: OpenGraphService,
  ) {}

  ngOnInit(): void {
    this.seoService.setTitle('Buy, Sell, & Swap XMR with uSwap');
    this.seoService.setDescription('Use uSwap from MoneroSpace to onramp, off-ramp, and convert XMR across crypto, fiat routes, cards, Telegram, VPN, gift cards, and more.');
    this.ogService.setManualOgImage('dashboard.png');
  }
}
