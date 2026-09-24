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
        async get(requested) {
          const names = typeof requested === 'string' ? [requested] : requested;
          return plain(Object.fromEntries(names.filter(key => Object.hasOwn(local, key)).map(key => [key, local[key]])));
        },
        async set(values) {
          if (failWrite) throw new Error('Disk full');
          Object.assign(local, plain(values));
        }
      }
    }
  };
  const context = vm.createContext({ chrome, crypto: require('node:crypto').webcrypto, TextEncoder });
  context.importScripts = name => vm.runInContext(source(name), context);
  vm.runInContext(source('background.js'), context);
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
    contextInvalidated: false,
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

for (const failure of ['invalidated', 'missing runtime', 'runtime removed during send']) {
test(`disconnected content script offers refresh once and stops stale writes: ${failure}`, async () => {
  const script = source('content.js');
  const handling = script.slice(script.indexOf('  const reportError ='), script.indexOf('  // ---------- page-level'));
  let banner, writes = 0, reloads = 0, disconnects = 0, cleared, removed = 0;
  const errors = [], alerts = [];
  const context = vm.createContext({
    contextInvalidated: false, reloadOnChange: true, navigationTimer: 42,
    observer: { disconnect() { disconnects++; } },
    clearInterval(id) { cleared = id; },
    console: { error(...args) { errors.push(args); } }, alert: text => alerts.push(text),
    location: { reload() { reloads++; } },
    chrome: failure === 'missing runtime' ? {} : {
      runtime: {
        id: 'test-extension',
        async sendMessage() {
          writes++;
          if (failure === 'runtime removed during send') {
            delete context.chrome.runtime;
            throw new TypeError("Cannot read properties of undefined (reading 'sendMessage')");
          }
          throw new Error('Extension context invalidated.');
        }
      }
    },
    document: {
      body: { prepend(el) { assert.equal(banner, undefined); banner = el; } },
      querySelectorAll() { return [{ remove() { removed++; } }]; },
      createElement() {
        return {
          children: [], listeners: {}, attributes: {},
          setAttribute(key, value) { this.attributes[key] = value; },
          appendChild(child) { this.children.push(child); },
          addEventListener(name, fn) { this.listeners[name] = fn; }
        };
      }
    }
  });
  vm.runInContext(source('storage.js'), context);
  await vm.runInContext(handling + 'toggleSeller("seller")', context);
  await vm.runInContext('toggleSeller("seller")', context);
  vm.runInContext('reportError(new Error("Extension context invalidated."))', context);
  const updateBanner = script.slice(script.indexOf('  const updateBanner ='), script.indexOf('  // ---------- counter'));
  vm.runInContext(updateBanner + 'updateBanner()', context);
  assert.equal(writes, failure === 'missing runtime' ? 0 : 1);
  assert.equal(disconnects, 1);
  assert.equal(cleared, 42);
  assert.equal(removed, 1);
  assert.equal(errors.length, 0);
  assert.equal(alerts.length, 0);
  assert.equal(reloads, 0);
  assert.equal(banner.attributes.role, 'alert');
  assert.match(banner.children[0].textContent, /Refresh this page/);
  assert.equal(banner.children[1].textContent, 'Refresh Fab');
  banner.children[1].listeners.click();
  assert.equal(reloads, 1);
});
}

test('storage reports disconnected APIs for load, save, and toggle', async () => {
  for (const chrome of [undefined, {}, { runtime: {} }, { runtime: { id: 'test-extension' } }]) {
    const context = vm.createContext({ chrome });
    vm.runInContext(source('storage.js'), context);
    for (const call of ['FabStorage.load()', 'FabStorage.save({ blockedSellers: [] })', 'FabStorage.toggleSeller("seller")']) {
      await assert.rejects(vm.runInContext(call, context), error =>
        error.code === 'FSB_CONTEXT_INVALIDATED' && /Refresh the Fab page/.test(error.message));
    }
  }
});

test('storage keeps normal responses and failures distinct from disconnection', async () => {
  let response = { settings: { blockedSellers: ['seller'] } }, calls = 0, reject = false;
  const context = vm.createContext({
    chrome: { runtime: { id: 'test-extension', async sendMessage(message) {
      calls++;
      assert.equal(message.type, 'fsb:storage');
      if (reject) throw new Error('Could not establish connection. Receiving end does not exist.');
      return response;
    } } }
  });
  vm.runInContext(source('storage.js'), context);
  assert.deepEqual(plain(await vm.runInContext('FabStorage.load()', context)), response.settings);
  response = { error: 'Disk full' };
  await assert.rejects(vm.runInContext('FabStorage.save({})', context), /Disk full/);
  reject = true;
  await assert.rejects(vm.runInContext('FabStorage.toggleSeller("seller")', context), error =>
    !error.code && /Receiving end does not exist/.test(error.message));
  assert.equal(calls, 3);
});

