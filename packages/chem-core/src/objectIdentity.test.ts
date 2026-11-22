import { describe, expect, it } from "vitest";
import {
  adoptDerivedDocument, applyPatch, applyPatches, createEmptyDocument, hasObjectIdentity, objectIdentity, retainObjectIdentity,
  serializeDocument, toEngineDocument, type ChemDraftDocument, type DocumentObject, type MoleculeObject
} from "./index";

const now = "2026-11-22T00:00:00.000Z";
const molecule = (id: string, x: number): MoleculeObject => ({
  id, type: "molecule", x, y: 0, width: 30, height: 20, rotation: 0, style: {},
  structureFormat: "smiles", structure: "CC",
  atoms: [{ id: "a1", element: "C", x, y: 0, formalCharge: 0 }, { id: "a2", element: "C", x: x + 30, y: 0, formalCharge: 0 }],
  bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" }], superatoms: [], rGroups: []
});
const text = (id: string): DocumentObject => ({
  id, type: "text", x: 0, y: 0, width: 10, height: 10, rotation: 0, style: {}, text: "T", spans: []
});

function twoPages(): ChemDraftDocument {
  const empty = createEmptyDocument({ now });
  return toEngineDocument({ ...empty, pages: [
    { ...empty.pages[0]!, id: "page-1", objects: [molecule("X", 0), text("T")] },
    { ...empty.pages[0]!, id: "page-2", objects: [] }
  ], selection: { pageId: "page-1", objectIds: [] } });
}
const find = (document: ChemDraftDocument, id: string) => document.pages.flatMap(page => page.objects).find(object => object.id === id)!;

describe("host-owned object identity (objectIdentity.ts)", () => {
  it("an edit, restyle, or move patch keeps the object's identity", () => {
    const before = twoPages();
    const identity = objectIdentity(find(before, "X"));
    const after = applyPatches(before, [
      { op: "updateObject", objectId: "X", changes: { y: 12 } },
      { op: "updateObject", objectId: "X", changes: { style: { color: "#112233" } } },
      { op: "moveObject", objectId: "X", x: 40, y: 50 }
    ], { now });
    expect(find(after, "X")).not.toBe(find(before, "X"));
    expect(hasObjectIdentity(find(after, "X"), identity)).toBe(true);
  });

  it("an object edited before anyone asked for its identity still matches its undo state", () => {
    const before = twoPages();
    const after = applyPatch(before, { op: "updateObject", objectId: "X", changes: { y: 12 } }, { now });
    expect(hasObjectIdentity(find(before, "X"), objectIdentity(find(after, "X")))).toBe(true);
  });

  it("an insertion is always a new object, even of an exact copy or the same value under a freed id", () => {
    const before = twoPages();
    const original = find(before, "X");
    const identity = objectIdentity(original);
    const removed = applyPatch(before, { op: "removeObject", objectId: "X" }, { now });
    for (const object of [original, structuredClone(original)]) {
      const reinserted = applyPatch(removed, { op: "addObject", pageId: "page-1", object }, { now });
      expect(hasObjectIdentity(find(reinserted, "X"), identity)).toBe(false);
    }
    // Remove and re-add in one batch: still a new object.
    const replaced = applyPatches(before, [{ op: "removeObject", objectId: "X" },
      { op: "addObject", pageId: "page-1", object: molecule("X", 0) }], { now });
    expect(hasObjectIdentity(find(replaced, "X"), identity)).toBe(false);
  });

  it("the engine's copy of a whole document keeps every object's identity", () => {
    const before = twoPages();
    const identity = objectIdentity(find(before, "X"));
    // A spread document is unknown to the engine: the next patch copies all of it.
    const spread = { ...before, pages: [...before.pages] };
    const after = applyPatch(spread, { op: "updateObject", objectId: "T", changes: { x: 3 } }, { now });
    expect(find(after, "X")).not.toBe(find(before, "X"));
    expect(hasObjectIdentity(find(after, "X"), identity)).toBe(true);
    expect(hasObjectIdentity(find(toEngineDocument(spread), "X"), identity)).toBe(true);
  });

  it("adoptDerivedDocument carries identity to a same-id, same-page derived copy", () => {
    const before = twoPages();
    const identity = objectIdentity(find(before, "X"));
    const derived = { ...before, pages: [{ ...before.pages[0]!, objects: before.pages[0]!.objects.map(object =>
      object.id === "X" ? { ...object, y: 7 } : object) }, before.pages[1]!] };
    const adopted = adoptDerivedDocument(before, derived);
    expect(find(adopted, "X")).toMatchObject({ y: 7 });
    expect(hasObjectIdentity(find(adopted, "X"), identity)).toBe(true);
  });

  it("adoptDerivedDocument fails closed: a newcomer beside the moved original, or of another type, is a new object", () => {
    const before = twoPages();
    const original = find(before, "X");
    const identity = objectIdentity(original);
    // The original moves to page 2 (same value); a same-id copy appears on page 1.
    const moved = adoptDerivedDocument(before, { ...before, pages: [
      { ...before.pages[0]!, objects: [{ ...original, x: 99 }, find(before, "T")] },
      { ...before.pages[1]!, objects: [original] }
    ] });
    expect(hasObjectIdentity(moved.pages[1]!.objects[0]!, identity)).toBe(true);
    expect(hasObjectIdentity(moved.pages[0]!.objects[0]!, identity)).toBe(false);
    // Same id, different type.
    const textIdentity = objectIdentity(find(before, "T"));
    const retyped = adoptDerivedDocument(before, { ...before, pages: [
      { ...before.pages[0]!, objects: [original, molecule("T", 60)] }, before.pages[1]!
    ] });
    expect(hasObjectIdentity(find(retyped, "T"), textIdentity)).toBe(false);
  });

  it("retainObjectIdentity carries only to a same-id, same-type value without an identity of its own", () => {
    const a = molecule("X", 0);
    const identity = objectIdentity(a);
    const renamed = { ...a, id: "Y" };
    retainObjectIdentity(a, renamed);
    expect(hasObjectIdentity(renamed, identity)).toBe(false);
    const other = molecule("X", 5);
    const otherIdentity = objectIdentity(other);
    retainObjectIdentity(a, other);
    expect(hasObjectIdentity(other, otherIdentity)).toBe(true);
    const copy = { ...a, y: 3 };
    retainObjectIdentity(a, copy);
    expect(hasObjectIdentity(copy, identity)).toBe(true);
  });

  it("is never part of the document's data", () => {
    const document = twoPages();
    const file = serializeDocument(document);
    const json = JSON.stringify(document);
    objectIdentity(find(document, "X"));
    const edited = applyPatch(document, { op: "updateObject", objectId: "X", changes: { y: 1 } }, { now });
    expect(serializeDocument(document)).toBe(file);
    expect(JSON.stringify(document)).toBe(json);
    expect(Object.getOwnPropertySymbols(find(edited, "X"))).toEqual([]);
    expect(Object.keys(find(edited, "X"))).toEqual(Object.keys(find(document, "X")));
  });
});
