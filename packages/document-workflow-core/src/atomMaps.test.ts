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
    // ChemDraft's writer (chem-core molfile.ts) always pairs an R# atom with its M  RGP entry.
    const rgroup = v2000("", [2, 0]).replace("C   0  0  0  0  0  0  0  0  0  2", "R#  0  0  0  0  0  0  0  0  0  2")
      .replace("M  END", "M  RGP  1   1   2\nM  END");
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

describe("review findings (1.2.3)", () => {
  const atomLine = (xyz: string, symbol: string, map: number) =>
    `${xyz} ${symbol.padEnd(3)} 0  0  0  0  0  0  0  0  0${String(map).padStart(3)}  0  0`;
  const coordinates = (x: number) => `${x.toFixed(4).padStart(10)}    0.0000    0.0000`;
  const molfile = (header: readonly string[], counts: string, atoms: readonly string[], rest: readonly string[] = []) =>
    [...header, counts, ...atoms, ...rest, "M  END"].join("\n");

  it("removes a class 0 so callers can see the text changed, without counting it", () => {
    for (const input of ["[CH3:0][C@](C)(F)Cl", "[CH3:0]/C(C)=C/F"]) {
      const result = stripSmilesAtomMaps(input);
      expect(result.removed).toBe(0);
      expect(result.smiles).not.toBe(input);
      expect(result.smiles).toBe(input.replace(":0", ""));
    }
  });

  it("reads V2000 atom lines by column when the coordinate fields touch", () => {
    const touching = molfile(["title", "  Other", ""], "  2  1  0  0  0  0  0  0  0  0999 V2000", [
      atomLine("12345.6789-1234.5678-9999.9999", "C", 3),
      atomLine("-1234.5678    0.0000    0.0000", "O", 0)
    ], ["  1  2  1  0"]);
    expect(touching.split("\n")[4]!.slice(0, 30)).toBe("12345.6789-1234.5678-9999.9999");
    expect(touching.split("\n")[4]!.slice(60, 63)).toBe("  3");
    expect(molfileAtomMapNumbers(touching)).toEqual([3]);
  });

  it.each([
    ["unpadded, separate fields", "2 1 0 0 0 0 0 0 0 0999"],
    ["unpadded, no tag, six fields", "2 1 0 0 0 0"],
    ["fixed width, no tag", "  2  1  0  0  0  0  0  0  0  0999"]
  ])("accepts the clipboard reader's versionless counts form: %s", (_name, counts) => {
    const text = molfile(["title", "  Other", ""], counts, [atomLine(coordinates(0), "C", 4), atomLine(coordinates(1.5), "O", 0)],
      ["  1  2  1  0  0  0  0"]);
    expect(molfileAtomMapNumbers(text)).toEqual([4]);
  });

  it("never lets a counts-shaped header comment win over the real counts line", () => {
    for (const comment of ["  0  0  0  0  0  0  0  0  0  0999 V2000", "  0  0  0  0  0  0", "  1  0  0  0  0  0  0  0  0  0999 V2000"]) {
      const text = molfile(["", "title", "  Other", comment], "  2  0  0  0  0  0  0  0  0  0999 V2000",
        [atomLine(coordinates(0), "C", 1), atomLine(coordinates(1.5), "C", 2)]);
      expect(molfileAtomMapNumbers(text)).toEqual([1, 2]);
    }
  });

  it("reads a one-line RXN block header, as the clipboard reader does", () => {
    const block = ["  ChemDraw06022615382D", "  2  1  0  0  0  0            999 V2000",
      atomLine(coordinates(0), "C", 1), atomLine(coordinates(1.56), "O", 2), "  1  2  1  0        0", "M  END"].join("\n");
    expect(molfileAtomMapNumbers(block)).toEqual([1, 2]);
  });

  it("counts a map on an external R-group pseudo-atom", () => {
    // RDKit reads this as [2*:7]: R-group 2, atom map 7.
    const external = molfile(["", "  Other", ""], "  2  0  0  0  0  0  0  0  0  0999 V2000",
      [atomLine(coordinates(0), "R#", 7), atomLine(coordinates(1.5), "C", 0)], ["M  RGP  1   1   2"]);
    expect(molfileAtomMapNumbers(external)).toEqual([7]);
    // ChemDraft's own program line does not excuse a map that differs from the R-group number.
    expect(molfileAtomMapNumbers(external.replace("  Other", "  ChemDraft"))).toEqual([7]);
    // Another writer's R# whose map equals its R-group number is still a map.
    expect(molfileAtomMapNumbers(external.replace("M  RGP  1   1   2", "M  RGP  1   1   7"))).toEqual([7]);
    // ChemDraft's own encoding: R# with its own number, or a dummy * whose drawn atom is R<map>.
    const own = external.replace("  Other", "  ChemDraft").replace("M  RGP  1   1   2", "M  RGP  1   1   7");
    expect(molfileAtomMapNumbers(own)).toEqual([]);
    const ownStar = own.replace("R# ", "*  ").replace("M  RGP  1   1   7\n", "");
    // A bare * with nothing tying it to a drawn R7 is a map (1.2.3 re-review, finding 3).
    expect(molfileAtomMapNumbers(ownStar)).toEqual([7]);
    expect(molfileAtomMapNumbers(ownStar, [{ element: "R7", neighbours: [] }, { element: "C", neighbours: [] }])).toEqual([]);
    expect(molfileAtomMapNumbers(external.replace("R# ", "*  ").replace("M  RGP  1   1   2\n", ""))).toEqual([7]);
  });

  it("counts AAMAP= and other writers' maps on a V3000 R-group atom, and AAMAP= split over a continuation line", () => {
    const v3000 = (program: string, atoms: string[]) => ["", program, "", "  0  0  0     0  0            999 V3000",
      "M  V30 BEGIN CTAB", `M  V30 COUNTS ${atoms.length} 0 0 0 0`, "M  V30 BEGIN ATOM", ...atoms,
      "M  V30 END ATOM", "M  V30 END CTAB", "M  END"].join("\n");
    expect(molfileAtomMapNumbers(v3000("  ChemDraft", ["M  V30 1 R# 0 0 0 0 RGROUPS=(1 2) AAMAP=5"]))).toEqual([5]);
    expect(molfileAtomMapNumbers(v3000("  ChemDraft", ["M  V30 1 R# 0 0 0 5 RGROUPS=(1 2)"]))).toEqual([5]);
    expect(molfileAtomMapNumbers(v3000("  Other", ["M  V30 1 R# 0 0 0 2 RGROUPS=(1 2)"]))).toEqual([2]);
    expect(molfileAtomMapNumbers(v3000("  ChemDraft", ["M  V30 1 R# 0 0 0 2 RGROUPS=(1 2)"]))).toEqual([]);
    expect(molfileAtomMapNumbers(v3000("  Other", ["M  V30 1 C 0 0 0 0 CHG=1 -", "M  V30 AAMAP=8"]))).toEqual([8]);
    expect(molfileAtomMapNumbers(v3000("  Other", ["M  V30 1 C 0 0 0 0 AA-", "M  V30 MAP=9"]))).toEqual([9]);
  });

  it("reads mapped SMILES kept only as the source SMILES of a molfile structure", () => {
    const molecule = { structureFormat: "molfile-v2000" as const, structure: v2000("", [0, 0]) };
    expect(moleculeSourceHasAtomMaps(molecule)).toBe(false);
    expect(moleculeSourceHasAtomMaps({ ...molecule, compatibility: { sourceFormat: "smiles", warnings: [], unknown: { smiles: "[CH3:1]O" } } })).toBe(true);
    expect(moleculeSourceHasAtomMaps({ ...molecule, compatibility: { sourceFormat: "smiles", warnings: [], unknown: { smiles: "[CH3:0]O" } } })).toBe(false);
    expect(moleculeSourceHasAtomMaps({ ...molecule, compatibility: { sourceFormat: "smiles", warnings: [], unknown: { smiles: "CO" } } })).toBe(false);
  });

  it("reads ChemDraft's own [*:n] spelling of a drawn Rn label as that label, not a map", () => {
    const atom = (element: string, id = element) => ({ id, element, x: 0, y: 0, formalCharge: 0 });
    const bond = (from: string, to: string) => ({ id: `${from}-${to}`, fromAtomId: from, toAtomId: to, order: "single" as const });
    // The drawn R2 is bonded to a carbon, as the [*:2] is: the same atom.
    expect(moleculeSourceHasAtomMaps({ structureFormat: "smiles", structure: "[*:2]CC",
      atoms: [atom("R2"), atom("C", "c1"), atom("C", "c2")], bonds: [bond("R2", "c1"), bond("c1", "c2")] })).toBe(false);
    expect(moleculeSourceHasAtomMaps({ structureFormat: "smiles", structure: "[*+:2]CC",
      atoms: [atom("R2"), atom("C")], bonds: [bond("R2", "C")] })).toBe(false);
    expect(moleculeSourceHasAtomMaps({ structureFormat: "smiles", structure: "[*:2]CC", atoms: [atom("R3")] })).toBe(true);
    expect(moleculeSourceHasAtomMaps({ structureFormat: "smiles", structure: "[*:2]C[*:2]", atoms: [atom("R2")] })).toBe(true);
    expect(moleculeSourceHasAtomMaps({ structureFormat: "smiles", structure: "[CH3:2]C", atoms: [atom("R2")] })).toBe(true);
    expect(moleculeSourceHasAtomMaps({ structureFormat: "smiles", structure: "[*:2]CC" })).toBe(true);
  });

  it("writes the V2000 map column the detector reads (CTAB column 61-63)", () => {
    const text = v2000("t", [1, 0, 12]);
    expect(text.split("\n").slice(4, 7).map(line => line.slice(60, 63))).toEqual(["  1", "  0", " 12"]);
    expect(molfileAtomMapNumbers(text)).toEqual([1, 12]);
  });
});

