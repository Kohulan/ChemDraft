import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const indexer = (text, file) => (needle) => {
  const index = text.indexOf(needle);
  assert.ok(index >= 0, `${file} lacks ${needle}`);
  return index;
};

test("the Linux sidecar workflow builds the pinned sources, checks them, and uploads one binary with its SHA-256", () => {
  const sidecar = read(".github/workflows/linux-sidecar-build.yml");
  const at = indexer(sidecar, "linux-sidecar-build.yml");
  assert.match(sidecar, /^on:\n  workflow_dispatch:\n  push:\n    branches:\n      - ci\/linux-sidecar-build\n\n/m);
  assert.match(sidecar, /runs-on: ubuntu-22\.04/);
  // Both sources by commit alone, with no tags: avogadrolibs' CMake reads `git describe`.
  const fetch = at('git -C _deps/avogadrolibs fetch --no-tags --depth 1 origin "$commit"');
  const eigen = at('git -C _deps/eigen fetch --no-tags --depth 1 origin "$eigen"');
  assert.doesNotMatch(sidecar, /git clone|fetch (?![^\n]*--no-tags)[^\n]*origin/);
  assert.match(sidecar, /\[ -z "\$\(git -C _deps\/avogadrolibs tag\)" \] \|\|/);
  const configure = at("cmake --preset linux-x86_64");
  const compile = at("cmake --build --preset linux-x86_64");
  const handshake = at('node "$GITHUB_WORKSPACE/scripts/check-engine3d-sidecar.mjs" "$bin"');
  const audit = at("pnpm run audit:engine3d-sidecar");
  const smokes = ["real-structure", "hold-steady", "anneal-energy"].map((name) => at(`pnpm smoke:engine3d-${name}`));
  const stage = at('sha256sum -- "$name" > "$name.sha256"');
  const upload = at("name: engine3d-sidecar-linux-x86_64");
  const summary = at('>> "$GITHUB_STEP_SUMMARY"');
  assert.ok(fetch < eigen && eigen < configure && configure < compile && compile < handshake && handshake < audit);
  assert.ok(smokes.every((smoke) => audit < smoke && smoke < stage) && stage < upload && upload < summary);
  assert.match(sidecar, /echo "- run id: \\`\$GITHUB_RUN_ID\\`"/);
  assert.match(sidecar, /echo "- SHA-256: \\`\$SHA256\\`"/);
  // Eigen 3.4.0 by commit, verified, never by the movable tag name.
  assert.match(sidecar, /eigen=3147391d946bb4b6c68edd901f2add6ac1f31f8c/);
  assert.match(sidecar, /\[ "\$\(git -C _deps\/eigen rev-parse HEAD\)" = "\$eigen" \]/);
  assert.doesNotMatch(sidecar, /--branch 3\.4\.0/);
  // The commit comes from CMakeLists.txt, the one place it is pinned.
  assert.match(sidecar, /commit=\$\(grep -oE '\[0-9a-f\]\{40\}' CMakeLists\.txt \| sort -u\)/);
  for (const text of [sidecar, read(".github/workflows/linux-build.yml")]) {
    assert.doesNotMatch(text, /sidecar-check\.sh|readelf|objdump/);
    assert.doesNotMatch(text, /continue-on-error/);
    // Every action is pinned by commit.
    for (const [, ref] of text.matchAll(/uses: [\w./-]+@(\S+)/g)) assert.match(ref, /^[0-9a-f]{40}$/);
  }
});