test('ordinary storage errors still report failure without disconnecting the script', async () => {
  const script = source('content.js');
  const handling = script.slice(script.indexOf('  const reportError ='), script.indexOf('  // ---------- page-level'));
  let message, logged;
  const context = vm.createContext({
    contextInvalidated: false, reloadOnChange: true,
    FabStorage: { async toggleSeller() { throw new Error('Disk full'); } },
    console: { error(_label, error) { logged = error.message; } },
    alert(text) { message = text; }
  });
  await vm.runInContext(handling + 'toggleSeller("seller")', context);
  assert.equal(context.contextInvalidated, false);
  assert.equal(logged, 'Disk full');
  assert.match(message, /Disk full/);
});

test('clear and restore preserve sellers, keywords, preference, and an undo point across restarts', async () => {
  const original = { blockedSellers: ['seller'], blockedKeywords: ['junk'], reloadOnChange: false };
  const w = worker(original);
  await w.request('save', { values: { blockedSellers: [], blockedKeywords: [], reloadOnChange: true } });
  const backup = (await w.request('listBackups')).settings.backups[0];
  assert.deepEqual(plain(backup.settings), original);
  const restarted = worker({}, w.local);
  const restored = await restarted.request('restoreBackup', { id: backup.id });
  assert.deepEqual(plain(restored.settings.blockedSellers), original.blockedSellers);
  assert.deepEqual(plain(restored.settings.blockedKeywords), original.blockedKeywords);
  assert.equal(restored.settings.reloadOnChange, original.reloadOnChange);
  const undo = (await restarted.request('listBackups')).settings.backups[0];
  assert.deepEqual(plain(undo.settings.blockedSellers), []);
  assert.equal(undo.settings.reloadOnChange, true);
  await restarted.request('restoreBackup', { id: undo.id });
  assert.deepEqual(restarted.local.blockedSellers, []);
});

test('history stays bounded, ignores no-op saves, and rejects expired restore points', async () => {
  const w = worker({ blockedSellers: ['original'] });
  await w.request('toggleSeller', { seller: 'first' });
  const expired = w.local.blocklistBackups[0].id;
  for (let i = 0; i < 15; i++) await w.request('toggleSeller', { seller: 'seller ' + i });
  assert.equal(w.local.blocklistBackups.length, 10);
  const before = plain(w.local);
  await w.request('save', { values: { blockedSellers: w.local.blockedSellers } });
  assert.deepEqual(w.local, before);
  const result = await w.request('restoreBackup', { id: expired });
  assert.match(result.error, /no longer available/);
  assert.deepEqual(w.local, before);
});

test('backup history trims large Unicode snapshots by byte size', async () => {
  const w = worker({ blockedSellers: ['猫'.repeat(180000)] });
  for (let i = 0; i < 8; i++) await w.request('toggleSeller', { seller: 'seller ' + i });
  assert.ok(w.local.blocklistBackups.length < 10);
  assert.ok(Buffer.byteLength(JSON.stringify(w.local.blocklistBackups)) <= 2 * 1024 * 1024);
  const latest = w.local.blocklistBackups[0];
  assert.ok(latest.settings.blockedSellers.includes('seller 6'));
  assert.ok(!latest.settings.blockedSellers.includes('seller 7'));
});

test('failed saves and restores keep both the current list and its backup history', async () => {
  const w = worker({ blockedSellers: ['original'] });
  await w.request('toggleSeller', { seller: 'new' });
  const before = plain(w.local);
  w.fail(true);
  assert.equal((await w.request('save', { values: { blockedSellers: [] } })).error, 'Disk full');
  assert.equal((await w.request('restoreBackup', { id: before.blocklistBackups[0].id })).error, 'Disk full');
  assert.deepEqual(w.local, before);
});

test('concurrent changes each keep the immediately preceding list', async () => {
  const w = worker({ blockedSellers: ['original'] });
  await Promise.all([
    w.request('toggleSeller', { seller: 'first' }),
    w.request('toggleSeller', { seller: 'second' })
  ]);
  assert.deepEqual(w.local.blocklistBackups.map(entry => entry.settings.blockedSellers), [
    ['first', 'original'], ['original']
  ]);
});

test('downloaded JSON round-trips exact list contents and restores into a fresh installation', async () => {
  const context = vm.createContext({});
  vm.runInContext(source('backup.js'), context);
  const original = { blockedSellers: ['kw:seller', '猫', 'A "quote"'], blockedKeywords: ['100%', 'two\nlines'], reloadOnChange: false };
  const json = context.FabBackup.stringify(original);
  const parsed = context.FabBackup.parse(json);
  assert.deepEqual(plain(parsed), original);
  const w = worker();
  const result = await w.request('restoreFile', { settings: parsed });
  assert.equal(result.error, undefined);
  assert.deepEqual(plain(result.settings.blockedSellers), original.blockedSellers);
  assert.deepEqual(plain(result.settings.blockedKeywords), original.blockedKeywords);
  assert.equal(result.settings.reloadOnChange, false);
});

