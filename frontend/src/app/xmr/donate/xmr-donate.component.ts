import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { OpenGraphService } from '@app/services/opengraph.service';
import { SeoService } from '@app/services/seo.service';

@Component({
  selector: 'app-xmr-donate',
  templateUrl: './xmr-donate.component.html',
  styleUrls: ['./xmr-donate.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class XmrDonateComponent implements OnInit {
  readonly donateAddress = '83PcqHAZRciDzuwiKFwXJ7dgYbmudizgLNGJE6uvV1KoiDdGL8jfVz2FQoG32wFbgdCo4YQ3mGnDZ7buXL1zsqcgMzAVbYs';
  readonly donateUri = `monero:${this.donateAddress}`;
  readonly telegramUrl = 'https://t.me/hiss';

  constructor(
    private seoService: SeoService,
    private ogService: OpenGraphService,
  ) {}

  ngOnInit(): void {
    this.seoService.setTitle('Donate XMR to MoneroSpace');
    this.seoService.setDescription('Support MoneroSpace hosting costs with an XMR donation or contact t.me/hiss for sponsorship.');
    this.ogService.setManualOgImage('dashboard.png');
  }
}
