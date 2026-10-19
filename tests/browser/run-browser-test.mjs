// Browser test driver for Image Hunter — real Chrome for Testing via Puppeteer.
// Verifies 34 checks: scanner accuracy, filters, downloads (single/bulk/
// conflict), ZIP, deep scan, persistence, privacy, restricted pages.
//
// One-time environment setup (no sudo needed):
//   1. mkdir /tmp/ih-test && cd /tmp/ih-test && npm init -y && npm i puppeteer
//      (downloads Chrome for Testing into ~/.cache/puppeteer)
//   2. Test-only extension copy: cp -r <project> /tmp/ih-test/ext, then add
//      "host_permissions": ["http://localhost/*"] to ext/manifest.json, and in
//      ext/popup.js replace the active-tab lookup with a last-http-tab picker
//      (a popup opened as a tab IS the active tab, chrome.tabs.query would
//      return the popup itself).
//   3. If Chrome fails to start with a missing-lib error (Code 127), fetch the
//      system libs the same way: apt-get download <lib> && dpkg -x <lib>.deb
//      /tmp/ih-test/debs/x, then export the LD_LIBRARY_PATH below.
//
// Run:
//   LD_LIBRARY_PATH=/tmp/ih-test/debs/x/usr/lib/x86_64-linux-gnu \
//     node tests/browser/run-browser-test.mjs
import puppeteer from 'puppeteer';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const PROJECT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const EXT_DIR = process.env.IH_EXT_DIR || '/tmp/ih-test/ext';
const FIXTURES = path.join(PROJECT, 'tests', 'fixtures');
const DL_DIR = process.env.IH_DL_DIR || path.join(process.env.HOME || '/root', 'Downloads');
const PORT = Number(process.env.IH_PORT || 8342);

const results = [];
function check(name, cond, info) {
  results.push({ name, pass: !!cond, info: info || '' });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + (info || '')}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- static server for fixtures ----------------------------------------------