test('unsupported or malformed backup files never replace the saved list', async () => {
  const context = vm.createContext({});
  vm.runInContext(source('backup.js'), context);
  for (const json of ['not json', 'null', '{}', '{"format":"fab-seller-blocklist-backup","version":2}',
    '{"format":"fab-seller-blocklist-backup","version":1,"settings":{"blockedSellers":[42],"blockedKeywords":[],"reloadOnChange":true}}']) {
    assert.throws(() => context.FabBackup.parse(json));
  }
  const w = worker({ blockedSellers: ['original'] });
  await w.request('load');
  const before = plain(w.local);
  assert.ok((await w.request('restoreFile', { settings: { blockedSellers: [] } })).error);
  assert.deepEqual(w.local, before);
});

async function popupHarness(w) {
  const elements = new Map(), all = [], downloads = [], confirmations = [];
  let allowRestore = true;
  const make = tag => {
    const el = {
      tagName: tag, children: [], listeners: {}, disabled: false, open: false,
      value: '', hidden: false, textContent: '', classList: { add() {}, remove() {} },
      append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); },
      addEventListener(name, fn) { this.listeners[name] = fn; }, remove() {},
      click() { if (tag === 'a') downloads.push(this); else return this.listeners.click?.(); },
      set innerHTML(value) { this.children = []; }
    };
    all.push(el);
    return el;
  };
  const get = id => {
    if (!elements.has(id)) elements.set(id, make('element'));
    return elements.get(id);
  };
  const api = async (action, extra) => {
    const response = await w.request(action, extra);
    if (response.error) throw new Error(response.error);
    return response.settings;
  };
  let blob;
  const context = vm.createContext({
    document: { getElementById: get, querySelectorAll: () => all, createElement: make, body: make('body') },
    FabStorage: {
      load: () => api('load'), listBackups: () => api('listBackups'),
      save: values => api('save', { values }), restoreBackup: id => api('restoreBackup', { id }),
      restoreFile: settings => api('restoreFile', { settings })
    },
    chrome: { tabs: { query(_options, cb) { cb([]); } } },
    confirm(message) { confirmations.push(message); return allowRestore; },
    Blob, URL: { createObjectURL(value) { blob = value; return 'blob:test-backup'; }, revokeObjectURL() {} },
    setTimeout(fn) { fn(); }
  });
  vm.runInContext(source('backup.js') + '\n' + source('popup.js'), context);
  await new Promise(resolve => setImmediate(resolve));
  return { get, downloads, confirmations, blob: () => blob, allow(value) { allowRestore = value; } };
}

test('popup downloads fresh saved data and restores a file only after confirmation', async () => {
  const w = worker({ blockedSellers: ['original'] });
  const ui = await popupHarness(w);
  await w.request('toggleSeller', { seller: 'another tab' });
  await ui.get('downloadBackup').click();
  assert.equal(ui.downloads.length, 1);
  assert.match(ui.downloads[0].download, /^fab-blocklist-backup-.*\.json$/);
  const json = await ui.blob().text();
  assert.deepEqual(JSON.parse(json).settings.blockedSellers, ['another tab', 'original']);
  await w.request('save', { values: { blockedSellers: [] } });
  const event = { target: { files: [{ size: json.length, text: async () => json }], value: 'backup.json' } };
  ui.allow(false);
  await ui.get('backupFile').listeners.change(event);
  assert.deepEqual(w.local.blockedSellers, []);
  ui.allow(true);
  await ui.get('backupFile').listeners.change(event);
  assert.deepEqual(w.local.blockedSellers, ['another tab', 'original']);
  assert.match(ui.get('backupStatus').textContent, /Backup restored/);
  assert.equal(ui.get('downloadBackup').disabled, false);
  const before = plain(w.local);
  await ui.get('backupFile').listeners.change({ target: { files: [{ size: 1, text: async () => 'invalid' }] } });
  assert.match(ui.get('error').textContent, /not a valid JSON backup/);
  assert.deepEqual(w.local, before);
});

test('popup exposes local restore points and updates the displayed list after recovery', async () => {
  const w = worker({ blockedSellers: ['original'], blockedKeywords: ['junk'], reloadOnChange: false });
  await w.request('save', { values: { blockedSellers: [], blockedKeywords: [] } });
  const ui = await popupHarness(w);
  ui.get('backups').open = true;
  await ui.get('backups').listeners.toggle();
  const restore = ui.get('backupList').children[0].children[1];
  assert.equal(restore.textContent, 'Restore');
  await restore.click();
  assert.deepEqual(w.local.blockedSellers, ['original']);
  assert.equal(ui.get('count').textContent, '(1)');
  assert.equal(ui.get('kwCount').textContent, '(1)');
  assert.equal(ui.get('reloadToggle').checked, false);
  assert.equal(ui.get('backupList').children.length, 2);
});
