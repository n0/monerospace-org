#!/usr/bin/env python3
"""Render-aware SEO probe for the monerospace.org SPA.

Visits representative routes with a real browser (Chromium), waits for Angular
to bootstrap, then extracts the post-JS SEO fingerprint + perf metrics per route.
Saves JSON to rendered.json and screenshots to screenshots/.
"""
import json, sys, time
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

BASE = "https://monerospace.org"
BLOCK = "4b56ff281cc7d4af442afa06f83ca104047441e78131fa78513188e114591ae7"
TX = "831442a262c37bdc713a25a994e43f3ca50458cd01497ccc846cfbd2388ec7f4"

ROUTES = [
    ("home",            "/"),
    ("blocks_list",     "/blocks/1"),
    ("block",           f"/block/{BLOCK}"),
    ("tx",              f"/tx/{TX}"),
    ("txs",             "/txs"),
    ("graphs_mempool",  "/graphs/mempool"),
    ("graphs_price",    "/graphs/price"),
    ("about",           "/about"),
    ("docs",            "/docs"),
    ("soft404_path",    "/this-page-does-not-exist-xyz123"),
    ("soft404_block",   "/block/zzznotahash"),
]

INIT = r"""
window.__cls = 0; window.__lcp = 0; window.__longtasks = 0; window.__lt_total = 0;
try {
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (!e.hadRecentInput) window.__cls += e.value; } }).observe({type:'layout-shift', buffered:true});
} catch(e){}
try {
  new PerformanceObserver((l) => { const es=l.getEntries(); const last=es[es.length-1]; if(last) window.__lcp = last.startTime; }).observe({type:'largest-contentful-paint', buffered:true});
} catch(e){}
try {
  new PerformanceObserver((l) => { for (const e of l.getEntries()){ window.__longtasks++; window.__lt_total += e.duration; } }).observe({type:'longtask', buffered:true});
} catch(e){}
"""

FINGERPRINT = r"""
() => {
  const meta = (n) => { const e=document.querySelector(`meta[name="${n}"]`)||document.querySelector(`meta[property="${n}"]`); return e?e.getAttribute('content'):null; };
  const canonical = document.querySelector('link[rel="canonical"]');
  const alternates = [...document.querySelectorAll('link[rel="alternate"]')].map(l=>({hreflang:l.getAttribute('hreflang'), href:l.getAttribute('href')}));
  const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s=>s.textContent.slice(0,300));
  const h1 = [...document.querySelectorAll('h1')].map(e=>(e.innerText||'').trim()).filter(Boolean);
  const h2 = [...document.querySelectorAll('h2')].map(e=>(e.innerText||'').trim()).filter(Boolean).slice(0,12);
  const bodyText = (document.body.innerText||'').replace(/\s+/g,' ').trim();
  const imgs = [...document.querySelectorAll('img')];
  const imgsNoAlt = imgs.filter(i=>!i.hasAttribute('alt')||i.getAttribute('alt').trim()==='').length;
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const res = performance.getEntriesByType('resource');
  let totalTransfer = (nav.transferSize||0);
  const byType = {};
  for (const r of res) { totalTransfer += (r.transferSize||0); const t=r.initiatorType||'other'; byType[t]=(byType[t]||0)+(r.transferSize||0); }
  const big = res.map(r=>({u:(r.name||'').split('/').pop().slice(0,40), kb:Math.round((r.transferSize||0)/1024)}))
                 .filter(x=>x.kb>20).sort((a,b)=>b.kb-a.kb).slice(0,8);
  return {
    url: location.href, title: document.title, titleLen: document.title.length,
    canonical: canonical?canonical.getAttribute('href'):null,
    description: meta('description'), descLen: (meta('description')||'').length,
    ogTitle: meta('og:title'), ogUrl: meta('og:url'), ogImage: meta('og:image'),
    twitterCard: meta('twitter:card'), robots: meta('robots'),
    lang: document.documentElement.getAttribute('lang'),
    alternates, h1, h1count: h1.length, h2,
    textLen: bodyText.length, textSample: bodyText.slice(0,500),
    imgCount: imgs.length, imgsNoAlt,
    jsonldCount: jsonld.length, jsonldSample: jsonld,
    perf: {
      ttfb: Math.round(nav.responseStart||0),
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd||0),
      load: Math.round(nav.loadEventEnd||0),
      lcp: Math.round(window.__lcp||0),
      cls: Math.round((window.__cls||0)*1000)/1000,
      longtasks: window.__longtasks||0,
      longtaskTotalMs: Math.round(window.__lt_total||0),
      reqCount: res.length,
      totalTransferKB: Math.round(totalTransfer/1024),
      transferByTypeKB: Object.fromEntries(Object.entries(byType).map(([k,v])=>[k,Math.round(v/1024)])),
      biggest: big
    }
  };
}
"""

def probe(page, label, path):
    url = BASE + path
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    console_errs = []
    page.on("console", lambda m: console_errs.append(m.text[:200]) if m.type=="error" else None)
    rec = {"label": label, "path": path}
    try:
        resp = page.goto(url, wait_until="domcontentloaded", timeout=30000)
        rec["http_status"] = resp.status if resp else None
    except PWTimeout:
        rec["http_status"] = "timeout"
    except Exception as e:
        rec["error"] = str(e)[:200]; return rec
    page.wait_for_timeout(4200)  # let Angular bootstrap + SeoService run + content paint
    try:
        fp = page.evaluate(FINGERPRINT)
        rec.update(fp)
    except Exception as e:
        rec["eval_error"] = str(e)[:200]
    rec["pageErrors"] = errors[:5]
    rec["consoleErrors"] = console_errs[:5]
    return rec

def main():
    out = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width":1440,"height":900},
                                  user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 ClaudeSEO/1.2")
        ctx.add_init_script(INIT)
        page = ctx.new_page()
        for label, path in ROUTES:
            print(f"  probing {label} {path} ...", file=sys.stderr, flush=True)
            out.append(probe(page, label, path))
        # screenshots: desktop home + block
        for label, path in [("home","/"), ("block", f"/block/{BLOCK}")]:
            try:
                page.goto(BASE+path, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(4200)
                page.screenshot(path=f"screenshots/{label}-desktop.png", full_page=False)
            except Exception as e:
                print(f"  desktop screenshot {label} failed: {e}", file=sys.stderr)
        ctx.close()
        # mobile pass
        mctx = browser.new_context(viewport={"width":390,"height":844}, is_mobile=True, has_touch=True, device_scale_factor=2,
                                   user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
        mpage = mctx.new_page()
        for label, path in [("home","/"), ("block", f"/block/{BLOCK}")]:
            try:
                mpage.goto(BASE+path, wait_until="domcontentloaded", timeout=30000)
                mpage.wait_for_timeout(4200)
                mpage.screenshot(path=f"screenshots/{label}-mobile.png", full_page=False)
            except Exception as e:
                print(f"  mobile screenshot {label} failed: {e}", file=sys.stderr)
        mctx.close()
        browser.close()
    with open("rendered.json","w") as f:
        json.dump(out, f, indent=2)
    print(json.dumps(out, indent=2))

if __name__ == "__main__":
    main()
