import { Component } from '@angular/core';
import { SeoService } from '@app/services/seo.service';
import { OpenGraphService } from '@app/services/opengraph.service';

@Component({
  selector: 'app-terms-of-service',
  templateUrl: './terms-of-service.component.html',
  standalone: false,
})
export class TermsOfServiceComponent {
  constructor(
    private seoService: SeoService,
    private ogService: OpenGraphService,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle('Terms of Service');
    this.seoService.setDescription('Terms for using MoneroSpace, an open-source Monero block and mempool explorer that surfaces public chain data without wallet, custody, or transaction-priority services.');
    this.ogService.setManualOgImage('terms-of-service.jpg');
  }
}
