#!/usr/bin/env node
// Checks that an avogadro3d-sidecar is a real x86-64 ELF build, not the committed placeholder
// (apps/desktop/src-tauri/binaries/README.md); that it needs only glibc, and at most the glibc of the
// oldest supported host; and that it completes the stdio protocol handshake with Avogadro's UFF
// linked in and the pinned avogadrolibs commit reported. Every stdout line is parsed as a protocol
// message, as the app parses it (packages/engine3d-api).
// Node built-ins only, and no binutils: it reads the ELF's dynamic section itself, so it runs the
// same on the build runner and inside every distro container (which installs only `nodejs`).
// With --packaged (a sidecar inside an extracted .deb or AppImage, or installed from one), it must also
// be a regular file with mode exactly 0755, so every user can run it after a root-owned install.
// Usage: node scripts/check-engine3d-sidecar.mjs [--packaged] <path to avogadro3d-sidecar>
import { spawn } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PLACEHOLDER_MARKER = "avogadro3d-sidecar placeholder";
const HANDSHAKE_TIMEOUT_MS = 60_000;
/** How long a sidecar may take to exit after SIGTERM, and then after SIGKILL, before the check gives up. */
const KILL_GRACE_MS = 5_000;
/** The process status GNU `timeout` reports when it had to stop the command. */
const TIMEOUT_STATUS = 124;
/** The session the handshake creates; every message the sidecar writes back must carry it. */
export const HANDSHAKE_SESSION = "sidecar-check";
/** The app rejects a longer protocol line (DefaultEngine3DMaxMessageBytes in packages/engine3d-api). */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

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

export function handshakeRequests(session = HANDSHAKE_SESSION) {
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

const HANDSHAKE_REQUEST_IDS = ["check-create", "check-ping", "check-commit", "check-dispose"];
/** Engine3DEventType in packages/engine3d-api. */
const EVENT_TYPES = new Set([
  "ready", "coordinatesChanged", "energyChanged", "selectionChanged", "warning", "error", "heartbeat", "closed"
]);

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value, path) => path.split(".").reduce((node, key) => isRecord(node) ? node[key] : undefined, value);
const isCoordinate = (value) => isRecord(value) && ["x", "y", "z"].every((axis) => Number.isFinite(value[axis]));
const coordinatesFor = (atomIds) => (value) => isRecord(value) &&
  Object.keys(value).sort().join() === [...atomIds].sort().join() && atomIds.every((id) => isCoordinate(value[id]));

/**
 * The sidecar's stdout as the app reads it (packages/engine3d-api parseEngine3DMessageLine): one
 * protocol-version-2 JSON object per newline-terminated line, each a response or an event for this
 * session. Returns the messages, or the first problem.
 */
export function parseHandshakeMessages(stdout, session = HANDSHAKE_SESSION) {
  if (stdout === "") return { messages: [] };
  if (!stdout.endsWith("\n")) return { problem: "wrote a non-protocol line to stdout (the last line is not newline-terminated)" };
  const messages = [];
  for (const [index, line] of stdout.slice(0, -1).split("\n").entries()) {
    const bad = (why) => ({ problem: `wrote a non-protocol line to stdout (line ${index + 1} ${why})` });
    if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) return bad(`is longer than the app's ${MAX_MESSAGE_BYTES}-byte limit`);
    let message;
    try { message = JSON.parse(line); } catch { return bad("is not JSON"); }
    if (!isRecord(message)) return bad("is not a JSON object");
    if (message.protocolVersion !== 2) return bad(`has protocolVersion ${JSON.stringify(message.protocolVersion)}, not 2`);
    if (message.type !== "response" && message.type !== "event") return bad(`has type ${JSON.stringify(message.type)}, not response or event`);
    if (typeof message.requestId !== "string" || message.requestId === "") return bad("has no requestId");
    if (message.sessionId !== session) return bad(`has sessionId ${JSON.stringify(message.sessionId)}, not "${session}"`);
    const ids = message.type === "response" ? HANDSHAKE_REQUEST_IDS : HANDSHAKE_REQUEST_IDS.map((id) => `${id}.event`);
    if (!ids.includes(message.requestId)) return bad(`answers requestId ${JSON.stringify(message.requestId)}, which was never sent`);
    if (message.type === "response" && typeof message.ok !== "boolean") return bad("is a response without a boolean ok");
    if (message.type === "event" && !EVENT_TYPES.has(message.eventType)) return bad(`has eventType ${JSON.stringify(message.eventType)}`);
    messages.push(message);
  }
  return { messages };
}

