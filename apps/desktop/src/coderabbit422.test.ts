// CodeRabbit review of the 1.2.2 PR (#422): charge and radical mark handling. Each claim is pinned by a
// test through the workflow functions the app calls. A claim that reproduces is `it.fails` (the fix
// removes `.fails`); a claim that does not reproduce asserts the correct behaviour and passes.
import { describe, expect, it } from "vitest";
import { applyPatch, applyPatches, type ChemDraftDocument, type ElectronMarkObject, type MoleculeAtom,
  type MoleculeObject } from "@chemdraft/chem-core";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { moleculeLayoutLabelBoxes, transformPointForObject } from "@chemdraft/layout-engine";
import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles, phase4Timestamp } from "@chemdraft/document-workflow-core";
import { moleculeToMolfileV3000 } from "@chemdraft/chem-core";
import { commitChemistryRefusals, moleculeAtomChemistryChanges, policyChemistryRefusals, preexistingMoleculeChemistryChanges,
  selectionTransformChemistry } from "./commitChemistryGuard";
import * as workflow from "./documentWorkflow";
import { resolveElectronMarksAfterMoleculePartMove, resolveElectronMarksInSelectionTransform } from "./electronMarkDrop";
import { nativeStylePresetPatchForSelection } from "./nativeStylePresetCommand";
import { ammoniumElectronMarkDropFixture, dropMark, dropMolecule, electronMarkDropFixture } from "./testSupport/electronMarkDropFixture";

const markAtoms = workflow.committedElectronMarkAtoms;
const normalize = workflow.normalizeCommittedDocument;
const identity = (document: ChemDraftDocument) => document;
const RADIUS = 22 * 1.15;

const moleculeOn = (document: ChemDraftDocument, pageId: string, id: string) =>
  document.pages.find(page => page.id === pageId)!.objects.find((object): object is MoleculeObject =>
    object.type === "molecule" && object.id === id)!;
const moleculeById = (document: ChemDraftDocument, id: string) => moleculeOn(document, document.pages[0].id, id);
const atomOf = (document: ChemDraftDocument, moleculeId: string, atomId: string) =>
  moleculeById(document, moleculeId).atoms.find(atom => atom.id === atomId)!;
const markById = (document: ChemDraftDocument, id: string) =>
  document.pages[0].objects.find((object): object is ElectronMarkObject => object.type === "electron-mark" && object.id === id)!;

/** A neutral ethane, first atom at `at`. */
function ethane(id: string, at: { x: number; y: number }): MoleculeObject {
  const graph = testMoleculeFromSmiles("CC");
  const atoms = graph.atoms.map((atom, index) => ({ ...atom, x: at.x + index * 22, y: at.y }));
  return { id, type: "molecule", x: at.x, y: at.y, width: 22, height: 0, rotation: 0, style: {}, atoms, bonds: graph.bonds,
    structureFormat: "smiles", structure: nativeSingleBondGraphSmiles(atoms, graph.bonds),
    chemistry: nativeSingleBondGraphMetadata(atoms, graph.bonds), superatoms: [], rGroups: [] };
}

const withMolecule = (document: ChemDraftDocument, molecule: MoleculeObject) =>
  applyPatch(document, { op: "addObject", pageId: document.pages[0].id, object: molecule }, { now: phase4Timestamp });

function translated(molecule: MoleculeObject, dx: number, dy: number): Partial<MoleculeObject> {
  return { x: molecule.x + dx, y: molecule.y + dy, atoms: molecule.atoms.map(atom => ({ ...atom, x: atom.x + dx, y: atom.y + dy })) };
}

