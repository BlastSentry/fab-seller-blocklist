// Shared by the popup and content script; the worker owns migration and writes.
globalThis.FabStorage = {
  async request(action, values) {
    const response = await chrome.runtime.sendMessage({ type: 'fsb:storage', action, ...values });
    if (!response || response.error) throw new Error(response?.error || 'Storage is unavailable.');
    return response.settings;
  },
  load() { return this.request('load'); },
  save(values) { return this.request('save', { values }); },
  toggleSeller(seller) { return this.request('toggleSeller', { seller }); }
};
