import { describe, expect, it } from "vitest";
import {
  applyPatch,
  moleculeToMolfileV3000,
  type ChemDraftDocument,
  type ElectronMarkObject,
  type MoleculeAtom,
  type MoleculeObject
} from "@chemdraft/chem-core";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles } from "@chemdraft/document-workflow-core";
import {
  applyChargeToolAtNativeAtom,
  applyEditorSaveResultWithLabelWarnings,
  createPhase4Document,
  EDITOR_SAVE_MARK_SHIFT_REFUSAL,
  editorSaveChargeContradictsMarkRefusal,
  normalizeCommittedDocument
} from "./documentWorkflow";

/**
 * ChemDraft AGENTS.md section 7: chemistry is never silently changed. An unchanged Ketcher
 * Apply must leave an atom's charge and electron marks exactly as they were.
 *
 * The round trip, as the app runs it:
 *  - open: KetcherEditorHost -> adapter.loadObject({ object: molecule }) -> engine.loadMolecule with
 *    `molecule.structure` in `molecule.structureFormat` (packages/ketcher-adapter/src/index.ts
 *    loadObject). There is no separate export: Ketcher is handed the stored string, which for a
 *    native graph is the SMILES `refreshNativeSingleBondGraph` derives from `atom.formalCharge`
 *    (the TOTAL charge, mark contribution included).
 *  - save: adapter.saveObject() asks Ketcher for V3000 -> handleApplyKetcherEdit ->
 *    applyEditorSaveResultWithLabelWarnings -> commitDocumentChangeWithPageFit, which normalizes
 *    through normalizeCommittedDocument.
 *
 * Ketcher itself is not runnable here. It returns the charges it was given unchanged, so the
 * stand-in for an unchanged Ketcher save is the V3000 the app's own writer produces for the same
 * atoms (CHG = atom.formalCharge, RAD from atom.markRadicals), after checking the SMILES Ketcher
 * would really have been given carries the same charge.
 */

const objectId = "mol_ketcher_roundtrip";

function methylamine(): { document: ChemDraftDocument; nitrogenId: string } {
  const { document } = linearMolecule("CN");
  return { document, nitrogenId: moleculeOf(document).atoms.find(atom => atom.element === "N")!.id };
}

/** A native molecule of `smiles` (written as an unbranched chain) laid out left to right, 30 px apart. */
function linearMolecule(smiles: string): { document: ChemDraftDocument; atomIds: string[] } {
  const graph = testMoleculeFromSmiles(smiles);
  const atoms: MoleculeAtom[] = graph.atoms.map((atom, index) => ({ ...atom, x: 100 + index * 30, y: 100 }));
  const molecule: MoleculeObject = {
    id: objectId, type: "molecule", x: 90, y: 80, width: Math.max(60, (atoms.length - 1) * 30 + 20), height: 40,
    rotation: 0, style: {},
    atoms, bonds: graph.bonds, structureFormat: "smiles",
    structure: nativeSingleBondGraphSmiles(atoms, graph.bonds),
    chemistry: nativeSingleBondGraphMetadata(atoms, graph.bonds),
    superatoms: [], rGroups: []
  };
  const document = applyPatch(createPhase4Document("Ketcher charge round trip"),
    { op: "addObject", pageId: createPhase4Document().pages[0].id, object: molecule });
  return { document: normalizeCommittedDocument(document), atomIds: atoms.map(atom => atom.id) };
}

function selectMolecule(document: ChemDraftDocument): ChemDraftDocument {
  return applyPatch(document, { op: "setSelection", pageId: document.pages[0].id, objectIds: [objectId] });
}

function moleculeOf(document: ChemDraftDocument): MoleculeObject {
  return document.pages[0].objects.find((object): object is MoleculeObject => object.id === objectId)!;
}

function marksOf(document: ChemDraftDocument): ElectronMarkObject[] {
  return document.pages[0].objects.filter((object): object is ElectronMarkObject => object.type === "electron-mark");
}

function nitrogenOf(document: ChemDraftDocument, nitrogenId: string): MoleculeAtom {
  return moleculeOf(document).atoms.find(atom => atom.id === nitrogenId)!;
}

