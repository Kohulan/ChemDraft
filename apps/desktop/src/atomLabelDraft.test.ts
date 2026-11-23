import { describe, expect, it } from "vitest";
import { applyPatches, createDocumentHistory, moleculeToMolfileV2000, undo, type ChemDraftDocument, type DocumentHistory, type MoleculeObject } from "@chemdraft/chem-core";
import { atomDisplayLabel } from "@chemdraft/layout-engine";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { nativeBondOrderResolution, nativeSingleBondGraphMetadata, normalizeNativeMoleculeGeometry, tryNativeSingleBondGraphSmiles } from "@chemdraft/document-workflow-core";
import { atomLabelDraftDocumentUnchanged, createAtomLabelDraftRollback, recordAtomLabelDraftRollback, restoreAtomLabelDraft, type AtomLabelDraftState } from "./atomLabelDraft";
import { applyColorToNativeMoleculePart, applyNativeAtomElementTarget, commitNativeAtomLabelTarget, createPhase4Document, insertNativeTemplateMolecule, moveNativeMoleculeParts, nativeMoleculeInvalidAtomStates } from "./documentWorkflow";

function molecule(document: ChemDraftDocument): MoleculeObject {
  return document.pages[0].objects[0] as MoleculeObject;
}

function replaceMolecule(document: ChemDraftDocument, next: MoleculeObject): ChemDraftDocument {
  return { ...document, pages: document.pages.map(page => ({ ...page,
    objects: page.objects.map(object => object.id === next.id ? next : object) })) };
}

function fixture() {
  const document = insertNativeTemplateMolecule(createPhase4Document(), { x: 300, y: 300 }, "cyclohexane");
  const original = molecule(document);
  // A stated count on every atom: a relabel is a chemical edit of the relabeled atom only, so it
  // drops that atom's count and the others keep theirs (owner ruling 1.2.3); rollback stays exact.
  const before: MoleculeObject = { ...original, structureFormat: "molfile-v2000",
    structure: moleculeToMolfileV2000(original, { kekuleBondOrders: nativeBondOrderResolution(original.atoms, original.bonds).kekuleOrders }).contents,
    atoms: original.atoms.map(atom => ({ ...atom, hydrogenCount: 2, warningSuppressed: true,
      labelVisible: true, labelOffset: { x: 1, y: 2 } })) };
  const state: AtomLabelDraftState = { objectId: before.id, atomId: before.atoms[0]!.id,
    draftBeforeAtom: before.atoms[0]!, draftBeforeMolecule: before,
    draftRollback: createAtomLabelDraftRollback(before) };
  return { document: replaceMolecule(document, before), before, state };
}

function draft(document: ChemDraftDocument, state: AtomLabelDraftState, label = "OMe") {
  const next = applyNativeAtomElementTarget(document, {
    objectId: state.objectId, kind: "atom", atomId: state.atomId, distanceToPointer: 0
  }, label, { literal: true });
  recordAtomLabelDraftRollback(state, molecule(document), molecule(next));
  return next;
}

function expectDerivedFromGraph(object: MoleculeObject) {
  const smiles = tryNativeSingleBondGraphSmiles(object.atoms, object.bonds);
  expect(object.structureFormat).toBe("smiles");
  expect(object.structure).toBe("smiles" in smiles ? smiles.smiles : "");
  expect(object.chemistry).toEqual(nativeSingleBondGraphMetadata(object.atoms, object.bonds));
  const geometry = normalizeNativeMoleculeGeometry(object);
  for (const key of ["x", "y", "width", "height"] as const) expect(object[key]).toBe(geometry[key]);
}

