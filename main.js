'use strict';

/**
 * pi-web-shell — Electron main process.
 *
 * Responsibilities:
 *   1. Acquire a single-instance lock; raise existing window on second launch.
 *   2. Locate the bundled Node.js + @agegr/pi-web inside the EXE resources.
 *      Falls back to user-installed / system Node and npm for dev mode.
 *   3. Spawn Node + pi-web as a child process with --no-open so the shell's
 *      own BrowserWindow is the only window that opens.
 *   4. Watch stdout for "Ready" then navigate the window to the local URL.
 *   5. Cleanly shut down the child process when the window closes.
 *   6. (Phase 3) Check, download, and apply kernel updates in the background.
 *      On startup failures, auto-rollback to the previous kernel.
 *
 * This file does NOT modify @agegr/pi-web. It treats pi-web as an opaque
 * black-box subprocess that speaks HTTP on 127.0.0.1:30141.
 *
 * Phase 2: Node.js and pi-web's full node_modules are bundled inside the EXE
 * via electron-builder's extraResources, so end users do NOT need to install
 * Node separately. The resolution order is:
 *   1. Bundled in resources/ (Phase 2 — primary path)
 *   2. Env overrides (PI_WEB_BIN / PI_WEB_NODE) for dev/testing
 *   3. System Node.js + global pi-web (dev convenience)
 *   4. npx fallback (downloads @latest on first run)
 *
 * Phase 3: Only the pi-web kernel is hot-updated via lib/kernel-updater.js.
 * The shell itself is replaced only via full EXE upgrades. This keeps update
 * payloads small (~150 MB compressed vs ~300 MB for a full EXE) and avoids
 * SmartScreen re-prompts.
 */

const { app, BrowserWindow, ipcMain, Menu, shell, dialog, screen, Tray, nativeImage } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const { KernelUpdater } = require('./lib/kernel-updater');
const { UpdateState } = require('./lib/update-state');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 30141;
const DEFAULT_HOSTNAME = '127.0.0.1';
const READY_TIMEOUT_MS = 60_000;
const CHILD_TERMINATE_GRACE_MS = 5_000;
// Must match NODE_VERSION in scripts/fetch-node.js. Used as the versioned
// subdirectory name under resources/node/.
const BUNDLED_NODE_VERSION = '22.19.0';

// Set to true to see verbose child-process logs in the Electron console.
const DEBUG = process.argv.includes('--enable-logging');

// ---------------------------------------------------------------------------
// Port & Settings Management (Scheme A: Zero-touch to pi-web core)
// ---------------------------------------------------------------------------

function isPortAvailable(port, host = DEFAULT_HOSTNAME) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function findAvailablePort(preferredPort, host = DEFAULT_HOSTNAME, maxTries = 30) {
  for (let p = preferredPort; p < preferredPort + maxTries; p++) {
    if (await isPortAvailable(p, host)) {
      return p;
    }
  }
  return preferredPort;
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const p = getSettingsPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (err) {
    if (DEBUG) console.warn('[shell] failed to read settings:', err.message);
  }
  return {};
}

function saveSettings(data) {
  try {
    const p = getSettingsPath();
    const current = loadSettings();
    fs.writeFileSync(p, JSON.stringify({ ...current, ...data }, null, 2));
  } catch (err) {
    console.error('[shell] failed to save settings:', err.message);
  }
}

function getPreferredPort() {
  if (process.env.PORT) {
    const p = parseInt(process.env.PORT, 10);
    if (!isNaN(p) && p > 0) return p;
  }
  const settings = loadSettings();
  if (typeof settings.preferredPort === 'number' && settings.preferredPort > 0) {
    return settings.preferredPort;
  }
  return DEFAULT_PORT;
}

let currentPreferredPort = DEFAULT_PORT;
let currentActualPort = DEFAULT_PORT;

// ---------------------------------------------------------------------------
// Logging Management (Local file logger for troubleshooting)
// ---------------------------------------------------------------------------

function getLogFilePath() {
  const logDir = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  return path.join(logDir, 'pi-web.log');
}

