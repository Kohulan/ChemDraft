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
 * - Every object value has one identity, minted the first time it is asked for.
 * - An edit that replaces an object value with an edited copy of the same object carries the
 *   identity to the copy (`retainObjectIdentity`): a patch update or move, a normalization pass
 *   re-admitted through `adoptDerivedDocument`, the engine's copy of a whole document. A move to
 *   another page keeps the value itself; undo and redo reinstate earlier values, which still hold
 *   theirs.
 * - An insertion (`addObject`: paste, duplicate, template, plugin insert) parses a new value, and so
 *   gets a fresh identity even when it reuses an id.
 * - Any other new value, including one made by a path that forgot to carry the identity, also gets a
 *   fresh one. A missed carry therefore fails closed: a pin stops resolving and its write is refused.
 *   It can never make a different object match.
 */
declare const objectIdentityBrand: unique symbol;
export type ObjectIdentity = symbol & { readonly [objectIdentityBrand]: true };

/**
 * One identity runtime per JavaScript realm, shared by every chem-core copy loaded in it.
 *
 * A host can hold more than one chem-core: the published plugin-host SDK bundles its own, and an
 * embedder applies writes through another (its own `@chemdraft/chem-core`, or a writer built on it). A
 * module-private map would split identity between them: the embedder's edit would carry the identity in
 * its copy only, and the SDK's next pin check would find nothing (fail closed, but a legitimate second
 * write to the same selected object refused). So the first copy to need identity publishes its runtime
 * on `globalThis` under a registered symbol, and every later copy uses that one.
 *
 * - The runtime is a frozen set of the same four operations this module exports; it never exposes its
 *   map, so a holder can do nothing a chem-core import cannot already do. The global property is
 *   non-enumerable, non-writable and non-configurable: once published it cannot be replaced.
 * - `version` names the semantics below. A copy that finds a runtime of another version, or cannot
 *   publish one (a frozen global), keeps a private runtime: identity is then not shared, and a pin made
 *   in one copy matches nothing edited in the other (fail closed, never a wrong match).
 * - Plugins never receive it. In the app they run in per-plugin Workers, another realm with its own
 *   global; and the host gives any plugin only deep-frozen structured clones (which hold no identity),
 *   while everything a plugin writes is parsed into a new value. Bump the version on any change to what
 *   an identity means or how it is carried.
 */
export const OBJECT_IDENTITY_RUNTIME_VERSION = 1;
const runtimeKey = Symbol.for("chemdraft.chem-core.objectIdentity");

interface ObjectIdentityRuntime {
  readonly version: typeof OBJECT_IDENTITY_RUNTIME_VERSION;
  identityOf(object: DocumentObject): ObjectIdentity;
  holds(object: DocumentObject, identity: ObjectIdentity): boolean;
  retain(before: DocumentObject, after: DocumentObject): void;
  carry(original: DocumentObject, copy: DocumentObject): void;
}

function createObjectIdentityRuntime(): ObjectIdentityRuntime {
  const identities = new WeakMap<DocumentObject, ObjectIdentity>();
  const identityOf = (object: DocumentObject): ObjectIdentity => {
    let identity = identities.get(object);
    if (!identity) {
      identity = Symbol("chemdraft.object") as ObjectIdentity;
      identities.set(object, identity);
    }
    return identity;
  };
  return Object.freeze({
    version: OBJECT_IDENTITY_RUNTIME_VERSION,
    identityOf,
    holds: (object: DocumentObject, identity: ObjectIdentity) => identities.get(object) === identity,
    retain: (before: DocumentObject, after: DocumentObject) => {
      if (before === after || before.id !== after.id || before.type !== after.type) return;
      const identity = identityOf(before);
      if (!identities.has(after)) identities.set(after, identity);
    },
    carry: (original: DocumentObject, copy: DocumentObject) => {
      if (original === copy || original.id !== copy.id || original.type !== copy.type) return;
      identities.set(copy, identityOf(original));
    }
  });
}

function isObjectIdentityRuntime(value: unknown): value is ObjectIdentityRuntime {
  if (typeof value !== "object" || value === null || !Object.isFrozen(value)) return false;
  const runtime = value as Partial<Record<keyof ObjectIdentityRuntime, unknown>>;
  return runtime.version === OBJECT_IDENTITY_RUNTIME_VERSION && typeof runtime.identityOf === "function" &&
    typeof runtime.holds === "function" && typeof runtime.retain === "function" && typeof runtime.carry === "function";
}

/**
 * The identity runtime of `scope` (a realm's `globalThis`): the one already published there when it is
 * this version's, else a new one, published when nothing holds the key yet. A runtime that cannot be
 * shared stays private to the caller. Exported for tests; chem-core resolves it once, on first use.
 */
export function resolveObjectIdentityRuntime(scope: object): ObjectIdentityRuntime {
  const published = (scope as Record<symbol, unknown>)[runtimeKey];
  if (isObjectIdentityRuntime(published)) return published;
  const runtime = createObjectIdentityRuntime();
  if (published === undefined) {
    try {
      Object.defineProperty(scope, runtimeKey, { value: runtime, enumerable: false, writable: false, configurable: false });
    } catch {
      // A frozen or locked-down global: this copy keeps its identities to itself.
    }
  }
  return runtime;
}

let realmRuntime: ObjectIdentityRuntime | undefined;
const identityRuntime = () => realmRuntime ??= resolveObjectIdentityRuntime(globalThis);

/** The identity of `object`, minting a fresh one if it has none yet. */
export function objectIdentity(object: DocumentObject): ObjectIdentity {
  return identityRuntime().identityOf(object);
}

/** Whether `object` holds `identity`. Never mints: an object without an identity matches nothing. */
export function hasObjectIdentity(object: DocumentObject, identity: ObjectIdentity): boolean {
  return identityRuntime().holds(object, identity);
}

/**
 * Record that `after` is an edited copy of `before`, the same object: it takes `before`'s identity
 * (minted now if needed, so an undo back to `before` still matches). Only a copy with the same id and
 * type can continue an object, and a value that already has an identity of its own keeps it; either
 * way the call does nothing and `after` stays a different object (fail closed).
 */
export function retainObjectIdentity(before: DocumentObject, after: DocumentObject): void {
  identityRuntime().retain(before, after);
}

/**
 * Record that `copy` is `original` itself, re-parsed: the engine's copy of a whole document
 * (`cloneDocument`). Unlike `retainObjectIdentity`, this replaces an identity the copy was given while
 * it was being parsed: normalization inside the parse (the repeat-unit warning pass) can ask for the
 * fresh value's identity before the copy is matched to its original, and that minted identity belongs
 * to nothing else. Only a same-id, same-type value is a copy.
 */
export function carryObjectIdentityToCopy(original: DocumentObject, copy: DocumentObject): void {
  identityRuntime().carry(original, copy);
}
