// Image Hunter — background service worker: message routing, session storage
// access level for the content script, and download-batch state.
// Classic worker: uses importScripts so all modules stay plain scripts.
'use strict';

importScripts('image-utils.js', 'downloads.js');

const { Downloader } = self;

// Allow the injected content script to read/write chrome.storage.session.
chrome.runtime.onStartup.addListener(enableSessionAccess);
chrome.runtime.onInstalled.addListener(enableSessionAccess);
enableSessionAccess();

function enableSessionAccess() {
  try {
    chrome.storage.session.setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
    }).catch(() => {});
  } catch (e) { /* older Chrome: content script simply won't report */ }
}

// --- message routing ---------------------------------------------------------
// All inbound runtime messages are validated: known types only, plain payloads.
const ALLOWED_TYPES = new Set([
  'IH_GET_SETTINGS', 'IH_SET_SETTINGS', 'IH_HISTORY_ADD', 'IH_HISTORY_CLEAR', 'IH_HISTORY_GET',
  'IH_DOWNLOAD_BATCH', 'IH_DOWNLOAD_ONE', 'IH_CANCEL_DOWNLOADS', 'IH_DOWNLOAD_STATUS',
  'IH_SCAN_PROGRESS'
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !ALLOWED_TYPES.has(msg.type)) return false;
  try {
    switch (msg.type) {
      case 'IH_SCAN_PROGRESS':
        // Progress is delivered to the popup through chrome.storage.session;
        // the content script's message exists for logging only.
        return false;

      case 'IH_DOWNLOAD_BATCH':
      case 'IH_DOWNLOAD_ONE': {
        const items = normaliseDownloadItems(msg.payload);
        if (!items.length) { sendResponse({ ok: false, error: 'No valid items' }); break; }
        Downloader.startBatch(items, msg.payload && msg.payload.folder).then((res) => {
          sendResponse(res);
        });
        return true; // async response
      }

      case 'IH_CANCEL_DOWNLOADS':
        Downloader.cancelBatch().then(() => sendResponse({ ok: true }));
        return true;

      case 'IH_DOWNLOAD_STATUS':
        sendResponse(Downloader.getStatus());
        return false;

      default:
        return false;
    }
  } catch (e) {
    sendResponse({ ok: false, error: String(e && e.message || e) });
    return false;
  }
});

function normaliseDownloadItems(payload) {
  if (!payload || !Array.isArray(payload.items)) return [];
  const out = [];
  for (const it of payload.items) {
    if (!it || typeof it.url !== 'string') continue;
    const url = ImageUtils.normalizeImageUrl(it.url, null);
    if (!url) continue;
    out.push({
      url,
      filename: it.filename ? ImageUtils.sanitizeFilename(it.filename) : null,
      candidate: it.candidate === true
    });
  }
  return out;
}

// Rehydrate an in-flight batch after worker restart so onChanged events for
// retried/completed downloads keep being tracked.
Downloader.restore().catch(() => {});
