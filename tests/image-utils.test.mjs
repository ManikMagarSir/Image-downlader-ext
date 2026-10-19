// Node unit tests for image-utils.js  —  run: node --test tests/
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const IU = require('../image-utils.js');

test('normalizeImageUrl resolves relative URLs and drops fragments only', () => {
  const u = IU.normalizeImageUrl('photo.jpg?a=1#sec', 'https://ex.com/dir/page.html');
  assert.equal(u, 'https://ex.com/dir/photo.jpg?a=1');
  assert.equal(IU.normalizeImageUrl('mailto:a@b.com', 'https://ex.com/'), null);
  assert.equal(IU.normalizeImageUrl('', 'https://ex.com/'), null);
  assert.equal(IU.normalizeImageUrl('javascript:void(0)', 'https://ex.com/'), null);
  const d = IU.normalizeImageUrl('data:image/png;base64,AAA', 'https://ex.com/');
  assert.equal(d, 'data:image/png;base64,AAA');
  // absolute URL with null/undefined base must not throw (background path)
  assert.equal(IU.normalizeImageUrl('http://localhost:1/img.png', null), 'http://localhost:1/img.png');
  assert.equal(IU.normalizeImageUrl('https://ex.com/i.webp#x', undefined), 'https://ex.com/i.webp');
});

test('query parameters are preserved (auth/transform safety)', () => {
  const u = IU.normalizeImageUrl('https://ex.com/i.png?token=abc&fit=crop', undefined);
  assert.match(u, /token=abc&fit=crop/);
});

test('extension and format detection', () => {
  assert.equal(IU.extensionOf('https://ex.com/a.jpeg?x=1'), 'jpeg');
  assert.equal(IU.extensionOf('https://ex.com/a.WEBP'), 'webp');
  assert.equal(IU.extensionOf('https://ex.com/a.avif'), 'avif');
  assert.equal(IU.extensionOf('https://ex.com/noext'), null);
  assert.equal(IU.extensionOf('data:image/svg+xml;base64,AAA'), 'svg');
  assert.equal(IU.formatOf('https://ex.com/a.png'), 'PNG');
  assert.equal(IU.formatOf('https://ex.com/a.xyz'), 'Other');
});

test('isLikelyImageUrl', () => {
  assert.equal(IU.isLikelyImageUrl('https://ex.com/fullsize.jpg?v=2'), true);
  assert.equal(IU.isLikelyImageUrl('https://ex.com/page.html'), false);
});

test('parseSrcset handles widths, heights, commas and junk', () => {
  const s = IU.parseSrcset('a.jpg 320w, b.jpg 640w, "c.jpg" 100h, , junk', 'https://ex.com/dir/p');
  const names = s.map(e => e.url.split('/').pop());
  assert.deepEqual(names, ['a.jpg', 'b.jpg', 'c.jpg', 'junk'], 'absolute URLs from base, quotes stripped');
  assert.equal(s[0].w, 320);
  assert.equal(s[1].w, 640);
  assert.equal(s[2].h, 100);
  assert.equal(IU.bestSrcsetEntry(s).url.endsWith('b.jpg'), true);
});

test('dedupe merges same URL and keeps distinct URLs apart', () => {
  const a = { url: 'https://ex.com/x.png', sourceType: 'img', naturalWidth: 100, naturalHeight: 50 };
  const b = { url: 'https://ex.com/x.png', sourceType: 'css-inline' };
  const c = { url: 'https://ex.com/y.png', sourceType: 'img' };
  const out = IU.dedupeRecords([a, b, c]);
  assert.equal(out.length, 2);
  const merged = out.find(r => r.url === 'https://ex.com/x.png');
  assert.deepEqual(merged.sourceTypes.sort(), ['css-inline', 'img']);
  assert.equal(merged.naturalWidth, 100);
});

test('dedupe does not merge distinct images with same filename', () => {
  const out = IU.dedupeRecords([
    { url: 'https://a.com/img/x.png', sourceType: 'img' },
    { url: 'https://b.com/img/x.png', sourceType: 'img' }
  ]);
  assert.equal(out.length, 2);
});

test('sanitizeFilename strips illegal characters', () => {
  const clean = IU.sanitizeFilename('photo<>:"/\\|?*.png');
  assert.equal(/[<>:"/\\|?*]/.test(clean), false);
  assert.ok(clean.endsWith('.png'));
  assert.equal(IU.sanitizeFilename('...'), 'image');
});

test('baseFilename keeps extension and truncates long stems', () => {
  assert.equal(IU.baseFilename('https://ex.com/path/cool%20pic.webp?v=3'), 'cool pic.webp');
  assert.equal(IU.baseFilename('https://ex.com/path/noext?x=1'), 'noext', 'no extension invented');
  const long = IU.baseFilename('https://ex.com/' + 'a'.repeat(200) + '.jpg');
  assert.equal(long.length <= 80 + 4, true);
});

test('uniqueFilename appends counters without collision', () => {
  const taken = new Set(['a.jpg', 'a (1).jpg']);
  assert.equal(IU.uniqueFilename('a.jpg', taken), 'a (2).jpg');
  assert.equal(IU.uniqueFilename('b.jpg', taken), 'b.jpg');
});

test('tracking pixel heuristic only fires for known small dimensions', () => {
  assert.equal(IU.isTrackingPixel({ naturalWidth: 1, naturalHeight: 1 }), true);
  assert.equal(IU.isTrackingPixel({ naturalWidth: 300, naturalHeight: 2 }), false);
  assert.equal(IU.isTrackingPixel({}), false, 'unknown dimensions are kept');
});

test('sorting modes order records as documented', () => {
  const recs = [
    { url: 'https://ex.com/small.png', naturalWidth: 100, naturalHeight: 100 },
    { url: 'https://ex.com/big.png', naturalWidth: 2000, naturalHeight: 2000 },
    { url: 'https://ex.com/mid.jpg', naturalWidth: 800, naturalHeight: 600 }
  ];
  assert.equal(IU.sortRecords(recs, 'largest')[0].url.includes('big'), true);
  assert.equal(IU.sortRecords(recs, 'smallest')[0].url.includes('small'), true);
  assert.equal(IU.sortRecords(recs, 'name')[0].url.includes('big'), true);
});

test('search matches filename and URL substrings', () => {
  const r = { url: 'https://cdn.ex.com/img/2024/photo-cat_640.png' };
  assert.equal(IU.searchMatches(r, 'photo-cat'), true);
  assert.equal(IU.searchMatches(r, 'CDN.EX.COM'), true);
  assert.equal(IU.searchMatches(r, 'dog'), false);
  assert.equal(IU.searchMatches(r, ''), true);
});

test('resolutionClass buckets by pixel count', () => {
  assert.equal(IU.resolutionClass({ naturalWidth: 4000, naturalHeight: 3000 }), 'large');
  assert.equal(IU.resolutionClass({ naturalWidth: 1024, naturalHeight: 768 }), 'medium');
  assert.equal(IU.resolutionClass({ naturalWidth: 200, naturalHeight: 100 }), 'small');
  assert.equal(IU.resolutionClass({}), 'unknown');
});