let logStream = null;
function writeLog(prefix, text) {
  try {
    if (!logStream) {
      const logFile = getLogFilePath();
      logStream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });
    }
    const timestamp = new Date().toISOString();
    logStream.write(`[${timestamp}] [${prefix}] ${text}\n`);
  } catch (err) {
    // Ignore logging errors
  }
}

function openLogFile() {
  const logPath = getLogFilePath();
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `--- Pi Web Log Initialized at ${new Date().toISOString()} ---\n`);
  }
  shell.openPath(logPath);
}

function openLogFolder() {
  const logDir = path.dirname(getLogFilePath());
  shell.openPath(logDir);
}

// ---------------------------------------------------------------------------
// Startup & Tray Management
// ---------------------------------------------------------------------------

let tray = null;
let isQuitting = false;

function isAutoStartEnabled() {
  const settings = loadSettings();
  if (typeof settings.openAtLogin === 'boolean') {
    return settings.openAtLogin;
  }
  return app.getLoginItemSettings().openAtLogin;
}

function setAutoStart(enable) {
  app.setLoginItemSettings({
    openAtLogin: enable,
    path: process.execPath,
  });
  saveSettings({ openAtLogin: enable });
}

function getAppIcon() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  return nativeImage.createEmpty();
}

function createTray() {
  if (tray) return;
  const icon = getAppIcon();
  tray = new Tray(icon);
  tray.setToolTip('Pi Web');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: '重启服务',
      click: () => restartChildProcess(),
    },
    { type: 'separator' },
    {
      label: '查看运行日志',
      click: () => openLogFile(),
    },
    { type: 'separator' },
    {
      label: '彻底退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Resource path resolution
// ---------------------------------------------------------------------------

/**
 * Return the absolute path to the resources/ directory the shell should
 * read bundled assets from. In packaged builds that's process.resourcesPath;
 * in dev (electron .) it falls back to the project's own resources/ dir.
 */
function getResourcesRoot() {
  if (app && app.isPackaged) return process.resourcesPath;
  return path.join(__dirname, 'resources');
}

// ---------------------------------------------------------------------------
// Locate the pi-web CLI
// ---------------------------------------------------------------------------

/**
 * Return an absolute path to pi-web's bin/pi-web.js, or null if we should
 * fall back to spawning npx.
 *
 * Search order:
 *   1. PI_WEB_BIN env var (explicit override)
 *   2. Bundled: <resources>/pi-web/node_modules/@agegr/pi-web/bin/pi-web.js
 *   3. Global npm root
 *   4. Local node_modules of the shell itself (dev mode)
 */
function resolvePiWebBin() {
  // 1. Explicit override (always wins).
  if (process.env.PI_WEB_BIN && fs.existsSync(process.env.PI_WEB_BIN)) {
    return process.env.PI_WEB_BIN;
  }

  // 2. Bundled with the EXE (Phase 2 primary path).
  try {
    const bundled = path.join(
      getResourcesRoot(),
      'pi-web',
      'node_modules',
      '@agegr',
      'pi-web',
      'bin',
      'pi-web.js'
    );
    if (fs.existsSync(bundled)) return bundled;
  } catch (err) {
    if (DEBUG) console.warn('[shell] bundled lookup failed:', err.message);
  }

  // 3. Look in the global npm root. `npm root -g` prints the global
  //    node_modules directory; we append @agegr/pi-web/bin/pi-web.js.
  try {
    const globalRoot = execSync(
      `${process.platform === 'win32' ? 'npm.cmd' : 'npm'} root -g`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
    ).trim();
    const candidate = path.join(globalRoot, '@agegr', 'pi-web', 'bin', 'pi-web.js');
    if (fs.existsSync(candidate)) return candidate;
  } catch (err) {
    if (DEBUG) console.warn('[shell] npm root -g failed:', err.message);
  }

  // 3. Look next to this app's bundled node_modules (when @agegr/pi-web is a
  //    regular dependency — which is our package.json's choice for now).
  try {
    const pkgJsonPath = require.resolve('@agegr/pi-web/package.json');
    const candidate = path.join(path.dirname(pkgJsonPath), 'bin', 'pi-web.js');
    if (fs.existsSync(candidate)) return candidate;
  } catch (err) {
    if (DEBUG) console.warn('[shell] local resolve failed:', err.message);
  }

  return null;
}

/**
 * Find an npx executable. Search order:
 *   1. Bundled with the EXE (Phase 2 — under resources/node/v<ver>/).
 *   2. Alongside the bundled Node binary (sibling).
 *   3. Sibling of process.execPath (dev mode / packaged Electron co-located).
 *   4. PATH fallback (returns a name only; relied on by spawn to find via PATH).
 */
function resolveNpxBin() {
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push('npx.cmd', 'npx.exe');
  } else {
    candidates.push('npx');
  }

  // 1. Bundled.
  try {
    const bundledDir = path.join(
      getResourcesRoot(),
      'node',
      `v${BUNDLED_NODE_VERSION}`
    );
    for (const name of candidates) {
      const p = path.join(bundledDir, name);
      if (fs.existsSync(p)) return p;
    }
    // On Windows npx.cmd delegates to node_modules/npm/bin/npx-cli.js.
    const npxCliWin = path.join(
      bundledDir,
      'node_modules',
      'npm',
      'bin',
      'npx-cli.js'
    );
    if (fs.existsSync(npxCliWin)) return npxCliWin;
  } catch (err) {
    if (DEBUG) console.warn('[shell] bundled npx lookup failed:', err.message);
  }

  // 2. Sibling of process.execPath.
  const nodeDir = path.dirname(process.execPath);
  for (const name of candidates) {
    const p = path.join(nodeDir, name);
    if (fs.existsSync(p)) return p;
  }

  // 3. PATH fallback (a bare name).
  return candidates[0];
}

