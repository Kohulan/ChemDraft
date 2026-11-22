import { hasObjectIdentity, objectIdentity, type DocumentObject, type DocumentPage, type ObjectIdentity } from "@chemdraft/chem-core";
import type { ChemDraftDocument } from "@chemdraft/plugin-api";

/**
 * Page-aware object resolution for every legacy and plugin write path (AGENTS.md section 7).
 *
 * Object ids are unique within a page but NOT across pages: an imported or pasted document can hold
 * a molecule "X" on page A and a different object "X" on page B. A lookup by bare id silently picks
 * the first occurrence in page order, so it can read, anchor beside, or change the wrong object.
 * Write code resolves objects only through these helpers, with the Send-time selection's pins: a pin
 * names the selected object itself by its host-owned identity, not by id or page.
 */

/**
 * A Send-time pin: the page the selection named the object on, and the object's host-owned identity
 * (chem-core objectIdentity.ts). The identity lives in host memory only: it is never stored in the
 * document and never given to a plugin. It follows the object through edits, restyling, moves
 * (including to another page) and undo/redo; a paste, duplicate, or insert that reuses the id is a
 * different object with a fresh identity.
 */
export interface PagePin {
  readonly pageId: string;
  readonly identity: ObjectIdentity;
}

/** Host-only legacy scope: selected object id -> its Send-time pin. A pin resolves to the object that
 * holds its identity, wherever that object now is, and to nothing else (see {@link resolvePinnedObject}). */
export type PluginWriteScopePages = ReadonlyMap<string, PagePin>;

/** Each pinned id's page in one document ({@link resolvePinnedPages}): the page now holding the pinned
 * object, or null when it is gone, or when no page-level check could single it out. A write-scope check
 * resolves its pins once, against the document the write starts from, and passes this to
 * {@link objectInWriteScope}. */
export type PinnedObjectPages = ReadonlyMap<string, string | null>;

/** Each pinned id's object in one document ({@link resolvePinnedObjects}): the one object value holding
 * the pin's identity, or null when it is gone or (failing closed) found more than once. */
export type PinnedObjects = ReadonlyMap<string, DocumentObject | null>;

export interface PageObjectLocation<Object extends DocumentObject = DocumentObject> {
  page: DocumentPage;
  object: Object;
}

/** A selected or anchoring object named by page and id. */
export interface PageObjectRef { pageId: string; objectId: string }

/** Every occurrence of `objectId`, in page order. */
export function objectLocations(document: ChemDraftDocument, objectId: string): PageObjectLocation[] {
  const found: PageObjectLocation[] = [];
  for (const page of document.pages) {
    const object = page.objects.find(candidate => candidate.id === objectId);
    if (object) found.push({ page, object });
  }
  return found;
}

/** A page as the user sees it: its 1-based position in the document. Pages carry no display name. */
export function pageNumberLabel(document: ChemDraftDocument, pageId: string): string {
  const index = document.pages.findIndex(page => page.id === pageId);
  return index < 0 ? "another page" : `page ${index + 1}`;
}

function joinLabels(labels: string[]): string {
  return labels.length < 3 ? labels.join(" and ") : `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

/**
 * The user-facing refusal for a write whose selected object shares its id with an object on another page.
 * Pages are named by number; the internal ids go to console.warn only. `others` are the page ids holding
 * the same-id objects the write would have reached. `selectedPageId` is where the selection named the object.
 */
export function duplicateIdRefusalMessage(document: ChemDraftDocument, objectId: string, selectedPageId: string,
  others: readonly string[]): string {
  console.warn(`Plugin write refused: object "${objectId}" selected on page id "${selectedPageId}"; same id on page ids ${others.map(id => `"${id}"`).join(", ")}.`);
  const where = joinLabels(others.map(id => pageNumberLabel(document, id)));
  return `Plugin write refused: the change was not applied. The object you selected on ${pageNumberLabel(document, selectedPageId)} shares its internal ID with an object on ${where}, so ChemDraft can't tell which one to change safely. To edit it, make the change by hand, or copy the object and paste it as a new object, then try again.`;
}

