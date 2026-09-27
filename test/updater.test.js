'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { parseGithubRelease, validateCustomManifest } = require('../lib/manifest-client');
const { KernelUpdater, compareVersions } = require('../lib/kernel-updater');
const { UpdateState } = require('../lib/update-state');

test('compareVersions properly compares semver and fallback strings', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.9.0', '0.9.0'), 0);
  assert.equal(compareVersions('0.8.5', '0.9.0'), -1);
});

test('parseGithubRelease correctly parses pi-web-kernel prefixed tags and assets', () => {
  const mockRelease = {
    tag_name: 'pi-web-kernel-0.9.0',
    html_url: 'https://github.com/demon820308/pi-web-shell/releases/tag/pi-web-kernel-0.9.0',
    body: '## Release notes\n- bugfixes',
    assets: [
      {
        name: 'pi-web-kernel-0.9.0.tar.gz',
        browser_download_url: 'https://github.com/releases/download/pi-web-kernel-0.9.0.tar.gz',
        size: 1024,
      },
      {
        name: 'pi-web-kernel-0.9.0.tar.gz.sha256',
        browser_download_url: 'https://github.com/releases/download/pi-web-kernel-0.9.0.tar.gz.sha256',
        size: 64,
      },
    ],
  };

  const manifest = parseGithubRelease(mockRelease);
  assert.equal(manifest.kernel.version, '0.9.0');
  assert.equal(manifest.kernel.tarball, 'https://github.com/releases/download/pi-web-kernel-0.9.0.tar.gz');
  assert.equal(manifest.kernel.changelog, '## Release notes\n- bugfixes');
  assert.equal(manifest.kernel._sha256SidecarUrl, 'https://github.com/releases/download/pi-web-kernel-0.9.0.tar.gz.sha256');
});

test('parseGithubRelease correctly recognizes installer .exe releases', () => {
  const mockRelease = {
    tag_name: 'v0.3.0',
    html_url: 'https://github.com/demon820308/pi-web-shell/releases/tag/v0.3.0',
    body: '## Shell Release 0.3.0\n- New UI and features',
    assets: [
      {
        name: 'Pi-Web-Setup-0.3.0.exe',
        browser_download_url: 'https://github.com/releases/download/v0.3.0/Pi-Web-Setup-0.3.0.exe',
        size: 50000000,
      },
    ],
  };

  const manifest = parseGithubRelease(mockRelease);
  assert.equal(manifest.kernel.type, 'installer');
  assert.equal(manifest.kernel.version, '0.3.0');
  assert.equal(manifest.kernel.tarball, 'https://github.com/releases/download/v0.3.0/Pi-Web-Setup-0.3.0.exe');
  assert.equal(manifest.kernel.changelog, '## Shell Release 0.3.0\n- New UI and features');
});

test('KernelUpdater.init() reconciles interrupted swap if active is missing but backup exists', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'updater-reconcile-test-'));
  const backupDir = path.join(tmpRoot, 'pi-web-backup');
  const activeDir = path.join(tmpRoot, 'pi-web');
  const dummyPkg = path.join(backupDir, 'node_modules', '@agegr', 'pi-web');
  await fsp.mkdir(dummyPkg, { recursive: true });
  await fsp.writeFile(path.join(dummyPkg, 'package.json'), JSON.stringify({ version: '0.8.0' }));

  const stateDir = path.join(tmpRoot, 'state');
  const state = new UpdateState(stateDir);
  const updater = new KernelUpdater({
    resourcesRoot: tmpRoot,
    state,
  });

  assert.equal(fs.existsSync(activeDir), false);
  assert.equal(fs.existsSync(backupDir), true);

  const installed = await updater.init();
  assert.equal(installed, '0.8.0');
  assert.equal(fs.existsSync(activeDir), true);
  assert.equal(fs.existsSync(backupDir), false);

  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

test('KernelUpdater _downloadAndVerify follows HTTP 302 redirects', async () => {
  const payload = 'dummy-tarball-content';
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

  // Setup mock HTTP server with 302 redirect
  const server = http.createServer((req, res) => {
    if (req.url === '/download/file.tar.gz') {
      res.writeHead(302, { Location: '/storage/actual.tar.gz' });
      res.end();
    } else if (req.url === '/storage/actual.tar.gz') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(payload);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'updater-redirect-test-'));
  const stateDir = path.join(tmpRoot, 'state');
  const state = new UpdateState(stateDir);
  const updater = new KernelUpdater({
    resourcesRoot: tmpRoot,
    state,
  });

  await fsp.mkdir(updater.incomingDir, { recursive: true });

  await updater._downloadAndVerify({
    tarball: `http://127.0.0.1:${port}/download/file.tar.gz`,
    sha256,
  });

  const downloadedContent = await fsp.readFile(updater.tarballPath, 'utf8');
  assert.equal(downloadedContent, payload);

  server.close();
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

test('KernelUpdater.rollback() quarantines bad version and prevents immediate loop', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'updater-rollback-test-'));
  const stateDir = path.join(tmpRoot, 'state');
  const state = new UpdateState(stateDir);

  const activeDir = path.join(tmpRoot, 'pi-web');
  const backupDir = path.join(tmpRoot, 'pi-web-backup');
  const incomingDir = path.join(tmpRoot, 'pi-web-incoming');

  // Create active dir with failing version 0.9.0
  const activePkg = path.join(activeDir, 'node_modules', '@agegr', 'pi-web');
  await fsp.mkdir(activePkg, { recursive: true });
  await fsp.writeFile(path.join(activePkg, 'package.json'), JSON.stringify({ version: '0.9.0' }));

  // Create backup dir with stable version 0.8.0
  const backupPkg = path.join(backupDir, 'node_modules', '@agegr', 'pi-web');
  await fsp.mkdir(backupPkg, { recursive: true });
  await fsp.writeFile(path.join(backupPkg, 'package.json'), JSON.stringify({ version: '0.8.0' }));

  const updater = new KernelUpdater({
    resourcesRoot: tmpRoot,
    state,
  });
  await updater.init();

  // Perform rollback
  const res = await updater.rollback();
  assert.equal(res.ok, true);
  assert.equal(res.version, '0.8.0');
  assert.equal(state.get('rolledBackVersion'), '0.9.0');
  assert.equal(fs.existsSync(incomingDir), false); // ensure bad kernel not left in incoming

  await fsp.rm(tmpRoot, { recursive: true, force: true });
});
