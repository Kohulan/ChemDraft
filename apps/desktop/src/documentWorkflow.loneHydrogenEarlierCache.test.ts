import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  admitParsedDocument, applyPatch, createEmptyDocument, serializeDocument,
  type BracketObject, type ChemDraftDocument, type DocumentObject, type MoleculeAtom, type MoleculeBond, type MoleculeObject
} from "@chemdraft/chem-core";
import { nativeSingleBondGraphMetadata } from "@chemdraft/document-workflow-core";
import { ensureRdkit } from "@chemdraft/rdkit-adapter";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { buildDocumentSessionEnvelope, parseDocumentSessionEnvelope } from "./documentSession";
import * as workflow from "./documentWorkflow";
import { restoreSessionWarningReports } from "./openWarnings";

// A lone H, D or T is one hydrogen atom, a radical (H•; owner decision 2026-11-23). A document saved
// before that caches an earlier reading of it. The refresh replaces a stored cache only when it is
// ChemDraft's own output for the drawing under such a reading, field for field (nothing stored is
// parsed); any other stored cache is kept exactly as saved, and the user is told (AGENTS.md section 7).
// The stale records below are literal: what the native writer stored under the H2 reading
// (863c8f229, "[HH]" with one hydrogen counted in the formula and masses, no radical).

beforeAll(() => {
  installNodeRdkitModuleLoader();
});

const atom = (id: string, element: string, x: number, y = 0): MoleculeAtom => ({ id, element, x, y, formalCharge: 0 });
const bond = (id: string, fromAtomId: string, toAtomId: string, order: MoleculeBond["order"] = "single",
  display?: MoleculeBond["display"]): MoleculeBond => ({ id, fromAtomId, toAtomId, order, ...(display ? { display } : {}) });
const documentOf = (objects: DocumentObject[]): ChemDraftDocument => {
  const base = createEmptyDocument();
  return { ...base, pages: [{ ...base.pages[0]!, objects }] };
};
/** File > Open: read, then the commit MainWindow's `resetDocumentHistory` makes. */
const openRead = (objects: DocumentObject[]) => workflow.openNativeDocument(serializeDocument(documentOf(objects)));
/** Autosave's session envelope for `objects`, with any saved report metadata, parsed as MainWindow's restore does. */
const restoredSession = (objects: DocumentObject[], metadata: object = {}) => {
  const payload = workflow.createNativeSavePayload(admitParsedDocument(documentOf(objects)));
  const envelope = buildDocumentSessionEnvelope(payload, { dirty: true }, "Untitled", false);
  return parseDocumentSessionEnvelope(JSON.parse(JSON.stringify({ ...envelope, ...metadata })) as unknown, true)!;
};
/** Session restore: autosave's envelope, parsed and read as MainWindow's restore does. */
const restoreRead = (objects: DocumentObject[]) => workflow.openNativeDocument(restoredSession(objects).contents);
const committed = (read: ReturnType<typeof workflow.openNativeDocument> | ChemDraftDocument) =>
  workflow.normalizeCommittedDocument(admitParsedDocument("source" in read ? read.document! : read), { preserveElectronMarks: true });
/** A native ChemDraft clipboard paste of `objects`, copied from a document holding them. */
const pasted = (objects: DocumentObject[], warningsOut?: string[]) => {
  let source: ChemDraftDocument = admitParsedDocument(documentOf(objects));
  source = applyPatch(source, { op: "setSelection", pageId: source.pages[0]!.id, objectIds: objects.map((object) => object.id) });
  const payload = workflow.createSelectionClipboardPayload(source)!;
  return workflow.pasteSelectionClipboardPayload(admitParsedDocument(createEmptyDocument()), payload,
    { x: payload.bounds.centerX, y: payload.bounds.centerY }, warningsOut);
};
const molecules = (document: ChemDraftDocument) =>
  document.pages[0]!.objects.filter((object): object is MoleculeObject => object.type === "molecule");
/** Every field the lone-H refresh may write, serialized: equal strings mean a byte-identical cache. */
const cacheOf = (molecule: MoleculeObject) => JSON.stringify({ structureFormat: molecule.structureFormat,
  structure: molecule.structure, chemistry: molecule.chemistry, compatibility: molecule.compatibility });
const declinedOf = (warnings: readonly { code: string }[]) =>
  warnings.filter((warning) => warning.code === workflow.IMPLIED_RADICAL_CACHE_NOT_REFRESHED_CODE) as
    { code: string; message: string; sourceObjectId?: string }[];
/** RDKit's SMILES for a stored structure (a SMILES or a molfile), or undefined if RDKit cannot read it. */
const rdkitReading = async (structure: string) => {
  const rdkit = await ensureRdkit();
  const mol = rdkit.get_mol(structure);
  if (!mol) return undefined;
  try {
    return mol.get_smiles?.();
  } finally {
    mol.delete();
  }
};

/** A chemistry record in the native writer's key order. */
const record = (formula: string, averageMass: number, exactMass: number, atomCount: number, bondCount: number,
  options: { radicalCount?: number; isotopeLabels?: string[]; stereochemistry?: string[] } = {}) => ({
  formula, averageMass, exactMass, atomCount, bondCount, totalCharge: 0, radicalCount: options.radicalCount ?? 0,
  isotopeLabels: options.isotopeLabels ?? [], stereochemistry: options.stereochemistry ?? [], warnings: []
});
const moleculeOf = (id: string, atoms: MoleculeAtom[], bonds: MoleculeBond[], structureFormat: MoleculeObject["structureFormat"],
  structure: string, chemistry: MoleculeObject["chemistry"], compatibility?: MoleculeObject["compatibility"]): MoleculeObject => ({
  id, type: "molecule", x: 0, y: 0, width: 60, height: 24, rotation: 0, style: {},
  structureFormat, structure, superatoms: [], rGroups: [], atoms, bonds,
  ...(chemistry ? { chemistry } : {}), ...(compatibility ? { compatibility } : {})
});
/** What release/1.2.3 (ddaa4d498) made of a stale molecule: its structure, format and record re-derived, nothing else. */
const refreshedAt123 = (stored: MoleculeObject): MoleculeObject => {
  const derived = workflow.refreshNativeSingleBondGraph(stored, stored.atoms, stored.bonds);
  return { ...stored, structureFormat: derived.structureFormat, structure: derived.structure, chemistry: derived.chemistry };
};