/**
 * Locate a real Node.js binary (separate from Electron's bundled runtime).
 * Critical because pi-web's native modules (node-pty) are prebuilt for
 * Node.js ABI, which may not match Electron's.
 *
 * Search order:
 *   1. PI_WEB_NODE env override
 *   2. Bundled: <resources>/node/v<version>/{node.exe|bin/node}
 *   3. Sibling of process.execPath (when running unpackaged or co-located)
 *   4. PATH lookup via `where node` / `which node`
 *
 * @returns {string | null} absolute path to a Node binary, or null if none found.
 */
function resolveNodeBin() {
  // 1. PI_WEB_NODE override.
  if (process.env.PI_WEB_NODE && fs.existsSync(process.env.PI_WEB_NODE)) {
    return process.env.PI_WEB_NODE;
  }

  // 2. Bundled with the EXE (Phase 2 primary path).
  try {
    const versioned = path.join(
      getResourcesRoot(),
      'node',
      `v${BUNDLED_NODE_VERSION}`
    );
    const bundled = process.platform === 'win32'
      ? path.join(versioned, 'node.exe')
      : path.join(versioned, 'bin', 'node');
    if (fs.existsSync(bundled)) return bundled;
  } catch (err) {
    if (DEBUG) console.warn('[shell] bundled node lookup failed:', err.message);
  }

  // 3. Sibling of process.execPath (works for both dev `electron .` and
  //    packaged Electron — useful when a user puts node.exe next to the app).
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const sibling = path.join(path.dirname(process.execPath), nodeName);
  if (fs.existsSync(sibling)) return sibling;

  // 4. PATH lookup via where/which.
  try {
    const cmd = process.platform === 'win32' ? 'where node' : 'which node';
    const out = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch (err) {
    if (DEBUG) console.warn('[shell] which node failed:', err.message);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Child process lifecycle
// ---------------------------------------------------------------------------

class PiWebProcess {
  constructor() {
    /** @type {import('child_process').ChildProcess | null} */
    this.child = null;
    this.stdoutBuffer = '';
    this.resolved = false;
    this.listeners = new Set();
  }

  /** Subscribe to lifecycle events: { kind: 'ready' | 'error' | 'exit', ... } */
  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[shell] listener threw:', err);
      }
    }
  }

  start(portOverride) {
    const port = String(portOverride || currentActualPort || DEFAULT_PORT);
    const hostname = process.env.PI_WEB_HOSTNAME || DEFAULT_HOSTNAME;

    const env = {
      ...process.env,
      PI_WEB_NO_OPEN: '1', // We open our own window; suppress the default browser.
      PI_WEB_HOSTNAME: hostname,
    };

    let command;
    let args;
    let spawnEnv = env;

    const directBin = resolvePiWebBin();
    if (directBin) {
      // Prefer a real Node.js over Electron-as-Node. The reason is that
      // pi-web's native modules (notably node-pty) ship prebuilt binaries
      // for specific Node ABIs, which often do NOT match Electron's bundled
      // Node ABI. Using the user's installed Node avoids that mismatch.
      const nodeBin = resolveNodeBin();
      if (nodeBin) {
        command = nodeBin;
        args = [directBin, '--no-open', '-p', port, '-H', hostname];
        if (DEBUG) console.log(`[shell] spawning direct via system node: ${command} ${args.join(' ')}`);
      } else {
        // Fall back to Electron-as-Node. Set the flag so the binary
        // drops its GUI mode and runs as a plain Node interpreter.
        command = process.execPath;
        args = [directBin, '--no-open', '-p', port, '-H', hostname];
        spawnEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
        if (DEBUG) console.log(`[shell] spawning direct via electron-as-node: ${command} ${args.join(' ')}`);
      }
    } else {
      // Fallback: npx will download @agegr/pi-web on first run.
      const npx = resolveNpxBin();
      command = npx;
      args = ['--yes', '@agegr/pi-web@latest', '--no-open', '-p', port, '-H', hostname];
      if (DEBUG) console.log(`[shell] spawning via npx: ${command} ${args.join(' ')}`);
    }

    try {
      this.child = spawn(command, args, {
        cwd: os.homedir(),
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this.emit({ kind: 'error', message: `Failed to spawn pi-web: ${err.message}` });
      return;
    }

    this.child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      this.stdoutBuffer += text;
      writeLog('stdout', text.trimEnd());
      if (DEBUG) process.stdout.write(`[pi-web] ${text}`);
      if (!this.resolved && /Ready/i.test(this.stdoutBuffer)) {
        this.resolved = true;
        this.emit({ kind: 'ready', url: `http://${hostname}:${port}`, port: Number(port) });
      }
    });

    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      writeLog('stderr', text.trimEnd());
      if (DEBUG) process.stderr.write(`[pi-web:err] ${text}`);
      // Surface only the last 2 KB to the UI to avoid memory bloat.
      this.emit({ kind: 'stderr', text: text.slice(-2048) });
    });

    this.child.on('error', (err) => {
      this.emit({ kind: 'error', message: err.message });
    });

    this.child.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      if (DEBUG) console.log(`[shell] pi-web exited (${reason})`);
      this.child = null;
      this.emit({ kind: 'exit', code, signal });
    });

    // Hard timeout in case "Ready" never arrives.
    setTimeout(() => {
      if (!this.resolved && this.child) {
        this.emit({
          kind: 'error',
          message: `pi-web did not become ready within ${READY_TIMEOUT_MS / 1000}s. Check your network or firewall.`,
        });
      }
    }, READY_TIMEOUT_MS).unref();
  }

  async stop() {
    if (!this.child) return;
    const child = this.child;
    const pid = child.pid;
    // Claim the slot up front so a re-entrant stop() can't double-kill.
    this.child = null;

    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', done);

      // Kill the entire process tree. On Windows, child.kill() only kills
      // the direct child — but pi-web itself spawns "next start" as a
      // grandchild. Without /T (tree), that grandchild becomes an orphan
      // and keeps holding port 30141, breaking the next launch with
      // EADDRINUSE. taskkill /f /t /pid kills the whole tree atomically.
      //
      // On Unix, child.kill() forwards the signal to the child, which is
      // the standard process-group semantics we want on those platforms.
      if (pid && process.platform === 'win32') {
        try {
          execSync(`taskkill /f /t /pid ${pid}`, {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch (err) {
          // taskkill exits non-zero if the process is already gone — fine.
          if (DEBUG) console.warn('[shell] taskkill:', err.message);
        }
      } else {
        try {
          child.kill('SIGTERM');
        } catch (err) {
          if (DEBUG) console.warn('[shell] kill SIGTERM failed:', err.message);
        }
      }

      // Hard timeout fallback. Never block shutdown forever: if exit
      // doesn't arrive within CHILD_TERMINATE_GRACE_MS, resolve anyway
      // so the Electron close flow can complete.
      setTimeout(done, CHILD_TERMINATE_GRACE_MS).unref();
    });
  }
}

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

