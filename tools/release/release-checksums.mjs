#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export const SUMS_FILE = "SHA256SUMS.txt";
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function releaseChecksums(directory) {
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name !== SUMS_FILE)
    .map(({ name }) => `${digest(join(directory, name))}  ${name}`).sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
}

export function writeReleaseChecksums(directory) {
  const content = `${releaseChecksums(directory).join("\n")}\n`;
  writeFileSync(join(directory, SUMS_FILE), content, { encoding: "utf8" });
  return content;
}

export function verifyReleaseChecksums(directory) {
  const path = join(directory, SUMS_FILE);
  const actual = readFileSync(path, "utf8");
  if (actual.includes("\r")) throw new Error(`${SUMS_FILE}: CRLF is not allowed`);
  const expected = `${releaseChecksums(directory).join("\n")}\n`;
  if (actual !== expected) {
    const actualNames = actual.split("\n").filter(Boolean).map((line) => line.match(/^[0-9a-f]{64}  (.+)$/)?.[1]).filter(Boolean);
    const expectedNames = releaseChecksums(directory).map((line) => line.slice(66));
    const missing = expectedNames.filter((name) => !actualNames.includes(name));
    const extra = actualNames.filter((name) => !expectedNames.includes(name));
    throw new Error(`${SUMS_FILE}: checksum mismatch${missing.length ? `; missing ${missing.join(", ")}` : ""}${extra.length ? `; unattached ${extra.join(", ")}` : ""}`);
  }
  return true;
}

export function processReleaseChecksums({ assets, tag, verify = false }, { run = spawnSync, makeTemp = () => mkdtempSync(join(tmpdir(), "chemdraft-release-sums-")), cleanup = (path) => rmSync(path, { recursive: true, force: true }) } = {}) {
  if (Boolean(assets) === Boolean(tag)) throw new Error("Provide exactly one of --assets or --tag");
  let folder = assets && resolve(assets);
  const temporary = Boolean(tag);
  if (tag) {
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("Expected --tag vX.Y.Z");
    folder = makeTemp();
  }
  try {
    if (tag) {
      // Hash the complete attached asset set, including files uploaded by another platform.
      const result = run("gh", ["release", "download", tag, "--dir", folder], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`gh release download ${tag}: ${result.stderr || result.error?.message || "download failed"}`);
    }
    if (verify) return verifyReleaseChecksums(folder);
    const content = writeReleaseChecksums(folder);
    if (tag) {
      const result = run("gh", ["release", "upload", tag, join(folder, SUMS_FILE), "--clobber"], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`gh release upload ${tag}: ${result.stderr || result.error?.message || "upload failed"}`);
    }
    return content;
  }
  finally { if (temporary) cleanup(folder); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { assets: { type: "string" }, tag: { type: "string" }, verify: { type: "boolean", default: false } } });
    processReleaseChecksums(values);
    console.log(`SHA-256 sums ${values.verify ? "verified" : values.tag ? "uploaded" : "written"}`);
  } catch (error) { console.error(`Release checksums: ${error.message}`); process.exitCode = 1; }
}
