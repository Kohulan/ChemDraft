// Owner ruling 2026-11-21 (charge always follows): the shared rule, `followElectronMarksWithMovedAtoms`,
// on moves the DOM suite (chargeAlwaysFollows.dom.test.tsx) does not reach: an engine 2D relayout,
// and rigid turns and mirrors of atoms that leave the mark where it was, where the mark's offset from
// its atom must turn or mirror with the atoms.
import { beforeAll, describe, expect, it } from "vitest";
import { applyPatch, applyPatches, type ChemDraftDocument, type ElectronMarkObject, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import { transformPointForObject } from "@chemdraft/layout-engine";
import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles, phase4Timestamp } from "@chemdraft/document-workflow-core";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { ensureOclResources, relayoutMolfile2D } from "@chemdraft/ocl-adapter";
import * as workflow from "./documentWorkflow";
import { commitChemistryRefusals, marksFollowAtoms, structureEditorChemistry } from "./commitChemistryGuard";
import { dropMark, dropMolecule, electronMarkDropFixture } from "./testSupport/electronMarkDropFixture";

type Point = { x: number; y: number };

/** Boc-glycine N+ with its tool-placed mark, atom-anchored or re-stored as a legacy bond-anchored mark below N. */
function chargedNitrogen(kind: "atom" | "bond") {
  const { document, nitrogen } = electronMarkDropFixture();
  if (kind === "atom") return { document, nitrogenId: nitrogen.id };
  const molecule = dropMolecule(document), mark = dropMark(document);
  const bond = molecule.bonds.find(bond => bond.fromAtomId === nitrogen.id || bond.toAtomId === nitrogen.id)!;
  const toolCenter = workflow.nativeChargeMarkCenter(mark);
  const atom = transformPointForObject(molecule, nitrogen);
  const center = { x: atom.x, y: atom.y + Math.hypot(toolCenter.x - atom.x, toolCenter.y - atom.y) };
  const legacy = workflow.normalizeCommittedDocument(applyPatch(document, { op: "updateObject", objectId: mark.id, changes: {
    x: center.x - mark.width / 2, y: center.y - mark.height / 2,
    anchor: { kind: "bond", objectId: molecule.id, bondId: bond.id }, atomAssociation: undefined
  } }, { now: phase4Timestamp }));
  return { document: legacy, nitrogenId: nitrogen.id };
}

const chemistry = (atom: MoleculeAtom) => [atom.formalCharge, atom.markCharge ?? 0, atom.markRadicals ?? 0];

function offset(document: ChemDraftDocument, atomId: string): Point {
  const molecule = dropMolecule(document);
  const atom = transformPointForObject(molecule, molecule.atoms.find(candidate => candidate.id === atomId)!);
  const center = workflow.nativeChargeMarkCenter(dropMark(document));
  return { x: center.x - atom.x, y: center.y - atom.y };
}

function owner(document: ChemDraftDocument, markId: string) {
  return workflow.committedElectronMarkAssignments(document.pages[0]).anchorByMarkId.get(markId);
}

/** The rule's result, committed, keeps every atom's chemistry and the mark's atom, and passes the commit guard. */
function expectCommittedWithMarkKept(before: ChemDraftDocument, moved: ChemDraftDocument, nitrogenId: string) {
  const followed = workflow.followElectronMarksWithMovedAtoms(before, moved);
  const mark = dropMark(before);
  expect(followed.followedMarkIds.has(mark.id)).toBe(true);
  const committed = workflow.normalizeCommittedDocument(followed.document);
  expect(dropMolecule(committed).atoms.map(chemistry)).toEqual(dropMolecule(before).atoms.map(chemistry));
  expect(owner(committed, mark.id)).toEqual({ objectId: dropMolecule(before).id, atomId: nitrogenId });
  // A legacy mark is re-anchored to its atom explicitly; an atom-anchored one keeps its anchor.
  expect(dropMark(committed).anchor).toMatchObject({ kind: "atom", atomId: nitrogenId });
  if (dropMark(before).anchor.kind !== "atom") expect(dropMark(committed).atomAssociation).toBe("explicit");
  expect(commitChemistryRefusals({ before, next: followed.document, after: committed,
    normalize: workflow.normalizeCommittedDocument, markAtoms: workflow.committedElectronMarkAtoms, operation: "clean up" })).toEqual([]);
  return committed;
}

