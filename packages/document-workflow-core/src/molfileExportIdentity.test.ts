import { describe, expect, it } from "../../../node_modules/vitest";
import { assertMolfileExportIdentity } from "./molfileExportIdentity";

const v2000 = `
  ChemDraft

  6  4  0  0  0  0  0  0  0  0999 V2000
    0.0000    1.0000    0.0000 F   0  0  0  0  0  0  0  0  0  0  0  0
    1.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    2.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    3.0000   -1.0000    0.0000 F   0  0  0  0  0  0  0  0  0  0  0  0
    5.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    6.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0  0  0  0
  2  3  2  0  0  0  0
  3  4  1  0  0  0  0
  5  6  8  0  0  0  0
M  END`;

const v3000 = `
  ChemDraft

  0  0  0  0  0  0            999 V3000
M  V30 BEGIN CTAB
M  V30 COUNTS 6 4 0 0 0
M  V30 BEGIN ATOM
M  V30 1 F 0 1 0 0
M  V30 2 C 1 0 0 0
M  V30 3 C 2 0 0 0
M  V30 4 F 3 -1 0 0
M  V30 5 C 5 0 0 0
M  V30 6 C 6 0 0 0
M  V30 END ATOM
M  V30 BEGIN BOND
M  V30 1 1 1 2
M  V30 2 2 2 3
M  V30 3 1 3 4
M  V30 4 8 5 6
M  V30 END BOND
M  V30 END CTAB
M  END`;

describe.each([["V2000", v2000], ["V3000", v3000]])("%s export identity", (_format, molfile) => {
  it("accepts identical stereo-capable CTABs without an identifier or stereo reader", async () => {
    await expect(assertMolfileExportIdentity(molfile, molfile, undefined, "Export")).resolves.toBeUndefined();
  });

  it("refuses changed stereo-capable CTABs without a stereo reader", async () => {
    await expect(assertMolfileExportIdentity(molfile, molfile.replace("ChemDraft", "Changed"), undefined, "Export"))
      .rejects.toThrow("no molfile stereo reader is available");
  });
});