let mainWindow = null;
let piWeb = null;
let stateBeforeReady = 'starting'; // 'starting' | 'ready' | 'error'
let updater = null;
let updateState = null;
/** Pending child restart after an applied update. */
let pendingApplyRestart = false;
/** Guards re-entrant shutdown from close + before-quit both firing. */
let isShuttingDown = false;

// ---------------------------------------------------------------------------
// Updater integration
// ---------------------------------------------------------------------------

/** Push update-related state to the renderer. */
function pushUpdateStateToRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('shell:event', {
    kind: 'update:state',
    phase: updater ? updater.phase : 'idle',
    bytesDownloaded: updater ? updater.bytesDownloaded : 0,
    bytesTotal: updater ? updater.bytesTotal : 0,
    installedVersion: updateState ? updateState.get('installedVersion') : null,
    availableVersion: updateState ? updateState.get('availableVersion') : null,
    downloadedVersion: updateState ? updateState.get('downloadedVersion') : null,
    lastError: updateState ? updateState.get('lastCheckError') : null,
  });
}

async function triggerUpdateCheck({ manual = false } = {}) {
  if (!updater) return { ok: false, error: 'updater not initialized' };
  pushUpdateStateToRenderer();
  const result = await updater.checkForUpdates();
  if (manual && result.available) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update available',
      message: `Pi Web kernel ${result.version} is available.`,
      detail: 'It will download in the background. You will be notified when it is ready to install.',
      buttons: ['OK'],
    });
  } else if (manual && !result.available) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'No updates',
      message: 'You are running the latest Pi Web kernel.',
      detail: result.reason === 'shell-too-old'
        ? 'A newer kernel exists but requires a newer shell version.'
        : '',
      buttons: ['OK'],
    });
  }
  return { ok: true, ...result };
}

