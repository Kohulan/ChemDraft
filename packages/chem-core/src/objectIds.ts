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
  let id = `${prefix}_${String(index).padStart(3, "0")}`;

  // `reserved` covers ids issued but not yet applied — see SmilesMoleculeSource.reservedObjectIds.
  while (existingIds.has(id) || reserved?.has(id)) {
    index += 1;
    id = `${prefix}_${String(index).padStart(3, "0")}`;
  }

  return id;
}

/** One duplicate the native reader gave a new id. Indexes are positions in the file. */
export interface RenumberedObjectId {
  pageIndex: number;
  objectIndex: number;
  from: string;
  to: string;
}

/**
 * Give every later same-page duplicate of an object id a fresh id, in decoded native file data
 * (before the schema parse, so bracket normalization and preserved-extension paths see unique ids).
 * The first object with an id keeps it.
 *
 * Object ids are page-scoped (plugin-host pageObjects.ts): the same id on two different pages is two
 * legitimate objects and is left alone. New ids come from {@link nextObjectId}, prefixed with the
 * duplicated id, so they are unique across the whole document.
 *
 * References: only references that can be attributed to the renamed copy are updated, and those are
 * the copy's own warnings that name its id: `compatibility.warnings`, a mechanism arrow's `warnings`,
 * and its chemical metadata's warnings (a molecule's `chemistry`, `superatoms` and `rGroups`, a
 * superatom's `metadata`, an R-group label's `display`). Every other reference to the duplicated id
 * — another object's anchor, reaction component, group child, bracket member, a page crossing, the
 * document selection or document-level warnings — cannot tell the copies apart, so it keeps the id and
 * still points at the FIRST copy, which is the object a bare-id lookup resolved to before renumbering.
 * Only ids change: no atom, bond, charge, stereo, coordinate or reaction role is touched.
 */
export function renumberDuplicatePageObjectIds(root: unknown): RenumberedObjectId[] {
  const pages = ownNativeValue(root, "pages");
  if (!Array.isArray(pages)) return [];
  const objectsOf = (page: unknown): unknown[] => {
    const objects = ownNativeValue(page, "objects");
    return Array.isArray(objects) ? objects : [];
  };
  const idOf = (object: unknown): string | undefined => {
    const id = ownNativeValue(object, "id");
    return typeof id === "string" && id.length > 0 ? id : undefined;
  };
  // A live view the allocator reads, so each new id is also unique against the ones issued before it.
  const view = pages.map((page) => ({ objects: objectsOf(page).flatMap((object) => {
    const id = idOf(object);
    return id === undefined ? [] : [{ id }];
  }) }));
  const renumbered: RenumberedObjectId[] = [];
  pages.forEach((page, pageIndex) => {
    const seen = new Set<string>();
    let viewIndex = 0;
    objectsOf(page).forEach((object, objectIndex) => {
      const from = idOf(object);
      if (from === undefined || !isNativeRecord(object)) return;
      const entry = view[pageIndex]!.objects[viewIndex++]!;
      if (!seen.has(from)) {
        seen.add(from);
        return;
      }
      const to = nextObjectId({ pages: view }, from);
      object.id = to;
      entry.id = to;
      seen.add(to);
      renameOwnWarnings(object, from, to);
      renumbered.push({ pageIndex, objectIndex, from, to });
    });
  });
  return renumbered;
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
export function duplicateObjectIdsMessage(renumbered: readonly RenumberedObjectId[]): string {
  const byPage = new Map<number, Set<string>>();
  for (const { pageIndex, from } of renumbered) {
    const ids = byPage.get(pageIndex) ?? new Set<string>();
    ids.add(from);
    byPage.set(pageIndex, ids);
  }
  const parts = [...byPage].sort(([left], [right]) => left - right).map(([pageIndex, ids]) => {
    // Objects sharing an id: every renamed duplicate, plus the first copy of each shared id that kept it.
    const count = renumbered.filter((item) => item.pageIndex === pageIndex).length + ids.size;
    return `${count} objects sharing ${ids.size === 1 ? "an id" : "ids"} on page ${pageIndex + 1}`;
  });
  const listed = parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `This file had ${listed}; ChemDraft gave the duplicates new ids. Save to keep the fix.`;
}