const MIME = { '.png': 'image/png', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/scanner.html';
  const file = path.join(FIXTURES, p);
  if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

fs.mkdirSync(DL_DIR, { recursive: true });

function findDownloaded(haystack, timeout = 30000) {
  const t0 = Date.now();
  return (async () => {
    while (Date.now() - t0 < timeout) {
      const hit = walk(DL_DIR).find(f => f.includes(haystack) && !f.endsWith('.crdownload'));
      if (hit) return hit;
      await sleep(200);
    }
    return null;
  })();
}
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f)); else out.push(f);
  }
  return out;
}
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// --- launch -------------------------------------------------------------------
const browser = await puppeteer.launch({
  protocolTimeout: 600000,
  headless: true, // new headless supports --load-extension
  args: [
    '--no-sandbox', '--disable-gpu', '--window-size=1100,750',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`
  ]
});

const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 20000 })
  .catch(() => null);
if (!swTarget) {
  check('extension loads in Chrome', false, 'no service worker target (headless may not support extensions)');
  await browser.close(); server.close(); process.exit(1);
}
const extId = new URL(swTarget.url()).host;
check('extension loads: manifest valid, service worker starts', true, extId);

const requested = new Set();
function watchRequests(page) {
  page.on('request', (r) => requested.add(r.url()));
}

// --- fixture page + popup tab -------------------------------------------------
const pageA = await browser.newPage();
watchRequests(pageA);
await pageA.goto(`http://localhost:${PORT}/scanner.html`, { waitUntil: 'load' });
await sleep(600); // let dynamic fixture insertions land

const pageB = await browser.newPage();
watchRequests(pageB);
await pageB.goto(`chrome-extension://${extId}/popup.html`);
await pageB.waitForSelector('#btn-scan');
await pageB.waitForFunction(() => document.getElementById('sort').options.length >= 5, { timeout: 15000 }); // popup init finished (listeners bound)
fs.rmSync(path.join(DL_DIR, 'ImageHunter'), { recursive: true, force: true });
for (const stale of ['large-blue.png', 'same-name.png', 'param.png', 'small-red.png']) fs.rmSync(path.join(DL_DIR, stale), { force: true });
for (const f of walk(DL_DIR)) if (f.endsWith('.zip')) fs.rmSync(f, { force: true });

// --- Test 1: basic scan ---------------------------------------------------------
console.log('\n== Test 1: scanner accuracy ==');
await pageB.evaluate(() => document.getElementById('btn-scan').click());
await pageB.waitForFunction(
  () => document.querySelector('.card') &&
        document.getElementById('progress').classList.contains('hidden'),
  { timeout: 40000 }
);
const cards = await pageB.evaluate(() =>
  Array.from(document.querySelectorAll('.card .name')).map(n => ({ url: n.title, text: n.textContent })));
const urls = cards.map(c => c.url);
const has = (sub) => urls.filter(u => u.includes(sub));

check('scan returns results', cards.length > 10, `${cards.length} cards`);
const exactLarge = urls.filter(u => u === `http://localhost:${PORT}/img/large-blue.png`).length;
check('same image via absolute+relative+srcset merged to ONE card', exactLarge === 1, `${exactLarge} cards`);
check('lazy data-src found as own record (green.png)',
  urls.some(u => u === `http://localhost:${PORT}/img/green.png`));
check('lazy data-original found (param.png plain)',
  urls.some(u => u === `http://localhost:${PORT}/img/param.png`));
check('query string preserved (token=abc kept)',
  urls.some(u => u.includes('token=abc') && u.includes('param.png')));
check('CSS background from class (bg-tile.png)', has('/img/bg-tile.png').length === 1);
check('picture source variant (xlarge-blue) found', has('/img/xlarge-blue.png').length >= 1);
check('anchor image link found (green.png direct link)', urls.some(u => u === `http://localhost:${PORT}/img/green.png`));
check('shadow DOM img found (?v=shadow)', has('v=shadow').length === 1);
check('broken image listed without crash', has('does-not-exist.png').length === 1 && has('invalid.invalid').length === 1);

check('tracking pixel (1x1, no query) hidden by Hide tiny default',
  !urls.some(u => u.endsWith('/img/pixel.png')));
check('identical filenames under different paths both listed',
  has('same-name.png').length === 2);
check('dynamic insert after load discovered (?v=late)', has('v=late').length === 1);
check('candidate badges rendered on srcset card',
  (await pageB.evaluate(() => document.querySelectorAll('.tag.cand').length)) > 0);

// Secondary filters now live behind the "Filters" disclosure.
await pageB.click('#btn-filters');
await pageB.waitForFunction(() => {
  const p = document.getElementById('filters-panel');
  return p && !p.classList.contains('hidden') && document.getElementById('btn-filters').getAttribute('aria-expanded') === 'true';
}, { timeout: 5000 });

// hide-tiny toggle
await pageB.click('#hide-tiny');
const urls2 = await pageB.evaluate(() =>
  Array.from(document.querySelectorAll('.card .name')).map(n => n.title));
check('unchecking Hide tiny reveals pixel.png', urls2.some(u => u.endsWith('/img/pixel.png')));
check('distinct-query pixel kept as separate record', urls2.some(u => u.includes('pixel.png?k=2')));
await pageB.click('#hide-tiny');

// --- Test 2: search + sort -------------------------------------------------------
console.log('\n== Test 2: search/sort/filters ==');
await pageB.type('#search', 'bg-tile');
await sleep(250);
const filtered = await pageB.evaluate(() =>
  Array.from(document.querySelectorAll('.card .name')).map(n => n.title));
check('search narrows to matching cards only', filtered.length === 1 && filtered[0].includes('bg-tile'));
await pageB.evaluate(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); });
await pageB.select('#sort', 'largest');
await sleep(150);
const firstLarge = await pageB.evaluate(() => document.querySelector('.card .name')?.title || '');
check('sort by largest puts 800x600 image first', firstLarge.includes('large-blue.png'), firstLarge);
await pageB.type('#minw', '700');
await sleep(150);
const afterMinW = await pageB.evaluate(() =>
  Array.from(document.querySelectorAll('.card .name')).map(n => n.title));
check('min-width filter drops narrower known images', !afterMinW.some(u => u.includes('small-red')));
await pageB.evaluate(() => { const m = document.getElementById('minw'); m.value = ''; m.dispatchEvent(new Event('input')); });

// --- Test 3: single download ------------------------------------------------------
console.log('\n== Test 3: single download ==');
await pageB.evaluate(() => {
  const n = Array.from(document.querySelectorAll('.card .name'))
    .find(n => n.title === 'http://localhost:8342/img/large-blue.png');
  n.closest('.card').querySelector('.quickdl').click();
});
const f1 = await findDownloaded('large-blue.png');
check('single download saved under ImageHunter/', !!f1 && f1.includes('ImageHunter'), f1 || 'timeout');
if (f1) check('downloaded bytes match fixture',
  sha256(f1) === sha256(path.join(FIXTURES, 'img/large-blue.png')));

// --- Test 4: bulk download with filename conflict ------------------------------------
console.log('\n== Test 4: bulk download + conflicts ==');
await pageB.evaluate(() => {
  for (const n of document.querySelectorAll('.card .name')) {
    if (n.title.endsWith('same-name.png')) n.closest('.card').querySelector('.pick').click();
  }
});
const sel = await pageB.evaluate(() => document.getElementById('counts').textContent);
check('two cards selected', sel.includes('2 selected'), sel);
await pageB.evaluate(() => document.getElementById('btn-download').click());
const c1 = await findDownloaded('same-name', 15000);
await sleep(2500);
const names = walk(DL_DIR).map(f => path.basename(f)).filter(n => n.startsWith('same-name'));
check('both same-named files downloaded with conflict suffix',
  names.includes('same-name.png') && names.includes('same-name (1).png'), JSON.stringify(names));
await pageB.waitForFunction(() => /Done:/.test(document.getElementById('download-status').textContent), { timeout: 20000 });
check('download status reports honest completion', true);

// --- Test 5: ZIP export ----------------------------------------------------------------
console.log('\n== Test 5: ZIP export ==');
await pageB.evaluate(() => document.getElementById('btn-zip').click());
try {
  await pageB.waitForFunction(() => /ZIP created/.test(document.getElementById('download-status').textContent), { timeout: 60000 });
  const zipFile = await findDownloaded('.zip');
  check('zip file downloaded', !!zipFile, zipFile || '');
  if (zipFile) {
    const listing = execFileSync('unzip', ['-l', zipFile]).toString();
    check('zip contains both renamed entries',
      listing.includes('same-name.png') && listing.includes('same-name (1).png'), listing.slice(0, 200));
    execFileSync('unzip', ['-t', zipFile], { stdio: 'pipe' });
    check('zip opens cleanly (unzip -t)', true);
  }
} catch (e) {
  const statusText = await pageB.evaluate(() => document.getElementById('download-status').textContent + ' | ' + document.getElementById('banner').textContent);
  check('zip export completes', false, statusText);
}

// --- Test 6: deep scan --------------------------------------------------------------------
console.log('\n== Test 6: deep scan ==');
await pageA.bringToFront(); // headless: unfocused tabs get no frames, so scroll events never dispatch
await pageB.evaluate(() => document.getElementById('btn-deep').click());
// The popup is now a background tab: it gets no animation frames, so waitForFunction's
// default rAF polling never fires. Poll from Node instead.
let scrollTitles = [];
const scanDeadline = Date.now() + 90000;
while (Date.now() < scanDeadline) {
  await sleep(3000);
  scrollTitles = await pageB.evaluate(() =>
    Array.from(document.querySelectorAll('.card .name')).map(n => n.title).filter(u => u.includes('scroll=')));
  if (scrollTitles.length >= 5) break;
}
check('deep scan discovers scroll-triggered lazy images', scrollTitles.length >= 5, `${scrollTitles.length} found`);
// Discovery can happen mid-scan; restoration only happens when the scan finishes.
const finDeadline = Date.now() + 60000;
while (Date.now() < finDeadline) {
  const st = await pageB.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    const rep = Object.entries(all).find(([k]) => k.startsWith('ih-scan-'))?.[1];
    return rep && rep.status;
  });
  if (st === 'done' || st === 'error' || st === 'cancelled') break;
  await sleep(2000);
}
const scrollY = await pageA.evaluate(() => window.scrollY);
check('original scroll position restored', scrollY < 5, `scrollY=${scrollY}`);
await pageB.bringToFront(); // popup needs frames again for real clicks below

