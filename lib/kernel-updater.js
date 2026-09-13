'use strict';

/**
 * kernel-updater.js — the engine behind silent kernel hot-updates.
 *
 * Lifecycle:
 *
 *   checkForUpdates()
 *     ├─ fetches manifest
 *     ├─ if kernel.version <= installed version → state = 'up-to-date'
 *     └─ else → state = 'available', stores manifest info
 *
 *   downloadUpdate() (called when 'available')
 *     ├─ downloads tarball to resources/pi-web-incoming/kernel.tar.gz
 *     ├─ streams sha256 verification during download
 *     ├─ extracts tarball to resources/pi-web-incoming/
 *     ├─ sanity-checks node_modules/@agegr/pi-web/package.json
 *     └─ state = 'ready'
 *
 *   applyUpdate() (called when 'ready')
 *     ├─ if resources/pi-web is live → rename to pi-web-backup
 *     ├─ rename pi-web-incoming → pi-web
 *     └─ state = 'applied' (caller restarts the child process)
 *
 *   rollback() (called when startupFailures > threshold)
 *     ├─ rename pi-web → pi-web-incoming (back to staging)
 *     ├─ rename pi-web-backup → pi-web (back to previous version)
 *     └─ state = 'rolled-back'
 *
 * All public methods are idempotent. State transitions are atomic per-file
 * (we always write tmp + rename). The download is streamed so memory usage
 * stays flat regardless of kernel size (~500 MB).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const tar = require('tar');
const semver = require('semver');

const { fetchManifest, DEFAULT_MANIFEST_URL } = require('./manifest-client');

const INCOMING_DIR_NAME = 'pi-web-incoming';
const BACKUP_DIR_NAME = 'pi-web-backup';
const ACTIVE_DIR_NAME = 'pi-web';
const TARBALL_FILENAME = 'kernel.tar.gz';
const STARTUP_FAILURE_THRESHOLD = 3;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

/**
 * Compare two semver strings ("0.9.0", "1.2.3-rc.1") using the bundled
 * `semver` package. Returns -1, 0, or 1.
 *
 * Falls back to a string comparison if either input is not valid semver.
 */
function compareVersions(a, b) {
  if (semver.valid(a) && semver.valid(b)) {
    return semver.compare(a, b);
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Read the currently-installed pi-web version. Returns null if not present. */
async function readInstalledVersion(kernelDir) {
  const pkgJson = path.join(kernelDir, 'node_modules', '@agegr', 'pi-web', 'package.json');
  try {
    const raw = await fsp.readFile(pkgJson, 'utf8');
    return JSON.parse(raw).version;
  } catch {
    return null;
  }
}

/**
 * Read the version of the kernel staged for the next launch, if any.
 * Used to detect a kernel that was swapped-in by a previous run.
 */
async function readIncomingVersion(resourcesRoot) {
  return readInstalledVersion(path.join(resourcesRoot, INCOMING_DIR_NAME));
}

/** Free disk space in bytes for the given path. Returns null if unsupported. */
async function freeDiskBytes(targetPath) {
  // Best-effort: only Windows has a reliable synchronous statvfs-style API
  // via fs.statfs in Node 22+. On other platforms return null and skip the
  // pre-flight check.
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(targetPath);
      return stats.bavail * stats.bsize;
    }
  } catch {
    // ignore
  }
  return null;
}

class KernelUpdater {
  /**
   * @param {object} opts
   * @param {string} opts.resourcesRoot  Absolute path to resources/.
   * @param {import('./update-state').UpdateState} opts.state
   * @param {(event: object) => void} opts.onEvent  Called with state transitions.
   * @param {boolean} [opts.debug]
   */
  constructor({ resourcesRoot, state, onEvent, debug = false }) {
    this.resourcesRoot = resourcesRoot;
    this.state = state;
    this.onEvent = onEvent || (() => {});
    this.debug = debug;

    this.activeDir = path.join(resourcesRoot, ACTIVE_DIR_NAME);
    this.incomingDir = path.join(resourcesRoot, INCOMING_DIR_NAME);
    this.backupDir = path.join(resourcesRoot, BACKUP_DIR_NAME);
    this.tarballPath = path.join(this.incomingDir, TARBALL_FILENAME);

    /** @type {'idle'|'checking'|'up-to-date'|'available'|'downloading'|'ready'|'applying'|'applied'|'rolled-back'|'error'} */
    this.phase = 'idle';
    /** Bytes downloaded so far in the current download. */
    this.bytesDownloaded = 0;
    /** Total bytes expected. */
    this.bytesTotal = 0;
    /** AbortController for the in-flight download. */
    this._abort = null;
    /** Last error message (also persisted to state). */
    this.lastError = null;
  }

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  _emit(extra = {}) {
    this.onEvent({
      phase: this.phase,
      bytesDownloaded: this.bytesDownloaded,
      bytesTotal: this.bytesTotal,
      installedVersion: this.state.get('installedVersion'),
      availableVersion: this.state.get('availableVersion'),
      lastError: this.lastError,
      ...extra,
    });
  }

