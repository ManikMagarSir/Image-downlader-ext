// Image Hunter — ZIP export via locally bundled JSZip (no CDN at runtime).
// Fetches image bytes from the popup context and streams them into one
// archive. Downloads of remote bytes are subject to CORS; failures are
// reported per item, never silently skipped.
'use strict';
(function (root) {
  const IU = root.ImageUtils;
  const SIZE_WARN_BYTES = 400 * 1024 * 1024; // in-browser generation gets unreliable beyond this

  async function buildZip(items, onProgress) {
    const zip = new root.JSZip();
    const taken = new Set();
    const result = { added: [], failed: [], bytes: 0, aborted: false, abortedReason: null };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (onProgress) onProgress({ phase: 'fetch', index: i, total: items.length, bytes: result.bytes });
      let blob;
      try {
        blob = await fetchBlob(item.url);
      } catch (e) {
        result.failed.push({ url: item.url, error: describeFetchError(e) });
        continue;
      }
      if (result.bytes + blob.size > SIZE_WARN_BYTES) {
        result.aborted = true;
        result.abortedReason = `Archive exceeded the ${Math.round(SIZE_WARN_BYTES / 1048576)} MB in-browser limit. Use bulk download instead.`;
        return result;
      }
      let name = item.filename || IU.baseFilename(item.url);
      name = IU.uniqueFilename(IU.sanitizeFilename(name), taken);
      taken.add(name);
      zip.file(name, blob);
      result.added.push({ url: item.url, filename: name, size: blob.size });
      result.bytes += blob.size;
    }

    if (onProgress) onProgress({ phase: 'compressing', index: items.length, total: items.length, bytes: result.bytes });
    result.blob = await zip.generateAsync(
      { type: 'blob', compression: 'STORE' }, // images are already compressed
      (meta) => onProgress && onProgress({ phase: 'compressing', percent: meta.percent })
    );
    return result;
  }

  async function fetchBlob(url) {
    const res = await fetch(url, { credentials: 'include', mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!/^image\//.test(blob.type) && blob.type !== '' && !isImageNameUrl(url)) {
      // Server lied about the type; keep it but note the mismatch later.
    }
    return blob;
  }

  function isImageNameUrl(url) {
    return IU.extensionOf(url) != null;
  }

  function describeFetchError(e) {
    const msg = String(e && e.message || e);
    if (/failed to fetch|cors|load failed/i.test(msg)) {
      return 'Blocked by cross-origin policy — download this file individually instead.';
    }
    return msg;
  }

  async function downloadZip(blob, zipName) {
    const url = URL.createObjectURL(blob);
    try {
      await new Promise((resolve, reject) => {
        chrome.downloads.download({ url, filename: IU.sanitizeFilename(zipName), saveAs: false, conflictAction: 'uniquify' },
          (id) => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(id));
      });
    } finally {
      // Revoke once the download has read the blob; a timeout is sufficient
      // in practice and keeps this simple.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  root.ZipExport = { buildZip, downloadZip, SIZE_WARN_BYTES };
})(self);