/** Open in Ketcher, return it unchanged, apply, and commit the way the app does. */
function unchangedKetcherSave(document: ChemDraftDocument): { opened: MoleculeObject; v3000: string; committed: ChemDraftDocument } {
  const selected = selectMolecule(document);
  const opened = moleculeOf(selected);
  const v3000 = moleculeToMolfileV3000(opened, { kekuleBondOrders: new Map() }).contents;
  const saved: MoleculeObject = { ...opened, structureFormat: "molfile-v3000", structure: v3000 };
  const applied = applyEditorSaveResultWithLabelWarnings(selected, { object: saved, warnings: [] });
  return { opened, v3000, committed: normalizeCommittedDocument(applied.document) };
}

/** Open in Ketcher, let `edit` change the V3000 Ketcher returns, apply, and commit. */
function editedKetcherSave(
  document: ChemDraftDocument,
  edit: (v3000: string) => string
): { v3000: string; selected: ChemDraftDocument; refusal?: string; committed: ChemDraftDocument } {
  const selected = selectMolecule(document);
  const opened = moleculeOf(selected);
  const v3000 = edit(moleculeToMolfileV3000(opened, { kekuleBondOrders: new Map() }).contents);
  const saved: MoleculeObject = { ...opened, structureFormat: "molfile-v3000", structure: v3000 };
  const applied = applyEditorSaveResultWithLabelWarnings(selected, { object: saved, warnings: [] });
  // A refused save returns the document it was given, untouched: the caller commits nothing.
  if (applied.refusal) expect(applied.document).toBe(selected);
  return { v3000, selected, refusal: applied.refusal, committed: normalizeCommittedDocument(applied.document) };
}

/** The V3000 Ketcher returns with `element`'s atom set to CHG=`charge` (the atom's total charge). */
function withCharge(element: string, charge: number): (v3000: string) => string {
  const atomLine = new RegExp(`^M\\s+V30\\s+\\d+\\s+${element}\\s`);
  return v3000 => v3000.split(/\r?\n/).map(line => {
    if (!atomLine.test(line)) return line;
    const stripped = line.replace(/\s+CHG=-?\d+/, "");
    return charge === 0 ? stripped : `${stripped} CHG=${charge}`;
  }).join("\n");
}

/** A methyl bonded to N, appended after the existing atoms and bonds (so every existing atom keeps its id). */
function appendMethylOnNitrogen(v3000: string): string {
  const lines = v3000.split(/\r?\n/);
  const atomLines = lines.filter(line => /^M\s+V30\s+\d+\s+[A-Z][a-z]?\s/.test(line) &&
    lines.indexOf(line) > lines.findIndex(candidate => candidate.includes("BEGIN ATOM")) &&
    lines.indexOf(line) < lines.findIndex(candidate => candidate.includes("END ATOM")));
  const nitrogen = atomLines.find(line => /^M\s+V30\s+\d+\s+N\s/.test(line))!;
  const [, , nitrogenIndex, , x, y] = nitrogen.trim().split(/\s+/);
  const atomCount = atomLines.length + 1;
  const bondCount = lines.filter((line, index) => index > lines.findIndex(c => c.includes("BEGIN BOND")) &&
    index < lines.findIndex(c => c.includes("END BOND"))).length + 1;
  const out: string[] = [];
  for (const line of lines) {
    if (/^M\s+V30\s+COUNTS\s/.test(line)) {
      const parts = line.trim().split(/\s+/);
      parts[3] = String(atomCount);
      parts[4] = String(bondCount);
      out.push(`M  V30 ${parts.slice(2).join(" ")}`);
      continue;
    }
    if (line.includes("END ATOM")) out.push(`M  V30 ${atomCount} C ${Number(x) + 30} ${y} 0 0`);
    if (line.includes("END BOND")) out.push(`M  V30 ${bondCount} 1 ${nitrogenIndex} ${atomCount}`);
    out.push(line);
  }
  return out.join("\n");
}

/** N on methylamine charged by the charge tool, once per entry of `charges`. */
function chargedByTool(document: ChemDraftDocument, atomId: string, charges: Array<1 | -1>): ChemDraftDocument {
  return charges.reduce((current, charge) => normalizeCommittedDocument(applyChargeToolAtNativeAtom(current,
    { kind: "charge", charge }, { kind: "atom", objectId, atomId, distanceToPointer: 0 })), document);
}

function atomOf(document: ChemDraftDocument, atomId: string): MoleculeAtom {
  return moleculeOf(document).atoms.find(atom => atom.id === atomId)!;
}

function chargeState(document: ChemDraftDocument, atomId: string) {
  const atom = atomOf(document, atomId);
  return { formalCharge: atom.formalCharge, markCharge: atom.markCharge ?? 0, marks: marksOf(document).length };
}