/** Turn or mirror every atom of the molecule about N, leaving the mark where it was. */
function mapAtomsAboutNitrogen(document: ChemDraftDocument, nitrogenId: string, map: (offset: Point) => Point) {
  const molecule = dropMolecule(document);
  const pivot = molecule.atoms.find(atom => atom.id === nitrogenId)!;
  const atoms = molecule.atoms.map(atom => {
    const next = map({ x: atom.x - pivot.x, y: atom.y - pivot.y });
    return { ...atom, x: pivot.x + next.x, y: pivot.y + next.y };
  });
  return applyPatch(document, { op: "updateObject", objectId: molecule.id, changes: { atoms } }, { now: phase4Timestamp });
}

/** Map the named atoms' coordinates by `map`, leaving every mark where it was (a part move the rule must follow). */
function mapAtoms(document: ChemDraftDocument, atomIds: readonly string[], map: (point: Point) => Point) {
  const molecule = dropMolecule(document), ids = new Set(atomIds);
  const atoms = molecule.atoms.map(atom => ids.has(atom.id) ? { ...atom, ...map({ x: atom.x, y: atom.y }) } : atom);
  return applyPatch(document, { op: "updateObject", objectId: molecule.id, changes: { atoms } }, { now: phase4Timestamp });
}

const turnAbout = (pivot: Point, radians: number) => ({ x, y }: Point) => ({
  x: pivot.x + (x - pivot.x) * Math.cos(radians) - (y - pivot.y) * Math.sin(radians),
  y: pivot.y + (x - pivot.x) * Math.sin(radians) + (y - pivot.y) * Math.cos(radians)
});

const markCenter = (document: ChemDraftDocument) => workflow.nativeChargeMarkCenter(dropMark(document));

describe.each(["atom", "bond"] as const)("charge always follows: the shared rule (%s-anchored N+)", kind => {
  beforeAll(async () => { await ensureOclResources(); });

  it("an engine 2D relayout keeps the mark with N at its offset, and the commit guard passes", () => {
    const { document, nitrogenId } = chargedNitrogen(kind);
    const molecule = dropMolecule(document);
    const relaid = workflow.applyNativeMoleculeEngineRelayout(document, molecule.id, relayoutMolfile2D);
    const before = transformPointForObject(molecule, molecule.atoms.find(atom => atom.id === nitrogenId)!);
    const after = transformPointForObject(dropMolecule(relaid), dropMolecule(relaid).atoms.find(atom => atom.id === nitrogenId)!);
    expect(Math.hypot(after.x - before.x, after.y - before.y), "the relayout moves N").toBeGreaterThan(0.5);
    const committed = expectCommittedWithMarkKept(document, relaid, nitrogenId);
    const kept = offset(committed, nitrogenId), original = offset(document, nitrogenId);
    expect(Math.hypot(kept.x, kept.y)).toBeCloseTo(Math.hypot(original.x, original.y), 3);
  });

  it("a quarter turn of the atoms about N turns the mark's offset with them", () => {
    const { document, nitrogenId } = chargedNitrogen(kind);
    const turned = mapAtomsAboutNitrogen(document, nitrogenId, ({ x, y }) => ({ x: -y, y: x }));
    const committed = expectCommittedWithMarkKept(document, turned, nitrogenId);
    const original = offset(document, nitrogenId), kept = offset(committed, nitrogenId);
    expect(kept.x).toBeCloseTo(-original.y, 3);
    expect(kept.y).toBeCloseTo(original.x, 3);
  });

  it("a mirror of the atoms through N mirrors the mark's offset", () => {
    const { document, nitrogenId } = chargedNitrogen(kind);
    const mirrored = mapAtomsAboutNitrogen(document, nitrogenId, ({ x, y }) => ({ x, y: -y }));
    const committed = expectCommittedWithMarkKept(document, mirrored, nitrogenId);
    const original = offset(document, nitrogenId), kept = offset(committed, nitrogenId);
    expect(kept.x).toBeCloseTo(original.x, 3);
    expect(kept.y).toBeCloseTo(-original.y, 3);
  });

  it("turning a part of the molecule that holds N turns the mark's offset with that part", () => {
    const { document, nitrogenId } = chargedNitrogen(kind);
    const molecule = dropMolecule(document);
    const partIds = molecule.atoms.slice(7).map(atom => atom.id);
    expect(partIds[0]).toBe(nitrogenId);
    // Turned about a point off N, so N itself moves with the part.
    const turned = mapAtoms(document, partIds, turnAbout({ x: 261, y: 245 }, Math.PI / 2));
    const committed = expectCommittedWithMarkKept(document, turned, nitrogenId);
    const original = offset(document, nitrogenId), kept = offset(committed, nitrogenId);
    expect(kept.x).toBeCloseTo(-original.y, 3);
    expect(kept.y).toBeCloseTo(original.x, 3);
  });

  it("a part turned about N leaves N, and so its mark, where they were", () => {
    // Review P2a: the part's map is fitted to the atoms it displaced. N is the turn's pivot and
    // does not move, so its mark neither moves nor turns (1.2.3 turned it about N).
    const { document, nitrogenId } = chargedNitrogen(kind);
    const molecule = dropMolecule(document);
    const partIds = molecule.atoms.slice(7).map(atom => atom.id);
    const turned = workflow.rotateNativeMoleculeParts(document,
      { objectId: molecule.id, kind: "parts", atomIds: partIds, bondIds: [] }, 90);
    const n = (drawing: ChemDraftDocument) => {
      const next = dropMolecule(drawing);
      return transformPointForObject(next, next.atoms.find(atom => atom.id === nitrogenId)!);
    };
    expect(n(turned), "N is the pivot").toEqual(n(document));
    const followed = workflow.followElectronMarksWithMovedAtoms(document, turned, { motion: "turn" });
    expect(followed.followedMarkIds.has(dropMark(document).id)).toBe(false);
    expect(markCenter(followed.document)).toEqual(markCenter(document));
    const committed = workflow.normalizeCommittedDocument(followed.document);
    expect(owner(committed, dropMark(document).id)).toEqual({ objectId: molecule.id, atomId: nitrogenId });
    expect(dropMolecule(committed).atoms.map(chemistry)).toEqual(dropMolecule(document).atoms.map(chemistry));
  });
});