// ---------------------------------------------------------------------------------------------
// A: commitChemistryGuard.ts:182 — a removed molecule matched to a same-id survivor on another page
// ---------------------------------------------------------------------------------------------
describe("A: cross-page same-id molecule match", () => {
  it("A: reports a molecule removed from page 1 while a same-id twin survives on page 2", () => {
    const { document } = electronMarkDropFixture();
    const molecule = dropMolecule(document);
    const twoPages: ChemDraftDocument = { ...document, pages: [document.pages[0],
      { ...document.pages[0], id: "page_two", objects: [molecule] }] };
    // Only page 1's molecule is removed; page 2's twin (same id, same atoms, same chemistry) stays.
    const removed: ChemDraftDocument = { ...twoPages, pages: [{ ...twoPages.pages[0],
      objects: twoPages.pages[0].objects.filter(object => object.id !== molecule.id) }, twoPages.pages[1]] };
    expect(preexistingMoleculeChemistryChanges(twoPages, removed)).toEqual([{ pageId: document.pages[0].id, moleculeId: molecule.id }]);
    expect(commitChemistryRefusals({ before: twoPages, next: removed, after: removed, normalize: identity, markAtoms })).toHaveLength(1);
  });

  it("A (convergence): two same-id sources on pages A and B never both match one new same-id molecule on page C", () => {
    const { document } = electronMarkDropFixture();
    const molecule = dropMolecule(document);
    const pageA = document.pages[0];
    const before: ChemDraftDocument = { ...document, pages: [pageA,
      { ...pageA, id: "page_b", objects: [molecule] }, { ...pageA, id: "page_c", objects: [] }] };
    // Afterwards neither A nor B holds "m"; only C does, newly. At most one source moved there.
    const after: ChemDraftDocument = { ...before, pages: [
      { ...pageA, objects: pageA.objects.filter(object => object.id !== molecule.id) },
      { ...before.pages[1], objects: [] }, { ...before.pages[2], objects: [molecule] }] };
    const changes = preexistingMoleculeChemistryChanges(before, after);
    const removals = changes.filter(change => change.atomId === undefined);
    expect(removals.length).toBeGreaterThanOrEqual(1);
    expect(removals.every(change => change.moleculeId === molecule.id)).toBe(true);
    expect(commitChemistryRefusals({ before, next: after, after, normalize: identity, markAtoms }).length).toBeGreaterThanOrEqual(1);
    // Control: one source moving to one new page is a move, not a removal.
    const moveOnly: ChemDraftDocument = { ...before, pages: [before.pages[0], { ...before.pages[1], objects: [] },
      { ...before.pages[2], objects: [molecule] }] };
    expect(preexistingMoleculeChemistryChanges(before, moveOnly)).toEqual([]);
  });

  /** Page A holds the fixture's molecule and an ethane "m"; pages B and C start empty. */
  function threePagesWithEthane() {
    const { document } = electronMarkDropFixture();
    const pageA = document.pages[0];
    const m = ethane("m", { x: 420, y: 400 });
    const before: ChemDraftDocument = { ...document, pages: [{ ...pageA, objects: [...pageA.objects, m] },
      { ...pageA, id: "page_b", objects: [] }, { ...pageA, id: "page_c", objects: [] }] };
    return { before, pageA: before.pages[0], m };
  }

  it("A (multiple arrivals): A's m moves to B while a different same-id m arrives on C — no removal", () => {
    const { before, pageA, m } = threePagesWithEthane();
    const other = { ...ethane("m", { x: 100, y: 100 }), atoms: ethane("m", { x: 100, y: 100 }).atoms.map(atom => ({ ...atom, id: `${atom.id}_other` })) };
    const after: ChemDraftDocument = { ...before, pages: [{ ...pageA, objects: pageA.objects.filter(object => object.id !== "m") },
      { ...before.pages[1], objects: [m] }, { ...before.pages[2], objects: [other] }] };
    expect(preexistingMoleculeChemistryChanges(before, after)).toEqual([]);
    expect(commitChemistryRefusals({ before, next: after, after, normalize: identity, markAtoms })).toEqual([]);
  });

  it("A (multiple arrivals): two same-id molecules on A and B moving to new pages C and D are two moves, not removals", () => {
    const { before: three, pageA, m } = threePagesWithEthane();
    const before: ChemDraftDocument = { ...three, pages: [three.pages[0], { ...three.pages[1], objects: [m] }, three.pages[2],
      { ...three.pages[2], id: "page_d", objects: [] }] };
    const after: ChemDraftDocument = { ...before, pages: [{ ...pageA, objects: pageA.objects.filter(object => object.id !== "m") },
      { ...before.pages[1], objects: [] }, { ...before.pages[2], objects: [m] }, { ...before.pages[3], objects: [m] }] };
    expect(preexistingMoleculeChemistryChanges(before, after)).toEqual([]);
    expect(commitChemistryRefusals({ before, next: after, after, normalize: identity, markAtoms })).toEqual([]);
  });

  it("A (multiple arrivals): a real deletion is still reported when an unrelated molecule arrives elsewhere", () => {
    const { before, pageA } = threePagesWithEthane();
    const deleted = { ...pageA, objects: pageA.objects.filter(object => object.id !== "m") };
    // A molecule with another id arriving on B does not stand in for the deleted m.
    const otherId: ChemDraftDocument = { ...before, pages: [deleted, { ...before.pages[1], objects: [ethane("n", { x: 100, y: 100 })] },
      before.pages[2]] };
    expect(preexistingMoleculeChemistryChanges(before, otherId)).toEqual([{ pageId: pageA.id, moleculeId: "m" }]);
    expect(commitChemistryRefusals({ before, next: otherId, after: otherId, normalize: identity, markAtoms })).toHaveLength(1);
    // A same-id m with none of its atoms arriving on B and C: whichever it pairs with, m's atoms are reported gone.
    const stranger = (at: number) => ({ ...ethane("m", { x: at, y: at }), atoms: ethane("m", { x: at, y: at }).atoms.map(atom => ({ ...atom, id: `${atom.id}_x` })) });
    const sameId: ChemDraftDocument = { ...before, pages: [deleted, { ...before.pages[1], objects: [stranger(100)] },
      { ...before.pages[2], objects: [stranger(200)] }] };
    const changes = preexistingMoleculeChemistryChanges(before, sameId);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every(change => change.pageId === pageA.id && change.moleculeId === "m")).toBe(true);
  });

  it("A (multiple arrivals): deleting m is reported when an unrelated m with the same atom ids and chemistry arrives elsewhere", () => {
    const { before, pageA, m } = threePagesWithEthane();
    // Drawn or pasted at another place: same id, same atom ids, same chemistry, but not m moved.
    const unrelated = ethane("m", { x: 100, y: 100 });
    expect(unrelated.atoms.map(atom => atom.id)).toEqual(m.atoms.map(atom => atom.id));
    expect(moleculeAtomChemistryChanges(m, unrelated)).toEqual([]);
    const after: ChemDraftDocument = { ...before, pages: [{ ...pageA, objects: pageA.objects.filter(object => object.id !== "m") },
      { ...before.pages[1], objects: [unrelated] }, before.pages[2]] };
    expect(preexistingMoleculeChemistryChanges(before, after)).toEqual([{ pageId: pageA.id, moleculeId: "m" }]);
    expect(commitChemistryRefusals({ before, next: after, after, normalize: identity, markAtoms })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// B: commitChemistryGuard.ts:280 — the moved-mark exemption covers every change on the mark's atom
// ---------------------------------------------------------------------------------------------
describe("B: moved selected mark exemption", () => {
  /**
   * A's N carries a selected explicit + and a stationary legacy object-anchored + (N is +2; 1.2.2 keeps
   * object anchors). The transform nudges the explicit + (it stays on N) and moves selected B so B's
   * atom sits on the legacy +, which commit normalization then hands to B: N goes +2 -> +1.
   */
  function legacyPlusTakenByMovedB() {
    const { document, nitrogen } = electronMarkDropFixture();
    const a = dropMolecule(document), explicit = dropMark(document);
    const legacyCenter = { x: nitrogen.x, y: nitrogen.y + 16 };
    const legacy: ElectronMarkObject = { ...explicit, id: "legacy_plus", atomAssociation: undefined,
      anchor: { kind: "object", objectId: a.id }, x: legacyCenter.x - explicit.width / 2, y: legacyCenter.y - explicit.height / 2 };
    let drawing = applyPatches(document, [
      { op: "updateObject", objectId: explicit.id, changes: { atomAssociation: "explicit" } },
      { op: "addObject", pageId: document.pages[0].id, object: legacy }
    ], { now: phase4Timestamp });
    drawing = normalize(withMolecule(drawing, ethane("b_mol", { x: 420, y: 400 })));
    expect(atomOf(drawing, a.id, nitrogen.id)).toMatchObject({ formalCharge: 2, markCharge: 2 });
    const before = workflow.selectDocumentObjects(drawing, drawing.pages[0].id, [explicit.id, "b_mol"]);
    const b = moleculeById(before, "b_mol");
    const next = applyPatches(before, [
      { op: "updateObject", objectId: explicit.id, changes: { x: markById(before, explicit.id).x + 2 } },
      { op: "updateObject", objectId: "b_mol", changes: translated(b, legacyCenter.x - b.atoms[0].x, legacyCenter.y - b.atoms[0].y) }
    ], { now: phase4Timestamp });
    return { before, next, a, nitrogen };
  }

  it("B: the guard refuses A's N losing the stationary legacy + although a different, selected + on N moved", () => {
    const { before, next, a, nitrogen } = legacyPlusTakenByMovedB();
    const after = normalize(next);
    expect(atomOf(after, a.id, nitrogen.id).formalCharge).toBe(1);
    const refusals = commitChemistryRefusals({ before, next, after, normalize, markAtoms, operation: "move" });
    // ADAPTED on charge-follows: B's own atom, now carrying the transferred +, is also (correctly) refused.
    expect(refusals).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`molecule "${a.id}": its atom "${nitrogen.id}"`))]));
  });

  it("B (app path): the selection-transform resolver every transform runs announces that legacy + transfer", () => {
    // MainWindow passes every selection transform through resolveElectronMarksInSelectionTransform
    // before the commit guard: the legacy anchor's change of owner is validated and named there.
    const { before, next, a, nitrogen } = legacyPlusTakenByMovedB();
    const resolved = resolveElectronMarksInSelectionTransform(before, next);
    expect(resolved.refused).toBeFalsy();
    // ADAPTED on charge-follows: the resolver now keeps the stationary legacy + on its atom (re-anchored,
    // explicit), so no transfer happens or needs announcing: N stays +2.
    expect(atomOf(normalize(resolved.document), a.id, nitrogen.id).formalCharge).toBe(2);
  });

  it("B control: when the selected + on N is not moved, the guard refuses the same change to A", () => {
    const { before, next, a, nitrogen } = legacyPlusTakenByMovedB();
    const explicitId = dropMark(before).id;
    const unmoved = applyPatch(next, { op: "updateObject", objectId: explicitId,
      changes: { x: markById(before, explicitId).x } }, { now: phase4Timestamp });
    expect(commitChemistryRefusals({ before, next: unmoved, after: normalize(unmoved), normalize, markAtoms, operation: "move" }))
      // ADAPTED on charge-follows: B's own atom, now carrying the transferred +, is also (correctly) refused.
      .toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`molecule "${a.id}": its atom "${nitrogen.id}"`))]));
  });
});

