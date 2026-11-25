/**
 * The atom-map detector (document-workflow-core atomMaps.ts) against RDKit's own reading of the
 * same text: for every tricky fixture RDKit reads, the detector finds exactly the maps RDKit finds.
 * (ChemDraft's own R-group spelling is a deliberate exception, tested in atomMaps.test.ts; fixtures
 * RDKit refuses but the clipboard reader reads, such as unpadded counts fields, a short or detached
 * V3000 counts line and "AAMAP = 7", are tested there too.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { molfileAtomMapNumbers, smilesAtomMapNumbers } from "@chemdraft/document-workflow-core";
import { ensureRdkit, resetRdkitForTesting } from "@chemdraft/rdkit-adapter";
import { installRealRdkitModuleLoader } from "@chemdraft/rdkit-adapter/testing";

beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

const atomLine = (xyz: string, symbol: string, map: number) =>
  `${xyz} ${symbol.padEnd(3)} 0  0  0  0  0  0  0  0  0${String(map).padStart(3)}  0  0`;
const at = (x: number) => `${x.toFixed(4).padStart(10)}    0.0000    0.0000`;
const v2000 = (header: readonly string[], counts: string, atoms: readonly string[], rest: readonly string[] = []) =>
  [...header, counts, ...atoms, ...rest, "M  END"].join("\n");
const v3000 = (atoms: readonly string[], bonds: readonly string[] = []) => ["", "  Other", "",
  "  0  0  0     0  0            999 V3000", "M  V30 BEGIN CTAB", `M  V30 COUNTS ${atoms.filter((_, index) => !atoms[index - 1]?.endsWith("-")).length} ${bonds.length} 0 0 0`,
  "M  V30 BEGIN ATOM", ...atoms, "M  V30 END ATOM",
  ...(bonds.length ? ["M  V30 BEGIN BOND", ...bonds, "M  V30 END BOND"] : []), "M  V30 END CTAB", "M  END"].join("\n");
const header = ["", "  Other", ""];
const ethanol = (counts: string, maps: readonly [number, number]) =>
  v2000(header, counts, [atomLine(at(0), "C", maps[0]), atomLine(at(1.5), "O", maps[1])], ["  1  2  1  0  0  0  0"]);

const molfiles: [string, string][] = [
  ["standard fixed width", ethanol("  2  1  0  0  0  0  0  0  0  0999 V2000", [1, 12])],
  ["fixed width, no tag", ethanol("  2  1  0  0  0  0  0  0  0  0999", [0, 4])],
  ["unmapped", ethanol("  2  1  0  0  0  0  0  0  0  0999 V2000", [0, 0])],
  ["touching coordinate fields", v2000(header, "  2  1  0  0  0  0  0  0  0  0999 V2000",
    [atomLine("12345.6789-1234.5678-9999.9999", "C", 3), atomLine("-1234.5678    0.0000    0.0000", "O", 0)], ["  1  2  1  0"])],
  ["zero-count comment line shaped like a counts line", v2000(["title", "  Other", "  0  0  0  0  0  0  0  0  0  0999 V2000"],
    "  2  1  0  0  0  0  0  0  0  0999 V2000", [atomLine(at(0), "C", 4), atomLine(at(1.5), "O", 0)], ["  1  2  1  0"])],
  ["header title that mentions a map", v2000(["[OH:2] AAMAP=7", "  Other", ""], "  2  1  0  0  0  0  0  0  0  0999 V2000",
    [atomLine(at(0), "C", 0), atomLine(at(1.5), "O", 0)], ["  1  2  1  0"])],
  ["external R# with a map", v2000(header, "  2  1  0  0  0  0  0  0  0  0999 V2000",
    [atomLine(at(0), "R#", 7), atomLine(at(1.5), "C", 0)], ["  1  2  1  0", "M  RGP  1   1   2"])],
  ["R# whose map equals its R-group number, another writer", v2000(header, "  2  1  0  0  0  0  0  0  0  0999 V2000",
    [atomLine(at(0), "R#", 2), atomLine(at(1.5), "C", 0)], ["  1  2  1  0", "M  RGP  1   1   2"])],
  ["V3000 positional", v3000(["M  V30 1 C 0 0 0 4", "M  V30 2 O 1.5 0 0 0"], ["M  V30 1 1 1 2"])],
  ["V3000 AAMAP=0 beside a positional map", v3000(["M  V30 1 C 0 0 0 5 AAMAP=0", "M  V30 2 O 1.5 0 0 0"], ["M  V30 1 1 1 2"])],
  ["V3000 positional and AAMAP= both nonzero", v3000(["M  V30 1 C 0 0 0 5 AAMAP=7", "M  V30 2 O 1.5 0 0 0"], ["M  V30 1 1 1 2"])],
  ["V3000 positional split over a continuation line", v3000(["M  V30 1 C 0 0 0 -", "M  V30 6", "M  V30 2 O 1.5 0 0 0"], ["M  V30 1 1 1 2"])],
  // 1.2.3 third review.
  ["V2000 with a bare \"M  V30\" header comment", ethanol("  2  1  0  0  0  0  0  0  0  0999 V2000", [7, 0]).replace(/^\n  Other\n/, "\n  Other\nM  V30")],
  ["V2000 whose title is \"M  V30\"", `M  V30${ethanol("  2  1  0  0  0  0  0  0  0  0999 V2000", [7, 0])}`],
  ["V3000 positional with a plus sign", v3000(["M  V30 1 C 0 0 0 +5", "M  V30 2 O 1.5 0 0 0"], ["M  V30 1 1 1 2"])],
  ["V3000 positional with leading zeros", v3000(["M  V30 1 C 0 0 0 007", "M  V30 2 O 1.5 0 0 0"], ["M  V30 1 1 1 2"])],
  ["V3000 negative positional", v3000(["M  V30 1 C 0 0 0 -5", "M  V30 2 O 1.5 0 0 0"], ["M  V30 1 1 1 2"])],
  ["V3000 atom records out of ID order", v3000(["M  V30 2 O 1.5 0 0 0", "M  V30 1 * 0 0 0 1"], ["M  V30 1 1 1 2"])],
  // 1.2.3 fourth review.
  ["V2000 alkene whose header lines spell a V3000 atom block", v2000(["M  V30 BEGIN ATOM", "M  V30 1 C 0 0 0 +5", "M  V30 END ATOM"],
    "  4  3  0  0  0  0  0  0  0  0999 V2000", [0, 1, 2, 3].map(index => atomLine(at(index * 1.5), "C", 0)),
    ["  1  2  1  0", "  2  3  2  0", "  3  4  1  0"])],
  ["V3000 whose header lines spell a V2000 connection table", v3000(["M  V30 1 C 0 0 0 0"]).replace(/^\n {2}Other\n\n/,
    "  1  0  0  0  0  0  0  0  0  0999 V2000\n    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  5  0  0\nM  END\n")],
  ["V3000 continuation whose next line starts with the separator", v3000(["M  V30 1 C 0 0 0-", "M  V30  +1", "M  V30 2 O 1.5 0 0 0"], ["M  V30 1 1 1 2"])]
];

/**
 * Fixtures read with their drawing: ChemDraft's R-group exception applies only to its own output
 * (blank title and comment, "  ChemDraft", an unsigned R number), so here too the detector finds
 * exactly the maps RDKit finds.
 */