async function triggerRollback() {
  if (!updater) return { ok: false };
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    title: 'Roll back kernel?',
    message: 'This will revert Pi Web to the previously installed kernel and restart the server.',
    buttons: ['Cancel', 'Roll back'],
    defaultId: 0,
    cancelId: 0,
  });
  if (choice !== 1) return { ok: false, cancelled: true };

  try {
    await piWeb?.stop();
    await updater.rollback();
  } catch (err) {
    dialog.showErrorBox('Rollback failed', err.message);
    return { ok: false, error: err.message };
  }
  await restartChildProcess();
  return { ok: true };
}

async function applyUpdateAndRestart() {
  if (!updater) return { ok: false };
  try {
    await piWeb?.stop();
    await updater.applyUpdate();
  } catch (err) {
    dialog.showErrorBox('Update failed', err.message);
    pushUpdateStateToRenderer();
    return { ok: false, error: err.message };
  }
  // The activeDir now points at the new kernel; restart the child to use it.
  await restartChildProcess();
  // Schedule a follow-up check to see if there's another newer kernel.
  setTimeout(() => triggerUpdateCheck(), 5_000);
  return { ok: true };
}

async function restartChildProcess(targetPort) {
  if (piWeb) {
    await piWeb.stop();
  }
  piWeb = new PiWebProcess();
  attachPiWebHandlers(piWeb);
  stateBeforeReady = 'starting';

  const preferred = typeof targetPort === 'number' ? targetPort : getPreferredPort();
  currentPreferredPort = preferred;
  currentActualPort = await findAvailablePort(preferred);
  if (currentActualPort !== preferred) {
    console.log(`[shell] Preferred port ${preferred} in use, using ${currentActualPort}`);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }

  piWeb.start(currentActualPort);
}

/**
 * Attach the renderer-facing handlers to a fresh PiWebProcess instance.
 * Pulled out so that retry can swap in a new instance and re-attach.
 */
