import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deserializeDocument, type MoleculeObject } from "@chemdraft/chem-core";
import {
  ATOM_MAPS_DROPPED_EXPORT_CODE, ATOM_MAPS_NOT_KEPT_OPEN_CODE, atomMapStereoLossMessage, atomMapsNotKeptOpenWarnings,
  molfileAtomMapNumbers, moleculeSourceHasAtomMaps, pushAtomMapsDroppedWarning, smilesAtomMapNumbers,
  smilesStereoElementCounts, stripSmilesAtomMaps
} from "./atomMaps";

const fixture = readFileSync(new URL("../../fixtures/open-double-bonds/atom-mapped.chemdraft", import.meta.url), "utf8");

const v2000 = (title: string, maps: readonly number[], options: { leading?: string; version?: string } = {}) => [
  ...(options.leading !== undefined ? [options.leading] : []),
  title, "  ChemDraft", "",
  `  ${maps.length}  0  0  0  0  0  0  0  0  0999${options.version ?? " V2000"}`,
  ...maps.map((map, index) =>
    `${(index * 1.5).toFixed(4).padStart(10)}    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0${String(map).padStart(3)}  0  0`),
  "M  END"
].join("\n");

describe("stripSmilesAtomMaps", () => {
  it.each([
    ["[CH3:1]/[CH:2]=[CH:3]/[CH3:4]", "[CH3]/[CH]=[CH]/[CH3]", 4],
    ["[CH3:1][C:2](=[O:3])[OH:4]", "[CH3][C](=[O])[OH]", 4],
    ["[13CH3:1][C@@H:2]([NH3+:3])C(=O)[O-:12]", "[13CH3][C@@H]([NH3+])C(=O)[O-]", 4],
    ["[CH2:1]1CC[CH2:2]C1.[Na+:7]", "[CH2]1CC[CH2]C1.[Na+]", 3],
    ["[C@TH1H:5](F)(Cl)Br", "[C@TH1H](F)(Cl)Br", 1],
    ["c1cc:c([OH:9])cc1", "c1cc:c([OH])cc1", 1]
  ])("removes only the classes from %s", (input, expected, removed) => {
    expect(stripSmilesAtomMaps(input)).toEqual({ smiles: expected, removed });
  });

  it("removes a class 0 without counting it as a map", () => {
    expect(stripSmilesAtomMaps("[CH3:0]O")).toEqual({ smiles: "[CH3]O", removed: 0 });
    expect(smilesAtomMapNumbers("[CH3:0]O")).toEqual([]);
  });

  it.each(["CC=CC", "C/C=C/C", "[13CH3]O", "[NH4+].[Cl-]", "c1ccccc1:c", " CCO ethanol ", "C%12CC%12"])(
    "returns unmapped input as the identical string: %j", input => {
      const result = stripSmilesAtomMaps(input);
      expect(result.smiles).toBe(input);
      expect(result.removed).toBe(0);
    });

  it("leaves a name after the SMILES token untouched", () => {
    expect(stripSmilesAtomMaps("[CH3:1]O note[x:2]")).toEqual({ smiles: "[CH3]O note[x:2]", removed: 1 });
  });
});

describe("molfileAtomMapNumbers", () => {
  it("reads the V2000 map column of the atom-mapped fixture", () => {
    const molecule = deserializeDocument(fixture).pages[0]!.objects[0] as MoleculeObject;
    expect(molfileAtomMapNumbers(molecule.structure)).toEqual([1, 2, 3, 4]);
    expect(moleculeSourceHasAtomMaps(molecule)).toBe(true);
  });

  it("never reads the header as structure", () => {
    expect(molfileAtomMapNumbers(v2000("V2000 export of [OH:2]", [0, 0]))).toEqual([]);
    expect(molfileAtomMapNumbers(v2000("  2  0  0  0  0  0  0  0  0  0999 V2000", [0, 0]))).toEqual([]);
    expect(molfileAtomMapNumbers(v2000("[OH:2] V2000", [3, 0]))).toEqual([3]);
  });

  it("allows a leading blank line and a versionless counts line", () => {
    expect(molfileAtomMapNumbers(v2000("title", [1, 2], { leading: "" }))).toEqual([1, 2]);
    expect(molfileAtomMapNumbers(v2000("", [1, 2], { leading: "" }))).toEqual([1, 2]);
    expect(molfileAtomMapNumbers(v2000("title", [1, 0, 5], { version: "" }))).toEqual([1, 5]);
    expect(molfileAtomMapNumbers(v2000("title", [0, 0], { version: "" }))).toEqual([]);
  });

  it("ignores class 0 and ChemDraft's own R-group numbers", () => {
    const rgroup = v2000("", [2, 0]).replace("C   0  0  0  0  0  0  0  0  0  2", "R#  0  0  0  0  0  0  0  0  0  2");
    expect(molfileAtomMapNumbers(rgroup)).toEqual([]);
  });

  it("reads V3000 positional and AAMAP= maps inside the atom block only", () => {
    const v3000 = (atoms: string[]) => ["[OH:2] AAMAP=7", "  ChemDraft", "", "  0  0  0     0  0            999 V3000",
      "M  V30 BEGIN CTAB", `M  V30 COUNTS ${atoms.length} 0 0 0 0`, "M  V30 BEGIN ATOM", ...atoms,
      "M  V30 END ATOM", "M  V30 END CTAB", "M  END"].join("\n");
    expect(molfileAtomMapNumbers(v3000(["M  V30 1 C 0 0 0 0", "M  V30 2 O 1.5 0 0 0 CHG=-1"]))).toEqual([]);
    expect(molfileAtomMapNumbers(v3000(["M  V30 1 C 0 0 0 4", "M  V30 2 O 1.5 0 0 0"]))).toEqual([4]);
    expect(molfileAtomMapNumbers(v3000(["M  V30 1 C 0 0 0 -", "M  V30 6", "M  V30 2 R# 1.5 0 0 2 RGROUPS=(1 2)"]))).toEqual([6]);
    expect(molfileAtomMapNumbers(v3000(["M  V30 1 C 0 0 0 0 AAMAP=3"]))).toEqual([3]);
  });

  it("does not read SMILES maps from a molfile or molfile columns from a SMILES", () => {
    expect(moleculeSourceHasAtomMaps({ structureFormat: "molfile-v2000", structure: v2000("[CH3:1]", [0]) })).toBe(false);
    expect(moleculeSourceHasAtomMaps({ structureFormat: "smiles", structure: "[CH3:1]O" })).toBe(true);
    expect(moleculeSourceHasAtomMaps({ structureFormat: "smiles", structure: "[CH3:0]O" })).toBe(false);
    expect(moleculeSourceHasAtomMaps({ structureFormat: "unknown", structure: "[CH3:1]O" })).toBe(false);
  });
});

