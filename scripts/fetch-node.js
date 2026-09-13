'use strict';

/**
 * fetch-node.js — download a portable Node.js runtime into resources/node/.
 *
 * Why: Phase 2 ships the Node runtime inside the EXE so users don't have to
 * install Node separately. We download the official Node.js distribution
 * tarball once at build time and stage only the files we need (node binary,
 * npm, npx, and their internal node_modules).
 *
 * Idempotent: re-running the script skips download when the right binary
 * version is already present. Bumping NODE_VERSION forces a re-download.
 *
 * Cross-platform: detects the host platform. For multi-platform builds run
 * this on each target host (electron-builder only packages for the host OS
 * by default).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Pin a Node version that satisfies pi-web's >=22.19 requirement and is an
// active LTS. Bump manually after testing against the bundled native modules.
const NODE_VERSION = '22.19.0';

const RESOURCES_DIR = path.join(__dirname, '..', 'resources');
const NODE_DIR = path.join(RESOURCES_DIR, 'node');
const VERSION_DIR = path.join(NODE_DIR, `v${NODE_VERSION}`);

// ---------------------------------------------------------------------------
// Download helper (follows one redirect, no extra deps)
// ---------------------------------------------------------------------------

function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const request = (u) =>
      https
        .get(u, (response) => {
          // nodejs.org redirects to a CDN; follow one hop.
          if (response.statusCode === 301 || response.statusCode === 302) {
            response.resume();
            return request(response.headers.location);
          }
          if (response.statusCode !== 200) {
            response.resume();
            return reject(new Error(`HTTP ${response.statusCode} for ${u}`));
          }
          const file = fs.createWriteStream(dest);
          response.pipe(file);
          file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())));
          file.on('error', reject);
        })
        .on('error', reject);
    request(url);
  });
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract a zip (Windows) or tar.gz (Unix) into destDir using the platform's
 * built-in tools. Avoids any extra npm dependency.
 */
function extract(archivePath, destDir, kind) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    // PowerShell's Expand-Archive is available on Windows 10+ and handles
    // Node's zip without needing admin rights.
    const ps = `Expand-Archive -Path "${archivePath}" -DestinationPath "${destDir}" -Force`;
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`, {
      stdio: 'inherit',
    });
  } else {
    execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: 'inherit' });
  }
}

// ---------------------------------------------------------------------------
// Files to copy from the extracted tarball
// ---------------------------------------------------------------------------

/**
 * Returns the list of files/dirs to copy from the extracted Node tarball into
 * VERSION_DIR, relative to the extraction root. We exclude docs, man pages,
 * include headers, and other dev artifacts to keep the bundle small.
 */
function filesToCopy(platform) {
  if (platform === 'win32') {
    // Windows zip layout: everything at the root of the extracted dir.
    return [
      'node.exe',
      'npm.cmd',
      'npx.cmd',
      'node_modules/npm',
      'node_modules/npm.cmd',
      'node_modules/npx',
      'node_modules/npx.cmd',
      'node_modules/corepack',
      'node_modules/corepack.cmd',
    ];
  }
  // Unix tarball layout: bin/, include/, lib/, share/, node_modules/.
  return [
    'bin',
    'lib',
    'share',
    'include',
    'node_modules/npm',
    'node_modules/corepack',
  ];
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

// ---------------------------------------------------------------------------
// Platform / URL selection
// ---------------------------------------------------------------------------

function platformArchString() {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  }
  // linux
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

function archiveExtension() {
  return process.platform === 'win32' ? 'zip' : 'tar.gz';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Idempotency: skip if the right binary already exists.
  const expectedBin =
    process.platform === 'win32'
      ? path.join(VERSION_DIR, 'node.exe')
      : path.join(VERSION_DIR, 'bin', 'node');

  if (fs.existsSync(expectedBin)) {
    console.log(`[fetch-node] ${expectedBin} already present, skipping download.`);
    return;
  }

  fs.mkdirSync(NODE_DIR, { recursive: true });

  const platformArch = platformArchString();
  const ext = archiveExtension();
  const filename = `node-v${NODE_VERSION}-${platformArch}.${ext}`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${filename}`;

  const tmpArchive = path.join(os.tmpdir(), filename);
  console.log(`[fetch-node] Downloading ${url}`);
  await downloadToFile(url, tmpArchive);

  console.log(`[fetch-node] Extracting ${filename}`);
  const tmpExtract = fs.mkdtempSync(path.join(os.tmpdir(), 'node-extract-'));
  extract(tmpArchive, tmpExtract, ext);

  // Find the single subdirectory created by the archive.
  const entries = fs.readdirSync(tmpExtract);
  const extractedRoot = entries.find((e) => e.startsWith('node-v'));
  if (!extractedRoot) {
    throw new Error('Could not locate extracted Node directory');
  }
  const extractedPath = path.join(tmpExtract, extractedRoot);

  // Stage only the files we need into VERSION_DIR.
  fs.mkdirSync(VERSION_DIR, { recursive: true });
  for (const rel of filesToCopy(process.platform)) {
    const src = path.join(extractedPath, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(VERSION_DIR, rel);
    copyRecursive(src, dest);
  }

  // Cleanup.
  fs.rmSync(tmpExtract, { recursive: true, force: true });
  fs.rmSync(tmpArchive, { force: true });

  console.log(`[fetch-node] Staged Node ${NODE_VERSION} at ${VERSION_DIR}`);
  console.log(`[fetch-node] Binary: ${expectedBin}`);
}

main().catch((err) => {
  console.error('[fetch-node] Failed:', err.message);
  process.exit(1);
});