/** The user-facing reason a pin no longer resolves: the selected object is gone (deleted, or replaced by a
 * different object that reuses its id). `selectedPageId` is the page it was selected on at Send. Reads
 * and writes both refuse with it. */
export function pinnedObjectMissingMessage(document: ChemDraftDocument, selectedPageId: string): string {
  return `The object you selected on ${pageNumberLabel(document, selectedPageId)} is no longer there; reselect it and try again.`;
}

/** The object named `objectId` on page `pageId`, or undefined. */
export function resolveObjectOnPage(document: ChemDraftDocument, pageId: string, objectId: string): PageObjectLocation | undefined {
  const page = document.pages.find(candidate => candidate.id === pageId);
  const object = page?.objects.find(candidate => candidate.id === objectId);
  return page && object ? { page, object } : undefined;
}

/** The page a chem-core patch op that names `objectId` will act on: chem-core resolves a bare id to
 * its FIRST occurrence in page order. Compare it with {@link scopedObjectPage} before writing. */
export function bareIdTargetPage(document: ChemDraftDocument, objectId: string): string | undefined {
  return document.pages.find(page => page.objects.some(object => object.id === objectId))?.id;
}

/** Pin `object`, found on `page`, by its host-owned identity. */
export function pinObject(page: DocumentPage, object: DocumentObject): PagePin {
  return { pageId: page.id, identity: objectIdentity(object) };
}

/** A pin no object can hold: for a selected id with no object to pin, so that nothing is in scope under it. */
function unmatchedPin(pageId: string): PagePin {
  return { pageId, identity: Symbol("chemdraft.unmatched-pin") as ObjectIdentity };
}

/**
 * The pinned object itself: the one object named `objectId` that holds the pin's identity, on any page.
 * A genuine move to another page keeps it. Undefined when it is gone: deleted, or replaced by a
 * different object that reuses the id on any page (a paste, duplicate, undo, or plugin insert), which
 * never matches. Also undefined, failing closed, if the identity were ever found more than once.
 */
export function resolvePinnedObject(document: ChemDraftDocument, objectId: string, pin: PagePin): PageObjectLocation | undefined {
  let found: PageObjectLocation | undefined;
  for (const page of document.pages) {
    for (const object of page.objects) {
      if (object.id !== objectId || !hasObjectIdentity(object, pin.identity)) continue;
      if (found) return undefined;
      found = { page, object };
    }
  }
  return found;
}

/** Resolve every pin's object in one pass over `document` (see {@link resolvePinnedObject}). Undefined
 * only when there are no pins at all (`scopePages` undefined): a caller that passes pins, even none,
 * gets pinned scope, in which an id without a pin grants nothing. */
export function resolvePinnedObjects(document: ChemDraftDocument, scopePages: PluginWriteScopePages | undefined): PinnedObjects | undefined {
  if (!scopePages) return undefined;
  const objects = new Map<string, DocumentObject | null>();
  const found = new Set<string>();
  for (const objectId of scopePages.keys()) objects.set(objectId, null);
  for (const page of document.pages) {
    for (const object of page.objects) {
      const pin = scopePages.get(object.id);
      if (!pin || !hasObjectIdentity(object, pin.identity)) continue;
      objects.set(object.id, found.has(object.id) ? null : object);
      found.add(object.id);
    }
  }
  return objects;
}

/**
 * Resolve every pin's page in one pass over `document` (see {@link resolvePinnedObject}), for checks that
 * can only name an object by page and id, such as crossings. A pinned object whose page also holds
 * another object with its id gets null too: by page and id the two cannot be told apart, so neither is
 * in scope there. Undefined only without pins, as in {@link resolvePinnedObjects}.
 */
export function resolvePinnedPages(document: ChemDraftDocument, scopePages: PluginWriteScopePages | undefined): PinnedObjectPages | undefined {
  const objects = resolvePinnedObjects(document, scopePages);
  if (!objects) return undefined;
  const pages = new Map<string, string | null>();
  for (const objectId of objects.keys()) pages.set(objectId, null);
  for (const page of document.pages) {
    const counts = new Map<string, number>();
    for (const object of page.objects) if (objects.has(object.id)) counts.set(object.id, (counts.get(object.id) ?? 0) + 1);
    for (const object of page.objects) {
      if (objects.get(object.id) === object && counts.get(object.id) === 1) pages.set(object.id, page.id);
    }
  }
  return pages;
}