const drawnR1 = [{ element: "R1", neighbours: ["O"] }, { element: "O", neighbours: ["*"] }];
const ownV3000 = (header: readonly string[], value: string) => [...header, "  0  0  0     0  0            999 V3000",
  "M  V30 BEGIN CTAB", "M  V30 COUNTS 2 1 0 0 0", "M  V30 BEGIN ATOM", `M  V30 1 * 0 0 0 ${value}`, "M  V30 2 O 1.5 0 0 0",
  "M  V30 END ATOM", "M  V30 BEGIN BOND", "M  V30 1 1 1 2", "M  V30 END BOND", "M  V30 END CTAB", "M  END"].join("\n");
const molfilesWithDrawing: [string, string][] = [
  ["V3000 with a bare \"M  V30\" title over ChemDraft's program line", ownV3000(["M  V30", "  ChemDraft", ""], "1")],
  ["V3000 R-group number with a sign, ChemDraft's header", ownV3000(["", "  ChemDraft", ""], "+1")]
];

const smiles = [
  "[CH3:1]/[CH:2]=[CH:3]/[CH3:4]", "[CH3:0]O", "[2*:7]C", "[*:2]CC", "c1cc:c([OH:9])cc1", "[13CH3:1][C@@H:2]([NH3+:3])C(=O)[O-:12]",
  "CCO", "[CH2:1]1CC[CH2:2]C1.[Na+:7]", "*CCOCCC[*:1]", "[*:1]CC[*:1]"
];

/** RDKit's atom-map numbers: the classes of its own SMILES output (it writes every nonzero map). */
async function rdkitMaps(text: string): Promise<number[]> {
  const rdkit = await ensureRdkit();
  // MinimalLib returns null for text it cannot read.
  const molecule = rdkit.get_mol(text) as { get_smiles(): string; delete(): void } | null;
  try {
    expect(molecule, `RDKit reads ${JSON.stringify(text)}`).not.toBeNull();
    return [...molecule!.get_smiles().matchAll(/\[[^\]]*:(\d+)\]/g)].map(match => Number(match[1])).filter(map => map > 0);
  } finally {
    molecule?.delete();
  }
}

const sorted = (values: readonly number[]) => [...values].sort((a, b) => a - b);

describe("atom-map detector agrees with RDKit", () => {
  it.each(molfiles)("molfile: %s", async (_name, text) => {
    expect(sorted(molfileAtomMapNumbers(text))).toEqual(sorted(await rdkitMaps(text)));
  });

  it.each(molfilesWithDrawing)("molfile with its drawing: %s", async (_name, text) => {
    expect(sorted(molfileAtomMapNumbers(text, drawnR1))).toEqual(sorted(await rdkitMaps(text)));
  });

  it.each(smiles)("SMILES: %s", async text => {
    expect(sorted(smilesAtomMapNumbers(text))).toEqual(sorted(await rdkitMaps(text)));
  });
});
