import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitParsedDocument, adoptDerivedDocument, applyPatch, applyPatches, createEmptyDocument, hasObjectIdentity, objectIdentity,
  parseDocument, retainObjectIdentity, toEngineDocument, type ChemDraftDocument, type DocumentObject, type MoleculeObject
} from "./index";
import { OBJECT_IDENTITY_RUNTIME_VERSION, resolveObjectIdentityRuntime } from "./objectIdentity";

/**
 * Kimi run-20261122-134802-dbfee4. Finding 1: chem-core adopted any frozen object of its version with four
 * function-shaped properties found under the runtime key, so a script that ran first could publish
 * `holds: () => true` and a same-id impostor satisfied every pin. Finding 2: the genuine shared runtime
 * exposed `carry`, which overwrote an object's identity, so anyone holding object references could carry
 * the selected object's identity onto an impostor; and the runtime called `WeakMap.prototype` methods
 * when it ran, so replacing them changed pin results.
 */
const key = Symbol.for("chemdraft.chem-core.objectIdentity");
const now = "2026-11-22T00:00:00.000Z";
const molecule = (id: string, x: number): MoleculeObject => ({
  id, type: "molecule", x, y: 0, width: 30, height: 20, rotation: 0, style: {},
  structureFormat: "smiles", structure: "CC",
  atoms: [{ id: "a1", element: "C", x, y: 0, formalCharge: 0 }, { id: "a2", element: "C", x: x + 30, y: 0, formalCharge: 0 }],
  bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" }], superatoms: [], rGroups: []
});
function twoPages(): ChemDraftDocument {
  const empty = createEmptyDocument({ now });
  return toEngineDocument({ ...empty, pages: [
    { ...empty.pages[0]!, id: "page-1", objects: [molecule("X", 0), molecule("Y", 100)] },
    { ...empty.pages[0]!, id: "page-2", objects: [] }
  ], selection: { pageId: "page-1", objectIds: ["X"] } });
}
const objects = (document: ChemDraftDocument) => document.pages.flatMap(page => page.objects);
const find = (document: ChemDraftDocument, id: string) => objects(document).find(object => object.id === id)!;
/** As plugin-host's resolvePinnedObject: every object named `id` that holds the pin. */
const pinned = (document: ChemDraftDocument, id: string, pin: ReturnType<typeof objectIdentity>) =>
  objects(document).filter(object => object.id === id && hasObjectIdentity(object, pin));
/** The user deletes the selected X and pastes a same-id, same-content copy back. */
const replaceWithImpostor = (document: ChemDraftDocument) => applyPatches(document, [{ op: "removeObject", objectId: "X" },
  { op: "addObject", pageId: "page-1", object: structuredClone(find(document, "X")) }], { now });

