import type { DocumentObject } from "./schemas";

/**
 * Host-owned object identity (ChemDraft 1.2.3).
 *
 * An object id is document data: unique within a page, free again once its object is deleted, and
 * reused by a paste, an undo, or a plugin insert. So an id cannot tell "the object the user selected"
 * from "a different object that now has its id". This identity can. It lives only in memory, keyed
 * by the object value itself, like the bracket creation identity in brackets.ts: it is never part of
 * the schema, never serialized (JSON and structured clone both drop it), and never reachable from a
 * plugin, which imports only `@chemdraft/plugin-api`.
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

const identities = new WeakMap<DocumentObject, ObjectIdentity>();

/** The identity of `object`, minting a fresh one if it has none yet. */
export function objectIdentity(object: DocumentObject): ObjectIdentity {
  let identity = identities.get(object);
  if (!identity) {
    identity = Symbol("chemdraft.object") as ObjectIdentity;
    identities.set(object, identity);
  }
  return identity;
}

/** Whether `object` holds `identity`. Never mints: an object without an identity matches nothing. */
export function hasObjectIdentity(object: DocumentObject, identity: ObjectIdentity): boolean {
  return identities.get(object) === identity;
}

/**
 * Record that `after` is an edited copy of `before`, the same object: it takes `before`'s identity
 * (minted now if needed, so an undo back to `before` still matches). Only a copy with the same id and
 * type can continue an object, and a value that already has an identity of its own keeps it; either
 * way the call does nothing and `after` stays a different object (fail closed).
 */
export function retainObjectIdentity(before: DocumentObject, after: DocumentObject): void {
  if (before === after || before.id !== after.id || before.type !== after.type) return;
  const identity = objectIdentity(before);
  if (!identities.has(after)) identities.set(after, identity);
}

/**
 * Record that `copy` is `original` itself, re-parsed: the engine's copy of a whole document
 * (`cloneDocument`). Unlike `retainObjectIdentity`, this replaces an identity the copy was given while
 * it was being parsed: normalization inside the parse (the repeat-unit warning pass) can ask for the
 * fresh value's identity before the copy is matched to its original, and that minted identity belongs
 * to nothing else. Only a same-id, same-type value is a copy.
 */
export function carryObjectIdentityToCopy(original: DocumentObject, copy: DocumentObject): void {
  if (original === copy || original.id !== copy.id || original.type !== copy.type) return;
  identities.set(copy, objectIdentity(original));
}
