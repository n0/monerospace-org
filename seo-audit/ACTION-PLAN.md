# Action Plan — monerospace.org SEO

Prioritized **Critical → Low**. Each item: impact, concrete fix, and where in the codebase. Health score today: **52/100**. The single highest-leverage change (SSR/prerender) unblocks several others.

---

## 🔴 Critical — fix immediately (blocks discovery / causes index bloat)

### C1. Ship a real `sitemap.xml`
- **Why:** No sitemap exists (`/sitemap.xml` serves the SPA shell). Search engines have no discovery feed for an explorer of millions of pages.
- **Do:**
  - Add a backend route in `backend/src/api/monero/xmr-server.ts` (alongside `/healthz`) that emits a **sitemap index** + a **static sitemap** of stable URLs: `/`, `/blocks/1`, `/txs`, `/graphs/{mempool,price,swaps,mining/*}`, `/about`, `/docs`, `/tools/calculator`, `/status`, `/terms-of-service`, `/privacy-policy`, `/trademark-policy`.
  - Optionally a **rolling sitemap** of the most recent N blocks/txs (don't try to list all history — it's unbounded).
  - Route `/sitemap.xml` in `deploy/nginx.conf` to the backend (add a `location = /sitemap.xml` **before** the SPA `try_files` fallback).
  - Add `Sitemap: https://monerospace.org/sitemap.xml` to `robots.txt` (see L2).

### C2. Stop serving soft-404s; don't self-canonicalize junk
- **Why:** `/block/<junk>`, `/tx/<junk>`, and unknown paths return **200**; an invalid block self-canonicalizes to the junk URL with no `noindex` → unbounded indexable junk + wasted crawl budget.
- **Do (any/all):**
  - For invalid entities, **don't set a self-canonical** to the requested URL and **add `<meta name="robots" content="noindex">`** in the not-found state (`block.component`/`transaction.component` error branch; `SeoService` already has `logSoft404()` at `seo.service.ts:97-103` — wire a real signal to it).
  - Return a proper **404 status** for unknown paths — this requires SSR/prerender (C3) or a Cloudflare edge rule that 404s non-matching paths.
  - Until then, at minimum canonicalize invalid entity pages to their parent (`/blocks/1` or `/`) instead of to themselves.

### C3. Deploy SSR or prerender (highest leverage)
- **Why:** Pure CSR means Bing, AI crawlers, and social unfurlers see an empty shell on every URL; Google must render JS (deferred). This is the root cause of C1-adjacent discovery problems, broken OG images (H1), missing hreflang (H2), and uncrawlable schema (M1).
- **Do:** The SSR stack already exists — `frontend/server.ts`, `main.server.ts`, `angular.json` `server`/`prerender` targets, and `package.json` `build:ssr`/`serve:ssr`.
  - **Option A (best):** Run the Angular Universal server in production (build `server:production`, run the Node server behind nginx) so block/tx pages are server-rendered on demand. This also revives the `/render/...` OG service.
  - **Option B (lighter):** Prerender the **stable** routes (expand `angular.json` prerender `routes` beyond `["/"]`) and keep CSR for entity pages, paired with C2's noindex/edge-404 handling.
- **Effort:** Medium-High. Everything needed is in the repo; it's a build/deploy change (`Dockerfile.coolify:40` currently runs plain `npm run build`).

---

## 🟠 High — fix within ~1 week

### H1. Fix block/tx social preview images
- **Why:** `og:image`/`twitter:image` → `/render/en/preview/{block,tx}/:id` returns HTML, not an image → no card image on shares of the most-shared pages.
- **Do:** Deploy the unfurler/SSR render service (folds into C3-A). **Quick interim fix:** point block/tx `og:image` to a working static image (`/resources/previews/blocks.jpg` or `dashboard.png`) in `SeoService`/components until `/render` is live.