/** The V3000 Ketcher returns with atoms `first` and `second` (1-based) trading places: a geometry-only edit. */
function swapAtomPositions(first: number, second: number): (v3000: string) => string {
  return v3000 => {
    const lines = v3000.split(/\r?\n/);
    const begin = lines.findIndex(line => line.includes("BEGIN ATOM"));
    const end = lines.findIndex(line => line.includes("END ATOM"));
    const find = (atom: number) => lines.findIndex((line, index) => index > begin && index < end &&
      new RegExp(`^M\\s+V30\\s+${atom}\\s`).test(line));
    const a = find(first), b = find(second);
    const partsA = lines[a]!.trim().split(/\s+/), partsB = lines[b]!.trim().split(/\s+/);
    // M V30 <index> <element> <x> <y> <z> ...
    [partsA[4], partsB[4], partsA[5], partsB[5]] = [partsB[4]!, partsA[4]!, partsB[5]!, partsA[5]!];
    lines[a] = `M  V30 ${partsA.slice(2).join(" ")}`;
    lines[b] = `M  V30 ${partsB.slice(2).join(" ")}`;
    return lines.join("\n");
  };
}

/** A V3000 as the editor writes it for these atoms (page px, y down) and 1-based bonds, all single. */
function editorV3000(atoms: ReadonlyArray<{ element: string; x: number; y: number }>, bonds: ReadonlyArray<[number, number]>): string {
  return [
    "-INDIGO-", "", "  0  0  0  0  0  0  0  0  0  0  0 V3000",
    "M  V30 BEGIN CTAB",
    `M  V30 COUNTS ${atoms.length} ${bonds.length} 0 0 0`,
    "M  V30 BEGIN ATOM",
    ...atoms.map((atom, index) => `M  V30 ${index + 1} ${atom.element} ${(atom.x / 30).toFixed(4)} ${(-atom.y / 30).toFixed(4)} 0.0 0`),
    "M  V30 END ATOM",
    "M  V30 BEGIN BOND",
    ...bonds.map(([from, to], index) => `M  V30 ${index + 1} 1 ${from} ${to}`),
    "M  V30 END BOND", "M  V30 END CTAB", "M  END"
  ].join("\n");
}

function markCenter(mark: ElectronMarkObject) {
  return { x: mark.x + mark.width / 2, y: mark.y + mark.height / 2 };
}

/** Where the mark sits relative to its atom: unchanged when the mark rode with the atom. */
function markOffset(document: ChemDraftDocument, mark: ElectronMarkObject, atomId: string) {
  const atom = atomOf(document, atomId), center = markCenter(mark);
  return { dx: center.x - atom.x, dy: center.y - atom.y };
}

function nitrogenLine(v3000: string): string {
  return v3000.split(/\r?\n/).find(line => /^M\s+V30\s+\d+\s+N\s/.test(line.trim())) ?? "";
}

/**
 * N+ whose + mark is a legacy loose mark: a point anchor and no explicit association, so commit
 * normalization associates it with N only by distance. Not normalized again, so it reaches the
 * editor save still loose (normalization would anchor it to N).
 */
function looseChargeOnNitrogen(plain: ChemDraftDocument, nitrogenId: string): ChemDraftDocument {
  const anchored = chargedByTool(plain, nitrogenId, [1]);
  const mark = marksOf(anchored)[0]!;
  const loose = applyPatch(anchored, { op: "updateObject", objectId: mark.id,
    changes: { anchor: { kind: "point", point: markCenter(mark) }, atomAssociation: undefined } });
  expect(marksOf(loose)[0]!.anchor).toEqual({ kind: "point", point: markCenter(mark) });
  expect(marksOf(loose)[0]!.atomAssociation).toBeUndefined();
  expect(chargeState(loose, nitrogenId)).toEqual({ formalCharge: 1, markCharge: 1, marks: 1 });
  expect(chargeState(normalizeCommittedDocument(loose), nitrogenId)).toEqual({ formalCharge: 1, markCharge: 1, marks: 1 });
  return loose;
}

