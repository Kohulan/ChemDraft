import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkEngine3dSidecar,
  compareVersions,
  disallowedLibraries,
  elfHeaderProblem,
  GLIBC_LIBRARIES,
  glibcVersions,
  HANDSHAKE_SESSION,
  handshakeProblem,
  handshakeRequests,
  MAX_GLIBC,
  MAX_MESSAGE_BYTES,
  newestVersion,
  packagedModeProblem,
  pinnedAvogadroCommit,
  readElfDependencies,
  runSidecarHandshake,
  SidecarCheckFailure
} from "./check-engine3d-sidecar.mjs";

/** A minimal x86-64 ELF: one PT_LOAD over the whole file and a PT_DYNAMIC with NEEDED and VERNEED. */
function syntheticElf({ needed, versions, machine = 0x3e }: { needed: string[]; versions: string[]; machine?: number }): Buffer {
  const names = [...needed, ...versions];
  const strings = Buffer.from(`\0${names.join("\0")}\0`, "latin1");
  const index = (name: string) => strings.indexOf(Buffer.from(`\0${name}\0`, "latin1")) + 1;
  const headerSize = 64;
  const programHeaders = headerSize;
  const stringsAt = programHeaders + 2 * 56;
  const verneedAt = stringsAt + strings.length + (8 - (strings.length % 8)) % 8;
  const verneedSize = 16 + 16 * versions.length;
  const dynamicAt = verneedAt + verneedSize;
  const dynamicEntries: Array<[bigint, number]> = [
    ...needed.map((name): [bigint, number] => [1n, index(name)]),
    [5n, stringsAt], [10n, strings.length], [0x6ffffffen, verneedAt], [0x6fffffffn, 1], [0n, 0]
  ];
  const size = dynamicAt + 16 * dynamicEntries.length;
  const elf = Buffer.alloc(size);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(elf, 0);
  elf.writeUInt16LE(3, 0x10); // ET_DYN
  elf.writeUInt16LE(machine, 0x12);
  elf.writeBigUInt64LE(BigInt(programHeaders), 0x20);
  elf.writeUInt16LE(56, 0x36);
  elf.writeUInt16LE(2, 0x38);
  const segment = (at: number, type: number, offset: number, fileSize: number) => {
    elf.writeUInt32LE(type, at);
    elf.writeBigUInt64LE(BigInt(offset), at + 8);
    elf.writeBigUInt64LE(BigInt(offset), at + 16); // vaddr = offset
    elf.writeBigUInt64LE(BigInt(fileSize), at + 32);
  };
  segment(programHeaders, 1, 0, size);
  segment(programHeaders + 56, 2, dynamicAt, 16 * dynamicEntries.length);
  strings.copy(elf, stringsAt);
  elf.writeUInt16LE(1, verneedAt);
  elf.writeUInt16LE(versions.length, verneedAt + 2);
  elf.writeUInt32LE(index("libc.so.6"), verneedAt + 4);
  elf.writeUInt32LE(16, verneedAt + 8);
  versions.forEach((name, position) => {
    const aux = verneedAt + 16 + 16 * position;
    elf.writeUInt32LE(index(name), aux + 8);
    elf.writeUInt32LE(position === versions.length - 1 ? 0 : 16, aux + 12);
  });
  dynamicEntries.forEach(([tag, value], position) => {
    elf.writeBigInt64LE(tag, dynamicAt + 16 * position);
    elf.writeBigUInt64LE(BigInt(value), dynamicAt + 16 * position + 8);
  });
  return elf;
}

describe("glibc version checks", () => {
  it("orders dotted versions numerically, like sort -V", () => {
    expect(compareVersions("2.4", "2.35")).toBe(-1);
    expect(compareVersions("2.35", "2.35")).toBe(0);
    expect(compareVersions("2.35", "2.35.1")).toBe(-1);
    expect(compareVersions("2.36", "2.35")).toBe(1);
    expect(newestVersion(["2.2.5", "2.17", "2.35", "2.34"])).toBe("2.35");
    expect(newestVersion([])).toBeUndefined();
  });

  it("keeps only glibc releases from the required version names", () => {
    expect(glibcVersions(["GLIBC_2.2.5", "GLIBC_PRIVATE", "GCC_3.0", "CXXABI_1.3", "GLIBC_2.34"])).toEqual(["2.2.5", "2.34"]);
    expect(MAX_GLIBC).toBe("2.35");
  });
});

