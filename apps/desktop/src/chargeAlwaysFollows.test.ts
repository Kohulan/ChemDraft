// Owner ruling 2026-11-21 (charge always follows): the shared rule, `followElectronMarksWithMovedAtoms`,
// on moves the DOM suite (chargeAlwaysFollows.dom.test.tsx) does not reach: an engine 2D relayout,
// and rigid turns and mirrors of atoms that leave the mark where it was, where the mark's offset from
// its atom must turn or mirror with the atoms.
import { beforeAll, describe, expect, it } from "vitest";
import { applyPatch, type ChemDraftDocument, type ElectronMarkObject, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import { transformPointForObject } from "@chemdraft/layout-engine";
import { phase4Timestamp } from "@chemdraft/document-workflow-core";
import { ensureOclResources, relayoutMolfile2D } from "@chemdraft/ocl-adapter";
import * as workflow from "./documentWorkflow";
import { commitChemistryRefusals } from "./commitChemistryGuard";
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
    const turned = workflow.rotateNativeMoleculeParts(document,
      { objectId: molecule.id, kind: "parts", atomIds: partIds, bondIds: [] }, 90);
    const vector = (drawing: ChemDraftDocument) => {
      const next = dropMolecule(drawing);
      const [n, c] = [partIds[0], partIds[1]].map(id => transformPointForObject(next, next.atoms.find(atom => atom.id === id)!));
      return Math.atan2(c.y - n.y, c.x - n.x);
    };
    const turn = vector(turned) - vector(document);
    expect(Math.abs(Math.cos(turn)), "the part turns by a quarter").toBeLessThan(1e-6);
    const committed = expectCommittedWithMarkKept(document, turned, nitrogenId);
    const original = offset(document, nitrogenId), kept = offset(committed, nitrogenId);
    expect(kept.x).toBeCloseTo(original.x * Math.cos(turn) - original.y * Math.sin(turn), 3);
    expect(kept.y).toBeCloseTo(original.x * Math.sin(turn) + original.y * Math.cos(turn), 3);
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
