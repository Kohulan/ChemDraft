import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { processReleaseChecksums, SUMS_FILE, verifyReleaseChecksums, writeReleaseChecksums } from "./release-checksums.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "chemdraft-checksums-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "mac.dmg"), "mac payload");
  writeFileSync(join(dir, "windows.exe"), "windows payload");
  return dir;
}

test("writes sorted two-space LF lines for all asset files and verifies", (t) => {
  const dir = fixture(t);
  const sums = writeReleaseChecksums(dir);
  assert.match(sums, /^[0-9a-f]{64}  mac\.dmg\n[0-9a-f]{64}  windows\.exe\n$/);
  assert.equal(sums.includes("\r"), false);
  assert.equal(verifyReleaseChecksums(dir), true);
});

test("verification rejects missing, unattached, changed and CRLF entries", (t) => {
  const dir = fixture(t);
  const valid = writeReleaseChecksums(dir);
  writeFileSync(join(dir, "SHA256SUMS.txt"), `${valid.split("\n")[0]}\n`);
  assert.throws(() => verifyReleaseChecksums(dir), /missing windows\.exe/);
  writeFileSync(join(dir, "SHA256SUMS.txt"), `${valid}${"0".repeat(64)}  orphan.zip\n`);
  assert.throws(() => verifyReleaseChecksums(dir), /unattached/);
  writeFileSync(join(dir, "SHA256SUMS.txt"), valid.replaceAll("\n", "\r\n"));
  assert.throws(() => verifyReleaseChecksums(dir), /CRLF/);
  writeFileSync(join(dir, "SHA256SUMS.txt"), valid.replace(/^./, "f"));
  assert.throws(() => verifyReleaseChecksums(dir), /checksum mismatch/);
});

test("tag mode delegates download to gh and supports verification", (t) => {
  const dir = fixture(t);
  writeReleaseChecksums(dir);
  let invocation;
  assert.equal(processReleaseChecksums({ tag: "v1.2.3", verify: true }, {
    makeTemp: () => dir, cleanup: () => {},
    run: (command, args) => { invocation = [command, args]; return { status: 0 }; }
  }), true);
  assert.equal(invocation[0], "gh");
  assert.deepEqual(invocation[1].slice(0, 3), ["release", "download", "v1.2.3"]);
  assert.throws(() => processReleaseChecksums({ tag: "latest" }), /Expected --tag/);
  assert.throws(() => processReleaseChecksums({ tag: "v1.2.3" }, { makeTemp: () => dir, cleanup: () => {}, run: () => ({ status: 1, stderr: "no release" }) }), /no release/);
});

test("tag write mode uploads combined LF sums over every attached asset before cleanup", (t) => {
  const dir = fixture(t);
  const expected = writeReleaseChecksums(dir);
  // Simulate the stale Windows-only sums left on a draft after Mac assets arrive.
  writeFileSync(join(dir, SUMS_FILE), expected.split("\n").filter((line) => line.endsWith("windows.exe")).join("\n") + "\n");
  const calls = [];
  let uploaded;
  const content = processReleaseChecksums({ tag: "v1.2.3" }, {
    makeTemp: () => dir,
    run: (command, args, options) => {
      calls.push([command, args]);
      assert.equal(options.encoding, "utf8");
      if (args[1] === "upload") uploaded = readFileSync(args[3], "utf8");
      return { status: 0 };
    }
  });
  assert.deepEqual(calls, [
    ["gh", ["release", "download", "v1.2.3", "--dir", dir]],
    ["gh", ["release", "upload", "v1.2.3", join(dir, SUMS_FILE), "--clobber"]]
  ]);
  assert.equal(uploaded, expected);
  assert.equal(content, expected);
  assert.equal(uploaded.includes("\r"), false);
  assert.equal(existsSync(dir), false);
});

for (const operation of ["download", "upload"]) {
  test(`tag write mode reports gh ${operation} failures and cleans up`, (t) => {
    const dir = fixture(t);
    const calls = [];
    assert.throws(() => processReleaseChecksums({ tag: "v1.2.3" }, {
      makeTemp: () => dir,
      run: (_command, args) => {
        calls.push(args[1]);
        return args[1] === operation ? { status: 1, stderr: `${operation} refused` } : { status: 0 };
      }
    }), new RegExp(`gh release ${operation} v1.2.3: ${operation} refused`));
    assert.deepEqual(calls, operation === "download" ? ["download"] : ["download", "upload"]);
    assert.equal(existsSync(dir), false);
  });
}
