// One writer serializes migration and saves across tabs and the popup.
importScripts('backup.js');
const defaults = { blockedSellers: [], blockedKeywords: [], reloadOnChange: true };
const keys = Object.keys(defaults);
const migrationKey = 'localStorageMigrated';
const backupKey = 'blocklistBackups';
const maxBackups = 10;
const maxBackupBytes = 2 * 1024 * 1024;

const readBackups = async () => {
  const stored = await chrome.storage.local.get(backupKey);
  return Array.isArray(stored[backupKey]) ? stored[backupKey] : [];
};

const addBackup = (backups, settings) => {
  const snapshot = FabBackup.settings(settings);
  if (JSON.stringify(backups[0]?.settings) === JSON.stringify(snapshot)) return backups;
  const next = [{ id: crypto.randomUUID(), createdAt: new Date().toISOString(), settings: snapshot }, ...backups];
  // Keep the newest restore point even for unusually large lists. If storage
  // cannot hold it, the save fails without replacing the user's current list.
  while (next.length > maxBackups || (next.length > 1 && new TextEncoder().encode(JSON.stringify(next)).length > maxBackupBytes)) {
    next.pop();
  }
  return next;
};

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
    if (message.action === 'listBackups') return { backups: await readBackups() };
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
    } else if (message.action === 'restoreBackup') {
      const backup = (await readBackups()).find(entry => entry.id === message.id);
      if (!backup) throw new Error('That restore point is no longer available. Reopen Backups and try again.');
      changes = FabBackup.settings(backup.settings);
    } else if (message.action === 'restoreFile') {
      changes = FabBackup.settings(message.settings);
    } else if (message.action === 'toggleSeller') {
      if (typeof message.seller !== 'string' || !message.seller) throw new Error('Invalid seller.');
      const sellers = new Set(settings.blockedSellers);
      if (sellers.has(message.seller)) sellers.delete(message.seller);
      else sellers.add(message.seller);
      changes = { blockedSellers: [...sellers].sort() };
    } else {
      throw new Error('Unknown storage action.');
    }
    const nextSettings = { ...settings, ...changes };
    if (keys.some(key => JSON.stringify(settings[key]) !== JSON.stringify(nextSettings[key]))) {
      // The previous list and the new settings are saved together; restoring
      // a backup also creates an undo point for the list being replaced.
      const backups = addBackup(await readBackups(), settings);
      await chrome.storage.local.set({ ...changes, [backupKey]: backups });
    }
    return { ...settings, ...changes };
  });
  pending = operation.catch(() => {});
  operation.then(
    settings => respond({ settings }),
    error => respond({ error: error.message || 'Storage is unavailable.' })
  );
  return true;
});
