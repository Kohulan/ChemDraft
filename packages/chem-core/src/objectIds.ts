import { isNativeRecord, ownNativeValue } from "./nativeCompatibilityState";

/** The pages and object ids a document holds: a parsed document, or a view over native file data. */
export interface ObjectIdSource {
  readonly pages: readonly { readonly objects: readonly { readonly id: string }[] }[];
}

/**
 * The object-id allocator every document builder uses: `<prefix>_NNN`, counting from the number of
 * distinct ids in the document plus one, and skipping any id already used on any page or `reserved`.
 * Moved here from document-workflow-core (which re-exports it) so the native file reader can use the
 * same allocator when it renumbers duplicate ids on open.
 */
export function nextObjectId(document: ObjectIdSource, prefix: string, reserved?: ReadonlySet<string>): string {
  const existingIds = new Set(document.pages.flatMap((page) => page.objects.map((object) => object.id)));
  let index = existingIds.size + 1;
  let id = objectIdWithIndex(prefix, index);

  // `reserved` covers ids issued but not yet applied — see SmilesMoleculeSource.reservedObjectIds.
  while (existingIds.has(id) || reserved?.has(id)) {
    index += 1;
    id = objectIdWithIndex(prefix, index);
  }

  return id;
}

/** One duplicate object the native reader gave a new id. Indexes are positions in the file. */
export interface RenumberedObjectId {
  pageIndex: number;
  objectIndex: number;
  from: string;
  to: string;
}

/**
 * One repeated atom or bond id inside a molecule that the native reader gave a new id. `objectIndex`
 * and `moleculeId` name the molecule (its id after object renumbering); `itemIndex` is the atom's or
 * bond's position in that molecule's `atoms` or `bonds`.
 */
export interface RenumberedMoleculeItemId {
  kind: "atom" | "bond";
  pageIndex: number;
  objectIndex: number;
  moleculeId: string;
  itemIndex: number;
  from: string;
  to: string;
}

/** Everything one open renumbered: duplicate page objects, then repeated atoms and bonds. */
export type RenumberedId = RenumberedObjectId | RenumberedMoleculeItemId;

function isMoleculeItemRenumbering(entry: RenumberedId): entry is RenumberedMoleculeItemId {
  return "kind" in entry;
}

const objectsOf = (page: unknown): unknown[] => {
  const objects = ownNativeValue(page, "objects");
  return Array.isArray(objects) ? objects : [];
};

const idOf = (record: unknown): string | undefined => {
  const id = ownNativeValue(record, "id");
  return typeof id === "string" && id.length > 0 ? id : undefined;
};

/**
 * Repair repeated ids in decoded native file data (before the schema parse, so bracket normalization
 * and preserved-extension paths see unique ids), in one pass that reports one list:
 *
 * 1. Objects. Every later same-page duplicate of an object id gets a fresh id; the first object with
 *    an id keeps it. Object ids are page-scoped (plugin-host pageObjects.ts): the same id on two
 *    different pages is two legitimate objects and is left alone. New ids follow the
 *    {@link nextObjectId} scheme, prefixed with the duplicated id, counting from the distinct object-id
 *    count and skipping every string anywhere in the file, so they are unique across the whole
 *    document and never capture a dangling reference (one naming an object that does not exist).
 * 2. Atoms and bonds. Inside one molecule, every later atom repeating an atom id, and every later
 *    bond repeating a bond id, gets `<id>_<n>` from a per-id counter starting at 2, skipping every
 *    string anywhere in the file (so it can neither collide with an id nor capture a dangling
 *    reference). The first keeps its id. Atom and bond ids are molecule-scoped: the same id in two
 *    molecules is left alone.
 *
 * References: only references that can be attributed to a renamed copy are updated. For a renamed
 * object those are the copy's own warnings that name its id: `compatibility.warnings`, a mechanism
 * arrow's `warnings`, and its chemical metadata's warnings (a molecule's `chemistry`, `superatoms`
 * and `rGroups`, a superatom's `metadata`, an R-group label's `display`). An atom or bond holds no
 * reference to its own id, so nothing inside a renamed atom or bond changes but `id`. Every other
 * reference to a repeated id — a bond's `fromAtomId`/`toAtomId`, an atom's `labelBondSide`, a
 * superatom's `atomIds`, an anchor, reaction component, group child, bracket member or crossing, a
 * page crossing, the document selection or document-level warnings — cannot tell the copies apart,
 * so it keeps the id and still points at the FIRST copy, which is the one a first-wins lookup
 * (patches) resolved to before. In particular a bond whose endpoint id was repeated stays on the
 * first atom with that id. Only ids change: no element, bond order, charge, isotope, stereo,
 * coordinate or reaction role is touched.
 *
 * Linear in the size of the data: one detection pass with Set lookups, allocators that never probe
 * a candidate twice (see {@link objectIdAllocator} and {@link suffixIdAllocator}), and results
 * appended in place.
 */