describe("charge always follows: what the shared rule leaves alone", () => {
  it("a stationary loose mark is not taken by an atom moved onto it", () => {
    const { document, nitrogen } = electronMarkDropFixture();
    const mark = dropMark(document), molecule = dropMolecule(document);
    const free = workflow.normalizeCommittedDocument(applyPatch(document, { op: "updateObject", objectId: mark.id, changes: {
      x: 400 - mark.width / 2, y: 400 - mark.height / 2, anchor: { kind: "point", point: { x: 400, y: 400 } }, atomAssociation: undefined
    } }, { now: phase4Timestamp }));
    expect(owner(free, mark.id)).toBeUndefined();
    const onMark = workflow.moveNativeMoleculeParts(free, { objectId: molecule.id, kind: "atom", atomId: nitrogen.id },
      { x: 400 - nitrogen.x, y: 400 - nitrogen.y });
    const followed = workflow.followElectronMarksWithMovedAtoms(free, onMark);
    expect(followed.followedMarkIds.size).toBe(0);
    const committed = workflow.normalizeCommittedDocument(followed.document);
    expect(owner(committed, mark.id)).toBeUndefined();
    expect(dropMolecule(committed).atoms.map(chemistry)).toEqual(dropMolecule(free).atoms.map(chemistry));
  });

  it("a mark moved without its atom is left to the mark-move policy", () => {
    const { document } = electronMarkDropFixture();
    const mark = dropMark(document);
    const moved = workflow.moveDocumentObject(document, mark.id, { x: 600, y: 500 });
    const followed = workflow.followElectronMarksWithMovedAtoms(document, moved);
    expect(followed.followedMarkIds.size).toBe(0);
    expect(followed.document).toBe(moved);
  });
});