function attachPiWebHandlers(proc) {
  proc.on((event) => {
    switch (event.kind) {
      case 'ready':
        stateBeforeReady = 'ready';
        if (updater) updater.markHealthy();
        pushStateToRenderer('ready', { url: event.url, port: event.port });
        if (mainWindow && !mainWindow.isDestroyed()) {
          const titleSuffix = currentActualPort !== currentPreferredPort
            ? ` (Port ${currentActualPort}, Preferred ${currentPreferredPort} Busy)`
            : ` (Port ${currentActualPort})`;
          mainWindow.setTitle(`Pi Web${titleSuffix}`);
          mainWindow.loadURL(event.url);
        }
        break;
      case 'error':
        stateBeforeReady = 'error';
        pushStateToRenderer('error', { message: event.message });
        break;
      case 'exit':
        if (stateBeforeReady !== 'ready') {
          // Pre-ready crash: count toward auto-rollback threshold.
          const shouldRollback = updater ? updater.recordStartupFailure() : false;
          pushStateToRenderer('error', {
            message: `pi-web exited before becoming ready (${event.signal ? 'signal ' + event.signal : 'code ' + event.code}).` +
              (shouldRollback ? ' Auto-rollback triggered.' : ''),
          });
          if (shouldRollback) {
            // Run rollback asynchronously so we don't block the event loop.
            (async () => {
              try {
                await updater.rollback();
                await restartChildProcess();
              } catch (err) {
                console.error('[shell] auto-rollback failed:', err.message);
              }
            })();
          }
        } else {
          pushStateToRenderer('exit', { code: event.code, signal: event.signal });
        }
        break;
      case 'stderr':
        if (DEBUG) console.warn('[pi-web stderr]', event.text);
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Window management & Bounds Persistence (Antigravity-like spacious default)
// ---------------------------------------------------------------------------

function getInitialWindowBounds() {
  const settings = loadSettings();
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  // Antigravity-like spacious desktop IDE default: ~85% of screen or 1440x900
  const defaultWidth = Math.min(1440, Math.max(1280, Math.round(screenWidth * 0.85)));
  const defaultHeight = Math.min(920, Math.max(800, Math.round(screenHeight * 0.85)));

  const saved = settings.windowState;
  if (saved && typeof saved.width === 'number' && typeof saved.height === 'number') {
    return {
      width: Math.max(800, saved.width),
      height: Math.max(500, saved.height),
      x: saved.x,
      y: saved.y,
      isMaximized: Boolean(saved.isMaximized),
    };
  }

  return {
    width: defaultWidth,
    height: defaultHeight,
    isMaximized: false,
  };
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const isMaximized = win.isMaximized();
  if (!isMaximized) {
    const bounds = win.getBounds();
    saveSettings({
      windowState: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: false,
      },
    });
  } else {
    const current = loadSettings().windowState || {};
    saveSettings({
      windowState: {
        ...current,
        isMaximized: true,
      },
    });
  }
}

function createMainWindow() {
  const bounds = getInitialWindowBounds();

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 800,
    minHeight: 500,
    title: 'Pi Web',
    icon: getAppIcon(),
    backgroundColor: '#0b0f17',
    show: false, // Show only once we have real content (or an error).
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Disable Electron's default behaviour of opening http(s) links in a
      // new BrowserWindow; route them to the OS default browser instead.
      webSecurity: true,
    },
  });

  if (bounds.isMaximized) {
    mainWindow.maximize();
  }

  // Block in-app navigation to anything other than our localhost origin.
  // Anything else should open in the OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const ok = url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:');
    if (!ok) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('close', (event) => {
    saveWindowState(mainWindow);

    // Minimize to tray unless explicitly quitting
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }

    // Single source of truth for shutdown. If we've already started
    // shutting down (e.g. via before-quit), let the close proceed. If
    // not, take over and explicitly destroy the window after cleanup.
    if (isShuttingDown) return;
    isShuttingDown = true;
    event.preventDefault();

    doShutdown().then(() => {
      // Force-close: bypass any further close handlers and tear down
      // the BrowserWindow so the renderer process exits cleanly.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
      }
    });
  });

  buildMenu();

  // Load the local loading screen while pi-web boots.
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

let portSettingsWindow = null;

