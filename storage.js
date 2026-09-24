// Shared by the popup and content script; the worker owns migration and writes.
globalThis.FabStorage = {
  async request(action, values) {
    const disconnected = () => {
      const error = new Error('The extension was reloaded or disconnected. Refresh the Fab page and try again.');
      error.code = 'FSB_CONTEXT_INVALIDATED';
      return error;
    };
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.id || typeof runtime.sendMessage !== 'function') throw disconnected();
    let response;
    try {
      response = await runtime.sendMessage({ type: 'fsb:storage', action, ...values });
    } catch (error) {
      // A reload can also happen after the availability check. Never retry a
      // toggle automatically: the worker may already have saved the change.
      if (!globalThis.chrome?.runtime?.id || /extension context invalidated/i.test(error?.message || '')) {
        throw disconnected();
      }
      throw error;
    }
    if (!response || response.error) throw new Error(response?.error || 'Storage is unavailable.');
    return response.settings;
  },
  load() { return this.request('load'); },
  save(values) { return this.request('save', { values }); },
  toggleSeller(seller) { return this.request('toggleSeller', { seller }); },
  listBackups() { return this.request('listBackups'); },
  restoreBackup(id) { return this.request('restoreBackup', { id }); },
  restoreFile(settings) { return this.request('restoreFile', { settings }); }
};
