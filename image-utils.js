// Image Hunter — shared pure utilities (URLs, filenames, dedup, filters).
// UMD-style: exposes global `ImageUtils` for the popup, content script, and
// service worker; also exports for Node unit tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ImageUtils = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const IMAGE_EXTENSIONS = {
    jpg: 'JPEG', jpeg: 'JPEG', png: 'PNG', webp: 'WebP', gif: 'GIF',
    svg: 'SVG', avif: 'AVIF', bmp: 'BMP', ico: 'ICO', tiff: 'TIFF', tif: 'TIFF'
  };

  // --- URL handling -------------------------------------------------------

  // Resolve to absolute and drop only the fragment. Query strings are
  // preserved verbatim: they can carry auth or transform semantics.
  function normalizeImageUrl(raw, baseUrl) {
    if (!raw || typeof raw !== 'string') return null;
    raw = raw.trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) return null;
    if (/^(data|blob):/i.test(raw)) return raw;
    try {
      // null base must not reach the URL constructor: `new URL(abs, null)`
      // throws ("null" is parsed as an invalid base) even for absolute URLs.
      const u = new URL(raw, baseUrl || undefined);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      u.hash = '';
      return u.href;
    } catch (e) {
      return null;
    }
  }

  function extensionOf(url) {
    if (!url) return null;
    const path = url.startsWith('data:') ? url.slice(0, 64) : (parsePath(url) || url);
    const m = /\.(png|jpe?g|webp|gif|svgz?|avif|bmp|ico|tiff?)(?=($|[?#]))/i.exec(path);
    if (m) return m[1].toLowerCase().replace('svgz', 'svg');
    if (/^data:image\/([a-z.+-]+)/i.test(url)) {
      const t = RegExp.$1.toLowerCase();
      if (t === 'jpeg') return 'jpg';
      if (t === 'svg+xml') return 'svg';
      return t.split('+')[0];
    }
    return null;
  }

  function parsePath(url) {
    try { return new URL(url).pathname; } catch (e) { return null; }
  }

  function formatOf(url) {
    const ext = extensionOf(url);
    return ext ? (IMAGE_EXTENSIONS[ext] || ext.toUpperCase()) : 'Other';
  }

  function isLikelyImageUrl(url) {
    const ext = extensionOf(url);
    return ext != null && ext !== 'svg' || /\.svgz?(?=($|[?#]))/i.test(parsePath(url) || '');
  }

  function sameOrigin(a, b) {
    try {
      const ua = new URL(a), ub = new URL(b);
      return ua.origin === ub.origin;
    } catch (e) { return false; }
  }

  // --- Deduplication -------------------------------------------------------

  // Key by normalized URL only. Two records with the same URL are the same
  // bytes regardless of where they were found, so merging is safe; distinct
  // images never share a URL.
  function dedupeKey(record) {
    return record.url;
  }

  function mergeRecord(a, b) {
    const better = (x, y) => (x && x > 0 ? x : y) || null;
    return Object.assign({}, a, {
      sourceTypes: Array.from(new Set([].concat(a.sourceTypes || a.sourceType, b.sourceTypes || b.sourceType))),
      naturalWidth: better(b.naturalWidth, a.naturalWidth),
      naturalHeight: better(b.naturalHeight, a.naturalHeight),
      displayWidth: better(b.displayWidth, a.displayWidth),
      displayHeight: better(b.displayHeight, a.displayHeight),
      candidates: Array.from(new Set([].concat(a.candidates || [], b.candidates || []))),
      filename: a.filename || b.filename,
      status: a.status === 'loaded' || b.status === 'loaded' ? 'loaded' : (a.status || b.status)
    });
  }

  function dedupeRecords(records) {
    const map = new Map();
    for (const r of records) {
      const k = dedupeKey(r);
      if (map.has(k)) map.set(k, mergeRecord(map.get(k), r));
      else map.set(k, Object.assign({}, r, { candidates: r.candidates ? r.candidates.slice() : [] }));
    }
    return Array.from(map.values());
  }

  // --- srcset ---------------------------------------------------------------

  // Returns [{url, w, h}] with absolute URLs; invalid entries dropped.
  function parseSrcset(srcset, baseUrl) {
    if (!srcset || typeof srcset !== 'string') return [];
    const out = [];
    // Descriptors cannot contain commas outside parentheses; URLs may.
    const parts = srcset.split(/,(?![^()]*\))/);
    for (const part of parts) {
      const tokens = part.trim().split(/\s+,?\s+|\s+/g).filter(Boolean);
      if (!tokens.length) continue;
      const rawUrl = tokens[0].replace(/^["']|["']$/g, '');
      const url = normalizeImageUrl(rawUrl, baseUrl);
      if (!url) continue;
      let w = null, h = null;
      for (const d of tokens.slice(1)) {
        const mW = /^(\d+)w$/.exec(d), mH = /^(\d+)h$/.exec(d);
        if (mW) w = +mW[1];
        else if (mH) h = +mH[1];
      }
      out.push({ url, w, h });
    }
    return out;
  }

  function bestSrcsetEntry(entries) {
    let best = null, bestScore = -1;
    for (const e of entries) {
      const score = e.w || e.h || 0;
      if (score > bestScore) { best = e; bestScore = score; }
    }
    return best || entries[0] || null;
  }

  // --- Filenames -------------------------------------------------------------

  const ILLEGAL = /[\\/:*?"<>|\x00-\x1f]/g;

  function baseFilename(url, maxStem = 80) {
    let name = 'image';
    if (url.startsWith('data:')) {
      name = 'image';
    } else {
      const p = parsePath(url);
      if (p) {
        const seg = p.split('/').filter(Boolean).pop();
        if (seg) name = decodeURIComponentQuietly(seg);
      }
    }
    name = name.replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim();
    // Ensure an image extension is present.
    if (!extensionOf(name) && extensionOf(url)) name += '.' + extensionOf(url);
    const dot = name.lastIndexOf('.');
    const hasExt = dot > 0;
    const stem = hasExt ? name.slice(0, dot) : name;
    const ext = hasExt ? name.slice(dot) : '';
    return (stem.slice(0, maxStem) || 'image') + ext;
  }

  function decodeURIComponentQuietly(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function sanitizeFilename(name) {
    return String(name).replace(ILLEGAL, '_').replace(/^\.+/, '').trim() || 'image';
  }

  // Conflict-free name within a session: `photo.jpg`, `photo (1).jpg`, ...
  function uniqueFilename(name, taken) {
    if (!taken.has(name)) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let i = 1;
    while (taken.has(`${stem} (${i})${ext}`)) i++;
    return `${stem} (${i})${ext}`;
  }

  // --- Filters & sorting ------------------------------------------------------

  function isTrackingPixel(record, minWidth = 50, minHeight = 50) {
    // Unloaded images report default placeholder client sizes (often 100x100
    // or 150x150); trusting them would hide real lazy images. Only intrinsic
    // dimensions count as proof of smallness.
    const w = record.naturalWidth;
    const h = record.naturalHeight;
    if (w == null || h == null) return false; // unknown dimensions: keep
    return w <= minWidth && h <= minHeight;
  }

  function resolutionClass(record) {
    const w = record.naturalWidth || record.displayWidth || 0;
    const h = record.naturalHeight || record.displayHeight || 0;
    const px = w * h;
    if (px >= 1920 * 1080) return 'large';
    if (px >= 800 * 600) return 'medium';
    if (px > 0) return 'small';
    return 'unknown';
  }

  const SORTERS = {
    largest: (a, b) => px(b) - px(a),
    smallest: (a, b) => px(a) - px(b),
    name: (a, b) => baseFilename(a.url).localeCompare(baseFilename(b.url)),
    type: (a, b) => formatOf(a.url).localeCompare(formatOf(b.url)) || px(b) - px(a),
    discovered: (a, b) => (a.index || 0) - (b.index || 0)
  };
  function px(r) {
    return (r.naturalWidth || r.displayWidth || 0) * (r.naturalHeight || r.displayHeight || 0);
  }

  function sortRecords(records, mode) {
    const fn = SORTERS[mode] || SORTERS.largest;
    return records.slice().sort(fn);
  }

  function searchMatches(record, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return record.url.toLowerCase().includes(q) || baseFilename(record.url).toLowerCase().includes(q);
  }

  return {
    IMAGE_EXTENSIONS, normalizeImageUrl, extensionOf, formatOf, isLikelyImageUrl,
    sameOrigin, dedupeKey, dedupeRecords, mergeRecord, parseSrcset,
    bestSrcsetEntry, baseFilename, sanitizeFilename, uniqueFilename,
    isTrackingPixel, resolutionClass, sortRecords, searchMatches,
    px, SORT_MODES: Object.keys(SORTERS)
  };
});