describe("atom-label draft rollback", () => {
  it("leaves the entire document alone when an external label supersedes the draft", () => {
    const { document, state } = fixture();
    const preview = draft(document, state);
    const current = molecule(preview);
    const external = replaceMolecule(preview, { ...current, atoms: current.atoms.map(atom => atom.id === state.atomId
      ? { ...atom, element: "O", labelLiteral: undefined } : atom) });
    expect(restoreAtomLabelDraft(external, state)).toBe(external);
  });

  it("cancels later draft keys back to an externally accepted label, rather than the original label", () => {
    const { document, state } = fixture();
    const preview = draft(document, state, "NM");
    const current = molecule(preview);
    const accepted = { ...current, atoms: current.atoms.map(atom => atom.id === state.atomId
      ? { ...atom, element: "O" } : atom) };
    const continued = draft(replaceMolecule(preview, accepted), state, "NMe");
    expect(molecule(restoreAtomLabelDraft(continued, state))).toBe(accepted);
  });

  it("a draft retyping the same element drops that atom's stated count; rollback restores it exactly", () => {
    // Master decision 2026-11-22: retyping is an explicit user statement; the typed label wins.
    const { document, before, state } = fixture();
    const preview = draft(document, state, "C");
    expect(molecule(preview).atoms[0]).toMatchObject({ element: "C", labelLiteral: true });
    expect(molecule(preview).atoms.map(atom => atom.hydrogenCount)).toEqual([undefined, 2, 2, 2, 2, 2]);
    expect(molecule(restoreAtomLabelDraft(preview, state))).toEqual(before);
  });

  it("restores an imported molecule exactly; the relabel kept the other atoms' stated counts", () => {
    const { document, before, state } = fixture();
    const preview = draft(document, state);
    expect(molecule(preview).atoms.map(atom => atom.hydrogenCount)).toEqual([undefined, 2, 2, 2, 2, 2]);
    expect(molecule(restoreAtomLabelDraft(preview, state))).toEqual(before);
  });

  it("keeps another atom's move and flags and recomputes structure, chemistry and bounds", () => {
    const { document, before, state } = fixture();
    const preview = draft(document, state);
    const other = before.atoms[2]!;
    const moved = moveNativeMoleculeParts(preview, { objectId: before.id, kind: "atom", atomId: other.id }, { x: 120, y: 60 });
    const restored = molecule(restoreAtomLabelDraft(moved, state));
    expect(restored.atoms[0]).toEqual(before.atoms[0]);
    expect(restored.atoms[2]).toEqual(molecule(moved).atoms[2]);
    expect(restored.atoms[1]).toEqual(before.atoms[1]);
    // A move is not a chemical edit: the moved atom keeps its stated count.
    expect(restored.atoms[2]!.hydrogenCount).toBe(2);
    expect(restored.width).toBeGreaterThan(before.width);
    expectDerivedFromGraph(restored);
  });

  it("restores only label fields on the edited atom, preserving its current move, charge and display data", () => {
    const { document, before, state } = fixture();
    const preview = draft(document, state);
    const current = molecule(preview);
    const edited = { ...current, atoms: current.atoms.map(atom => atom.id === state.atomId
      ? { ...atom, x: atom.x + 120, y: atom.y + 60, formalCharge: 1, labelOffset: { x: 10, y: 20 } } : atom) };
    const restored = molecule(restoreAtomLabelDraft(replaceMolecule(preview, edited), state));
    expect(restored.atoms[0]).toEqual({ ...before.atoms[0], x: edited.atoms[0]!.x, y: edited.atoms[0]!.y,
      formalCharge: 1, labelOffset: { x: 10, y: 20 } });
    expectDerivedFromGraph(restored);
  });

  it("does not adopt an external edit as draft cleanup when more keys follow it", () => {
    const { document, before, state } = fixture();
    let preview = draft(document, state, "O");
    const current = molecule(preview);
    const edited = { ...current, atoms: current.atoms.map((atom, index) => index === 2
      ? { ...atom, warningSuppressed: false, labelOffset: { x: 10, y: 20 }, hydrogenCount: 0 } : atom) };
    preview = draft(replaceMolecule(preview, edited), state);
    const restored = molecule(restoreAtomLabelDraft(preview, state));
    expect(restored.atoms[2]).toEqual(molecule(preview).atoms[2]);
    expect(restored.atoms[2]!.warningSuppressed).toBe(false);
    // The external edit's count stays: the later keys edited atom 0, not this atom.
    expect(restored.atoms[2]!.hydrogenCount).toBe(0);
    expect(restored.atoms[1]).toEqual(before.atoms[1]);
    expectDerivedFromGraph(restored);
  });

  it("keeps another atom's recolour without restoring that changed atom's cleared hints", () => {
    const { document, before, state } = fixture();
    const preview = draft(document, state);
    const recoloured = applyColorToNativeMoleculePart(preview, {
      objectId: before.id, kind: "atom", atomId: before.atoms[2]!.id
    }, "#b3261e");
    const restored = molecule(restoreAtomLabelDraft(recoloured, state));
    expect(restored.style).toEqual(molecule(recoloured).style);
    expect(restored.style.atomLabelColors).toEqual({ [before.atoms[2]!.id]: "#b3261e" });
    expect(restored.atoms[2]).toEqual(molecule(recoloured).atoms[2]);
    expect(restored.atoms[1]).toEqual(before.atoms[1]);
    expectDerivedFromGraph(restored);
  });

  it("does not restore hints superseded by an incident-bond change or resurrect deleted atoms", () => {
    const { document, before, state } = fixture();
    const preview = draft(document, state);
    const current = molecule(preview);
    const changed = { ...current, atoms: current.atoms.filter(atom => atom.id !== before.atoms[4]!.id),
      bonds: current.bonds.filter(bond => bond.fromAtomId !== before.atoms[4]!.id && bond.toAtomId !== before.atoms[4]!.id)
        .map((bond, index) => index === 1 ? { ...bond, order: "double" as const } : bond) };
    const restored = molecule(restoreAtomLabelDraft(replaceMolecule(preview, changed), state));
    expect(restored.atoms.some(atom => atom.id === before.atoms[4]!.id)).toBe(false);
    // The atom whose bond changed after the preview is left as that edit left it, never rolled back.
    expect(restored.atoms[2]).toEqual(changed.atoms[2]);
    expect(restored.bonds).toEqual(changed.bonds);
    expectDerivedFromGraph(restored);
  });

  it("commits a substituent after rollback while keeping the other atom's move", () => {
    const { document, before, state } = fixture();
    const preview = draft(document, state);
    const moved = moveNativeMoleculeParts(preview, { objectId: before.id, kind: "atom", atomId: before.atoms[2]!.id }, { x: 120, y: 60 });
    const baseline = restoreAtomLabelDraft(moved, state);
    const result = commitNativeAtomLabelTarget(baseline, {
      objectId: before.id, kind: "atom", atomId: state.atomId, distanceToPointer: 0
    }, "OMe", { literal: true, beforeAtom: before.atoms[0], beforeMolecule: before });
    const committed = molecule(result.document);
    expect(committed.atoms[2]).toEqual(molecule(moved).atoms[2]);
    expect(committed.atoms).toHaveLength(7);
    expect(committed.bonds).toHaveLength(7);
    expect(committed.atoms[6]).toMatchObject({ element: "OMe", labelLiteral: true });
    expectDerivedFromGraph(committed);
  });
});