test("the Linux package build ships the committed sidecar it verified and never writes over it", () => {
  const build = read(".github/workflows/linux-build.yml");
  const at = indexer(build, "linux-build.yml");
  const verify = at("node scripts/verify-committed-linux-sidecar.mjs");
  const opsin = at("node scripts/build-opsin-runtime.mjs");
  const cleanBefore = at("- name: Check the source tree is clean before the bundle build");
  const bundle = at("pnpm --filter @chemdraft/desktop build --bundles deb,appimage");
  const clean = at("- name: Check the source tree is still clean after the bundle build");
  // Both packages' sidecars are compared with the pinned SHA-256 itself, not only with the checkout.
  const debCheck = at('node scripts/verify-committed-linux-sidecar.mjs --packaged "$payload/usr/bin/avogadro3d-sidecar"');
  const appImageStage = at('install -m 0755 -- "$GITHUB_WORKSPACE/apps/desktop/src-tauri/binaries/avogadro3d-sidecar-x86_64-unknown-linux-gnu" "$sidecar"');
  const squash = at("mksquashfs squashfs-root app.squashfs");
  const reextract = at("../repacked.AppImage --appimage-extract");
  const appImageCheck = at('verify-committed-linux-sidecar.mjs" --packaged squashfs-root/usr/bin/avogadro3d-sidecar');
  const record = at('record-build.mjs --artifact "$DEB"');
  assert.ok(verify < at("- name: Install Linux build dependencies") && verify < bundle);
  // Nothing may run between the clean-tree check and the bundle build: vite.config.ts stamps
  // "+dirty" from `git status --porcelain`.
  assert.ok(verify < opsin && opsin < cleanBefore && cleanBefore < bundle);
  assert.equal(build.indexOf("\n      - ", cleanBefore + 1), build.indexOf("      - name: Build stable .deb and AppImage") - 1);
  const guard = build.slice(cleanBefore, bundle);
  assert.match(guard, /cargo metadata --locked [^\n]*apps\/desktop\/src-tauri\/Cargo\.toml/);
  assert.match(guard, /dirty=\$\(git status --porcelain --untracked-files=normal\)\n\s+\[ -z "\$dirty" \] \|\| \{ printf '::error::[^']*\\n%s\\n' "\$dirty"; exit 1; \}/);
  assert.ok(bundle < clean && clean < debCheck && debCheck < appImageStage && appImageStage < squash);
  assert.ok(squash < reextract && reextract < appImageCheck && appImageCheck < record);
  assert.match(build, /sidecar="\$appdir\/usr\/bin\/avogadro3d-sidecar"\n\s+test -f "\$sidecar" \|\|/);
  // The .deb archive itself must hold the sidecar as a regular file with mode 0755, checked before
  // extraction can apply a umask.
  const debMode = at(`sidecar_entry=$(dpkg-deb -c "$deb" | awk '$NF == "./usr/bin/avogadro3d-sidecar" { print $1 }')`);
  assert.match(build, /\[ "\$sidecar_entry" = -rwxr-xr-x \] \|\| \{ echo "::error::[^"]+"; exit 1; \}/);
  assert.ok(clean < debMode && debMode < debCheck);
  assert.match(read("scripts/verify-committed-linux-sidecar.mjs"), /checkEngine3dSidecar\(payloadPath, \{ rootDir, log, packaged: true \}\)/);
  assert.doesNotMatch(build, /check-engine3d-sidecar\.mjs/, "packaged sidecars go through the pin, which runs the same checks");
  // Packaging neither builds the sidecar nor touches the tracked file: nothing is written into binaries/.
  assert.doesNotMatch(build, /cmake|_deps|native\/avogadro3d-sidecar\/build/);
  assert.doesNotMatch(build, /git checkout --|(install|cp|mv) [^\n]*binaries\/\S*"?\s*$/m);
});

test("the Linux CMake preset matches the shipped sidecar options and links only glibc dynamically", () => {
  const presets = JSON.parse(read("native/avogadro3d-sidecar/CMakePresets.json"));
  const linux = presets.configurePresets.find((preset) => preset.name === "linux-x86_64");
  assert.equal(linux.inherits, "protocol-scout");
  assert.deepEqual(linux.condition, { type: "equals", lhs: "${hostSystemName}", rhs: "Linux" });
  assert.equal(linux.cacheVariables.CMAKE_BUILD_TYPE, "Release");
  assert.match(linux.cacheVariables.CMAKE_EXE_LINKER_FLAGS, /-static-libstdc\+\+/);
  assert.match(linux.cacheVariables.CMAKE_EXE_LINKER_FLAGS, /-static-libgcc/);
  assert.ok(presets.buildPresets.some((preset) => preset.name === "linux-x86_64" && preset.configurePreset === "linux-x86_64"));
});

test("the container smoke checks the installed sidecar from the .deb and the AppImage", () => {
  const container = read(".github/workflows/linux-container-smoke.yml");
  const step = container.slice(container.indexOf("- name: Check the installed 3D sidecar"));
  assert.match(step, /check="\$GITHUB_WORKSPACE\/scripts\/check-engine3d-sidecar\.mjs"/);
  // Installed or extracted from a package, the sidecar must be a regular file with mode 0755.
  assert.match(step, /node "\$check" --packaged \/usr\/bin\/avogadro3d-sidecar/);
  assert.match(step, /"\$BUNDLE" --appimage-extract[\s\S]+node "\$check" --packaged "\$work\/squashfs-root\/usr\/bin\/avogadro3d-sidecar"/);
  assert.ok(container.indexOf("- name: Check the installed 3D sidecar") < container.indexOf("- name: Smoke test the Linux package"));
  assert.match(container, /- native\/avogadro3d-sidecar\/\*\*/);
  assert.match(container, /- scripts\/check-engine3d-sidecar\.mjs/);
  // Every distro installs Node for the check.
  assert.match(container, /libgtk-3-0t64 libxdo3 nodejs \\\n/);
  assert.match(container, /xorg-x11-server-Xvfb \\\n\s+nodejs gtk3 libxdo/);
  assert.match(container, /pacman -Syu --noconfirm --needed bash dbus procps-ng shadow strace util-linux nodejs \\\n/);
  const check = read("scripts/check-engine3d-sidecar.mjs");
  assert.match(check, /avogadro3d-sidecar placeholder/);
  assert.match(check, /7f454c460201/);
  // The handshake is parsed as protocol JSON, and Avogadro's UFF must back the commit.
  assert.match(check, /JSON\.parse\(line\)/);
  assert.match(check, /\["result\.forceField\.avogadroBacked", true\]/);
  assert.match(check, /child\.kill\("SIGKILL"\)/);
  assert.match(check, /export const MAX_GLIBC = "2\.35";/);
});

// The x86_64 file is pinned in scripts/engine3d-sidecar-linux.json and checked against its bytes by
// scripts/verify-committed-linux-sidecar.test.ts.
test("the committed aarch64 Linux sidecar stays a placeholder", () => {
  assert.match(read("apps/desktop/src-tauri/binaries/avogadro3d-sidecar-aarch64-unknown-linux-gnu"), /avogadro3d-sidecar placeholder/);
});