// ---------------------------------------------------------------------------------------------
// C / D: commitChemistryGuard.ts:285 and :104 — newline-joined keys collide
// ---------------------------------------------------------------------------------------------
function chargeAtom(molecule: MoleculeObject, charge: number): MoleculeObject {
  return { ...molecule, atoms: molecule.atoms.map((atom, index) => index === 0 ? { ...atom, formalCharge: charge } : atom) };
}

describe("C/D: delimiter collisions in guard keys", () => {
  it("C: a structure edit of molecule \"q\\nr\" on page \"p\" does not exempt molecule \"r\" on page \"p\\nq\"", () => {
    const base = electronMarkDropFixture().document;
    const grown = ethane("q\nr", { x: 100, y: 100 }), other = ethane("r", { x: 300, y: 100 });
    const before: ChemDraftDocument = { ...base, pages: [
      { ...base.pages[0], id: "p", objects: [grown] }, { ...base.pages[0], id: "p\nq", objects: [other] }] };
    const extraAtom: MoleculeAtom = { id: "grown_extra", element: "C", formalCharge: 0, x: 144, y: 100 };
    const next: ChemDraftDocument = { ...before, pages: [
      { ...before.pages[0], objects: [{ ...grown, atoms: [...grown.atoms, extraAtom] }] },
      { ...before.pages[1], objects: [chargeAtom(other, 1)] }] };
    const refusals = commitChemistryRefusals({ before, next, after: next, normalize: identity, markAtoms, structureEdit: true });
    expect(refusals).toEqual([expect.stringContaining('molecule "r"')]);
  });

  it("C/D control: with ids that hold no newline the same structure edit and move are refused", () => {
    const base = electronMarkDropFixture().document;
    const grown = ethane("q_r", { x: 100, y: 100 }), other = ethane("r", { x: 300, y: 100 });
    const before: ChemDraftDocument = { ...base, pages: [
      { ...base.pages[0], id: "p", objects: [grown] }, { ...base.pages[0], id: "p_q", objects: [other] }] };
    const extraAtom: MoleculeAtom = { id: "grown_extra", element: "C", formalCharge: 0, x: 144, y: 100 };
    const next: ChemDraftDocument = { ...before, pages: [
      { ...before.pages[0], objects: [{ ...grown, atoms: [...grown.atoms, extraAtom] }] },
      { ...before.pages[1], objects: [chargeAtom(other, 1)] }] };
    expect(commitChemistryRefusals({ before, next, after: next, normalize: identity, markAtoms, structureEdit: true }))
      .toEqual([expect.stringContaining('molecule "r"')]);
    const pageId = base.pages[0].id;
    const m = ethane("m", { x: 100, y: 100 }), unselected = ethane("m_a", { x: 300, y: 100 });
    const moveBefore: ChemDraftDocument = { ...base, selection: { ...base.selection, pageId, objectIds: ["m"] },
      pages: [{ ...base.pages[0], objects: [m, unselected] }] };
    const moveNext: ChemDraftDocument = { ...moveBefore, pages: [{ ...moveBefore.pages[0], objects: [
      { ...m, ...translated(m, 40, 0) }, chargeAtom(unselected, 1)] }] };
    expect(commitChemistryRefusals({ before: moveBefore, next: moveNext, after: moveNext, normalize: identity, markAtoms,
      operation: "move" })).toEqual([expect.stringContaining('molecule "m_a"')]);
  });

  it("D: moving selected molecule \"m\" (atom \"a\\nx\") does not exempt atom \"x\" of unselected molecule \"m\\na\"", () => {
    const base = electronMarkDropFixture().document;
    const selected = ethane("m", { x: 100, y: 100 });
    const m: MoleculeObject = { ...selected, atoms: selected.atoms.map((atom, index) => index === 0 ? { ...atom, id: "a\nx" } : atom),
      bonds: selected.bonds.map(bond => ({ ...bond, fromAtomId: bond.fromAtomId === selected.atoms[0].id ? "a\nx" : bond.fromAtomId,
        toAtomId: bond.toAtomId === selected.atoms[0].id ? "a\nx" : bond.toAtomId })) };
    const plain = ethane("m\na", { x: 300, y: 100 });
    const unselected: MoleculeObject = { ...plain, atoms: plain.atoms.map((atom, index) => index === 0 ? { ...atom, id: "x" } : atom),
      bonds: plain.bonds.map(bond => ({ ...bond, fromAtomId: bond.fromAtomId === plain.atoms[0].id ? "x" : bond.fromAtomId,
        toAtomId: bond.toAtomId === plain.atoms[0].id ? "x" : bond.toAtomId })) };
    const pageId = base.pages[0].id;
    const before: ChemDraftDocument = { ...base, selection: { ...base.selection, pageId, objectIds: ["m"] },
      pages: [{ ...base.pages[0], objects: [m, unselected] }] };
    const next: ChemDraftDocument = { ...before, pages: [{ ...before.pages[0], objects: [
      { ...m, ...translated(m, 40, 0) }, chargeAtom(unselected, 1)] }] };
    const refusals = commitChemistryRefusals({ before, next, after: next, normalize: identity, markAtoms, operation: "move" });
    expect(refusals).toEqual([expect.stringContaining('molecule "m\na"')]);
  });
});

