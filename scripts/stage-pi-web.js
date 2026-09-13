'use strict';

/**
 * stage-pi-web.js — install @agegr/pi-web into resources/pi-web/ so it can be
 * packaged into the EXE alongside the bundled Node runtime.
 *
 * Why: Phase 2 ships the entire pi-web server (including its .next build
 * artifacts and node-pty native binaries) inside the EXE. We isolate this
 * install in a dedicated directory so:
 *   1. It doesn't pollute the shell's dev node_modules.
 *   2. npm can hoist and dedupe cleanly without interference.
 *   3. electron-builder can glob it as a single extraResources entry.
 *
 * Idempotent: skips when the pinned version is already staged.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Pin to a known-working version. Bump to test upgrades.
const PI_WEB_VERSION = '0.9.0';

const RESOURCES_DIR = path.join(__dirname, '..', 'resources');
const STAGE_DIR = path.join(RESOURCES_DIR, 'pi-web');

function isAlreadyStaged() {
  const pkgJson = path.join(
    STAGE_DIR,
    'node_modules',
    '@agegr',
    'pi-web',
    'package.json'
  );
  if (!fs.existsSync(pkgJson)) return false;
  try {
    const installed = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    return installed.version === PI_WEB_VERSION;
  } catch {
    return false;
  }
}

function main() {
  if (isAlreadyStaged()) {
    console.log(`[stage-pi-web] @agegr/pi-web@${PI_WEB_VERSION} already staged, skipping.`);
    return;
  }

  // Clean and recreate.
  if (fs.existsSync(STAGE_DIR)) {
    console.log('[stage-pi-web] Removing previous staging directory.');
    fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(STAGE_DIR, { recursive: true });

  // Seed package.json so npm treats this as its own project root.
  fs.writeFileSync(
    path.join(STAGE_DIR, 'package.json'),
    JSON.stringify(
      {
        name: 'pi-web-shell-staging',
        version: '1.0.0',
        private: true,
        description: 'Staged copy of @agegr/pi-web for inclusion in the desktop shell.',
        dependencies: {
          '@agegr/pi-web': PI_WEB_VERSION,
        },
      },
      null,
      2
    )
  );

  console.log(`[stage-pi-web] Installing @agegr/pi-web@${PI_WEB_VERSION} into ${STAGE_DIR}`);
  // --omit=dev keeps production deps only (devDependencies of pi-web and its
  //   transitive deps are not needed at runtime). npm still runs lifecycle
  //   scripts for explicitly-installed packages, so pi-web's `postinstall`
  //   (which chmods node-pty's spawn-helper on macOS) will run.
  execSync(
    'npm install --omit=dev --no-audit --no-fund --loglevel=error',
    {
      cwd: STAGE_DIR,
      stdio: 'inherit',
      // Ensure we get a Node-matching ABI for any native deps pi-web pulls in.
      env: { ...process.env, npm_config_build_from_source: 'false' },
    }
  );

  // Sanity check.
  const pkgJson = path.join(
    STAGE_DIR,
    'node_modules',
    '@agegr',
    'pi-web',
    'package.json'
  );
  if (!fs.existsSync(pkgJson)) {
    throw new Error('Stage install succeeded but @agegr/pi-web/package.json not found.');
  }
  const installed = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
  console.log(`[stage-pi-web] Staged @agegr/pi-web@${installed.version} successfully.`);
}

main();