describe("re-review findings (1.2.3)", () => {
  const atomLine = (x: number, symbol: string, map: number) =>
    `${x.toFixed(4).padStart(10)}    0.0000    0.0000 ${symbol.padEnd(3)} 0  0  0  0  0  0  0  0  0${String(map).padStart(3)}  0  0`;
  const v3000 = (counts: string, atoms: readonly string[], options: { program?: string; gap?: boolean } = {}) =>
    ["", options.program ?? "  Other", "", counts, ...(options.gap ? [""] : []), "M  V30 BEGIN CTAB",
      `M  V30 COUNTS ${atoms.length} 0 0 0 0`, "M  V30 BEGIN ATOM", ...atoms, "M  V30 END ATOM", "M  V30 END CTAB", "M  END"].join("\n");
  const standardV3000Counts = "  0  0  0     0  0            999 V3000";

  it("reads unpadded counts of 100 atoms and 100 bonds as 100 and 100, not 100 and 10 (finding 1)", () => {
    const atoms = Array.from({ length: 100 }, (_, index) => atomLine(index * 1.5, "C", index === 50 ? 7 : 0));
    const bonds = Array.from({ length: 100 }, (_, index) => `${String(index + 1).padStart(3)}${String(index === 99 ? 1 : index + 2).padStart(3)}  1  0`);
    const text = ["", "  Other", "", "100 100  0  0  0  0", ...atoms, ...bonds, "M  END"].join("\n");
    expect(molfileAtomMapNumbers(text)).toEqual([7]);
    // The fixed-width form of the same counts still reads.
    expect(molfileAtomMapNumbers(text.replace("100 100  0  0  0  0", "100100  0  0  0  0  0  0  0  0999 V2000"))).toEqual([7]);
  });

  it("reads past a zero-count comment line shaped like a counts line (finding 1)", () => {
    const text = ["title", "  Other", "  0  0  0  0  0  0  0  0  0  0999 V2000", "  2  1  0  0  0  0  0  0  0  0999 V2000",
      atomLine(0, "C", 4), atomLine(1.5, "O", 0), "  1  2  1  0", "M  END"].join("\n");
    expect(molfileAtomMapNumbers(text)).toEqual([4]);
  });

  it("still reports maps when no counts reading is followed by a complete table", () => {
    // Bond lines this detector does not recognise: the atom lines alone still say there are maps.
    const text = ["", "  Other", "", "  2  1  0  0  0  0  0  0  0  0999 V2000", atomLine(0, "C", 4), atomLine(1.5, "O", 0),
      "bond?", "M  END"].join("\n");
    expect(molfileAtomMapNumbers(text)).toEqual([4]);
  });

  it("reads V3000 with a blank line before the block or a short counts line, as the clipboard reader does (finding 2)", () => {
    expect(molfileAtomMapNumbers(v3000(standardV3000Counts, ["M  V30 1 C 0 0 0 3"], { gap: true }))).toEqual([3]);
    expect(molfileAtomMapNumbers(v3000("0 0 V3000", ["M  V30 1 C 0 0 0 3"]))).toEqual([3]);
    expect(molfileAtomMapNumbers(v3000("0 0 V3000", ["M  V30 1 C 0 0 0 3"], { gap: true }))).toEqual([3]);
    expect(molfileAtomMapNumbers(v3000("0 0 V3000", ["M  V30 1 C 0 0 0 0"], { gap: true }))).toEqual([]);
  });

  it("reads AAMAP with spaces around '=' and never lets AAMAP=0 hide a positional map (finding 2)", () => {
    expect(molfileAtomMapNumbers(v3000(standardV3000Counts, ["M  V30 1 C 0 0 0 0 AAMAP = 7"]))).toEqual([7]);
    expect(molfileAtomMapNumbers(v3000(standardV3000Counts, ["M  V30 1 C 0 0 0 0 AAMAP =7"]))).toEqual([7]);
    expect(molfileAtomMapNumbers(v3000(standardV3000Counts, ["M  V30 1 C 0 0 0 5 AAMAP=0"]))).toEqual([5]);
    // RDKit keeps the positional map when both are nonzero.
    expect(molfileAtomMapNumbers(v3000(standardV3000Counts, ["M  V30 1 C 0 0 0 5 AAMAP=7"]))).toEqual([5]);
    expect(molfileAtomMapNumbers(v3000(standardV3000Counts, ["M  V30 1 C 0 0 0 0 AAMAP=0"]))).toEqual([]);
  });

  it("ties ChemDraft's own R-group spelling to the very atom it labels (finding 3)", () => {
    const atom = (element: string, id = element) => ({ id, element, x: 0, y: 0, formalCharge: 0 });
    const bond = (from: string, to: string) => ({ id: `${from}-${to}`, fromAtomId: from, toAtomId: to, order: "single" as const });
    // Drawn R2-O-C; the SMILES has an external [*:2] on a carbon instead: a map, not the drawn R2.
    const drawn = { atoms: [atom("R2"), atom("O"), atom("C")], bonds: [bond("R2", "O"), bond("O", "C")] };
    expect(moleculeSourceHasAtomMaps({ structureFormat: "smiles", structure: "[*:2]CO", ...drawn })).toBe(true);
    expect(moleculeSourceHasAtomMaps({ structureFormat: "smiles", structure: "[*:2]OC", ...drawn })).toBe(false);
    expect(moleculeSourceHasAtomMaps({ structureFormat: "smiles", structure: "CO[*:2]", ...drawn })).toBe(false);
    expect(smilesAtomMapNumbers("[*:2]CO", [{ element: "R2", neighbours: ["O"] }])).toEqual([2]);
    // The same in the source SMILES kept beside a molfile structure.
    const molfile = { structureFormat: "molfile-v2000" as const, structure: v2000("", [0, 0, 0]), ...drawn };
    expect(moleculeSourceHasAtomMaps({ ...molfile, compatibility: { sourceFormat: "smiles", warnings: [], unknown: { smiles: "[*:2]CO" } } })).toBe(true);
    expect(moleculeSourceHasAtomMaps({ ...molfile, compatibility: { sourceFormat: "smiles", warnings: [], unknown: { smiles: "[*:2]OC" } } })).toBe(false);
    // Molfile: a ChemDraft * with a map is the drawn Rn only when the drawn atom at that position is Rn.
    const star = ["", "  ChemDraft", "", "  3  2  0  0  0  0  0  0  0  0999 V2000",
      atomLine(0, "*", 2), atomLine(1.5, "O", 0), atomLine(3, "C", 0), "  1  2  1  0", "  2  3  1  0", "M  END"].join("\n");
    expect(moleculeSourceHasAtomMaps({ structureFormat: "molfile-v2000", structure: star, ...drawn })).toBe(false);
    expect(moleculeSourceHasAtomMaps({ structureFormat: "molfile-v2000", structure: star,
      atoms: [atom("C"), atom("O"), atom("R2")], bonds: [bond("C", "O"), bond("O", "R2")] })).toBe(true);
    expect(moleculeSourceHasAtomMaps({ structureFormat: "molfile-v2000", structure: star })).toBe(true);
    const starV3000 = v3000(standardV3000Counts, ["M  V30 1 * 0 0 0 2", "M  V30 2 O 1.5 0 0 0", "M  V30 3 C 3 0 0 0"], { program: "  ChemDraft" });
    expect(molfileAtomMapNumbers(starV3000)).toEqual([2]);
    expect(molfileAtomMapNumbers(starV3000, [{ element: "R2", neighbours: ["O"] }])).toEqual([]);
    expect(molfileAtomMapNumbers(starV3000.replace("  ChemDraft", "  Other"), [{ element: "R2", neighbours: ["O"] }])).toEqual([2]);
  });
});
