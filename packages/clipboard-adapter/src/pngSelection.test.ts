import { crc32 } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";
import { MAX_IMAGE_OBJECT_BYTES, readPngInfo } from "@chemdraft/chem-core";
import { CHEMDRAFT_PNG_SELECTION_KEYWORD, pngWithChemDraftSelection } from "./pngSelection";

function chunks(png: Uint8Array) {
  const buffer = Buffer.from(png);
  const result: { type: string; data: Buffer; bytes: Buffer }[] = [];
  for (let offset = 8; offset < buffer.length;) {
    const end = offset + buffer.readUInt32BE(offset) + 12;
    result.push({ type: buffer.toString("ascii", offset + 4, offset + 8),
      data: buffer.subarray(offset + 8, end - 4), bytes: buffer.subarray(offset, end) });
    offset = end;
  }
  return result;
}

describe("PNG selection carrier", () => {
  const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><path d="M1 1L19 9" stroke="black"/></svg>').render().asPng();
  it("embeds exact UTF-8 JSON in a standard CRC-checked iTXt chunk, preserving every image chunk", () => {
    const json = JSON.stringify({ kind: "chemdraft-selection", version: 1, text: "Δ Na⁺ 日本語" });
    const result = pngWithChemDraftSelection(png, json);
    const output = chunks(result);
    const metadata = output.find(chunk => chunk.type === "iTXt")!;
    expect(metadata.data.toString("utf8")).toBe(`${CHEMDRAFT_PNG_SELECTION_KEYWORD}\0\0\0\0\0${json}`);
    expect(metadata.bytes.readUInt32BE(metadata.bytes.length - 4)).toBe(crc32(metadata.bytes.subarray(4, -4)));
    expect(output.filter(chunk => chunk !== metadata)).toEqual(chunks(png));
    expect(output.at(-2)).toBe(metadata);
    expect(readPngInfo(result)).toEqual(readPngInfo(png));
    const replaced = chunks(pngWithChemDraftSelection(result, "{}"));
    expect(replaced.filter(chunk => chunk.type === "iTXt")).toHaveLength(1);
    expect(replaced.find(chunk => chunk.type === "iTXt")!.data.toString().endsWith("{}")).toBe(true);
  });
  it("refuses malformed PNG and over-limit carriers before writing the clipboard", () => {
    expect(() => pngWithChemDraftSelection(png.subarray(0, 33), "{}")).toThrow("PNG failed validation");
    expect(() => pngWithChemDraftSelection(png, "x".repeat(MAX_IMAGE_OBJECT_BYTES))).toThrow("25 MB picture limit");
  });
});
