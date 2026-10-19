// Image Hunter — content script: page image discovery and deep scanning.
// Injected together with image-utils.js (expects global ImageUtils).
// Results are written to chrome.storage.session under `ih-scan-<tabId>` so
// the popup can read them even if it was closed during a deep scan.
(function () {
  'use strict';
  if (self.ImageHunterScanner) return; // already injected

  const IU = ImageUtils;
  const MAX_RECORDS = 20000;
  const MAX_BG_ELEMENTS = 6000;
  const LAZY_SRC_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-original-src', 'data-full-url', 'data-image'];
  const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset', 'data-original-srcset'];

  const state = {
    deepScanning: false,
    cancelRequested: false,
    observer: null,
    pending: new Set(), // nodes added since last collection pass
    seenNodes: new WeakSet()
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // --- record helpers -------------------------------------------------------

  function mkRecord(url, sourceType, opts = {}) {
    return {
      url,
      sourceType,
      sourceTypes: [sourceType],
      pageUrl: location.href,
      displayWidth: opts.displayWidth || null,
      displayHeight: opts.displayHeight || null,
      naturalWidth: opts.naturalWidth || null,
      naturalHeight: opts.naturalHeight || null,
      status: opts.status || 'unknown',
      candidates: opts.candidates || [],
      filename: IU.baseFilename(url)
    };
  }

  function candidate(url, basis) {
    return { url, basis, inferred: true };
  }

  function imgCandidates(img, baseUrl) {
    const out = [];
    for (const attr of LAZY_SRC_ATTRS) {
      const v = img.getAttribute && img.getAttribute(attr);
      const u = IU.normalizeImageUrl(v, baseUrl);
      if (u && u !== img.__ihUrl) out.push(candidate(u, 'lazy-attribute'));
    }
    for (const attr of LAZY_SRCSET_ATTRS) {
      const best = IU.bestSrcsetEntry(IU.parseSrcset(img.getAttribute(attr), baseUrl));
      if (best && best.url !== img.__ihUrl) out.push(candidate(best.url, 'lazy-srcset'));
    }
    const srcsetBest = IU.bestSrcsetEntry(IU.parseSrcset(img.getAttribute('srcset'), baseUrl));
    if (srcsetBest && srcsetBest.url !== img.__ihUrl) out.push(candidate(srcsetBest.url, 'srcset'));
    // <picture> siblings
    const picture = img.parentNode && img.parentNode.tagName === 'PICTURE' ? img.parentNode : null;
    if (picture) {
      for (const src of picture.querySelectorAll('source')) {
        const best = IU.bestSrcsetEntry(IU.parseSrcset(src.getAttribute('srcset'), baseUrl));
        if (best && best.url !== img.__ihUrl) out.push(candidate(best.url, 'picture'));
      }
    }
    // parent link pointing straight at an image file
    const a = img.closest && img.closest('a[href]');
    if (a) {
      const href = IU.normalizeImageUrl(a.getAttribute('href'), baseUrl);
      if (href && IU.isLikelyImageUrl(href) && href !== img.__ihUrl) out.push(candidate(href, 'anchor'));
    }
    return out;
  }

  function recordFromImg(img) {
    const baseUrl = img.baseURI || location.href;
    const src = img.getAttribute('src') || '';
    let url = IU.normalizeImageUrl(img.currentSrc || src, baseUrl);
    if (!url) {
      for (const attr of LAZY_SRC_ATTRS) {
        url = IU.normalizeImageUrl(img.getAttribute(attr), baseUrl);
        if (url) break;
      }
    }
    if (!url) {
      const best = IU.bestSrcsetEntry(IU.parseSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset'), baseUrl));
      if (best) url = best.url;
    }
    if (!url) return null;
    img.__ihUrl = url;
    const complete = img.complete && img.naturalWidth > 0;
    return mkRecord(url, 'img', {
      displayWidth: img.clientWidth || parseInt(img.getAttribute('width'), 10) || null,
      displayHeight: img.clientHeight || parseInt(img.getAttribute('height'), 10) || null,
      naturalWidth: complete ? img.naturalWidth : null,
      naturalHeight: complete ? img.naturalHeight : null,
      status: complete ? 'loaded' : (src ? 'pending' : 'lazy'),
      candidates: imgCandidates(img, baseUrl)
    });
  }

  // --- DOM traversal (including open shadow roots) ---------------------------

  function* walkElements(root, depth = 0) {
    const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of nodes) {
      yield el;
      if (el.shadowRoot && depth < 6) yield* walkElements(el.shadowRoot, depth + 1);
    }
  }

  function collectDom(root = document, records = []) {
    const scanRoot = (container) => {
      for (const img of container.querySelectorAll('img')) {
        const r = recordFromImg(img);
        if (r) {
          records.push(r);
          // lazy-attribute targets are the real images behind placeholders:
          // record them as first-class entries as well as candidates.
          for (const attr of LAZY_SRC_ATTRS) {
            const u = IU.normalizeImageUrl(img.getAttribute(attr), img.baseURI || location.href);
            if (u && u !== r.url) records.push(mkRecord(u, 'lazy-attribute'));
          }
        }
        if (records.length >= MAX_RECORDS) return records;
      }
      for (const src of container.querySelectorAll('picture source, source')) {
        const best = IU.bestSrcsetEntry(IU.parseSrcset(src.getAttribute('srcset'), location.href));
        if (best) records.push(mkRecord(best.url, 'picture', { candidates: [] }));
      }
      for (const v of container.querySelectorAll('video[poster], audio[poster]')) {
        const u = IU.normalizeImageUrl(v.getAttribute('poster'), location.href);
        if (u) records.push(mkRecord(u, 'poster'));
      }
      for (const i of container.querySelectorAll('input[type="image"][src]')) {
        const u = IU.normalizeImageUrl(i.getAttribute('src'), location.href);
        if (u) records.push(mkRecord(u, 'input-image'));
      }
      for (const m of container.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"], meta[itemprop="image"]')) {
        const u = IU.normalizeImageUrl(m.getAttribute('content'), location.href);
        if (u) records.push(mkRecord(u, 'meta'));
      }
      // Links that point directly at image files (gallery "open original" links).
      for (const a of container.querySelectorAll('a[href]')) {
        const u = IU.normalizeImageUrl(a.getAttribute('href'), location.href);
        if (u && IU.isLikelyImageUrl(u)) records.push(mkRecord(u, 'link', {
          candidates: []
        }));
        if (records.length >= MAX_RECORDS) return records;
      }
    };
    scanRoot(root);
    if (root === document) {
      for (const el of walkElements(document)) {
        if (el.shadowRoot) scanRoot(el.shadowRoot);
      }
    }
    return IU.dedupeRecords(records);
  }

  // --- CSS backgrounds ---------------------------------------------------------

  const URL_FN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

  function urlsFromStyleText(text, baseUrl) {
    const out = [];
    let m;
    URL_FN.lastIndex = 0;
    while ((m = URL_FN.exec(text))) {
      const u = IU.normalizeImageUrl(m[2], baseUrl);
      if (u) out.push(u);
    }
    return out;
  }

  function collectInlineBackgrounds(records) {
    for (const el of document.querySelectorAll('[style]')) {
      for (const u of urlsFromStyleText(el.getAttribute('style'), location.href)) {
        records.push(mkRecord(u, 'css-inline', {
          displayWidth: el.clientWidth || null,
          displayHeight: el.clientHeight || null
        }));
      }
    }
    // Same-origin stylesheets (best effort; CORS-blocked sheets are skipped).
    for (const sheet of document.styleSheets) {
      try {
        if (sheet.href) {
          if (!IU.sameOrigin(sheet.href, location.href)) continue;
          for (const rule of sheet.cssRules) {
            if (rule.cssText) {
              const bg = /background(?:-image)?\s*:[^;}]*/i.exec(rule.cssText);
              if (bg) for (const u of urlsFromStyleText(bg[0], sheet.href)) {
                records.push(mkRecord(u, 'css-stylesheet'));
              }
            }
          }
        }
      } catch (e) { /* SecurityError on cross-origin sheets: expected */ }
    }
  }

  // getComputedStyle pass, chunked so long tasks are avoided.
  async function collectComputedBackgrounds(onProgress) {
    const els = Array.from(document.querySelectorAll('body *')).filter(el => {
      const s = el.getAttribute && el.getAttribute('style');
      return !(s && /background/i.test(s)); // inline already covered
    }).slice(0, MAX_BG_ELEMENTS);
    const records = [];
    const chunk = 200;
    for (let i = 0; i < els.length; i += chunk) {
      if (state.cancelRequested) break;
      for (const el of els.slice(i, i + chunk)) {
        let bg;
        try { bg = getComputedStyle(el).backgroundImage; } catch (e) { continue; }
        if (bg && bg !== 'none') {
          for (const u of urlsFromStyleText(bg, location.href)) {
            records.push(mkRecord(u, 'css-computed', {
              displayWidth: el.clientWidth || null,
              displayHeight: el.clientHeight || null
            }));
          }
        }
      }
      if (onProgress) onProgress(Math.min(1, (i + chunk) / els.length));
      await new Promise(r => setTimeout(r, 0));
    }
    return IU.dedupeRecords(records);
  }

  // --- MutationObserver ----------------------------------------------------------

  function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches('img')) state.pending.add(n);
          if (n.querySelectorAll) for (const img of n.querySelectorAll('img')) state.pending.add(img);
          state.pending.add(n);
        }
      }
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'data-src'] });
  }

  function drainPending(records) {
    for (const el of state.pending) {
      if (el.tagName === 'IMG') {
        const r = recordFromImg(el);
        if (r) records.push(r);
      } else if (el.style && /background/i.test(el.getAttribute('style') || '')) {
        for (const u of urlsFromStyleText(el.getAttribute('style'), location.href)) records.push(mkRecord(u, 'css-inline'));
      }
    }
    state.pending.clear();
    return IU.dedupeRecords(records);
  }

  function stopObserver() {
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    state.pending.clear();
  }

  // --- storage reporting ------------------------------------------------------------

  const storageKey = () => 'ih-scan-' + (self.__ihTabId || 0);
  const cancelKey = () => 'ih-cancel-' + (self.__ihTabId || 0);

  async function report(patch) {
    try {
      const cur = (await chrome.storage.session.get(storageKey()))[storageKey()] || {};
      await chrome.storage.session.set({ [storageKey()]: Object.assign(cur, patch, { updatedAt: Date.now() }) });
    } catch (e) { /* storage unavailable outside extension context (tests) */ }
  }

  async function readReport() {
    try { return (await chrome.storage.session.get(storageKey()))[storageKey()] || {}; }
    catch (e) { return {}; }
  }

  async function isCancelled() {
    try {
      const v = (await chrome.storage.session.get(cancelKey()))[cancelKey()];
      return !!v;
    } catch (e) { return state.cancelRequested; }
  }

  // combine new records into an existing report image list
  function combine(existing, fresh) {
    const merged = IU.dedupeRecords(existing.concat(fresh));
    merged.forEach((r, i) => { r.index = i; });
    return merged;
  }

  // --- public API ---------------------------------------------------------------------

  async function scan(opts = {}) {
    await report({ status: 'scanning', error: null, progress: { phase: 'collecting', percent: 0 } });
    try {
      let records = collectDom();
      collectInlineBackgrounds(records);
      records = IU.dedupeRecords(records);
      if (opts.includeComputedBackgrounds) {
        const bg = await collectComputedBackgrounds((p) => report({ progress: { phase: 'backgrounds', percent: Math.round(p * 100) } }));
        records = combine(records, bg);
      }
      records.forEach((r, i) => { r.index = i; });
      await report({
        status: 'done', count: records.length, images: records,
        progress: { phase: 'done', percent: 100 }, tabTitle: document.title, pageUrl: location.href
      });
      return records.length;
    } catch (e) {
      await report({ status: 'error', error: String(e && e.message || e) });
      throw e;
    } finally {
      stopObserver();
    }
  }

  async function deepScan(opts = {}) {
    if (state.deepScanning) return { started: false, reason: 'already-running' };
    state.deepScanning = true;
    state.cancelRequested = false;
    const delay = Math.max(100, opts.delayMs || 500);
    const maxMs = Math.max(1000, opts.maxMs || 30000);
    const startY = window.scrollY;
    const existing = (await readReport()).images || [];
    let records = existing.slice();
    try {
    try {
      chrome.runtime.sendMessage({
        type: 'IH_SCAN_PROGRESS',
        payload: { tabId: self.__ihTabId, phase: 'deep-scan-start', percent: 0 }
      });
    } catch (e) { /* no listener */ }
      startObserver();
      const t0 = Date.now();
      const step = Math.max(200, Math.round(window.innerHeight * 0.75));
      let stage = 0;
      while (true) {
        if (await isCancelled()) { await finish('cancelled', records, stage); return { started: true, cancelled: true }; }
        if (Date.now() - t0 > maxMs) { await finish('time-limit', records, stage); return { started: true, reason: 'time-limit' }; }
        window.scrollBy(0, step);
        await sleep(delay);
        stage++;
        const fresh = drainPending(collectDom());
        records = IU.dedupeRecords(combine(records, fresh));
        const nearBottom = window.scrollY + window.innerHeight >= document.body.scrollHeight - 5;
        await report({
          status: 'deep-scanning', count: records.length, images: records,
          progress: {
            phase: 'scrolling', percent: Math.min(90, Math.round((window.scrollY / Math.max(1, document.body.scrollHeight - window.innerHeight)) * 90)),
            stage, found: records.length
          }
        });
        if (nearBottom) break;
      }
      await sleep(delay); // let trailing lazy loaders fire
      const fresh = drainPending(collectDom());
      records = IU.dedupeRecords(combine(records, fresh));
      if (!(await isCancelled())) {
        const bg = await collectComputedBackgrounds();
        records = IU.dedupeRecords(combine(records, bg));
      }
      await finish(await isCancelled() ? 'cancelled' : 'done', records, stage);
      return { started: true, count: records.length };
    } catch (e) {
      await report({ status: 'error', error: String(e && e.message || e) });
      return { started: true, error: String(e && e.message || e) };
    } finally {
      window.scrollTo(0, startY); // restore original scroll position
      stopObserver();
      state.deepScanning = false;
      try { await chrome.storage.session.remove(cancelKey()); } catch (e) {}
    }
  }

  async function finish(status, records, stage) {
    records.forEach((r, i) => { r.index = i; });
    await report({
      status: status === 'done' ? 'done' : status,
      count: records.length, images: records,
      progress: { phase: status, percent: 100, stage, found: records.length },
      tabTitle: document.title, pageUrl: location.href
    });
    try {
      chrome.runtime.sendMessage({
        type: 'IH_SCAN_PROGRESS',
        payload: { tabId: self.__ihTabId, phase: status, percent: 100, found: records.length }
      });
    } catch (e) { /* no listener */ }
  }

  function cancelDeepScan() {
    state.cancelRequested = true;
    return true;
  }

  function selfTest() { // used by tests/fixtures harness
    return { records: IU.dedupeRecords(collectDom()) };
  }

  self.ImageHunterScanner = { scan, deepScan, cancelDeepScan, selfTest, state };

  // Expose helpers for executeScript(func, args) injection mode: the functions
  // above are not serializable across worlds, so popup injects a bootstrap
  // that calls these by name.
})();