function openPortSettings() {
  if (portSettingsWindow && !portSettingsWindow.isDestroyed()) {
    portSettingsWindow.focus();
    return;
  }
  portSettingsWindow = new BrowserWindow({
    width: 460,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow || undefined,
    modal: mainWindow ? true : false,
    title: '设置服务端口',
    backgroundColor: '#0b0f17',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  portSettingsWindow.setMenuBarVisibility(false);
  portSettingsWindow.loadFile(path.join(__dirname, 'renderer', 'port-settings.html'));
  portSettingsWindow.on('closed', () => {
    portSettingsWindow = null;
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: '设置服务端口 (Port)...',
          click: () => openPortSettings(),
        },
        {
          label: '开机自动启动 (Launch at Startup)',
          type: 'checkbox',
          checked: isAutoStartEnabled(),
          click: (item) => {
            setAutoStart(item.checked);
          },
        },
        { type: 'separator' },
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.reload(),
        },
        { type: 'separator' },
        {
          label: '彻底退出 (Quit)',
          accelerator: isMac ? 'Cmd+Q' : 'CmdOrCtrl+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Kernel',
      submenu: [
        {
          label: 'Check for updates…',
          click: () => triggerUpdateCheck({ manual: true }),
        },
        {
          label: 'Roll back to previous kernel',
          click: () => triggerRollback(),
        },
        {
          label: 'Open update log',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('shell:event', { kind: 'update:open-log' });
            }
          },
        },
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'About Pi Web',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Pi Web',
              message: 'Pi Web',
              detail:
                'A desktop shell for @agegr/pi-web.\n\n' +
                `Shell ${app.getVersion()}\n` +
                `Kernel ${updater ? (updater.state.get('installedVersion') || 'unknown') : 'unknown'}\n` +
                `Electron ${process.versions.electron}\n` +
                `Node ${process.versions.node}\n` +
                `Chrome ${process.versions.chrome}`,
              buttons: ['OK'],
            });
          },
        },
        { type: 'separator' },
        {
          label: '查看运行日志 (Open Log File)',
          click: () => openLogFile(),
        },
        {
          label: '打开日志文件夹 (Open Logs Folder)',
          click: () => openLogFolder(),
        },
        {
          label: '打开数据文件夹 (Open Data Folder)',
          click: () => shell.openPath(path.join(os.homedir(), '.pi', 'agent')),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Lifecycle wiring
// ---------------------------------------------------------------------------

/**
 * Single shutdown path. Stops the kernel child (which now kills the
 * whole process tree on Windows so grandchildren don't outlive us),
 * nulls the references so re-entry is a no-op, and resolves.
 *
 * Idempotent: safe to call multiple times concurrently — the inner
 * check on `piWeb` ensures we only stop once.
 */
async function doShutdown() {
  if (piWeb) {
    const local = piWeb;
    piWeb = null;
    try {
      await local.stop();
    } catch (err) {
      console.error('[shell] shutdown error:', err.message);
    }
  }
}

function pushStateToRenderer(kind, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('shell:event', { kind, ...payload });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  // Single-instance lock. The second process will only emit 'second-instance'
  // and then exit.
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  // Initialize the updater first so we can report kernel version in the UI.
  // We do this BEFORE creating the window so the initial state already has
  // the installed version populated.
  const stateDir = app.getPath('userData');
  updateState = new UpdateState(stateDir).load();
  updateState.set({ shellVersion: app.getVersion() });
  updater = new KernelUpdater({
    resourcesRoot: getResourcesRoot(),
    state: updateState,
    onEvent: () => pushUpdateStateToRenderer(),
    debug: DEBUG,
  });
  await updater.init();

  createMainWindow();
  createTray();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // Push initial update state so the renderer can render the correct banner.
  pushUpdateStateToRenderer();

  piWeb = new PiWebProcess();
  attachPiWebHandlers(piWeb);

  currentPreferredPort = getPreferredPort();
  currentActualPort = await findAvailablePort(currentPreferredPort);
  if (currentActualPort !== currentPreferredPort) {
    console.log(`[shell] Preferred port ${currentPreferredPort} in use, using ${currentActualPort}`);
  }
  piWeb.start(currentActualPort);

  // Kick off the first update check in the background. We don't await it
  // so window paint and child spawn aren't blocked on network.
  scheduleUpdateCheck(0);
});