describe("unchanged Ketcher save keeps charge and electron marks", () => {
  it("(a) N+ whose charge comes from an atom-anchored + mark stays +1 with exactly one + mark", () => {
    const { document: plain, nitrogenId } = methylamine();
    const charged = normalizeCommittedDocument(applyChargeToolAtNativeAtom(plain, { kind: "charge", charge: 1 },
      { kind: "atom", objectId, atomId: nitrogenId, distanceToPointer: 0 }));
    // Precondition: the charge is mark-derived.
    expect(nitrogenOf(charged, nitrogenId)).toMatchObject({ formalCharge: 1, markCharge: 1 });
    expect(marksOf(charged)).toHaveLength(1);
    expect(marksOf(charged)[0].anchor).toMatchObject({ kind: "atom", atomId: nitrogenId });

    const { opened, v3000, committed } = unchangedKetcherSave(charged);

    // What Ketcher is given: a stored SMILES carrying the total charge, so it returns CHG=1.
    expect(opened.structureFormat).toBe("smiles");
    expect(opened.structure).toMatch(/\[N[^\]]*\+\]/);
    expect(nitrogenLine(v3000)).toContain("CHG=1");

    const nitrogen = nitrogenOf(committed, nitrogenId);
    expect({ formalCharge: nitrogen.formalCharge, markCharge: nitrogen.markCharge ?? 0, marks: marksOf(committed).length })
      .toEqual({ formalCharge: 1, markCharge: 1, marks: 1 });
    expect(marksOf(committed)[0]).toMatchObject({ markKind: "charge", charge: 1 });
  });

  it("(b) the same with a legacy loose + mark that only associates by distance", () => {
    const { document: plain, nitrogenId } = methylamine();
    const loose = looseChargeOnNitrogen(plain, nitrogenId);

    const { v3000, committed } = unchangedKetcherSave(loose);
    expect(nitrogenLine(v3000)).toContain("CHG=1");

    const nitrogen = nitrogenOf(committed, nitrogenId);
    expect({ formalCharge: nitrogen.formalCharge, markCharge: nitrogen.markCharge ?? 0, marks: marksOf(committed).length })
      .toEqual({ formalCharge: 1, markCharge: 1, marks: 1 });
  });

  it("(c) a plain formalCharge +1 on N with no mark stays +1 and no mark is invented", () => {
    const { document: plain, nitrogenId } = methylamine();
    const molecule = moleculeOf(plain);
    const atoms = molecule.atoms.map(atom => atom.id === nitrogenId ? { ...atom, formalCharge: 1 } : atom);
    const charged = normalizeCommittedDocument(applyPatch(plain, { op: "updateObject", objectId,
      changes: {
        atoms,
        structure: nativeSingleBondGraphSmiles(atoms, molecule.bonds),
        chemistry: nativeSingleBondGraphMetadata(atoms, molecule.bonds)
      } }));
    expect(nitrogenOf(charged, nitrogenId)).toMatchObject({ formalCharge: 1 });
    expect(nitrogenOf(charged, nitrogenId).markCharge ?? 0).toBe(0);
    expect(marksOf(charged)).toHaveLength(0);

    const { v3000, committed } = unchangedKetcherSave(charged);
    expect(nitrogenLine(v3000)).toContain("CHG=1");

    const nitrogen = nitrogenOf(committed, nitrogenId);
    expect({ formalCharge: nitrogen.formalCharge, markCharge: nitrogen.markCharge ?? 0, marks: marksOf(committed).length })
      .toEqual({ formalCharge: 1, markCharge: 0, marks: 0 });
  });

  it("(d) a radical mark on N keeps its one unpaired electron and adds no charge", () => {
    const { document: plain, nitrogenId } = methylamine();
    const radical = normalizeCommittedDocument(applyChargeToolAtNativeAtom(plain, { kind: "radical-dot" },
      { kind: "atom", objectId, atomId: nitrogenId, distanceToPointer: 0 }));
    expect(nitrogenOf(radical, nitrogenId)).toMatchObject({ formalCharge: 0, markRadicals: 1 });
    expect(marksOf(radical)).toHaveLength(1);

    const { committed } = unchangedKetcherSave(radical);

    const nitrogen = nitrogenOf(committed, nitrogenId);
    expect({
      formalCharge: nitrogen.formalCharge, markCharge: nitrogen.markCharge ?? 0,
      markRadicals: nitrogen.markRadicals ?? 0, marks: marksOf(committed).length
    }).toEqual({ formalCharge: 0, markCharge: 0, markRadicals: 1, marks: 1 });
  });

  it("(e) N with a plain +1 and a + mark on top stays 2+, one + of it from the one mark", () => {
    const { document: plain, nitrogenId } = methylamine();
    const molecule = moleculeOf(plain);
    const atoms = molecule.atoms.map(atom => atom.id === nitrogenId ? { ...atom, formalCharge: 1 } : atom);
    const intrinsic = normalizeCommittedDocument(applyPatch(plain, { op: "updateObject", objectId,
      changes: {
        atoms,
        structure: nativeSingleBondGraphSmiles(atoms, molecule.bonds),
        chemistry: nativeSingleBondGraphMetadata(atoms, molecule.bonds)
      } }));
    const charged = chargedByTool(intrinsic, nitrogenId, [1]);
    expect(chargeState(charged, nitrogenId)).toEqual({ formalCharge: 2, markCharge: 1, marks: 1 });

    const { v3000, committed } = unchangedKetcherSave(charged);
    expect(nitrogenLine(v3000)).toContain("CHG=2");
    expect(chargeState(committed, nitrogenId)).toEqual({ formalCharge: 2, markCharge: 1, marks: 1 });
    expect(marksOf(committed)[0]).toMatchObject({ markKind: "charge", charge: 1 });
  });

  it("(f) C- whose charge comes from a minus mark stays -1 with its one mark", () => {
    const { document: plain } = methylamine();
    const carbonId = moleculeOf(plain).atoms.find(atom => atom.element === "C")!.id;
    const charged = chargedByTool(plain, carbonId, [-1]);
    expect(chargeState(charged, carbonId)).toEqual({ formalCharge: -1, markCharge: -1, marks: 1 });

    const { v3000, committed } = unchangedKetcherSave(charged);
    expect(v3000).toContain("CHG=-1");
    expect(chargeState(committed, carbonId)).toEqual({ formalCharge: -1, markCharge: -1, marks: 1 });
    expect(marksOf(committed)[0]).toMatchObject({ markKind: "charge", charge: -1 });
  });

  it("(g) a methyl added on the marked N in Ketcher is refused (ids are reused by index), document unchanged", () => {
    const { document: plain, nitrogenId } = methylamine();
    const charged = chargedByTool(plain, nitrogenId, [1]);
    expect(chargeState(charged, nitrogenId)).toEqual({ formalCharge: 1, markCharge: 1, marks: 1 });

    const { v3000, selected, refusal } = editedKetcherSave(charged, appendMethylOnNitrogen);
    expect(nitrogenLine(v3000)).toContain("CHG=1");
    expect(refusal).toBe(EDITOR_SAVE_MARK_SHIFT_REFUSAL);
    expect(moleculeOf(selected).atoms).toHaveLength(2);
    expect(chargeState(selected, nitrogenId)).toEqual({ formalCharge: 1, markCharge: 1, marks: 1 });
  });

  it("(g2) a bond order changed in Ketcher (C-N to C=N) keeps N's mark-derived +1 and its mark", () => {
    const { document: plain, nitrogenId } = methylamine();
    const charged = chargedByTool(plain, nitrogenId, [1]);
    const { v3000, committed } = editedKetcherSave(charged, molfile =>
      molfile.replace(/^(M\s+V30\s+1\s+)1(\s+1\s+2)\s*$/m, "$12$2"));
    expect(v3000).toMatch(/^M\s+V30\s+1\s+2\s+1\s+2\s*$/m);
    expect(moleculeOf(committed).bonds[0].order).toBe("double");
    expect(chargeState(committed, nitrogenId)).toEqual({ formalCharge: 1, markCharge: 1, marks: 1 });
    expect(marksOf(committed)[0]).toMatchObject({ markKind: "charge", charge: 1, anchor: { kind: "atom", atomId: nitrogenId } });
  });

  it("(i) deleting the marked N in Ketcher is refused, leaving the molecule and its + mark unchanged", () => {
    const { document: plain, nitrogenId } = methylamine();
    const charged = chargedByTool(plain, nitrogenId, [1]);
    const { selected, refusal } = editedKetcherSave(charged, molfile => molfile.split(/\r?\n/)
      .filter(line => !/^M\s+V30\s+2\s+N\s/.test(line) && !/^M\s+V30\s+1\s+1\s+1\s+2\s*$/.test(line))
      .map(line => line.replace(/^(M\s+V30\s+COUNTS\s+)2\s+1\b/, "$11 0")).join("\n"));
    expect(refusal).toBe(EDITOR_SAVE_MARK_SHIFT_REFUSAL);
    expect(moleculeOf(selected).atoms.map(atom => atom.element)).toEqual(["C", "N"]);
    expect(chargeState(selected, nitrogenId)).toEqual({ formalCharge: 1, markCharge: 1, marks: 1 });
  });

  it("(h1) N 2+ from the charge tool applied twice (one stacked 2+ mark) stays 2+", () => {
    const { document: plain, nitrogenId } = methylamine();
    const charged = chargedByTool(plain, nitrogenId, [1, 1]);
    expect(chargeState(charged, nitrogenId)).toEqual({ formalCharge: 2, markCharge: 2, marks: 1 });

    const { v3000, committed } = unchangedKetcherSave(charged);
    expect(nitrogenLine(v3000)).toContain("CHG=2");
    expect(chargeState(committed, nitrogenId)).toEqual({ formalCharge: 2, markCharge: 2, marks: 1 });
    expect(marksOf(committed)[0]).toMatchObject({ markKind: "charge", charge: 2 });
  });

  it("(h2) N 2+ from two separate + marks on it stays 2+ with both marks", () => {
    const { document: plain, nitrogenId } = methylamine();
    const once = chargedByTool(plain, nitrogenId, [1]);
    const first = marksOf(once)[0];
    // The tool stacks rather than placing a second mark, so the second + is a copy of the first
    // (as a paste or an older file would leave it), anchored to the same N.
    const twice = normalizeCommittedDocument(applyPatch(once, { op: "addObject", pageId: once.pages[0].id,
      object: { ...first, id: `${first.id}_second`, y: first.y + first.height } }));
    expect(chargeState(twice, nitrogenId)).toEqual({ formalCharge: 2, markCharge: 2, marks: 2 });

    const { v3000, committed } = unchangedKetcherSave(twice);
    expect(nitrogenLine(v3000)).toContain("CHG=2");
    expect(chargeState(committed, nitrogenId)).toEqual({ formalCharge: 2, markCharge: 2, marks: 2 });
  });
});

