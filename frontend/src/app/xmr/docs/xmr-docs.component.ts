import { Component, OnInit } from '@angular/core';
import { SeoService } from '@app/services/seo.service';

/**
 * Single-page Monero-focused docs replacing upstream's tabbed
 * FAQ/REST/WebSocket/Electrum docs. The old upstream `api-docs-data.ts`
 * dataset was removed because it was a large Bitcoin-shaped surface.
 * This component covers the docs that actually apply to xmr-space:
 * the FAQ + REST endpoints we serve.
 */
@Component({
  selector: 'app-xmr-docs',
  templateUrl: './xmr-docs.component.html',
  styleUrls: ['./xmr-docs.component.scss'],
  standalone: false,
})
export class XmrDocsComponent implements OnInit {
  constructor(private seoService: SeoService) {}

  ngOnInit(): void {
    this.seoService.setTitle($localize`:@@xmr.docs.browser-title:Documentation`);
    this.seoService.setDescription($localize`:@@meta.description.xmr.docs:Monero explorer API reference: REST endpoints, WebSocket and SSE streams, plus an FAQ on mempool data and RingCT privacy.`);
  }
}
