import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("the Linux package build ships a native 3D sidecar built from the pinned sources, never the placeholder", () => {
  const build = read(".github/workflows/linux-build.yml");
  const commit = read("native/avogadro3d-sidecar/CMakeLists.txt").match(/"([0-9a-f]{40})"/)?.[1];
  assert.ok(commit);
  const at = (needle) => {
    const index = build.indexOf(needle);
    assert.ok(index >= 0, `linux-build.yml lacks ${needle}`);
    return index;
  };
  const fetch = at("git clone https://github.com/OpenChemistry/avogadrolibs.git _deps/avogadrolibs");
  const eigen = at('git -C _deps/eigen fetch --depth 1 origin "$eigen"');
  const configure = at("cmake --preset linux-x86_64");
  const compile = at("cmake --build --preset linux-x86_64");
  const handshake = at('node "$GITHUB_WORKSPACE/scripts/check-engine3d-sidecar.mjs" "$bin"');
  const smoke = at("pnpm smoke:engine3d-real-structure");
  const stage = at('install -m 0755 "$CHEMDRAFT_ENGINE3D_SIDECAR" "$target"');
  const bundle = at("pnpm --filter @chemdraft/desktop build --bundles deb,appimage");
  const restore = at("git checkout -- apps/desktop/src-tauri/binaries/avogadro3d-sidecar-x86_64-unknown-linux-gnu");
  const debCheck = at('cmp native/avogadro3d-sidecar/build/linux-x86_64/avogadro3d-sidecar "$payload/usr/bin/avogadro3d-sidecar"');
  const debSidecarCheck = at('node scripts/check-engine3d-sidecar.mjs "$payload/usr/bin/avogadro3d-sidecar"');
  const appImageCheck = at('check-engine3d-sidecar.mjs" squashfs-root/usr/bin/avogadro3d-sidecar');
  const record = at('record-build.mjs --artifact "$DEB"');
  assert.ok(fetch < eigen && eigen < configure && configure < compile && compile < handshake);
  assert.ok(handshake < smoke && smoke < stage && stage < bundle && bundle < restore);
  assert.ok(restore < debCheck && debCheck < debSidecarCheck && debSidecarCheck < appImageCheck && appImageCheck < record);
  // Eigen 3.4.0 by commit, verified, never by the movable tag name.
  assert.match(build, /eigen=3147391d946bb4b6c68edd901f2add6ac1f31f8c/);
  assert.match(build, /\[ "\$\(git -C _deps\/eigen rev-parse HEAD\)" = "\$eigen" \]/);
  assert.doesNotMatch(build, /--branch 3\.4\.0/);
  assert.doesNotMatch(build, /sidecar-check\.sh|readelf|objdump/);
  // The commit comes from CMakeLists.txt, the one place it is pinned.
  assert.match(build, /commit=\$\(grep -oE '\[0-9a-f\]\{40\}' CMakeLists\.txt \| sort -u\)/);
  assert.doesNotMatch(build, /continue-on-error/);
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
  assert.match(step, /node "\$check" \/usr\/bin\/avogadro3d-sidecar/);
  assert.match(step, /"\$BUNDLE" --appimage-extract[\s\S]+node "\$check" "\$work\/squashfs-root\/usr\/bin\/avogadro3d-sidecar"/);
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
  assert.match(check, /"avogadroBacked":true/);
  assert.match(check, /export const MAX_GLIBC = "2\.35";/);
});

test("the committed Linux sidecars stay placeholders", () => {
  for (const triple of ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]) {
    assert.match(read(`apps/desktop/src-tauri/binaries/avogadro3d-sidecar-${triple}`), /avogadro3d-sidecar placeholder/);
  }
});