// Ethane beside a lone H. Native (H•): "CC.[H]", C2H7. H2 reading: "CC.[HH]", C2H8, no radical.
const ethaneAtoms = [atom("c1", "C", 0), atom("c2", "C", 14, 8), atom("h", "H", 40)];
const ethaneBonds = [bond("b1", "c1", "c2")];
const ethaneH2 = record("C2H8", 32.086, 32.0626, 3, 1);
const ethane = (id: string, structure = "CC.[HH]", chemistry: MoleculeObject["chemistry"] = ethaneH2,
  compatibility?: MoleculeObject["compatibility"]) => moleculeOf(id, ethaneAtoms, ethaneBonds, "smiles", structure, chemistry, compatibility);
// Ethanol beside a lone H. H2 reading: "CCO.[HH]", C2H8O.
const ethanolAtoms = [atom("c1", "C", 0), atom("c2", "C", 14, 8), atom("o", "O", 28), atom("h", "H", 50)];
const ethanolBonds = [bond("b1", "c1", "c2"), bond("b2", "c2", "o")];
const ethanolH2 = record("C2H8O", 48.085, 48.05751, 4, 2);
// Bromochlorofluoromethane (F on a wedge when `wedge`) beside a lone H. Native: "BrC(F)Cl.[H]".
// H2 reading: "BrC(F)Cl.[HH]", CH3BrClF.
const haloAtoms = [atom("c", "C", 0), atom("f", "F", 14), atom("cl", "Cl", -7, 12), atom("br", "Br", -7, -12), atom("h", "H", 40)];
const haloBonds = (wedge: boolean) => [
  bond("cf", "c", "f", "single", wedge ? { bondStyle: "wedge" } : undefined), bond("ccl", "c", "cl"), bond("cbr", "c", "br")
];
const haloH2 = (stereochemistry: string[] = []) => record("CH3BrClF", 149.387, 147.90907, 5, 3, { stereochemistry });
const halo = (id: string, options: { wedge?: boolean; structureFormat?: MoleculeObject["structureFormat"]; structure: string;
  stereochemistry?: string[]; compatibility?: MoleculeObject["compatibility"] }) =>
  moleculeOf(id, haloAtoms, haloBonds(options.wedge ?? false), options.structureFormat ?? "smiles", options.structure,
    haloH2(options.stereochemistry), options.compatibility);
// trans-Cyclooctene beside a lone H: its double bond is inside the ring and still E/Z; RDKit reads (E)
// back from these 2D coordinates alone. Native: "[H].C1C=CCCCCC1". H2 reading: "[HH].C1C=CCCCCC1", C8H16.
const octeneCoordinates: [number, number][] = [
  [1.9598, 0], [1.3858, -1.3858], [0, -0.8118], [-1.3858, -1.3858], [-1.9598, 0], [-1.3858, 1.3858], [0, 1.9598], [1.3858, 1.3858]
];
const octeneAtoms = [...octeneCoordinates.map(([x, y], index) => atom(`o${index + 1}`, "C", x * 20, y * 20)), atom("h", "H", 0, 60)];
const octeneBonds = octeneCoordinates.map((_, index) =>
  bond(`r${index + 1}`, `o${index + 1}`, `o${(index + 1) % 8 + 1}`, index === 1 ? "double" : "single"));
const octene = (id: string, structureFormat: MoleculeObject["structureFormat"], structure: string) =>
  moleculeOf(id, octeneAtoms, octeneBonds, structureFormat, structure, record("C8H16", 112.216, 112.1252, 9, 8));
// Cyclopropane beside a lone H. Native: "[H].C1CC1". H2 reading: "[HH].C1CC1", C3H8.
const cyclopropaneAtoms = [atom("r1", "C", 0), atom("r2", "C", 14, 8), atom("r3", "C", 14, -8), atom("h", "H", 50)];
const cyclopropaneBonds = [bond("k1", "r1", "r2"), bond("k2", "r2", "r3"), bond("k3", "r3", "r1")];
const cyclopropaneH2 = record("C3H8", 44.097, 44.0626, 4, 3);

// A D bonded only datively to Fe (a dashed bond) beside a lone H. Native (H•): "[2H][Fe].[H]", HDFe.
// The H2 reading gave EVERY hydrogen atom with no covalent bond a hydrogen of its own, the dative D
// included (a dative bond cost it nothing): "[2HH][Fe].[HH]", H3DFe, no radical (863c8f229's writer).
const dativeAtoms = [atom("d", "D", 0), atom("fe", "Fe", 15), atom("lone", "H", 50)];
const dativeBonds = [bond("coord", "d", "fe", "single", { bondStyle: "dashed" })];
const dativeH2 = record("H3DFe", 60.883, 60.97251, 3, 1, { isotopeLabels: ["2H"] });
const dative = (id: string, structure: string, chemistry: MoleculeObject["chemistry"]) =>
  moleculeOf(id, dativeAtoms, dativeBonds, "smiles", structure, chemistry);
// The same, with a second Fe bearing a dative H stored as lowercase "h", which the native writer folds
// to H (layout-engine's `hydrogenCountElement`). Native: "[2H][Fe].[Fe][H].[H]", H2DFe2. The H2 reading
// gave the "h" a hydrogen too: "[2HH][Fe].[Fe][HH].[HH]", H5DFe2.
const lowercaseAtoms = [...dativeAtoms, atom("fe2", "Fe", 15, 30), atom("hl", "h", 0, 30)];
const lowercaseBonds = [...dativeBonds, bond("coord2", "hl", "fe2", "single", { bondStyle: "dashed" })];
const lowercase = (id: string, structure: string, chemistry: MoleculeObject["chemistry"]) =>
  moleculeOf(id, lowercaseAtoms, lowercaseBonds, "smiles", structure, chemistry);