describe("NEEDED allowlist", () => {
  it("allows exactly the glibc libraries", () => {
    expect([...GLIBC_LIBRARIES].sort()).toEqual([
      "ld-linux-x86-64.so.2", "libc.so.6", "libdl.so.2", "libm.so.6", "libpthread.so.0", "librt.so.1"
    ]);
    expect(disallowedLibraries(["libc.so.6", "libm.so.6", "ld-linux-x86-64.so.2"])).toEqual([]);
    expect(disallowedLibraries(["libc.so.6", "libstdc++.so.6", "libgcc_s.so.1"])).toEqual(["libstdc++.so.6", "libgcc_s.so.1"]);
  });

  it("reads NEEDED and the required symbol versions from the ELF's dynamic section", () => {
    const elf = syntheticElf({ needed: ["libc.so.6", "libstdc++.so.6"], versions: ["GLIBC_2.2.5", "GLIBC_2.38", "GLIBC_PRIVATE"] });
    expect(elfHeaderProblem(elf)).toBeUndefined();
    const { needed, versions } = readElfDependencies(elf);
    expect(needed).toEqual(["libc.so.6", "libstdc++.so.6"]);
    expect(versions).toEqual(["GLIBC_2.2.5", "GLIBC_2.38", "GLIBC_PRIVATE"]);
    expect(disallowedLibraries(needed)).toEqual(["libstdc++.so.6"]);
    expect(newestVersion(glibcVersions(versions))).toBe("2.38");
  });

  it("treats an ELF with no dynamic segment as needing nothing, and refuses a truncated one", () => {
    const elf = syntheticElf({ needed: ["libc.so.6"], versions: ["GLIBC_2.17"] });
    const staticElf = Buffer.from(elf);
    staticElf.writeUInt16LE(1, 0x38); // only the PT_LOAD remains
    expect(readElfDependencies(staticElf)).toEqual({ needed: [], versions: [] });
    expect(() => readElfDependencies(elf.subarray(0, elf.length - 40))).toThrow(SidecarCheckFailure);
    expect(() => readElfDependencies(elf.subarray(0, elf.length - 40))).toThrow(/malformed ELF/);
  });
});