### H2. Add hreflang across the 34 locales
- **Why:** 34 indexable locale trees with no `rel="alternate" hreflang"` → wrong-locale indexing / duplicate content.
- **Do:** Emit `<link rel="alternate" hreflang="<locale>" href="…">` for each locale + `x-default`, per page. Must be in server-rendered/prerendered HTML to be reliably crawled (depends on C3). Source: locales in `angular.json:19-159`; currently zero hreflang in templates or runtime.

### H3. Give `/docs` its own title & description
- **Why:** `/docs` (≈11 KB of FAQ/API content) inherits the homepage shell title `…- Monero Mempool Explorer` + generic description.
- **Do:** Call `seoService.setTitle()` / `setDescription()` in the docs module (XmrDocsModule) — one small change.

### H4. Add security headers
- **Why:** No HSTS, `X-Content-Type-Options`, `X-Frame-Options`/CSP `frame-ancestors`, or `Referrer-Policy` on the live deploy.
- **Do:** Add at Cloudflare (Transform Rules / Managed Headers) or in `deploy/nginx.conf`:
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: SAMEORIGIN` (or CSP `frame-ancestors 'self'`)
  - `Referrer-Policy: strict-origin-when-cross-origin`

---

## 🟡 Medium — fix within ~1 month

### M1. Add structured data (JSON-LD)
- `WebSite` + `Organization` site-wide; `BreadcrumbList` on `/block/:id` and `/tx/:id`. (Crawlable only with C3.) Skip new `FAQPage` for Google rich-results purposes (gov/health-only since 2023); optional for AI citation.

### M2. Add H1s
- Add a semantic `<h1>` (visually-hidden if needed) to `/`, `/about`, and `/graphs/*`.

### M3. Shorten block/tx `<title>`
- Drop the full 64-char hash from the title (currently ~113–115 chars → SERP truncation). E.g. `Monero Block 3679433 — monerospace.org`; keep the hash in the meta description.

### M4. 301 `www` → apex
- Both `www` and apex return `200`. Add a Cloudflare redirect rule `www.monerospace.org/*` → `https://monerospace.org/$1` (301).

### M5. Optimize the homepage OG image
- `dashboard.png` is **2.0 MB**. Re-export as JPG/WebP <300 KB (match the 73 KB sibling previews).

### M6. Enable Brotli + immutable asset caching
- Turn on Brotli at Cloudflare (currently gzip). Set content-hashed assets to `Cache-Control: max-age=31536000, immutable` (currently 4 h).

### M7. Unify the brand name
- Pick one name and apply consistently across `<title>` template, `/docs` H1 (`xmr-space documentation`), and About. Currently mixes *monerospace.org / Monero Explorer / Monero Mempool Explorer / MoneroSpace / xmr-space*.

---

## 🟢 Low — backlog

- **L1. Add `og:url`** per route (mirror the canonical).
- **L2. Ship an in-repo `robots.txt`** referencing the sitemap (so it's version-controlled), and consciously decide the AI-bot policy (see below).
- **L3. Decide the AI-crawler stance deliberately.** The Cloudflare-managed robots blocks GPTBot/ClaudeBot/Google-Extended/CCBot/Bytespider/meta-externalagent and sets `ai-train=no`. If AI invisibility is intended (privacy ethos) — done. If AI presence is wanted, unblock the relevant bots, add an `llms.txt`, and pair with C3 (none of it matters while the shell is empty).
- **L4. Update stale docs.** `AUDIT.md`/`PROGRESS.md` still reference `xmr.space`; the code now uses `monerospace.org`. Correct them to prevent confusion.

---

### Suggested sequencing
1. **Week 1 quick wins (no SSR needed):** H1-interim (static OG fallback), H3 (`/docs` title), H4 (headers), M4 (www 301), M5 (OG image), M6 (Brotli/cache), C1 (static sitemap + robots `Sitemap:`).
2. **Then the structural fix:** C3 (SSR/prerender) → unblocks C2 (real 404s), H1-full (`/render`), H2 (hreflang), M1 (schema).
3. **Polish:** M2, M3, M7, and the Low items.