type Runtime = ReturnType<typeof resolveObjectIdentityRuntime>;
const realmRuntime = () => (globalThis as unknown as Record<symbol, Runtime>)[key]!;
/** `runtime` published on a stand-in global, as the real one is: non-enumerable, non-writable, non-configurable. */
const scopeHolding = (runtime: unknown) => Object.defineProperty({}, key, { value: runtime });
const shaped = (operations: Record<string, unknown>) =>
  Object.freeze(Object.assign(Object.create(null) as object, { version: OBJECT_IDENTITY_RUNTIME_VERSION, ...operations }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("finding 1: chem-core adopts a published identity runtime only if it came from chem-core", () => {
  /** Runtimes a script could publish before chem-core loads. Each must be refused. */
  function forgeries(): Array<[string, unknown]> {
    // Kimi's probe: same version, frozen, four function-shaped properties, a holds() that matches anything.
    const kimi = Object.freeze({ version: OBJECT_IDENTITY_RUNTIME_VERSION, identityOf: () => Symbol("forged"),
      holds: () => true, retain: () => {}, carry: () => {} });
    // The same lie in exactly the runtime's shape.
    const exactShape = shaped({ identityOf: () => Symbol("forged"), holds: () => true, retain: () => {} });
    // A careful forgery: a real map, but holds() also matches any value with the object's id and type.
    const map = new WeakMap<object, symbol>(), byId = new Map<string, symbol>();
    const label = (object: DocumentObject) => `${object.type}:${object.id}`;
    const identityOf = (object: DocumentObject) => {
      let identity = map.get(object);
      if (!identity) {
        identity = Symbol("forged");
        map.set(object, identity);
        if (!byId.has(label(object))) byId.set(label(object), identity);
      }
      return identity;
    };
    const byIdForgery = shaped({ identityOf, holds: (object: DocumentObject, identity: symbol) =>
      map.get(object) === identity || byId.get(label(object)) === identity,
    retain: (before: DocumentObject, after: DocumentObject) => { if (!map.has(after)) map.set(after, identityOf(before)); } });
    // A forgery whose operations throw.
    const throwing = shaped({ identityOf: () => { throw new Error("no"); }, holds: () => true, retain: () => {} });
    return [["Kimi's probe", kimi], ["the runtime's exact shape", exactShape], ["an id-matching forgery", byIdForgery],
      ["a throwing forgery", throwing]];
  }

  it("a runtime published first whose holds() matches anything is not adopted, and an impostor does not satisfy the pin", async () => {
    vi.resetModules();
    const fresh = await import("./objectIdentity"); // A copy whose warn-once has not fired yet.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [name, forgery] of forgeries()) {
      const scope = scopeHolding(forgery);
      const runtime = fresh.resolveObjectIdentityRuntime(scope);
      expect(runtime, name).not.toBe(forgery);
      expect(Object.getOwnPropertyDescriptor(scope, key)!.value, name).toBe(forgery); // Never replaced either.
      const selected = molecule("X", 0);
      const pin = runtime.identityOf(selected);
      expect(runtime.holds(selected, pin), name).toBe(true);
      const impostor = structuredClone(selected);
      expect(runtime.holds(impostor, pin), name).toBe(false);
      runtime.retain(molecule("X", 9), impostor);
      expect(runtime.holds(impostor, pin), name).toBe(false);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/ignoring the object-identity runtime/);
  });

  it("a runtime of another version is kept apart silently, as before", async () => {
    vi.resetModules();
    const fresh = await import("./objectIdentity");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const newer = shaped({ version: OBJECT_IDENTITY_RUNTIME_VERSION + 1, identityOf: () => Symbol(), holds: () => true, retain: () => {} });
    const runtime = fresh.resolveObjectIdentityRuntime(scopeHolding(newer));
    expect(runtime).not.toBe(newer);
    expect(runtime.holds(molecule("X", 0), runtime.identityOf(molecule("X", 0)))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("only a fixed, hidden data property is adopted: a getter or a writable slot is refused even when it holds a genuine runtime", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const genuine = resolveObjectIdentityRuntime({});
    const getter = Object.defineProperty({}, key, { get: () => genuine });
    const writable = Object.defineProperty({}, key, { value: genuine, writable: true });
    const enumerable = Object.defineProperty({}, key, { value: genuine, enumerable: true });
    for (const scope of [getter, writable, enumerable]) {
      const runtime = resolveObjectIdentityRuntime(scope);
      expect(runtime).not.toBe(genuine);
      const object = molecule("X", 0);
      expect(genuine.holds(object, runtime.identityOf(object))).toBe(false); // Not sharing genuine's map.
    }
    // Inherited is not published: the copy publishes its own on the global itself.
    const inherited = Object.create(Object.defineProperty({}, key, { value: shaped({ identityOf: () => Symbol(),
      holds: () => true, retain: () => {} }) })) as object;
    const runtime = resolveObjectIdentityRuntime(inherited);
    expect(Object.getOwnPropertyDescriptor(inherited, key)!.value).toBe(runtime);
  });

  it("a runtime another chem-core copy published passes the check and is shared", async () => {
    const scope = {};
    const published = resolveObjectIdentityRuntime(scope);
    vi.resetModules();
    const other = await import("./objectIdentity");
    expect(other.resolveObjectIdentityRuntime).not.toBe(resolveObjectIdentityRuntime);
    expect(other.resolveObjectIdentityRuntime(scope)).toBe(published);
    // And this realm's copies share the runtime the first of them published on globalThis.
    const object = molecule("X", 0);
    expect(other.hasObjectIdentity(object, objectIdentity(object))).toBe(true);
  });

  it("once chem-core has loaded, the realm's runtime cannot be replaced", () => {
    const forgery = shaped({ identityOf: () => Symbol(), holds: () => true, retain: () => {} });
    const before = realmRuntime();
    expect(() => Object.defineProperty(globalThis, key, { value: forgery })).toThrow(TypeError);
    expect(() => { (globalThis as unknown as Record<symbol, unknown>)[key] = forgery; }).toThrow(TypeError);
    expect(realmRuntime()).toBe(before);
  });
});

describe("finding 2: nothing the shared runtime exposes moves an identity onto an impostor", () => {
  it("the published runtime has no carry, and using what it does expose a same-id impostor never resolves as the pinned object", async () => {
    const runtime = realmRuntime();
    expect(Object.getPrototypeOf(runtime)).toBeNull();
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Reflect.ownKeys(runtime).map(String).sort()).toEqual(["holds", "identityOf", "retain", "version"]);
    expect("carry" in runtime).toBe(false);
    for (const name of Reflect.ownKeys(runtime)) {
      expect(Object.getOwnPropertyDescriptor(runtime, name), String(name)).toMatchObject({ writable: false, configurable: false });
    }

    const before = twoPages();
    const selected = find(before, "X");
    const pin = objectIdentity(selected); // Send pins the selected X.
    const replaced = replaceWithImpostor(before);
    const impostor = find(replaced, "X");
    expect(impostor).not.toBe(selected);
    // Kimi's probe, with everything still exposed: on the global, from this copy, and from another copy.
    runtime.retain(selected, impostor);
    runtime.identityOf(impostor);
    retainObjectIdentity(selected, impostor);
    vi.resetModules();
    const embedder = await import("./index");
    embedder.retainObjectIdentity(selected, impostor);
    expect(runtime.holds(impostor, pin)).toBe(false);
    expect(pinned(replaced, "X", pin)).toEqual([]);
    // Later edits of the impostor carry the impostor's own identity, never the pin.
    const edited = embedder.applyPatch(replaced, { op: "updateObject", objectId: "X", changes: { x: 40 } }, { now });
    expect(pinned(edited, "X", pin)).toEqual([]);
    // The selected object itself still holds its pin across edits.
    const moved = applyPatch(before, { op: "updateObject", objectId: "X", changes: { x: 40 } }, { now });
    expect(pinned(moved, "X", pin)).toEqual([find(moved, "X")]);

    // retain fills in an identity only on a value that holds none, which no value in a document is: a value
    // forged outside every document can take it, but enters a document only as a new, parsed value.
    const forged = { ...selected, x: 500 };
    runtime.retain(selected, forged);
    expect(hasObjectIdentity(forged, pin)).toBe(true);
    const removed = applyPatch(before, { op: "removeObject", objectId: "X" }, { now });
    const pasted = applyPatch(removed, { op: "addObject", pageId: "page-1", object: forged }, { now });
    expect(find(pasted, "X")).toMatchObject({ x: 500 });
    expect(pinned(pasted, "X", pin)).toEqual([]);
  });

  it("every object of every document the engine returns already holds an identity, so retain cannot hand it another's", () => {
    const before = twoPages();
    const selected = find(before, "X");
    const pin = objectIdentity(selected);
    const removed = applyPatch(before, { op: "removeObject", objectId: "X" }, { now });
    const json = JSON.parse(JSON.stringify(before)) as unknown;
    const candidates: Array<[string, ChemDraftDocument]> = [
      ["a pasted copy", applyPatch(removed, { op: "addObject", pageId: "page-1", object: structuredClone(selected) }, { now })],
      ["a parsed document admitted as it is", admitParsedDocument(parseDocument(json))],
      ["a plain document copied into the engine", toEngineDocument(parseDocument(json))],
      // A derived document that adds a same-id newcomer where the selected X was deleted.
      ["a derived document's newcomer", adoptDerivedDocument(removed, { ...removed, pages: [
        { ...removed.pages[0]!, objects: [...removed.pages[0]!.objects, { ...selected, y: 30 }] }, removed.pages[1]!] })]
    ];
    for (const [name, document] of candidates) {
      const impostor = find(document, "X");
      expect(impostor, name).not.toBe(selected);
      retainObjectIdentity(selected, impostor);
      realmRuntime().retain(selected, impostor);
      expect(pinned(document, "X", pin), name).toEqual([]);
    }
  });
});

describe("finding 2: replacing built-ins after chem-core loads does not change pin results", () => {
  it("WeakMap.prototype get/set/has, Function.prototype call/apply, Reflect.apply and Symbol", () => {
    const runtime = realmRuntime();
    const before = twoPages();
    const selected = find(before, "X");
    const pin = objectIdentity(selected);
    const edited = find(applyPatch(before, { op: "updateObject", objectId: "X", changes: { y: 12 } }, { now }), "X");
    const impostor = find(replaceWithImpostor(before), "X");
    const impostorIdentity = objectIdentity(impostor);
    const unseen = molecule("X", 9);
    const continued = { ...selected, y: 3 };

    const weakMapPrototype = WeakMap.prototype as unknown as Record<string, unknown>;
    const functionPrototype = Function.prototype as unknown as Record<string, unknown>;
    const reflect = Reflect as unknown as Record<string, unknown>;
    const realm = globalThis as unknown as Record<string, unknown>;
    const saved = { get: weakMapPrototype.get, set: weakMapPrototype.set, has: weakMapPrototype.has,
      call: functionPrototype.call, apply: functionPrototype.apply, reflectApply: reflect.apply, symbol: realm.Symbol };
    let observed: Record<string, boolean> = {};
    try {
      // Every lookup "finds" the pin, nothing is ever recorded, and every new symbol is the pin.
      weakMapPrototype.get = function get() { return pin; };
      weakMapPrototype.has = function has() { return false; };
      weakMapPrototype.set = function set(this: unknown) { return this; };
      functionPrototype.call = function call() { return pin; };
      functionPrototype.apply = function apply() { return pin; };
      reflect.apply = () => pin;
      realm.Symbol = () => pin;
      observed = {
        impostor: hasObjectIdentity(impostor, pin),
        impostorThroughGlobal: runtime.holds(impostor, pin),
        unseen: hasObjectIdentity(unseen, pin),
        selected: hasObjectIdentity(selected, pin),
        edited: hasObjectIdentity(edited, pin),
        impostorKeepsItsOwn: objectIdentity(impostor) === impostorIdentity,
        mintedIsPin: objectIdentity(molecule("Z", 0)) === pin
      };
      retainObjectIdentity(selected, impostor);
      runtime.retain(selected, impostor);
      observed.impostorAfterRetain = hasObjectIdentity(impostor, pin);
      retainObjectIdentity(selected, continued);
      observed.continued = hasObjectIdentity(continued, pin);
    } finally {
      weakMapPrototype.get = saved.get;
      weakMapPrototype.set = saved.set;
      weakMapPrototype.has = saved.has;
      functionPrototype.call = saved.call;
      functionPrototype.apply = saved.apply;
      reflect.apply = saved.reflectApply;
      realm.Symbol = saved.symbol;
    }
    expect(observed).toEqual({ impostor: false, impostorThroughGlobal: false, unseen: false, selected: true, edited: true,
      impostorKeepsItsOwn: true, mintedIsPin: false, impostorAfterRetain: false, continued: true });
  });
});