/** The first handshake problem in the sidecar's stdout, or undefined. */
export function handshakeProblem(stdout, commit, session = HANDSHAKE_SESSION) {
  const { messages, problem } = parseHandshakeMessages(stdout, session);
  if (problem) return problem;
  // The app records an error event on the session even when the expected messages follow it.
  const error = messages.find((message) => message.type === "event" && message.eventType === "error");
  if (error) {
    const detail = typeof error.message === "string" && error.message !== "" ? `: ${error.message}` : "";
    return `handshake reported an error event for ${error.requestId}${detail}`;
  }
  const response = (requestId) => messages.filter((message) => message.type === "response" && message.requestId === requestId);
  const event = (requestId, eventType) => messages.filter((message) =>
    message.type === "event" && message.requestId === `${requestId}.event` && message.eventType === eventType);
  const atoms = ["a1", "a2", "a3"];
  // [what, the matching messages, [field path, expected value or predicate, description]...]
  const expectations = [
    ["the createSession response", response("check-create"), [["ok", true], ["result.sessionId", session]]],
    ["the ready event", event("check-create", "ready"), [
      ["capabilities.headlessPhysics", true], ["capabilities.forceField", "UFF"],
      ["coords3dByAtomId", coordinatesFor(atoms), "a coordinate for each of a1, a2, a3"]
    ]],
    ["the ping response", response("check-ping"), [["ok", true]]],
    ["the commit response", response("check-commit"), [
      ["ok", true], ["result.sessionId", session], ["result.graphSignature", "check"], ["result.bondSignature", "check"],
      ["result.engine.name", "avogadro3d-sidecar"], ["result.engine.sourceCommit", commit],
      ["result.forceField.name", "UFF"], ["result.forceField.avogadroBacked", true],
      ["result.coords3dByAtomId", coordinatesFor(atoms), "a coordinate for each of a1, a2, a3"]
    ]],
    ["the dispose response", response("check-dispose"), [["ok", true]]]
  ];
  for (const [what, found, fields] of expectations) {
    if (found.length === 0) return `handshake is missing ${what}`;
    if (found.length > 1) return `handshake has ${found.length} of ${what}, not one`;
    for (const [path, expected, description] of fields) {
      const actual = field(found[0], path);
      const matches = typeof expected === "function" ? expected(actual) : actual === expected;
      if (!matches) {
        const wanted = description ?? JSON.stringify(expected);
        return `handshake has an unexpected ${what.replace(/^the /, "")} (${path} must be ${wanted}, not ${JSON.stringify(actual) ?? "missing"})`;
      }
    }
  }
  return undefined;
}

/** The shell's status for a command it could not find (127) or could not run (126). */
function launchFailureStatus(error) {
  return error.code === "ENOENT" ? 127 : ["EACCES", "ENOEXEC"].includes(error.code) ? 126 : 1;
}

/**
 * Runs `<sidecar> --stdio` with `input` on stdin. After `timeoutMs` it sends SIGTERM, after a further
 * `killGraceMs` SIGKILL, and after one more `killGraceMs` it stops waiting (a process the sidecar left
 * behind can hold the pipes open), reporting status 124 and `timedOut`.
 */
export function runSidecarHandshake(sidecar, input, { timeoutMs = HANDSHAKE_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS } = {}) {
  return new Promise((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(sidecar, ["--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolveRun({ status: launchFailureStatus(error), stdout, stderr: `${error.message}\n`, timedOut });
      return;
    }
    const timers = [];
    const later = (ms, action) => timers.push(setTimeout(action, ms));
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      resolveRun({ status: timedOut ? TIMEOUT_STATUS : status, stdout, stderr, timedOut });
    };
    later(timeoutMs, () => {
      timedOut = true;
      child.kill("SIGTERM");
      later(killGraceMs, () => {
        child.kill("SIGKILL");
        later(killGraceMs, () => {
          for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
          finish(TIMEOUT_STATUS);
        });
      });
    });
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    // A sidecar that exits before reading every request closes the pipe; its status says why.
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
      finish(launchFailureStatus(error));
    });
    child.on("close", (code, signal) => finish(code ?? 128 + (osConstants.signals[signal] ?? 0)));
    child.stdin.end(input);
  });
}

/** Why a packaged sidecar's file type or mode is wrong, or undefined for a regular file with mode 0755. */
export function packagedModeProblem(stats) {
  if (!stats.isFile()) return "is not a regular file in the package";
  const mode = stats.mode & 0o7777;
  if (mode !== 0o755) return `has mode ${mode.toString(8).padStart(4, "0")} in the package; it must be 0755`;
  return undefined;
}

export async function checkEngine3dSidecar(sidecar, { rootDir = ROOT_DIR, log = console.log, packaged = false } = {}) {
  const fail = (message) => { throw new SidecarCheckFailure(message); };
  let stats;
  // X_OK says only that this account may run it; a package must let every user run it.
  try { stats = packaged ? lstatSync(sidecar) : statSync(sidecar); } catch { fail("missing"); }
  if (packaged) {
    const modeProblem = packagedModeProblem(stats);
    if (modeProblem) fail(modeProblem);
  }
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

  // The file checked above, relative to the working directory: spawn would look a bare name up in PATH.
  const { status, stdout, stderr, timedOut } = await runSidecarHandshake(resolve(sidecar), handshakeRequests());
  const show = () => {
    log("--- sidecar stdout"); process.stdout.write(stdout);
    log("--- sidecar stderr"); process.stdout.write(stderr);
  };
  if (timedOut) { show(); fail(`did not finish the handshake within ${HANDSHAKE_TIMEOUT_MS / 1000} s and was killed`); }
  if (status !== 0) { show(); fail(`exited with status ${status}`); }
  const problem = handshakeProblem(stdout, commit);
  if (problem) { show(); fail(problem); }
  log(`3D sidecar ${sidecar}: native x86-64 ELF${packaged ? ", mode 0755" : ""}; handshake complete (UFF, avogadrolibs ${commit}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const packaged = args[0] === "--packaged";
  const sidecar = packaged ? args[1] : args[0];
  if (!sidecar || args.length !== (packaged ? 2 : 1)) {
    console.error("usage: check-engine3d-sidecar.mjs [--packaged] <path to avogadro3d-sidecar>");
    process.exit(2);
  }
  try {
    await checkEngine3dSidecar(sidecar, { packaged });
  } catch (error) {
    if (!(error instanceof SidecarCheckFailure)) throw error;
    // GitHub annotations, worded as the shell checks printed them.
    console.log(error.perFile ? `::error::3D sidecar ${sidecar}: ${error.message}` : `::error::${error.message}`);
    process.exit(1);
  }
}