describe("a Ketcher charge that contradicts a charge mark still on the atom", () => {
  function plusMarkedNitrogen() {
    const { document: plain, nitrogenId } = methylamine();
    const charged = chargedByTool(plain, nitrogenId, [1]);
    expect(chargeState(charged, nitrogenId)).toEqual({ formalCharge: 1, markCharge: 1, marks: 1 });
    // Methylamine is C then N, so N is atom 2 (Ketcher's own numbering of the molecule).
    expect(moleculeOf(charged).atoms.map(atom => atom.element)).toEqual(["C", "N"]);
    return { charged, nitrogenId };
  }

  function minusMarkedCarbon() {
    const { document: plain } = methylamine();
    const carbonId = moleculeOf(plain).atoms.find(atom => atom.element === "C")!.id;
    const charged = chargedByTool(plain, carbonId, [-1]);
    expect(chargeState(charged, carbonId)).toEqual({ formalCharge: -1, markCharge: -1, marks: 1 });
    return { charged, carbonId };
  }

  it("refuses N's charge cleared in Ketcher while its + mark stays, naming the atom; document unchanged", () => {
    const { charged, nitrogenId } = plusMarkedNitrogen();
    const { v3000, selected, refusal } = editedKetcherSave(charged, withCharge("N", 0));
    expect(nitrogenLine(v3000)).not.toContain("CHG=");
    expect(refusal).toBe(editorSaveChargeContradictsMarkRefusal("N", 2));
    expect(refusal).toBe("Ketcher changed the charge on N atom 2 but its charge mark is still on the canvas. Remove or move the charge mark on the canvas first.");
    expect(chargeState(selected, nitrogenId)).toEqual({ formalCharge: 1, markCharge: 1, marks: 1 });
  });

  it("refuses a negative charge set in Ketcher on a + marked N", () => {
    const { charged, nitrogenId } = plusMarkedNitrogen();
    const { v3000, selected, refusal } = editedKetcherSave(charged, withCharge("N", -1));
    expect(nitrogenLine(v3000)).toContain("CHG=-1");
    expect(refusal).toBe(editorSaveChargeContradictsMarkRefusal("N", 2));
    expect(chargeState(selected, nitrogenId)).toEqual({ formalCharge: 1, markCharge: 1, marks: 1 });
  });

  it("commits N with a + mark raised to 2+ in Ketcher: total 2, one + of it from the one mark", () => {
    const { charged, nitrogenId } = plusMarkedNitrogen();
    const { v3000, refusal, committed } = editedKetcherSave(charged, withCharge("N", 2));
    expect(nitrogenLine(v3000)).toContain("CHG=2");
    expect(refusal).toBeUndefined();
    expect(chargeState(committed, nitrogenId)).toEqual({ formalCharge: 2, markCharge: 1, marks: 1 });
    expect(marksOf(committed)[0]).toMatchObject({ markKind: "charge", charge: 1 });
  });

  it("commits C with a - mark lowered to 2- in Ketcher: total -2, one - of it from the one mark", () => {
    const { charged, carbonId } = minusMarkedCarbon();
    const { refusal, committed } = editedKetcherSave(charged, withCharge("C", -2));
    expect(refusal).toBeUndefined();
    expect(chargeState(committed, carbonId)).toEqual({ formalCharge: -2, markCharge: -1, marks: 1 });
    expect(marksOf(committed)[0]).toMatchObject({ markKind: "charge", charge: -1 });
  });

  it.each([0, 1])("refuses C with a - mark set to CHG %i in Ketcher, naming the atom", (charge) => {
    const { charged, carbonId } = minusMarkedCarbon();
    const { selected, refusal } = editedKetcherSave(charged, withCharge("C", charge));
    expect(refusal).toBe(editorSaveChargeContradictsMarkRefusal("C", 1));
    expect(chargeState(selected, carbonId)).toEqual({ formalCharge: -1, markCharge: -1, marks: 1 });
  });
});

