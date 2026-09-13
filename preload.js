'use strict';

/**
 * Preload script — runs in an isolated context with access to a tiny set of
 * Node primitives, then exposes a narrow surface to the renderer.
 *
 * The renderer should NEVER get direct access to ipcRenderer or Node APIs.
 * Everything goes through window.shell.* with input validation here.
 */

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_EVENT_KINDS = new Set([
  'ready',
  'error',
  'exit',
  'stderr',
  'update:state',
  'update:ready-toast',
  'update:open-log',
]);

contextBridge.exposeInMainWorld('shell', {
  /**
   * Ask the main process for the current boot state.
   * @returns {Promise<{state: 'starting' | 'ready' | 'error'}>}
   */
  getState() {
    return ipcRenderer.invoke('shell:get-state');
  },

  /**
   * Ask the main process to retry starting pi-web.
   * @returns {Promise<{ok: boolean}>}
   */
  retry() {
    return ipcRenderer.invoke('shell:retry');
  },

  /**
   * Get preferred and actual port configuration.
   * @returns {Promise<{preferredPort: number, actualPort: number}>}
   */
  getPortConfig() {
    return ipcRenderer.invoke('shell:get-port-config');
  },

  /**
   * Set preferred port and restart server.
   * @param {number} port
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  setPreferredPort(port) {
    return ipcRenderer.invoke('shell:set-preferred-port', port);
  },

  /**
   * Open an external URL in the OS default browser. The renderer itself is
   * sandboxed and cannot do this safely.
   * @param {string} url
   * @returns {Promise<{ok: boolean}>}
   */
  openExternal(url) {
    if (typeof url !== 'string') return Promise.resolve({ ok: false });
    if (!/^https?:\/\//i.test(url)) return Promise.resolve({ ok: false });
    return ipcRenderer.invoke('shell:open-external', url);
  },

  /**
   * Subscribe to shell lifecycle events from the main process.
   * @param {(event: {kind: string, [k: string]: any}) => void} listener
   * @returns {() => void} unsubscribe
   */
  onEvent(listener) {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, payload) => {
      if (payload && typeof payload === 'object' && ALLOWED_EVENT_KINDS.has(payload.kind)) {
        listener(payload);
      }
    };
    ipcRenderer.on('shell:event', wrapped);
    return () => ipcRenderer.removeListener('shell:event', wrapped);
  },

  /**
   * Kernel update API.
   */
  update: {
    getState() {
      return ipcRenderer.invoke('update:get-state');
    },
    check() {
      return ipcRenderer.invoke('update:check');
    },
    download() {
      return ipcRenderer.invoke('update:download');
    },
    applyAndRestart() {
      return ipcRenderer.invoke('update:apply-and-restart');
    },
    rollback() {
      return ipcRenderer.invoke('update:rollback');
    },
    cancelDownload() {
      return ipcRenderer.invoke('update:cancel-download');
    },
  },
});