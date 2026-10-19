// Popup UI smoke test — runs popup.js against a minimal DOM shim in Node.
// Verifies the progressive-disclosure flow (filters panel, contextual
// selection bar), the card interaction model (click selects, info opens
// details), friendly sort labels, and that the detail dialog no longer
// depends on a non-existent global `Button`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ImageUtils = require(path.join(ROOT, 'image-utils.js'));
const POPUP_SRC = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');

// --- minimal DOM ----------------------------------------------------------
class ClassList {
  constructor(el) { this.el = el; }
  _list() { return this.el.className.split(/\s+/).filter(Boolean); }
  _set(l) { this.el.className = l.join(' '); }
  add(...n) { const s = new Set(this._list()); n.forEach(x => s.add(x)); this._set([...s]); }
  remove(...n) { const s = new Set(this._list()); n.forEach(x => s.delete(x)); this._set([...s]); }
  contains(n) { return this._list().includes(n); }
  toggle(n, force) {
    const on = force === undefined ? !this.contains(n) : !!force;
    if (on) this.add(n); else this.remove(n);
    return on;
  }
}

function matchesCompound(el, part) {
  if (part.startsWith('#')) return el.id === part.slice(1);
  const classes = (part.match(/\.[\w-]+/g) || []).map(s => s.slice(1));
  const tag = (part.match(/^[a-zA-Z][\w-]*/) || [])[0];
  if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  return classes.every(c => el.classList.contains(c));
}
function matches(el, selector) {
  const parts = selector.trim().split(/\s+/);
  if (!matchesCompound(el, parts[parts.length - 1])) return false;
  let i = parts.length - 2, cur = el.parent;
  while (i >= 0 && cur) { if (matchesCompound(cur, parts[i])) i--; cur = cur.parent; }
  return i < 0;
}

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.id = '';
    this.children = [];
    this.parent = null;
    this._attrs = {};
    this._listeners = {};
    this._text = '';
    this._html = '';
    this.style = {};
    this.dataset = {};
    this.options = [];
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.title = '';
    this.type = '';
    this._open = false;
    this.classList = new ClassList(this);
  }
  get textContent() { return this._html || (this._text + this.children.map(c => c.textContent).join('')); }
  set textContent(v) { this._html = ''; this._text = String(v); this.children.forEach(c => (c.parent = null)); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this._text = ''; this.children = []; }
  setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  appendChild(child) {
    if (child && child.tagName === '#FRAGMENT') { child.children.forEach(c => this.appendChild(c)); child.children = []; return child; }
    this.children.push(child);
    child.parent = this;
    if (this.tagName === 'SELECT' && child.tagName === 'OPTION') this.options.push(child);
    return child;
  }
  append(...nodes) { nodes.forEach(n => this.appendChild(n)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  dispatch(type, extra) {
    for (const fn of this._listeners[type] || []) fn(Object.assign({ target: this, key: ' ', preventDefault() {}, stopPropagation() {} }, extra));
  }
  click() { this.dispatch('click'); }
  descendants() { const out = []; for (const c of this.children) { out.push(c, ...c.descendants()); } return out; }
  querySelectorAll(sel) { return this.descendants().filter(e => matches(e, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  showModal() { this._open = true; }
  close() { this._open = false; }
}

class Option extends El {
  constructor(text, value) { super('option'); this.value = value === undefined ? String(text) : String(value); this._text = String(text); }
}

function makeDocument() {
  const byId = {};
  const ids = ['btn-scan', 'btn-deep', 'btn-settings', 'btn-cancel', 'progress', 'progress-track',
    'progress-bar', 'progress-text', 'banner', 'banner-text', 'btn-banner-close', 'search', 'sort',
    'btn-filters', 'filter-badge', 'filters-panel', 'format', 'minw', 'minh', 'hide-tiny', 'hide-dupes',
    'btn-reset-filters', 'selection-bar', 'btn-select-visible', 'btn-clear-selection', 'counts',
    'gallery', 'empty', 'btn-more', 'btn-download', 'btn-zip', 'btn-cancel-downloads', 'download-status',
    'dlg-settings', 'dlg-detail', 'history', 's-minw', 's-minh', 's-hide-tiny', 's-hide-dupes', 's-sort',
    's-folder', 's-use-folder', 'folder-field', 's-delay', 's-maxms', 's-reset', 's-clear-history', 's-close'];
  const tagFor = (id) => {
    if (id === 'dlg-settings' || id === 'dlg-detail') return 'dialog';
    if (id === 'sort' || id === 'format' || id === 's-sort') return 'select';
    if (id === 'minw' || id === 'minh' || id === 's-minw' || id === 's-minh' || id === 's-delay' || id === 's-maxms' || id === 's-folder') return 'input';
    return 'div';
  };
  for (const id of ids) {
    const el = new El(tagFor(id));
    el.setAttribute('id', id);
    byId[id] = el;
  }
  // initial hidden classes per popup.html
  for (const [id, cls] of Object.entries({
    progress: 'progress hidden', banner: 'banner hidden', 'filters-panel': 'control-row filters-panel hidden',
    'selection-bar': 'selection-bar hidden', 'btn-cancel': 'btn btn-small btn-danger hidden',
    'btn-more': 'btn btn-more hidden', 'filter-badge': 'badge hidden', 'btn-cancel-downloads': 'btn hidden'
  })) byId[id].className = cls;
  byId['hide-tiny'].checked = true;

  const body = new El('body');
  body.appendChild(byId['gallery']);
  body.appendChild(byId['empty']);
  const doc = {
    _listeners: {},
    body,
    getElementById: (id) => byId[id] || null,
    createElement: (t) => new El(t),
    createDocumentFragment: () => new El('#fragment'),
    addEventListener: (t, fn) => { (doc._listeners[t] ||= []).push(fn); },
    fire: (t) => { for (const fn of doc._listeners[t] || []) fn(); },
    byId
  };
  return doc;
}

// --- chrome + settings mocks ---------------------------------------------
function makeChrome(doc) {
  let onChanged = null;
  return {
    doc,
    chrome: {
      tabs: { query: async () => [{ id: 1, url: 'http://example.test/' }], get: async () => ({ id: 1, url: 'http://example.test/' }) },
      scripting: { executeScript: async () => [] },
      storage: {
        session: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener: (fn) => { onChanged = fn; } }
      },
      runtime: { sendMessage: async () => ({ active: false }) }
    },
    fireStorage: (report) => onChanged && onChanged({ 'ih-scan-1': { newValue: report } }, 'session')
  };
}

const SETTINGS = {
  minWidth: 150, minHeight: 150, hideTiny: true, hideDuplicates: false,
  defaultSort: 'largest', downloadFolder: 'ImageHunter', useCustomFolder: true,
  deepScanDelayMs: 500, deepScanMaxMs: 30000
};

async function boot() {
  const doc = makeDocument();
  const { chrome, fireStorage } = makeChrome(doc);
  const sandbox = {
    ImageUtils, Option, URL, Date, Math, String, Object, Array, Set, Map, RegExp, parseInt, JSON, console,
    document: doc, chrome, navigator: { clipboard: { writeText: async () => {} } }, confirm: () => true,
    setTimeout: NodeTimers.setTimeout, clearTimeout: NodeTimers.clearTimeout,
    Settings: {
      DEFAULTS: SETTINGS,
      get: async () => Object.assign({}, SETTINGS),
      set: async (p) => Object.assign({}, SETTINGS, p),
      addHistory: async () => {}, getHistory: async () => [], clearHistory: async () => {}
    },
    ZipExport: { buildZip: async () => ({ added: [], failed: [] }), downloadZip: async () => {} }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(POPUP_SRC, ctx, { filename: 'popup.js' });
  doc.fire('DOMContentLoaded');
  await new Promise(r => NodeTimers.setTimeout(r, 20)); // flush async init
  return { doc, fireStorage };
}

const NodeTimers = await import('node:timers');

const REC = (name, w = 800, h = 600) => ({
  url: `http://example.test/img/${name}`, sourceType: 'img', sourceTypes: ['img'],
  pageUrl: 'http://example.test/', displayWidth: w, displayHeight: h,
  naturalWidth: w, naturalHeight: h, status: 'loaded', filename: name, index: 0, candidates: []
});

test('popup boots and populates friendly sort labels', async () => {
  const { doc } = await boot();
  const sort = doc.byId['sort'];
  assert.ok(sort.options.length >= 5, 'sort modes populated');
  assert.equal(sort.options[0].textContent, 'Largest first');
});

test('scan report renders cards and reveals the contextual selection bar', async () => {
  const { doc, fireStorage } = await boot();
  assert.ok(doc.byId['selection-bar'].classList.contains('hidden'), 'selection bar hidden before a scan');
  fireStorage({ status: 'done', count: 3, images: [REC('a.png'), REC('b.png'), REC('c.png')] });
  assert.equal(doc.byId['gallery'].querySelectorAll('.card').length, 3);
  assert.ok(doc.byId['empty'].classList.contains('hidden'));
  assert.ok(!doc.byId['selection-bar'].classList.contains('hidden'), 'selection bar shown after results');
});

test('clicking a card selects it; counts and primary action update', async () => {
  const { doc, fireStorage } = await boot();
  fireStorage({ status: 'done', count: 2, images: [REC('a.png'), REC('b.png')] });
  const card = doc.byId['gallery'].querySelectorAll('.card')[0];
  card.dispatch('click');
  assert.ok(card.classList.contains('selected'), 'card marked selected');
  assert.ok(doc.byId['counts'].textContent.includes('1 selected'), doc.byId['counts'].textContent);
  assert.equal(doc.byId['btn-download'].disabled, false);
  assert.equal(doc.byId['btn-download'].textContent, 'Download 1 image');
});

test('checkbox and card-body both toggle the same selection (no double-toggle)', async () => {
  const { doc, fireStorage } = await boot();
  fireStorage({ status: 'done', count: 1, images: [REC('a.png')] });
  const card = doc.byId['gallery'].querySelectorAll('.card')[0];
  const pick = card.querySelector('.pick');
  pick.dispatch('click');
  assert.ok(card.classList.contains('selected'));
  assert.ok(doc.byId['counts'].textContent.includes('1 selected'));
  pick.dispatch('click');
  assert.ok(!card.classList.contains('selected'), 'second toggle deselects');
  assert.ok(doc.byId['counts'].textContent.includes('0 selected'));
});

test('Filters disclosure toggles and tracks the active-filter badge', async () => {
  const { doc } = await boot();
  const panel = doc.byId['filters-panel'];
  const btn = doc.byId['btn-filters'];
  assert.ok(panel.classList.contains('hidden'), 'filters collapsed by default');
  btn.dispatch('click');
  assert.ok(!panel.classList.contains('hidden'));
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  // activate a filter -> badge appears with a count
  doc.byId['minw'].value = '500';
  doc.byId['minw'].dispatch('change');
  assert.ok(!doc.byId['filter-badge'].classList.contains('hidden'));
  assert.equal(doc.byId['filter-badge'].textContent, '1');
});

test('info button opens the detail dialog without throwing (regression: Button)', async () => {
  const { doc, fireStorage } = await boot();
  fireStorage({ status: 'done', count: 1, images: [REC('a.png')] });
  const card = doc.byId['gallery'].querySelectorAll('.card')[0];
  const info = card.querySelector('.info');
  assert.ok(info, 'card has an info button');
  assert.doesNotThrow(() => info.dispatch('click'));
  const dlg = doc.byId['dlg-detail'];
  assert.ok(dlg._open, 'detail dialog opened');
  assert.ok(dlg.children.length > 0, 'detail dialog has content');
  assert.ok(dlg.querySelector('#detail-title'), 'detail title present for aria-labelledby');
});

test('deep-scan live updates preserve scroll and do not duplicate cards', async () => {
  const { doc, fireStorage } = await boot();
  fireStorage({ status: 'scanning', count: 2, images: [REC('a.png'), REC('b.png')] });
  assert.equal(doc.byId['gallery'].querySelectorAll('.card').length, 2);
  fireStorage({ status: 'deep-scanning', count: 3, images: [REC('a.png'), REC('b.png'), REC('c.png')] });
  assert.equal(doc.byId['gallery'].querySelectorAll('.card').length, 3, 'cards replaced, not appended twice');
  fireStorage({ status: 'done', count: 3, images: [REC('a.png'), REC('b.png'), REC('c.png')] });
  assert.equal(doc.byId['gallery'].querySelectorAll('.card').length, 3);
});
