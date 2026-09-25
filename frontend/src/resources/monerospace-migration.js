/* Same-page MoneroSpace migration. No third-party requests or lookup analytics. */
(() => {
  'use strict';
  const role = document.currentScript.dataset.migration;
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const source = local ? 'http://127.0.0.1:4381' : 'https://monerospace.org';
  const target = local ? 'http://127.0.0.1:4382' : 'https://xmr.tx.taxi';
  const prefix = '#xmr-move=';
  const key = 'xmr-taxi-default-v1', nonceKey = 'xmr-taxi-move-v1', seenKey = 'xmr-taxi-from-monerospace-v1';
  const languages = new Set(["ar", "ca", "cs", "de", "da", "es", "fa", "fr", "hr", "ja", "ka", "ko", "it", "he", "nl", "nb", "pl", "pt", "sl", "sv", "th", "tr", "uk", "fi", "vi", "hu", "mk", "zh", "ro", "ru", "hi", "ne", "lt", "en", "en-US"]);
  const timezones = new Set(["local", "-12", "-11", "-10", "-9", "-8", "-7", "-6", "-5", "-4", "-3", "-2", "-1", "+0", "+1", "+2", "+3", "+4", "+5", "+6", "+7", "+8", "+9", "+10", "+11", "+12", "+13", "+14"]);
  let incoming, arrived = false, enabled = false, confirmEnable = false, storageFailed = false;
  const read = (store, name) => { try { return window[store].getItem(name); } catch { return null; } };
  const write = (store, name, value) => { try { value === null ? window[store].removeItem(name) : window[store].setItem(name,value); return true; } catch { return false; } };
  const metric = event => {
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl) return;
    fetch('/api/v1/migration-events', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({event}), credentials:'omit', referrerPolicy:'no-referrer', keepalive:true }).catch(() => {});
  };
  function supported(path) {
    const parts = path.split('/').filter(Boolean);
    if (languages.has(parts[0])) parts.shift();
    const route = parts.join('/');
    return /^(?:|tx\/[a-fA-F\d]{64}|block\/(?:[a-fA-F\d]{64}|\d+)|blocks(?:\/\d+)?|txs|status|about|terms-of-service|privacy-policy|trademark-policy|docs(?:\/(?:faq|api(?:\/(?:rest|websocket))?))?|tools\/calculator|mining(?:\/pool\/[a-z0-9-]+)?|graphs(?:\/(?:mempool|price|swaps|mining\/(?:hashrate-difficulty|pools|block-fees|block-fees-subsidy|block-rewards|block-fee-rates|block-sizes-weights)))?|mempool-block\/\d+)$/.test(route);
  }
  function prefs() {
    const fiat = read('localStorage','fiat-preference'), timezone = read('localStorage','timezone-preference');
    const cookie = document.cookie.match(/(?:^|;\s*)lang=([^;]+)/)?.[1];
    const language = languages.has(location.pathname.split('/')[1]) ? location.pathname.split('/')[1] : cookie;
    return {fiat: /^[A-Z]{3}$/.test(fiat || '') ? fiat : undefined, timezone:timezones.has(timezone) ? timezone : undefined, language:languages.has(language) ? language : undefined};
  }
  function applyPrefs(p = {}) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return;
    if (/^[A-Z]{3}$/.test(p.fiat || '')) write('localStorage','fiat-preference',p.fiat);
    if (timezones.has(p.timezone)) write('localStorage','timezone-preference',p.timezone);
    if (languages.has(p.language)) document.cookie = `lang=${p.language}; Path=/; Max-Age=31536000; SameSite=Lax${local ? '' : '; Secure'}`;
  }
  function link(origin, data) {
    const path = supported(location.pathname) ? location.pathname : '/';
    const url = new URL(path + (supported(location.pathname) ? location.search : ''), origin);
    url.hash = prefix + encodeURIComponent(JSON.stringify({...data,t:Date.now(),h:location.hash.slice(0,2048)}));
    return url.href;
  }
  function toTaxi(mode = 'try') {
    const nonce = crypto.randomUUID();
    write('sessionStorage',nonceKey,JSON.stringify({nonce,t:Date.now()}));
    return link(target,{mode,nonce,p:prefs()});
  }
  function rememberDefault() {
    if (!write('localStorage',key,'1')) { storageFailed = true; return false; }
    metric('default_enabled');
    location.replace(toTaxi('enabled'));
    return true;
  }
  if (location.hash.startsWith(prefix)) {
    try {
      if (location.hash.length > 8192) throw new Error('Oversized handoff');
      const value = JSON.parse(decodeURIComponent(location.hash.slice(prefix.length)));
      if (value && Number.isFinite(value.t) && Date.now()-value.t >= 0 && Date.now()-value.t < 600000 && typeof value.h === 'string' && value.h.length <= 2048 && (!value.h || value.h.startsWith('#')) && /^[a-f\d-]{36}$/.test(value.nonce || '') && supported(location.pathname)) incoming = value;
    } catch {}
    history.replaceState(null,'',location.pathname + location.search + (incoming?.h || ''));
  }
  if (role === 'target' && incoming && ['try','auto','enabled'].includes(incoming.mode)) {
    arrived = true; enabled = ['enabled','auto'].includes(incoming.mode);
    if (incoming.mode !== 'auto' || read('localStorage',seenKey) !== '1') applyPrefs(incoming.p);
    write('sessionStorage',nonceKey,JSON.stringify({nonce:incoming.nonce,t:incoming.t}));
    write('localStorage',seenKey,'1');
    metric('arrival');
  }
  if (role === 'source') {
    if (incoming && ['back','enable'].includes(incoming.mode)) applyPrefs(incoming.p);
    if (incoming?.mode === 'back') {
      const wasEnabled = read('localStorage',key) === '1';
      if (!write('localStorage',key,null)) storageFailed = true;
      if (wasEnabled) metric('default_disabled');
    } else if (incoming?.mode === 'enable') {
      let saved; try { saved = JSON.parse(read('sessionStorage',nonceKey)); } catch {}
      if (saved?.nonce === incoming.nonce && Date.now()-saved.t >= 0 && Date.now()-saved.t < 600000) rememberDefault();
      else confirmEnable = true;
    } else if (read('localStorage',key) === '1' && supported(location.pathname)) {
      metric('auto_forward'); location.replace(toTaxi('auto'));
    }
  }
  function mount() {
    if (role === 'target' && !arrived && read('localStorage',seenKey) !== '1') return;
    const banner = document.createElement('aside');
    banner.id = 'monerospace-migration'; banner.setAttribute('aria-label','MoneroSpace and XMR Taxi');
    const style = document.createElement('style');
    style.textContent = '#monerospace-migration{box-sizing:border-box;background:#18130e;border-bottom:1px solid #51351f;color:#dfd9d2;font:13px/1.5 system-ui,sans-serif;padding:10px 24px;display:flex;align-items:center;justify-content:center;gap:8px 20px;flex-wrap:wrap}#monerospace-migration p{margin:0}#monerospace-migration strong{font-weight:600;color:#fff}#monerospace-migration .migration-actions{display:flex;align-items:center;gap:10px 18px;flex-wrap:wrap}#monerospace-migration a,#monerospace-migration button{font:inherit;color:#ffae6a;text-decoration:none;cursor:pointer}#monerospace-migration a:hover{text-decoration:underline}#monerospace-migration button{border:1px solid #8a5630;border-radius:4px;background:#2c1d12;padding:4px 10px}#monerospace-migration :focus-visible{outline:2px solid #ffae6a;outline-offset:4px}@media(max-width:600px){#monerospace-migration{padding:10px 16px;justify-content:flex-start;gap:7px}#monerospace-migration .migration-actions{gap:8px 14px}}';
    document.head.append(style);
    const text = document.createElement('p');
    const actions = document.createElement('div'); actions.className = 'migration-actions';
    const button = (label, action) => { const el=document.createElement('button');el.type='button';el.textContent=label;el.onclick=action;actions.append(el);return el; };
    const anchor = (label, destination, onClick) => { const el=document.createElement('a');el.textContent=label;el.href=destination();for (const event of ['pointerdown','focus','contextmenu']) el.addEventListener(event,()=>{el.href=destination();});el.addEventListener('click',()=>{el.href=destination();onClick?.();});el.addEventListener('auxclick',()=>{el.href=destination();onClick?.();});actions.append(el);return el; };
    if (role === 'source') {
      text.innerHTML = '<strong>MoneroSpace’s next chapter is xmr.tx.taxi.</strong> Familiar Monero explorer, now part of tx.taxi.';
      const tryLink=anchor('Continue on XMR Taxi →',()=>toTaxi(),()=>metric('try_click'));
      const refresh = () => { tryLink.textContent = supported(location.pathname) && !/^\/(?:[a-z]{2}\/?)?$/.test(location.pathname) ? 'Open this page on XMR Taxi →' : 'Try XMR Taxi →'; };
      refresh(); window.addEventListener('popstate',refresh);
      // Angular pushState navigations update the visible CTA without changing its destination until clicked.
      const observer = new MutationObserver(refresh); observer.observe(document.querySelector('app-root') || document.body,{childList:true,subtree:true});
      if (confirmEnable) button('Use XMR Taxi by default',()=>{if(!rememberDefault()){text.textContent='Your browser cannot save this preference. You can still open XMR Taxi.';}});
      if (storageFailed) text.textContent='Your browser cannot save preferences. You can still open XMR Taxi.';
      metric('announcement_view');
    } else {
      text.innerHTML = '<strong>From the team behind MoneroSpace.</strong> Welcome to XMR Taxi.';
      if (enabled) text.textContent = 'XMR Taxi is now your default explorer. You can switch back anytime.';
      else button('Use XMR Taxi by default',()=>{
        let saved; try { saved=JSON.parse(read('sessionStorage',nonceKey)); } catch {}
        location.href=link(source,{mode:'enable',nonce:saved?.nonce || crypto.randomUUID(),p:prefs()});
      });
      anchor('Back to MoneroSpace',()=>link(source,{mode:'back',nonce:crypto.randomUUID(),p:prefs()}));
      const today = new Date().toISOString().slice(0,10);
      const lastVisit = read('localStorage','xmr-taxi-return-day-v1');
      // Count at most one returning browser-day; a same-day page load is not retention.
      if (lastVisit && lastVisit !== today) metric('return_visit');
      write('localStorage','xmr-taxi-return-day-v1',today);
    }
    banner.append(text,actions); document.body.prepend(banner);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',mount,{once:true}); else mount();
})();
