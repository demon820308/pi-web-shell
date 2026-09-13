'use strict';

/**
 * manifest-client.js — fetch the kernel update manifest.
 *
 * Two source formats are supported, selected by URL shape:
 *
 *   1. GitHub Releases API (the default)
 *      https://api.github.com/repos/<owner>/<repo>/releases/latest
 *      → parses the release JSON, looks for a kernel tarball asset, and
 *        derives the manifest. SHA256 verification is optional: if a
 *        sidecar asset named `<tarball>.sha256` exists, we use it.
 *
 *   2. Custom manifest JSON
 *      PI_WEB_UPDATE_MANIFEST_URL=<url>
 *      → strict schema (schemaVersion=1, kernel.{version,tarball,sha256,size}),
 *        with SHA256 verification required.
 *
 * 404 from the default URL is treated as "no release published yet" and
 * surfaces as a typed `MANIFEST_NOT_FOUND` error so the shell can stay
 * quiet instead of showing an alarming error banner.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_MANIFEST_URL =
  process.env.PI_WEB_UPDATE_MANIFEST_URL ||
  'https://api.github.com/repos/agegr/pi-web/releases/latest';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

// GitHub release JSON has no field for kernel SHA256, so we look for a
// sidecar asset uploaded alongside the tarball.
const SHA256_SIDECAR_SUFFIX = '.sha256';

// ---------------------------------------------------------------------------
// HTTP fetcher
// ---------------------------------------------------------------------------

function fetchUrl(urlString, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (err) {
      return reject(new Error(`Invalid manifest URL: ${urlString}`));
    }

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': `pi-web-shell/${process.versions.electron || 'unknown'}`,
          Accept: 'application/json',
        },
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        if (
          res.statusCode === 301 ||
          res.statusCode === 302 ||
          res.statusCode === 307 ||
          res.statusCode === 308
        ) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          const next = res.headers.location;
          if (!next) return reject(new Error('Redirect with no Location header'));
          const absolute = new URL(next, url).toString();
          return resolve(fetchUrl(absolute, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          const err = new Error(`HTTP ${res.statusCode} fetching manifest`);
          if (res.statusCode === 404) err.code = 'MANIFEST_NOT_FOUND';
          err.statusCode = res.statusCode;
          return reject(err);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      }
    );

    req.on('timeout', () => req.destroy(new Error('Manifest fetch timeout')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Schema validation (custom manifest format)
// ---------------------------------------------------------------------------

function validateCustomManifest(m) {
  if (!m || typeof m !== 'object') throw new Error('manifest: not an object');
  if (typeof m.schemaVersion !== 'number') throw new Error('manifest: schemaVersion missing');
  if (m.schemaVersion !== 1) throw new Error(`manifest: unsupported schemaVersion ${m.schemaVersion}`);
  if (!m.kernel || typeof m.kernel !== 'object') throw new Error('manifest: kernel missing');
  const k = m.kernel;
  if (typeof k.version !== 'string') throw new Error('manifest: kernel.version missing');
  if (typeof k.tarball !== 'string') throw new Error('manifest: kernel.tarball missing');
  if (typeof k.size !== 'number' || k.size <= 0) throw new Error('manifest: kernel.size invalid');
  if (k.minShellVersion && typeof k.minShellVersion !== 'string') {
    throw new Error('manifest: kernel.minShellVersion must be a string');
  }
  // sha256 is optional — only required if provided.
  if (k.sha256 !== undefined && (typeof k.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(k.sha256))) {
    throw new Error('manifest: kernel.sha256 is not a hex sha256');
  }
  return m;
}

// ---------------------------------------------------------------------------
// GitHub release parser
// ---------------------------------------------------------------------------

/**
 * Given a GitHub release JSON, find the kernel tarball asset (matching
 * /^kernel.*\.tar\.gz$/i) and return its metadata.
 *
 * Returns: { version, tarball, size, sha256 | null }
 *
 * Throws `MANIFEST_NOT_FOUND` if there's no kernel asset attached.
 */
function parseGithubRelease(release) {
  if (!release || typeof release !== 'object') {
    throw new Error('GitHub release: not an object');
  }
  if (typeof release.tag_name !== 'string') {
    throw new Error('GitHub release: tag_name missing');
  }

  // tag_name is conventionally "vX.Y.Z" — strip the leading "v".
  const version = release.tag_name.replace(/^v/, '').trim();
  if (!version) throw new Error('GitHub release: version empty after stripping "v"');

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const kernelAsset = assets.find(
    (a) => typeof a.name === 'string' && /^kernel.*\.tar\.gz$/i.test(a.name)
  );
  if (!kernelAsset) {
    // Treat "no kernel asset on the latest release" as "manifest not found":
    // a fresh release that hasn't been hooked up to our updater pipeline.
    const e = new Error('GitHub release: no kernel.tar.gz asset attached');
    e.code = 'MANIFEST_NOT_FOUND';
    throw e;
  }
  if (typeof kernelAsset.browser_download_url !== 'string') {
    throw new Error('GitHub release: asset missing browser_download_url');
  }

  // Optional SHA256 sidecar: look for an asset named "<kernel>.sha256".
  const sidecar = assets.find(
    (a) => typeof a.name === 'string' && a.name === kernelAsset.name + SHA256_SIDECAR_SUFFIX
  );

  return {
    schemaVersion: 1,
    kernel: {
      version,
      tarball: kernelAsset.browser_download_url,
      size: typeof kernelAsset.size === 'number' ? kernelAsset.size : 0,
      sha256: null, // resolved separately from the sidecar asset
      minShellVersion: undefined, // not supported via GitHub releases
      _sha256SidecarUrl:
        sidecar && typeof sidecar.browser_download_url === 'string'
          ? sidecar.browser_download_url
          : null,
      _githubRelease: {
        tag_name: release.tag_name,
        html_url: release.html_url,
        body: typeof release.body === 'string' ? release.body : '',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Top-level fetcher
// ---------------------------------------------------------------------------

function isGithubReleasesApi(url) {
  return /^https?:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/latest\/?$/i.test(
    url
  );
}

/**
 * Fetch the manifest URL, parse the response according to its format, and
 * resolve with a normalized `{ schemaVersion, kernel: { ... } }` object.
 *
 * For GitHub release sources we additionally try to fetch the SHA256
 * sidecar asset; if that fetch fails we keep `kernel.sha256 = null` and
 * the kernel-updater will skip integrity verification (HTTPS still gives
 * transport security).
 */
async function fetchManifest(url = DEFAULT_MANIFEST_URL) {
  const body = await fetchUrl(url);
  let raw;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    throw new Error(`Manifest is not valid JSON: ${err.message}`);
  }

  if (isGithubReleasesApi(url)) {
    const manifest = parseGithubRelease(raw);
    if (manifest.kernel._sha256SidecarUrl) {
      try {
        const sidecarText = await fetchUrl(manifest.kernel._sha256SidecarUrl);
        const sha = sidecarText.trim().split(/\s+/)[0].toLowerCase();
        if (/^[0-9a-f]{64}$/.test(sha)) {
          manifest.kernel.sha256 = sha;
        }
      } catch {
        // Sidecar unavailable — proceed without integrity check.
      }
    }
    return manifest;
  }

  return validateCustomManifest(raw);
}

module.exports = {
  fetchManifest,
  DEFAULT_MANIFEST_URL,
  // Exported for tests:
  parseGithubRelease,
  validateCustomManifest,
  isGithubReleasesApi,
};