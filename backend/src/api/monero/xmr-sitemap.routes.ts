import { Application, Request, Response } from 'express';

/**
 * Serves /sitemap.xml for the explorer.
 *
 * Only stable, bounded routes are listed. Entity pages (/block/:id, /tx/:id)
 * are intentionally excluded — they are unbounded and ephemeral, and are
 * discovered through internal linking instead of a sitemap. Locale variants
 * are signalled via per-page <link rel="alternate" hreflang> tags emitted by
 * the frontend SeoService, not enumerated here.
 *
 * The public origin defaults to https://monerospace.org and can be overridden
 * with XMR_PUBLIC_URL. nginx proxies /sitemap.xml to this route (see
 * deploy/nginx.conf) ahead of the SPA catch-all.
 */

interface SitemapEntry {
  path: string;
  changefreq: string;
  priority: string;
}

const STABLE_PATHS: SitemapEntry[] = [
  { path: '/', changefreq: 'always', priority: '1.0' },
  { path: '/blocks/1', changefreq: 'hourly', priority: '0.8' },
  { path: '/txs', changefreq: 'always', priority: '0.7' },
  { path: '/graphs/mempool', changefreq: 'hourly', priority: '0.6' },
  { path: '/graphs/price', changefreq: 'hourly', priority: '0.6' },
  { path: '/graphs/swaps', changefreq: 'daily', priority: '0.5' },
  { path: '/graphs/mining/hashrate-difficulty', changefreq: 'daily', priority: '0.5' },
  { path: '/graphs/mining/pools', changefreq: 'daily', priority: '0.5' },
  { path: '/graphs/mining/block-fees', changefreq: 'daily', priority: '0.5' },
  { path: '/graphs/mining/block-fees-subsidy', changefreq: 'daily', priority: '0.5' },
  { path: '/graphs/mining/block-rewards', changefreq: 'daily', priority: '0.5' },
  { path: '/graphs/mining/block-fee-rates', changefreq: 'daily', priority: '0.5' },
  { path: '/graphs/mining/block-sizes-weights', changefreq: 'daily', priority: '0.5' },
  { path: '/tools/calculator', changefreq: 'monthly', priority: '0.4' },
  { path: '/about', changefreq: 'monthly', priority: '0.4' },
  { path: '/docs', changefreq: 'monthly', priority: '0.4' },
  { path: '/status', changefreq: 'always', priority: '0.3' },
  { path: '/terms-of-service', changefreq: 'yearly', priority: '0.2' },
  { path: '/privacy-policy', changefreq: 'yearly', priority: '0.2' },
  { path: '/trademark-policy', changefreq: 'yearly', priority: '0.2' },
];

export class XmrSitemapRoutes {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = (process.env.XMR_PUBLIC_URL ?? 'https://monerospace.org').replace(/\/+$/, '');
  }

  public initRoutes(app: Application): void {
    app.get('/sitemap.xml', this.getSitemap.bind(this));
  }

  private getSitemap(_req: Request, res: Response): void {
    const lastmod = new Date().toISOString().slice(0, 10);
    const urls = STABLE_PATHS.map(({ path, changefreq, priority }) =>
      [
        '  <url>',
        `    <loc>${this.baseUrl}${path}</loc>`,
        `    <lastmod>${lastmod}</lastmod>`,
        `    <changefreq>${changefreq}</changefreq>`,
        `    <priority>${priority}</priority>`,
        '  </url>',
      ].join('\n'),
    ).join('\n');

    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      `${urls}\n` +
      '</urlset>\n';

    res.header('Content-Type', 'application/xml; charset=utf-8');
    res.header('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  }
}
