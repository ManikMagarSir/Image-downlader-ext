// Image Hunter — local preferences and download history (chrome.storage.local).
'use strict';
(function (root) {
  const DEFAULTS = {
    minWidth: 150,
    minHeight: 150,
    hideTiny: true,
    hideDuplicates: false, // exact-URL dedupe is always on; query-variant
                          // collapsing must be opt-in (?v=2 is a real image)
    defaultSort: 'largest',
    downloadFolder: 'ImageHunter',
    useCustomFolder: true,
    deepScanDelayMs: 500,
    deepScanMaxMs: 30000
  };
  const HISTORY_KEY = 'ih-history';
  const HISTORY_LIMIT = 500;

  async function get() {
    const stored = await chrome.storage.local.get('ih-settings');
    return Object.assign({}, DEFAULTS, stored['ih-settings'] || {});
  }

  async function set(patch) {
    const cur = await get();
    const next = Object.assign(cur, patch);
    await chrome.storage.local.set({ 'ih-settings': next });
    return next;
  }

  async function addHistory(entries) {
    const stored = await chrome.storage.local.get(HISTORY_KEY);
    const hist = stored[HISTORY_KEY] || [];
    for (const e of entries) {
      hist.unshift({
        url: String(e.url || '').slice(0, 2000),
        filename: String(e.filename || '').slice(0, 300),
        status: String(e.status || 'complete').slice(0, 20),
        time: Date.now()
      });
    }
    await chrome.storage.local.set({ [HISTORY_KEY]: hist.slice(0, HISTORY_LIMIT) });
  }

  async function getHistory() {
    const stored = await chrome.storage.local.get(HISTORY_KEY);
    return stored[HISTORY_KEY] || [];
  }

  async function clearHistory() {
    await chrome.storage.local.remove(HISTORY_KEY);
  }

  root.Settings = { DEFAULTS, get, set, addHistory, getHistory, clearHistory };
})(self);
