import type { DocumentObject } from "./schemas";

/**
 * Host-owned object identity (ChemDraft 1.2.3).
 *
 * An object id is document data: unique within a page, free again once its object is deleted, and
 * reused by a paste, an undo, or a plugin insert. So an id cannot tell "the object the user selected"
 * from "a different object that now has its id". This identity can. It lives only in memory, keyed
 * by the object value itself, like the bracket creation identity in brackets.ts, in one runtime that
 * every chem-core copy in the realm shares (below): it is never part of the schema, never serialized
 * (JSON and structured clone both drop it), and never reachable from a plugin, which imports only
 * `@chemdraft/plugin-api`.
 *
 * - Every object value has one identity, and never exchanges it for another. The engine gives one to
 *   every object of every document it adopts (`holdObjectIdentities`); the early returns of
 *   `applyPatches` with no patches and of `adoptDerivedDocument` are not pre-identified. Any other
 *   value gets one the first time it is asked for.
 * - An edit that replaces an object value with an edited copy of the same object carries the
 *   identity to the copy (`retainObjectIdentity`): a patch update or move, a normalization pass
 *   re-admitted through `adoptDerivedDocument`, the engine's copy of a whole document. A move to
 *   another page keeps the value itself; undo and redo reinstate earlier values, which still hold
 *   theirs. Carrying only ever fills in an identity a value does not have yet, so a value that is
 *   already in a document can never be handed another object's identity.
 * - An insertion (`addObject`: paste, duplicate, template, plugin insert) parses a new value, and so
 *   gets a fresh identity even when it reuses an id.
 * - Any other new value, including one made by a path that forgot to carry the identity, also gets a
 *   fresh one. A missed carry therefore fails closed: a pin stops resolving and its write is refused.
 *   It can never make a different object match.
 */
declare const objectIdentityBrand: unique symbol;
export type ObjectIdentity = symbol & { readonly [objectIdentityBrand]: true };

/*
 * Built-ins, captured when this module loads (Kimi run-20261122-134802-dbfee4, finding 2). The runtime,
 * and the check that adopts a runtime another copy published, call only these references, never a
 * method looked up when it runs: code that later replaces `WeakMap.prototype.get`, `set` or `has`,
 * `Function.prototype.call` or `apply`, `Reflect.apply`, `Symbol`, or an `Object` or `Reflect` static
 * changes nothing here. (`call.bind(method)` binds the intrinsic `call` itself, so calling the result
 * looks nothing up either.)
 */
const callIntrinsic = Function.prototype.call;
type IdentityMap = WeakMap<object, ObjectIdentity>;
const weakMapGet = callIntrinsic.bind(WeakMap.prototype.get) as (map: IdentityMap, key: object) => ObjectIdentity | undefined;
const weakMapSet = callIntrinsic.bind(WeakMap.prototype.set) as (map: IdentityMap, key: object, value: ObjectIdentity) => IdentityMap;
const weakMapHas = callIntrinsic.bind(WeakMap.prototype.has) as (map: IdentityMap, key: object) => boolean;
const hasOwnProperty = callIntrinsic.bind(Object.prototype.hasOwnProperty) as (object: object, key: PropertyKey) => boolean;
const WeakMapIntrinsic = WeakMap;
const SymbolIntrinsic = Symbol;
const { create, defineProperty, freeze, getOwnPropertyDescriptor, getPrototypeOf, isFrozen } = Object;
const { ownKeys } = Reflect;

