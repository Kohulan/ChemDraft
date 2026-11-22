# Sidecar Bundle Binaries

Tauri requires `bundle.externalBin` entries to have target-triple-suffixed files
at build time. These binaries keep the desktop shell buildable; macOS and Windows
targets have committed real builds, while the committed Linux files are placeholders.

Real binaries: `aarch64-apple-darwin`, `x86_64-apple-darwin`, and
`x86_64-pc-windows-msvc` (built with `cmake --preset windows-msvc && cmake --build
--preset windows-msvc` — static CRT, depends only on KERNEL32.dll).

`x86_64-unknown-linux-gnu` is a placeholder in the repository, but the Linux packages
ship a real sidecar: `.github/workflows/linux-build.yml` builds it from source on
Ubuntu 22.04 with `cmake --preset linux-x86_64` (Release, libstdc++ and libgcc
linked statically, so it needs only glibc 2.35 or newer), checks it, copies it over
the placeholder for the bundle step, and restores the placeholder afterwards. It is
never committed. The job fails rather than ship the placeholder.
`aarch64-unknown-linux-gnu` stays a placeholder; no aarch64 Linux package is built.

Every placeholder
carries the text `avogadro3d-sidecar placeholder`, which the app looks for (and on
Windows it also requires a PE image), so a placeholder reports the sidecar
unavailable rather than failing to start it: Interactive 3D shows as disabled with
"Interactive 3D isn't available in this <platform> build yet". Keep that text in any
new placeholder, and keep the committed Linux files placeholders (the Linux build
checks for the text before replacing x86_64).

macOS sidecar builds must target macOS 11.0, the app's declared minimum. Check
`otool -l apps/desktop/src-tauri/binaries/avogadro3d-sidecar-aarch64-apple-darwin`:
the `LC_BUILD_VERSION` minos (or `LC_VERSION_MIN_MACOSX` version) must be no
greater than 11.0.

The runtime bridge does not execute arbitrary renderer-provided paths. During
development, set `CHEMDRAFT_ENGINE3D_SIDECAR` to a built sidecar executable.
Release packaging uses the real native binary matching the target triple; for
x86_64 Linux that is the binary CI builds from source, not the committed placeholder.

## Intel macOS staging

The `x86_64-apple-darwin` file is a thin x86_64 Mach-O executable, built on Apple
silicon with the `protocol-scout-x86_64` CMake preset in
`native/avogadro3d-sidecar` (see that directory's README). It targets minimum
macOS 11.0 and links only `/usr/lib/libc++.1.dylib` and
`/usr/lib/libSystem.B.dylib`.

The Intel app also needs an x86_64 OPSIN runtime built with
`node scripts/build-opsin-runtime.mjs --arch x86_64`; see
`../resources/opsin/BUILD.md` for JAVA_HOME and Rosetta requirements. The runtime
is generated, never committed. Build and package architectures sequentially
because both use `resources/opsin/jre`. The release checker at
`tools/release/verify-macos-app.mjs` rejects missing/wrong-architecture runtimes
and sidecar placeholders by default. The advisory Intel CI job may explicitly
permit the known sidecar placeholder while skipping its smokes; that is not
release acceptance.
