#!/usr/bin/env node
// Checks that an avogadro3d-sidecar is a real x86-64 ELF build, not the committed placeholder
// (apps/desktop/src-tauri/binaries/README.md); that it needs only glibc, and at most the glibc of the
// oldest supported host; and that it completes the stdio protocol handshake with Avogadro's UFF
// linked in and the pinned avogadrolibs commit reported.
// Node built-ins only, and no binutils: it reads the ELF's dynamic section itself, so it runs the
// same on the build runner and inside every distro container (which installs only `nodejs`).
// Usage: node scripts/check-engine3d-sidecar.mjs <path to avogadro3d-sidecar>
import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PLACEHOLDER_MARKER = "avogadro3d-sidecar placeholder";
const HANDSHAKE_TIMEOUT_MS = 60_000;
/** The process status GNU `timeout` reports when it had to stop the command. */
const TIMEOUT_STATUS = 124;

/** Libraries glibc itself provides. libstdc++ and libgcc are linked statically (linux-build.yml). */
export const GLIBC_LIBRARIES = new Set([
  "libc.so.6", "libm.so.6", "libpthread.so.0", "libdl.so.2", "librt.so.1", "ld-linux-x86-64.so.2"
]);
/** Ubuntu 22.04, the oldest supported host and the build runner. */
export const MAX_GLIBC = "2.35";

/** A failed check. `perFile` messages are reported as "3D sidecar <path>: <message>". */
export class SidecarCheckFailure extends Error {
  constructor(message, { perFile = true } = {}) {
    super(message);
    this.perFile = perFile;
  }
}

/** Hex of the first 20 bytes, as `od -An -tx1 -N20 | tr -d ' \n'` printed it. */
export function elfHeaderHex(buffer) {
  return buffer.subarray(0, 20).toString("hex");
}

/** The ELF header problem, worded as before, or undefined for a 64-bit little-endian x86-64 ELF. */
export function elfHeaderProblem(buffer) {
  const header = elfHeaderHex(buffer);
  // ELF magic, 64-bit (02), little-endian (01); e_machine at byte 18 is 0x3e (x86-64).
  if (header.slice(0, 12) !== "7f454c460201") return `is not a 64-bit little-endian ELF (header ${header})`;
  if (header.slice(36, 40) !== "3e00") return `is not an x86-64 ELF (e_machine ${header.slice(36, 40)})`;
  return undefined;
}

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NULL = 0n;
const DT_NEEDED = 1n;
const DT_STRTAB = 5n;
const DT_STRSZ = 10n;
const DT_VERNEED = 0x6ffffffen;
const DT_VERNEEDNUM = 0x6fffffffn;

/**
 * The shared libraries (DT_NEEDED) and required symbol versions (the DT_VERNEED entries, the same
 * names `objdump -T` prints) of a 64-bit little-endian ELF, read through its program headers as the
 * dynamic loader does. A static executable has neither. Throws on a truncated or malformed file.
 */
