// Image Hunter — download queue (runs in the background service worker).
// Uses chrome.downloads for the actual fetch so page CORS and content
// security policies do not apply; the browser downloads with its own
// network access and existing cookies.
'use strict';
(function (root) {
  const IU = root.ImageUtils;
  const MAX_RETRIES = 2;
  const BATCH_KEY = 'ih-download-batch';
  const RETRYABLE = ['NETWORK', 'SERVER', 'FILE', 'TRANSPORT', 'ACCESS', 'ABORT'];

  let batch = null; // {items:[], taken:Set, active:Set}
  let listenerBound = false;

  function getStatus() {
    if (!batch) return { active: false };
    const counts = { total: batch.items.length, completed: 0, failed: 0, cancelled: 0, inProgress: 0, interrupted: 0 };
    for (const it of batch.items) {
      if (it.state === 'complete') counts.completed++;
      else if (it.state === 'failed') counts.failed++;
      else if (it.state === 'cancelled') counts.cancelled++;
      else if (it.state === 'interrupted') counts.interrupted++;
      else counts.inProgress++;
    }
    return {
      active: true,
      cancelled: !!batch.cancelled,
      counts,
      items: batch.items.map(({ url, filename, state, error, attempts, downloadId }) =>
        ({ url, filename, state, error, attempts, downloadId }))
    };
  }

  async function startBatch(items, folder) {
    bindListeners();
    batch = { items: [], taken: new Set(), cancelled: false, startedAt: Date.now() };
    const folderPrefix = sanitiseFolder(folder);
    for (const it of items) {
      let name = it.filename || IU.baseFilename(it.url);
      name = IU.uniqueFilename(IU.sanitizeFilename(name), batch.taken);
      batch.taken.add(name);
      batch.items.push({
        url: it.url,
        filename: folderPrefix ? `${folderPrefix}/${name}` : name,
        baseName: name,
        state: 'queued',
        error: null,
        attempts: 0,
        downloadId: null
      });
    }
    await persist();
    for (const it of batch.items) launch(it);
    return { ok: true, total: batch.items.length };
  }

  function sanitiseFolder(folder) {
    if (!folder || typeof folder !== 'string') return null;
    const parts = folder.split(/[\\/]/).map(s => IU.sanitizeFilename(s)).filter(Boolean);
    return parts.length ? parts.join('/') : null;
  }

  async function launch(item) {
    item.attempts++;
    item.state = 'inProgress';
    item.error = null;
    try {
      const id = await new Promise((resolve, reject) => {
        chrome.downloads.download(
          {
            url: item.url,
            filename: item.filename,
            saveAs: false,
            conflictAction: 'uniquify'
          },
          (id) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else if (id == null) reject(new Error('Download not started'));
            else resolve(id);
          }
        );
      });
      item.downloadId = id;
      activeIds.set(id, item);
    } catch (e) {
      item.state = 'failed';
      item.error = String(e.message || e);
    }
    await persist();
  }

  const activeIds = new Map(); // downloadId -> item

  function bindListeners() {
    if (listenerBound) return;
    listenerBound = true;
    chrome.downloads.onChanged.addListener(onChanged);
  }

  async function onChanged(delta) {
    const item = activeIds.get(delta.id);
    if (!item) return;
    if (delta.state) {
      const prev = item.state;
      if (delta.state.current === 'complete') {
        item.state = 'complete';
        activeIds.delete(delta.id);
      } else if (delta.state.current === 'interrupted') {
        activeIds.delete(delta.id);
        const err = (delta.error && delta.error.current) || 'UNKNOWN';
        const canRetry = !batch.cancelled && item.attempts <= MAX_RETRIES &&
          RETRYABLE.some(t => err.startsWith(t));
        if (canRetry) {
          item.state = 'retrying';
          await launch(item);
        } else if (batch.cancelled) {
          item.state = 'cancelled';
        } else {
          item.state = 'failed';
          item.error = err;
        }
      } else {
        item.state = delta.state.current;
      }
      if (prev !== item.state) await persist();
      // Keep the worker alive while downloads are running: pending events.
      if (batch && !batch.items.some(i => ['inProgress', 'retrying', 'queued', 'interrupted'].includes(i.state))) {
        activeIds.clear();
      }
    }
  }

  async function cancelBatch() {
    if (!batch) return;
    batch.cancelled = true;
    for (const [id] of activeIds) {
      try { await chrome.downloads.cancel(id); } catch (e) { /* already finished */ }
    }
    for (const it of batch.items) {
      if (it.state === 'queued' || it.state === 'inProgress' || it.state === 'retrying') it.state = 'cancelled';
    }
    activeIds.clear();
    await persist();
  }

  // --- persistence so a worker restart doesn't lose batch state ----------------
  async function persist() {
    if (!batch) return;
    try {
      await chrome.storage.session.set({
        [BATCH_KEY]: {
          cancelled: batch.cancelled,
          startedAt: batch.startedAt,
          items: batch.items.map(i => ({
            url: i.url, filename: i.filename, baseName: i.baseName,
            state: i.state, error: i.error, attempts: i.attempts, downloadId: i.downloadId
          }))
        }
      });
    } catch (e) { /* storage quota: status is best-effort */ }
  }

  async function restore() {
    try {
      const stored = (await chrome.storage.session.get(BATCH_KEY))[BATCH_KEY];
      if (!stored || !Array.isArray(stored.items)) return;
      batch = { items: stored.items.map(i => Object.assign({}, i)), taken: new Set(), cancelled: !!stored.cancelled, startedAt: stored.startedAt };
      bindListeners();
      for (const it of batch.items) {
        if (it.downloadId != null && ['inProgress', 'retrying', 'interrupted'].includes(it.state)) {
          activeIds.set(it.downloadId, it);
        }
      }
    } catch (e) { /* nothing to restore */ }
  }

  root.Downloader = { startBatch, cancelBatch, getStatus, restore };
})(self);
