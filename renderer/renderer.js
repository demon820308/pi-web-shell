'use strict';

/**
 * Renderer entry — runs in a sandboxed context with no Node access.
 * Only communicates with the main process via window.shell (defined in
 * preload.js).
 *
 * Lifecycle:
 *   - On load, query the main process for current state. If the server is
 *     already ready (window was reloaded), nothing to do — the main process
 *     already navigated us away.
 *   - Otherwise, show the loading screen and wait for 'ready' / 'error'.
 *   - When 'ready' arrives, the main process navigates this window to the
 *     pi-web URL, so this script is replaced and stops running.
 */

const screens = {
  starting: document.querySelector('[data-screen="starting"]'),
  error: document.querySelector('[data-screen="error"]'),
  exit: document.querySelector('[data-screen="exit"]'),
};
const errorMessageEl = document.getElementById('error-message');
const exitHintEl = document.getElementById('exit-hint');
const retryBtn = document.getElementById('retry-btn');
const docsBtn = document.getElementById('docs-btn');

// Update banner elements.
const bannerEl = document.getElementById('update-banner');
const bannerTitle = document.getElementById('update-banner-title');
const bannerDetail = document.getElementById('update-banner-detail');
const bannerProgress = document.getElementById('update-banner-progress');
const bannerProgressBar = document.getElementById('update-bar-fill');
const bannerAction = document.getElementById('update-banner-action');
const bannerDismiss = document.getElementById('update-banner-dismiss');

let bannerDismissed = false;

function showScreen(kind) {
  for (const [k, el] of Object.entries(screens)) {
    if (!el) continue;
    el.hidden = k !== kind;
  }
  document.getElementById('root').className = `state-${kind}`;
}

// ---------------------------------------------------------------------------
// Update banner
// ---------------------------------------------------------------------------

function fmtBytes(n) {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function hideBanner() {
  bannerEl.hidden = true;
  bannerEl.classList.remove('update-banner-error');
}

function renderBanner(state) {
  if (!state || bannerDismissed) {
    hideBanner();
    return;
  }

  const {
    phase,
    bytesDownloaded,
    bytesTotal,
    installedVersion,
    availableVersion,
    downloadedVersion,
    lastError,
  } = state;

  // Phases worth showing:
  //   checking / available / downloading / ready / error
  if (!['checking', 'available', 'downloading', 'ready', 'error'].includes(phase)) {
    hideBanner();
    return;
  }

  bannerEl.hidden = false;
  bannerEl.classList.toggle('update-banner-error', phase === 'error');

  let title;
  let detail;
  let actionLabel = null;
  let actionHandler = null;
  let showProgress = false;

  switch (phase) {
    case 'checking':
      title = 'Checking for updates…';
      detail = '';
      break;
    case 'available':
      title = `Update available: v${availableVersion}`;
      detail = installedVersion
        ? `Currently running v${installedVersion}. Downloading in the background…`
        : 'Downloading in the background…';
      break;
    case 'downloading':
      title = `Downloading v${availableVersion}…`;
      detail = `${fmtBytes(bytesDownloaded)} of ${fmtBytes(bytesTotal)}`;
      showProgress = true;
      const pct = bytesTotal ? Math.min(100, (bytesDownloaded / bytesTotal) * 100) : 0;
      bannerProgressBar.style.width = `${pct}%`;
      break;
    case 'ready':
      title = `v${downloadedVersion || availableVersion} ready to install`;
      detail = 'Restart the server to apply the update.';
      actionLabel = 'Restart now';
      actionHandler = async () => {
        bannerAction.disabled = true;
        bannerAction.textContent = 'Restarting…';
        await window.shell.update.applyAndRestart();
      };
      break;
    case 'error':
      title = 'Update check failed';
      detail = lastError || 'Unknown error. Will retry later.';
      break;
  }

  bannerTitle.textContent = title;
  bannerDetail.textContent = detail;
  bannerProgress.hidden = !showProgress;

  if (actionLabel && actionHandler) {
    bannerAction.hidden = false;
    bannerAction.textContent = actionLabel;
    bannerAction.disabled = false;
    bannerAction.onclick = actionHandler;
  } else {
    bannerAction.hidden = true;
    bannerAction.onclick = null;
  }
}

bannerDismiss.addEventListener('click', () => {
  bannerDismissed = true;
  hideBanner();
});

retryBtn?.addEventListener('click', () => {
  window.shell.retry();
  showScreen('starting');
  errorMessageEl.textContent = 'Retrying…';
});

docsBtn?.addEventListener('click', () => {
  window.shell.openExternal('https://github.com/agegr/pi-web#readme');
});

window.shell.onEvent((event) => {
  switch (event.kind) {
    case 'ready':
      // Main process will navigate us; nothing to do here.
      break;
    case 'error':
      errorMessageEl.textContent = event.message || 'Unknown error.';
      showScreen('error');
      break;
    case 'exit':
      exitHintEl.textContent = `The local server exited${
        event.signal ? ` (signal ${event.signal})` : event.code != null ? ` (code ${event.code})` : ''
      }. You can close this window.`;
      showScreen('exit');
      break;
    case 'update:state':
      // New update state from the main process. Re-render the banner and
      // un-dismiss it if the user previously hid it.
      if (event.phase && event.phase !== 'idle' && event.phase !== 'up-to-date') {
        bannerDismissed = false;
      }
      renderBanner(event);
      break;
    case 'update:ready-toast':
      // Soft, non-modal notification that an update finished downloading.
      // The banner is already updated via update:state; this is purely a
      // hook for future attention cues (sound, system notification, etc.).
      break;
    case 'update:open-log':
      // Reserved for a future in-app log viewer; currently a no-op.
      break;
  }
});

// Initial state probe.
window.shell.getState().then(({ state }) => {
  if (state === 'ready') {
    // The main process should already be navigating us; show starting as
    // a brief fallback in case the navigation is racing.
    showScreen('starting');
  } else if (state === 'error') {
    showScreen('error');
  } else {
    showScreen('starting');
  }
});

// Initial update state probe (independent of the loading screen).
window.shell.update.getState().then((updateState) => {
  renderBanner(updateState);
});