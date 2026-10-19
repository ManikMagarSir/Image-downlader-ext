// Image Hunter — popup application state and UI events.
'use strict';
(function () {
  const IU = ImageUtils;
  const PAGE_SIZE = 60;

  const SORT_LABELS = {
    largest: 'Largest first',
    smallest: 'Smallest first',
    name: 'Name (A–Z)',
    type: 'File type',
    discovered: 'Page order'
  };

  const HISTORY_STATUS = { complete: 'Downloaded', failed: 'Failed', zip: 'Zipped' };

  const ICONS = {
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5v.01"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>'
  };

  const els = {};
  for (const id of ['btn-scan', 'btn-deep', 'btn-settings', 'btn-cancel', 'progress', 'progress-track',
    'progress-bar', 'progress-text', 'banner', 'banner-text', 'btn-banner-close', 'search', 'sort',
    'btn-filters', 'filter-badge', 'filters-panel', 'format', 'minw', 'minh', 'hide-tiny', 'hide-dupes',
    'btn-reset-filters', 'selection-bar', 'btn-select-visible', 'btn-clear-selection', 'counts',
    'gallery', 'empty', 'btn-more', 'btn-download', 'btn-zip', 'btn-cancel-downloads', 'download-status',
    'dlg-settings', 'dlg-detail', 'history', 's-minw', 's-minh', 's-hide-tiny', 's-hide-dupes', 's-sort',
    's-folder', 's-use-folder', 'folder-field', 's-delay', 's-maxms', 's-reset', 's-clear-history', 's-close']) {
    els[id] = document.getElementById(id);
  }

  const app = {
    tabId: null,
    settings: null,
    images: [],          // raw scan records
    view: [],           // filtered + sorted records currently visible
    rendered: 0,        // cards rendered so far
    selected: new Set(), // URLs
    scanning: false,
    scanned: false,     // a scan has completed at least once for this tab
    dlTimer: null
  };

  // --- boot -------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    app.settings = await Settings.get();
    for (const m of IU.SORT_MODES) {
      els['sort'].appendChild(new Option(SORT_LABELS[m] || m, m));
      els['s-sort'].appendChild(new Option(SORT_LABELS[m] || m, m));
    }
    applySettingsToControls();
    bindEvents();
    syncFolderField();
    updateFilterBadge();

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    app.tabId = tab && tab.id;
    await loadStoredScan();
    if (app.images.length) render();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'session') return;
      const key = 'ih-scan-' + app.tabId;
      if (changes[key]) applyReport(changes[key].newValue);
    });
    pollDownloadStatus(); // resume display if a batch is running
  }

  function applySettingsToControls() {
    const s = app.settings;
    // min W/H filter inputs start empty (opt-in); s.minWidth/minHeight drive
    // the "hide tiny" threshold instead.
    els['hide-tiny'].checked = s.hideTiny;
    els['hide-dupes'].checked = s.hideDuplicates;
    els['sort'].value = s.defaultSort;
    els['s-minw'].value = s.minWidth;
    els['s-minh'].value = s.minHeight;
    els['s-hide-tiny'].checked = s.hideTiny;
    els['s-hide-dupes'].checked = s.hideDuplicates;
    els['s-sort'].value = s.defaultSort;
    els['s-folder'].value = s.downloadFolder;
    els['s-use-folder'].checked = s.useCustomFolder;
    els['s-delay'].value = s.deepScanDelayMs;
    els['s-maxms'].value = s.deepScanMaxMs;
    updateFilterBadge();
  }

  function syncFolderField() {
    els['s-folder'].disabled = !els['s-use-folder'].checked;
  }

  // --- progressive disclosure --------------------------------------------
  function setFiltersOpen(open) {
    els['filters-panel'].classList.toggle('hidden', !open);
    els['btn-filters'].setAttribute('aria-expanded', String(open));
  }

  function activeFilterCount() {
    let n = 0;
    if (els['format'].value) n++;
    if (parseInt(els['minw'].value, 10) > 0) n++;
    if (parseInt(els['minh'].value, 10) > 0) n++;
    if (els['hide-dupes'].checked) n++;
    return n;
  }

  function updateFilterBadge() {
    const n = activeFilterCount();
    els['filter-badge'].textContent = String(n);
    els['filter-badge'].classList.toggle('hidden', n === 0);
  }

  function resetFilters() {
    els['format'].value = '';
    els['minw'].value = '';
    els['minh'].value = '';
    els['hide-tiny'].checked = app.settings.hideTiny;
    els['hide-dupes'].checked = app.settings.hideDuplicates;
    els['sort'].value = app.settings.defaultSort;
    els['search'].value = '';
    updateFilterBadge();
    render();
  }

  // --- scanning ----------------------------------------------------------
  const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|web-store)/;

  async function injectScanner() {
    await chrome.scripting.executeScript({
      target: { tabId: app.tabId },
      files: ['image-utils.js', 'scanner.js']
    });
  }

  async function runScan(deep) {
    if (app.scanning) return;
    const tab = (await chrome.tabs.get(app.tabId).catch(() => null));
    if (!tab || RESTRICTED.test(tab.url || '') || /^https:\/\/chrome\.google\.com\/webstore/.test(tab.url || '')) {
      showBanner('This page type is not accessible to extensions (browser pages, Web Store). Open a regular website and try again.', 'error');
      return;
    }
    app.scanning = true;
    hideBanner();
    setProgress(deep ? 'Deep scan: preparing…' : 'Scanning…', 5);
    els['btn-cancel'].classList.remove('hidden');
    els['btn-scan'].disabled = els['btn-deep'].disabled = true;
    try {
      await injectScanner();
      if (deep) {
        await chrome.scripting.executeScript({
          target: { tabId: app.tabId },
          func: (tid, opts) => { self.__ihTabId = tid; return self.ImageHunterScanner.deepScan(opts); },
          args: [app.tabId, { delayMs: app.settings.deepScanDelayMs, maxMs: app.settings.deepScanMaxMs }]
        });
        // deepScan keeps reporting through storage; the popup receives live
        // updates via chrome.storage.onChanged even if this call returns late.
      } else {
        await chrome.scripting.executeScript({
          target: { tabId: app.tabId },
          func: (tid, opts) => { self.__ihTabId = tid; return self.ImageHunterScanner.scan(opts); },
          args: [app.tabId, { includeComputedBackgrounds: true }]
        });
      }
      await loadStoredScan();
    } catch (e) {
      showBanner('Cannot scan this page: ' + (e.message || e), 'error');
    } finally {
      app.scanning = false;
      app.scanned = true;
      els['btn-cancel'].classList.add('hidden');
      els['btn-scan'].disabled = els['btn-deep'].disabled = false;
      clearProgress();
      render();
    }
  }

  async function cancelScan() {
    try {
      await chrome.storage.session.set({ ['ih-cancel-' + app.tabId]: true });
      await chrome.scripting.executeScript({
        target: { tabId: app.tabId },
        func: () => self.ImageHunterScanner.cancelDeepScan()
      });
    } catch (e) { /* tab may have closed */ }
    setProgress('Cancelling…', 100);
  }

  async function loadStoredScan() {
    try {
      const key = 'ih-scan-' + app.tabId;
      const stored = await chrome.storage.session.get(key);
      applyReport(stored[key]);
    } catch (e) { /* session storage may be cleared */ }
  }

  function applyReport(report) {
    if (!report) return;
    if (Array.isArray(report.images)) {
      const live = report.status === 'scanning' || report.status === 'deep-scanning';
      const grew = app.images.length > 0 && report.images.length >= app.images.length;
      app.images = report.images;
      if (report.status === 'done' || report.status === 'cancelled' || report.status === 'time-limit') {
        app.scanned = true;
      }
      // prune selections that vanished
      const urls = new Set(app.images.map(i => i.url));
      app.selected = new Set(Array.from(app.selected).filter(u => urls.has(u)));
      render({ keepScroll: live && grew });
    }
    if (report.status === 'scanning' || report.status === 'deep-scanning') {
      const p = report.progress || {};
      const phase = p.phase ? ` — ${p.phase}` : '';
      setProgress(`Finding images… ${report.count || 0} found${phase}`, p.percent || 0);
      els['btn-cancel'].classList.remove('hidden');
    } else if (report.status === 'error') {
      app.scanned = true;
      clearProgress();
      els['btn-cancel'].classList.add('hidden');
      showBanner('Scan failed: ' + report.error, 'error');
    } else if (report.status === 'cancelled') {
      clearProgress();
      els['btn-cancel'].classList.add('hidden');
      showBanner('Scan cancelled.');
    } else if (report.status === 'time-limit') {
      clearProgress();
      els['btn-cancel'].classList.add('hidden');
      showBanner('Deep scan reached its time limit — showing everything found so far.');
    } else if (report.status === 'done') {
      clearProgress();
      els['btn-cancel'].classList.add('hidden');
    }
  }

  // --- rendering -----------------------------------------------------------
  // "Collapse URL variants" drops records whose URL differs only by query
  // string (e.g. /a.jpg vs /a.jpg?v=2), keeping the richest variant. Normalized
  // exact duplicates are already merged by the scanner.
  function hideQueryDuplicates(list) {
    const byPath = new Map();
    for (const r of list) {
      let key;
      try { const u = new URL(r.url); u.search = ''; key = u.href; }
      catch (e) { key = r.url; }
      const cur = byPath.get(key);
      if (!cur || IU.px(r) > IU.px(cur)) byPath.set(key, r);
    }
    return Array.from(byPath.values());
  }

  function filteredView() {
    const s = app.settings;
    const q = els['search'].value.trim();
    const fmt = els['format'].value;
    const minW = parseInt(els['minw'].value, 10) || 0;
    const minH = parseInt(els['minh'].value, 10) || 0;
    const hideTiny = els['hide-tiny'].checked;
    const tinyW = s.minWidth, tinyH = s.minHeight;

    let list = app.images;
    if (els['hide-dupes'].checked) list = hideQueryDuplicates(list);
    if (hideTiny) list = list.filter(r => !IU.isTrackingPixel(r, tinyW, tinyH));
    if (q) list = list.filter(r => IU.searchMatches(r, q));
    if (fmt) list = list.filter(r => IU.formatOf(r.url) === fmt);
    if (minW || minH) {
      list = list.filter(r => {
        // unknown dimensions are kept: only images *proven* smaller than the
        // threshold are excluded (the tiny-pixel filter covers true smallness)
        const w = r.naturalWidth || r.displayWidth;
        const h = r.naturalHeight || r.displayHeight;
        return (!w || w >= minW) && (!h || h >= minH);
      });
    }
    return IU.sortRecords(list, els['sort'].value);
  }

  function render(opts) {
    const keepScroll = !!(opts && opts.keepScroll);
    const prevRendered = app.rendered;
    const scrollTop = keepScroll ? els['gallery'].scrollTop : 0;

    app.view = filteredView();
    app.rendered = 0;
    els['gallery'].querySelectorAll('.card').forEach(c => c.remove());
    setEmptyState();
    renderMore();
    if (keepScroll) {
      // Re-render enough pages to cover what the user had already seen so the
      // gallery doesn't shrink mid-scan, then restore the scroll position.
      let guard = 0;
      while (app.rendered < prevRendered && app.rendered < app.view.length && guard++ < 200) renderMore();
      els['gallery'].scrollTop = scrollTop;
    }
    updateSelectionBar();
    updateCounts();
  }

  function renderMore() {
    const frag = document.createDocumentFragment();
    const slice = app.view.slice(app.rendered, app.rendered + PAGE_SIZE);
    for (const rec of slice) frag.appendChild(buildCard(rec));
    els['gallery'].appendChild(frag);
    app.rendered += slice.length;
    els['btn-more'].classList.toggle('hidden', app.rendered >= app.view.length);
    updateCounts();
  }

  function setEmptyState() {
    const el = els['empty'];
    el.innerHTML = '';
    if (app.view.length > 0) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');

    const hasScan = app.scanned || app.images.length > 0;
    if (!app.images.length) {
      if (hasScan) {
        el.textContent = 'No images found on this page.';
        const hint = document.createElement('span');
        hint.className = 'empty-hint';
        hint.textContent = 'Some sites load images as you scroll.';
        el.appendChild(hint);
        const btn = document.createElement('button');
        btn.className = 'btn btn-tiny';
        btn.style.marginTop = '10px';
        btn.textContent = 'Try Deep Scan';
        btn.addEventListener('click', () => runScan(true));
        el.appendChild(btn);
      } else {
        el.innerHTML = 'No scan yet. Click <b>Scan</b> to find images on this page.';
      }
      return;
    }
    // Images exist but none match the filters.
    el.textContent = 'No images match your filters.';
    const btn = document.createElement('button');
    btn.className = 'btn btn-tiny';
    btn.style.marginTop = '10px';
    btn.textContent = 'Reset filters';
    btn.addEventListener('click', resetFilters);
    el.appendChild(btn);
  }

  function buildCard(rec) {
    const selected = app.selected.has(rec.url);
    const card = document.createElement('div');
    card.className = 'card' + (selected ? ' selected' : '');
    card.dataset.url = rec.url;

    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'pick';
    pick.checked = selected;
    pick.setAttribute('aria-label', 'Select ' + IU.baseFilename(rec.url));
    card.appendChild(pick);

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const im = document.createElement('img');
    im.loading = 'lazy';
    im.alt = '';
    im.referrerPolicy = 'no-referrer';
    im.src = rec.url;
    im.addEventListener('error', () => {
      thumb.textContent = 'Preview failed';
      thumb.classList.add('broken');
      rec.status = 'broken';
    });
    thumb.appendChild(im);
    card.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = IU.baseFilename(rec.url);
    name.title = rec.url;
    meta.appendChild(name);
    const tags = document.createElement('div');
    tags.className = 'tags';
    const dims = rec.naturalWidth ? `${rec.naturalWidth}×${rec.naturalHeight}`
      : rec.displayWidth ? `~${rec.displayWidth}×${rec.displayHeight}` : '?×?';
    tags.appendChild(tag(dims));
    tags.appendChild(tag(IU.formatOf(rec.url), 'type'));
    if (rec.candidates && rec.candidates.length) tags.appendChild(tag('larger version?', 'cand'));
    meta.appendChild(tags);
    card.appendChild(meta);

    const info = document.createElement('button');
    info.className = 'info';
    info.innerHTML = ICONS.info;
    info.title = 'Details';
    info.setAttribute('aria-label', 'Details for ' + IU.baseFilename(rec.url));
    info.addEventListener('click', (e) => { e.stopPropagation(); showDetail(rec); });
    card.appendChild(info);

    const dl = document.createElement('button');
    dl.className = 'quickdl';
    dl.innerHTML = ICONS.download;
    dl.title = 'Download this image';
    dl.setAttribute('aria-label', 'Download ' + IU.baseFilename(rec.url));
    dl.addEventListener('click', (e) => { e.stopPropagation(); downloadRecords([rec], useBestVersion(rec)); });
    card.appendChild(dl);

    pick.addEventListener('click', (e) => { e.stopPropagation(); toggleSelect(rec); });
    card.addEventListener('click', () => toggleSelect(rec));
    return card;
  }

  function tag(text, cls) {
    const t = document.createElement('span');
    t.className = 'tag' + (cls ? ' ' + cls : '');
    t.textContent = text;
    return t;
  }

  function toggleSelect(rec) {
    if (app.selected.has(rec.url)) app.selected.delete(rec.url);
    else app.selected.add(rec.url);
    rec.__selected = app.selected.has(rec.url);
    // cheap update instead of full re-render
    const cards = els['gallery'].querySelectorAll('.card');
    for (const c of cards) {
      if (c.dataset.url !== rec.url) continue;
      c.classList.toggle('selected', app.selected.has(rec.url));
      const pick = c.querySelector('.pick');
      if (pick) pick.checked = app.selected.has(rec.url);
    }
    updateCounts();
  }

  function updateSelectionBar() {
    els['selection-bar'].classList.toggle('hidden', app.images.length === 0);
  }

  function updateCounts() {
    const parts = [`${app.selected.size} selected`];
    if (app.images.length) parts.push(`${app.view.length} of ${app.images.length} shown`);
    els['counts'].textContent = parts.join(' · ');
    const hasSel = app.selected.size > 0;
    els['btn-download'].disabled = !hasSel;
    els['btn-zip'].disabled = !hasSel;
    els['btn-download'].textContent = hasSel
      ? `Download ${app.selected.size} image${app.selected.size > 1 ? 's' : ''}`
      : 'Download selected';
  }

  // --- detail dialog (original vs candidate) ---------------------------------
  function showDetail(rec) {
    const dlg = els['dlg-detail'];
    dlg.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'detail';

    const title = document.createElement('h2');
    title.id = 'detail-title';
    title.textContent = 'Image details';
    wrap.appendChild(title);

    const preview = document.createElement('div');
    preview.className = 'preview';
    const im = document.createElement('img');
    im.src = rec.url; im.alt = ''; im.referrerPolicy = 'no-referrer';
    preview.appendChild(im);
    wrap.appendChild(preview);

    const summary = document.createElement('div');
    summary.className = 'summary';
    const dname = document.createElement('div');
    dname.className = 'dname';
    dname.textContent = IU.baseFilename(rec.url);
    const dsub = document.createElement('div');
    dsub.className = 'dsub';
    const dims = fmtSize(rec.naturalWidth || rec.displayWidth, rec.naturalHeight || rec.displayHeight);
    dsub.textContent = `${IU.formatOf(rec.url)} · ${dims}${rec.candidates && rec.candidates.length ? ' · larger version available' : ''}`;
    summary.append(dname, dsub);
    wrap.appendChild(summary);

    const tech = document.createElement('details');
    tech.className = 'tech';
    const techSummary = document.createElement('summary');
    techSummary.textContent = 'Technical details';
    tech.appendChild(techSummary);

    const table = document.createElement('table');
    table.appendChild(row('Format', IU.formatOf(rec.url)));
    table.appendChild(row('Displayed', fmtSize(rec.displayWidth, rec.displayHeight)));
    table.appendChild(row('Actual size', fmtSize(rec.naturalWidth, rec.naturalHeight)));
    table.appendChild(row('Found in', (rec.sourceTypes || [rec.sourceType] || []).join(', ')));
    table.appendChild(row('Page', rec.pageUrl || ''));
    tech.appendChild(table);

    tech.appendChild(urlRow('Source URL', rec.url, false));
    for (const cand of (rec.candidates || [])) {
      const probe = document.createElement('div');
      probe.appendChild(urlRow(`Candidate (${cand.basis}, inferred — not verified as original)`, cand.url, true));
      const info = document.createElement('span');
      info.className = 'tag';
      info.textContent = 'size: checking…';
      probe.appendChild(info);
      probeImageSize(cand.url).then(d => {
        cand.__probed = d; // remembered so "best version" choices can use proof
        info.textContent = d ? `size: ${d.w}×${d.h}` : 'size: unreachable';
      });
      tech.appendChild(probe);
    }
    wrap.appendChild(tech);
    dlg.appendChild(wrap);

    const menu = document.createElement('menu');
    const close = mkButton('Close', 'btn');
    close.onclick = () => dlg.close();
    menu.appendChild(close);
    const dl = mkButton(rec.candidates && rec.candidates.length ? 'Download best quality' : 'Download', 'btn btn-primary');
    dl.onclick = () => { dlg.close(); downloadRecords([rec], useBestVersion(rec)); };
    menu.appendChild(dl);
    dlg.appendChild(menu);
    dlg.showModal();
  }

  function row(k, v) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = k;
    const td2 = document.createElement('td'); td2.textContent = v;
    tr.append(td1, td2);
    return tr;
  }

  function urlRow(label, url, isCand) {
    const div = document.createElement('div');
    div.className = 'urlrow';
    const lab = document.createElement('span');
    lab.style.fontSize = '12px';
    lab.textContent = label;
    const code = document.createElement('code');
    code.textContent = url;
    code.title = url;
    const copy = mkButton('Copy', 'btn btn-tiny');
    copy.onclick = () => navigator.clipboard.writeText(url);
    div.append(lab, code, copy);
    return div;
  }

  function mkButton(label, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    return b;
  }

  function fmtSize(w, h) {
    return w && h ? `${w}×${h}` : 'unknown';
  }

  function probeImageSize(url) {
    return new Promise((resolve) => {
      const img = new Image();
      const t = setTimeout(() => resolve(null), 8000);
      img.onload = () => { clearTimeout(t); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = () => { clearTimeout(t); resolve(null); };
      img.referrerPolicy = 'no-referrer';
      img.src = url;
    });
  }

  // Choose the best version per image: prefer a candidate whose probed size
  // beats the source; candidates remain labelled as inferred in the UI.
  function useBestVersion(rec) {
    const items = [{ url: rec.url, filename: IU.baseFilename(rec.url) }];
    if (rec.candidates && rec.candidates.length) {
      // Without a verified probe we cannot guarantee "higher resolution", so
      // the plain source stays first; the detail dialog offers candidates
      // explicitly. Here we only upgrade when intrinsic data proves bigger.
      for (const cand of rec.candidates) {
        if (cand.__probed && rec.naturalWidth &&
            cand.__probed.w * cand.__probed.h > rec.naturalWidth * (rec.naturalHeight || 0)) {
          return [{ url: cand.url, filename: IU.baseFilename(cand.url) }];
        }
      }
    }
    return items;
  }

  // --- downloads --------------------------------------------------------------
  async function downloadRecords(records, resolvedItems) {
    const folder = app.settings.useCustomFolder ? app.settings.downloadFolder : null;
    const items = resolvedItems.map(it => Object.assign({}, it, {
      filename: it.filename ? IU.sanitizeFilename(it.filename) : IU.baseFilename(it.url)
    }));
    const res = await chrome.runtime.sendMessage({ type: 'IH_DOWNLOAD_BATCH', payload: { items, folder } });
    if (!res || !res.ok) {
      setDlStatus(res && res.error ? 'Download failed: ' + res.error : 'Download request failed', 'error');
      return;
    }
    const dest = folder ? ` into ${folder}/` : '';
    setDlStatus(`Downloading ${items.length} file${items.length > 1 ? 's' : ''}${dest}…`, '');
    pollDownloadStatus(true);
  }

  function selectedRecords() {
    return app.images.filter(r => app.selected.has(r.url));
  }

  function pollDownloadStatus(force) {
    if (app.dlTimer && !force) return;
    clearTimeout(app.dlTimer);
    const tick = async () => {
      const st = await chrome.runtime.sendMessage({ type: 'IH_DOWNLOAD_STATUS' }).catch(() => null);
      if (!st || !st.active) { app.dlTimer = null; els['btn-cancel-downloads'].classList.add('hidden'); return; }
      const c = st.counts;
      const remaining = c.inProgress + c.interrupted;
      els['btn-cancel-downloads'].classList.toggle('hidden', !remaining);
      setDlStatus(
        st.cancelled ? `Cancelled — ${c.completed} of ${c.total} completed` :
        remaining ? `Download ${c.completed + c.failed} / ${c.total}${c.failed ? ` (${c.failed} failed)` : ''}` :
        `Done: ${c.completed} succeeded${c.failed ? `, ${c.failed} failed` : ''}${c.cancelled ? `, ${c.cancelled} cancelled` : ''}`,
        remaining ? '' : (c.failed ? 'error' : 'ok')
      );
      if (!remaining) {
        await Settings.addHistory(st.items.filter(i => i.state === 'complete' || i.state === 'failed')
          .map(i => ({ url: i.url, filename: i.filename, status: i.state })));
        app.dlTimer = null;
        return;
      }
      app.dlTimer = setTimeout(tick, 800);
    };
    app.dlTimer = setTimeout(tick, 300);
  }

  async function cancelDownloads() {
    els['btn-cancel-downloads'].disabled = true;
    try { await chrome.runtime.sendMessage({ type: 'IH_CANCEL_DOWNLOADS' }); } catch (e) { /* ignore */ }
    els['btn-cancel-downloads'].disabled = false;
    setDlStatus('Cancelling downloads…', '');
    pollDownloadStatus(true);
  }

  function setDlStatus(text, cls) {
    els['download-status'].textContent = text;
    els['download-status'].className = 'dl-status' + (cls ? ' ' + cls : '');
  }

  async function zipSelected() {
    const records = selectedRecords();
    if (!records.length) return;
    els['btn-zip'].disabled = true;
    els['btn-download'].disabled = true;
    try {
      const res = await ZipExport.buildZip(
        records.map(r => ({ url: r.url, filename: IU.baseFilename(r.url) })),
        (p) => {
          if (p.phase === 'fetch') setProgress(`ZIP: fetching ${p.index + 1}/${p.total} (${formatBytes(p.bytes)})`, Math.round(p.index / p.total * 80));
          else setProgress(`ZIP: packaging ${(p.percent || 0).toFixed(0)}%`, 80 + Math.round((p.percent || 0) * 0.2));
        }
      );
      clearProgress();
      if (res.aborted) {
        showBanner(res.abortedReason, 'error');
      }
      if (res.added.length) {
        const name = `ImageHunter-${new Date().toISOString().slice(0, 10)}.zip`;
        await ZipExport.downloadZip(res.blob, name);
        await Settings.addHistory(res.added.map(a => ({ url: a.url, filename: a.filename, status: 'zip' })));
        setDlStatus(`ZIP created with ${res.added.length} file(s)${res.failed.length ? `, ${res.failed.length} skipped` : ''}`, res.failed.length ? 'error' : 'ok');
      }
      if (res.failed.length) {
        showBanner(`${res.failed.length} file(s) could not be fetched: ${res.failed.slice(0, 3).map(f => f.error).join(' | ')}${res.failed.length > 3 ? ' …' : ''}`, 'error');
      }
      if (!res.added.length && !res.failed.length) setDlStatus('Nothing to add', 'error');
    } catch (e) {
      clearProgress();
      setDlStatus('ZIP failed: ' + (e.message || e), 'error');
    } finally {
      els['btn-zip'].disabled = els['btn-download'].disabled = app.selected.size === 0;
    }
  }

  function formatBytes(n) {
    return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
  }

  // --- progress & banner helpers -------------------------------------------------
  function setProgress(text, pct) {
    const clamped = Math.max(0, Math.min(100, pct));
    els['progress'].classList.remove('hidden');
    els['progress-text'].textContent = text;
    els['progress-bar'].style.width = clamped + '%';
    els['progress-track'].setAttribute('aria-valuenow', String(Math.round(clamped)));
  }
  function clearProgress() {
    els['progress'].classList.add('hidden');
    els['progress-track'].setAttribute('aria-valuenow', '0');
  }
  function showBanner(text, kind) {
    els['banner-text'].textContent = text;
    els['banner'].className = 'banner' + (kind === 'error' ? ' error' : '');
  }
  function hideBanner() { els['banner'].className = 'banner hidden'; }

  // --- settings dialog -------------------------------------------------------------
  async function openSettings() {
    applySettingsToControls();
    syncFolderField();
    const hist = await Settings.getHistory();
    els['history'].innerHTML = '';
    if (!hist.length) {
      els['history'].textContent = 'No downloads recorded yet.';
    } else {
      for (const h of hist.slice(0, 50)) {
        const div = document.createElement('div');
        const n = document.createElement('span'); n.className = 'hname'; n.textContent = h.filename; n.title = h.url;
        const meta = document.createElement('span'); meta.className = 'hmeta';
        const label = HISTORY_STATUS[h.status] || h.status;
        const when = h.time ? new Date(h.time).toLocaleString() : '';
        meta.textContent = when ? `${label} · ${when}` : label;
        meta.classList.add('hstatus-' + h.status);
        div.append(n, meta);
        els['history'].appendChild(div);
      }
    }
    els['dlg-settings'].showModal();
  }

  async function saveSettingsFromDialog() {
    const s = await Settings.set({
      minWidth: parseInt(els['s-minw'].value, 10) || 0,
      minHeight: parseInt(els['s-minh'].value, 10) || 0,
      hideTiny: els['s-hide-tiny'].checked,
      hideDuplicates: els['s-hide-dupes'].checked,
      defaultSort: els['s-sort'].value,
      downloadFolder: els['s-folder'].value.trim() || 'ImageHunter',
      useCustomFolder: els['s-use-folder'].checked,
      deepScanDelayMs: Math.max(100, parseInt(els['s-delay'].value, 10) || 500),
      deepScanMaxMs: Math.max(1000, parseInt(els['s-maxms'].value, 10) || 30000)
    });
    app.settings = s;
    applySettingsToControls();
    render();
  }

  async function resetSettings() {
    if (!confirm('Reset all settings to their defaults?')) return;
    app.settings = await Settings.set(Object.assign({}, Settings.DEFAULTS));
    applySettingsToControls();
    syncFolderField();
    render();
  }

  // --- events ------------------------------------------------------------------------
  function bindEvents() {
    els['btn-scan'].addEventListener('click', () => runScan(false));
    els['btn-deep'].addEventListener('click', () => runScan(true));
    els['btn-cancel'].addEventListener('click', cancelScan);
    els['btn-settings'].addEventListener('click', openSettings);
    els['btn-banner-close'].addEventListener('click', hideBanner);
    els['btn-cancel-downloads'].addEventListener('click', cancelDownloads);
    els['btn-filters'].addEventListener('click', () => {
      setFiltersOpen(els['filters-panel'].classList.contains('hidden'));
    });
    els['btn-reset-filters'].addEventListener('click', resetFilters);
    els['s-close'].addEventListener('click', () => { saveSettingsFromDialog(); els['dlg-settings'].close(); });
    els['s-reset'].addEventListener('click', resetSettings);
    els['s-clear-history'].addEventListener('click', async () => {
      if (!confirm('Clear the download history?')) return;
      await Settings.clearHistory();
      openSettings();
    });
    els['s-use-folder'].addEventListener('change', syncFolderField);
    for (const id of ['search', 'sort', 'format', 'minw', 'minh', 'hide-tiny', 'hide-dupes']) {
      els[id].addEventListener('input', () => { updateFilterBadge(); render(); });
      els[id].addEventListener('change', () => { updateFilterBadge(); render(); });
    }
    els['btn-select-visible'].addEventListener('click', () => {
      for (const r of app.view.slice(0, app.rendered)) app.selected.add(r.url);
      render();
    });
    els['btn-clear-selection'].addEventListener('click', () => { app.selected.clear(); render(); });
    els['btn-more'].addEventListener('click', renderMore);
    els['btn-download'].addEventListener('click', () => {
      const recs = selectedRecords();
      const items = [];
      const taken = new Set();
      for (const r of recs) {
        for (const it of useBestVersion(r)) {
          it.filename = IU.uniqueFilename(it.filename || IU.baseFilename(it.url), taken);
          taken.add(it.filename);
          items.push(it);
        }
      }
      downloadRecords(recs, items);
    });
    els['btn-zip'].addEventListener('click', zipSelected);
  }
})();
