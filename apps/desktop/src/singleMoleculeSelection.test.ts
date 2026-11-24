// The shared "is a single molecule selected?" check that Spin 3D, its conformer prefetch, 3D cleanup
// and Interactive 3D read. A molecule selected with only its own marks counts as that molecule (a
// marquee around a charged molecule selects both); a selected mark the molecule cannot carry is named.
import { describe, expect, it } from "vitest";
import { applyPatch, applyPatches, type ChemDraftDocument } from "@chemdraft/chem-core";
import { phase4Timestamp } from "@chemdraft/document-workflow-core";
import * as workflow from "./documentWorkflow";
import { dropMark, dropMolecule, electronMarkDropFixture } from "./testSupport/electronMarkDropFixture";

const select = (document: ChemDraftDocument, objectIds: string[]) =>
  workflow.selectDocumentObjects(document, document.pages[0].id, objectIds);

/** A second, uncharged molecule well away from the charged one. */
function withSecondMolecule(document: ChemDraftDocument) {
  const second = workflow.createNativeTemplateMolecule(document, { x: 500, y: 450 }, "benzene");
  return { document: applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: second }],
    { now: phase4Timestamp }), secondId: second.id };
}

describe("singleMoleculeSelection", () => {
  it("counts one molecule plus its own atom-anchored charge as that molecule", () => {
    const { document } = electronMarkDropFixture();
    const molecule = dropMolecule(document), mark = dropMark(document);
    expect(mark.anchor).toMatchObject({ kind: "atom", objectId: molecule.id });
    for (const objectIds of [[molecule.id, mark.id], [mark.id, molecule.id]]) {
      expect(workflow.singleMoleculeSelection(select(document, objectIds)))
        .toEqual({ objectIds: [molecule.id], uncarriedMarkIds: [] });
    }
  });

  it.each([{ kind: "radical-dot" } as const, { kind: "lone-pair" } as const])("counts its own %o mark too", spec => {
    const { document } = electronMarkDropFixture(spec);
    const molecule = dropMolecule(document), mark = dropMark(document);
    expect(workflow.singleMoleculeSelection(select(document, [molecule.id, mark.id])).objectIds).toEqual([molecule.id]);
  });

  // A mark without an atom anchor is assigned to an atom by proximity. Opening a file keeps stored
  // marks as they are (`preserveElectronMarks`, as MainWindow's open path does), so a legacy loose
  // charge is still point-anchored when Spin 3D reads the selection; a bond- or object-anchored mark
  // keeps that anchor even through full commit normalization.
  it("counts a legacy loose charge, as an opened file keeps it, that belongs to one of the molecule's atoms", () => {
    const { document, nitrogen } = electronMarkDropFixture();
    const molecule = dropMolecule(document), mark = dropMark(document);
    // A point-anchored mark one bond length below N: N is the only atom within the association radius.
    const center = { x: nitrogen.x, y: nitrogen.y + 22 };
    const opened = workflow.normalizeCommittedDocument(applyPatch(document, { op: "updateObject", objectId: mark.id,
      changes: { anchor: { kind: "point", point: center }, atomAssociation: undefined,
        x: center.x - mark.width / 2, y: center.y - mark.height / 2 } }, { now: phase4Timestamp }),
      { preserveElectronMarks: true });
    expect(dropMark(opened).anchor.kind).toBe("point");
    expect(workflow.singleMoleculeSelection(select(opened, [molecule.id, mark.id])))
      .toEqual({ objectIds: [molecule.id], uncarriedMarkIds: [] });
  });

  it("counts a legacy bond-anchored charge on one of the molecule's atoms after commit normalization", () => {
    const { document, nitrogen } = electronMarkDropFixture();
    const molecule = dropMolecule(document), mark = dropMark(document);
    const bond = molecule.bonds.find(candidate => candidate.fromAtomId === nitrogen.id || candidate.toAtomId === nitrogen.id)!;
    const legacy = workflow.normalizeCommittedDocument(applyPatch(document, { op: "updateObject", objectId: mark.id,
      changes: { anchor: { kind: "bond", objectId: molecule.id, bondId: bond.id }, atomAssociation: undefined,
        x: nitrogen.x - mark.width / 2, y: nitrogen.y - mark.height / 2 } }, { now: phase4Timestamp }));
    expect(dropMark(legacy).anchor.kind).toBe("bond");
    expect(workflow.singleMoleculeSelection(select(legacy, [molecule.id, mark.id])))
      .toEqual({ objectIds: [molecule.id], uncarriedMarkIds: [] });
  });

  it("keeps the original reading for a plain molecule, an empty selection, a lone mark and two molecules", () => {
    const { document: charged } = electronMarkDropFixture();
    const { document, secondId } = withSecondMolecule(charged);
    const molecule = dropMolecule(document), mark = dropMark(document);
    expect(workflow.singleMoleculeSelection(select(document, [molecule.id])))
      .toEqual({ objectIds: [molecule.id], uncarriedMarkIds: [] });
    expect(workflow.singleMoleculeSelection(select(document, []))).toEqual({ objectIds: [], uncarriedMarkIds: [] });
    expect(workflow.singleMoleculeSelection(select(document, [mark.id]))).toEqual({ objectIds: [mark.id], uncarriedMarkIds: [] });
    expect(workflow.singleMoleculeSelection(select(document, [molecule.id, secondId, mark.id])))
      .toEqual({ objectIds: [molecule.id, secondId, mark.id], uncarriedMarkIds: [] });
  });

  it("folds a native part's host molecule in, alone or with the molecule's mark", () => {
    const { document } = electronMarkDropFixture();
    const molecule = dropMolecule(document), mark = dropMark(document);
    expect(workflow.singleMoleculeSelection(select(document, []), [molecule.id]).objectIds).toEqual([molecule.id]);
    expect(workflow.singleMoleculeSelection(select(document, [mark.id]), [molecule.id]).objectIds).toEqual([molecule.id]);
  });

  it("names a selected mark the molecule does not carry: one on another molecule's atom", () => {
    const { document: charged } = electronMarkDropFixture();
    const { document, secondId } = withSecondMolecule(charged);
    const mark = dropMark(document);
    const selection = workflow.singleMoleculeSelection(select(document, [secondId, mark.id]));
    expect(selection).toEqual({ objectIds: [secondId, mark.id], uncarriedMarkIds: [mark.id] });
  });

  it("names a selected floating mark", () => {
    const { document } = electronMarkDropFixture();
    const molecule = dropMolecule(document), mark = dropMark(document);
    const floating = workflow.normalizeCommittedDocument(applyPatch(document, { op: "updateObject", objectId: mark.id,
      changes: { anchor: { kind: "point", point: { x: 600, y: 500 } }, atomAssociation: "explicit",
        x: 600 - mark.width / 2, y: 500 - mark.height / 2 } }, { now: phase4Timestamp }));
    expect(workflow.singleMoleculeSelection(select(floating, [molecule.id, mark.id])))
      .toEqual({ objectIds: [molecule.id, mark.id], uncarriedMarkIds: [mark.id] });
  });

  it("phrases the refusal for one mark and for several", () => {
    expect(workflow.uncarriedMarksRefusal("Spin 3D", 1)).toBe(
      "Spin 3D cannot keep the selected mark on an atom of this molecule. Deselect the mark, or move it onto one of the molecule's atoms.");
    expect(workflow.uncarriedMarksRefusal("Spin 3D", 2)).toMatch(/^Spin 3D cannot keep 2 selected marks/);
  });
});
