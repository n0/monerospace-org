import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { SeoService } from '@app/services/seo.service';
import { OpenGraphService } from '@app/services/opengraph.service';

@Component({
  selector: 'app-about',
  templateUrl: './about.component.html',
  styleUrls: ['./about.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AboutComponent implements OnInit {
  constructor(
    private seoService: SeoService,
    private ogService: OpenGraphService,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle($localize`:@@004b222ff9ef9dd4771b777950ca1d0e4cd4348a:About MoneroSpace`);
    this.seoService.setDescription($localize`:@@meta.description.about:Learn about MoneroSpace, a Monero block and mempool explorer that surfaces public chain data while respecting RingCT privacy.`);
    this.ogService.setManualOgImage('about.jpg');
  }
}
