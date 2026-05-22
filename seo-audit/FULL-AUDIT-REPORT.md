# Full SEO Audit — monerospace.org

**Site:** https://monerospace.org (Monero block & mempool explorer — Angular SPA fork of mempool.space)
**Audit date:** 2026-05-22
**Method:** Live HTTP probing + JS-rendered probing (headless Chromium, 11 routes) + authoritative source-code review of `/home/lukee/dev/xmr-space` @ branch `xmr`.
**Business type detected:** Cryptocurrency block explorer — a *programmatic / data-driven utility site* (millions of auto-generated `/block/:id` and `/tx/:id` pages), localized into **34 languages**.

---

## Executive Summary

### SEO Health Score: **52 / 100** — *Needs Work*

| Category | Weight | Score | Weighted |
|---|---:|---:|---:|
| Technical SEO | 22% | 46 | 10.1 |
| Content Quality | 23% | 64 | 14.7 |
| On-Page SEO | 20% | 60 | 12.0 |
| Schema / Structured Data | 10% | 15 | 1.5 |
| Performance (CWV) | 10% | 84 | 8.4 |
| AI Search Readiness | 10% | 22 | 2.2 |
| Images | 5% | 55 | 2.75 |
| **Total** | **100%** | | **≈ 52** |

**One-sentence verdict:** The fundamentals that are *implemented* are genuinely good — per-route titles/descriptions/canonicals, fast Core Web Vitals, clean URLs, real unique content — but they are all delivered **client-side only**, so discovery (no sitemap), crawl efficiency (soft-404s), non-Google engines, social sharing (broken OG images), and internationalization (no hreflang across 34 locales) are significantly undermined.

### Top 5 Critical Issues
1. **No sitemap.xml.** `/sitemap.xml` returns the SPA HTML shell — there is no sitemap at all. For an explorer with millions of pages, search engines have no discovery feed.
2. **Soft-404s create index-bloat risk.** Invalid `/block/<junk>`, `/tx/<junk>`, and any unknown path return **HTTP 200**; an invalid block page even **self-canonicalizes to the junk URL** with the homepage title and no `noindex`.
3. **Pure client-side rendering, no SSR/prerender in production.** Every URL serves an identical ~3 KB empty `<app-root>` shell to anything that doesn't execute JS (Bing, AI crawlers, social scrapers, and Google's first-pass fetch).
4. **Broken social preview images for blocks & transactions.** `og:image`/`twitter:image` point to `/render/en/preview/...`, which returns HTML, not an image — block/tx shares show no card image.
5. **No hreflang across 34 built locales.** `/es/…`, `/de/…`, `/ja/…` etc. are all indexable but unlinked → wrong-locale indexing and duplicate-content risk.

### Top 5 Quick Wins
1. **Point block/tx `og:image` to a static fallback** (e.g. `dashboard.png`) until the render service ships — restores social cards immediately.
2. **Set a real `<title>`/description for `/docs`** — it currently inherits the homepage shell title despite 11 KB of content (one `seoService.setTitle()` call).
3. **Add security headers** (HSTS, `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy`) at Cloudflare or in `deploy/nginx.conf`.
4. **301 `www` → apex** at the edge (both currently serve `200`).
5. **Optimize the homepage OG image** — `dashboard.png` is a **2.0 MB PNG**; re-export as <300 KB JPG/WebP (sibling previews are 73 KB JPGs).

---

## 1. Rendering Model — the central finding

`monerospace.org` is a **pure client-side-rendered (CSR) Angular SPA**. Verified three ways:

- **Identical shells:** the homepage HTML is **3,605 bytes** and byte-identical whether fetched with a normal UA or `Googlebot` UA (no dynamic rendering/prerender). Inner routes return a **3,101-byte** shell.
- **Empty body:** the served HTML is `<body><app-root></app-root>…scripts…</body>` — zero content before JS executes. All visible content, and the per-route `<title>`/description/canonical, are injected by Angular *after* bootstrap.
- **Source confirms it:** SSR machinery exists in the repo (`frontend/server.ts`, `main.server.ts`, `angular.json` `server`/`prerender` targets) but production builds **`ng build` only** (`Dockerfile.coolify:40`) and serves static files via nginx (`deploy/nginx.conf:33`). The `prerender` target lists only `routes: ["/"]` (`angular.json:336`). **No Node SSR process runs in production.**