/**
 * Schedule an update check after `delayMs`. Subsequent calls reset the
 * timer (debounce), so manual triggers from the menu don't double-fire.
 */
let _updateCheckTimer = null;
function scheduleUpdateCheck(delayMs = 0) {
  if (_updateCheckTimer) clearTimeout(_updateCheckTimer);
  _updateCheckTimer = setTimeout(async () => {
    _updateCheckTimer = null;
    if (!updater) return;
    if (process.env.PI_WEB_UPDATE_DISABLED === '1') return;
    try {
      const result = await updater.checkForUpdates();
      if (result.available) {
        // Background-download the update without bothering the user.
        try {
          await updater.downloadUpdate();
          // Surface a non-modal notification when the update is ready.
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('shell:event', {
              kind: 'update:ready-toast',
              version: result.version,
            });
          }
        } catch (err) {
          console.warn('[shell] background download failed:', err.message);
        }
      }
    } catch (err) {
      if (DEBUG) console.warn('[shell] scheduled check failed:', err.message);
    }
  }, delayMs);
}

app.on('window-all-closed', () => {
  if (isQuitting || process.platform !== 'darwin') {
    // If not quitting, the window was hidden to tray, so keep process alive.
    if (isQuitting) app.quit();
  }
});

app.on('before-quit', (event) => {
  isQuitting = true;
  // If the close handler already started shutdown, let the quit proceed.
  // Otherwise, take over: prevent the quit, run cleanup, then exit hard.
  if (isShuttingDown) return;
  isShuttingDown = true;
  event.preventDefault();

  doShutdown().then(() => {
    // app.exit() bypasses the event loop entirely so we don't risk any
    // pending IPC / timers / awaits keeping the process alive.
    app.exit(0);
  });
});

// ---------------------------------------------------------------------------
// IPC from renderer
// ---------------------------------------------------------------------------

ipcMain.handle('shell:get-state', () => ({ state: stateBeforeReady }));

ipcMain.handle('shell:get-port-config', () => ({
  preferredPort: currentPreferredPort,
  actualPort: currentActualPort,
}));

ipcMain.handle('shell:set-preferred-port', async (_event, newPort) => {
  const port = parseInt(newPort, 10);
  if (isNaN(port) || port < 1024 || port > 65535) {
    return { ok: false, error: '端口号必须在 1024 到 65535 之间' };
  }
  saveSettings({ preferredPort: port });
  await restartChildProcess(port);
  return { ok: true };
});

ipcMain.handle('shell:retry', async () => {
  if (piWeb) {
    await restartChildProcess();
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle('shell:open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    shell.openExternal(url);
    return { ok: true };
  }
  return { ok: false };
});

// ---------------------------------------------------------------------------
// Update IPC
// ---------------------------------------------------------------------------

ipcMain.handle('update:get-state', () => ({
  phase: updater ? updater.phase : 'idle',
  bytesDownloaded: updater ? updater.bytesDownloaded : 0,
  bytesTotal: updater ? updater.bytesTotal : 0,
  installedVersion: updateState ? updateState.get('installedVersion') : null,
  availableVersion: updateState ? updateState.get('availableVersion') : null,
  downloadedVersion: updateState ? updateState.get('downloadedVersion') : null,
  lastCheckAt: updateState ? updateState.get('lastCheckAt') : null,
  lastError: updateState ? updateState.get('lastCheckError') : null,
  changelog:
    updateState && updateState.get('availableTarball')
      ? updateState.get('availableTarball').changelog || null
      : null,
}));

ipcMain.handle('update:check', () => triggerUpdateCheck({ manual: true }));

ipcMain.handle('update:download', async () => {
  if (!updater) return { ok: false, error: 'updater not initialized' };
  try {
    await updater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('update:apply-and-restart', () => applyUpdateAndRestart());

ipcMain.handle('update:rollback', () => triggerRollback());

ipcMain.handle('update:cancel-download', () => {
  if (updater) updater.cancelDownload();
  return { ok: true };
});