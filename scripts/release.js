#!/usr/bin/env node
'use strict';

/**
 * release.js — build a kernel tarball and manifest for distribution.
 *
 * Usage:
 *   node scripts/release.js                    # auto-detect version from staging
 *   node scripts/release.js --version 0.10.0   # explicit version
 *   node scripts/release.js --output ./out      # output directory (default ./dist-kernel)
 *   node scripts/release.js --upload           # auto-upload via `gh` CLI
 *
 * Pipeline:
 *   1. Sanity-check resources/pi-web/node_modules/@agegr/pi-web/package.json
 *   2. Tar + gzip resources/pi-web into a versioned tarball
 *   3. SHA-256 the tarball
 *   4. Emit kernel-manifest.json alongside
 *   5. (optional) Push to GitHub Release via `gh release create`
 *
 * The output directory is gitignored and excluded from electron-builder.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAGING_DIR = path.join(ROOT, 'resources', 'pi-web');
const PACKAGE_JSON_PATH = path.join(STAGING_DIR, 'node_modules', '@agegr', 'pi-web', 'package.json');

// Defaults — overridden by CLI flags or env.
const DEFAULT_OUTPUT_DIR = path.join(ROOT, 'dist-kernel');
const DEFAULT_SHELL_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();
const DEFAULT_MANIFEST_URL =
  process.env.PI_WEB_UPDATE_MANIFEST_URL ||
  'https://github.com/agegr/pi-web-shell/releases/latest/download/kernel-manifest.json';

function parseArgs(argv) {
  const args = { output: DEFAULT_OUTPUT_DIR, upload: false, manifestUrl: DEFAULT_MANIFEST_URL };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version') args.version = argv[++i];
    else if (arg === '--output') args.output = path.resolve(argv[++i]);
    else if (arg === '--upload') args.upload = true;
    else if (arg === '--shell-version') args.shellVersion = argv[++i];
    else if (arg === '--manifest-url') args.manifestUrl = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node scripts/release.js [--version V] [--output DIR] [--shell-version V] [--manifest-url URL] [--upload]'
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Recursively walk a directory and return all paths. Used to decide what to
 * pack into the tarball.
 */
async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, base)));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

/**
 * Patterns to exclude from the kernel tarball. We aggressively strip
 * artifacts that aren't needed at runtime.
 */
const EXCLUDE_PATTERNS = [
  // Path components that should never ship.
  /(^|[\\/])\.npm([\\/]|$)/,
  /(^|[\\/])node_modules[\\/]\.bin([\\/]|$)/,
  /(^|[\\/])\.cache([\\/]|$)/,
  /(^|[\\/])\.next[\\/]cache([\\/]|$)/,
  /(^|[\\/])\.next[\\/]dev([\\/]|$)/,
  // Doc files.
  /(^|[\\/])README\.md$/i,
  /(^|[\\/])README\.[a-z\-]+\.md$/i,
  /(^|[\\/])CHANGELOG\.md$/i,
  /(^|[\\/])HISTORY\.md$/i,
  // Editor / OS metadata.
  /(^|[\\/])\.gitignore$/,
  /(^|[\\/])\.DS_Store$/,
  /(^|[\\/])\.eslintrc/,
  /(^|[\\/])\.editorconfig$/,
  /(^|[\\/])\.prettierrc/,
  // Test files.
  /(^|[\\/])__tests__([\\/]|$)/,
  /(^|[\\/])__mocks__([\\/]|$)/,
  /\.test\.(js|mjs|ts)$/,
  /\.spec\.(js|mjs|ts)$/,
  // TypeScript declaration files (not needed at runtime).
  /\.d\.ts$/,
  // Source maps.
  /\.map$/,
];

function shouldExclude(relPath) {
  return EXCLUDE_PATTERNS.some((re) => re.test(relPath));
}