// Master decision 2026-11-22 (refined): a typed label that equals the label drawn for the atom, its
// implicit H included, says nothing new, so committing it changes nothing: the stated count and the
// aromatic ring's Kekule hint stay. Typed text that differs from the drawn label wins and drops the
// count. A retype that leaves the aromatic system without a Kekule pattern is never silent: the
// ring's atoms are badged, as for any other label edit (AGENTS.md section 7).
describe("committing a typed label over the label drawn for an aromatic NH", () => {
  const ring = (smiles: string) => {
    const graph = testMoleculeFromSmiles(smiles);
    const object: MoleculeObject = { id: "m", type: "molecule", x: 0, y: 0, width: 100, height: 100, rotation: 0, style: {},
      structureFormat: "molfile-v2000", structure: "", superatoms: [], rGroups: [],
      atoms: graph.atoms.map(atom => ({ ...atom, x: 200 + atom.x * 3, y: 200 + atom.y * 3 })), bonds: [...graph.bonds] };
    const base = createPhase4Document("Retype");
    const document = applyPatches(base, [{ op: "addObject", pageId: base.pages[0]!.id, object }]);
    const nitrogen = molecule(document).atoms.find(atom => atom.element === "N" && atom.hydrogenCount === 1)!;
    return { document, nitrogen, target: { objectId: object.id, kind: "atom" as const, atomId: nitrogen.id, distanceToPointer: 0 } };
  };
  const drawn = (document: ChemDraftDocument, atomId: string) => {
    const object = molecule(document);
    return atomDisplayLabel(object.atoms.find(atom => atom.id === atomId)!, object.bonds, undefined, object.atoms);
  };
  const badges = (document: ChemDraftDocument) =>
    nativeMoleculeInvalidAtomStates(molecule(document)).filter(state => !state.warningSuppressed);
  const rings = [["pyrrole", "c1cc[nH]c1"], ["indole", "c1ccc2[nH]ccc2c1"], ["imidazole", "c1c[nH]cn1"]] as const;

  it.each(rings)("\"NH\" typed over the drawn NH of %s changes nothing: the stated count and the Kekule hint stay", (_name, smiles) => {
    const { document, nitrogen, target } = ring(smiles);
    expect(drawn(document, nitrogen.id)).toBe("NH");
    expect(badges(document)).toEqual([]);
    const result = commitNativeAtomLabelTarget(document, target, "NH", { literal: true, replaceElement: true });
    expect(result.document).toBe(document);
    expect(result.refusal).toBeUndefined();
    expect(molecule(result.document).atoms.find(atom => atom.id === nitrogen.id)).toEqual(nitrogen);
  });

  it.each(rings)("\"N\" typed over the drawn NH of %s is never silent: the ring is badged, and undo restores it exactly", (name, smiles) => {
    const { document, nitrogen, target } = ring(smiles);
    const committed = commitNativeAtomLabelTarget(document, target, "N", { literal: true, replaceElement: true }).document;
    const retyped = molecule(committed).atoms.find(atom => atom.id === nitrogen.id)!;
    expect(retyped).toMatchObject({ element: "N", labelLiteral: true });
    expect(retyped.hydrogenCount).toBeUndefined();
    const shown = badges(committed);
    if (name === "imidazole") {
      // The ring still kekulizes, but only with the H guessed onto the other N: that N is badged.
      const other = molecule(committed).atoms.find(atom => atom.element === "N" && atom.id !== nitrogen.id)!;
      expect(drawn(committed, other.id)).toBe("NH");
      expect(shown).toEqual([expect.objectContaining({ atomId: other.id, tautomerGuessed: true,
        invalidReason: "N: hydrogen count guessed from the aromatic bonds. Draw the H to settle it." })]);
    } else {
      // Without its H the ring has no Kekule pattern: every ring atom is badged, the typed N included.
      expect(shown).toContainEqual(expect.objectContaining({ atomId: nitrogen.id, unresolvedAromatic: true,
        invalidReason: "N: its aromatic bonds don't resolve into single and double bonds." }));
      expect(shown.every(state => state.unresolvedAromatic === true)).toBe(true);
    }
    // The app's history keeps whole committed documents; undo puts the one before the retype back.
    const history: DocumentHistory = { ...createDocumentHistory(document), past: [document], present: committed };
    const undone = undo(history);
    expect(undone.present).toBe(document);
    expect(molecule(undone.present).atoms.find(atom => atom.id === nitrogen.id)).toEqual(nitrogen);
    expect(badges(undone.present)).toEqual([]);
  });
});