describe.each(["atom", "bond"] as const)("charge always follows: review fixes (%s-anchored N+)", kind => {
  // P2a: a rigid turn of part of the molecule fits a map to the moved atoms only; a mark whose
  // atom stayed where it was must neither move nor turn about it.
  it("a mark on an atom a partial turn leaves in place stays exactly where it was", () => {
    const { document, nitrogenId } = chargedNitrogen(kind);
    const molecule = dropMolecule(document);
    const nIndex = molecule.atoms.findIndex(atom => atom.id === nitrogenId);
    // The four atoms beyond N (C, C, =O, OH) turn a quarter about a point between them; N stays.
    const partIds = molecule.atoms.slice(nIndex + 1).map(atom => atom.id);
    expect(partIds).toHaveLength(4);
    const turned = mapAtoms(document, partIds, turnAbout({ x: 261, y: 245 }, Math.PI / 2));
    const n = (drawing: ChemDraftDocument) => dropMolecule(drawing).atoms.find(atom => atom.id === nitrogenId)!;
    expect(n(turned)).toMatchObject({ x: n(document).x, y: n(document).y });
    const pass = workflow.followElectronMarksWithMovedAtoms(document, turned);
    expect(pass.followedMarkIds.has(dropMark(document).id)).toBe(false);
    expect(markCenter(pass.document)).toEqual(markCenter(document));
    expect(dropMark(pass.document).rotation).toBe(dropMark(document).rotation);
    // The commit funnel's second pass over the already-followed document leaves it as well.
    const again = workflow.followElectronMarksWithMovedAtoms(document, pass.document);
    expect(markCenter(again.document)).toEqual(markCenter(document));
    const committed = workflow.normalizeCommittedDocument(again.document);
    expect(owner(committed, dropMark(document).id)).toEqual({ objectId: molecule.id, atomId: nitrogenId });
  });

  // P2b: two moved atoms define a turn (rotation, scale, translation); when the caller knows the
  // operation was a turn, the mark's offset turns with them.
  it("a partial turn of exactly two atoms, known to be a turn, turns the mark's offset", () => {
    const { document, nitrogenId } = chargedNitrogen(kind);
    const molecule = dropMolecule(document);
    const nIndex = molecule.atoms.findIndex(atom => atom.id === nitrogenId);
    const partIds = [nitrogenId, molecule.atoms[nIndex + 1].id];
    const turned = mapAtoms(document, partIds, turnAbout({ x: 239, y: 280 }, Math.PI / 2));
    const followed = workflow.followElectronMarksWithMovedAtoms(document, turned, { motion: "turn" });
    expect(followed.followedMarkIds.has(dropMark(document).id)).toBe(true);
    const original = offset(document, nitrogenId), kept = offset(followed.document, nitrogenId);
    expect(kept.x).toBeCloseTo(-original.y, 3);
    expect(kept.y).toBeCloseTo(original.x, 3);
    // Not known: two atoms cannot tell a turn from a mirror, so the offset is only translated.
    const unknown = workflow.followElectronMarksWithMovedAtoms(document, turned);
    const translated = offset(unknown.document, nitrogenId);
    expect(translated.x).toBeCloseTo(original.x, 6);
    expect(translated.y).toBeCloseTo(original.y, 6);
  });
});

describe("charge always follows: a two-atom molecule mirrored or turned by an edit that does not say which", () => {
  /** CH3–NH3+ with the charge tool's mark on N. */
  function chargedMethylammonium() {
    const fixture = electronMarkDropFixture(), molecule = dropMolecule(fixture.document);
    const graph = testMoleculeFromSmiles("CN");
    const atoms = graph.atoms.map((atom, index) => ({ ...atom, x: 206 + index * 22, y: 250 }));
    let document = applyPatches(fixture.document, [
      { op: "removeObject", objectId: dropMark(fixture.document).id },
      { op: "updateObject", objectId: molecule.id, changes: {
        x: 206, y: 250, width: 22, height: 0, atoms, bonds: graph.bonds,
        structure: nativeSingleBondGraphSmiles(atoms, graph.bonds), chemistry: nativeSingleBondGraphMetadata(atoms, graph.bonds)
      } }
    ], { now: phase4Timestamp });
    document = workflow.normalizeCommittedDocument(workflow.applyChargeToolAtNativeAtom(document, 1,
      { kind: "atom", objectId: molecule.id, atomId: atoms[1].id, distanceToPointer: 0 }));
    return { document, nitrogenId: atoms[1].id, carbonId: atoms[0].id };
  }

  it("keeps the offset translated only, never guessing a mirror or a turn; a known mirror mirrors it", () => {
    const { document, nitrogenId, carbonId } = chargedMethylammonium();
    const original = offset(document, nitrogenId);
    expect(Math.abs(original.y), "the tool places the mark off the C–N axis").toBeGreaterThan(1);
    // C and N swap places: a mirror across x = 217, or a half turn about (217, 250).
    const swapped = mapAtoms(document, [carbonId, nitrogenId], ({ x, y }) => ({ x: 434 - x, y }));
    const unknown = workflow.followElectronMarksWithMovedAtoms(document, swapped);
    const kept = offset(unknown.document, nitrogenId);
    expect(kept.x).toBeCloseTo(original.x, 6);
    expect(kept.y).toBeCloseTo(original.y, 6);
    const mirrored = offset(workflow.followElectronMarksWithMovedAtoms(document, swapped, { motion: "mirror" }).document, nitrogenId);
    expect(mirrored.x).toBeCloseTo(-original.x, 3);
    expect(mirrored.y).toBeCloseTo(original.y, 3);
    const turned = offset(workflow.followElectronMarksWithMovedAtoms(document, swapped, { motion: "turn" }).document, nitrogenId);
    expect(turned.x).toBeCloseTo(-original.x, 3);
    expect(turned.y).toBeCloseTo(-original.y, 3);
  });
});

