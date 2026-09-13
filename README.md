# pi-web-shell

A lightweight **Electron** wrapper that turns [@agegr/pi-web](https://github.com/agegr/pi-web)
into a standalone, zero-dependency desktop app on Windows / macOS / Linux.

## What it does

```
┌──────────────────────────────────────────────────┐
│  pi-web-shell/                                   │
│  ├─ Electron main (main.js)                      │
│  │   ├─ Resolves bundled Node + pi-web           │
│  │   ├─ Spawns them as a child process           │
│  │   ├─ Watches stdout for "Ready"               │
│  │   └─ (Phase 3) Background kernel updater       │
│  └─ BrowserWindow                                │
│      ├─ Loading screen (renderer/)               │
│      ├─ Update banner (Phase 3)                  │
│      └─ Navigates to localhost:30141             │
└─────────────────┬────────────────────────────────┘
                  │ child_process.spawn
                  ▼
┌──────────────────────────────────────────────────┐
│  Bundled inside the EXE:                         │
│  ├─ resources/node/v22.19.0/node.exe             │
│  ├─ resources/pi-web/         (active kernel)     │
│  ├─ resources/pi-web-backup/ (previous, rollback) │
│  └─ resources/pi-web-incoming/ (downloaded, swap) │
└──────────────────────────────────────────────────┘
```

**The shell and the main program are completely separated.** The shell:
- Never modifies pi-web's source code.
- Spawns pi-web as an opaque child process.
- Communicates with pi-web only through `child_process` and HTTP on `127.0.0.1:30141`.
- Upgrading pi-web is hot: the shell silently downloads a new kernel and
  prompts the user to restart.

## Phase 3: Silent kernel hot-updates

Only the **pi-web kernel** is updated automatically, not the shell or Node.js.
Update flow:

1. On startup, the shell fetches `kernel-manifest.json` (URL configurable).
2. If the manifest's version is newer than the installed one, the shell
   **silently downloads** the new kernel tarball in the background.
3. While downloading, the user sees a small banner in the corner with progress.
4. When the download completes, a **"Restart now"** button appears.
5. Clicking it: stops the child process → atomic-renames
   `pi-web/` → `pi-web-backup/` and `pi-web-incoming/` → `pi-web/`
   → restarts the child against the new kernel.
6. If the new kernel crashes on startup 3 times in a row, the shell
   **auto-rolls back** to the previous version.

Update payload is ~220 MB compressed (vs ~300 MB for a full EXE). User
never sees a browser redirect or a download dialog.

## Running from source (dev mode)

```bash
cd pi-web-shell
npm install
npm run stage          # one-time: download Node + install pi-web into resources/
npm start              # launch shell, spawns bundled pi-web
```

For dev with a system Node and globally installed pi-web:
```bash
npm install -g @agegr/pi-web@latest
npm start              # skips resources/; uses your system Node + global pi-web
```

## Building an EXE (Windows)

```bash
npm run build
```

Pipeline: `fetch-node.js` → `stage-pi-web.js` → `electron-builder`.

Outputs in `dist/`:
- `Pi Web-0.3.0-x64.exe` — NSIS installer (per-user, no admin needed).
- `Pi Web-0.3.0-Portable.exe` — single-file portable EXE.

## Releasing a kernel update

```bash
# Bump pi-web version in scripts/stage-pi-web.js, then:
npm run stage
npm run release:kernel             # builds tarball + manifest in dist-kernel/
npm run release:kernel -- --upload # also uploads via gh CLI
```

The release script:
1. Walks `resources/pi-web/` and excludes dev/test/source-map/docs.
2. `tar -czf`s the result into a versioned tarball (~220 MB).
3. Computes SHA-256.
4. Emits `kernel-manifest.json` pointing at the tarball.
5. Optionally `gh release create`s both files.

## Build & release pipeline

| Script                          | What it does                                          |
|---------------------------------|-------------------------------------------------------|
| `npm run fetch:node`            | Download Node.js portable to `resources/node/v22.19.0/` |
| `npm run stage:pi-web`          | Install `@agegr/pi-web@<ver>` to `resources/pi-web/`  |
| `npm run stage`                 | Both of the above                                     |
| `npm run build`                 | Stage + electron-builder (NSIS + Portable)            |
| `npm run build:portable`        | Stage + electron-builder (Portable only)              |
| `npm run release:kernel`        | Build kernel tarball + manifest                       |
| `npm run release:kernel:upload` | Same, then `gh release create`                        |

`fetch:node` and `stage:pi-web` are **idempotent** — they skip when the
right version is already present.

## Configuration

| Env var                       | Purpose                                              |
|-------------------------------|------------------------------------------------------|
| `PORT`                        | Override pi-web's listen port (default `30141`)      |
| `PI_WEB_HOSTNAME`             | Override bind hostname (default `127.0.0.1`)         |
| `PI_WEB_BIN`                  | Absolute path to a specific `pi-web.js` to spawn     |
| `PI_WEB_NODE`                 | Absolute path to a specific `node` binary to use     |
| `PI_WEB_PASSWORD`             | Enable HTTP Basic Auth (passed through to pi-web)    |
| `PI_WEB_UPDATE_MANIFEST_URL`  | Override the kernel manifest URL                     |
| `PI_WEB_UPDATE_DISABLED=1`    | Disable automatic update checks                      |

## Project structure

```
pi-web-shell/
├── package.json             # electron-builder config + scripts
├── main.js                  # Electron main process
├── preload.js               # Context bridge (sandboxed renderer)
├── renderer/
│   ├── index.html           # Loading + error + update banner
│   ├── styles.css
│   └── renderer.js
├── lib/                     # Phase 3 — updater modules
│   ├── manifest-client.js   # Fetch + validate kernel-manifest.json
│   ├── update-state.js      # Persisted update state in userData/
│   └── kernel-updater.js    # State machine: check → download → apply → rollback
├── scripts/
│   ├── fetch-node.js        # Download Node.js portable at build time
│   ├── stage-pi-web.js      # Install pi-web into resources/ at build time
│   └── release.js           # Build kernel tarball + manifest
├── resources/               # Gitignored, regenerated by `npm run stage`
│   ├── node/v22.19.0/       # Bundled Node.js runtime
│   └── pi-web/node_modules/ # Bundled pi-web + all transitive deps
├── assets/                  # (placeholder for app icon)
└── build/                   # electron-builder build resources (icon.ico)
```

## What Phase 3 still doesn't do

These were deferred:
- Windows code signing (unsigned EXEs trigger SmartScreen warnings).
- macOS / Linux packaging.
- Custom application icon.
- Window position/size persistence.
- Tray icon + background mode.
- Differential update deltas (full kernel tarball every time).
- Built-in log viewer (we surface errors via the banner / About dialog).

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