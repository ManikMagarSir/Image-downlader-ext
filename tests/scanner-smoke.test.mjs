// Headless smoke test for scanner.js collection logic with a minimal DOM stub.
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);

function makeEnv() {
  const IU = require('../image-utils.js');
  const base = 'https://fixture.test/page';

  class El {
    constructor(tag, attrs = {}, extra = {}) {
      this.tagName = tag.toUpperCase();
      this.attrs = attrs;
      this.baseURI = base;
      this.style = {};
      this.children = extra.children || [];
      Object.assign(this, extra);
      this.children = extra.children || [];
    }
    getAttribute(n) { return this.attrs[n] ?? null; }
    querySelectorAll() { return this.children; }
    closest(sel) { return this.__closest || null; }
    matches() { return false; }
  }

  const img1 = new El('img', { src: 'a.png', srcset: 'a.png 400w, b.png 1200w' },
    { currentSrc: base + '/a.png', complete: true, naturalWidth: 400, naturalHeight: 300, clientWidth: 200, clientHeight: 150 });
  const imgLazy = new El('img', { src: 'px.gif', 'data-src': 'c.png' },
    { currentSrc: base + '/px.gif', complete: true, naturalWidth: 1, naturalHeight: 1 });
  const imgPending = new El('img', { src: 'd.png' }, { complete: false });
  const imgDup = new El('img', { src: 'a.png' }, { currentSrc: base + '/a.png', complete: false });
  const imgBroken = new El('img', { src: 'missing.png' }, { complete: true, naturalWidth: 0, naturalHeight: 0 });
  const picChild = new El('img', { src: 'p.png' }, {
    currentSrc: base + '/p.png', complete: false,
    parentNode: { tagName: 'PICTURE' },
    children: [new El('source', { srcset: 'p.png 600w, pbig.png 2000w' })]
  });
  picChild.parentNode.querySelectorAll = () => picChild.children;
  picChild.parentNode.tagName = 'PICTURE';
  const anchor = { getAttribute: () => 'x.png' };
  const imgLinked = new El('img', { src: 't.png' }, { currentSrc: base + '/t.png', complete: false });
  imgLinked.__closest = anchor;

  const imgs = [img1, imgLazy, imgPending, imgDup, imgBroken, picChild, imgLinked];
  const registry = {
    'img': imgs,
    'picture source, source': picChild.children,
    'video[poster], audio[poster]': [],
    'input[type="image"][src]': [],
    'meta[property="og:image"], meta[name="twitter:image"], meta[itemprop="image"]': [],
    'a[href]': [anchor],
    '*': []
  };
  anchor.tagName = 'A';

  globalThis.self = globalThis;
  globalThis.ImageUtils = IU;
  globalThis.location = { href: base };
  globalThis.document = {
    querySelectorAll: (s) => registry[s] || [],
    styleSheets: [],
    title: 'fixture',
    documentElement: {}
  };
  globalThis.chrome = {
    storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    runtime: { sendMessage: () => Promise.resolve() }
  };

  delete require.cache[require.resolve('../scanner.js')];
  require('../scanner.js');
  return { IU, urls: (recs) => recs.map(r => r.url) };
}

test('scanner collects, dedupes, and labels candidates (smoke)', () => {
  const { IU } = makeEnv();
  const { records } = self.ImageHunterScanner.selfTest();

  const urls = records.map(r => r.url);
  // duplicates of a.png merged into one record
  assert.equal(urls.filter(u => u.endsWith('/a.png')).length, 1);
  // lazy data-src discovered even though src is a placeholder
  assert.ok(urls.some(u => u.endsWith('/c.png')));
  assert.ok(urls.some(u => u.endsWith('/d.png')));
  // picture source present
  assert.ok(urls.some(u => u.endsWith('/p.png')));
  // anchor href to image file collected
  assert.ok(urls.some(u => u.endsWith('/x.png')));

  const a = records.find(r => r.url.endsWith('/a.png'));
  assert.equal(a.naturalWidth, 400);
  assert.equal(a.status, 'loaded');
  const cand = a.candidates.map(c => c.url);
  assert.ok(cand.some(u => u.endsWith('/b.png')), 'srcset 1200w becomes a candidate');
  assert.ok(a.candidates.every(c => c.inferred === true), 'candidates labelled inferred');

  // placeholder px.gif and its real c.png coexist; pixel detectable
  const px = records.find(r => r.url.endsWith('/px.gif'));
  assert.equal(IU.isTrackingPixel(px, 50, 50), true);

  // linked thumbnail carries anchor candidate
  const t = records.find(r => r.url.endsWith('/t.png'));
  assert.ok(t.candidates.some(c => c.basis === 'anchor' && c.url.endsWith('/x.png')));
});