async function buildTarball({ version, outputDir }) {
  const tarballName = `pi-web-kernel-${version}.tar.gz`;
  const tarballPath = path.join(outputDir, tarballName);

  // Collect the file list ourselves so we can filter. We can't use
  // tar.create with a filter callback because the streaming gzip wrapper
  // makes debugging hard if something goes wrong; we'd rather just have a
  // deterministic list.
  console.log('[release] walking staging directory...');
  const allFiles = await walk(STAGING_DIR);
  const files = allFiles.filter((p) => !shouldExclude(p)).map((p) => p.replace(/\\/g, '/'));
  console.log(`[release] ${files.length} files (excluded ${allFiles.length - files.length})`);

  // Use the platform's tar to do the compression. On Windows this is
  // tar.exe (built into Windows 10+), on macOS / Linux it's GNU tar.
  const manifest = path.join(outputDir, `files-${version}.txt`);
  await fsp.writeFile(manifest, files.join('\n'));

  console.log(`[release] creating ${tarballName}...`);
  // tar --files-from expects NUL-separated paths on Windows for safety,
  // but newlines work fine here because we control the paths.
  // We use `tar -C STAGING_DIR -T manifest -czf tarball` so the entries
  // are relative to STAGING_DIR.
  // --force-local prevents GNU tar on Windows from interpreting paths
  // like "D:\..." as remote host:path specs (the colon triggers it).
  const tarCmd = process.platform === 'win32' ? 'tar.exe' : 'tar';
  const toFwd = (p) => String(p).replace(/\\/g, '/');
  execSync(
    `${tarCmd} --force-local -C "${toFwd(STAGING_DIR)}" -T "${toFwd(manifest)}" -czf "${toFwd(tarballPath)}"`,
    { stdio: 'inherit' }
  );
  await fsp.rm(manifest, { force: true });

  const stat = await fsp.stat(tarballPath);
  const sha256 = await sha256OfFile(tarballPath);
  return { tarballPath, tarballName, size: stat.size, sha256 };
}

async function buildManifest({ version, size, sha256, args }) {
  const manifest = {
    schemaVersion: 1,
    manifestVersion: new Date().toISOString(),
    kernel: {
      version,
      tarball: args.manifestUrl.replace(/kernel-manifest\.json$/, `pi-web-kernel-${version}.tar.gz`),
      sha256,
      size,
      minShellVersion: args.shellVersion || DEFAULT_SHELL_VERSION,
      releasedAt: new Date().toISOString(),
    },
  };
  const manifestPath = path.join(args.output, 'kernel-manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { manifestPath, manifest };
}

async function maybeUpload({ version, tarballPath, manifestPath, args }) {
  if (!args.upload) {
    console.log('[release] --upload not set. Skipping GitHub push.');
    console.log('[release] Manual upload:');
    console.log(`          gh release create pi-web-kernel-${version} \\`);
    console.log(`            "${path.relative(process.cwd(), tarballPath)}" \\`);
    console.log(`            "${path.relative(process.cwd(), manifestPath)}" \\`);
    console.log(`            --title "Pi Web Kernel ${version}" --generate-notes`);
    return;
  }

  // Check `gh` is available.
  try {
    execSync('gh --version', { stdio: 'ignore' });
  } catch {
    throw new Error('`gh` CLI not found in PATH; cannot auto-upload');
  }

  const tag = `pi-web-kernel-${version}`;
  console.log(`[release] creating GitHub release ${tag}...`);
  execSync(
    `gh release create "${tag}" "${tarballPath}" "${manifestPath}" --title "Pi Web Kernel ${version}" --generate-notes`,
    { stdio: 'inherit' }
  );
  console.log('[release] uploaded.');
}

async function main() {
  const args = parseArgs(process.argv);

  // 1. Detect version from staging if not provided.
  if (!args.version) {
    if (!fs.existsSync(PACKAGE_JSON_PATH)) {
      console.error(`No staging found at ${PACKAGE_JSON_PATH}. Run \`npm run stage\` first.`);
      process.exit(1);
    }
    args.version = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')).version;
    console.log(`[release] detected staged version: ${args.version}`);
  }

  await fsp.mkdir(args.output, { recursive: true });

  // 2. Build the tarball.
  const { tarballPath, tarballName, size, sha256 } = await buildTarball({
    version: args.version,
    outputDir: args.output,
  });
  console.log(`[release] ${tarballName} ${(size / 1e6).toFixed(1)} MB`);
  console.log(`[release] sha256: ${sha256}`);

  // 3. Emit the manifest.
  const { manifestPath, manifest } = await buildManifest({ version: args.version, size, sha256, args });
  console.log(`[release] wrote ${manifestPath}`);
  console.log(JSON.stringify(manifest, null, 2));

  // 4. Upload (optional).
  await maybeUpload({ version: args.version, tarballPath, manifestPath, args });

  console.log('[release] done.');
}

main().catch((err) => {
  console.error('[release] failed:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});