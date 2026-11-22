#!/usr/bin/env node
// Verifies the committed x86_64 Linux 3D sidecar before Linux packaging bundles it: the pin in
// scripts/engine3d-sidecar-linux.json is filled in, the file is not a placeholder, its SHA-256 equals
// the pin, and scripts/check-engine3d-sidecar.mjs passes it (x86-64 ELF, glibc only, at most
// glibc 2.35, protocol handshake). Packaging never builds or replaces the sidecar;
// .github/workflows/linux-sidecar-build.yml builds it for a maintainer to commit. With --packaged, it
// checks the sidecar inside a built .deb or AppImage payload the same way, against the same pin.
// Node built-ins only. Usage: node scripts/verify-committed-linux-sidecar.mjs [--packaged <payload sidecar>]
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkEngine3dSidecar, SidecarCheckFailure } from "./check-engine3d-sidecar.mjs";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** The one place the committed Linux sidecar's SHA-256 is pinned. */
export const LINUX_SIDECAR_PIN = "scripts/engine3d-sidecar-linux.json";
/**
 * The only file the pin may name: the externalBin Tauri bundles into the .deb and AppImage. Hashing any
 * other file would verify one binary and ship another.
 */
export const LINUX_SIDECAR_PATH = "apps/desktop/src-tauri/binaries/avogadro3d-sidecar-x86_64-unknown-linux-gnu";
/** What the pin holds until a maintainer commits a binary built by the sidecar workflow. */
export const PENDING = "PENDING-MAINTAINER-COMMIT";
const PLACEHOLDER_MARKER = "avogadro3d-sidecar placeholder";

export function readLinuxSidecarPin(rootDir = ROOT_DIR) {
  return JSON.parse(readFileSync(join(rootDir, LINUX_SIDECAR_PIN), "utf8"));
}

export function isSidecarPlaceholder(bytes) {
  return bytes.includes(PLACEHOLDER_MARKER);
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Why these bytes cannot ship against this pin, or undefined when they can. `label` names the file in
 * messages: the committed path, or a packaged payload's sidecar.
 */
export function pinPathProblem(pin) {
  if (pin.path === LINUX_SIDECAR_PATH) return undefined;
  return `${LINUX_SIDECAR_PIN} path must be ${LINUX_SIDECAR_PATH}, the file Tauri bundles; it is ${JSON.stringify(pin.path)}.`;
}

export function committedSidecarProblem(bytes, pin, label = pin.path) {
  const pathProblem = pinPathProblem(pin);
  if (pathProblem) return pathProblem;
  if (pin.sha256 === PENDING || pin.buildRunId === PENDING) {
    return `The x86_64 Linux 3D sidecar is not committed yet: ${LINUX_SIDECAR_PIN} still says ${PENDING}. ` +
      `A maintainer runs ${pin.buildWorkflow}, commits its binary as ${pin.path}, and fills in buildRunId and sha256.`;
  }
  if (!/^[0-9a-f]{64}$/.test(pin.sha256)) return `${LINUX_SIDECAR_PIN} sha256 must be 64 lowercase hex digits.`;
  if (!/^[1-9][0-9]*$/.test(pin.buildRunId)) return `${LINUX_SIDECAR_PIN} buildRunId must be a GitHub Actions run id.`;
  if (isSidecarPlaceholder(bytes)) return `${label} is the placeholder, but ${LINUX_SIDECAR_PIN} pins a real binary.`;
  const actual = sha256Hex(bytes);
  if (actual !== pin.sha256) {
    return `${label} has SHA-256 ${actual}; ${LINUX_SIDECAR_PIN} pins ${pin.sha256} (run ${pin.buildRunId}).`;
  }
  return undefined;
}

export async function verifyCommittedLinuxSidecar({ rootDir = ROOT_DIR, log = console.log } = {}) {
  const pin = readLinuxSidecarPin(rootDir);
  // Refuse any other path before reading anything, and read only the canonical file.
  const pathProblem = pinPathProblem(pin);
  if (pathProblem) throw new SidecarCheckFailure(pathProblem, { perFile: false });
  const path = join(rootDir, LINUX_SIDECAR_PATH);
  let bytes;
  try { bytes = readFileSync(path); } catch { throw new SidecarCheckFailure(`${LINUX_SIDECAR_PATH} is missing.`, { perFile: false }); }
  const problem = committedSidecarProblem(bytes, pin);
  if (problem) throw new SidecarCheckFailure(problem, { perFile: false });
  log(`${pin.path}: SHA-256 ${pin.sha256} matches ${LINUX_SIDECAR_PIN} (run ${pin.buildRunId}).`);
  await checkEngine3dSidecar(path, { rootDir, log });
  return path;
}

/**
 * The sidecar inside a built package (an extracted .deb or AppImage payload) must be the pinned build
 * byte for byte, so a package cannot ship another binary than the one verified, must pass the same
 * checks as the committed file, and must be a regular file with mode 0755.
 */
export async function verifyPackagedLinuxSidecar(payloadPath, { rootDir = ROOT_DIR, log = console.log } = {}) {
  const pin = readLinuxSidecarPin(rootDir);
  let bytes;
  try { bytes = readFileSync(payloadPath); } catch { throw new SidecarCheckFailure(`${payloadPath} is missing.`, { perFile: false }); }
  const problem = committedSidecarProblem(bytes, pin, payloadPath);
  if (problem) throw new SidecarCheckFailure(problem, { perFile: false });
  log(`${payloadPath}: SHA-256 ${pin.sha256} matches ${LINUX_SIDECAR_PIN} (run ${pin.buildRunId}).`);
  await checkEngine3dSidecar(payloadPath, { rootDir, log, packaged: true });
  return payloadPath;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const packaged = args[0] === "--packaged";
  if (packaged ? args.length !== 2 || !args[1] : args.length !== 0) {
    console.error("usage: verify-committed-linux-sidecar.mjs [--packaged <payload sidecar>]");
    process.exit(2);
  }
  try {
    if (packaged) await verifyPackagedLinuxSidecar(args[1]);
    else await verifyCommittedLinuxSidecar();
  } catch (error) {
    if (!(error instanceof SidecarCheckFailure)) throw error;
    const subject = packaged ? args[1] : readLinuxSidecarPin().path;
    console.log(error.perFile ? `::error::3D sidecar ${subject}: ${error.message}` : `::error::${error.message}`);
    process.exit(1);
  }
}
