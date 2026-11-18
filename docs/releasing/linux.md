# Linux release

ChemDraft for Linux ships as two packages, built by `.github/workflows/linux-release.yml` on a
GitHub-hosted Ubuntu 22.04 runner from the same tag as the macOS DMG and the Windows installer:

| Package | For | Install |
| --- | --- | --- |
| `ChemDraft_<version>_amd64.deb` | Ubuntu 22.04+, Linux Mint 21+, Debian 12+, Pop!_OS, elementary OS, Zorin | `sudo apt install ./ChemDraft_<version>_amd64.deb` |
| `ChemDraft_<version>_amd64.AppImage` | x86-64 distributions with glibc 2.35 or later and compatible host graphics libraries | `chmod +x ChemDraft_<version>_amd64.AppImage && ./ChemDraft_<version>_amd64.AppImage` |

`SHA256SUMS-linux.txt` lists both package checksums. The combined `SHA256SUMS.txt` covers the
packages, their `.build.json` records, and the other attached release assets.

## Why Ubuntu 22.04

A Linux binary links against the glibc and WebKitGTK of the machine it is built on and runs only on
systems with the same or newer versions. Building on the oldest supported base (22.04, glibc 2.35,
WebKitGTK 4.1) covers Linux Mint 21 and 22 and every Ubuntu LTS still in support. Move the runner
forward only when 22.04 leaves support.

## Releasing

After creating the draft release (same as for Windows):

```sh
gh workflow run linux-release.yml --ref v<version> -f ref=v<version> -f upload_to_release=v<version>
```

The workflow:

1. Checks that `ref` is a tag (or full SHA) and that `upload_to_release` is `v<app version>`.
   For uploads, the build ref must also match the workflow commit.
2. Builds the OPSIN Java runtime on the runner and smoke-tests it (benzene).
3. Builds a stable `.deb` and AppImage (`CHEMDRAFT_STABLE_BUILD=1`, no worktree label).
4. Checks the bundle identity and that the `.deb` carries `chemdraft`, the 3D sidecar and the
   OPSIN runtime.
5. Repacks the AppImage after Tauri bundles it. It uses the host's Wayland and compiler runtime
   libraries and the host's `libgpg-error.so.0`; the job verifies that the finished image contains no `libwayland-*`,
   `libstdc++.so*`, or `libgcc_s.so*` files or symlinks.
6. Records the source commit and final bytes of each package, then stages the packages, records,
   and checksums as the `linux-release-amd64` workflow artifact.
7. Runs independent smoke jobs on **Ubuntu 22.04 and 24.04**. Each downloads and verifies the same
   22.04-built packages against `SHA256SUMS-linux.txt`. The jobs run both package checks, even
   when the AppImage or the other runner fails.
8. After both smoke jobs pass, fetches the draft's tag and checks that it resolves to the build
   commit. It uploads to the existing draft, validates the attached builds, and refreshes the
   combined checksums.

Add a `## Linux` section when preparing the release body.

## Ubuntu smoke diagnostics

Both runners use the package smoke composite action shared with the container workflow. Each
runner restores the AppImage's executable bit and launches it with `--appimage-extract-and-run`
before apt installs the `.deb` and its dependencies. Each launch uses Xvfb, Openbox, a private
D-Bus session, and fresh XDG directories. Xvfb selects a free display with RANDR and GLX enabled,
and the action waits for Openbox readiness. The action checks that the app and a WebKit web process
start and a ChemDraft window appears within 60 seconds. The app must stay up for another 20 seconds,
with a visible window and live web process at the end. A WebKit web process crash or app panic fails
the check. The harness matches processes and windows to the active launch by process ancestry.

The `linux-smoke-amd64-ubuntu-22.04` and `linux-smoke-amd64-ubuntu-24.04` artifacts preserve
package setup, library versions, display, app, and process logs even when smoke fails. The harness
records the traced launch's exit status and any encoded signal, and labels signals it sends during
cleanup. It also records profile contents and the single-instance D-Bus name owner. The `ldd` logs
cover the app and WebKit helpers, using installed paths for the `.deb` and AppRun's library paths
for the AppImage. Compare the reported package versions across runners since `4.1` names the
WebKitGTK ABI.

A failed launch gets a GDB retry with a fresh profile and D-Bus session and synchronous GTK X11
errors. The retry times out after 90 seconds, with a further ten seconds before SIGKILL. It records
thread stacks if GDB catches a fatal signal or reaches an exit breakpoint. For the AppImage, the
action uses a disposable extraction so the app under GDB has AppRun's environment and GDB can use
host libraries and Python. A successful retry leaves the original failure in place. GDB frame
detail depends on the binary's available symbols.

## Container smoke test

Pull requests changing Linux packaging paths also build and smoke-test packages from the PR head.

Build and test both packages using the workflow from a branch or tag:

```sh
gh workflow run linux-container-smoke.yml --ref <branch-or-tag>
```

To test existing packages, add `-f artifact_run_id=<linux-release-run-id>` and optionally
`-f artifact_name=<name>` (defaults to `linux-release-amd64`). A reusable caller can also supply
`artifact_name` for packages uploaded earlier in the same run. Reusable callers need
`actions: read` for artifact downloads and must allow the `contents: write` permission declared
by the release workflow's separate publishing job. The build itself runs with read access.

The workflow checks Debian sid and Fedora under Xvfb and headless Weston. The containers install
libgpg-error as a desktop system would. Debian installs the
.deb with apt and Fedora extracts its payload and runs it with Fedora's libraries. Each job
uploads display, app, and process logs. These tests cover startup and subprocess crashes. GPU
rendering still needs a desktop check. The privileged containers allow `strace` to trace the app
and glycin's bubblewrap to create user namespaces; Weston enables Xwayland for Wayland smoke tests.

## Updates

Linux has no in-app updater yet: the `.deb` and AppImage are updated by downloading the new
release. Options for later, in order of effort: an AppImage `.zsync` update file, a signed APT
repository on GitHub Pages, or a Flathub listing.

## Platform notes

- Webview: WebKitGTK, origin `tauri://localhost` (as on macOS). Before startup on Linux,
  ChemDraft defaults `WEBKIT_DISABLE_DMABUF_RENDERER` to `1` to avoid Wayland graphics
  problems. An explicit value, including `0`, takes precedence.
- Menus: on the document window, as on Windows (`install_app_menu`). Edit ▸ Cut / Copy / Paste
  invoke WebKitGTK's native editing commands in the focused window. The webview receives
  Ctrl+X / C / V directly and uses the same clipboard events for menu clicks and shortcuts.
- 3D: the `avogadro3d-sidecar` for Linux is still the placeholder (`binaries/README.md`), so 3D
  reports itself unavailable until a real Linux sidecar is built.
- Clipboard: `linux_clipboard.rs`, GTK's clipboard (X11 and Wayland). Targets are MIME types, so
  the editor's payload types are written unchanged; plain text is also offered as `UTF8_STRING`,
  `STRING` and `TEXT` for older X11 applications.
- Local tools (OCSR engine installer) report themselves unsupported on Linux for now.
- Building locally: `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev
  libayatana-appindicator3-dev libsoup-3.0-dev libssl-dev libxdo-dev patchelf`, then
  `node scripts/build-opsin-runtime.mjs` and
  `LD_LIBRARY_PATH=$PWD/apps/desktop/src-tauri/resources/opsin/jre/lib/server APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=true pnpm --filter @chemdraft/desktop build --bundles deb,appimage`.
  The `LD_LIBRARY_PATH` lets linuxdeploy find `libjvm.so` for the bundled OPSIN runtime.
