import { Component } from '@angular/core';

/**
 * Single-page Monero-focused docs replacing upstream's tabbed
 * FAQ/REST/WebSocket/Electrum docs. The upstream `api-docs-data.ts` is
 * ~13k lines of Bitcoin-shaped tables, examples, and FAQ entries —
 * retargeting in-place would have taken many iterations and produced a
 * fragile mess. This new component covers the only docs that actually
 * apply to xmr-space: the FAQ + REST endpoints we serve.
 */
@Component({
  selector: 'app-xmr-docs',
  templateUrl: './xmr-docs.component.html',
  styleUrls: ['./xmr-docs.component.scss'],
  standalone: false,
})
export class XmrDocsComponent {}
