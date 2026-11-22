import { describe, expect, it, vi } from "vitest";
import {
  adoptDerivedDocument, applyPatch, applyPatches, createEmptyDocument, hasObjectIdentity, objectIdentity, retainObjectIdentity,
  serializeDocument, toEngineDocument, type ChemDraftDocument, type DocumentObject, type MoleculeObject
} from "./index";
import { OBJECT_IDENTITY_RUNTIME_VERSION, resolveObjectIdentityRuntime } from "./objectIdentity";

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

  it("the engine's copy of a whole document keeps the identity of a molecule inside a repeat unit", () => {
    const empty = createEmptyDocument({ now });
    const unit = (id: string, side: "open" | "close", x: number): DocumentObject => ({ id, type: "bracket", bracketKind: "square",
      x, y: 0, width: 10, height: 60, rotation: 0, style: {}, containedObjectIds: ["X"], pairId: "pair", side, repeatUnit: true,
      bracketUsage: "sru", ...(side === "close" ? { label: "n" } : {}) });
    const withRecord = { ...molecule("X", 0), chemistry: { formula: "C2H6", isotopeLabels: [], stereochemistry: [], warnings: [] } };
    const before = applyPatches(toEngineDocument({ ...empty, pages: [{ ...empty.pages[0]!, id: "page-1", objects: [] }] }),
      [withRecord, unit("open", "open", -10), unit("close", "close", 40)].map(object => ({ op: "addObject" as const, pageId: "page-1", object })), { now });
    const identity = objectIdentity(find(before, "X"));
    // Parsing the copy regenerates the molecule's repeat-unit warning before the copy is matched to it.
    const copy = toEngineDocument({ ...before, pages: [...before.pages] });
    expect(find(copy, "X")).not.toBe(find(before, "X"));
    expect(hasObjectIdentity(find(copy, "X"), identity)).toBe(true);
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

  it("Kimi 1.2.3 finding 4: an edited cross-page move beside a same-id newcomer donates the identity to neither", () => {
    const before = twoPages();
    const original = find(before, "X");
    const identity = objectIdentity(original);
    // The selected X moves to page 2 as an edited copy; an unrelated X takes its place on page 1.
    const newcomer = molecule("X", 200);
    const adopted = adoptDerivedDocument(before, { ...before, pages: [
      { ...before.pages[0]!, objects: [newcomer, find(before, "T")] },
      { ...before.pages[1]!, objects: [{ ...original, y: 40 }] }
    ] });
    expect(adopted.pages[0]!.objects[0]).toMatchObject({ id: "X", x: 200 });
    expect(adopted.pages[1]!.objects[0]).toMatchObject({ id: "X", y: 40 });
    // Never the newcomer. Which of the two new values continues X cannot be told apart, so neither does.
    expect(hasObjectIdentity(adopted.pages[0]!.objects[0]!, identity)).toBe(false);
    expect(hasObjectIdentity(adopted.pages[1]!.objects[0]!, identity)).toBe(false);
  });

  it("Kimi 1.2.3 finding 4: an id whose replacements are ambiguous across pages carries nothing, and a lone in-place replacement still carries", () => {
    const empty = createEmptyDocument({ now });
    const before = toEngineDocument({ ...empty, pages: [
      { ...empty.pages[0]!, id: "page-1", objects: [molecule("X", 0)] },
      { ...empty.pages[0]!, id: "page-2", objects: [molecule("X", 300)] }
    ], selection: { pageId: "page-1", objectIds: [] } });
    const [first, second] = [before.pages[0]!.objects[0]!, before.pages[1]!.objects[0]!];
    const firstIdentity = objectIdentity(first), secondIdentity = objectIdentity(second);
    // Both same-id objects swap pages as edited copies: each page's new value may be either one.
    const swapped = adoptDerivedDocument(before, { ...before, pages: [
      { ...before.pages[0]!, objects: [{ ...second, y: 5 }] }, { ...before.pages[1]!, objects: [{ ...first, y: 5 }] }
    ] });
    for (const object of swapped.pages.flatMap(page => page.objects)) {
      expect(hasObjectIdentity(object, firstIdentity) || hasObjectIdentity(object, secondIdentity)).toBe(false);
    }
    // Only page 1's X is replaced in place; page 2's is kept: the replacement is unambiguous.
    const inPlace = adoptDerivedDocument(before, { ...before, pages: [
      { ...before.pages[0]!, objects: [{ ...first, y: 9 }] }, before.pages[1]!
    ] });
    expect(hasObjectIdentity(inPlace.pages[0]!.objects[0]!, firstIdentity)).toBe(true);
    expect(inPlace.pages[1]!.objects[0]).toBe(second);
  });

  it("Kimi 1.2.3 finding 5: deleting a bracket's partner keeps the surviving bracket's identity", () => {
    const empty = createEmptyDocument({ now });
    const bracket = (id: string, side: "open" | "close", x: number): DocumentObject => ({ id, type: "bracket", bracketKind: "square",
      x, y: 0, width: 16, height: 64, rotation: 0, style: {}, containedObjectIds: [], pairId: "pair", side });
    const before = toEngineDocument({ ...empty, pages: [{ ...empty.pages[0]!, id: "page-1",
      objects: [bracket("open", "open", 0), bracket("close", "close", 80)] }], selection: { pageId: "page-1", objectIds: [] } });
    const identity = objectIdentity(find(before, "open"));
    const after = applyPatch(before, { op: "removeObject", objectId: "close" }, { now, preserveRepeatUnitBrackets: true });
    const survivor = find(after, "open");
    // The orphaned bracket loses its pair metadata, but it is still the same object.
    expect(survivor).not.toBe(find(before, "open"));
    expect(survivor).not.toHaveProperty("pairId");
    expect(hasObjectIdentity(survivor, identity)).toBe(true);
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

/**
 * Kimi run-20261122-123139-b532aa, finding 2: identity was a module-private WeakMap, while the published
 * plugin-host SDK bundles its own chem-core. An embedder applying writes through another chem-core copy
 * carried identity in that copy only: the first write passed, and the next write to the same selected
 * object no longer resolved its pin. Every chem-core copy in a realm now shares one identity runtime.
 */
describe("one identity runtime per realm, shared by every chem-core copy", () => {
  /** A second, separately evaluated chem-core module instance: the embedder's own copy. */
  async function secondCopy() {
    vi.resetModules();
    const copy = await import("./index");
    expect(copy.applyPatch).not.toBe(applyPatch);
    expect(copy.objectIdentity).not.toBe(objectIdentity);
    return copy;
  }

  it("two writes through another copy keep the identity this copy pinned, and each copy sees the other's", async () => {
    const embedder = await secondCopy();
    const before = twoPages();
    const pin = objectIdentity(find(before, "X")); // The SDK's copy pins the selected X.
    const first = embedder.applyPatch(before, { op: "updateObject", objectId: "X", changes: { x: 10 } }, { now });
    expect(hasObjectIdentity(find(first, "X"), pin)).toBe(true);
    const second = embedder.applyPatch(first, { op: "updateObject", objectId: "X", changes: { x: 20 } }, { now });
    expect(find(second, "X")).toMatchObject({ x: 20 });
    expect(hasObjectIdentity(find(second, "X"), pin)).toBe(true);
    expect(embedder.hasObjectIdentity(find(second, "X"), pin)).toBe(true);
    // And the other way round: an identity the embedder's copy minted holds across this copy's edits.
    const theirs = embedder.objectIdentity(find(second, "T"));
    const third = applyPatch(second, { op: "updateObject", objectId: "T", changes: { x: 5 } }, { now });
    expect(embedder.hasObjectIdentity(find(third, "T"), theirs)).toBe(true);
  });

  it("an insertion through another copy is still a new object, even under a freed id", async () => {
    const embedder = await secondCopy();
    const before = twoPages();
    const pin = objectIdentity(find(before, "X"));
    const replaced = embedder.applyPatches(before, [{ op: "removeObject", objectId: "X" },
      { op: "addObject", pageId: "page-1", object: structuredClone(find(before, "X")) }], { now });
    expect(hasObjectIdentity(find(replaced, "X"), pin)).toBe(false);
  });

  it("publishes a frozen runtime that exposes no map and cannot be replaced", () => {
    const scope = {};
    const runtime = resolveObjectIdentityRuntime(scope);
    expect(resolveObjectIdentityRuntime(scope)).toBe(runtime);
    const key = Symbol.for("chemdraft.chem-core.objectIdentity");
    const descriptor = Object.getOwnPropertyDescriptor(scope, key)!;
    expect(descriptor).toMatchObject({ value: runtime, enumerable: false, writable: false, configurable: false });
    expect(Object.keys(scope)).toEqual([]);
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(runtime.version).toBe(OBJECT_IDENTITY_RUNTIME_VERSION);
    expect(Object.values(runtime).some(value => value instanceof WeakMap)).toBe(false);
    expect(() => { (scope as Record<symbol, unknown>)[key] = {}; }).toThrow(TypeError);
    // This realm's chem-core uses the runtime published on globalThis.
    const object = molecule("Y", 0);
    const identity = objectIdentity(object);
    const realm = (globalThis as unknown as Record<symbol, ReturnType<typeof resolveObjectIdentityRuntime>>)[key]!;
    expect(realm.holds(object, identity)).toBe(true);
  });

  it("a copy that finds another version's runtime, or cannot publish, keeps its identities private (fail closed)", () => {
    const key = Symbol.for("chemdraft.chem-core.objectIdentity");
    const other = Object.freeze({ version: OBJECT_IDENTITY_RUNTIME_VERSION + 1, identityOf: () => Symbol(), holds: () => true,
      retain: () => {}, carry: () => {} });
    const newer = Object.defineProperty({}, key, { value: other });
    const mismatched = resolveObjectIdentityRuntime(newer);
    expect(mismatched).not.toBe(other);
    expect(resolveObjectIdentityRuntime(newer)).not.toBe(mismatched);
    const object = molecule("Y", 0);
    expect(mismatched.holds(object, mismatched.identityOf(structuredClone(object)))).toBe(false);
    const frozen = Object.freeze({});
    const unpublished = resolveObjectIdentityRuntime(frozen);
    expect(Object.getOwnPropertySymbols(frozen)).toEqual([]);
    expect(resolveObjectIdentityRuntime(frozen)).not.toBe(unpublished);
  });
});
