import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  committedSidecarProblem,
  isSidecarPlaceholder,
  PENDING,
  readLinuxSidecarPin,
  sha256Hex
} from "./verify-committed-linux-sidecar.mjs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url));
const pin = readLinuxSidecarPin();
const committed = read(pin.path);

describe("the committed x86_64 Linux 3D sidecar pin", () => {
  it("names the binary and the workflow that builds it", () => {
    expect(pin.path).toBe("apps/desktop/src-tauri/binaries/avogadro3d-sidecar-x86_64-unknown-linux-gnu");
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
  const filled = { path: "bin", buildWorkflow: "build.yml", buildRunId: "42", sha256: sha256Hex(bytes) };

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
});