/**
 * The page `objectId` resolves to in `document`:
 * - a pinned id: the page holding the pinned object ({@link resolvePinnedObject}), even when the id also
 *   exists elsewhere; nothing once it is gone. A same-id object that does not hold the pin's identity,
 *   on any page including its own, may be an unrelated object inserted after Send, so it is never in scope;
 * - an unpinned id: its only page;
 * - undefined when the id is gone, or unpinned and on several pages.
 */
export function scopedObjectPage(document: ChemDraftDocument, objectId: string,
  scopePages?: PluginWriteScopePages): string | undefined {
  const pin = scopePages?.get(objectId);
  if (pin !== undefined) return resolvePinnedObject(document, objectId, pin)?.page.id;
  const locations = objectLocations(document, objectId);
  return locations.length === 1 ? locations[0]!.page.id : undefined;
}

function pageList(locations: readonly PageObjectLocation[]): string {
  return locations.map(location => `"${location.page.id}"`).join(", ");
}

/** Resolve a write-scoped or anchoring id by {@link scopedObjectPage}, or throw a specific error. */
export function resolveScopedObject(document: ChemDraftDocument, objectId: string,
  scopePages?: PluginWriteScopePages, where = "the document"): PageObjectLocation {
  const pin = scopePages?.get(objectId);
  if (pin !== undefined) {
    const pinned = resolvePinnedObject(document, objectId, pin);
    if (pinned) return pinned;
    throw new Error(pinnedObjectMissingMessage(document, pin.pageId));
  }
  const locations = objectLocations(document, objectId);
  if (locations.length === 1) return locations[0]!;
  if (!locations.length) throw new Error(`Object "${objectId}" does not exist in ${where}.`);
  throw new Error(`Object id "${objectId}" names objects on pages ${pageList(locations)}; select the one you mean and retry.`);
}

/** True when the object `objectId` on page `pageId` is in write scope, for checks that can only name an
 * object by page and id (crossings, page-keyed comparisons). With pins (`pinned`, resolved by
 * {@link resolvePinnedPages} against the document being written), a granted id only on the page holding
 * its pinned object, alone under that id there; nowhere once it is gone, and nowhere for an id without a
 * pin. Without pins (`pinned` undefined: request-bound callers that resolved identity themselves, and
 * table builders) a granted id keeps bare-id scope. Prefer {@link objectIsInWriteScope} wherever the
 * object itself is at hand. */
export function objectInWriteScope(scope: ReadonlySet<string>, pinned: PinnedObjectPages | undefined,
  pageId: string, objectId: string): boolean {
  if (!scope.has(objectId)) return false;
  return !pinned || pinned.get(objectId) === pageId;
}

/** True when `object` itself is in write scope: with pins (`pinned`, resolved by
 * {@link resolvePinnedObjects} against the same document as `object`), only the one object holding its
 * id's pin, by identity: never another object with the id, on any page including its own, and never an
 * id without a pin. Without pins, as {@link objectInWriteScope}. */
export function objectIsInWriteScope(scope: ReadonlySet<string>, pinned: PinnedObjects | undefined, object: DocumentObject): boolean {
  if (!scope.has(object.id)) return false;
  return !pinned || pinned.get(object.id) === object;
}

/**
 * Pin selected ids at Send, each to the object it names and that object's host identity. Ids on
 * `pageId` pin the object there. Ids elsewhere pin their only occurrence; an id found on several other
 * pages cannot be pinned and is returned in `ambiguous` (or, when `pageId` is a page, given a pin no
 * object holds, so that nothing is in scope under it). So is an id that names no object at all: a
 * later object reusing it is never the one selected.
 */
