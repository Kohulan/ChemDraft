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
  const eigen = at("git clone --depth 1 --branch 3.4.0 https://gitlab.com/libeigen/eigen.git _deps/eigen");
  const configure = at("cmake --preset linux-x86_64");
  const compile = at("cmake --build --preset linux-x86_64");
  const handshake = at('sidecar-check.sh "$CHEMDRAFT_ENGINE3D_SIDECAR"');
  const smoke = at("pnpm smoke:engine3d-real-structure");
  const stage = at('install -m 0755 "$CHEMDRAFT_ENGINE3D_SIDECAR" "$target"');
  const bundle = at("pnpm --filter @chemdraft/desktop build --bundles deb,appimage");
  const restore = at("git checkout -- apps/desktop/src-tauri/binaries/avogadro3d-sidecar-x86_64-unknown-linux-gnu");
  const debCheck = at('cmp native/avogadro3d-sidecar/build/linux-x86_64/avogadro3d-sidecar "$payload/usr/bin/avogadro3d-sidecar"');
  const appImageCheck = at("sidecar-check.sh\" squashfs-root/usr/bin/avogadro3d-sidecar");
  const record = at('record-build.mjs --artifact "$DEB"');
  assert.ok(fetch < eigen && eigen < configure && configure < compile && compile < handshake);
  assert.ok(handshake < smoke && smoke < stage && stage < bundle && bundle < restore);
  assert.ok(restore < debCheck && debCheck < appImageCheck && appImageCheck < record);
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
  assert.match(step, /bash "\$check" \/usr\/bin\/avogadro3d-sidecar/);
  assert.match(step, /"\$BUNDLE" --appimage-extract[\s\S]+bash "\$check" "\$work\/squashfs-root\/usr\/bin\/avogadro3d-sidecar"/);
  assert.ok(container.indexOf("- name: Check the installed 3D sidecar") < container.indexOf("- name: Smoke test the Linux package"));
  assert.match(container, /- native\/avogadro3d-sidecar\/\*\*/);
  const check = read(".github/workflows/linux-package-smoke/sidecar-check.sh");
  assert.match(check, /avogadro3d-sidecar placeholder/);
  assert.match(check, /7f454c460201/);
  assert.match(check, /"avogadroBacked":true/);
});

test("the committed Linux sidecars stay placeholders", () => {
  for (const triple of ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]) {
    assert.match(read(`apps/desktop/src-tauri/binaries/avogadro3d-sidecar-${triple}`), /avogadro3d-sidecar placeholder/);
  }
});