/** The record the native writer derives for the lowercase drawing with a hydrogen partnered to each of `partnered`. */
const lowercasePartneredRecord = (partnered: string[]) => {
  const derived = workflow.refreshNativeSingleBondGraph(lowercase("p", "", undefined),
    [...lowercaseAtoms, ...partnered.map((id, index) => atom(`partner${index}`, "H", 70 + index * 10))],
    [...lowercaseBonds, ...partnered.map((id, index) => bond(`pair${index}`, id, `partner${index}`))]);
  return { ...derived.chemistry!, atomCount: lowercaseAtoms.length, bondCount: lowercaseBonds.length };
};

// A repeat-unit bracket pair ("n") around a molecule: chem-core notes on the molecule's chemistry record,
// on every read and commit, that its values are for one drawn copy (`chemistry.bracket_multiplier`).
const repeatUnitPair = (moleculeId: string): BracketObject[] => {
  const open: BracketObject = { id: "open", type: "bracket", x: -20, y: -30, width: 10, height: 60, rotation: 0, style: {},
    bracketKind: "square", side: "open", pairId: "pair", repeatUnit: true, containedObjectIds: [moleculeId] };
  return [open, { ...open, id: "close", x: 70, side: "close", label: "n" }];
};
const BRACKET_NOTE = "chemistry.bracket_multiplier";
const bracketNotes = (molecule: MoleculeObject) => molecule.chemistry?.warnings.filter((warning) => warning.code === BRACKET_NOTE) ?? [];
const withoutBracketNotes = (molecule: MoleculeObject) => molecule.chemistry &&
  { ...molecule.chemistry, warnings: molecule.chemistry.warnings.filter((warning) => warning.code !== BRACKET_NOTE) };

// Two lone H atoms, the first stating one hydrogen of its own (hydrogenCount 1): a count nothing counts
// on a hydrogen atom (chem-core `atomIgnoresStatedHydrogenCount`), so the validator writes a diagnostic
// about that atom, naming the count it derives. Today, and from e7ef3bc68 on, a hydrogen atom derives
// none ("... SMILES count 0."); the H2 reading's writer derived one for it ("... SMILES count 1.").
const statedAtoms = [{ ...atom("h1", "H", 0), hydrogenCount: 1 }, atom("h2", "H", 40)];
const stated = (id: string, structure: string, chemistry: MoleculeObject["chemistry"], compatibility?: MoleculeObject["compatibility"]) =>
  moleculeOf(id, statedAtoms, [], "smiles", structure, chemistry, compatibility);
/** Today's record for the drawing: "[H].[H]", H2, two radicals, and the diagnostic about h1 ending "SMILES count 0.". */
const statedToday = () => workflow.refreshNativeSingleBondGraph(stated("p", "", undefined), statedAtoms, []).chemistry!;
/**
 * The H2 reading's formula and masses for the drawing (H4, no radical), with today's diagnostic about
 * h1: today's native metadata of the drawing with a hydrogen bonded to each lone H, as the refresh
 * once rebuilt the H2 record (each bonded H still states its count, and derives none).
 */
const statedH4WithTodaysDiagnostic = () => ({
  ...nativeSingleBondGraphMetadata([...statedAtoms, atom("p1", "H", 10), atom("p2", "H", 50)], [bond("q1", "h1", "p1"), bond("q2", "h2", "p2")]),
  atomCount: 2, bondCount: 0
});

/** A V2000 molfile of C, F, Cl, Br and a lone H, as RDKit writes one (the lone H with no valence field: H2). */
const haloV2000 = [
  "", "     RDKit          2D", "",
  "  5  3  0  0  0  0  0  0  0  0999 V2000",
  "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    1.0000    0.0000    0.0000 F   0  0  0  0  0  0  0  0  0  0  0  0",
  "   -0.5000    0.8660    0.0000 Cl  0  0  0  0  0  0  0  0  0  0  0  0",
  "   -0.5000   -0.8660    0.0000 Br  0  0  0  0  0  0  0  0  0  0  0  0",
  "    3.0000    0.0000    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0",
  "  1  2  1  1",
  "  1  3  1  0",
  "  1  4  1  0",
  "M  END", ""
].join("\n");
/** The same molecule as a V3000 molfile with a CFG on the C-F bond. */
const haloV3000 = [
  "", "     RDKit          2D", "",
  "  0  0  0     0  0            999 V3000",
  "M  V30 BEGIN CTAB",
  "M  V30 COUNTS 5 3 0 0 0",
  "M  V30 BEGIN ATOM",
  "M  V30 1 C 0 0 0 0",
  "M  V30 2 F 1 0 0 0",
  "M  V30 3 Cl -0.5 0.866 0 0",
  "M  V30 4 Br -0.5 -0.866 0 0",
  "M  V30 5 H 3 0 0 0",
  "M  V30 END ATOM",
  "M  V30 BEGIN BOND",
  "M  V30 1 1 1 2 CFG=1",
  "M  V30 2 1 1 3",
  "M  V30 3 1 1 4",
  "M  V30 END BOND",
  "M  V30 END CTAB",
  "M  END", ""
].join("\n");
/** Ethane beside a lone H as a V2000 molfile carrying the H's radical as an `M  RAD` doublet (RDKit: CC.[H]). */
const ethaneRadicalV2000 = [
  "", "     RDKit          2D", "",
  "  3  1  0  0  0  0  0  0  0  0999 V2000",
  "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    0.7000   -0.4000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    2.0000    0.0000    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0",
  "  1  2  1  0",
  "M  RAD  1   3   2",
  "M  END", ""
].join("\n");
/** A CXSMILES whose stereo is only its extension: coordinates and a wedge (wU), no "@", "/" or "\\". */
const haloCxSmiles = "FC(Cl)Br.[HH] |(0,0,;1.2,0,;-0.6,1,;-0.6,-1,;3,0,),wU:1.0|";

