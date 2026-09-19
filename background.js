// One writer serializes migration and saves across tabs and the popup.
const defaults = { blockedSellers: [], blockedKeywords: [], reloadOnChange: true };
const keys = Object.keys(defaults);
const migrationKey = 'localStorageMigrated';

const loadSettings = async () => {
  const local = await chrome.storage.local.get([...keys, migrationKey]);
  if (!local[migrationKey]) {
    const legacy = await chrome.storage.sync.get(defaults);
    const migrated = { ...defaults, ...legacy, ...local, [migrationKey]: true };
    await chrome.storage.local.set(migrated);
    return migrated;
  }
  return { ...defaults, ...local };
};

let pending = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'fsb:storage') return;
  const operation = pending.then(async () => {
    const settings = await loadSettings();
    if (message.action === 'load') return settings;
    let changes;
    if (message.action === 'save') {
      changes = {};
      for (const key of keys) {
        if (Object.hasOwn(message.values || {}, key)) changes[key] = message.values[key];
      }
      if (Object.hasOwn(changes, 'reloadOnChange') && typeof changes.reloadOnChange !== 'boolean') {
        throw new Error('Invalid reload preference.');
      }
      for (const key of ['blockedSellers', 'blockedKeywords']) {
        if (Object.hasOwn(changes, key) &&
            (!Array.isArray(changes[key]) || !changes[key].every(value => typeof value === 'string'))) {
          throw new Error('Invalid blocklist.');
        }
      }
    } else if (message.action === 'toggleSeller') {
      if (typeof message.seller !== 'string' || !message.seller) throw new Error('Invalid seller.');
      const sellers = new Set(settings.blockedSellers);
      if (sellers.has(message.seller)) sellers.delete(message.seller);
      else sellers.add(message.seller);
      changes = { blockedSellers: [...sellers].sort() };
    } else {
      throw new Error('Unknown storage action.');
    }
    await chrome.storage.local.set(changes);
    return { ...settings, ...changes };
  });
  pending = operation.catch(() => {});
  operation.then(
    settings => respond({ settings }),
    error => respond({ error: error.message || 'Storage is unavailable.' })
  );
  return true;
});
