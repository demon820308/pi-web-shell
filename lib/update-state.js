'use strict';

/**
 * update-state.js — persistent state for the kernel updater.
 *
 * Stored in app.getPath('userData') which on Windows is
 *   %APPDATA%\Pi Web\update-state.json
 * and on macOS / Linux is the standard platform location. We deliberately
 * keep this OUTSIDE of resources/ so it survives kernel swaps and is
 * trivially inspectable.
 *
 * Fields tracked:
 *   - lastCheckAt: ISO timestamp of the last manifest fetch attempt
 *   - lastCheckError: string | null
 *   - availableVersion: string | null      (latest known newer version)
 *   - availableTarball: { url, sha256, size, minShellVersion, changelog }
 *   - downloadedVersion: string | null     (tarball downloaded + verified)
 *   - downloadPath: string | null          (resources/pi-web-incoming/)
 *   - appliedAt: string | null             (when we last swapped)
 *   - startupFailures: number              (counter for auto-rollback)
 *   - lastError: { message, at } | null
 */

const fs = require('fs');
const path = require('path');

const FILENAME = 'update-state.json';
const DEFAULTS = () => ({
  schemaVersion: 1,
  lastCheckAt: null,
  lastCheckError: null,
  availableVersion: null,
  availableTarball: null,
  downloadedVersion: null,
  downloadPath: null,
  appliedAt: null,
  startupFailures: 0,
  lastError: null,
});

class UpdateState {
  /**
   * @param {string} stateDir Directory where update-state.json lives.
   */
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.filePath = path.join(stateDir, FILENAME);
    this.state = DEFAULTS();
    this._loaded = false;
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        // Merge with defaults so missing keys don't blow up older state files.
        this.state = { ...DEFAULTS(), ...parsed };
      }
    } catch (err) {
      // Corrupt state file: keep defaults, log to console.
      console.warn('[update-state] failed to load state, using defaults:', err.message);
      this.state = DEFAULTS();
    }
    this._loaded = true;
    return this;
  }

  save() {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn('[update-state] failed to save:', err.message);
    }
  }

  get(key) {
    return this.state[key];
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.save();
    return this.state;
  }

  reset() {
    this.state = DEFAULTS();
    this.save();
  }

  /** Increment the startup failure counter and return the new value. */
  recordStartupFailure() {
    this.state.startupFailures = (this.state.startupFailures || 0) + 1;
    this.save();
    return this.state.startupFailures;
  }

  /** Reset the startup failure counter (called when the server stays up). */
  resetStartupFailures() {
    if (this.state.startupFailures !== 0) {
      this.state.startupFailures = 0;
      this.save();
    }
  }

  /** Mark current kernel as healthy (e.g., after Ready). */
  markHealthy() {
    this.resetStartupFailures();
  }
}

module.exports = { UpdateState, FILENAME };