import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  committedSidecarProblem,
  isSidecarPlaceholder,
  LINUX_SIDECAR_PATH,
  PENDING,
  readLinuxSidecarPin,
  sha256Hex,
  verifyPackagedLinuxSidecar
} from "./verify-committed-linux-sidecar.mjs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url));
const pin = readLinuxSidecarPin();
const committed = read(pin.path);

describe("the committed x86_64 Linux 3D sidecar pin", () => {
  it("names the binary and the workflow that builds it", () => {
    expect(pin.path).toBe("apps/desktop/src-tauri/binaries/avogadro3d-sidecar-x86_64-unknown-linux-gnu");
    expect(pin.path).toBe(LINUX_SIDECAR_PATH);
    expect(pin.buildWorkflow).toBe(".github/workflows/linux-sidecar-build.yml");
    expect(read(pin.buildWorkflow).toString("utf8")).toContain("engine3d-sidecar-linux-x86_64");
  });

  it("is pending exactly while the committed file is the placeholder", () => {
    const pending = pin.sha256 === PENDING;
    expect(pin.buildRunId === PENDING).toBe(pending);
    expect(isSidecarPlaceholder(committed)).toBe(pending);
    if (!pending) {
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.buildRunId).toMatch(/^[1-9][0-9]*$/);
    }
  });

  // Bytes on disk against the pin, only once a real binary is committed.
  it.skipIf(isSidecarPlaceholder(committed))("matches the bytes on disk and the dependency inventory", () => {
    expect(sha256Hex(committed)).toBe(pin.sha256);
    expect(committedSidecarProblem(committed, pin)).toBeUndefined();
    const inventory = read("docs/architecture/dependency-inventory.md").toString("utf8");
    expect(inventory).toContain(pin.sha256);
    expect(inventory).toContain(`run id: ${pin.buildRunId}`);
  });
});

describe("committedSidecarProblem", () => {
  const bytes = Buffer.from("\x7fELF native build");
  const filled = { path: LINUX_SIDECAR_PATH, buildWorkflow: "build.yml", buildRunId: "42", sha256: sha256Hex(bytes) };

  it("refuses a pin that names any file but the one Tauri bundles, whatever its bytes", () => {
    for (const path of ["bin", "apps/desktop/src-tauri/binaries/avogadro3d-sidecar-aarch64-unknown-linux-gnu",
      `./${LINUX_SIDECAR_PATH}`, `${LINUX_SIDECAR_PATH}/../avogadro3d-sidecar-x86_64-unknown-linux-gnu`]) {
      expect(committedSidecarProblem(bytes, { ...filled, path })).toMatch(/path must be apps\/desktop\/src-tauri\/binaries\/avogadro3d-sidecar-x86_64-unknown-linux-gnu, the file Tauri bundles/);
    }
  });

  it("refuses a pending pin, naming the workflow that builds the sidecar", () => {
    expect(committedSidecarProblem(bytes, { ...filled, sha256: PENDING })).toMatch(/not committed yet.*build\.yml/);
    expect(committedSidecarProblem(bytes, { ...filled, buildRunId: PENDING })).toMatch(/still says PENDING-MAINTAINER-COMMIT/);
  });

  it("refuses the placeholder, a malformed pin, and bytes with another hash", () => {
    expect(committedSidecarProblem(Buffer.from("ChemDraft avogadro3d-sidecar placeholder."), filled)).toMatch(/is the placeholder/);
    expect(committedSidecarProblem(bytes, { ...filled, sha256: filled.sha256.toUpperCase() })).toMatch(/64 lowercase hex/);
    expect(committedSidecarProblem(bytes, { ...filled, buildRunId: "latest" })).toMatch(/run id/);
    expect(committedSidecarProblem(Buffer.from("other"), filled)).toMatch(/has SHA-256 [0-9a-f]{64}; .* pins /);
  });

  it("accepts the pinned bytes", () => {
    expect(committedSidecarProblem(bytes, filled)).toBeUndefined();
  });

  it("names a packaged payload's sidecar in place of the committed path", () => {
    expect(committedSidecarProblem(Buffer.from("other"), filled, "payload/usr/bin/avogadro3d-sidecar"))
      .toMatch(/^payload\/usr\/bin\/avogadro3d-sidecar has SHA-256 [0-9a-f]{64}; /);
  });
});

describe("verifyPackagedLinuxSidecar", () => {
  const root = mkdtempSync(join(tmpdir(), "linux-sidecar-pin-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const pinned = Buffer.from("\x7fELF pinned build");
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "engine3d-sidecar-linux.json"), JSON.stringify({
    path: "apps/desktop/src-tauri/binaries/avogadro3d-sidecar-x86_64-unknown-linux-gnu",
    buildWorkflow: ".github/workflows/linux-sidecar-build.yml",
    buildRunId: "42",
    sha256: sha256Hex(pinned)
  }));
  const payload = (name: string, contents: Buffer) => {
    const path = join(root, name);
    writeFileSync(path, contents, { mode: 0o755 });
    return path;
  };
  const verify = (path: string) => verifyPackagedLinuxSidecar(path, { rootDir: root, log: () => undefined });

  it("refuses a payload sidecar whose bytes differ from the pin, before running it", async () => {
    const stale = payload("stale", Buffer.from("\x7fELF a different build"));
    await expect(verify(stale)).rejects.toThrow(`${stale} has SHA-256 ${sha256Hex(Buffer.from("\x7fELF a different build"))}; `);
    await expect(verify(stale)).rejects.toThrow(`scripts/engine3d-sidecar-linux.json pins ${sha256Hex(pinned)} (run 42).`);
  });

  it("refuses a pin naming another path even when the payload matches its hash", async () => {
    writeFileSync(join(root, "scripts", "engine3d-sidecar-linux.json"), JSON.stringify({
      path: "elsewhere", buildWorkflow: ".github/workflows/linux-sidecar-build.yml", buildRunId: "42", sha256: sha256Hex(pinned)
    }));
    try {
      await expect(verify(payload("matching", pinned))).rejects.toThrow(/path must be /);
    } finally {
      writeFileSync(join(root, "scripts", "engine3d-sidecar-linux.json"), JSON.stringify({
        path: LINUX_SIDECAR_PATH, buildWorkflow: ".github/workflows/linux-sidecar-build.yml", buildRunId: "42", sha256: sha256Hex(pinned)
      }));
    }
  });

  it("refuses a missing payload sidecar and the placeholder", async () => {
    await expect(verify(join(root, "absent"))).rejects.toThrow(/absent is missing\./);
    await expect(verify(payload("placeholder", Buffer.from("ChemDraft avogadro3d-sidecar placeholder.")))).rejects.toThrow(/is the placeholder/);
  });
});