describe("a Ketcher save keeps every charge and radical mark on its atom", () => {
  const carbonIdOf = (document: ChemDraftDocument) => moleculeOf(document).atoms.find(atom => atom.element === "C")!.id;

  it("a bond-anchored radical on N follows N when C and N trade places in Ketcher", () => {
    const { document: plain, nitrogenId } = methylamine();
    const anchored = normalizeCommittedDocument(applyChargeToolAtNativeAtom(plain, { kind: "radical-dot" },
      { kind: "atom", objectId, atomId: nitrogenId, distanceToPointer: 0 }));
    const mark = marksOf(anchored)[0]!;
    const bond = moleculeOf(anchored).bonds[0]!;
    // A legacy bond-anchored radical: normalization resolves it to N by distance.
    const radical = normalizeCommittedDocument(applyPatch(anchored, { op: "updateObject", objectId: mark.id,
      changes: { anchor: { kind: "bond", objectId, bondId: bond.id }, atomAssociation: undefined } }));
    expect(marksOf(radical)[0]!.anchor).toMatchObject({ kind: "bond", bondId: bond.id });
    expect(nitrogenOf(radical, nitrogenId)).toMatchObject({ formalCharge: 0, markRadicals: 1 });
    const offsetBefore = markOffset(radical, marksOf(radical)[0]!, nitrogenId);

    const { refusal, committed } = editedKetcherSave(radical, swapAtomPositions(1, 2));
    expect(refusal).toBeUndefined();
    const carbonId = carbonIdOf(committed);
    // N really moved: it now sits where C was.
    expect(nitrogenOf(committed, nitrogenId).x).toBeLessThan(atomOf(committed, carbonId).x);
    expect(nitrogenOf(committed, nitrogenId).markRadicals ?? 0).toBe(1);
    expect(atomOf(committed, carbonId).markRadicals ?? 0).toBe(0);
    expect(marksOf(committed)).toHaveLength(1);
    const after = marksOf(committed)[0]!;
    expect(after.anchor).toMatchObject({ kind: "atom", objectId, atomId: nitrogenId });
    const offsetAfter = markOffset(committed, after, nitrogenId);
    expect(offsetAfter.dx).toBeCloseTo(offsetBefore.dx, 6);
    expect(offsetAfter.dy).toBeCloseTo(offsetBefore.dy, 6);
  });

  it("a legacy loose + mark on N follows N when C and N trade places in Ketcher", () => {
    const { document: plain, nitrogenId } = methylamine();
    const loose = looseChargeOnNitrogen(plain, nitrogenId);
    const offsetBefore = markOffset(loose, marksOf(loose)[0]!, nitrogenId);

    const { v3000, refusal, committed } = editedKetcherSave(loose, swapAtomPositions(1, 2));
    expect(nitrogenLine(v3000)).toContain("CHG=1");
    expect(refusal).toBeUndefined();
    const carbonId = carbonIdOf(committed);
    expect(chargeState(committed, nitrogenId)).toEqual({ formalCharge: 1, markCharge: 1, marks: 1 });
    expect(chargeState(committed, carbonId)).toEqual({ formalCharge: 0, markCharge: 0, marks: 1 });
    const after = marksOf(committed)[0]!;
    expect(after.anchor).toMatchObject({ kind: "atom", objectId, atomId: nitrogenId });
    const offsetAfter = markOffset(committed, after, nitrogenId);
    expect(offsetAfter.dx).toBeCloseTo(offsetBefore.dx, 6);
    expect(offsetAfter.dy).toBeCloseTo(offsetBefore.dy, 6);
  });
});