/**
 * One identity runtime per JavaScript realm, shared by every chem-core copy loaded in it.
 *
 * A host can hold more than one chem-core: the published plugin-host SDK bundles its own, and an
 * embedder applies writes through another (its own `@chemdraft/chem-core`, or a writer built on it). A
 * module-private map would split identity between them: the embedder's edit would carry the identity in
 * its copy only, and the SDK's next pin check would find nothing (fail closed, but a legitimate second
 * write to the same selected object refused). So the first copy to load publishes its runtime on
 * `globalThis` under a registered symbol, and every later copy uses that one.
 *
 * - The runtime is a frozen, prototype-less object holding `version` and three operations, each a
 *   fixed property: `identityOf`, `holds` and `retain`, the operations chem-core already exports. It
 *   never exposes its map, and it has nothing that replaces an identity a value already holds (the
 *   `carry` of 1.2.3's first build did; Kimi run-20261122-134802-dbfee4, finding 2), so a holder of the
 *   global can do nothing a chem-core import cannot already do. The global property is non-enumerable,
 *   non-writable and non-configurable: once published it cannot be replaced.
 * - A later copy adopts a published runtime only after checking that it came from chem-core
 *   (`adoptablePublishedRuntime`; finding 1): it must sit in exactly that property, have exactly that
 *   shape, and behave as this module's runtime does on fresh probe values, which a stand-in whose
 *   `holds` matches anything, or anything with the id, does not. A copy that finds anything else keeps
 *   a private runtime and says so once on the console: identity is then not shared, and a pin made in
 *   one copy matches nothing edited in another (fail closed, never a wrong match). The check cannot
 *   tell chem-core from a forgery that a script placed in the realm before the first copy loaded and
 *   that behaves exactly like chem-core until asked about an object it targets. Such a script controls
 *   the realm the host runs in, which is out of scope: run untrusted code in a Worker.
 * - Built-ins are captured per chem-core copy, when that copy loads, not once per realm. A copy that
 *   loads after untrusted code has replaced `Object.isFrozen`, `WeakMap.prototype.get` or the like
 *   captures the replacements: it rejects the genuine runtime, makes a private one, and calls the
 *   poisoned methods. So every chem-core copy that will be used (the host's, the plugin-host SDK
 *   bundle's, an embedder's) must load before any untrusted code runs in the realm, not only the first.
 * - `version` names the semantics below. A copy that finds a runtime of another version, or cannot
 *   publish one (a frozen global), also keeps a private runtime, silently. Bump the version on any
 *   change to what an identity means, how it is carried, or the runtime's shape.
 * - Plugins never receive it. In the app they run in per-plugin Workers, another realm with its own
 *   global; and the host gives any plugin only deep-frozen structured clones (which hold no identity),
 *   while everything a plugin writes is parsed into a new value.
 */
export const OBJECT_IDENTITY_RUNTIME_VERSION = 2;
const runtimeKey = Symbol.for("chemdraft.chem-core.objectIdentity");
const runtimeOperations = ["identityOf", "holds", "retain"] as const;

interface ObjectIdentityRuntime {
  readonly version: typeof OBJECT_IDENTITY_RUNTIME_VERSION;
  /** The identity of `object`, minted now if it has none yet. */
  identityOf(object: DocumentObject): ObjectIdentity;
  /** Whether `object` holds `identity`. Never mints. */
  holds(object: DocumentObject, identity: ObjectIdentity): boolean;
  /** `after` takes `before`'s identity if it has the same id and type and holds none of its own yet. */
  retain(before: DocumentObject, after: DocumentObject): void;
}

/** A property descriptor with no prototype, so nothing on `Object.prototype` can add fields to it. */
function fixedProperty(value: unknown, enumerable: boolean): PropertyDescriptor {
  const descriptor = create(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.enumerable = enumerable;
  descriptor.writable = false;
  descriptor.configurable = false;
  return descriptor;
}

function createObjectIdentityRuntime(): ObjectIdentityRuntime {
  const identities: IdentityMap = new WeakMapIntrinsic();
  const identityOf = (object: DocumentObject): ObjectIdentity => {
    let identity = weakMapGet(identities, object);
    if (identity === undefined) {
      identity = SymbolIntrinsic("chemdraft.object") as ObjectIdentity;
      weakMapSet(identities, object, identity);
    }
    return identity;
  };
  const holds = (object: DocumentObject, identity: ObjectIdentity): boolean => weakMapGet(identities, object) === identity;
  const retain = (before: DocumentObject, after: DocumentObject): void => {
    if (before === after || before.id !== after.id || before.type !== after.type) return;
    const identity = identityOf(before);
    if (!weakMapHas(identities, after)) weakMapSet(identities, after, identity);
  };
  const runtime = create(null) as ObjectIdentityRuntime;
  defineProperty(runtime, "version", fixedProperty(OBJECT_IDENTITY_RUNTIME_VERSION, true));
  defineProperty(runtime, "identityOf", fixedProperty(identityOf, true));
  defineProperty(runtime, "holds", fixedProperty(holds, true));
  defineProperty(runtime, "retain", fixedProperty(retain, true));
  return freeze(runtime);
}

/** `object[key]` when it is an own data property that can never change (non-writable, non-configurable). */
function fixedOwnValue(object: object, key: PropertyKey): unknown {
  const descriptor = getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined || !hasOwnProperty(descriptor, "value") ||
    descriptor.writable !== false || descriptor.configurable !== false) return undefined;
  return descriptor.value;
}

