// Shared backup format for downloaded files and local restore points.
globalThis.FabBackup = {
  settings(value) {
    if (!value || !Array.isArray(value.blockedSellers) || !Array.isArray(value.blockedKeywords) ||
        !value.blockedSellers.every(name => typeof name === 'string') ||
        !value.blockedKeywords.every(word => typeof word === 'string') ||
        typeof value.reloadOnChange !== 'boolean') {
      throw new Error('This backup does not contain valid sellers, keywords, and settings.');
    }
    return {
      blockedSellers: [...value.blockedSellers],
      blockedKeywords: [...value.blockedKeywords],
      reloadOnChange: value.reloadOnChange
    };
  },
  stringify(settings) {
    return JSON.stringify({
      format: 'fab-seller-blocklist-backup', version: 1,
      exportedAt: new Date().toISOString(), settings: this.settings(settings)
    }, null, 2);
  },
  parse(text) {
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new Error('This file is not a valid JSON backup.'); }
    if (data?.format !== 'fab-seller-blocklist-backup' || data.version !== 1) {
      throw new Error('This file is not a supported Fab Seller Blocklist backup.');
    }
    return this.settings(data.settings);
  }
};