export function readElfDependencies(buffer) {
  const malformed = (what) => { throw new SidecarCheckFailure(`has a malformed ELF ${what}`); };
  const within = (offset, length, what) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > buffer.length) malformed(what);
    return offset;
  };
  const u16 = (offset, what) => buffer.readUInt16LE(within(offset, 2, what));
  const u32 = (offset, what) => buffer.readUInt32LE(within(offset, 4, what));
  const u64 = (offset, what) => Number(buffer.readBigUInt64LE(within(offset, 8, what)));

  const programHeaders = u64(0x20, "header");
  const entrySize = u16(0x36, "header");
  const count = u16(0x38, "header");
  if (count > 0 && entrySize < 56) malformed("program header table");
  const segments = [];
  for (let index = 0; index < count; index += 1) {
    const base = programHeaders + index * entrySize;
    within(base, 56, "program header table");
    segments.push({
      type: buffer.readUInt32LE(base),
      offset: u64(base + 8, "program header table"),
      address: u64(base + 16, "program header table"),
      fileSize: u64(base + 32, "program header table")
    });
  }
  const dynamic = segments.find((segment) => segment.type === PT_DYNAMIC);
  if (!dynamic) return { needed: [], versions: [] };

  const fileOffset = (address, what) => {
    const load = segments.find((segment) => segment.type === PT_LOAD &&
      address >= segment.address && address < segment.address + segment.fileSize);
    if (!load) malformed(what);
    return load.offset + (address - load.address);
  };

  const neededNames = [];
  let strtab, strsz, verneed, verneedCount = 0;
  within(dynamic.offset, dynamic.fileSize, "dynamic section");
  for (let offset = dynamic.offset; offset + 16 <= dynamic.offset + dynamic.fileSize; offset += 16) {
    const tag = buffer.readBigInt64LE(offset);
    const value = buffer.readBigUInt64LE(offset + 8);
    if (tag === DT_NULL) break;
    if (tag === DT_NEEDED) neededNames.push(Number(value));
    else if (tag === DT_STRTAB) strtab = Number(value);
    else if (tag === DT_STRSZ) strsz = Number(value);
    else if (tag === DT_VERNEED) verneed = Number(value);
    else if (tag === DT_VERNEEDNUM) verneedCount = Number(value);
  }
  if (neededNames.length === 0 && verneed === undefined) return { needed: [], versions: [] };
  if (strtab === undefined || strsz === undefined) malformed("dynamic section");

  const strings = within(fileOffset(strtab, "string table"), strsz, "string table");
  const string = (index) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= strsz) malformed("string table");
    const end = buffer.indexOf(0, strings + index);
    if (end === -1 || end >= strings + strsz) malformed("string table");
    return buffer.toString("latin1", strings + index, end);
  };

  const versions = [];
  if (verneed !== undefined) {
    let entry = fileOffset(verneed, "version requirements");
    for (let index = 0; index < verneedCount; index += 1) {
      const auxCount = u16(entry + 2, "version requirements");
      let aux = entry + u32(entry + 8, "version requirements");
      for (let auxIndex = 0; auxIndex < auxCount; auxIndex += 1) {
        versions.push(string(u32(aux + 8, "version requirements")));
        const next = u32(aux + 12, "version requirements");
        if (next === 0) break;
        aux += next;
      }
      const next = u32(entry + 12, "version requirements");
      if (next === 0) break;
      entry += next;
    }
  }
  return { needed: neededNames.map(string), versions };
}

/** The needed libraries glibc does not provide. */
export function disallowedLibraries(needed) {
  return needed.filter((library) => !GLIBC_LIBRARIES.has(library));
}

/** `GLIBC_2.34` → `2.34`; anything else (GLIBC_PRIVATE, GCC_3.0, CXXABI_…) is not a glibc release. */
export function glibcVersions(versionNames) {
  return versionNames.flatMap((name) => /^GLIBC_(\d+(?:\.\d+)+)$/.exec(name)?.[1] ?? []);
}

/** Orders dotted versions like `sort -V`: 2.2.5 < 2.17 < 2.35 < 2.35.1. */
export function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function newestVersion(versions) {
  return versions.reduce((newest, version) => newest === undefined || compareVersions(version, newest) > 0 ? version : newest, undefined);
}

/** The pinned avogadrolibs commit: CMakeLists.txt must name exactly one 40-hex commit. */
export function pinnedAvogadroCommit(cmakeSource) {
  const commits = [...new Set(cmakeSource.match(/[0-9a-f]{40}/g) ?? [])];
  return commits.length === 1 ? commits[0] : undefined;
}

// Ethanol's heavy atoms as a V2000 molfile.
const ETHANOL_MOLFILE = [
  "ethanol", "  ChemDraft", "", "  3  2  0  0  0  0  0  0  0  0999 V2000",
  "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    1.5200    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    2.0300    1.3500    0.1000 O   0  0  0  0  0  0  0  0  0  0  0  0",
  "  1  2  1  0  0  0  0", "  2  3  1  0  0  0  0", "M  END", ""
].join("\n");

export function handshakeRequests(session = "sidecar-check") {
  const request = (requestId, type, extra = {}) =>
    JSON.stringify({ protocolVersion: 2, requestId, sessionId: session, type, ...extra });
  return [
    request("check-create", "createSession", {
      input: {
        molfile: ETHANOL_MOLFILE, format: "molfile-v2000", atomIdByMolfileIndex: ["a1", "a2", "a3"],
        graphSignature: "check", bondSignature: "check"
      }
    }),
    request("check-ping", "ping"),
    request("check-commit", "commit"),
    request("check-dispose", "dispose")
  ].map((line) => `${line}\n`).join("");
}