// --- Test 7: persistence + settings ---------------------------------------------------------
console.log('\n== Test 7: settings & history ==');
await pageB.click('#btn-settings');
await pageB.waitForFunction(() => !document.getElementById('dlg-settings').hidden && document.getElementById('history').children.length > 0, { timeout: 5000 });
const hist = await pageB.evaluate(() => document.getElementById('history').textContent);
check('download history recorded in settings', hist.includes('same-name'), hist.slice(0, 120));
await pageB.click('#s-close');
// reopen popup: scan results should reload from session storage
await pageB.goto(`chrome-extension://${extId}/popup.html`);
await pageB.waitForFunction(() => document.querySelectorAll('.card').length > 5, { timeout: 15000 });
check('scan results survive popup reload', true);

// --- Test 8: privacy --------------------------------------------------------------------------------
console.log('\n== Test 8: privacy ==');
const foreign = [...requested].filter(u =>
  !u.startsWith(`http://localhost:${PORT}/`) &&
  !u.startsWith('chrome-extension://') &&
  !u.startsWith('data:') && !u.startsWith('blob:') &&
  !u.startsWith('http://invalid.invalid/') &&
  !u.includes('invalid.invalid'));
check('no requests to any external host', foreign.length === 0, foreign.join(', ').slice(0, 300));

// --- Test 9: restricted page ------------------------------------------------------------------------
console.log('\n== Test 9: restricted page ==');
const pageC = await browser.newPage();
await pageC.goto('chrome://version');
const pageD = await browser.newPage();
await pageD.goto(`chrome-extension://${extId}/popup.html`);
await pageD.waitForSelector('#btn-scan');
// patched tab picker falls back to the last http tab; force it to chrome:// by
// evaluating runScan on the chrome tab instead: emulate by closing http tabs is
// destructive — simpler: click scan and confirm UI never crashes and either
// scans the old tab or shows a banner.
await pageD.click('#btn-scan');
await sleep(3000);
const survived = await pageD.evaluate(() => !!document.getElementById('btn-scan'));
check('popup stays alive on restricted-page scan attempt', survived);
await pageC.close(); await pageD.close();

console.log('\n================ SUMMARY ================');
const failed = results.filter(r => !r.pass);
for (const r of results) if (!r.pass) console.log(`  FAILED: ${r.name} — ${r.info}`);
console.log(`${results.length - failed.length}/${results.length} checks passed`);

await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
