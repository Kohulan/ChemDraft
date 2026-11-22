import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  compareVersions,
  disallowedLibraries,
  elfHeaderProblem,
  GLIBC_LIBRARIES,
  glibcVersions,
  handshakeProblem,
  handshakeRequests,
  MAX_GLIBC,
  newestVersion,
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

describe("handshake", () => {
  const commit = "416651ddaef33a4e20392392e7c0b505d446491b";
  const goodStdout = [
    '{"protocolVersion":2,"requestId":"check-create","type":"response","ok":true}',
    '{"protocolVersion":2,"requestId":"check-create.event","eventType":"ready","headlessPhysics":true}',
    '{"protocolVersion":2,"requestId":"check-ping","ok":true}',
    `{"protocolVersion":2,"requestId":"check-commit","ok":true,"engine":{"name":"avogadro3d-sidecar","sourceCommit":"${commit}"},"forceField":{"name":"UFF","avogadroBacked":true}}`,
    '{"protocolVersion":2,"requestId":"check-dispose","ok":true}'
  ].join("\n") + "\n";

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
    expect(requests.every(request => request.protocolVersion === 2 && request.sessionId === "sidecar-check")).toBe(true);
    expect(lines[0]).toMatch(/^\{"protocolVersion":2,"requestId":"check-create","sessionId":"sidecar-check","type":"createSession","input":\{"molfile":"ethanol\\n  ChemDraft\\n\\n  3  2/);
    expect(requests[0].input.molfile.endsWith("M  END\n")).toBe(true);
  });

  it("accepts a complete handshake and names the first missing part", () => {
    expect(handshakeProblem(goodStdout, commit)).toBeUndefined();
    expect(handshakeProblem(`log line\n${goodStdout}`, commit)).toBe("wrote a non-protocol line to stdout");
    expect(handshakeProblem(goodStdout.replace('"headlessPhysics":true', '"headlessPhysics":false'), commit))
      .toBe('handshake is missing the ready event ("headlessPhysics":true)');
    expect(handshakeProblem(goodStdout, "0".repeat(40)))
      .toBe(`handshake is missing the commit response ("sourceCommit":"${"0".repeat(40)}")`);
    expect(handshakeProblem("", commit)).toBe('handshake is missing the createSession response ("type":"response")');
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
      expect(result).toMatchObject({ status: 0, stdout: handshakeRequests() });
    });

    it("reports the exit status, and the shell's 127 for a missing file", async () => {
      expect((await runSidecarHandshake(stub("fails", "echo oops >&2; exit 3"), "")).status).toBe(3);
      expect((await runSidecarHandshake(join(work, "absent"), "")).status).toBe(127);
    });
  });
});
