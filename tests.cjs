// Run with: node --test tests.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function worker(legacy = {}, initial = {}) {
  let listener, failWrite = false, syncReads = 0;
  const local = { ...initial };
  const chrome = {
    runtime: { id: 'test-extension', onMessage: { addListener(fn) { listener = fn; } } },
    storage: {
      sync: { async get(defaults) { syncReads++; return { ...defaults, ...legacy }; } },
      local: {
        async get() { return plain(local); },
        async set(values) {
          if (failWrite) throw new Error('Disk full');
          Object.assign(local, plain(values));
        }
      }
    }
  };
  vm.runInNewContext(source('background.js'), { chrome });
  return {
    local,
    fail(value) { failWrite = value; },
    syncReads: () => syncReads,
    request(action, extra = {}) {
      return new Promise(resolve => listener(
        { type: 'fsb:storage', action, ...extra }, { id: chrome.runtime.id }, resolve
      ));
    }
  };
}

test('migrates sellers, keywords, and preference once; does not resurrect cleared lists', async () => {
  const w = worker({ blockedSellers: ['seller a'], blockedKeywords: ['junk'], reloadOnChange: false });
  const migrated = await w.request('load');
  assert.deepEqual(plain(migrated.settings.blockedSellers), ['seller a']);
  assert.deepEqual(plain(migrated.settings.blockedKeywords), ['junk']);
  assert.equal(migrated.settings.reloadOnChange, false);
  await w.request('save', { values: { blockedSellers: [], blockedKeywords: [] } });
  const restarted = worker({ blockedSellers: ['seller a'] }, w.local);
  assert.deepEqual(plain((await restarted.request('load')).settings.blockedSellers), []);
  assert.equal(restarted.syncReads(), 0);
});

test('concurrent first-run toggles preserve both sellers', async () => {
  const w = worker({ blockedSellers: ['old'] });
  await Promise.all([
    w.request('toggleSeller', { seller: 'first' }),
    w.request('toggleSeller', { seller: 'second' })
  ]);
  assert.deepEqual(w.local.blockedSellers, ['first', 'old', 'second']);
  assert.equal(w.syncReads(), 1);
});

test('local blocklists larger than the sync per-item limit save successfully', async () => {
  const w = worker();
  const sellers = Array.from({ length: 2000 }, (_, i) => `seller number ${i}`);
  assert.ok(Buffer.byteLength(JSON.stringify(sellers)) > 8192);
  const result = await w.request('save', { values: { blockedSellers: sellers } });
  assert.equal(result.error, undefined);
  assert.deepEqual(w.local.blockedSellers, sellers);
});

test('failed migration is retryable and never marks incomplete data as migrated', async () => {
  const w = worker({ blockedSellers: ['old'] });
  w.fail(true);
  assert.equal((await w.request('load')).error, 'Disk full');
  assert.equal(w.local.localStorageMigrated, undefined);
  w.fail(false);
  assert.deepEqual(plain((await w.request('load')).settings.blockedSellers), ['old']);
});

test('failed save preserves persisted data and does not poison subsequent requests', async () => {
  const w = worker({ blockedSellers: ['old'] });
  await w.request('load');
  w.fail(true);
  assert.equal((await w.request('toggleSeller', { seller: 'new' })).error, 'Disk full');
  assert.deepEqual(w.local.blockedSellers, ['old']);
  w.fail(false);
  assert.equal((await w.request('toggleSeller', { seller: 'new' })).error, undefined);
  assert.deepEqual(w.local.blockedSellers, ['new', 'old']);
});

test('counter observer settles instead of scheduling frames indefinitely', () => {
  const script = source('content.js');
  const counter = script.slice(script.indexOf('  const updateCounter ='), script.indexOf('  // ---------- scanning'));
  const observer = script.slice(script.indexOf('  let scheduled ='), script.indexOf('  // SPA navigation'));
  const mutations = [], frames = [];
  let callback, writes = 0, text = '';
  const element = {
    isConnected: true,
    get textContent() { return text; },
    set textContent(value) { text = value; writes++; mutations.push({ addedNodes: [{ nodeType: 3 }] }); }
  };
  const context = vm.createContext({
    document: { body: { appendChild() {} }, createElement: () => element },
    MutationObserver: class { constructor(fn) { callback = fn; } },
    requestAnimationFrame: fn => frames.push(fn), scan() {}, updateBanner() {}
  });
  vm.runInContext('let hiddenCount = 1; let counterEl = null;' + counter + observer + 'updateCounter();', context);
  for (let i = 0; i < 10 && mutations.length; i++) {
    callback(mutations.splice(0));
    frames.shift()?.();
  }
  assert.equal(writes, 1);
  assert.equal(mutations.length, 0);
  assert.equal(frames.length, 0);
});

test('banner updates seller and unblock target; unchanged state does not replace it', () => {
  const script = source('content.js');
  const bannerCode = script.slice(script.indexOf('  const updateBanner ='), script.indexOf('  // ---------- counter'));
  let banner = null, seller = 'first', keyword = null, toggled;
  function element() {
    return {
      dataset: {}, children: [], listeners: {},
      appendChild(child) { this.children.push(child); },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      remove() { if (banner === this) banner = null; }
    };
  }
  const context = vm.createContext({
    document: { body: { prepend(el) { banner = el; } }, querySelector: () => banner, createElement: element },
    blocked: new Set(['first', 'second']),
    currentPageSeller: () => seller, currentPageTitle: () => '', matchKeyword: () => keyword,
    toggleSeller: value => { toggled = value; }
  });
  vm.runInContext(bannerCode + 'updateBanner();', context);
  const first = banner;
  vm.runInContext('updateBanner()', context);
  assert.equal(banner, first);
  seller = 'second';
  vm.runInContext('updateBanner()', context);
  assert.notEqual(banner, first);
  assert.match(banner.children[0].textContent, /second/);
  banner.children[1].listeners.click();
  assert.equal(toggled, 'second');
  seller = null; keyword = 'junk';
  vm.runInContext('updateBanner()', context);
  assert.equal(banner.children.length, 1);
  assert.match(banner.children[0].textContent, /junk/);
  keyword = null;
  vm.runInContext('updateBanner()', context);
  assert.equal(banner, null);
});

test('popup rolls back failed saves, shows an error, and skips reload', async () => {
  const script = source('popup.js');
  const persist = script.slice(script.indexOf('const persist ='), script.indexOf('// Reload the active tab'));
  let busy, error, loads = 0, renders = 0, reloads = 0;
  const context = vm.createContext({
    setBusy: value => { busy = value; }, showError: value => { error = value; },
    load: async () => { loads++; }, render: () => { renders++; },
    reloadFabTab: async () => { reloads++; },
    write: async () => { throw new Error('Disk full'); }
  });
  const result = await vm.runInContext(persist + 'persist(write, true)', context);
  assert.equal(result, false);
  assert.equal(loads, 1);
  assert.equal(renders, 1);
  assert.equal(reloads, 0);
  assert.equal(busy, false);
  assert.match(error, /Could not save changes.*Disk full/);
});