describe("open and export warnings", () => {
  it("adds one open warning for a document with mapped sources", () => {
    const document = deserializeDocument(fixture);
    expect(atomMapsNotKeptOpenWarnings(document)).toEqual([{
      code: ATOM_MAPS_NOT_KEPT_OPEN_CODE,
      message: "ChemDraft document: 1 structure stores atom-map numbers. ChemDraft does not keep atom maps yet; " +
        "they will be dropped on export or when the structure is edited."
    }]);
  });

  it("adds one export warning per mapped molecule", () => {
    const molecule = deserializeDocument(fixture).pages[0]!.objects[0] as MoleculeObject;
    const warnings: Parameters<typeof pushAtomMapsDroppedWarning>[0] = [];
    pushAtomMapsDroppedWarning(warnings, molecule, "SDF");
    pushAtomMapsDroppedWarning(warnings, molecule, "SMILES");
    expect(warnings).toEqual([expect.objectContaining({ code: ATOM_MAPS_DROPPED_EXPORT_CODE, objectId: molecule.id, severity: "warning" })]);
    pushAtomMapsDroppedWarning(warnings, { ...molecule, id: "other", structure: v2000("", [0, 0]) }, "SDF");
    expect(warnings).toHaveLength(1);
  });
});

describe("stereo lost with the maps", () => {
  it("counts tetrahedral tags and stereo double bonds", () => {
    expect(smilesStereoElementCounts("F[C@:2](Cl)([CH3:1])[CH3:3]")).toEqual({ tetrahedral: 1, doubleBonds: 0 });
    expect(smilesStereoElementCounts("C/C=C/C")).toEqual({ tetrahedral: 0, doubleBonds: 1 });
    expect(smilesStereoElementCounts("C/C(=C(\\F)[CH3:1])[CH3:2]")).toEqual({ tetrahedral: 0, doubleBonds: 1 });
    expect(smilesStereoElementCounts("C/C=C\\C=C")).toEqual({ tetrahedral: 0, doubleBonds: 1 });
    expect(smilesStereoElementCounts("C/1=C/CCCCCC1")).toEqual({ tetrahedral: 0, doubleBonds: 1 });
    expect(smilesStereoElementCounts("CC(C)(F)Cl")).toEqual({ tetrahedral: 0, doubleBonds: 0 });
  });

  it("names the stereo the maps alone made specifiable", () => {
    expect(atomMapStereoLossMessage("F[C@:2](Cl)([CH3:1])[CH3:3]", "CC(C)(F)Cl")).toBe(
      "Without atom-map numbers, 1 stereocenter in the pasted SMILES is no longer stereogenic and was drawn without stereo");
    expect(atomMapStereoLossMessage("C/C(=C(\\F)[CH3:1])[CH3:2]", "CC(C)=C(C)F")).toBe(
      "Without atom-map numbers, 1 double-bond E/Z assignment in the pasted SMILES is no longer stereogenic and was drawn without stereo");
    expect(atomMapStereoLossMessage("[CH3:1]/[CH:2]=[CH:3]/[CH3:4]", "C/C=C/C")).toBeUndefined();
    expect(atomMapStereoLossMessage("O[C@@H:2](F)[13CH3:1]", "[13CH3][C@H](O)F")).toBeUndefined();
  });
});