/**
 * Whether `identityOf`, `holds` and `retain` behave as this module's runtime does, on probe values that
 * nothing else has seen. Above all, a fresh value with the same id and type as an object never holds
 * that object's identity, and `retain` never replaces an identity a value already holds.
 */
function behavesAsChemCore(runtime: ObjectIdentityRuntime): boolean {
  const { identityOf, holds, retain } = runtime;
  const probe = (id: string, type = "text") => ({ id, type }) as unknown as DocumentObject;
  const original = probe("chemdraft.identity-probe"), impostor = probe("chemdraft.identity-probe");
  const copy = probe("chemdraft.identity-probe"), retyped = probe("chemdraft.identity-probe", "molecule");
  const renamed = probe("chemdraft.identity-probe.other");
  const identity = identityOf(original);
  if (typeof identity !== "symbol" || identityOf(original) !== identity) return false;
  if (holds(original, identity) !== true || holds(original, SymbolIntrinsic("chemdraft.object") as ObjectIdentity) !== false) return false;
  // A same-id, same-type value never given the identity does not hold it, and asking does not give it one.
  if (holds(impostor, identity) !== false) return false;
  const impostorIdentity = identityOf(impostor);
  if (typeof impostorIdentity !== "symbol" || impostorIdentity === identity ||
    holds(impostor, impostorIdentity) !== true || holds(impostor, identity) !== false || holds(original, impostorIdentity) !== false) return false;
  // retain continues the object only onto a same-id, same-type value without an identity of its own.
  retain(original, copy);
  retain(original, impostor);
  retain(original, retyped);
  retain(original, renamed);
  return holds(copy, identity) === true && holds(impostor, identity) === false && holds(impostor, impostorIdentity) === true &&
    holds(retyped, identity) === false && holds(renamed, identity) === false;
}

type PublishedRuntime =
  | { readonly kind: "none" }
  | { readonly kind: "adoptable"; readonly runtime: ObjectIdentityRuntime }
  | { readonly kind: "other-version" }
  | { readonly kind: "untrusted"; readonly reason: string };

/**
 * What `scope` holds under the runtime key, and whether this copy may adopt it. Each property is read
 * once, through its descriptor, and must be fixed (non-writable, non-configurable): its value can then
 * never change, not even behind a Proxy, whose traps the language holds to a fixed property's value.
 */
function adoptablePublishedRuntime(scope: object): PublishedRuntime {
  try {
    const descriptor = getOwnPropertyDescriptor(scope, runtimeKey);
    if (descriptor === undefined) return { kind: "none" };
    if (!hasOwnProperty(descriptor, "value") || descriptor.writable !== false || descriptor.configurable !== false ||
      descriptor.enumerable !== false) return { kind: "untrusted", reason: "it is not a fixed, hidden data property" };
    const value: unknown = descriptor.value;
    if (typeof value !== "object" || value === null) return { kind: "untrusted", reason: "it is not an object" };
    const version = fixedOwnValue(value, "version");
    if (typeof version === "number" && version !== OBJECT_IDENTITY_RUNTIME_VERSION) return { kind: "other-version" };
    if (version !== OBJECT_IDENTITY_RUNTIME_VERSION) return { kind: "untrusted", reason: "it has no fixed version" };
    const keys = ownKeys(value);
    if (getPrototypeOf(value) !== null || !isFrozen(value) || keys.length !== runtimeOperations.length + 1) {
      return { kind: "untrusted", reason: "it does not have the runtime's shape" };
    }
    // With exactly four own keys, the four expected fixed properties are all of them.
    for (let index = 0; index < runtimeOperations.length; index += 1) {
      if (typeof fixedOwnValue(value, runtimeOperations[index]!) !== "function") {
        return { kind: "untrusted", reason: "it does not have the runtime's shape" };
      }
    }
    const runtime = value as ObjectIdentityRuntime;
    if (!behavesAsChemCore(runtime)) return { kind: "untrusted", reason: "it does not behave as chem-core's runtime" };
    return { kind: "adoptable", runtime };
  } catch {
    return { kind: "untrusted", reason: "reading it threw" };
  }
}