export function pinSelectionPages(document: ChemDraftDocument | undefined, objectIds: readonly string[],
  pageId: string | undefined): { pages: Map<string, PagePin>; ambiguous: string[] } {
  const pages = new Map<string, PagePin>();
  const ambiguous: string[] = [];
  if (!document) return { pages, ambiguous };
  const knownPage = pageId !== undefined && document.pages.some(page => page.id === pageId) ? pageId : undefined;
  for (const objectId of new Set(objectIds)) {
    const onPage = knownPage === undefined ? undefined : resolveObjectOnPage(document, knownPage, objectId);
    if (onPage) {
      pages.set(objectId, pinObject(onPage.page, onPage.object));
      continue;
    }
    const locations = objectLocations(document, objectId);
    if (locations.length === 1) pages.set(objectId, pinObject(locations[0]!.page, locations[0]!.object));
    else if (knownPage !== undefined) pages.set(objectId, unmatchedPin(knownPage));
    else if (locations.length > 1) ambiguous.push(objectId);
    else if (document.pages[0]) pages.set(objectId, unmatchedPin(document.pages[0].id));
  }
  return { pages, ambiguous };
}

/**
 * `pins` without the pins of `insertedIds`: ids the command or request has since inserted objects under.
 * An insertion needs its id to be free, so the pinned object was already gone; the id now names the
 * insertion, which is in scope only through its own insertion pin ({@link insertionPins}).
 */
export function withoutPins(pins: PluginWriteScopePages | undefined, insertedIds: Iterable<string>): PluginWriteScopePages | undefined {
  if (!pins?.size) return pins;
  const dropped = [...insertedIds].filter(id => pins.has(id));
  if (!dropped.length) return pins;
  return new Map([...pins].filter(([id]) => !dropped.includes(id)));
}

/**
 * Pins for the objects a write inserted, read from `committed`, the document that write committed. The
 * write's insertion under an id is the one object named by it there that is new to the write: a value
 * whose identity no object of `before` (the document the write was checked against) held. An insertion
 * parses a new value, so it is new even under an id the same write freed (a batch that deletes the
 * selected X and inserts its replacement X); an object the write only edited carries its identity and is
 * never taken for one. Each id pins that object by its own identity, so the insertion is in scope exactly
 * as a selected object is, and a later object reusing the id (the user deletes the insertion and pastes a
 * copy back, an undo, another plugin's insert) is not. An id naming no new object, or several, gets no
 * pin, so nothing is in scope under it (fail closed). Never a grant by bare id.
 */
export function insertionPins(before: ChemDraftDocument, committed: ChemDraftDocument | undefined,
  insertedIds: Iterable<string>): Map<string, PagePin> {
  const pins = new Map<string, PagePin>();
  const wanted = new Set(insertedIds);
  if (!committed || !wanted.size) return pins;
  const existing = new Set<ObjectIdentity>();
  for (const page of before.pages) for (const object of page.objects) existing.add(objectIdentity(object));
  const found = new Map<string, PageObjectLocation | null>();
  for (const page of committed.pages) {
    for (const object of page.objects) {
      if (!wanted.has(object.id) || existing.has(objectIdentity(object))) continue;
      found.set(object.id, found.has(object.id) ? null : { page, object });
    }
  }
  for (const [objectId, location] of found) if (location) pins.set(objectId, pinObject(location.page, location.object));
  return pins;
}

/** `pins` with `added` laid over it: an id re-inserted under a pin now pins the insertion instead. */
export function withPins(pins: PluginWriteScopePages | undefined, added: ReadonlyMap<string, PagePin>): Map<string, PagePin> {
  return new Map([...(pins ?? []), ...added]);
}

/** Each scoped id as a page reference, for placement beside the selection. Unresolvable ids are omitted. */
export function scopedObjectRefs(document: ChemDraftDocument, objectIds: Iterable<string>,
  scopePages?: PluginWriteScopePages): PageObjectRef[] {
  const refs: PageObjectRef[] = [];
  const pinned = resolvePinnedPages(document, scopePages);
  for (const objectId of new Set(objectIds)) {
    const pageId = pinned?.has(objectId) ? pinned.get(objectId) ?? undefined : scopedObjectPage(document, objectId);
    if (pageId !== undefined) refs.push({ pageId, objectId });
  }
  return refs;
}