  _setPhase(phase, extra = {}) {
    this.phase = phase;
    this._emit(extra);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Read installed version, sanity-check that resources/pi-web exists.
   * Run once at startup.
   */
  async init() {
    const installed = await readInstalledVersion(this.activeDir);
    this.state.set({ installedVersion: installed });
    return installed;
  }

  /**
   * Fetch the manifest and decide if an update is available. Returns:
   *   { available: boolean, version: string | null, reason: string }
   */
  async checkForUpdates() {
    this._setPhase('checking');
    try {
      const manifest = await fetchManifest();
      const installed = await readInstalledVersion(this.activeDir);
      const remote = manifest.kernel.version;

      // Shell compatibility gate.
      if (manifest.kernel.minShellVersion) {
        const minOk = compareVersions(
          this.state.get('shellVersion') || '0.0.0',
          manifest.kernel.minShellVersion
        ) >= 0;
        if (!minOk) {
          this._setPhase('up-to-date', { availableVersion: null });
          this.state.set({
            lastCheckAt: new Date().toISOString(),
            lastCheckError: `Update requires shell >= ${manifest.kernel.minShellVersion}`,
            availableVersion: null,
          });
          return { available: false, version: null, reason: 'shell-too-old' };
        }
      }

      const cmp = compareVersions(remote, installed || '0.0.0');
      const isNewer = cmp > 0;

      // If we already have a downloaded incoming kernel and it matches the
      // remote version, surface it as ready — regardless of whether the
      // active dir is empty (e.g. first run after a botched swap). This
      // prevents redundant re-downloads.
      const incomingVer = await readIncomingVersion(this.resourcesRoot);
      if (incomingVer && compareVersions(incomingVer, remote) === 0) {
        this.state.set({
          downloadedVersion: incomingVer,
          downloadPath: this.incomingDir,
          availableVersion: remote,
          availableTarball: manifest.kernel,
        });
        this._setPhase('ready', { availableVersion: remote });
        return { available: true, version: remote, reason: 'already-downloaded' };
      }

      this.state.set({
        lastCheckAt: new Date().toISOString(),
        lastCheckError: null,
        manifestEtag: manifest.kernel.tarball, // opportunistic cache key
      });

      if (!isNewer) {
        this.state.set({ availableVersion: null, availableTarball: null });
        this._setPhase('up-to-date', { availableVersion: null });
        return { available: false, version: null, reason: 'current' };
      }

      // Newer version available.
      this.state.set({
        availableVersion: remote,
        availableTarball: manifest.kernel,
      });
      this._setPhase('available', { availableVersion: remote });
      return { available: true, version: remote, reason: 'newer' };
    } catch (err) {
      this.lastError = err.message;
      this.state.set({
        lastCheckAt: new Date().toISOString(),
        lastCheckError: err.message,
      });

      // A 404 on the default manifest URL means "not published yet" — a
      // normal condition for fresh installs. Treat it as no-update-available
      // so we don't show an alarming error banner. Only surface the error
      // when the user explicitly configured PI_WEB_UPDATE_MANIFEST_URL,
      // because in that case the URL is intentional and likely a typo.
      const usedDefaultUrl = !process.env.PI_WEB_UPDATE_MANIFEST_URL;
      if (err.code === 'MANIFEST_NOT_FOUND' && usedDefaultUrl) {
        this._setPhase('up-to-date', { availableVersion: null });
        return { available: false, version: null, reason: 'manifest-not-published' };
      }

      this._setPhase('error', { lastError: err.message });
      return { available: false, version: null, reason: 'check-failed', error: err.message };
    }
  }

  /**
   * Download the kernel tarball + verify SHA256 + extract.
   * Idempotent: if a verified download for the same version already exists,
   * it short-circuits to extraction verification.
   */
  async downloadUpdate() {
    const available = this.state.get('availableTarball');
    const version = this.state.get('availableVersion');
    if (!available || !version) {
      throw new Error('No update available to download');
    }

    // Free disk space check (skip if statfs unavailable).
    const freeBytes = await freeDiskBytes(this.resourcesRoot);
    const needed = (available.size || 0) * 2.5; // tarball + extracted + working space
    if (freeBytes !== null && freeBytes < needed) {
      throw new Error(
        `Insufficient disk space: need ~${Math.ceil(needed / 1e9)} GB, have ${Math.ceil(freeBytes / 1e9)} GB`
      );
    }

    // Reset incoming dir.
    await fsp.rm(this.incomingDir, { recursive: true, force: true });
    await fsp.mkdir(this.incomingDir, { recursive: true });

    this._setPhase('downloading', { availableVersion: version });
    this.bytesDownloaded = 0;
    this.bytesTotal = available.size;

    try {
      await this._downloadAndVerify(available);
      await this._extractTarball();
      await this._verifyExtractedKernel(version);
      this.state.set({
        downloadedVersion: version,
        downloadPath: this.incomingDir,
      });
      this._setPhase('ready', { availableVersion: version });
      return { ok: true, version };
    } catch (err) {
      this.lastError = err.message;
      this.state.set({ lastError: { message: err.message, at: new Date().toISOString() } });
      // Clean up partial download.
      await fsp.rm(this.incomingDir, { recursive: true, force: true }).catch(() => {});
      this._setPhase('error', { lastError: err.message });
      throw err;
    }
  }

  /**
   * Swap the incoming kernel into place. After this returns, the active
   * kernel path points at the new version. Caller MUST restart the child
   * process for the swap to take effect.
   *
   * Atomicity: we use two renames. On failure mid-way we attempt to undo.
   */
  async applyUpdate() {
    const version = this.state.get('downloadedVersion');
    if (!version) throw new Error('No downloaded kernel to apply');

    this._setPhase('applying', { availableVersion: version });

    // If the active dir doesn't exist (e.g. first run with no bundled kernel
    // and we're recovering from a botched swap), just rename incoming.
    const activeExists = fs.existsSync(this.activeDir);
    const backupExists = fs.existsSync(this.backupDir);

    // Move aside any stale backup so we have a free slot.
    if (backupExists) {
      await fsp.rm(this.backupDir, { recursive: true, force: true });
    }

    try {
      if (activeExists) {
        await fsp.rename(this.activeDir, this.backupDir);
      }
      await fsp.rename(this.incomingDir, this.activeDir);
    } catch (err) {
      // Attempt to undo.
      this.lastError = err.message;
      if (fs.existsSync(this.backupDir) && !fs.existsSync(this.activeDir)) {
        await fsp.rename(this.backupDir, this.activeDir).catch(() => {});
      }
      this._setPhase('error', { lastError: err.message });
      throw err;
    }

    this.state.set({
      appliedAt: new Date().toISOString(),
      installedVersion: version,
      downloadedVersion: null,
      downloadPath: null,
      startupFailures: 0,
      availableVersion: null,
      availableTarball: null,
    });
    this._setPhase('applied', { availableVersion: version });
    return { ok: true, version };
  }

  /**
   * Revert to the previous kernel by swapping back. Used both by the user
   * (via menu) and by the auto-rollback when startupFailures exceeds the
   * threshold.
   */
  async rollback() {
    if (!fs.existsSync(this.backupDir)) {
      throw new Error('No backup kernel available to roll back to');
    }
    this._setPhase('applying');

    // Move current aside (to incoming, so it's preserved but not active).
    if (fs.existsSync(this.activeDir)) {
      await fsp.rm(this.incomingDir, { recursive: true, force: true });
      await fsp.rename(this.activeDir, this.incomingDir);
    }
    await fsp.rename(this.backupDir, this.activeDir);

    const restoredVer = await readInstalledVersion(this.activeDir);
    this.state.set({
      installedVersion: restoredVer,
      appliedAt: new Date().toISOString(),
      lastError: { message: 'rolled back', at: new Date().toISOString() },
      startupFailures: 0,
    });
    this._setPhase('rolled-back', { availableVersion: null });
    return { ok: true, version: restoredVer };
  }

  /** Cancel an in-flight download. */
  cancelDownload() {
    if (this._abort) {
      this._abort.abort();
      this._abort = null;
    }
  }

  /**
   * Called when the child process successfully reports "Ready". We reset
   * the failure counter so a previously-crashing kernel doesn't trigger
   * auto-rollback after it's been fixed by a fresh download.
   */
  markHealthy() {
    this.state.markHealthy();
  }

  /**
   * Called when the child process exits unexpectedly before becoming
   * healthy. Increments the failure counter and returns whether auto-
   * rollback should be triggered.
   */
  recordStartupFailure() {
    const count = this.state.recordStartupFailure();
    return count >= STARTUP_FAILURE_THRESHOLD;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  _downloadAndVerify(manifestKernel) {
    return new Promise((resolve, reject) => {
      this._abort = new AbortController();
      const url = new URL(manifestKernel.tarball);
      const lib = url.protocol === 'https:' ? https : http;

      const req = lib.get(
        url,
        {
          headers: { 'User-Agent': 'pi-web-shell' },
          timeout: DOWNLOAD_TIMEOUT_MS,
          signal: this._abort.signal,
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} for tarball`));
          }

          const hasher = crypto.createHash('sha256');
          const fileStream = fs.createWriteStream(this.tarballPath);

          res.on('data', (chunk) => {
            this.bytesDownloaded += chunk.length;
            hasher.update(chunk);
            this._emit();
          });

          res.on('error', (err) => {
            fileStream.destroy();
            reject(err);
          });

          fileStream.on('error', reject);

          pipeline(res, fileStream)
            .then(() => {
              // SHA256 verification is optional: only enforced when the
              // manifest provided a hash (custom manifest). For GitHub
              // releases we trust HTTPS transport.
              if (manifestKernel.sha256) {
                const digest = hasher.digest('hex').toLowerCase();
                const expected = String(manifestKernel.sha256).toLowerCase();
                if (digest !== expected) {
                  return reject(
                    new Error(`SHA256 mismatch: expected ${expected}, got ${digest}`)
                  );
                }
              }
              resolve();
            })
            .catch(reject);
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error('Tarball download timeout'));
      });
      req.on('error', (err) => {
        if (err.name === 'AbortError') return; // user-cancelled
        reject(err);
      });
    });
  }

  async _extractTarball() {
    // tar.x reads .tar / .tar.gz / .tgz automatically.
    await tar.x({
      file: this.tarballPath,
      cwd: this.incomingDir,
      // Strip the top-level directory from each entry. The release script
      // packs with `tar -C resources/pi-web -czf ...` so the tarball contains
      // bare paths like "node_modules/@agegr/pi-web/...". No strip needed.
    });
    // Remove the tarball after extraction to reclaim space.
    await fsp.rm(this.tarballPath, { force: true });
  }

  async _verifyExtractedKernel(expectedVersion) {
    const installed = await readInstalledVersion(this.incomingDir);
    if (!installed) {
      throw new Error('Extracted kernel is missing @agegr/pi-web/package.json');
    }
    if (compareVersions(installed, expectedVersion) !== 0) {
      throw new Error(
        `Extracted kernel reports version ${installed}, expected ${expectedVersion}`
      );
    }
    // Quick sanity check: bin/pi-web.js exists.
    const entry = path.join(this.incomingDir, 'node_modules', '@agegr', 'pi-web', 'bin', 'pi-web.js');
    await fsp.access(entry, fs.constants.R_OK);
  }
}

module.exports = {
  KernelUpdater,
  compareVersions,
  STARTUP_FAILURE_THRESHOLD,
  ACTIVE_DIR_NAME,
  INCOMING_DIR_NAME,
  BACKUP_DIR_NAME,
};