/** The first handshake problem in the sidecar's stdout, worded as before, or undefined. */
export function handshakeProblem(stdout, commit) {
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  // stdout is protocol-only: one JSON object per line.
  if (lines.some((line) => !line.startsWith('{"protocolVersion":2,'))) return "wrote a non-protocol line to stdout";
  const expectations = [
    ["the createSession response", "check-create", ['"type":"response"', '"ok":true']],
    ["the ready event", "check-create.event", ['"eventType":"ready"', '"headlessPhysics":true']],
    ["the ping response", "check-ping", ['"ok":true']],
    ["the commit response", "check-commit", ['"ok":true', '"engine":{"name":"avogadro3d-sidecar"',
      `"sourceCommit":"${commit}"`, '"forceField":{"name":"UFF"', '"avogadroBacked":true']],
    ["the dispose response", "check-dispose", ['"ok":true']]
  ];
  for (const [what, requestId, needles] of expectations) {
    const response = lines.filter((line) => line.includes(`"requestId":"${requestId}"`)).join("\n");
    const missing = needles.find((needle) => !response.includes(needle));
    if (missing) return `handshake is missing ${what} (${missing})`;
  }
  return undefined;
}

/** The shell's status for a command it could not find (127) or could not run (126). */
function launchFailureStatus(error) {
  return error.code === "ENOENT" ? 127 : ["EACCES", "ENOEXEC"].includes(error.code) ? 126 : 1;
}

export function runSidecarHandshake(sidecar, input) {
  return new Promise((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(sidecar, ["--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolveRun({ status: launchFailureStatus(error), stdout, stderr: `${error.message}\n` });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, HANDSHAKE_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    // A sidecar that exits before reading every request closes the pipe; its status says why.
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      clearTimeout(timer);
      stderr += `${error.message}\n`;
      resolveRun({ status: launchFailureStatus(error), stdout, stderr });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const status = timedOut ? TIMEOUT_STATUS : code ?? 128 + (osConstants.signals[signal] ?? 0);
      resolveRun({ status, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

export async function checkEngine3dSidecar(sidecar, { rootDir = ROOT_DIR, log = console.log } = {}) {
  const fail = (message) => { throw new SidecarCheckFailure(message); };
  let stats;
  try { stats = statSync(sidecar); } catch { fail("missing"); }
  if (!stats.isFile()) fail("missing");
  try { accessSync(sidecar, constants.X_OK); } catch { fail("not executable"); }
  const binary = readFileSync(sidecar);
  if (binary.includes(PLACEHOLDER_MARKER)) fail("is the committed placeholder, not a native build");
  const headerProblem = elfHeaderProblem(binary);
  if (headerProblem) fail(headerProblem);

  const { needed, versions } = readElfDependencies(binary);
  log(`Shared libraries the sidecar needs: ${needed.join(" ")}`);
  const disallowed = disallowedLibraries(needed);
  if (disallowed.length > 0) {
    throw new SidecarCheckFailure(`The sidecar needs ${disallowed[0]}; only glibc libraries are allowed.`, { perFile: false });
  }
  const newest = newestVersion(glibcVersions(versions));
  log(`Newest glibc symbol version: ${newest ?? "none"}`);
  if (newest !== undefined && compareVersions(newest, MAX_GLIBC) > 0) {
    throw new SidecarCheckFailure(`The sidecar needs glibc ${newest}; the oldest supported host has ${MAX_GLIBC}.`, { perFile: false });
  }

  const commit = pinnedAvogadroCommit(readFileSync(join(rootDir, "native", "avogadro3d-sidecar", "CMakeLists.txt"), "utf8"));
  if (!commit) fail("CMakeLists.txt must pin exactly one avogadrolibs commit");

  const { status, stdout, stderr } = await runSidecarHandshake(sidecar, handshakeRequests());
  const show = () => {
    log("--- sidecar stdout"); process.stdout.write(stdout);
    log("--- sidecar stderr"); process.stdout.write(stderr);
  };
  if (status !== 0) { show(); fail(`exited with status ${status}`); }
  const problem = handshakeProblem(stdout, commit);
  if (problem) { show(); fail(problem); }
  log(`3D sidecar ${sidecar}: native x86-64 ELF; handshake complete (UFF, avogadrolibs ${commit}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sidecar = process.argv[2];
  if (!sidecar) {
    console.error("usage: check-engine3d-sidecar.mjs <path to avogadro3d-sidecar>");
    process.exit(2);
  }
  try {
    await checkEngine3dSidecar(sidecar);
  } catch (error) {
    if (!(error instanceof SidecarCheckFailure)) throw error;
    // GitHub annotations, worded as the shell checks printed them.
    console.log(error.perFile ? `::error::3D sidecar ${sidecar}: ${error.message}` : `::error::${error.message}`);
    process.exit(1);
  }
}
