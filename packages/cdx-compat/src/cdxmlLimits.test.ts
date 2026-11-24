import { describe, expect, it } from "vitest";
import * as limitsModule from "./cdxmlLimits";

// Unmocked: these are the values production runs with.
describe("CDXML production caps (#442)", () => {
  it("pins every production cap", () => {
    expect({ ...limitsModule.cdxmlLimits }).toEqual({
      colorTable: 65_534, objectColorTableCopies: 65_536,
      fontTable: 65_535, fontId: 65_535, captionRuns: 65_535, documentCaptionRuns: 262_144,
      textFontTableCopies: 16_384, textFontTableCopyChars: 1_048_576,
      rootPageAttributeCopyChars: 1_048_576
    });
  });

  it("cannot be mutated, and the module exports no override", () => {
    expect(Object.isFrozen(limitsModule.cdxmlLimits)).toBe(true);
    const limits = limitsModule.cdxmlLimits as unknown as Record<string, number>;
    expect(() => { limits.colorTable = 1; }).toThrow(TypeError);
    expect(() => { delete limits.fontTable; }).toThrow(TypeError);
    expect(() => { limits.extra = 1; }).toThrow(TypeError);
    expect(limitsModule.cdxmlLimits.colorTable).toBe(65_534);
    expect(Object.keys(limitsModule).sort()).toEqual(["cdxmlLimits"]);
  });
});