// ---------------------------------------------------------------------------------------------
// E: documentWorkflow.ts:8500 — a whole-molecule drag leaves a bond/object-anchored mark behind
// ---------------------------------------------------------------------------------------------
describe("E: whole-molecule drag with a legacy-anchored charge", () => {
  it.each(["bond", "object"] as const)("E (workflow): a single-molecule drag keeps the %s-anchored + on its N, or refuses", kind => {
    const { document, nitrogen } = electronMarkDropFixture();
    const molecule = dropMolecule(document), mark = dropMark(document);
    const bond = molecule.bonds.find(candidate => candidate.fromAtomId === nitrogen.id || candidate.toAtomId === nitrogen.id)!;
    const anchor: ElectronMarkObject["anchor"] = kind === "bond" ? { kind, objectId: molecule.id, bondId: bond.id } : { kind, objectId: molecule.id };
    // As legacy-anchored marks are kept by 1.2.2 commit normalization (and so saved and reopened).
    const drawing = normalize(applyPatch(document, { op: "updateObject", objectId: mark.id, changes: {
      anchor, atomAssociation: undefined, x: nitrogen.x - mark.width / 2, y: nitrogen.y - mark.height / 2 } }, { now: phase4Timestamp }));
    expect(dropMark(drawing).anchor).toEqual(anchor);
    expect(atomOf(drawing, molecule.id, nitrogen.id)).toMatchObject({ formalCharge: 1, markCharge: 1 });
    // MainWindow.commitObjectDrag for one molecule: moveDocumentObject, committed under selectionTransformChemistry("move").
    const before = workflow.selectDocumentObjects(drawing, drawing.pages[0].id, [molecule.id]);
    const moved = workflow.moveDocumentObject(before, molecule.id, { x: molecule.x + 200, y: molecule.y + 150 });
    const after = normalize(moved);
    const refusals = policyChemistryRefusals(selectionTransformChemistry("move"), { before, next: moved, after, normalize, markAtoms });
    const charge = atomOf(after, molecule.id, nitrogen.id).formalCharge;
    // Correct: either the + travelled with N (charge kept), or the commit is refused. Silent loss is the bug.
    expect(charge === 1 || refusals.length > 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// F / G: documentWorkflow.ts:13976 and :13085 — copying by stored atom anchor, not resolver owner
// ---------------------------------------------------------------------------------------------
/**
 * An opened older file: A's N stores +1 from an atom-anchored (non-explicit) +, but the + glyph sits
 * outside N's association radius, beside B's first atom. The committed resolver gives it to B.
 */
function staleAtomAnchorFixture() {
  const { document, nitrogen } = electronMarkDropFixture();
  const a = dropMolecule(document), mark = dropMark(document);
  const withB = normalize(withMolecule(document, ethane("b_mol", { x: 420, y: 350 })));
  const center = { x: 410, y: 350 };
  const drawing = applyPatch(withB, { op: "updateObject", objectId: mark.id, changes: {
    x: center.x - mark.width / 2, y: center.y - mark.height / 2 } }, { now: phase4Timestamp });
  expect(dropMark(drawing).anchor).toMatchObject({ kind: "atom", objectId: a.id, atomId: nitrogen.id });
  expect(workflow.committedElectronMarkAssignments(drawing.pages[0]).anchorByMarkId.get(mark.id)?.objectId).toBe("b_mol");
  expect(atomOf(normalize(drawing), a.id, nitrogen.id).formalCharge).toBe(0);
  return { drawing, a, nitrogen, mark };
}

describe("F/G: copying a molecule whose stored anchor disagrees with the resolver", () => {
  it("F: a clipboard copy of A carries no charge that normalized A does not have", () => {
    const { drawing, a, nitrogen } = staleAtomAnchorFixture();
    const selected = workflow.selectDocumentObjects(drawing, drawing.pages[0].id, [a.id]);
    const payload = workflow.createSelectionClipboardPayload(selected)!;
    const pasted = normalize(workflow.pasteSelectionClipboardPayload(selected, payload, { x: 300, y: 520 }));
    const copy = pasted.pages[0].objects.find((object): object is MoleculeObject =>
      object.type === "molecule" && !selected.pages[0].objects.some(old => old.id === object.id))!;
    expect(copy).toBeDefined();
    const original = moleculeById(normalize(selected), a.id);
    expect(moleculeAtomChemistryChanges(original, { ...copy, atoms: copy.atoms })).toEqual([]);
    expect(copy.atoms.find(atom => atom.id === nitrogen.id)!.formalCharge).toBe(0);
  });

  it("G: Duplicate of A succeeds with a copy faithful to normalized A", () => {
    const { drawing, a } = staleAtomAnchorFixture();
    const selected = workflow.selectDocumentObjects(drawing, drawing.pages[0].id, [a.id]);
    const warnings: string[] = [];
    const duplicated = workflow.duplicateSelectedDocumentObjects(selected, undefined, warnings);
    expect(warnings).toEqual([]);
    expect(duplicated).not.toBe(selected);
    const after = normalize(duplicated);
    const copy = after.pages[0].objects.find((object): object is MoleculeObject =>
      object.type === "molecule" && !selected.pages[0].objects.some(old => old.id === object.id))!;
    expect(moleculeAtomChemistryChanges(moleculeById(normalize(selected), a.id), copy)).toEqual([]);
  });
});

describe("F/G (drag): a molecule drag carries a stale-anchored mark by the copy resolver's owner", () => {
  /** MainWindow.commitObjectDrag for one molecule, through the commit funnel's follow step. */
  const drag = (drawing: ChemDraftDocument, moleculeId: string, delta: { x: number; y: number }) => {
    const before = workflow.selectDocumentObjects(drawing, drawing.pages[0].id, [moleculeId]);
    const molecule = moleculeById(before, moleculeId);
    const policy = selectionTransformChemistry("move");
    const moved = workflow.carryElectronMarksWithMovedAtoms(before,
      workflow.moveDocumentObject(before, moleculeId, { x: molecule.x + delta.x, y: molecule.y + delta.y }), policy);
    const after = normalize(moved);
    return { before, after, refusals: policyChemistryRefusals(policy, { before, next: moved, after, normalize, markAtoms }) };
  };

  it("dragging A (the stale anchor's molecule) leaves B's mark exactly where it was", () => {
    const { drawing, a } = staleAtomAnchorFixture();
    const mark = dropMark(drawing);
    const { before, after, refusals } = drag(drawing, a.id, { x: 0, y: 120 });
    expect(refusals).toEqual([]);
    const kept = dropMark(after);
    expect({ x: kept.x, y: kept.y }).toEqual({ x: mark.x, y: mark.y });
    for (const id of [a.id, "b_mol"]) {
      expect(moleculeAtomChemistryChanges(moleculeById(normalize(before), id), moleculeById(after, id))).toEqual([]);
    }
    expect(workflow.committedElectronMarkAssignments(after.pages[0]).anchorByMarkId.get(mark.id)?.objectId).toBe("b_mol");
  });

  it("dragging B (the committed owner) moves the mark with B", () => {
    const { drawing, a } = staleAtomAnchorFixture();
    const mark = dropMark(drawing);
    const { before, after, refusals } = drag(drawing, "b_mol", { x: 0, y: 120 });
    expect(refusals).toEqual([]);
    const moved = dropMark(after);
    expect(moved.x).toBeCloseTo(mark.x);
    expect(moved.y).toBeCloseTo(mark.y + 120);
    for (const id of [a.id, "b_mol"]) {
      expect(moleculeAtomChemistryChanges(moleculeById(normalize(before), id), moleculeById(after, id))).toEqual([]);
    }
    expect(workflow.committedElectronMarkAssignments(after.pages[0]).anchorByMarkId.get(mark.id)?.objectId).toBe("b_mol");
  });
});

// ---------------------------------------------------------------------------------------------
// H: documentWorkflow.ts:20314 — an editor save moves a neutral atom onto a loose +
// ---------------------------------------------------------------------------------------------
describe("H: structure-editor save that brings a neutral atom to a loose +", () => {
  it("H: the save is refused with EDITOR_SAVE_TAKES_MARK_REFUSAL and no countercharge is hidden", () => {
    // Methylamine C–N, left to right; a loose (unowned) + below the bond's midpoint, out of range of both.
    const graph = testMoleculeFromSmiles("CN");
    const atoms: MoleculeAtom[] = graph.atoms.map((atom, index) => ({ ...atom, x: 100 + index * 30, y: 100 }));
    const molecule: MoleculeObject = { id: "mol_h", type: "molecule", x: 90, y: 80, width: 50, height: 40, rotation: 0, style: {},
      atoms, bonds: graph.bonds, structureFormat: "smiles", structure: nativeSingleBondGraphSmiles(atoms, graph.bonds),
      chemistry: nativeSingleBondGraphMetadata(atoms, graph.bonds), superatoms: [], rGroups: [] };
    let document = withMolecule(workflow.createPhase4Document("H"), molecule);
    const plusCenter = { x: 115, y: 130 };
    const nitrogenId = atoms.find(atom => atom.element === "N")!.id;
    // Seed a + with the charge tool, then make it loose: a free point mark, not explicit.
    document = normalize(workflow.applyChargeToolAtNativeAtom(document, { kind: "charge", charge: 1 },
      { kind: "atom", objectId: molecule.id, atomId: nitrogenId, distanceToPointer: 0 }));
    const seeded = document.pages[0].objects.find((object): object is ElectronMarkObject => object.type === "electron-mark")!;
    document = normalize(applyPatches(document, [
      { op: "updateObject", objectId: seeded.id, changes: { anchor: { kind: "point", point: plusCenter }, atomAssociation: undefined,
        x: plusCenter.x - seeded.width / 2, y: plusCenter.y - seeded.height / 2 } }
    ], { now: phase4Timestamp }));
    expect(workflow.committedElectronMarkAssignments(document.pages[0]).anchorByMarkId.get(seeded.id)).toBeUndefined();
    expect(moleculeById(document, molecule.id).atoms.every(atom => atom.formalCharge === 0)).toBe(true);
    expect(workflow.moleculeHasElectronMarks(document.pages[0], moleculeById(document, molecule.id))).toBe(false);
    // The editor returns the molecule turned vertical: C above N. Re-centred on the old box, N lands by the +.
    const selected = applyPatch(document, { op: "setSelection", pageId: document.pages[0].id, objectIds: [molecule.id] });
    const opened = moleculeById(selected, molecule.id);
    const v3000 = moleculeToMolfileV3000(opened, { kekuleBondOrders: new Map() }).contents.split(/\r?\n/).map(line => {
      const parts = line.trim().split(/\s+/);
      if (!/^M\s+V30\s+\d+\s+[A-Z][a-z]?\s/.test(line) || parts.length <= 5) return line;
      const isN = parts[3] === "N";
      return `M  V30 ${parts[2]} ${parts[3]} 0.0000 ${isN ? "-1.5000" : "0.0000"} ${parts.slice(6).join(" ")}`;
    }).join("\n");
    const applied = workflow.applyEditorSaveResultWithLabelWarnings(selected, {
      object: { ...opened, structureFormat: "molfile-v3000", structure: v3000 }, warnings: [] });
    // The loose + is not this molecule's: the save is refused with exactly that reason, not any
    // older refusal, and the document is left as it was.
    expect(applied.refusal).toBe(workflow.EDITOR_SAVE_TAKES_MARK_REFUSAL);
    expect(applied.document).toBe(selected);
    // No countercharge: N stays neutral with no mark contribution, and the + stays loose.
    const after = normalize(applied.document);
    const keptN = moleculeById(after, molecule.id).atoms.find(atom => atom.element === "N")!;
    expect({ formalCharge: keptN.formalCharge, markCharge: keptN.markCharge ?? 0 }).toEqual({ formalCharge: 0, markCharge: 0 });
    expect(moleculeById(after, molecule.id).atoms.every(atom => atom.formalCharge === 0 && (atom.markCharge ?? 0) === 0)).toBe(true);
    expect(workflow.committedElectronMarkAssignments(after.pages[0]).anchorByMarkId.get(seeded.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// J: electronMarkDrop.ts:71 — a legacy point mark's existing owner is not resolved
// ---------------------------------------------------------------------------------------------
describe("J: short part drag of an N carrying a legacy loose +", () => {
  it("J: keeps N+ (no double-counted attachment) when N moves a little under its legacy point-anchored +", () => {
    const { document, nitrogen } = ammoniumElectronMarkDropFixture();
    const molecule = dropMolecule(document), mark = dropMark(document);
    const center = { x: nitrogen.x, y: nitrogen.y - 14 };
    // An older file: a non-explicit point-anchored + by N, N storing formalCharge 1, markCharge 1.
    const drawing = applyPatch(document, { op: "updateObject", objectId: mark.id, changes: {
      anchor: { kind: "point", point: center }, atomAssociation: undefined,
      x: center.x - mark.width / 2, y: center.y - mark.height / 2 } }, { now: phase4Timestamp });
    expect(atomOf(drawing, molecule.id, nitrogen.id)).toMatchObject({ formalCharge: 1, markCharge: 1 });
    expect(workflow.committedElectronMarkAssignments(drawing.pages[0]).anchorByMarkId.get(mark.id)).toEqual({ objectId: molecule.id, atomId: nitrogen.id });
    const moved = workflow.moveNativeMoleculeParts(drawing, { objectId: molecule.id, kind: "atom", atomId: nitrogen.id }, { x: 3, y: 0 });
    const result = resolveElectronMarksAfterMoleculePartMove(drawing, moved);
    expect(result.status ?? "").not.toMatch(/^Cannot move/);
    expect(result.document).not.toBe(drawing);
    expect(atomOf(normalize(result.document), molecule.id, nitrogen.id).formalCharge).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// K: electronMarkDrop.ts:158 / documentWorkflow.ts:8407-8419 — legacy marks on a rotated molecule
// ---------------------------------------------------------------------------------------------
describe("K: legacy-anchored marks on a rotated molecule", () => {
  it("K1: a part drag that brings rotated N's drawn position onto its legacy + keeps the charge", () => {
    // N (two bonds) at the rotation pivot; two C neighbours far out fix the bounds. 90° rotation.
    const { document } = ammoniumElectronMarkDropFixture();
    const base = dropMolecule(document), mark = dropMark(document);
    const pivot = { x: 300, y: 300 };
    const r = Math.max(22 * 1.15, 25.3);
    const atoms: MoleculeAtom[] = [
      { id: "n", element: "N", formalCharge: 1, markCharge: 1, x: pivot.x, y: pivot.y },
      { id: "c1", element: "C", formalCharge: 0, x: pivot.x - 80, y: pivot.y - 80 },
      { id: "c2", element: "C", formalCharge: 0, x: pivot.x + 80, y: pivot.y + 80 }
    ];
    const bonds = [{ id: "b1", fromAtomId: "n", toAtomId: "c1", order: "single" as const },
      { id: "b2", fromAtomId: "n", toAtomId: "c2", order: "single" as const }];
    let drawing = applyPatches(document, [
      { op: "updateObject", objectId: base.id, changes: { x: pivot.x - 80, y: pivot.y - 80, width: 160, height: 160, rotation: 90,
        atoms, bonds, structure: nativeSingleBondGraphSmiles(atoms, bonds), chemistry: nativeSingleBondGraphMetadata(atoms, bonds) } }
    ], { now: phase4Timestamp });
    const rendered = (doc: ChemDraftDocument, atomId: string) => {
      const molecule = moleculeById(doc, base.id);
      return transformPointForObject(molecule, molecule.atoms.find(atom => atom.id === atomId)!);
    };
    expect(rendered(drawing, "n").x).toBeCloseTo(pivot.x);
    // Which way does +x raw render at 90°? Put the + 0.9 r along it from the pivot.
    const probe = transformPointForObject(moleculeById(drawing, base.id), { x: pivot.x + 10, y: pivot.y });
    const dir = { x: (probe.x - pivot.x) / 10, y: (probe.y - pivot.y) / 10 };
    const plus = { x: pivot.x + dir.x * 0.9 * r, y: pivot.y + dir.y * 0.9 * r };
    drawing = applyPatch(drawing, { op: "updateObject", objectId: mark.id, changes: {
      anchor: { kind: "object", objectId: base.id }, atomAssociation: undefined,
      x: plus.x - mark.width / 2, y: plus.y - mark.height / 2 } }, { now: phase4Timestamp });
    expect(workflow.committedElectronMarkAssignments(drawing.pages[0]).anchorByMarkId.get(mark.id)).toEqual({ objectId: base.id, atomId: "n" });
    // The move is 0.9 r along raw +x, in the molecule's own frame (the part-drag snap's frame).
    const moved = workflow.moveNativeMoleculeParts(drawing, { objectId: base.id, kind: "atom", atomId: "n" }, { x: 0.9 * r, y: 0 }, "molecule");
    const drawn = rendered(moved, "n");
    expect(Math.hypot(drawn.x - plus.x, drawn.y - plus.y)).toBeLessThan(2);
    const result = resolveElectronMarksAfterMoleculePartMove(drawing, moved);
    const after = normalize(result.document);
    expect(atomOf(after, base.id, "n").formalCharge).toBe(1);
  });

  it("K2: a legacy + drawn outside rotated N's radius is not kept on N because N stores another + (explicit)", () => {
    const { document, nitrogen } = electronMarkDropFixture();
    const molecule = dropMolecule(document), explicit = dropMark(document);
    const rotated = applyPatches(document, [
      { op: "updateObject", objectId: molecule.id, changes: { rotation: 90 } },
      { op: "updateObject", objectId: explicit.id, changes: { atomAssociation: "explicit" } }
    ], { now: phase4Timestamp });
    const drawnN = transformPointForObject(moleculeById(rotated, molecule.id), nitrogen);
    // Raw-near (20 px from raw N) but drawn-far from N.
    const center = [{ x: nitrogen.x, y: nitrogen.y + 20 }, { x: nitrogen.x, y: nitrogen.y - 20 }]
      .find(point => Math.hypot(point.x - drawnN.x, point.y - drawnN.y) > RADIUS + 2)!;
    expect(center).toBeDefined();
    const legacy: ElectronMarkObject = { ...explicit, id: "legacy_plus", atomAssociation: undefined,
      anchor: { kind: "object", objectId: molecule.id }, x: center.x - explicit.width / 2, y: center.y - explicit.height / 2 };
    const drawing = applyPatch(rotated, { op: "addObject", pageId: rotated.pages[0].id, object: legacy }, { now: phase4Timestamp });
    expect(atomOf(drawing, molecule.id, nitrogen.id)).toMatchObject({ formalCharge: 1, markCharge: 1 });
    expect(workflow.committedElectronMarkAssignments(drawing.pages[0]).anchorByMarkId.get(legacy.id)).toBeUndefined();
    expect(atomOf(normalize(drawing), molecule.id, nitrogen.id).formalCharge).toBe(1);
  });

  /**
   * A rotated molecule whose N stores `stored` from legacy marks, and one legacy object-anchored
   * radical-ion mark (+1 and one radical) drawn outside N's rendered radius but near raw N.
   */
  function radicalIonFixture(stored: { formalCharge: number; markCharge: number; markRadicals: number }) {
    const { document, nitrogen } = electronMarkDropFixture();
    const molecule = dropMolecule(document), plus = dropMark(document);
    const atoms = molecule.atoms.map(atom => atom.id === nitrogen.id
      ? { ...atom, formalCharge: stored.formalCharge, markCharge: stored.markCharge, markRadicals: stored.markRadicals } : atom);
    const rotated = applyPatches(document, [
      { op: "removeObject", objectId: plus.id },
      { op: "updateObject", objectId: molecule.id, changes: { rotation: 90, atoms } }
    ], { now: phase4Timestamp });
    const drawnN = transformPointForObject(moleculeById(rotated, molecule.id), nitrogen);
    const center = [{ x: nitrogen.x, y: nitrogen.y + 20 }, { x: nitrogen.x, y: nitrogen.y - 20 }]
      .find(point => Math.hypot(point.x - drawnN.x, point.y - drawnN.y) > RADIUS + 2)!;
    expect(center).toBeDefined();
    const legacy: ElectronMarkObject = { ...plus, id: "legacy_radical_ion", atomAssociation: undefined, charge: 1, radical: true,
      anchor: { kind: "object", objectId: molecule.id }, x: center.x - plus.width / 2, y: center.y - plus.height / 2 };
    const drawing = applyPatch(rotated, { op: "addObject", pageId: rotated.pages[0].id, object: legacy }, { now: phase4Timestamp });
    return { drawing, molecule, nitrogen, legacy };
  }

  it("K2 (radical ion): stored radicals without stored charge do not keep a drawn-far +1 radical-ion mark on N", () => {
    const { drawing, legacy } = radicalIonFixture({ formalCharge: 0, markCharge: 0, markRadicals: 1 });
    expect(workflow.committedElectronMarkAssignments(drawing.pages[0]).anchorByMarkId.get(legacy.id)).toBeUndefined();
  });

  it("K2 (radical ion): stored charge without stored radicals does not keep a drawn-far +1 radical-ion mark on N", () => {
    const { drawing, legacy } = radicalIonFixture({ formalCharge: 1, markCharge: 1, markRadicals: 0 });
    expect(workflow.committedElectronMarkAssignments(drawing.pages[0]).anchorByMarkId.get(legacy.id)).toBeUndefined();
  });

  it("K2 (radical ion) control: with both its charge and its radical stored, the legacy mark stays on N", () => {
    const { drawing, molecule, nitrogen, legacy } = radicalIonFixture({ formalCharge: 1, markCharge: 1, markRadicals: 1 });
    expect(workflow.committedElectronMarkAssignments(drawing.pages[0]).anchorByMarkId.get(legacy.id))
      .toEqual({ objectId: molecule.id, atomId: nitrogen.id });
  });
});

// ---------------------------------------------------------------------------------------------
// O (hands-on follow-up): Structure > Drawing style with shorter bonds scaled the + on N into N's
// label and bond. The mark keeps its direction from N and sits clear of N's label box.
// ---------------------------------------------------------------------------------------------
describe("O: a style that shortens the bonds keeps a + clear of its atom's label", () => {
  type Box = { x: number; y: number; width: number; height: number };
  const overlaps = (a: Box, b: Box) => Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x)
    && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
  const labelOf = (molecule: MoleculeObject, atomId: string) =>
    moleculeLayoutLabelBoxes(molecule).find(box => molecule.atoms[box.atom].id === atomId)!;
  const bond = (m: MoleculeObject) => Math.hypot(m.atoms[0].x - m.atoms[1].x, m.atoms[0].y - m.atoms[1].y);

  it.each(["chemdraft.acs1996", "chemdraft.rscjournal"])("O: %s leaves a close + on N outside N's label box, in its old direction", presetId => {
    // The molecule drawn with long (33 px) bonds; its + set close by N, up and to the right, clear of
    // N's label. Both styles shorten the bonds to 22 px or less and scale the + offset with them.
    const fixture = electronMarkDropFixture();
    const { nitrogen } = fixture;
    const plain = applyPatches(fixture.document, [{ op: "removeObject", objectId: dropMark(fixture.document).id }],
      { now: phase4Timestamp });
    const big = workflow.resizeNativeMoleculeObject(plain, dropMolecule(plain).id, { x: 1.5, y: 1.5 });
    const bigN = dropMolecule(big).atoms.find(atom => atom.id === nitrogen.id)!;
    const charged = normalize(workflow.applyChargeToolAtNativeAtom(big, 1,
      { kind: "atom", objectId: dropMolecule(big).id, atomId: bigN.id, distanceToPointer: 0 }));
    const charge = dropMark(charged);
    const document = normalize(workflow.moveDocumentObject(charged, charge.id,
      { x: bigN.x + 16 - charge.width / 2, y: bigN.y - 16 - charge.height / 2 }));
    const molecule = dropMolecule(document), mark = dropMark(document);
    const nBefore = molecule.atoms.find(atom => atom.id === nitrogen.id)!;
    expect(nBefore).toMatchObject({ formalCharge: 1, markCharge: 1 });
    expect(markAtoms(document.pages[0], mark).every(owner => owner.atomId === nitrogen.id)).toBe(true);
    expect(overlaps(mark, labelOf(molecule, nitrogen.id)), "precondition: + clear of N's label before the style").toBe(false);

    const selected = workflow.selectDocumentObjects(document, document.pages[0].id, [molecule.id, mark.id]);
    const warnings: Parameters<typeof nativeStylePresetPatchForSelection>[3] = [];
    const styled = normalize(applyPatches(selected, nativeStylePresetPatchForSelection(selected, presetId, [], warnings).patches));
    expect(warnings).toEqual([]);
    const after = dropMolecule(styled), moved = dropMark(styled);
    expect(bond(after)).toBeLessThan(bond(molecule) - 1);
    const n = after.atoms.find(atom => atom.id === nitrogen.id)!;
    const label = labelOf(after, nitrogen.id);
    expect(overlaps(moved, label), `+ frame ${JSON.stringify(moved)} overlaps N label ${JSON.stringify(label)}`).toBe(false);
    const direction = (from: { x: number; y: number }, m: ElectronMarkObject) =>
      Math.atan2(m.y + m.height / 2 - from.y, m.x + m.width / 2 - from.x);
    expect(Math.abs(direction(n, moved) - direction(nBefore, mark))).toBeLessThan(1e-6);
    // Chemistry unchanged: N keeps its + and the mark still belongs to N.
    expect({ formalCharge: n.formalCharge, markCharge: n.markCharge })
      .toEqual({ formalCharge: nBefore.formalCharge, markCharge: nBefore.markCharge });
    const owners = markAtoms(styled.pages[0], moved);
    expect(owners.length).toBeGreaterThan(0);
    expect(owners.every(owner => owner.objectId === molecule.id && owner.atomId === nitrogen.id)).toBe(true);
  });

  it.each(["chemdraft.acs1996", "chemdraft.rscjournal"])("O (rotated mark): %s clears N's label by the + turned 45°, its rotated extents", presetId => {
    // As above, but the + is turned 45° relative to its (unrotated) molecule: in the molecule frame
    // it covers its rotated box, √2 × its stored size, not its stored width and height.
    const fixture = electronMarkDropFixture();
    const { nitrogen } = fixture;
    const plain = applyPatches(fixture.document, [{ op: "removeObject", objectId: dropMark(fixture.document).id }],
      { now: phase4Timestamp });
    const big = workflow.resizeNativeMoleculeObject(plain, dropMolecule(plain).id, { x: 1.5, y: 1.5 });
    const bigN = dropMolecule(big).atoms.find(atom => atom.id === nitrogen.id)!;
    const charged = normalize(workflow.applyChargeToolAtNativeAtom(big, 1,
      { kind: "atom", objectId: dropMolecule(big).id, atomId: bigN.id, distanceToPointer: 0 }));
    const charge = dropMark(charged);
    const document = normalize(applyPatches(workflow.moveDocumentObject(charged, charge.id,
      { x: bigN.x - charge.width / 2, y: bigN.y - 24 - charge.height / 2 }),
      [{ op: "updateObject", objectId: charge.id, changes: { rotation: 45 } }], { now: phase4Timestamp }));
    const molecule = dropMolecule(document), mark = dropMark(document);
    expect(molecule.rotation).toBe(0);
    expect(mark.rotation).toBe(45);
    const nBefore = molecule.atoms.find(atom => atom.id === nitrogen.id)!;
    expect(nBefore).toMatchObject({ formalCharge: 1, markCharge: 1 });
    const rotatedBox = (m: ElectronMarkObject) => {
      const turn = (m.rotation * Math.PI) / 180, cos = Math.abs(Math.cos(turn)), sin = Math.abs(Math.sin(turn));
      const w = cos * m.width + sin * m.height, h = sin * m.width + cos * m.height;
      return { x: m.x + m.width / 2 - w / 2, y: m.y + m.height / 2 - h / 2, width: w, height: h };
    };
    expect(overlaps(rotatedBox(mark), labelOf(molecule, nitrogen.id)), "precondition: turned + clear of N's label").toBe(false);

    const selected = workflow.selectDocumentObjects(document, document.pages[0].id, [molecule.id, mark.id]);
    const warnings: Parameters<typeof nativeStylePresetPatchForSelection>[3] = [];
    const styled = normalize(applyPatches(selected, nativeStylePresetPatchForSelection(selected, presetId, [], warnings).patches));
    expect(warnings).toEqual([]);
    const after = dropMolecule(styled), moved = dropMark(styled);
    expect(bond(after)).toBeLessThan(bond(molecule) - 1);
    expect(moved.rotation).toBe(45);
    const label = labelOf(after, nitrogen.id);
    expect(overlaps(rotatedBox(moved), label), `turned + ${JSON.stringify(rotatedBox(moved))} overlaps N label ${JSON.stringify(label)}`).toBe(false);
    const n = after.atoms.find(atom => atom.id === nitrogen.id)!;
    expect({ formalCharge: n.formalCharge, markCharge: n.markCharge })
      .toEqual({ formalCharge: nBefore.formalCharge, markCharge: nBefore.markCharge });
    expect(markAtoms(styled.pages[0], moved).every(owner => owner.objectId === molecule.id && owner.atomId === nitrogen.id)).toBe(true);
  });
});
