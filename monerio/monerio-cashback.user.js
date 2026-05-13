// ==UserScript==
// @name         Monerio Cashback Banner
// @namespace    https://monerio.ch/
// @version      0.2.1
// @description  Shows a Monerio cashback banner on any supported store, with a one-click affiliate activation link and available coupon codes.
// @author       Miki
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_cookie
// @connect      api.monerio.ch
// @connect      monerio.ch
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const API = 'https://api.monerio.ch';
  const APP = 'https://monerio.ch';
  const SUPPORTED_LANGS = ['de', 'en', 'fr', 'it'];
  const LANG = (() => {
    const code = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return SUPPORTED_LANGS.includes(code) ? code : 'en';
  })();
  const EXCLUDED_HOST = /(^|\.)(monerio\.ch|twitter\.com|x\.com|whatsapp\.com|google\.[a-z.]+)$/i;
  const STORES_TTL_MS      = 6  * 60 * 60 * 1000;
  const COUPONS_TTL_MS     = 24 * 60 * 60 * 1000;
  const EXSETTINGS_TTL_MS  = 24 * 60 * 60 * 1000;
  const HIDE_TTL_MS        = 24 * 60 * 60 * 1000;

  const gmFetch = (url, opts = {}) => new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: opts.method || 'GET',
      url,
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', ...(opts.headers || {}) },
      data: opts.body,
      onload: r => {
        try { resolve(JSON.parse(r.responseText)); }
        catch (e) { reject(new Error('Bad JSON from ' + url)); }
      },
      onerror: () => reject(new Error('Network error: ' + url)),
      ontimeout: () => reject(new Error('Timeout: ' + url)),
    });
  });

  async function loadStores() {
    const raw = GM_getValue('monerio_stores', null);
    const cached = raw ? JSON.parse(raw) : null;
    if (cached && Date.now() - cached.t < STORES_TTL_MS) return cached.d;
    const r = await gmFetch(`${API}/public/exStores?locale=${LANG}`);
    if (r && r.success && r.data) {
      GM_setValue('monerio_stores', JSON.stringify({ t: Date.now(), d: r.data }));
      return r.data;
    }
    return (cached && cached.d) || {};
  }

  function findStore(stores, hostname) {
    const host = hostname.toLowerCase();
    const stripped = host.replace(/^www\./, '');
    for (const k of [host, stripped, 'www.' + stripped]) if (stores[k]) return stores[k];
    // Walk parent domains (e.g. ch.iherb.com -> iherb.com), but never to a TLD.
    const parts = stripped.split('.');
    while (parts.length > 2) {
      parts.shift();
      const parent = parts.join('.');
      if (stores[parent]) return stores[parent];
      if (stores['www.' + parent]) return stores['www.' + parent];
    }
    return null;
  }

  async function loadExSettings() {
    const raw = GM_getValue('monerio_settings', null);
    const cached = raw ? JSON.parse(raw) : null;
    if (cached && Date.now() - cached.t < EXSETTINGS_TTL_MS) return cached.d;
    try {
      const r = await gmFetch(`${API}/public/exSettings`);
      if (r && r.success && r.data) {
        GM_setValue('monerio_settings', JSON.stringify({ t: Date.now(), d: r.data }));
        return r.data;
      }
    } catch (_) {}
    return (cached && cached.d) || {};
  }

  async function hasAffParams() {
    const s = await loadExSettings();
    const params = String(s.aff_link_params || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!params.length) return false;
    const qs = location.search;
    return params.some(p => qs.includes(p));
  }

  function isLoggedIn() {
    return new Promise(resolve => {
      if (typeof GM_cookie === 'undefined' || !GM_cookie || !GM_cookie.list) { resolve(null); return; }
      try {
        GM_cookie.list({ url: APP, name: 'cry_user_token' }, (cookies, err) => {
          if (err || !cookies || !cookies.length) return resolve(false);
          resolve(Boolean(cookies[0].value));
        });
      } catch (_) { resolve(null); }
    });
  }

  async function fetchCoupons(storeId) {
    const key = 'monerio_coupons_' + storeId;
    const raw = GM_getValue(key, null);
    const cached = raw ? JSON.parse(raw) : null;
    if (cached && Date.now() - cached.t < COUPONS_TTL_MS) return cached.d;
    const r = await gmFetch(`${API}/public/coupons`, {
      method: 'POST',
      body: JSON.stringify({ cat: [], order: 'latest', page: 1, show: 'all', perPage: 100, store: [storeId] }),
    });
    const coupons = (r && r.data && r.data.coupons) || [];
    GM_setValue(key, JSON.stringify({ t: Date.now(), d: coupons }));
    return coupons;
  }

  function cashbackText(store) {
    const langs = store.cashback_string_langs || {};
    return (langs[LANG] || store.cashback_string || '')
      .replace(/^\+\s*/, '')
      .replace(/\s*mit\s*$|\s*with\s*$|\s*avec\s*$|\s*con\s*$/i, '');
  }

  function cashbackWas(store) {
    if (!store.cashback_was) return '';
    const [type, val] = String(store.cashback_was).split('|');
    if (!val) return '';
    return type === 'percent' ? `${val}%` : `CHF ${val}`;
  }

  function outUrl(store) { return `${APP}/${LANG}/out/store/${store.id}`; }

  function injectStyles() {
    if (document.getElementById('mn-style')) return;
    const css = `
      .mn-banner { position: fixed; top: 16px; right: 16px; z-index: 2147483647;
        background:#fff; color:#111; font:13px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;
        border:1px solid #e5e7eb; border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,.15);
        width:288px; padding:12px 14px 14px; }
      .mn-row { display:flex; align-items:center; gap:10px; }
      .mn-logo { width:32px;height:32px;object-fit:contain;border-radius:6px;background:#fafafa; }
      .mn-title { font-weight:600; font-size:14px; }
      .mn-sub { color:#6b7280; font-size:11px; }
      .mn-cb { color:#0a7d2c; font-weight:700; margin:8px 0 10px; font-size:14px; }
      .mn-was { color:#9ca3af; text-decoration:line-through; font-weight:500; margin-left:6px; font-size:12px; }
      .mn-btn { display:block; text-align:center; padding:9px 12px; background:#111; color:#fff !important;
        text-decoration:none; border-radius:8px; font-weight:600; }
      .mn-btn:hover { background:#000; }
      .mn-note { margin-top:8px; padding:6px 8px; border-radius:6px; font-size:11px;
        background:#ecfdf5; color:#065f46; border:1px solid #a7f3d0; }
      .mn-warn { margin-top:8px; padding:6px 8px; border-radius:6px; font-size:11px;
        background:#fffbeb; color:#92400e; border:1px solid #fde68a; }
      .mn-warn a { color:#92400e; font-weight:600; }
      .mn-x { position:absolute; top:6px; right:8px; cursor:pointer; opacity:.5;
        background:none; border:0; font-size:18px; line-height:1; padding:2px 6px; }
      .mn-x:hover { opacity:1; }
      .mn-toggle { background:none; border:0; color:#0a7d2c; cursor:pointer; font-weight:600;
        padding:8px 0 0; font-size:12px; }
      .mn-cp { margin-top:8px; max-height:200px; overflow:auto; border-top:1px solid #eee; padding-top:8px; display:none; }
      .mn-cp-item { padding:6px 0; border-bottom:1px dashed #eee; }
      .mn-cp-item:last-child { border-bottom:0; }
      .mn-cp-title { font-weight:600; font-size:12px; }
      .mn-cp-desc { color:#6b7280; font-size:11px; margin-top:2px; }
      .mn-code { display:inline-block; margin-top:4px; font-family:ui-monospace,Menlo,Consolas,monospace;
        background:#f3f4f6; padding:2px 8px; border-radius:4px; cursor:pointer; font-size:12px; }
      .mn-code:hover { background:#e5e7eb; }
      .mn-code.copied { background:#d1fae5; color:#065f46; }
      .mn-nocode { color:#9ca3af; font-size:11px; margin-top:4px; }
    `;
    const s = document.createElement('style');
    s.id = 'mn-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function render(store, coupons, opts) {
    injectStyles();
    document.querySelectorAll('.mn-banner').forEach(b => b.remove());
    const was = cashbackWas(store);
    const el = document.createElement('div');
    el.className = 'mn-banner';
    el.innerHTML = `
      <button class="mn-x" title="Hide for today" aria-label="Close">×</button>
      <div class="mn-row">
        ${store.logo ? `<img class="mn-logo" src="${store.logo}" alt="">` : ''}
        <div>
          <div class="mn-title">${escapeHtml(store.name)}</div>
          <div class="mn-sub">Monerio cashback available</div>
        </div>
      </div>
      <div class="mn-cb">
        ${escapeHtml(cashbackText(store))}
        ${was ? `<span class="mn-was" title="Previous rate">was ${escapeHtml(was)}</span>` : ''}
      </div>
      ${opts.alreadyActivated
        ? `<div class="mn-note">✓ Already on an affiliate link &mdash; cashback should track.</div>`
        : `<a class="mn-btn" href="${outUrl(store)}" target="_blank" rel="noopener">Activate cashback</a>`}
      ${opts.loggedIn === false
        ? `<div class="mn-warn">Sign in on <a href="${APP}" target="_blank" rel="noopener">monerio.ch</a> first &mdash; cashback only tracks for logged-in users.</div>`
        : ''}
      ${coupons.length ? `<button class="mn-toggle">Show ${coupons.length} coupon${coupons.length > 1 ? 's' : ''}</button>` : ''}
      <div class="mn-cp"></div>
    `;
    document.body.appendChild(el);

    el.querySelector('.mn-x').addEventListener('click', () => {
      GM_setValue('mn_hide_' + store.id, Date.now());
      el.remove();
    });

    const toggle = el.querySelector('.mn-toggle');
    const list = el.querySelector('.mn-cp');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const open = list.style.display !== 'block';
        if (open && !list.dataset.filled) {
          list.innerHTML = coupons.map(c => `
            <div class="mn-cp-item">
              <div class="mn-cp-title">${escapeHtml(c.title || 'Offer')}</div>
              ${c.description ? `<div class="mn-cp-desc">${escapeHtml(c.description)}</div>` : ''}
              ${c.code
                ? `<span class="mn-code" data-code="${escapeAttr(c.code)}" title="Click to copy">${escapeHtml(c.code)}</span>`
                : `<div class="mn-nocode">No code needed</div>`}
            </div>`).join('');
          list.querySelectorAll('.mn-code').forEach(s => {
            s.addEventListener('click', () => {
              navigator.clipboard.writeText(s.dataset.code).then(() => {
                s.classList.add('copied');
                const orig = s.textContent;
                s.textContent = 'Copied!';
                setTimeout(() => { s.classList.remove('copied'); s.textContent = orig; }, 1200);
              });
            });
          });
          list.dataset.filled = '1';
        }
        list.style.display = open ? 'block' : 'none';
        toggle.textContent = open
          ? 'Hide coupons'
          : `Show ${coupons.length} coupon${coupons.length > 1 ? 's' : ''}`;
      });
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  async function evaluate() {
    if (EXCLUDED_HOST.test(location.hostname)) {
      document.querySelectorAll('.mn-banner').forEach(b => b.remove());
      return;
    }
    try {
      const stores = await loadStores();
      const store = findStore(stores, location.hostname);
      if (!store || !store.cashback_enabled) {
        document.querySelectorAll('.mn-banner').forEach(b => b.remove());
        return;
      }
      const hiddenAt = Number(GM_getValue('mn_hide_' + store.id, 0));
      if (hiddenAt && Date.now() - hiddenAt < HIDE_TTL_MS) return;
      const [coupons, alreadyActivated, loggedIn] = await Promise.all([
        fetchCoupons(store.id).catch(() => []),
        hasAffParams().catch(() => false),
        isLoggedIn(),
      ]);
      render(store, coupons, { alreadyActivated, loggedIn });
    } catch (e) {
      console.warn('[Monerio]', e);
    }
  }

  function watchSpaNavigation(onChange) {
    let last = location.href;
    const fire = () => {
      if (location.href === last) return;
      last = location.href;
      onChange();
    };
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        queueMicrotask(fire);
        return r;
      };
    }
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
  }

  evaluate();
  watchSpaNavigation(evaluate);
})();