describe("charge always follows: a structure-editor (Ketcher) save", () => {
  // P1: the editor save reuses the previous atom ids by array index, so deleting an earlier atom
  // shifts every later atom onto the previous id of its predecessor. An id is then not the same
  // atom, and a mark must never follow (or be anchored to) the atom that inherited its atom's id.
  function legacyLooseNitrogen() {
    const { document, nitrogen } = electronMarkDropFixture();
    // A loose "+" 10 px below N, nearer N than any other atom, stored (unnormalized) as an older
    // file keeps it: normalization would anchor it to N by id.
    const mark = dropMark(document), center = { x: nitrogen.x, y: nitrogen.y + 10 };
    const loose = applyPatch(document, { op: "updateObject", objectId: mark.id, changes: {
      x: center.x - mark.width / 2, y: center.y - mark.height / 2, anchor: { kind: "point", point: center }, atomAssociation: undefined
    } }, { now: phase4Timestamp });
    expect(dropMark(loose).anchor.kind).toBe("point");
    expect(owner(loose, mark.id)).toEqual({ objectId: dropMolecule(loose).id, atomId: nitrogen.id });
    return { document: loose, nitrogenId: nitrogen.id };
  }

  /** As the editor save rebuilds the molecule: the first atom deleted, ids reused by index. */
  function deleteFirstAtomReusingIdsByIndex(document: ChemDraftDocument) {
    const molecule = dropMolecule(document);
    const [gone, ...kept] = molecule.atoms;
    const idByOldId = new Map(kept.map((atom, index) => [atom.id, molecule.atoms[index].id]));
    const atoms = kept.map(atom => ({ ...atom, id: idByOldId.get(atom.id)! }));
    const bonds = molecule.bonds.filter(bond => bond.fromAtomId !== gone.id && bond.toAtomId !== gone.id)
      .map((bond, index) => ({ ...bond, id: molecule.bonds[index].id,
        fromAtomId: idByOldId.get(bond.fromAtomId)!, toAtomId: idByOldId.get(bond.toAtomId)! }));
    return applyPatch(document, { op: "updateObject", objectId: molecule.id, changes: {
      atoms, bonds, structure: nativeSingleBondGraphSmiles(atoms, bonds), chemistry: nativeSingleBondGraphMetadata(atoms, bonds)
    } }, { now: phase4Timestamp });
  }

  it("does not move a legacy mark to, or anchor it on, the atom that inherited its atom's id", () => {
    const { document, nitrogenId } = legacyLooseNitrogen();
    const edited = deleteFirstAtomReusingIdsByIndex(document);
    const inherited = dropMolecule(edited).atoms.find(atom => atom.id === nitrogenId)!;
    expect(inherited.element, "N's old id now names the carbon after it").toBe("C");
    const policy = structureEditorChemistry(dropMolecule(document).id);
    expect(marksFollowAtoms(policy)).toBe(false);
    const committed = workflow.normalizeCommittedDocument(workflow.carryElectronMarksWithMovedAtoms(document, edited, policy));
    // The mark stays where it was, and normal association gives it to the nitrogen it sits beside.
    expect(markCenter(committed)).toEqual(markCenter(document));
    const markOwner = owner(committed, dropMark(document).id)!;
    const ownerAtom = dropMolecule(committed).atoms.find(atom => atom.id === markOwner.atomId)!;
    expect(ownerAtom.element).toBe("N");
    expect(ownerAtom).toMatchObject({ formalCharge: 1, markCharge: 1 });
    expect(dropMolecule(committed).atoms.find(atom => atom.id === nitrogenId)).toMatchObject({ element: "C", formalCharge: 0 });
    expect(dropMark(committed).anchor).not.toMatchObject({ kind: "atom", atomId: nitrogenId });
  });
});