describe("a lone H's stale cache that is ChemDraft's own earlier output is refreshed as release/1.2.3 refreshed it", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("refreshes a plain CC.[HH] cache on open, session restore and paste, byte-identically to release/1.2.3, with no warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = ethane("ethane");
    const expected = refreshedAt123(stored);
    expect(expected.structure).toBe("CC.[H]");
    expect(expected.chemistry).toEqual(record("C2H7", 31.078, 31.05478, 3, 1, { radicalCount: 1 }));
    // The refresh itself is release/1.2.3's, object for object.
    const refreshed = workflow.withImpliedRadicalChemistryRederived(documentOf([stored]));
    expect(molecules(refreshed)[0]).toEqual(expected);
    for (const [occasion, read] of [["open", openRead], ["session restore", restoreRead]] as const) {
      const result = read([stored]);
      expect(declinedOf(result.warnings), occasion).toEqual([]);
      const [kept] = molecules(committed(result));
      expect(cacheOf(kept!), occasion).toBe(cacheOf(expected));
      expect(kept!.atoms).toEqual(stored.atoms);
      expect(kept!.bonds).toEqual(stored.bonds);
    }
    const warningsOut: string[] = [];
    const [paste] = molecules(pasted([stored], warningsOut));
    expect(cacheOf(paste!)).toBe(cacheOf(expected));
    expect(warningsOut).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("refreshes a bonded H2 beside a lone D ([H][H].[2HH]): only the lone D's reading changes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The bonded H2 component is "[H][H]" under every reading; the lone D was "[2HH]" (HD) and is "[2H]" (D•).
    const stored = moleculeOf("h2d", [atom("h1", "H", 0), atom("h2", "H", 14), atom("d", "D", 50)], [bond("hh", "h1", "h2")],
      "smiles", "[2HH].[H][H]", record("H3D", 5.038, 5.03758, 3, 1, { isotopeLabels: ["2H"] }));
    for (const read of [openRead, restoreRead]) {
      const result = read([stored]);
      expect(declinedOf(result.warnings)).toEqual([]);
      const [kept] = molecules(committed(result));
      expect(kept!.structure).toBe("[2H].[H][H]");
      expect(kept!.chemistry).toEqual(record("H2D", 4.03, 4.02975, 3, 1, { radicalCount: 1, isotopeLabels: ["2H"] }));
    }
    expect(molecules(pasted([stored]))[0]!.structure).toBe("[2H].[H][H]");
    expect(warn).not.toHaveBeenCalled();
  });

  it("refreshes a cached SMILES copy (compatibility.unknown.smiles) that is the same earlier output, to the same structure", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = ethane("twice", "CC.[HH]", ethaneH2, { warnings: [], unknown: { smiles: "CC.[HH]", kept: "other" } });
    const result = openRead([stored]);
    expect(declinedOf(result.warnings)).toEqual([]);
    const [kept] = molecules(committed(result));
    expect(kept!.structure).toBe("CC.[H]");
    expect(kept!.compatibility?.unknown).toEqual({ smiles: "CC.[H]", kept: "other" });
    expect(kept!.chemistry?.radicalCount).toBe(1);
  });

  it("counts a field absent in storage as equal: no structure, or no chemistry record", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const noRecord = moleculeOf("noRecord", ethaneAtoms, ethaneBonds, "smiles", "CC.[HH]", undefined);
    expect(noRecord.chemistry).toBeUndefined();
    for (const stored of [ethane("noStructure", ""), noRecord]) {
      const result = openRead([stored]);
      expect(declinedOf(result.warnings)).toEqual([]);
      expect(cacheOf(molecules(committed(result))[0]!)).toBe(cacheOf(refreshedAt123(stored)));
    }
  });

  it("refreshes the bare-atom reading of release 1.2.2 (CC.[H], C2H7, no radical counted) to count the radical", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = ethane("released", "CC.[H]", record("C2H7", 31.078, 31.05478, 3, 1));
    const result = openRead([stored]);
    expect(declinedOf(result.warnings)).toEqual([]);
    expect(cacheOf(molecules(committed(result))[0]!)).toBe(cacheOf(refreshedAt123(stored)));
    expect(molecules(committed(result))[0]!.chemistry?.radicalCount).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("refreshes a dative Fe–D beside a lone H as the H2 reading stored it ([2HH][Fe].[HH], H3DFe): both atoms' readings at once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = dative("dative", "[2HH][Fe].[HH]", dativeH2);
    const expected = refreshedAt123(stored);
    expect(expected.structure).toBe("[2H][Fe].[H]");
    expect(expected.chemistry?.formula).toBe("HDFe");
    expect(expected.chemistry?.radicalCount).toBe(1);
    for (const [occasion, read] of [["open", openRead], ["session restore", restoreRead]] as const) {
      const result = read([stored]);
      expect(declinedOf(result.warnings), occasion).toEqual([]);
      expect(cacheOf(molecules(committed(result))[0]!), occasion).toBe(cacheOf(expected));
    }
    const warningsOut: string[] = [];
    expect(cacheOf(molecules(pasted([stored], warningsOut))[0]!)).toBe(cacheOf(expected));
    expect(warningsOut).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("refreshes a dative Fe–h stored as lowercase \"h\" as the H2 reading stored it ([2HH][Fe].[Fe][HH].[HH], H5DFe2)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h2 = lowercasePartneredRecord(["d", "lone", "hl"]);
    expect(h2.formula).toBe("H5DFe2");
    const stored = lowercase("lowercase", "[2HH][Fe].[Fe][HH].[HH]", h2);
    const expected = refreshedAt123(stored);
    expect(expected.structure).toBe("[2H][Fe].[Fe][H].[H]");
    expect(expected.chemistry?.formula).toBe("H2DFe2");
    for (const [occasion, read] of [["open", openRead], ["session restore", restoreRead]] as const) {
      const result = read([stored]);
      expect(declinedOf(result.warnings), occasion).toEqual([]);
      expect(cacheOf(molecules(committed(result))[0]!), occasion).toBe(cacheOf(expected));
    }
    const warningsOut: string[] = [];
    expect(cacheOf(molecules(pasted([stored], warningsOut))[0]!)).toBe(cacheOf(expected));
    expect(warningsOut).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("refreshes the same dative drawing under the bare-atom reading ([2H][Fe].[H], no radical): the dative D read then as now", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const today = refreshedAt123(dative("bare", "", undefined));
    const stored = { ...today, chemistry: { ...today.chemistry!, radicalCount: 0 } };
    const result = openRead([stored]);
    expect(declinedOf(result.warnings)).toEqual([]);
    expect(cacheOf(molecules(committed(result))[0]!)).toBe(cacheOf(today));
    expect(warn).not.toHaveBeenCalled();
  });

  it("refreshes the same halo drawing stored without stereo (BrC(F)Cl.[HH], wedge drawn or not): native output carries none", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const wedge of [false, true]) {
      const stored = halo("plain", { wedge, structure: "BrC(F)Cl.[HH]" });
      const result = openRead([stored]);
      expect(declinedOf(result.warnings)).toEqual([]);
      expect(cacheOf(molecules(committed(result))[0]!)).toBe(cacheOf(refreshedAt123(stored)));
    }
  });

  // The read notes the bracket pair on the stored H2 record, as on every record on that page; the
  // H2 reading's record is compared with that note on it too, made by chem-core's own annotation.
  it("refreshes a CC.[HH] cache inside a repeat-unit bracket pair on open, session restore and paste, as release/1.2.3 did", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = ethane("polymer");
    const at123 = refreshedAt123(stored);
    for (const [occasion, read] of [["open", openRead], ["session restore", restoreRead]] as const) {
      const result = read([stored, ...repeatUnitPair("polymer")]);
      expect(declinedOf(result.warnings), occasion).toEqual([]);
      const [readBack] = molecules(result.document!);
      expect(readBack!.structure, occasion).toBe("CC.[HH]");
      expect(bracketNotes(readBack!), occasion).toHaveLength(1);
      expect(bracketNotes(readBack!)[0]!.message).toContain("repeat unit n");
      const [kept] = molecules(committed(result));
      expect(kept!.structure, occasion).toBe("CC.[H]");
      expect(kept!.structureFormat).toBe(at123.structureFormat);
      // Release/1.2.3's record, with the page's own note kept on it, as the next commit would leave it.
      expect(withoutBracketNotes(kept!), occasion).toEqual(at123.chemistry);
      expect(bracketNotes(kept!), occasion).toEqual(bracketNotes(readBack!));
      expect(kept!.atoms).toEqual(stored.atoms);
    }
    const warningsOut: string[] = [];
    const paste = pasted([stored, ...repeatUnitPair("polymer")], warningsOut);
    const [pastedMolecule] = molecules(paste);
    expect(bracketNotes(pastedMolecule!)).toHaveLength(1);
    expect(pastedMolecule!.structure).toBe("CC.[H]");
    expect(withoutBracketNotes(pastedMolecule!)).toEqual(at123.chemistry);
    expect(warningsOut).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("refreshes the bare-atom reading of release 1.2.2 inside a repeat-unit bracket pair, with no warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = ethane("released", "CC.[H]", record("C2H7", 31.078, 31.05478, 3, 1));
    for (const read of [openRead, restoreRead]) {
      const result = read([stored, ...repeatUnitPair("released")]);
      expect(declinedOf(result.warnings)).toEqual([]);
      const [kept] = molecules(committed(result));
      expect(kept!.chemistry?.radicalCount).toBe(1);
      expect(withoutBracketNotes(kept!)).toEqual(refreshedAt123(stored).chemistry);
      expect(bracketNotes(kept!)).toHaveLength(1);
    }
    expect(molecules(pasted([stored, ...repeatUnitPair("released")]))[0]!.chemistry?.radicalCount).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("says nothing and changes nothing for today's own record inside a repeat-unit bracket pair", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = { ...ethane("current"), ...refreshedAt123(ethane("current")) };
    for (const read of [openRead, restoreRead]) {
      const result = read([stored, ...repeatUnitPair("current")]);
      expect(declinedOf(result.warnings)).toEqual([]);
      const [readBack] = molecules(result.document!);
      const [kept] = molecules(committed(result));
      expect(cacheOf(kept!)).toBe(cacheOf(readBack!));
      expect(bracketNotes(kept!)).toHaveLength(1);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  // From e7ef3bc68 until 95783e713 the writer read a lone H as the bare atom and derived no hydrogen
  // for it, as today's does: its diagnostic about the stated count is today's, word for word.
  it("refreshes the bare-atom reading of two lone H atoms, one stating a count, with today's diagnostic about it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const today = statedToday();
    expect(today.warnings).toHaveLength(1);
    expect(today.warnings[0]!.objectId).toBe("h1");
    expect(today.warnings[0]!.message).toMatch(/SMILES count 0\.$/);
    const stored = stated("bare", "[H].[H]", { ...today, radicalCount: 0 });
    for (const read of [openRead, restoreRead]) {
      const result = read([stored]);
      expect(declinedOf(result.warnings)).toEqual([]);
      const [kept] = molecules(committed(result));
      expect(kept!.structure).toBe("[H].[H]");
      expect(kept!.chemistry).toEqual(today);
    }
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("a lone H's cache that is not ChemDraft's own earlier output is kept as stored, with one warning", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  /** Each case: what it is, the stored molecule, and a stored string RDKit reads real stereo from (when it has one). */
  const cases: [string, () => MoleculeObject, { from: string; reads: RegExp }?][] = [
    ["a wedged F[C@@H](Cl)Br.[HH] with its stereochemistry label",
      () => halo("wedged", { wedge: true, structure: "F[C@@H](Cl)Br.[HH]", stereochemistry: ["atom 0 (S)"] }),
      { from: "F[C@@H](Cl)Br.[HH]", reads: /@/ }],
    ["a stereochemistry label alone, in an otherwise native record",
      () => halo("label", { wedge: true, structure: "BrC(F)Cl.[HH]", stereochemistry: ["atom 0 (S)"] })],
    ["trans-cyclooctene's E/Z in the stored SMILES", () => octene("octene", "smiles", "C1/C=C/CCCCC1.[HH]"),
      { from: "C1/C=C/CCCCC1.[HH]", reads: /[/\\]/ }],
    ["a wedge in a CXSMILES extension only (|wU|)", () => halo("cxsmiles", { structure: haloCxSmiles }),
      { from: haloCxSmiles, reads: /@/ }],
    ["a stored V2000 molfile", () => halo("v2000", { structureFormat: "molfile-v2000", structure: haloV2000 }),
      { from: haloV2000, reads: /@/ }],
    ["a stored V3000 molfile", () => halo("v3000", { structureFormat: "molfile-v3000", structure: haloV3000 }),
      { from: haloV3000, reads: /@/ }],
    ["dimethyl ether (COC.[HH]) stored for an ethanol drawing",
      () => moleculeOf("ether", ethanolAtoms, ethanolBonds, "smiles", "COC.[HH]", ethanolH2)],
    ["CC.[HH] with a [HH].CC copy and a formula claiming C9H99",
      () => ethane("c9h99", "CC.[HH]", { ...ethaneH2, formula: "C9H99" }, { warnings: [], unknown: { smiles: "[HH].CC" } })],
    ["a formula claiming C9H99 beside a native structure and copy",
      () => ethane("formula", "CC.[HH]", { ...ethaneH2, formula: "C9H99" }, { warnings: [], unknown: { smiles: "CC.[HH]" } })],
    ["a cached copy spelled other than the native writer spells it ([HH].CC)",
      () => ethane("respelled", "CC.[HH]", ethaneH2, { warnings: [], unknown: { smiles: "[HH].CC" } })],
    ["C(-1)CC1.[HH] stored for a cyclopropane drawing",
      () => moleculeOf("ring", cyclopropaneAtoms, cyclopropaneBonds, "smiles", "C(-1)CC1.[HH]", cyclopropaneH2)],
    // The lone H in the H2 reading but the dative D in today's: a mix no writer ever emitted (H2DFe).
    ["a mixed-era dative cache ([2H][Fe].[HH], H2DFe): the lone H read as H2, the dative D as today", () => {
      const partnered = workflow.refreshNativeSingleBondGraph(dative("p", "", undefined), [...dativeAtoms, atom("partner", "H", 65)],
        [...dativeBonds, bond("pair", "lone", "partner")]);
      expect(partnered.chemistry?.formula).toBe("H2DFe");
      return dative("mixed", "[2H][Fe].[HH]", { ...partnered.chemistry!, atomCount: 3, bondCount: 1 });
    }],
    // The lowercase "h" read as today while the D and the lone H read as H2 (H4DFe2): the H2-era writer
    // folded "h" to H and gave it a hydrogen too, so no writer ever emitted this.
    ["a mixed-era cache whose dative \"h\" reads as today ([2HH][Fe].[Fe][H].[HH], H4DFe2)", () => {
      const mixed = lowercasePartneredRecord(["d", "lone"]);
      expect(mixed.formula).toBe("H4DFe2");
      return lowercase("mixedh", "[2HH][Fe].[Fe][H].[HH]", mixed);
    }],
    // Today's structure and record, but a cached copy of other chemistry: not a no-op, and no era's output.
    ["a cached copy of other chemistry (COC.[HH]) beside today's structure and record",
      () => ({ ...refreshedAt123(ethane("copy")), compatibility: { warnings: [], unknown: { smiles: "COC.[HH]" } } })],
    // Nothing verifies a stored CTAB on open, restore or paste, so a CTAB beside today's record is kept
    // and named there (a plugin insert's verifier checks it instead: applyPluginDocumentPatch.loneHydrogen).
    ["a V2000 molfile with an M  RAD doublet on the lone H, beside today's record",
      () => ({ ...refreshedAt123(ethane("radctab")), structureFormat: "molfile-v2000" as const, structure: ethaneRadicalV2000 })],
    ["a chemistry record whose warnings the native writer never wrote (an engine's record)",
      () => ({ ...ethane("engine"), chemistry: { ...ethaneH2, warnings: [{ code: "rdkit.sanitize", message: "Read by RDKit." }] } })],
    // The H2 reading's structure (in both SMILES fields), formula, masses and radical count, beside
    // TODAY's diagnostic about h1 ("SMILES count 0."): the H2 writer wrote "SMILES count 1.", so no
    // writer ever emitted this mix, and refreshing it would read a record of two eras as one.
    ["two lone H atoms, one stating a count: the H2 reading's [HH].[HH] and H4 with today's diagnostic", () => {
      const mixed = statedH4WithTodaysDiagnostic();
      expect(mixed).toMatchObject({ formula: "H4", radicalCount: 0 });
      expect(mixed.warnings).toEqual(statedToday().warnings);
      expect(mixed.warnings[0]!.message).toMatch(/SMILES count 0\.$/);
      return stated("mixedH4", "[HH].[HH]", mixed, { warnings: [], unknown: { smiles: "[HH].[HH]" } });
    }],
    // The H2 writer's own record for that drawing. Its diagnostic states the hydrogen that era derived
    // for h1 ("SMILES count 1."), which today's validator never derives for a hydrogen atom, so the
    // reading cannot be rebuilt exactly and is not offered: the record is kept and named, never
    // matched in part.
    ["two lone H atoms, one stating a count: the H2 writer's record, whose diagnostic today's validator cannot rebuild", () => {
      const mixed = statedH4WithTodaysDiagnostic();
      const warnings = mixed.warnings.map((warning) => ({ ...warning, message: warning.message.replace(/SMILES count 0\.$/, "SMILES count 1.") }));
      expect(warnings[0]!.message).toMatch(/SMILES count 1\.$/);
      return stated("h2era", "[HH].[HH]", { ...mixed, warnings });
    }]
  ];

  for (const [what, make, stereo] of cases) {
    it(`keeps the cache byte-identical and warns once, on open, session restore and paste: ${what}`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const stored = make();
      if (stereo) expect(await rdkitReading(stereo.from)).toMatch(stereo.reads);
      for (const [occasion, read] of [["open", openRead], ["session restore", restoreRead]] as const) {
        const result = read([stored]);
        const declined = declinedOf(result.warnings);
        expect(declined, occasion).toHaveLength(1);
        expect(declined[0]!.sourceObjectId).toBe(stored.id);
        expect(declined[0]!.message).toContain("was not refreshed");
        expect(declined[0]!.message).toContain("not ChemDraft's own earlier output");
        const [kept] = molecules(committed(result));
        expect(cacheOf(kept!), occasion).toBe(cacheOf(stored));
        expect(kept!.atoms).toEqual(stored.atoms);
        expect(kept!.bonds).toEqual(stored.bonds);
      }
      const warningsOut: string[] = [];
      const [kept] = molecules(pasted([stored], warningsOut));
      expect(cacheOf(kept!)).toBe(cacheOf(stored));
      expect(warningsOut).toHaveLength(1);
      expect(warningsOut[0]).toContain("not ChemDraft's own earlier output");
      // One console line per refresh that declined: open, restore and paste.
      expect(warn).toHaveBeenCalledTimes(3);
    }, 30_000);
  }

  it("names each molecule a paste keeps as stored once, one line each, in the open report's words", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ether = moleculeOf("ether", ethanolAtoms.map((each) => ({ ...each, y: each.y + 60 })), ethanolBonds, "smiles", "COC.[HH]", ethanolH2);
    const both = [halo("wedged", { wedge: true, structure: "F[C@@H](Cl)Br.[HH]", stereochemistry: ["atom 0 (S)"] }), ether];
    const warningsOut: string[] = [];
    const kept = molecules(pasted(both, warningsOut));
    expect(kept).toHaveLength(2);
    expect(new Set(kept.map((molecule) => molecule.id)).size).toBe(2);
    // One line per kept molecule, naming it (its pasted id), and no line twice.
    expect(warningsOut).toEqual(kept.map((molecule) => workflow.impliedRadicalCacheDeclinedLine(molecule.id)));
    expect(new Set(warningsOut).size).toBe(2);
    kept.forEach((molecule, index) => expect(warningsOut[index]).toContain(`molecule "${molecule.id}"`));
    // The same text the open report shows for each of them.
    const opened = declinedOf(openRead(both).warnings);
    expect(opened).toHaveLength(2);
    for (const line of warningsOut) {
      expect(line).toContain(workflow.impliedRadicalCacheNotRefreshedText());
      expect(opened.some((warning) => warning.message.endsWith(workflow.impliedRadicalCacheNotRefreshedText()))).toBe(true);
    }
    // One console line per kept molecule of the paste (the open read above commits nothing).
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("says nothing and changes nothing when the stored record already is today's and no structure is stored", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = { ...refreshedAt123(ethane("recordOnly")), structure: "" };
    expect(stored.chemistry?.radicalCount).toBe(1);
    for (const read of [openRead, restoreRead]) {
      const result = read([stored]);
      expect(declinedOf(result.warnings)).toEqual([]);
      expect(cacheOf(molecules(committed(result))[0]!)).toBe(cacheOf(stored));
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("says nothing and changes nothing when the stored cache already is the native derivation ([H].CC)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The H's id sorts first, so the native writer writes its component first.
    const drawn = moleculeOf("current", [atom("a", "H", -30), atom("c1", "C", 0), atom("c2", "C", 14, 8)], ethaneBonds, "smiles", "", undefined);
    const derived = workflow.refreshNativeSingleBondGraph(drawn, drawn.atoms, drawn.bonds);
    const stored = { ...drawn, structureFormat: derived.structureFormat, structure: derived.structure, chemistry: derived.chemistry };
    expect(stored.structure).toBe("[H].CC");
    const document = documentOf([stored]);
    expect(workflow.withImpliedRadicalChemistryRederived(document)).toBe(document);
    for (const read of [openRead, restoreRead]) {
      const result = read([stored]);
      expect(declinedOf(result.warnings)).toEqual([]);
      expect(cacheOf(molecules(committed(result))[0]!)).toBe(cacheOf(stored));
    }
    const warningsOut: string[] = [];
    expect(cacheOf(molecules(pasted([stored], warningsOut))[0]!)).toBe(cacheOf(stored));
    expect(warningsOut).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

// A declined refresh is reported however the document opens: after a visible-layer conflict resolved
// to the embedded document, and on a session restore that carries a saved save report.
describe("the open report names a kept lone-H cache after Restore Embedded and beside a saved save report", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const kept = () => halo("wedged", { wedge: true, structure: "F[C@@H](Cl)Br.[HH]", stereochemistry: ["atom 0 (S)"] });

  it("names the embedded document's kept molecule after Restore Embedded, and only the visible subset's after Import Visible CDXML", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = kept();
    const saved = workflow.createNativeSavePayload(admitParsedDocument(documentOf([stored]))).contents;
    expect(saved).toContain("</fragment>");
    const edited = saved.replace("</fragment>", "</fragment><t id=\"999\" p=\"0 0\"><s>Edited elsewhere</s></t>");
    const opened = workflow.openNativeDocument(edited);
    expect(opened.document).toBeUndefined();
    const embedded = opened.conflict!.embeddedDocument;
    const visible = opened.conflict!.visibleDocument!;
    // The read names both candidates' kept molecules, each message saying which candidate it is about.
    const embeddedWarnings = declinedOf(opened.warnings).filter((warning) => warning.message.startsWith("Embedded ChemDraft document: "));
    const visibleWarnings = declinedOf(opened.warnings).filter((warning) => warning.message.startsWith("Edited visible CDXML subset: "));
    expect(embeddedWarnings).toHaveLength(1);
    expect(embeddedWarnings[0]!.sourceObjectId).toBe(stored.id);
    expect(declinedOf(opened.warnings)).toHaveLength(embeddedWarnings.length + visibleWarnings.length);
    // Restore Embedded installs `embeddedDocument` (MainWindow's resolveOpenResultDocument) and reports
    // `openedDocumentWarnings` for it: the embedded molecule's warning, and none of the discarded subset's.
    const restoredReport = workflow.openedDocumentWarnings(opened, embedded);
    expect(declinedOf(restoredReport)).toEqual(embeddedWarnings);
    expect(restoredReport.filter((warning) => !declinedOf([warning]).length))
      .toEqual(opened.warnings.filter((warning) => !declinedOf([warning]).length));
    expect(cacheOf(molecules(committed(embedded))[0]!)).toBe(cacheOf(stored));
    // Import Visible CDXML installs the visible subset: its own declined molecules are named, and never
    // the embedded payload's, which it discarded.
    const visibleDeclined: string[] = [];
    workflow.withImpliedRadicalChemistryRederived(admitParsedDocument(visible), { warningsOut: visibleDeclined });
    const importedReport = workflow.openedDocumentWarnings(opened, visible);
    expect(declinedOf(importedReport)).toEqual(visibleWarnings);
    expect(declinedOf(importedReport)).toHaveLength(visibleDeclined.length);
    expect(importedReport.some((warning) => warning.message.startsWith("Embedded ChemDraft document: "))).toBe(false);
    expect(importedReport.filter((warning) => !declinedOf([warning]).length))
      .toEqual(opened.warnings.filter((warning) => !declinedOf([warning]).length));
  });

  it("names the visible subset's kept molecule after Import Visible CDXML, and not after Restore Embedded", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A read whose visible subset holds the kept molecule and whose embedded document does not.
    const visible = admitParsedDocument(documentOf([kept()]));
    const embedded = admitParsedDocument(documentOf([ethane("fresh")]));
    const visibleWarning = { code: workflow.IMPLIED_RADICAL_CACHE_NOT_REFRESHED_CODE,
      message: `Edited visible CDXML subset: ${workflow.impliedRadicalCacheNotRefreshedText()}`, sourceObjectId: "wedged" };
    const other = { code: "cdxml.table_approximated", message: "Table written as text and lines." };
    const opened = { source: "native-payload", warnings: [other, visibleWarning],
      conflict: { embeddedDocument: embedded, visibleDocument: visible } } as unknown as ReturnType<typeof workflow.openNativeDocument>;
    expect(workflow.openedDocumentWarnings(opened, visible)).toEqual([other, visibleWarning]);
    expect(workflow.openedDocumentWarnings(opened, embedded)).toEqual([other]);
    // An open with no conflict reports its warnings as they are, the same array.
    const plain = openRead([kept()]);
    expect(workflow.openedDocumentWarnings(plain, plain.document!)).toBe(plain.warnings);
  });

  it("keeps the restore's lone-H warning when the session saved a save report and no open report", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = kept();
    const saveWarnings = { operation: "save", displayName: "Untitled", sourceLabel: "ChemDraft CDXML envelope",
      warnings: [{ code: "cdxml.table_approximated", message: "Table written as text and lines." }] };
    const session = restoredSession([stored], { saveWarnings });
    const opened = workflow.openNativeDocument(session.contents);
    const reread = { displayName: session.displayName, sourceLabel: "ChemDraft document", warnings: [
      ...opened.warnings, { code: "document.atom_hydrogen_count_not_counted", message: "The save report flags this atom too." }
    ] };
    const reports = restoreSessionWarningReports(session, reread);
    expect(reports.saveWarnings).toEqual(saveWarnings);
    // Only what no save report carries: the lone-H warning, not the one the save report flags as well.
    expect(reports.warnings?.warnings).toEqual(declinedOf(opened.warnings));
    expect(reports.warnings?.warnings).toHaveLength(1);
    expect(reports.warnings?.warnings[0]!.sourceObjectId).toBe(stored.id);
    // A legacy session keeping its save report in the open report's slot restores the same way.
    const legacy = restoredSession([stored], { openWarnings: saveWarnings });
    expect(restoreSessionWarningReports(legacy, reread).warnings?.warnings).toEqual(declinedOf(opened.warnings));
    // Nothing to keep: no report.
    expect(restoreSessionWarningReports(session, { ...reread, warnings: reread.warnings.slice(-1) }).warnings).toBeUndefined();
  });
});

// A plugin batch refreshes only what it inserted, in one pass, with each decline attributed.
describe("rederiveImpliedRadicalChemistryOf refreshes only the named molecules", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const twoPages = (first: MoleculeObject[], second: MoleculeObject[]): ChemDraftDocument => {
    const base = admitParsedDocument(documentOf(first));
    return admitParsedDocument({ ...base, pages: [...base.pages, { ...base.pages[0]!, id: "page_2", objects: second }] });
  };
  const kept = () => halo("kept", { wedge: true, structure: "F[C@@H](Cl)Br.[HH]", stereochemistry: ["atom 0 (S)"] });

  it("refreshes the named molecules, keeps a declined one with its page, id and text, and leaves everything else as stored", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = kept();
    const document = twoPages([stored, ethane("fresh"), ethane("other")], [ethane("fresh"), ethane("elsewhere")]);
    const firstPage = document.pages[0]!.id;
    const result = workflow.rederiveImpliedRadicalChemistryOf(document, [
      { pageId: firstPage, objectId: "kept" }, { pageId: firstPage, objectId: "fresh" }, { pageId: firstPage, objectId: "missing" }
    ], { occasion: "on plugin insert" });
    expect(result.declined).toEqual([{ pageId: firstPage, objectId: "kept", text: workflow.impliedRadicalCacheNotRefreshedText() }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("molecule kept on plugin insert");
    const [keptAfter, freshAfter, otherAfter] = molecules(result.document);
    expect(cacheOf(keptAfter!)).toBe(cacheOf(stored));
    expect(freshAfter!.structure).toBe("CC.[H]");
    expect(freshAfter!.chemistry?.radicalCount).toBe(1);
    expect(otherAfter).toBe(document.pages[0]!.objects[2]);
    // The page no target names keeps every object as it was, the same-id "fresh" there included.
    expect(result.document.pages[1]!.objects).toHaveLength(2);
    result.document.pages[1]!.objects.forEach((object, index) => expect(object).toBe(document.pages[1]!.objects[index]));
    expect((result.document.pages[1]!.objects[0] as MoleculeObject).structure).toBe("CC.[HH]");
    // It is the same refresh `withImpliedRadicalChemistryRederived` makes with `only`.
    const viaOnly = workflow.withImpliedRadicalChemistryRederived(document, {
      only: (pageId, objectId) => pageId === firstPage && (objectId === "kept" || objectId === "fresh"), occasion: "on plugin insert"
    });
    expect(serializeDocument(result.document)).toBe(serializeDocument(viaOnly));
  });

  it("returns the same document when it names nothing, or nothing it would change", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const document = twoPages([kept()], [ethane("fresh")]);
    expect(workflow.rederiveImpliedRadicalChemistryOf(document, [])).toEqual({ document, declined: [] });
    const onlyKept = workflow.rederiveImpliedRadicalChemistryOf(document, [{ pageId: document.pages[0]!.id, objectId: "kept" }]);
    expect(onlyKept.document).toBe(document);
    expect(onlyKept.declined).toHaveLength(1);
    expect(workflow.rederiveImpliedRadicalChemistryOf(document, [{ pageId: "no_such_page", objectId: "fresh" }]).document).toBe(document);
  });
});
