const STORAGE_KEY = 'blockedSellers';
const KEYWORDS_KEY = 'blockedKeywords';
const RELOAD_KEY = 'reloadOnChange';
const $ = (id) => document.getElementById(id);

const normalize = (name) => {
  let s = String(name || '');
  try { s = decodeURIComponent(s); } catch (_) {}
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
};

let blocked = [];
let keywords = [];
let reloadOnChange = true;
let currentSeller = null;

const load = () =>
  new Promise((resolve) =>
    chrome.storage.sync.get({ [STORAGE_KEY]: [], [KEYWORDS_KEY]: [], [RELOAD_KEY]: true }, (res) => {
      blocked = [...new Set((res[STORAGE_KEY] || []).map(normalize))].sort();
      keywords = [...new Set((res[KEYWORDS_KEY] || []).map(normalize).filter(Boolean))].sort();
      reloadOnChange = res[RELOAD_KEY] !== false;
      resolve();
    })
  );

const save = () => chrome.storage.sync.set({ [STORAGE_KEY]: blocked, [KEYWORDS_KEY]: keywords });

// Reload the active tab if it is a Fab page, so the change shows up immediately.
const reloadFabTab = () =>
  new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.id && /^https:\/\/(www\.)?fab\.com\//.test(tab.url || '')) {
        chrome.tabs.reload(tab.id, {}, () => resolve());
      } else resolve();
    });
  });

const saveAndReload = () => save().then(() => (reloadOnChange ? reloadFabTab() : undefined));

$('reloadToggle').addEventListener('change', (e) => {
  reloadOnChange = e.target.checked;
  chrome.storage.sync.set({ [RELOAD_KEY]: reloadOnChange });
});

const renderList = (ul, items, emptyText, onRemove) => {
  ul.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText;
    ul.appendChild(li);
  }
  for (const name of items) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = name;
    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.addEventListener('click', () => {
      onRemove(name);
      saveAndReload().then(render);
    });
    li.append(span, btn);
    ul.appendChild(li);
  }
};

const render = () => {
  $('reloadToggle').checked = reloadOnChange;
  $('count').textContent = blocked.length ? '(' + blocked.length + ')' : '';
  $('kwCount').textContent = keywords.length ? '(' + keywords.length + ')' : '';
  renderList($('list'), blocked, 'No sellers blocked yet.', (name) => {
    blocked = blocked.filter((n) => n !== name);
  });
  renderList($('kwList'), keywords, 'No keywords yet.', (name) => {
    keywords = keywords.filter((n) => n !== name);
  });
  const cur = $('current');
  if (currentSeller) {
    cur.classList.add('show');
    $('currentName').textContent = currentSeller;
    $('currentBtn').textContent = blocked.includes(currentSeller) ? 'Unblock' : 'Block';
  } else {
    cur.classList.remove('show');
  }
};

const add = (raw) => {
  const name = normalize(raw);
  if (!name) return Promise.resolve();
  if (!blocked.includes(name)) blocked.push(name);
  blocked.sort();
  return saveAndReload().then(render);
};

$('addBtn').addEventListener('click', () => {
  add($('addInput').value);
  $('addInput').value = '';
});
$('addInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('addBtn').click();
});

const addKeyword = (raw) => {
  const kw = normalize(raw);
  if (!kw) return Promise.resolve();
  if (!keywords.includes(kw)) keywords.push(kw);
  keywords.sort();
  return saveAndReload().then(render);
};
$('kwAddBtn').addEventListener('click', () => {
  addKeyword($('kwInput').value);
  $('kwInput').value = '';
});
$('kwInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('kwAddBtn').click();
});

$('currentBtn').addEventListener('click', () => {
  if (!currentSeller) return;
  if (blocked.includes(currentSeller)) blocked = blocked.filter((n) => n !== currentSeller);
  else blocked.push(currentSeller);
  blocked.sort();
  saveAndReload().then(render);
});

$('clearBtn').addEventListener('click', () => {
  if (!blocked.length && !keywords.length) return;
  if (!confirm('Remove all ' + blocked.length + ' blocked sellers and ' + keywords.length + ' keywords?')) return;
  blocked = [];
  keywords = [];
  saveAndReload().then(render);
});

const hideIO = () => {
  $('io').hidden = true;
  $('ioActions').hidden = true;
};
const showIO = (text, applyMode) => {
  const ta = $('io');
  ta.hidden = false;
  ta.value = text;
  ta.readOnly = !applyMode;
  $('ioActions').hidden = !applyMode;
  if (!applyMode) {
    ta.select();
    try { navigator.clipboard.writeText(text); } catch (_) {}
  } else {
    ta.focus();
  }
};
$('exportBtn').addEventListener('click', () =>
  showIO([...blocked, ...keywords.map((k) => 'kw:' + k)].join('\n'), false)
);
$('importBtn').addEventListener('click', () => showIO('', true));
$('ioCancel').addEventListener('click', hideIO);
$('ioApply').addEventListener('click', () => {
  const lines = $('io').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const newSellers = lines.filter((l) => !/^kw:/i.test(l)).map(normalize);
  const newKeywords = lines.filter((l) => /^kw:/i.test(l)).map((l) => normalize(l.slice(3)));
  blocked = [...new Set([...blocked, ...newSellers])].sort();
  keywords = [...new Set([...keywords, ...newKeywords].filter(Boolean))].sort();
  saveAndReload().then(() => { render(); hideIO(); });
});

// Ask the active Fab tab which seller its page belongs to
const queryCurrentSeller = () =>
  new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.id || !/^https:\/\/(www\.)?fab\.com\//.test(tab.url || '')) return resolve(null);
      chrome.tabs.sendMessage(tab.id, { type: 'fsb:currentSeller' }, (res) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve((res && res.seller) || null);
      });
    });
  });

Promise.all([load(), queryCurrentSeller()]).then(([, seller]) => {
  currentSeller = seller;
  render();
});