**Why this matters:** Googlebot *can* render JS (so it will eventually see correct content/meta), but rendering is deferred and best-effort. Bingbot, social unfurlers (Twitter/Slack/Telegram/Discord/Facebook), and AI crawlers largely **do not** execute JS — to them, every URL on the site looks like the homepage shell. This single architectural choice is the root cause of findings #2–#5 below.

---

## 2. Technical SEO — 46/100

**Strengths**
- HTTPS enforced; `http://` → `https://` upgrade works (Cloudflare).
- `robots.txt` present (Cloudflare-managed) and `Allow: /` for search engines.
- Clean, semantic URLs: `/block/:hash`, `/tx/:id`, `/blocks/:page`, `/graphs/*`.
- Per-route canonical is correct and updates on every navigation (see §4).
- Backend API returns *real* 404s for bad paths (e.g. `/api/blocks/tip/height` → Express 404).
- Fast TTFB (~70–166 ms) and edge-cached, hashed, gzipped assets.

**Issues**

| Severity | Issue | Evidence |
|---|---|---|
| 🔴 Critical | **No sitemap.xml** — returns the SPA shell. No backend route generates one (`backend/src/api/monero/xmr-server.ts:49` registers only `/healthz`); `deploy/nginx.conf` has no `/sitemap.xml` handler, so it falls through to `try_files … /index.html`. `robots.txt` contains no `Sitemap:` directive. | `GET /sitemap.xml` → `text/html`, 3101 b |
| 🔴 Critical | **Soft-404 / index bloat** — `/this-page-does-not-exist`, `/block/zzznotahash`, `/tx/notatx` all return **HTTP 200** + shell. The catch-all `**` route redirects to home client-side (`app-routing.module.ts:43-46`) but the *server* already returned 200. An invalid block renders an empty "Block" component, keeps the **homepage** title, and **self-canonicalizes to the junk URL** (`canonical=https://monerospace.org/block/zzznotahash`). No `noindex`. | `rendered.json` → `soft404_block` |
| 🟠 High | **No security headers** — `deploy/nginx.conf` and the Cloudflare/Traefik layer set none. Missing: `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`/CSP `frame-ancestors`, `Referrer-Policy`. (Notably, the parked `xmr.space` host *does* send HSTS; the live host doesn't.) | Response header dump |
| 🟡 Medium | **No host canonicalization** — `https://monerospace.org/` and `https://www.monerospace.org/` both return `200` with no `301`. The hardcoded canonical tag (apex) mitigates for Google but not all engines. | Redirect probe |
| 🟢 Low | **`window.soft404` flag is dead** — `SeoService.logSoft404()` (`seo.service.ts:97-103`) sets a flag intended for an SSR renderer to emit a 404; with no SSR, nothing consumes it. | Source review |

---

## 3. Content Quality & E-E-A-T — 64/100

**Strengths**
- **Genuinely unique, data-rich content** per entity when rendered: block pages show height/hash/size/weight/fee-span/median-fee/reward; tx pages show status/fee/size/ring info, with RingCT fields blurred by design.
- **`/docs`** is substantial (≈11.3 KB rendered text: FAQ, REST API, WebSocket, SSE, Privacy & limitations).
- **`/about`** transparently states what the site is ("a fork of mempool.space retargeted to Monero", "Privacy by default", v0.1), which is a reasonable trust/E-E-A-T signal for a utility.
- Meta descriptions are well-written and Monero/RingCT-aware (e.g. the tx description explicitly notes "Amounts and recipients stay hidden by RingCT").

**Issues**
- 🔴 **Crawler-invisible content.** Because content is CSR-only, non-JS engines and AI crawlers see thin homepage boilerplate on every URL (see §1). This caps the realizable value of otherwise good content.
- 🟡 **Soft-404 pages render dashboard content** rather than a "not found" state → low-value near-duplicate pages.
- 🟡 **Brand-name inconsistency** weakens entity clarity: the site variously calls itself *monerospace.org*, *Monero Explorer*, *Monero Mempool Explorer* (shell), *MoneroSpace* (About), and *xmr-space* (docs H1).
- 🟢 No author/organization/maintainer entity is expressed in machine-readable form (see §5).

---

## 4. On-Page SEO — 60/100

Per-route rendered SEO tags (post-JS, verified live):

| Route | `<title>` | Canonical | H1 | Notes |
|---|---|---|---|---|
| `/` | `monerospace.org - Monero Explorer` | `…/` | — (none) | No H1 (dashboard) |
| `/blocks/1` | `Blocks - … - Monero Explorer` | `…/blocks/1` | `Blocks` | ✅ good |
| `/block/:hash` | `Block 3679433: <64-hex> - … - Monero Explorer` | `…/block/:hash` | `Block 3679433` | ✅ unique; title 115 chars (too long) |
| `/tx/:id` | `Transaction: <64-hex> - … - Monero Explorer` | `…/tx/:id` | `Transaction` | ✅ unique; title 113 chars (too long) |
| `/txs` | `Recent Transactions - … - Monero Explorer` | `…/txs` | `Recent Transactions` | ✅ good |
| `/graphs/mempool` | `Graphs - … - Monero Explorer` | `…/graphs/mempool` | — (none) | Generic "Graphs" title; no H1 |
| `/graphs/price` | `XMR Price - … - Monero Explorer` | `…/graphs/price` | — (none) | Good title; no H1 |
| `/about` | `About MoneroSpace - … - Monero Explorer` | `…/about` | — (none) | No H1 on a content page |
| `/docs` | **`monerospace.org - Monero Mempool Explorer`** | `…/docs` | `xmr-space documentation` | ⚠️ inherits homepage shell title/description |

**Strengths:** canonical updates per-route to the correct `monerospace.org` host (driven from `app.component.ts:60` → `seoService.updateCanonical()`, `seo.service.ts:85-87`); `/block/:height` correctly canonicalizes to `/block/:hash`; titles follow a consistent `{page} - monerospace.org - Monero Explorer` template; descriptions are unique and useful.

**Issues**
- 🟠 **`/docs` is mis-titled** — keeps the static shell title `…- Monero Mempool Explorer` and the generic homepage description; `SeoService.setTitle/Description` is never called for the docs module.
- 🟠 **No hreflang** (see §8).
- 🟡 **Missing H1** on `/`, `/about`, and all `/graphs/*` pages.
- 🟡 **Block/tx titles too long** (~113–115 chars; the full 64-char hash is in the title) → truncated in SERPs. Put the hash in the description, keep the title concise (e.g. `Monero Block 3679433 — monerospace.org`).
- 🟢 **`og:url` missing** on every page (canonical covers Google, but `og:url` helps social).

---

## 5. Schema / Structured Data — 15/100

**Zero structured data.** No JSON-LD (`script[type="application/ld+json"]`) on any of the 11 routes probed; no Microdata/RDFa.

Opportunities (all require SSR/prerender to be crawlable — see §1):
- `WebSite` + (optionally) `SearchAction` for the site, `Organization` for entity identity.
- `BreadcrumbList` on `/block/:id` and `/tx/:id`.
- `Dataset` is a plausible fit for the chain-data pages.
- `FAQPage` on `/docs`: note Google restricts FAQ *rich results* to government/health sites (Aug 2023), so this won't earn SERP FAQ snippets — but it can aid AI/LLM citation. Treat as informational, low priority.

---

## 6. Performance / Core Web Vitals — 84/100

Lab metrics (single headless-Chromium run, fast connection — *not* field/CrUX data; INP estimated from long-task time since it can't be measured passively):

| Metric | Homepage (cold) | Assessment |
|---|---|---|
| LCP | **1,304 ms** | ✅ Good (<2.5 s) |
| CLS | **0** | ✅ Good |
| Long tasks | 1 × 153 ms | ✅ INP likely good |
| TTFB | 166 ms | ✅ |
| Transfer (cold) | ~770 KB | ✅ lean for Angular |
| Requests | 21 | ✅ |

- **Largest payloads:** lazy chunk `97.*.js` 313 KB + `main.js` 243 KB + `styles.css` 39 KB (transfer, gzipped). Lazy-loading is working — inner-route navigations are warm-cache and sub-200 ms.
- Assets: `content-encoding: gzip`, `cache-control: max-age=14400` (4 h), `cf-cache-status: HIT`.
- 🟡 **Brotli not enabled** — Cloudflare serves gzip even when `br` is offered (~15–20% larger JS/CSS than necessary).
- 🟡 **Hashed assets cached only 4 h** — they're content-hashed, so `max-age=31536000, immutable` is safe and better.
- 🟡 **CLS 0.118 on the invalid-block page** (>0.1) — edge case tied to the empty-block render.

> Performance is a real strength. The "empty shell to crawlers" problem is an *indexability* issue (counted in Technical/AI), not a user-perceived speed issue — real users get a fast, smooth experience.

---

## 7. Images & Social Cards — 55/100

**Strengths**
- Block-list pool logos carry `alt` text (0 missing alt on `/blocks/1`).
- Favicons complete; static OG previews exist and are well-sized JPGs: `blocks.jpg` (73 KB), `about.jpg` (74 KB).
- Most pages use SVG/icon-font UI (no raster-image SEO surface).

**Issues**
- 🟠 **Block/tx OG images are broken.** `og:image`/`twitter:image` resolve to `https://monerospace.org/render/en/preview/block/:hash` (and `/tx/:id`), which returns **`text/html` (3101 b)** — the SPA shell, not an image. The mempool "unfurler" render service isn't deployed. Result: the highest-volume shareable pages show **no preview image** on social/chat platforms.
- 🟡 **Homepage OG image oversized** — `dashboard.png` is **2,041,253 bytes (2.0 MB)**, a 2000×1000 PNG. Re-export as JPG/WebP <300 KB (its siblings are 73 KB JPGs).

---

## 8. International SEO (hreflang) — gap

The build emits **34 locales** (`angular.json:19-159`): en-US + `ar, ca, cs, de, da, es, fa, fr, hr, ja, ka, ko, it, he, nl, nb, pl, pt, sl, sv, th, tr, uk, fi, vi, hu, mk, zh, ro, ru, hi, ne, lt`, each under a path prefix (`/es/…`, `/de/…`). nginx negotiates locale via `Accept-Language`/cookie and falls back to `/en-US/`.

🟠 **No `hreflang` annotations exist** — no `<link rel="alternate" hreflang>` in the index templates or injected at runtime (verified live: `alternates: []` on every route; source grep: no matches). With 34 indexable locale trees and no hreflang linking them, search engines may index the wrong locale or treat them as duplicates. (And because hreflang must be crawlable, this fix also depends on SSR/prerender or build-time injection.)

---

## 9. AI Search Readiness / GEO — 22/100 (largely **by design**)

The Cloudflare-managed `robots.txt` **explicitly blocks every major AI crawler** with `Disallow: /`:

> `Amazonbot, Applebot-Extended, Bytespider, CCBot, ClaudeBot, CloudflareBrowserRenderingCrawler, Google-Extended, GPTBot, meta-externalagent`

…plus `User-agent: *  Content-Signal: search=yes, ai-train=no`.

**Interpretation:** AI training and AI crawling are **deliberately opted out** (the Cloudflare one-click "block AI bots" setting — consistent with a privacy-focused Monero project). Traditional search (Googlebot, Bingbot) and, notably, **PerplexityBot** are *not* blocked.

Consequences for AI visibility (ChatGPT, Claude, Gemini, Google AI Overviews training):
- Blocked at the edge regardless of content.
- Compounded by the empty SPA shell (even allowed AI fetchers that don't run JS get nothing) and the absence of `llms.txt` (`/llms.txt` returns the SPA shell — none is shipped).

**This is a policy choice, not a defect.** If AI presence is *not* wanted, the current setup achieves it. If it *is* wanted, both the Cloudflare AI-bot blocking and the CSR/no-llms.txt limitations must be addressed (see Action Plan §AI).

---

## 10. Notes / Corrections to internal docs

- `AUDIT.md` and `PROGRESS.md` claim the canonical/title were retargeted to **`xmr.space`**. **These are stale.** The shipping source uses **`monerospace.org`** everywhere (`seo.service.ts:14` `baseDomain = 'monerospace.org'`; `index.html:40` / `index.mempool.html:40` canonical). There are zero `xmr.space` references in frontend source. The live runtime canonical correctly points to `monerospace.org` — so the "canonical points to a dead domain" risk does **not** exist in production. (The parked `xmr.space` host returns `503`.) Recommend updating the docs to avoid confusion.

---

## Appendix — Evidence artifacts (in `seo-audit/`)
- `raw/home-default.html`, `raw/home-googlebot.html` — identical 3,605 b shells
- `raw/sitemap.xml`, `raw/llms.txt` — both are the SPA shell (3,101 b), not real files
- `raw/robots.txt` — full Cloudflare-managed robots
- `rendered.json` — post-JS SEO fingerprint + lab CWV for 11 routes
- `screenshots/` — `home-desktop`, `home-mobile`, `block-desktop`, `block-mobile`
- `render_audit.py` — the Playwright probe used

*Scoring weights follow the `seo` skill methodology. Lab CWV are indicative, not field data.*
