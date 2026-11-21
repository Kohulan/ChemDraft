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
  const graph = testMoleculeFromSmiles("CN");
  const atoms: MoleculeAtom[] = graph.atoms.map((atom, index) => ({ ...atom, x: 100 + index * 30, y: 100 }));
  const molecule: MoleculeObject = {
    id: objectId, type: "molecule", x: 90, y: 80, width: 60, height: 40, rotation: 0, style: {},
    atoms, bonds: graph.bonds, structureFormat: "smiles",
    structure: nativeSingleBondGraphSmiles(atoms, graph.bonds),
    chemistry: nativeSingleBondGraphMetadata(atoms, graph.bonds),
    superatoms: [], rGroups: []
  };
  const nitrogen = atoms.find(atom => atom.element === "N")!;
  const document = applyPatch(createPhase4Document("Ketcher charge round trip"),
    { op: "addObject", pageId: createPhase4Document().pages[0].id, object: molecule });
  return { document: normalizeCommittedDocument(document), nitrogenId: nitrogen.id };
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

function nitrogenLine(v3000: string): string {
  return v3000.split(/\r?\n/).find(line => /^M\s+V30\s+\d+\s+N\s/.test(line.trim())) ?? "";
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
    const anchored = normalizeCommittedDocument(applyChargeToolAtNativeAtom(plain, { kind: "charge", charge: 1 },
      { kind: "atom", objectId, atomId: nitrogenId, distanceToPointer: 0 }));
    const mark = marksOf(anchored)[0];
    const center = { x: mark.x + mark.width / 2, y: mark.y + mark.height / 2 };
    // A legacy mark: a floating point anchor and no explicit association; commit normalization
    // associates it with N by distance and derives markCharge from that.
    const loose = normalizeCommittedDocument(applyPatch(anchored, { op: "updateObject", objectId: mark.id,
      changes: { anchor: { kind: "point", point: center }, atomAssociation: undefined } }));
    expect(nitrogenOf(loose, nitrogenId)).toMatchObject({ formalCharge: 1, markCharge: 1 });
    expect(marksOf(loose)).toHaveLength(1);

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