export function renumberDuplicatePageObjectIds(root: unknown): RenumberedId[] {
  const pages = ownNativeValue(root, "pages");
  if (!Array.isArray(pages)) return [];
  const renumbered: RenumberedId[] = [];
  renumberPageObjects(root, pages, renumbered);
  renumberMoleculeItems(root, pages, renumbered);
  return renumbered;
}

function renumberPageObjects(root: unknown, pages: readonly unknown[], renumbered: RenumberedId[]): void {
  // Every object id on every page, which is what nextObjectId counts (to pick its starting index).
  const objectIds = new Set<string>();
  let repeated = false;
  for (const page of pages) {
    const seen = new Set<string>();
    for (const object of objectsOf(page)) {
      const id = idOf(object);
      if (id === undefined) continue;
      if (seen.has(id)) repeated = true;
      else seen.add(id);
      objectIds.add(id);
    }
  }
  if (!repeated) return;

  // Skip every string in the file, not just object ids: a new id equal to a dangling reference (a
  // reaction component, group child, anchor, bracket member, selection entry... naming an object that
  // does not exist) would silently make the renamed copy that reference's target. Object ids are
  // strings in the file, so this also covers what nextObjectId skips. Counting is unchanged.
  const allocate = objectIdAllocator(objectIds.size, fileStrings(root));
  pages.forEach((page, pageIndex) => {
    const seen = new Set<string>();
    objectsOf(page).forEach((object, objectIndex) => {
      const from = idOf(object);
      if (from === undefined || !isNativeRecord(object)) return;
      if (!seen.has(from)) {
        seen.add(from);
        return;
      }
      const to = allocate(from);
      object.id = to;
      seen.add(to);
      renameOwnWarnings(object, from, to);
      renumbered.push({ pageIndex, objectIndex, from, to });
    });
  });
}

function renumberMoleculeItems(root: unknown, pages: readonly unknown[], renumbered: RenumberedId[]): void {
  // Detection first, so a file with no repeats is only read, never walked for its strings.
  const lists: { pageIndex: number; objectIndex: number; molecule: Record<string, unknown>; kind: "atom" | "bond"; items: unknown[] }[] = [];
  pages.forEach((page, pageIndex) => {
    objectsOf(page).forEach((molecule, objectIndex) => {
      if (!isNativeRecord(molecule) || ownNativeValue(molecule, "type") !== "molecule") return;
      for (const kind of ["atom", "bond"] as const) {
        const items = ownNativeValue(molecule, kind === "atom" ? "atoms" : "bonds");
        if (Array.isArray(items) && repeatsAnId(items)) lists.push({ pageIndex, objectIndex, molecule, kind, items });
      }
    });
  });
  if (!lists.length) return;

  // After object renumbering, so these ids also avoid the object ids just issued.
  const allocate = suffixIdAllocator(fileStrings(root));
  for (const { pageIndex, objectIndex, molecule, kind, items } of lists) {
    const moleculeId = idOf(molecule) ?? "";
    const seen = new Set<string>();
    items.forEach((item, itemIndex) => {
      const from = idOf(item);
      if (from === undefined || !isNativeRecord(item)) return;
      if (!seen.has(from)) {
        seen.add(from);
        return;
      }
      const to = allocate(from);
      item.id = to;
      seen.add(to);
      renumbered.push({ kind, pageIndex, objectIndex, moleculeId, itemIndex, from, to });
    });
  }
}

function repeatsAnId(items: readonly unknown[]): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    const id = idOf(item);
    if (id === undefined) continue;
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}

/** Every string value in the decoded file (ids, references, text alike), without recursion. */
function fileStrings(root: unknown): Set<string> {
  const strings = new Set<string>();
  const pending: unknown[] = [root];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") strings.add(value);
    else if (Array.isArray(value)) for (const item of value) pending.push(item);
    else if (isNativeRecord(value)) for (const item of Object.values(value)) pending.push(item);
  }
  return strings;
}

