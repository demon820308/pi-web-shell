# pi-web-shell

A lightweight **Electron** wrapper that turns [@agegr/pi-web](https://github.com/agegr/pi-web)
into a standalone, zero-dependency desktop app on Windows.

## What it does

```
┌──────────────────────────────────────────────────┐
│  pi-web-shell/                                   │
│  ├─ Electron main (main.js)                      │
│  │   ├─ Resolves bundled Node + pi-web           │
│  │   ├─ Spawns them as a child process           │
│  │   ├─ Watches stdout for "Ready"               │
│  │   └─ Background kernel updater (lib/)         │
│  └─ BrowserWindow                                │
│      ├─ Loading screen (renderer/)               │
│      ├─ Update banner                            │
│      └─ Navigates to localhost:30141             │
└─────────────────┬────────────────────────────────┘
                  │ child_process.spawn
                  ▼
┌──────────────────────────────────────────────────┐
│  Bundled inside the EXE:                         │
│  ├─ resources/node/v22.19.0/node.exe             │
│  ├─ resources/pi-web/         (active kernel)     │
│  ├─ resources/pi-web-backup/ (previous version)   │
│  └─ resources/pi-web-incoming/ (downloaded, swap) │
└──────────────────────────────────────────────────┘
```

**The shell and the main program are completely separated.** The shell:
- Never modifies pi-web's source code.
- Spawns pi-web as an opaque child process.
- Communicates with pi-web only through `child_process` and HTTP on `127.0.0.1:30141`.
- Upgrading pi-web is hot: the shell silently downloads a new kernel and
  prompts the user to restart.

## Features

- **Zero-install runtime** — Node.js v22.19.0 and pi-web's full `node_modules`
  are bundled via electron-builder `extraResources`.
- **Single instance** — a second launch raises the existing window instead of
  spawning another server.
- **Port management** — defaults to `30141`, auto-falls-back to the next free
  port (up to +30) when busy. Configurable via *File → 设置服务端口 (Port)*;
  the choice is persisted in `userData/settings.json`.
- **Skill key manager** — *File → 技能密钥设置 (Skill Keys)*. Detects installed
  skills under `~/.pi/agent/skills/` (built-in: Tavily / Firecrawl / Brave /
  GitHub, plus any `SKILL.md` referencing `*_API_KEY`-style variables), lets you
  enter keys with masked display, and syncs them to `~/.pi/agent/.env`, which is
  merged into the child process environment.
- **System tray** — show window, restart service, skill keys, view log, quit.
  Closing the window minimizes to the tray and keeps pi-web running; use the
  tray's "彻底退出" (or *File → 彻底退出*) to actually stop the service.
- **Auto-start toggle** — *File → 开机自动启动 (Launch at Startup)*.
- **File logging** — the shell appends to `userData/logs/pi-web.log`;
  *Help → 查看运行日志* opens the file, plus "Open Logs Folder" /
  "Open Data Folder" entries.
- **Window state persistence** — position and size are remembered across runs.
- **Kernel hot-update** — see below.

## Kernel hot-updates

Only the **pi-web kernel** is updated automatically, not the shell or Node.js.
Update flow:

1. On startup (and via *Kernel → Check for updates…*), the shell fetches an
   update manifest. Two formats are supported:
   - **GitHub Releases API** (default):
     `https://api.github.com/repos/agegr/pi-web/releases/latest` — parses the
     release JSON for a kernel tarball asset; SHA-256 is verified when a
     `<tarball>.sha256` sidecar asset exists. A 404 means "no release yet" and
     stays silent.
   - **Custom manifest JSON** via `PI_WEB_UPDATE_MANIFEST_URL` — strict schema
     (`schemaVersion=1`, `kernel.{version,tarball,sha256,size}`) with mandatory
     SHA-256 verification.
2. If the manifest's version is newer than the installed one, the shell
   **silently downloads** the new kernel tarball in the background.
3. While downloading, the user sees a small banner in the corner with progress.
4. When the download completes, a **"Restart now"** button appears.
5. Clicking it: stops the child process → atomic-renames
   `pi-web/` → `pi-web-backup/` and `pi-web-incoming/` → `pi-web/`
   → restarts the child against the new kernel.
6. If the new kernel fails to start 3 times in a row, the shell
   **auto-rolls back** to the previous version (`STARTUP_FAILURE_THRESHOLD = 3`).

Update payload is ~220 MB compressed (vs ~300 MB for a full EXE). User
never sees a browser redirect or a download dialog. Update state lives in
`userData/update-state.json`; *Kernel → Open update log* shows its history.

## Running from source (dev mode)

```bash
cd pi-web-shell
npm install
npm run stage          # one-time: download Node + install pi-web into resources/
npm start              # launch shell, spawns bundled pi-web
npm run dev            # same, with --enable-logging (verbose child logs)
```

For dev with a system Node and globally installed pi-web:
```bash
npm install -g @agegr/pi-web@latest
npm start              # falls back to system Node + global pi-web when resources/ is absent
```

Resolution order for the pi-web binary and Node:
1. Bundled `resources/` (primary path in packaged builds)
2. Env overrides (`PI_WEB_BIN` / `PI_WEB_NODE`) for dev/testing
3. System Node.js + global pi-web (dev convenience)
4. `npx` fallback (downloads `@latest` on first run)

## Building an EXE (Windows)

```bash
npm run build              # NSIS installer + zip
npm run build:installer    # NSIS installer only
npm run build:zip          # zip only
npm run build:dir          # unpacked win-unpacked/ directory (for testing)
```

Pipeline: `fetch-node.js` → `stage-pi-web.js` → `electron-builder`.

Outputs in `dist/`:
- `Pi Web-Setup-<version>.exe` — NSIS installer (per-user, no admin needed).
- `Pi Web-<version>-x64.zip` — portable zip.

CI (`.github/workflows/build.yml`) runs `npm run build` on every push to `main`
and on `v*` tags, uploads the artifacts, and creates a **draft** GitHub release
for manual publishing.

## Releasing a kernel update

```bash
# Bump PI_WEB_VERSION in scripts/stage-pi-web.js, then:
npm run stage
npm run release:kernel             # builds tarball + manifest in dist-kernel/
npm run release:kernel:upload      # also uploads via gh CLI
```

The release script (`scripts/release.js`):
1. Walks `resources/pi-web/` and excludes dev/test/source-map/docs.
2. `tar -czf`s the result into a versioned tarball (~220 MB).
3. Computes SHA-256.
4. Emits `kernel-manifest.json` pointing at the tarball.
5. Optionally `gh release create`s both files (tag `pi-web-kernel-<version>`).

Options: `--version V`, `--output DIR`, `--shell-version V`,
`--manifest-url URL`, `--upload`.

## Build & release pipeline

| Script                          | What it does                                          |
|---------------------------------|-------------------------------------------------------|
| `npm start` / `npm run dev`     | Launch the shell from source                          |
| `npm run fetch:node`            | Download Node.js portable to `resources/node/v22.19.0/` |
| `npm run stage:pi-web`          | Install `@agegr/pi-web@<ver>` to `resources/pi-web/`  |
| `npm run stage`                 | Both of the above                                     |
| `npm run build`                 | Stage + electron-builder (NSIS + zip)                 |
| `npm run build:installer`       | Stage + electron-builder (NSIS only)                  |
| `npm run build:zip`             | Stage + electron-builder (zip only)                   |
| `npm run build:dir`             | Stage + electron-builder (unpacked directory)         |
| `npm run release:kernel`        | Build kernel tarball + manifest                       |
| `npm run release:kernel:upload` | Same, then `gh release create`                        |

`fetch:node` and `stage:pi-web` are **idempotent** — they skip when the
right version is already present. Pinned versions live at the top of each
script (`NODE_VERSION` in `fetch-node.js`, `PI_WEB_VERSION` in
`stage-pi-web.js`).

## Configuration

| Env var                       | Purpose                                              |
|-------------------------------|------------------------------------------------------|
| `PORT`                        | Override pi-web's listen port (default `30141`)      |
| `PI_WEB_HOSTNAME`             | Override bind hostname (default `127.0.0.1`)         |
| `PI_WEB_BIN`                  | Absolute path to a specific `pi-web.js` to spawn     |
| `PI_WEB_NODE`                 | Absolute path to a specific `node` binary to use     |
| `PI_WEB_PASSWORD`             | Enable HTTP Basic Auth (passed through to pi-web)    |
| `PI_WEB_UPDATE_MANIFEST_URL`  | Override the update manifest URL                     |
| `PI_WEB_UPDATE_DISABLED=1`    | Disable automatic update checks                      |

Keys from `~/.pi/agent/.env` are merged into the child environment as well.

## Project structure

```
pi-web-shell/
├── package.json             # electron-builder config + scripts
├── main.js                  # Electron main process
├── preload.js               # Context bridge (sandboxed renderer)
├── renderer/
│   ├── index.html           # Loading + error + update banner
│   ├── port-settings.html   # Port configuration dialog
│   ├── skill-keys.html      # Skill key manager dialog
│   ├── renderer.js
│   └── styles.css
├── lib/                     # Updater modules
│   ├── manifest-client.js   # Fetch + validate update manifest
│   ├── update-state.js      # Persisted update state in userData/
│   └── kernel-updater.js    # State machine: check → download → apply → rollback
├── scripts/
│   ├── fetch-node.js        # Download Node.js portable at build time
│   ├── stage-pi-web.js      # Install pi-web into resources/ at build time
│   └── release.js           # Build kernel tarball + manifest
├── resources/               # Gitignored, regenerated by `npm run stage`
│   ├── node/v22.19.0/       # Bundled Node.js runtime
│   └── pi-web/node_modules/ # Bundled pi-web + all transitive deps
├── assets/                  # app icon source (icon.png, 192x192)
└── build/                   # electron-builder build resources (icon.ico)
```

## Not yet done

These are still deferred:
- Windows code signing (unsigned EXEs trigger SmartScreen warnings).
- macOS / Linux packaging (builds currently target Windows x64 only).
- Differential update deltas (full kernel tarball every time).

## Verified

End-to-end test of the auto-update pipeline (using the staged pi-web):

```
Tarball size: 233.5 MB
 [checking] [available]
check.reason=newer
download+extract: <seconds>
extracted version: 0.9.0
BUILD_ID: Z_vA4pWAChTab5s3FVVi8
 [applying] [applied]
applied: 0.9.0
PASS
```

Smoke test of bundled Node + bundled pi-web (no Electron):

```
resources/node/v22.19.0/node.exe \
  resources/pi-web/node_modules/@agegr/pi-web/bin/pi-web.js \
  --no-open -p 30149
```
Server ready in ~780 ms; HTTP GET returns a 9.9 KB HTML page.