describe("the Ketcher id-shift guard on a molecule with a radical", () => {
  function radicalOn(smiles: string, atom: number) {
    const { document: plain, atomIds } = linearMolecule(smiles);
    const document = normalizeCommittedDocument(applyChargeToolAtNativeAtom(plain, { kind: "radical-dot" },
      { kind: "atom", objectId, atomId: atomIds[atom]!, distanceToPointer: 0 }));
    expect(atomOf(document, atomIds[atom]!).markRadicals).toBe(1);
    return { document, atomIds };
  }

  it("refuses a delete-and-re-add that keeps every count, element and the marked atom's neighbour elements", () => {
    // C1-C2(radical)-C3-C4: C1 deleted, a new carbon drawn on C2. By index the ids now name
    // C2, C3, C4 and the new carbon, so the radical's id names C3; only the bond graph shows it.
    const { document, atomIds } = radicalOn("CCCC", 1);
    const atoms = moleculeOf(document).atoms;
    const [, c2, c3, c4] = atoms;
    const v3000 = editorV3000([c2!, c3!, c4!, { element: "C", x: c2!.x, y: c2!.y + 30 }], [[1, 2], [2, 3], [1, 4]]);
    const { selected, refusal } = editedKetcherSave(document, () => v3000);
    expect(refusal).toBe(EDITOR_SAVE_MARK_SHIFT_REFUSAL);
    expect(moleculeOf(selected).atoms.map(atom => atom.id)).toEqual(atomIds);
    expect(atomOf(selected, atomIds[1]!).markRadicals).toBe(1);
  });

  it("commits an element change far from the radical, which stays on its atom", () => {
    const { document, atomIds } = radicalOn("CCCCC", 0);
    const { refusal, committed } = editedKetcherSave(document, molfile =>
      molfile.replace(/^(M\s+V30\s+5\s+)C(\s)/m, "$1N$2"));
    expect(refusal).toBeUndefined();
    expect(moleculeOf(committed).atoms.map(atom => atom.element)).toEqual(["C", "C", "C", "C", "N"]);
    expect(atomOf(committed, atomIds[0]!).markRadicals).toBe(1);
    expect(marksOf(committed)[0]!.anchor).toMatchObject({ kind: "atom", atomId: atomIds[0] });
  });

  it("still refuses an element change on a direct neighbour of the radical's atom", () => {
    const { document } = radicalOn("CCCCC", 0);
    const { refusal } = editedKetcherSave(document, molfile => molfile.replace(/^(M\s+V30\s+2\s+)C(\s)/m, "$1N$2"));
    expect(refusal).toBe(EDITOR_SAVE_MARK_SHIFT_REFUSAL);
  });
});

describe("an unchanged charge under a mark always commits", () => {
  it("N with an intrinsic -1 and a + mark (total 0) survives an unchanged save", () => {
    const { document: plain, nitrogenId } = methylamine();
    const molecule = moleculeOf(plain);
    const atoms = molecule.atoms.map(atom => atom.id === nitrogenId ? { ...atom, formalCharge: -1 } : atom);
    const intrinsic = normalizeCommittedDocument(applyPatch(plain, { op: "updateObject", objectId,
      changes: {
        atoms,
        structure: nativeSingleBondGraphSmiles(atoms, molecule.bonds),
        chemistry: nativeSingleBondGraphMetadata(atoms, molecule.bonds)
      } }));
    const charged = chargedByTool(intrinsic, nitrogenId, [1]);
    expect(chargeState(charged, nitrogenId)).toEqual({ formalCharge: 0, markCharge: 1, marks: 1 });

    const { v3000, refusal, committed } = editedKetcherSave(charged, molfile => molfile);
    expect(nitrogenLine(v3000)).not.toContain("CHG=");
    expect(refusal).toBeUndefined();
    expect(chargeState(committed, nitrogenId)).toEqual({ formalCharge: 0, markCharge: 1, marks: 1 });
  });
});