function objectIdWithIndex(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(3, "0")}`;
}

/**
 * {@link nextObjectId} for a run of renumberings over one document, without rebuilding its id set per
 * call. `distinct` is the number of distinct object ids in the document; `taken` holds every object id
 * plus every other string to avoid (passed to nextObjectId as `reserved`) and is extended with each id
 * issued.
 *
 * Same results as calling nextObjectId(live document, prefix, reserved) each time: the k-th call
 * (1-based) starts at `distinct + k` (the distinct count has grown by one per issued id) and skips
 * taken ids. When this prefix was last issued at index `r` by call k' < k, every index in
 * [distinct + k', r] was taken then and still is, and distinct + k > distinct + k', so starting at
 * max(distinct + k, r + 1) skips only taken ids.
 * Each probe that fails moves the prefix's counter past an id that is taken, and a string is
 * `<prefix>_<padded index>` for at most one (prefix, index), so failed probes total at most |taken|.
 */
function objectIdAllocator(distinct: number, taken: Set<string>): (prefix: string) => string {
  let issued = 0;
  const lastIndex = new Map<string, number>();
  return (prefix) => {
    issued += 1;
    let index = Math.max(distinct + issued, (lastIndex.get(prefix) ?? 0) + 1);
    let id = objectIdWithIndex(prefix, index);
    while (taken.has(id)) id = objectIdWithIndex(prefix, ++index);
    lastIndex.set(prefix, index);
    taken.add(id);
    return id;
  };
}

/**
 * `<base>_<n>` with a per-base counter from 2 that only moves forward, skipping every string in
 * `taken` (which grows with each issued id). A string is `<base>_<n>` for at most one (base, n), so
 * across all calls the failed probes total at most |taken|: many repeats of one id never rescan the
 * suffixes already found occupied.
 */
function suffixIdAllocator(taken: Set<string>): (base: string) => string {
  const nextSuffix = new Map<string, number>();
  return (base) => {
    let suffix = nextSuffix.get(base) ?? 2;
    let id = `${base}_${suffix}`;
    while (taken.has(id)) id = `${base}_${++suffix}`;
    nextSuffix.set(base, suffix + 1);
    taken.add(id);
    return id;
  };
}

/** Rename `from` to `to` in every warning list a renamed copy owns (see renumberDuplicatePageObjectIds). */
function renameOwnWarnings(object: Record<string, unknown>, from: string, to: string): void {
  const inRecord = (record: unknown) => renameWarningList(ownNativeValue(record, "warnings"), from, to);
  const inEach = (records: unknown) => { if (Array.isArray(records)) records.forEach(inRecord); };
  inRecord(ownNativeValue(object, "compatibility"));
  switch (ownNativeValue(object, "type")) {
    case "mechanism-arrow": inRecord(object); break;
    case "molecule":
      inRecord(ownNativeValue(object, "chemistry"));
      inEach(ownNativeValue(object, "superatoms"));
      inEach(ownNativeValue(object, "rGroups"));
      break;
    case "superatom": inRecord(ownNativeValue(object, "metadata")); break;
    case "r-group-label": inRecord(ownNativeValue(object, "display")); break;
  }
}

function renameWarningList(warnings: unknown, from: string, to: string): void {
  if (!Array.isArray(warnings)) return;
  for (const warning of warnings) {
    if (isNativeRecord(warning) && ownNativeValue(warning, "objectId") === from) warning.objectId = to;
  }
}

/** The open warning for {@link renumberDuplicatePageObjectIds}, one sentence for the whole file. */
export function duplicateObjectIdsMessage(renumbered: readonly RenumberedId[]): string {
  // Per page and kind: how many were renamed, and which shared ids (per molecule for atoms and bonds).
  type Tally = { renamed: number; ids: Set<string>; molecules: Set<number> };
  const kinds = ["object", "atom", "bond"] as const;
  const byPage = new Map<number, Map<(typeof kinds)[number], Tally>>();
  for (const entry of renumbered) {
    const kind = isMoleculeItemRenumbering(entry) ? entry.kind : "object";
    const tallies = byPage.get(entry.pageIndex) ?? new Map<(typeof kinds)[number], Tally>();
    byPage.set(entry.pageIndex, tallies);
    const tally = tallies.get(kind) ?? { renamed: 0, ids: new Set<string>(), molecules: new Set<number>() };
    tallies.set(kind, tally);
    tally.renamed += 1;
    tally.ids.add(kind === "object" ? entry.from : `${entry.objectIndex}\u0000${entry.from}`);
    tally.molecules.add(entry.objectIndex);
  }
  const parts: string[] = [];
  for (const [pageIndex, tallies] of [...byPage].sort(([left], [right]) => left - right)) {
    for (const kind of kinds) {
      const tally = tallies.get(kind);
      if (!tally) continue;
      // Everything sharing an id: every renamed copy, plus the first of each shared id, which kept it.
      const count = tally.renamed + tally.ids.size;
      const shared = tally.ids.size === 1 ? "an id" : "ids";
      const within = kind === "object" ? ""
        : tally.molecules.size === 1 ? " within a molecule" : ` within ${tally.molecules.size} molecules`;
      parts.push(`${count} ${kind}s sharing ${shared}${within} on page ${pageIndex + 1}`);
    }
  }
  const listed = parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  const bonds = renumbered.some((entry) => isMoleculeItemRenumbering(entry) && entry.kind === "atom")
    ? " Bonds to a shared atom id stay on the first atom with it." : "";
  return `This file had ${listed}; ChemDraft gave the duplicates new ids.${bonds} Save to keep the fix.`;
}

/** One log line entry per renumbering, for the open's console log. */
export function describeRenumberedId(entry: RenumberedId): string {
  const where = `page ${entry.pageIndex + 1} object ${entry.objectIndex}`;
  return isMoleculeItemRenumbering(entry)
    ? `${where} ${entry.kind} ${entry.itemIndex}: ${entry.from} -> ${entry.to}`
    : `${where}: ${entry.from} -> ${entry.to}`;
}