describe("ELF header", () => {
  it("reports the header and machine as the shell check did", () => {
    expect(elfHeaderProblem(Buffer.from("hi\n"))).toBe("is not a 64-bit little-endian ELF (header 68690a)");
    const arm = syntheticElf({ needed: [], versions: [], machine: 0xb7 });
    expect(elfHeaderProblem(arm)).toBe("is not an x86-64 ELF (e_machine b700)");
    const elf32 = syntheticElf({ needed: [], versions: [] });
    elf32[4] = 1;
    expect(elfHeaderProblem(elf32)).toMatch(/^is not a 64-bit little-endian ELF \(header 7f454c460101/);
  });
});

describe("packaged sidecar mode", () => {
  const work = mkdtempSync(join(tmpdir(), "engine3d-sidecar-mode-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const file = (name: string, mode: number) => {
    const path = join(work, name);
    writeFileSync(path, "ChemDraft avogadro3d-sidecar placeholder.");
    chmodSync(path, mode);
    return path;
  };

  it.skipIf(process.platform === "win32")("requires a regular file with mode exactly 0755", () => {
    expect(packagedModeProblem(statSync(file("ok", 0o755)))).toBeUndefined();
    expect(packagedModeProblem(statSync(file("owner-only", 0o700)))).toBe("has mode 0700 in the package; it must be 0755");
    expect(packagedModeProblem(statSync(file("group-writable", 0o775)))).toBe("has mode 0775 in the package; it must be 0755");
    expect(packagedModeProblem(statSync(file("setuid", 0o4755)))).toBe("has mode 4755 in the package; it must be 0755");
    expect(packagedModeProblem(statSync(work))).toBe("is not a regular file in the package");
  });

  it.skipIf(process.platform === "win32")("fails a packaged 0700 copy or a symlink the CI account could still run", async () => {
    const ownerOnly = file("installed-0700", 0o700);
    await expect(checkEngine3dSidecar(ownerOnly, { packaged: true, log: () => undefined })).rejects.toThrow("has mode 0700 in the package; it must be 0755");
    const link = join(work, "link");
    symlinkSync(file("target", 0o755), link);
    await expect(checkEngine3dSidecar(link, { packaged: true, log: () => undefined })).rejects.toThrow("is not a regular file in the package");
    // Unpackaged, only executability is required; this one then fails as the placeholder it is.
    await expect(checkEngine3dSidecar(ownerOnly, { log: () => undefined })).rejects.toThrow("is the committed placeholder");
  });
});

describe("handshake", () => {
  const commit = "416651ddaef33a4e20392392e7c0b505d446491b";
  // The lines native/avogadro3d-sidecar/src/main.cpp writes for handshakeRequests(), in order: every
  // message carries the session, events answer "<requestId>.event", and the commit metadata sits
  // inside the commit response's result (Engine3DCommitResult in packages/engine3d-api).
  const coords = '{"a1":{"x":-1.2000,"y":0.1000,"z":0.0000},"a2":{"x":0.3000,"y":-0.2000,"z":0.0500},"a3":{"x":0.9000,"y":1.1000,"z":-0.0500}}';
  const forceField = '{"name":"UFF","status":"converged","energy":2.4167,"energyUnits":"kJ/mol","avogadroBacked":true}';
  const envelope = (requestId: string, type: string) =>
    `{"protocolVersion":2,"requestId":"${requestId}","sessionId":"sidecar-check","type":"${type}"`;
  const goodLines = [
    `${envelope("check-create", "response")},"ok":true,"result":{"sessionId":"sidecar-check"}}`,
    `${envelope("check-create.event", "event")},"eventType":"ready","capabilities":{"headlessPhysics":true,"worldSpaceDrag":true,"frontendRendering":true,"autoOptimize":true,"forceField":"UFF"},"coordinateRevision":0,"coords3dByAtomId":${coords}}`,
    `${envelope("check-create.event", "event")},"eventType":"coordinatesChanged","coordinateRevision":0,"reason":"embed","coords3dByAtomId":${coords}}`,
    `${envelope("check-create.event", "event")},"eventType":"coordinatesChanged","coordinateRevision":1,"reason":"initial-relax","coords3dByAtomId":${coords}}`,
    `${envelope("check-create.event", "event")},"eventType":"energyChanged","energy":2.4167,"forceField":${forceField}}`,
    `${envelope("check-ping", "response")},"ok":true}`,
    `${envelope("check-ping.event", "event")},"eventType":"heartbeat"}`,
    `${envelope("check-commit", "response")},"ok":true,"result":{"sessionId":"sidecar-check","coords3dByAtomId":${coords},"coordinateRevision":1,"graphSignature":"check","bondSignature":"check","engine":{"name":"avogadro3d-sidecar","version":"protocol-scout","sourceCommit":"${commit}"},"forceField":${forceField},"warnings":[]}}`,
    `${envelope("check-dispose", "response")},"ok":true}`,
    `${envelope("check-dispose.event", "event")},"eventType":"closed"}`
  ];
  const goodStdout = goodLines.join("\n") + "\n";
  const withLine = (index: number, line: string) => goodLines.map((original, at) => at === index ? line : original).join("\n") + "\n";
  const commitLine = goodLines.findIndex(line => line.includes('"requestId":"check-commit"'));

  it("reads the pinned commit from CMakeLists.txt", () => {
    expect(pinnedAvogadroCommit(`GIT_TAG ${commit}\n# ${commit}`)).toBe(commit);
    expect(pinnedAvogadroCommit(`${commit} ${"a".repeat(40)}`)).toBeUndefined();
    expect(pinnedAvogadroCommit("no commit")).toBeUndefined();
    const cmake = readFileSync(new URL("../native/avogadro3d-sidecar/CMakeLists.txt", import.meta.url), "utf8");
    expect(pinnedAvogadroCommit(cmake)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("sends the same four requests, one JSON object per line", () => {
    const lines = handshakeRequests().split("\n");
    expect(lines.pop()).toBe("");
    const requests = lines.map(line => JSON.parse(line));
    expect(requests.map(request => [request.requestId, request.type])).toEqual([
      ["check-create", "createSession"], ["check-ping", "ping"], ["check-commit", "commit"], ["check-dispose", "dispose"]
    ]);
    expect(requests.every(request => request.protocolVersion === 2 && request.sessionId === HANDSHAKE_SESSION)).toBe(true);
    expect(lines[0]).toMatch(/^\{"protocolVersion":2,"requestId":"check-create","sessionId":"sidecar-check","type":"createSession","input":\{"molfile":"ethanol\\n  ChemDraft\\n\\n  3  2/);
    expect(requests[0].input.molfile.endsWith("M  END\n")).toBe(true);
  });

  it("accepts the sidecar's real handshake", () => {
    expect(goodLines.every(line => JSON.parse(line).sessionId === HANDSHAKE_SESSION)).toBe(true);
    expect(handshakeProblem(goodStdout, commit)).toBeUndefined();
  });

  it("refuses a line that is not a complete protocol message, even when it holds every expected field", () => {
    // Cut after the fields a substring search looked for: no longer JSON the app could parse.
    const truncated = goodLines[commitLine]!.slice(0, goodLines[commitLine]!.indexOf('"avogadroBacked":true') + '"avogadroBacked":true'.length);
    expect(handshakeProblem(withLine(commitLine, truncated), commit))
      .toBe(`wrote a non-protocol line to stdout (line ${commitLine + 1} is not JSON)`);
    expect(handshakeProblem(goodStdout.slice(0, -1), commit))
      .toBe("wrote a non-protocol line to stdout (the last line is not newline-terminated)");
    expect(handshakeProblem(`log line\n${goodStdout}`, commit)).toBe("wrote a non-protocol line to stdout (line 1 is not JSON)");
    expect(handshakeProblem(`[1]\n${goodStdout}`, commit)).toBe("wrote a non-protocol line to stdout (line 1 is not a JSON object)");
    expect(handshakeProblem(goodStdout.replace('"protocolVersion":2,"requestId":"check-ping"', '"protocolVersion":3,"requestId":"check-ping"'), commit))
      .toMatch(/^wrote a non-protocol line to stdout \(line \d+ has protocolVersion 3, not 2\)$/);
  });

  it("refuses messages for another session, an unsent request, or an unknown type", () => {
    expect(handshakeProblem(goodStdout.replace('"requestId":"check-ping","sessionId":"sidecar-check"', '"requestId":"check-ping","sessionId":"other"'), commit))
      .toMatch(/line \d+ has sessionId "other", not "sidecar-check"/);
    expect(handshakeProblem(goodStdout.replace('"requestId":"check-ping","sessionId":"sidecar-check","type":"response"', '"requestId":"check-ping","type":"response"'), commit))
      .toMatch(/line \d+ has sessionId undefined, not "sidecar-check"/);
    expect(handshakeProblem(`${envelope("check-other", "response")},"ok":true}\n${goodStdout}`, commit))
      .toBe('wrote a non-protocol line to stdout (line 1 answers requestId "check-other", which was never sent)');
    expect(handshakeProblem(`${envelope("check-ping", "request")}}\n${goodStdout}`, commit))
      .toBe('wrote a non-protocol line to stdout (line 1 has type "request", not response or event)');
    expect(handshakeProblem(`${envelope("check-ping.event", "event")},"eventType":"bogus"}\n${goodStdout}`, commit))
      .toBe('wrote a non-protocol line to stdout (line 1 has eventType "bogus")');
  });

  it("refuses a line longer than the app accepts, and accepts one at the limit", () => {
    const padded = (bytes: number) => {
      const line = `${envelope("check-ping.event", "event")},"eventType":"heartbeat","pad":""}`;
      return line.replace('"pad":""', `"pad":"${"x".repeat(bytes - line.length)}"`);
    };
    expect(Buffer.byteLength(padded(MAX_MESSAGE_BYTES))).toBe(MAX_MESSAGE_BYTES);
    expect(handshakeProblem(`${padded(MAX_MESSAGE_BYTES)}\n${goodStdout}`, commit)).toBeUndefined();
    expect(handshakeProblem(`${padded(MAX_MESSAGE_BYTES + 1)}\n${goodStdout}`, commit))
      .toBe(`wrote a non-protocol line to stdout (line 1 is longer than the app's ${MAX_MESSAGE_BYTES}-byte limit)`);
  });

  it("refuses an error event even when every expected message follows it", () => {
    const error = `${envelope("check-create.event", "event")},"eventType":"error","message":"UFF setup failed"}`;
    expect(handshakeProblem(`${error}\n${goodStdout}`, commit))
      .toBe("handshake reported an error event for check-create.event: UFF setup failed");
    // A warning is not fatal in the app, so it does not fail the check.
    const warning = `${envelope("check-create.event", "event")},"eventType":"warning","message":"slow"}`;
    expect(handshakeProblem(`${warning}\n${goodStdout}`, commit)).toBeUndefined();
  });

  it("refuses commit metadata outside the result object, as the app reads it", () => {
    const outside = `${envelope("check-commit", "response")},"ok":true,"engine":{"name":"avogadro3d-sidecar","sourceCommit":"${commit}"},"forceField":{"name":"UFF","avogadroBacked":true}}`;
    expect(handshakeProblem(withLine(commitLine, outside), commit))
      .toBe("handshake has an unexpected commit response (result.sessionId must be \"sidecar-check\", not missing)");
  });

  it("names the first missing or wrong part", () => {
    expect(handshakeProblem(goodStdout.replace('"headlessPhysics":true', '"headlessPhysics":false'), commit))
      .toBe("handshake has an unexpected ready event (capabilities.headlessPhysics must be true, not false)");
    expect(handshakeProblem(goodStdout, "0".repeat(40)))
      .toBe(`handshake has an unexpected commit response (result.engine.sourceCommit must be "${"0".repeat(40)}", not "${commit}")`);
    expect(handshakeProblem(goodStdout.replaceAll('"avogadroBacked":true', '"avogadroBacked":false'), commit))
      .toBe("handshake has an unexpected commit response (result.forceField.avogadroBacked must be true, not false)");
    expect(handshakeProblem(goodStdout.replace('"requestId":"check-dispose","sessionId":"sidecar-check","type":"response","ok":true', '"requestId":"check-dispose","sessionId":"sidecar-check","type":"response","ok":false'), commit))
      .toBe("handshake has an unexpected dispose response (ok must be true, not false)");
    expect(handshakeProblem(withLine(commitLine, goodLines[commitLine]!.replace('"a3":', '"a4":')), commit))
      .toMatch(/^handshake has an unexpected commit response \(result\.coords3dByAtomId must be a coordinate for each of a1, a2, a3, not /);
    expect(handshakeProblem(goodLines.filter((_, index) => index !== 1).join("\n") + "\n", commit)).toBe("handshake is missing the ready event");
    expect(handshakeProblem(goodStdout + goodLines[5] + "\n", commit)).toBe("handshake has 2 of the ping response, not one");
    expect(handshakeProblem("", commit)).toBe("handshake is missing the createSession response");
  });

  describe.skipIf(process.platform === "win32")("running a sidecar", () => {
    const work = mkdtempSync(join(tmpdir(), "engine3d-sidecar-check-"));
    afterAll(() => rmSync(work, { recursive: true, force: true }));
    const stub = (name: string, body: string) => {
      const path = join(work, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
      return path;
    };

    it("feeds the requests on stdin and returns its stdout", async () => {
      const result = await runSidecarHandshake(stub("echo", '[ "$1" = --stdio ] || exit 9\ncat'), handshakeRequests());
      expect(result).toMatchObject({ status: 0, stdout: handshakeRequests(), timedOut: false });
    });

    it("reports the exit status, and the shell's 127 for a missing file", async () => {
      expect((await runSidecarHandshake(stub("fails", "echo oops >&2; exit 3"), "")).status).toBe(3);
      expect((await runSidecarHandshake(join(work, "absent"), "")).status).toBe(127);
    });

    it("kills a sidecar that ignores SIGTERM and fails with status 124", async () => {
      const started = Date.now();
      const result = await runSidecarHandshake(stub("stubborn", "trap '' TERM\nwhile :; do :; done"), "", { timeoutMs: 200, killGraceMs: 200 });
      expect(result).toMatchObject({ status: 124, timedOut: true });
      expect(Date.now() - started).toBeLessThan(4_000);
    });

    it("stops waiting when a process the sidecar left behind holds its output open", async () => {
      const started = Date.now();
      const result = await runSidecarHandshake(stub("orphan", "trap '' TERM\nsleep 3"), "", { timeoutMs: 200, killGraceMs: 200 });
      expect(result).toMatchObject({ status: 124, timedOut: true });
      expect(Date.now() - started).toBeLessThan(2_500);
    });
  });
});
