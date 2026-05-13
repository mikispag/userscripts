// ==UserScript==
// @name         Monerio + Rabattcorner + iGraal Cashback
// @namespace    https://github.com/mikispag/userscripts/
// @version      0.1.3
// @description  Shows Monerio, Rabattcorner, and iGraal cashback on supported stores, with one-click affiliate activation links and coupon codes. Highlights the best offer when multiple providers cover the same shop.
// @author       Michele Spagnuolo (miki.it)
// @license      MIT
// @homepageURL  https://github.com/mikispag/userscripts/
// @supportURL   https://github.com/mikispag/userscripts/issues
// @match        https://*/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.monerio.ch
// @connect      www.rabattcorner.ch
// @connect      graphql-router-public-euc1.foundation.gsg.direct
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ====== Shared config ======
  const SUPPORTED_LANGS = ['de', 'en', 'fr', 'it'];
  const LANG = (() => {
    const code = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return SUPPORTED_LANGS.includes(code) ? code : 'en';
  })();
  const EXCLUDED_HOST = /(^|\.)(monerio\.ch|rabattcorner\.ch|igraal\.com|igraal\.pl|twitter\.com|x\.com|whatsapp\.com|google\.[a-z.]+)$/i;
  const STORES_TTL_MS      = 6  * 60 * 60 * 1000;
  const COUPONS_TTL_MS     = 24 * 60 * 60 * 1000;
  const EXSETTINGS_TTL_MS  = 24 * 60 * 60 * 1000;
  const HIDE_TTL_MS        = 24 * 60 * 60 * 1000;
  // iGraal does host->retailer lookups via per-page GraphQL calls, so caching is
  // a privacy lever as well as a perf one. The retailer↔domain mapping basically
  // never changes; catalog growth is slow (~tens of retailers/month). Use long TTLs.
  const IG_MATCH_POS_TTL_MS = 14 * 24 * 60 * 60 * 1000;   // 14 days for known retailers
  const IG_MATCH_NEG_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days for hosts not on iGraal

  const MN = { id: 'monerio',      label: 'Monerio',      color: '#0a7d2c' };
  const RC = { id: 'rabattcorner', label: 'Rabattcorner', color: '#e6007e' };
  const IG = { id: 'igraal',       label: 'iGraal',       color: '#5b21b6' };

  // ====== Monerio config ======
  const MN_API = 'https://api.monerio.ch';
  const MN_APP = 'https://monerio.ch';
  const MN_DOMAIN_OVERRIDES = {
    'swiss.com':  'artefact.com',  // SWISS International Air Lines (placeholder key in catalog)
    'mcafee.com': 'macafee.com',   // McAfee (typo in catalog key)
  };

  // ====== Rabattcorner config ======
  const RC_API = 'https://www.rabattcorner.ch';

  // ====== iGraal config ======
  // GraphQL Federation gateway shared with other Global Savings Group properties.
  // The extension hits this from every page; we mirror that with per-host caching.
  // PRIVACY: each unique host visit sends a GraphQL request to iGraal (same as their
  // official extension). Negative results are cached for 24h so the request is
  // amortized.
  const IG_GQL = 'https://graphql-router-public-euc1.foundation.gsg.direct/';
  // Per-locale Apollo clientId + image/landing host. Pulled verbatim from the
  // browser extension bundle (background.bundle.js, `gql:{de:{clientId:...}}`).
  const IG_CLIENTS = {
    fr: 'a444a51901d85f3d9eb84ada70cef7f3',
    de: 'c235ee8b371f4e8b8e392330ea359875',
    es: 'ff880fb8a999463b9a7c952eeac263ca',
    pl: 'f9f4557825c74791ac01dc5c72ef7aef',
  };
  const IG_HOST = { fr: 'fr.igraal.com', de: 'de.igraal.com', es: 'es.igraal.com', pl: 'igraal.pl' };
  // Per-locale account currency symbol for FIXED_NUMBER cashback amounts.
  // iGraal accounts are denominated by country: EUR for fr/de/es, PLN for pl.
  const IG_CURRENCY = { fr: '€', de: '€', es: '€', pl: 'zł' };
  // No CH/EN/IT locale in iGraal; map: de→de, everything else (fr/it/en/...)→fr (broadest catalog).
  const IG_COUNTRY = (LANG === 'de') ? 'de' : 'fr';
  const IG_CLIENT  = IG_CLIENTS[IG_COUNTRY];
  const IG_HOST_BASE = `https://${IG_HOST[IG_COUNTRY]}`;
  const IG_CURRENCY_SYMBOL = IG_CURRENCY[IG_COUNTRY] || '€';

  // ====== Network ======
  const gmFetch = (url, opts = {}) => new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: opts.method || 'GET',
      url,
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', ...(opts.headers || {}) },
      data: opts.body,
      onload: r => {
        if (r.status < 200 || r.status >= 300) { reject(new Error(`HTTP ${r.status} from ${url}`)); return; }
        try { resolve(JSON.parse(r.responseText)); }
        catch (e) { reject(new Error('Bad JSON from ' + url)); }
      },
      onerror: () => reject(new Error('Network error: ' + url)),
      ontimeout: () => reject(new Error('Timeout: ' + url)),
    });
  });

  // ====== Domain / URL helpers ======
  // Mirrors Rabattcorner's own normalizer: strips common load-balancer prefixes.
  const STRIP_WWW_LIKE = /^(www|www1|www2|ww11|ww30)\./i;
  function stripWwwLike(s) { return String(s || '').toLowerCase().trim().replace(STRIP_WWW_LIKE, ''); }

  function normalizeDomain(key) {
    let s = String(key || '').toLowerCase().trim();
    s = s.replace(/^https?:\/\//, '');
    const slash = s.indexOf('/');
    if (slash >= 0) s = s.slice(0, slash);
    return s;
  }

  // Block non-http(s) URLs (defensive: catalog feeds are third-party JSON).
  function safeUrl(s) {
    if (!s) return '';
    try {
      const u = new URL(s, location.href);
      return /^https?:$/.test(u.protocol) ? u.href : '';
    } catch { return ''; }
  }

  // eTLD+1 extraction with a small allowlist for two-part suffixes. Matches what
  // iGraal's extension does (PSL-based eTLD+1), so we send the same number of
  // GraphQL requests per page as the extension instead of fan-out parent-walking.
  const TWO_PART_SUFFIXES = new Set([
    'co.uk','co.jp','co.nz','co.in','co.za','co.kr','co.il',
    'com.au','com.br','com.mx','com.cn','com.tr','com.ar','com.sg','com.hk','com.tw',
    'org.uk','gov.uk','ac.uk','me.uk','net.uk',
    'ne.jp','or.jp','ac.jp',
  ]);
  function registrableDomain(hostname) {
    const stripped = stripWwwLike(hostname);
    const parts = stripped.split('.');
    if (parts.length <= 2) return stripped;
    const last2 = parts.slice(-2).join('.');
    if (TWO_PART_SUFFIXES.has(last2)) return parts.slice(-3).join('.');
    return parts.slice(-2).join('.');
  }

  // ====== Monerio: stores ======
  function normalizeMnStores(raw) {
    const out = {};
    for (const k of Object.keys(raw)) {
      const nk = normalizeDomain(k);
      if (nk && !out[nk]) out[nk] = raw[k];
    }
    return out;
  }

  async function loadMnStores() {
    const raw = GM_getValue('monerio_stores', null);
    const cached = raw ? JSON.parse(raw) : null;
    if (cached && Date.now() - cached.t < STORES_TTL_MS) return cached.d;
    const r = await gmFetch(`${MN_API}/public/exStores?locale=${LANG}`);
    if (r && r.success && r.data) {
      const normalized = normalizeMnStores(r.data);
      GM_setValue('monerio_stores', JSON.stringify({ t: Date.now(), d: normalized }));
      return normalized;
    }
    throw new Error('Empty or unsuccessful exStores response');
  }

  function findMnStore(stores, hostname) {
    const host = hostname.toLowerCase();
    const stripped = host.replace(/^www\./, '');
    for (const k of [host, stripped]) {
      const target = MN_DOMAIN_OVERRIDES[k];
      if (target && stores[target]) return stores[target];
    }
    for (const k of [host, stripped, 'www.' + stripped]) if (stores[k]) return stores[k];
    const parts = stripped.split('.');
    while (parts.length > 2) {
      parts.shift();
      const parent = parts.join('.');
      if (stores[parent]) return stores[parent];
      if (stores['www.' + parent]) return stores['www.' + parent];
    }
    return null;
  }

  async function loadMnExSettings() {
    const raw = GM_getValue('monerio_settings', null);
    const cached = raw ? JSON.parse(raw) : null;
    if (cached && Date.now() - cached.t < EXSETTINGS_TTL_MS) return cached.d;
    try {
      const r = await gmFetch(`${MN_API}/public/exSettings`);
      if (r && r.success && r.data) {
        GM_setValue('monerio_settings', JSON.stringify({ t: Date.now(), d: r.data }));
        return r.data;
      }
    } catch (_) {}
    return (cached && cached.d) || {};
  }

  async function mnHasAffParams() {
    const s = await loadMnExSettings();
    const params = String(s.aff_link_params || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!params.length) return false;
    // Name-equality, NOT substring (the extension does substring → false positives on every ?utm_*).
    const qp = new URLSearchParams(location.search);
    return params.some(p => qp.has(p));
  }

  async function fetchMnCoupons(storeId) {
    const key = 'monerio_coupons_' + storeId;
    const raw = GM_getValue(key, null);
    const cached = raw ? JSON.parse(raw) : null;
    if (cached && Date.now() - cached.t < COUPONS_TTL_MS) return cached.d;
    const r = await gmFetch(`${MN_API}/public/coupons`, {
      method: 'POST',
      body: JSON.stringify({ cat: [], order: 'latest', page: 1, show: 'all', perPage: 100, store: [storeId] }),
    });
    const coupons = (r && r.data && r.data.coupons) || [];
    GM_setValue(key, JSON.stringify({ t: Date.now(), d: coupons }));
    return coupons;
  }

  function mnCashbackText(store) {
    const langs = store.cashback_string_langs || {};
    return (langs[LANG] || store.cashback_string || '')
      .replace(/^\+\s*/, '')
      .replace(/\s*mit\s*$|\s*with\s*$|\s*avec\s*$|\s*con\s*$/i, '');
  }

  // Locale-less path verified against production: /de|en|fr|it/out/store/{id} all return 404.
  function mnOutUrl(store) { return `${MN_APP}/out/store/${store.id}`; }

  function parseMnRate(store) {
    if (!store) return null;
    const v = parseFloat(store.cashback_amount);
    if (!isFinite(v) || v <= 0) return null;
    if (store.amount_type === 'percent') return { kind: 'percent', value: v };
    if (store.amount_type === 'fixed')   return { kind: 'fixed',   value: v };
    return null;
  }

  // ====== Rabattcorner: partners ======
  function normalizeRcPartners(raw) {
    const list = [];
    for (const pid of Object.keys(raw)) {
      const p = raw[pid] || {};
      const dom = stripWwwLike(normalizeDomain(p.websiteUrl));
      // Skip catalog placeholders like "kein ADDON gewünscht" (no-tracking partners).
      if (!dom || dom.indexOf(' ') >= 0 || dom.indexOf('.') < 0) continue;
      list.push(Object.assign({}, p, { partner_id: pid, websiteUrl: dom }));
    }
    return list;
  }

  async function loadRcPartners() {
    const raw = GM_getValue('rc_partners', null);
    const cached = raw ? JSON.parse(raw) : null;
    if (cached && Date.now() - cached.t < STORES_TTL_MS) return cached.d;
    const r = await gmFetch(`${RC_API}/browserplugin3/partner.json`);
    if (r && typeof r === 'object') {
      const list = normalizeRcPartners(r);
      GM_setValue('rc_partners', JSON.stringify({ t: Date.now(), d: list }));
      return list;
    }
    throw new Error('Empty partner.json response');
  }

  function findRcPartner(partners, hostname) {
    const host = stripWwwLike(hostname);
    for (const p of partners) {
      const w = p.websiteUrl;
      if (host === w || host.endsWith('.' + w)) return p;
    }
    return null;
  }

  async function fetchRcVouchers(partner) {
    if (!partner.vouchers) return [];
    const key = 'rc_vouchers_' + partner.partner_id;
    const raw = GM_getValue(key, null);
    const cached = raw ? JSON.parse(raw) : null;
    if (cached && Date.now() - cached.t < COUPONS_TTL_MS) return cached.d;
    const r = await gmFetch(`${RC_API}/${LANG}/api/vouchers/${partner.partner_id}`);
    const data = (r && r.success && Array.isArray(r.data)) ? r.data : [];
    GM_setValue(key, JSON.stringify({ t: Date.now(), d: data }));
    return data;
  }

  function rcCashbackText(partner) {
    const rate = (partner.comission || partner.lowestCommission || '').trim();
    if (!rate) return '';
    const prefix = partner.multiplerates ? 'Up to ' : '';
    return `${prefix}${rate} cashback`;
  }

  // NOTE: With multiplerates, partner.comission is the *headline* (highest) rate. The
  // best-deal comparison uses this headline rate by design; if both providers list
  // tiered rates, the comparison favors whichever advertises a higher ceiling.

  function rcOutUrl(partner) {
    if (!partner.rcTrackingUrl) return RC_API;
    return RC_API + partner.rcTrackingUrl;
  }

  function parseRcRate(partner) {
    if (!partner) return null;
    const s = (partner.comission || partner.lowestCommission || '').trim();
    if (!s) return null;
    const pct = /^([\d.]+)\s*%$/.exec(s);
    if (pct) return { kind: 'percent', value: parseFloat(pct[1]) };
    const chf = /CHF\s*([\d.]+)/i.exec(s);
    if (chf) return { kind: 'fixed', value: parseFloat(chf[1]) };
    return null;
  }

  // ====== iGraal: GraphQL ======
  const IG_Q_RETAILERS = `
    query RetailersByFilter($input: SearchRetailersInput) {
      retailersByFilter(input: $input) {
        retailers {
          data {
            retailer {
              country merchantUrl name idPool isPublished isShownInExtension
              logo logoBackgroundColor qualityPos
            }
          }
        }
      }
    }`;
  const IG_Q_CASHBACK = `
    query ActiveCashbackWithMaxCommission($criteria: CashbackRetailerPoolIdInput) {
      activeCashbackWithMaxCommission(criteria: $criteria) {
        data {
          retailer {
            name idPool
            activeCashback {
              data {
                maxCommission { type value }
                offers { cashbackDisplayText outgoingAmount { type value } }
              }
            }
            landingPage { url }
          }
        }
      }
    }`;
  const IG_Q_OFFERS = `
    query offersByFilter($input: SearchOffersInput) {
      offersByFilter(input: $input) {
        offers {
          data {
            voucher {
              code caption1 description title termsAndConditions
              endTime startTime voucherTypeName country
            }
          }
        }
      }
    }`;

  async function igGql(query, variables) {
    const r = await gmFetch(IG_GQL, {
      method: 'POST',
      headers: { 'apollographql-client-name': 'browser-extension' },
      body: JSON.stringify({ query, variables }),
    });
    if (r && Array.isArray(r.errors) && r.errors.length) {
      throw new Error(r.errors[0].message || 'GraphQL error');
    }
    return r && r.data;
  }

  async function igLookupByUrl(url) {
    const data = await igGql(IG_Q_RETAILERS, {
      input: {
        country: IG_COUNTRY,
        filter: { url, published: true },
        idClient: IG_CLIENT,
        page: 1,
        size: 50,   // extension uses 100; 50 is plenty headroom for single-domain queries
      },
    });
    const hits = (data && data.retailersByFilter && data.retailersByFilter.retailers
                 && data.retailersByFilter.retailers.data) || [];
    // Collect all verified hits, then prefer the one whose country matches the
    // chosen IG_COUNTRY (e.g. multiple regional L'Occitane retailers: pick FR over BE).
    const verified = [];
    for (const h of hits) {
      const r = h.retailer;
      if (!r || !r.isPublished || !r.isShownInExtension) continue;
      let mHost = '';
      try { mHost = stripWwwLike(new URL(r.merchantUrl).hostname); }
      catch { mHost = stripWwwLike(String(r.merchantUrl || '')); }
      if (mHost === url || mHost.endsWith('.' + url) || url.endsWith('.' + mHost)) verified.push(r);
    }
    if (!verified.length) return null;
    // Prefer retailer in IG_COUNTRY, then lowest qualityPos (iGraal's editorial
    // ranking; lower = more prominent). Handles e.g. loccitane.com returning
    // both be.loccitane.com and fr.loccitane.com from the FR catalog.
    verified.sort((a, b) => {
      const ac = a.country === IG_COUNTRY ? 0 : 1;
      const bc = b.country === IG_COUNTRY ? 0 : 1;
      if (ac !== bc) return ac - bc;
      return (a.qualityPos ?? 9999) - (b.qualityPos ?? 9999);
    });
    return verified[0];
  }

  async function findIgRetailer(hostname) {
    // Query the eTLD+1 once (matching the extension), not host/parents one by one.
    // The strict post-filter inside igLookupByUrl rejects unrelated server hits.
    const lookupHost = registrableDomain(hostname);
    const cacheKey = `igraal_match_${IG_COUNTRY}_${lookupHost}`;
    const raw = GM_getValue(cacheKey, null);
    const cached = raw ? JSON.parse(raw) : null;
    if (cached) {
      const ttl = cached.r ? IG_MATCH_POS_TTL_MS : IG_MATCH_NEG_TTL_MS;
      if (Date.now() - cached.t < ttl) return cached.r;
    }
    const found = await igLookupByUrl(lookupHost);
    GM_setValue(cacheKey, JSON.stringify({ t: Date.now(), r: found }));
    return found;
  }

  async function fetchIgCashback(retailer) {
    const cacheKey = `igraal_cb_${IG_COUNTRY}_${retailer.idPool}`;
    const raw = GM_getValue(cacheKey, null);
    const cached = raw ? JSON.parse(raw) : null;
    if (cached && Date.now() - cached.t < COUPONS_TTL_MS) return cached.d;
    const data = await igGql(IG_Q_CASHBACK, { criteria: { idClient: IG_CLIENT, idPool: retailer.idPool } });
    const result = (data && data.activeCashbackWithMaxCommission && data.activeCashbackWithMaxCommission.data) || null;
    GM_setValue(cacheKey, JSON.stringify({ t: Date.now(), d: result }));
    return result;
  }

  // Client-side validity filter mirroring the extension's isValidVoucher.
  // Drops expired offers and Code-type vouchers whose code contains whitespace
  // (server-side data bug that occasionally leaks past voucherSubset:'ACTIVE').
  function isValidIgVoucher(v) {
    if (!v) return false;
    const now = Date.now();
    if (v.startTime && new Date(v.startTime).getTime() > now) return false;
    if (v.endTime   && new Date(v.endTime).getTime()   < now) return false;
    if (v.code && /\s/.test(v.code)) return false;
    return true;
  }

  async function fetchIgCoupons(retailer) {
    const cacheKey = `igraal_offers_${IG_COUNTRY}_${retailer.idPool}`;
    const raw = GM_getValue(cacheKey, null);
    const cached = raw ? JSON.parse(raw) : null;
    if (cached && Date.now() - cached.t < COUPONS_TTL_MS) return cached.d;
    try {
      const data = await igGql(IG_Q_OFFERS, {
        input: {
          country: IG_COUNTRY,
          filter: { idRetailer: retailer.idPool, published: true, voucherSubset: 'ACTIVE' },
          idClient: IG_CLIENT,
          page: 1,
          size: 50,
          sort: [{ direction: 'desc', field: 'amountScore' }],
        },
      });
      const data2 = data && data.offersByFilter && data.offersByFilter.offers && data.offersByFilter.offers.data;
      const coupons = (data2 || []).map(o => o.voucher).filter(isValidIgVoucher);
      GM_setValue(cacheKey, JSON.stringify({ t: Date.now(), d: coupons }));
      return coupons;
    } catch (_) { return []; }
  }

  function igCashbackText(cb) {
    const data = cb && cb.retailer && cb.retailer.activeCashback && cb.retailer.activeCashback.data;
    if (!data) return '';
    const offers = data.offers || [];
    const mc = data.maxCommission;
    const top = mc ? offers.find(o => o.outgoingAmount &&
                                      o.outgoingAmount.value === mc.value &&
                                      o.outgoingAmount.type === mc.type) : null;
    if (top && top.cashbackDisplayText) {
      return offers.length > 1 ? `Up to ${top.cashbackDisplayText}` : top.cashbackDisplayText;
    }
    if (mc && mc.value != null) {
      return mc.type === 'PERCENTAGE'
        ? `Up to ${mc.value}% cashback`
        : `Up to ${IG_CURRENCY_SYMBOL}${mc.value} cashback`;
    }
    return '';
  }

  function igLogoUrl(retailer) {
    const p = retailer && retailer.logo;
    if (!p) return '';
    const path = p.startsWith('/') ? p : '/' + p;
    return `${IG_HOST_BASE}/images/180x${path}`;
  }

  function igOutUrl(cb) {
    const lp = cb && cb.retailer && cb.retailer.landingPage && cb.retailer.landingPage.url;
    if (!lp) return IG_HOST_BASE;
    if (/^https?:\/\//i.test(lp)) return lp;
    return `${IG_HOST_BASE}/${lp.replace(/^\//, '')}`;
  }

  function parseIgRate(cb) {
    const mc = cb && cb.retailer && cb.retailer.activeCashback
            && cb.retailer.activeCashback.data && cb.retailer.activeCashback.data.maxCommission;
    if (!mc) return null;
    const v = parseFloat(mc.value);
    if (!isFinite(v) || v <= 0) return null;
    if (mc.type === 'PERCENTAGE')   return { kind: 'percent', value: v };
    if (mc.type === 'FIXED_NUMBER') return { kind: 'fixed',   value: v };
    return null;
  }

  // ====== Best-offer picking ======
  // Returns the single match object with the strictly-highest rate across all
  // provided matches. Returns null when:
  //   - Fewer than 2 rated matches (nothing to compare).
  //   - Rate units mismatch (percent vs CHF — incomparable without basket size).
  //   - Multiple matches share the top value (a tie — show all without a "Best" badge).
  function pickBestMatch(matches) {
    const rated = matches.filter(m => m.rate);
    if (rated.length < 2) return null;
    const kinds = new Set(rated.map(m => m.rate.kind));
    if (kinds.size > 1) return null;
    const maxV = Math.max(...rated.map(m => m.rate.value));
    const top = rated.filter(m => m.rate.value === maxV);
    return top.length === 1 ? top[0] : null;
  }

  // ====== Rendering ======
  function injectStyles() {
    if (document.getElementById('mn-style')) return;
    const css = `
      #mn-stack { position: fixed; top: 16px; right: 16px; z-index: 2147483647;
        display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
      #mn-stack > * { pointer-events: auto; }
      .mn-card { background:#fff; color:#111;
        font:13px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;
        border:1px solid #e5e7eb; border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,.15);
        width:288px; padding:12px 14px 14px; position:relative; }
      .mn-card.mn-best { border:2px solid #f59e0b; box-shadow:0 12px 36px rgba(245,158,11,.30); }
      .mn-chips { display:flex; align-items:center; gap:6px; margin-bottom:6px; }
      .mn-chip { display:inline-block; font-size:10px; font-weight:700; text-transform:uppercase;
        letter-spacing:.04em; padding:2px 7px; border-radius:999px; color:#fff; }
      .mn-chip.mn-best-chip { background:#f59e0b; color:#fff;
        display:inline-flex; align-items:center; gap:3px; }
      .mn-row { display:flex; align-items:center; gap:10px; }
      .mn-logo { width:32px;height:32px;object-fit:contain;border-radius:6px;background:#fafafa; }
      .mn-title { font-weight:600; font-size:14px; }
      .mn-sub { color:#6b7280; font-size:11px; }
      .mn-cb { font-weight:700; margin:8px 0 10px; font-size:14px; }
      .mn-card.mn-best .mn-cb { font-size:16px; }
      .mn-btn { display:block; text-align:center; padding:9px 12px; color:#fff !important;
        text-decoration:none; border-radius:8px; font-weight:600; }
      .mn-btn:hover { filter:brightness(0.92); }
      .mn-note { margin-top:8px; padding:6px 8px; border-radius:6px; font-size:11px;
        background:#ecfdf5; color:#065f46; border:1px solid #a7f3d0; }
      .mn-err { margin-top:6px; padding:8px 10px; border-radius:6px; font-size:12px;
        background:#fef2f2; color:#991b1b; border:1px solid #fecaca; }
      .mn-err-msg { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px; margin-top:4px; word-break:break-word; }
      .mn-x { position:absolute; top:6px; right:8px; cursor:pointer; opacity:.5;
        background:none; border:0; font-size:18px; line-height:1; padding:2px 6px; }
      .mn-x:hover { opacity:1; }
      .mn-toggle { background:none; border:0; cursor:pointer; font-weight:600;
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

  function ensureStack() {
    let stack = document.getElementById('mn-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'mn-stack';
      document.body.appendChild(stack);
    }
    return stack;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function renderMatch(spec) {
    injectStyles();
    const stack = ensureStack();
    const el = document.createElement('div');
    el.className = 'mn-card' + (spec.isBest ? ' mn-best' : '');
    el.dataset.provider = spec.provider.id;
    const logo = safeUrl(spec.logo);
    const out  = safeUrl(spec.outUrl);
    el.innerHTML = `
      <button class="mn-x" title="Hide for today" aria-label="Close">×</button>
      <div class="mn-chips">
        <span class="mn-chip" style="background:${spec.provider.color}">${escapeHtml(spec.provider.label)}</span>
        ${spec.isBest ? `<span class="mn-chip mn-best-chip" title="Highest cashback among matching providers">★ Best deal</span>` : ''}
      </div>
      <div class="mn-row">
        ${logo ? `<img class="mn-logo" src="${escapeAttr(logo)}" alt="">` : ''}
        <div>
          <div class="mn-title">${escapeHtml(spec.name)}</div>
          <div class="mn-sub">Cashback available</div>
        </div>
      </div>
      <div class="mn-cb" style="color:${spec.provider.color}">${escapeHtml(spec.cashbackText)}</div>
      ${spec.alreadyActivated
        ? `<div class="mn-note">✓ Already on an affiliate link &mdash; cashback should track.</div>`
        : (out ? `<a class="mn-btn" style="background:${spec.provider.color}" href="${escapeAttr(out)}" target="_blank" rel="noopener">Activate cashback</a>` : '')}
      ${spec.coupons.length ? `<button class="mn-toggle" style="color:${spec.provider.color}">Show ${spec.coupons.length} coupon${spec.coupons.length > 1 ? 's' : ''}</button>` : ''}
      <div class="mn-cp"></div>
    `;
    stack.appendChild(el);

    el.querySelector('.mn-x').addEventListener('click', () => {
      GM_setValue(spec.hideKey, Date.now());
      el.remove();
    });

    const toggle = el.querySelector('.mn-toggle');
    const list = el.querySelector('.mn-cp');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const open = list.style.display !== 'block';
        if (open && !list.dataset.filled) {
          list.innerHTML = spec.coupons.map(c => {
            const title = c[spec.couponMap.title];
            const desc  = c[spec.couponMap.description];
            const code  = c[spec.couponMap.code];
            return `
              <div class="mn-cp-item">
                <div class="mn-cp-title">${escapeHtml(title || 'Offer')}</div>
                ${desc ? `<div class="mn-cp-desc">${escapeHtml(desc)}</div>` : ''}
                ${code
                  ? `<span class="mn-code" data-code="${escapeAttr(code)}" title="Click to copy">${escapeHtml(code)}</span>`
                  : `<div class="mn-nocode">No code needed</div>`}
              </div>`;
          }).join('');
          list.querySelectorAll('.mn-code').forEach(s => {
            s.addEventListener('click', () => {
              const txt = s.dataset.code;
              const p = (navigator.clipboard && navigator.clipboard.writeText)
                ? navigator.clipboard.writeText(txt)
                : Promise.reject(new Error('clipboard unavailable'));
              p.then(() => {
                s.classList.add('copied');
                const orig = s.textContent;
                s.textContent = 'Copied!';
                setTimeout(() => { s.classList.remove('copied'); s.textContent = orig; }, 1200);
              }).catch(() => {
                s.classList.add('copied');
                const orig = s.textContent;
                s.textContent = 'Copy failed';
                setTimeout(() => { s.classList.remove('copied'); s.textContent = orig; }, 1500);
              });
            });
          });
          list.dataset.filled = '1';
        }
        list.style.display = open ? 'block' : 'none';
        toggle.textContent = open
          ? 'Hide coupons'
          : `Show ${spec.coupons.length} coupon${spec.coupons.length > 1 ? 's' : ''}`;
      });
    }
  }

  function renderError(provider, message) {
    injectStyles();
    const stack = ensureStack();
    const el = document.createElement('div');
    el.className = 'mn-card';
    el.dataset.provider = provider.id;
    el.innerHTML = `
      <button class="mn-x" title="Dismiss" aria-label="Close">×</button>
      <div class="mn-chips">
        <span class="mn-chip" style="background:${provider.color}">${escapeHtml(provider.label)}</span>
      </div>
      <div class="mn-err">
        <strong>Couldn't load cashback data</strong>
        <div class="mn-err-msg">${escapeHtml(message)}</div>
      </div>
    `;
    stack.appendChild(el);
    el.querySelector('.mn-x').addEventListener('click', () => el.remove());
  }

  // ====== Provider runners ======
  async function runMonerio() {
    try {
      const stores = await loadMnStores();
      const store = findMnStore(stores, location.hostname);
      if (!store || !store.cashback_enabled) return { kind: 'none' };
      const hideKey = 'mn_hide_' + store.id;
      const hiddenAt = Number(GM_getValue(hideKey, 0));
      if (hiddenAt && Date.now() - hiddenAt < HIDE_TTL_MS) return { kind: 'none' };
      const [coupons, alreadyActivated] = await Promise.all([
        fetchMnCoupons(store.id).catch(() => []),
        mnHasAffParams().catch(() => false),
      ]);
      return {
        kind: 'match',
        provider: MN,
        rate: parseMnRate(store),
        spec: {
          provider: MN,
          name: store.name,
          logo: store.logo || null,
          cashbackText: mnCashbackText(store),
          outUrl: mnOutUrl(store),
          coupons,
          alreadyActivated,
          hideKey,
          couponMap: { title: 'title', description: 'description', code: 'code' },
        },
      };
    } catch (e) {
      return { kind: 'error', provider: MN, message: (e && e.message) || String(e) };
    }
  }

  async function runRabattcorner() {
    try {
      const partners = await loadRcPartners();
      const partner = findRcPartner(partners, location.hostname);
      if (!partner) return { kind: 'none' };
      const hideKey = 'rc_hide_' + partner.partner_id;
      const hiddenAt = Number(GM_getValue(hideKey, 0));
      if (hiddenAt && Date.now() - hiddenAt < HIDE_TTL_MS) return { kind: 'none' };
      const coupons = await fetchRcVouchers(partner).catch(() => []);
      return {
        kind: 'match',
        provider: RC,
        rate: parseRcRate(partner),
        spec: {
          provider: RC,
          name: partner.name,
          logo: null,
          cashbackText: rcCashbackText(partner),
          outUrl: rcOutUrl(partner),
          coupons,
          alreadyActivated: false,
          hideKey,
          couponMap: { title: 'title', description: 'description', code: 'code' },
        },
      };
    } catch (e) {
      return { kind: 'error', provider: RC, message: (e && e.message) || String(e) };
    }
  }

  async function runIgraal() {
    try {
      const retailer = await findIgRetailer(location.hostname);
      if (!retailer) return { kind: 'none' };
      const hideKey = 'ig_hide_' + retailer.idPool;
      const hiddenAt = Number(GM_getValue(hideKey, 0));
      if (hiddenAt && Date.now() - hiddenAt < HIDE_TTL_MS) return { kind: 'none' };
      const cb = await fetchIgCashback(retailer).catch(() => null);
      // Bail when no active campaign. iGraal returns `cb.retailer` with
      // `activeCashback.data === null` between campaigns; the extension throws
      // "No cashback available" in exactly this case. Without this check, the
      // banner would render with empty cashbackText and a broken activate link.
      if (!cb || !cb.retailer || !cb.retailer.activeCashback || !cb.retailer.activeCashback.data) {
        return { kind: 'none' };
      }
      const coupons = await fetchIgCoupons(retailer).catch(() => []);
      return {
        kind: 'match',
        provider: IG,
        rate: parseIgRate(cb),
        spec: {
          provider: IG,
          name: (cb.retailer && cb.retailer.name) || retailer.name,
          logo: igLogoUrl(retailer),
          cashbackText: igCashbackText(cb),
          outUrl: igOutUrl(cb),
          coupons,
          alreadyActivated: false,
          hideKey,
          // iGraal voucher field names match the {title, description, code} convention.
          couponMap: { title: 'title', description: 'description', code: 'code' },
        },
      };
    } catch (e) {
      return { kind: 'error', provider: IG, message: (e && e.message) || String(e) };
    }
  }

  // ====== Orchestration ======
  // Monotonic run token: prevents a slow first evaluate() from overwriting a
  // fresh one's render after the user navigated (SPA) to another host mid-await.
  let runId = 0;

  async function evaluate() {
    const myRun = ++runId;
    if (EXCLUDED_HOST.test(location.hostname)) {
      const stack = document.getElementById('mn-stack');
      if (stack) stack.remove();
      return;
    }

    const results = await Promise.all([runMonerio(), runRabattcorner(), runIgraal()]);
    if (myRun !== runId) return;  // a newer evaluate() has started; abandon this one

    const existing = document.getElementById('mn-stack');
    if (existing) existing.innerHTML = '';

    const matches = results.filter(r => r.kind === 'match');
    const errors  = results.filter(r => r.kind === 'error');

    const best = pickBestMatch(matches);
    for (const m of matches) m.spec.isBest = (m === best);

    // Order: best first; other matches in stable provider order; errors last.
    const order = [];
    if (best) order.push(best);
    for (const m of matches) if (m !== best) order.push(m);
    for (const e of errors) order.push(e);

    for (const r of order) {
      if (r.kind === 'match') renderMatch(r.spec);
      else if (r.kind === 'error') renderError(r.provider, r.message);
    }

    if (existing && !existing.children.length) existing.remove();
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