let warnedUntrusted = false;

/**
 * The identity runtime of `scope` (a realm's `globalThis`): the one already published there when it is
 * this version's and passes the check, else a new one, published when nothing holds the key yet. A
 * runtime that cannot be shared stays private to the caller. Exported for tests; chem-core resolves
 * `globalThis`'s once, when this module loads.
 */
export function resolveObjectIdentityRuntime(scope: object): ObjectIdentityRuntime {
  const published = adoptablePublishedRuntime(scope);
  if (published.kind === "adoptable") return published.runtime;
  if (published.kind === "untrusted" && !warnedUntrusted) {
    warnedUntrusted = true;
    console.warn(`chem-core: ignoring the object-identity runtime already published on the global (${published.reason}). ` +
      "This chem-core copy keeps object identities to itself, so a selection pinned through another copy will not match " +
      "and its writes are refused.");
  }
  const runtime = createObjectIdentityRuntime();
  if (published.kind === "none") {
    try {
      defineProperty(scope, runtimeKey, fixedProperty(runtime, false));
    } catch {
      // A frozen or locked-down global: this copy keeps its identities to itself.
    }
  }
  return runtime;
}

// Resolved when the module loads, not on first use, so nothing that runs after chem-core loads can
// publish a runtime before it.
const { identityOf: realmIdentityOf, holds: realmHolds, retain: realmRetain } = resolveObjectIdentityRuntime(globalThis);

/** The identity of `object`, minting a fresh one if it has none yet. */
export function objectIdentity(object: DocumentObject): ObjectIdentity {
  return realmIdentityOf(object);
}

/** Whether `object` holds `identity`. Never mints: an object without an identity matches nothing. */
export function hasObjectIdentity(object: DocumentObject, identity: ObjectIdentity): boolean {
  return realmHolds(object, identity);
}

/** Paused while this copy parses the engine's copy of a document (`parseWithoutIdentityTransfers`). */
let identityTransfersPaused = 0;

/**
 * Record that `after` is an edited copy of `before`, the same object: it takes `before`'s identity
 * (minted now if needed, so an undo back to `before` still matches). Only a copy with the same id and
 * type can continue an object, and a value that already has an identity of its own keeps it; either
 * way the call does nothing and `after` stays a different object (fail closed).
 */
export function retainObjectIdentity(before: DocumentObject, after: DocumentObject): void {
  if (identityTransfersPaused) return;
  realmRetain(before, after);
}

/**
 * Run `parse`, which re-parses a copy of a document, with this chem-core copy's identity transfers
 * paused: `retainObjectIdentity` does nothing until it returns. For the engine's copy of a whole
 * document (`cloneDocument`), which then gives each copied object its original's identity with
 * `retainObjectIdentity`. Normalization inside the parse (the repeat-unit warning pass) edits values
 * and would otherwise give the fresh copy an identity of its own before it is matched to its original,
 * and an identity a value holds is never replaced. Not exported from the package.
 */
export function parseWithoutIdentityTransfers<T>(parse: () => T): T {
  identityTransfersPaused += 1;
  try {
    return parse();
  } finally {
    identityTransfersPaused -= 1;
  }
}

/**
 * Give every object of `document` that has no identity yet a fresh one. The engine calls it on each
 * document it adopts (a patch result, `toEngineDocument`, `admitParsedDocument`, an adopted derived
 * document), so every value in an engine-adopted document holds an identity before anything else can
 * reach it, and `retain`, which only fills in a missing identity, can never hand it another object's.
 * This does not cover `adoptDerivedDocument`'s early return, which hands back a `next` that is the
 * `base` itself, is already an engine document, or comes with a `base` that is not an engine document:
 * such a `next` is not adopted and is not pre-identified here. (An engine `base` or `next` was
 * pre-identified when it was adopted. Making the early return mint identities would change what a
 * non-engine document's own objects can retain, so it deliberately does not.)
 * Index loops: nothing here goes through `Array.prototype`. Not exported from the package.
 */
export function holdObjectIdentities(document: { readonly pages: readonly { readonly objects: readonly DocumentObject[] }[] }): void {
  const { pages } = document;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const { objects } = pages[pageIndex]!;
    for (let objectIndex = 0; objectIndex < objects.length; objectIndex += 1) realmIdentityOf(objects[objectIndex]!);
  }
}