describe("immutable atom-label cancellation snapshots", () => {
  it("ignores shell and edited-atom key order while checking non-label fields", () => {
    const { document, state } = fixture();
    const original = molecule(document);
    const reorder = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).reverse()) as T;
    const changed = replaceMolecule(document, reorder({ ...original, atoms: original.atoms.map(atom =>
      atom.id === state.atomId ? reorder({ ...atom, element: "NMe" }) : atom) }));
    expect(atomLabelDraftDocumentUnchanged(reorder(changed), document, state)).toBe(true);
    const moved = replaceMolecule(changed, { ...molecule(changed), atoms: molecule(changed).atoms.map(atom =>
      atom.id === state.atomId ? { ...atom, x: atom.x + 1 } : atom) });
    expect(atomLabelDraftDocumentUnchanged(moved, document, state)).toBe(false);
  });

  it("detects explicit undefined and external selection differences", () => {
    const { document, state } = fixture();
    const current = molecule(document);
    const changed = replaceMolecule(document, { ...current, atoms: current.atoms.map(atom => atom.id === state.atomId
      ? { ...atom, z: undefined } : atom) });
    expect(atomLabelDraftDocumentUnchanged(changed, document, state)).toBe(false);
    expect(atomLabelDraftDocumentUnchanged({ ...document, selection: { ...document.selection, objectIds: [] } }, document, state)).toBe(false);
  });

  it("treats replaced atoms, bonds, other objects and other pages as intervening changes", () => {
    const { document, state } = fixture();
    const current = molecule(document);
    for (const changed of [
      { ...current, atoms: current.atoms.map((atom, index) => index === 1 ? { ...atom } : atom) },
      { ...current, bonds: current.bonds.map((bond, index) => index === 0 ? { ...bond } : bond) }
    ]) expect(atomLabelDraftDocumentUnchanged(replaceMolecule(document, changed), document, state)).toBe(false);
    const page = document.pages[0]!;
    const other = { ...current, id: "other-molecule" };
    const twoObjects = { ...document, pages: [{ ...page, objects: [...page.objects, other] }] };
    expect(atomLabelDraftDocumentUnchanged({ ...twoObjects, pages: [{ ...twoObjects.pages[0]!, objects: [current, { ...other }] }] }, twoObjects, state)).toBe(false);
    const otherPage = { ...page, id: "other-page", objects: [] };
    const twoPages = { ...document, pages: [page, otherPage] };
    expect(atomLabelDraftDocumentUnchanged({ ...twoPages, pages: [page, { ...otherPage }] }, twoPages, state)).toBe(false);
  });

  it("does not inspect the payload of unchanged objects", () => {
    const { document, state } = fixture();
    const page = document.pages[0]!;
    const other = { ...molecule(document), id: "large-molecule", get structure(): string { throw new Error("Payload visited"); } };
    const withLargeObject = { ...document, pages: [{ ...page, objects: [...page.objects, other] }] };
    const copy = { ...withLargeObject, pages: [{ ...withLargeObject.pages[0]!, objects: [...withLargeObject.pages[0]!.objects] }] };
    expect(atomLabelDraftDocumentUnchanged(copy, withLargeObject, state)).toBe(true);
  });
});
