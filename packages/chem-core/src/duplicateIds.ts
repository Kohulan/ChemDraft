import type { ChemDraftDocument, DocumentObject } from "./schemas";

/** One id the reader gave a fresh value. `kind` says which id space it belongs to. */
export interface DuplicateIdRenumbering {
  kind: "object" | "atom" | "bond";
  pageId: string;
  /** The molecule holding a renumbered atom or bond. */
  moleculeId?: string;
  from: string;
  to: string;
}

/**
 * A native file can repeat an id on one page (two objects), or inside one molecule (two atoms,
 * two bonds). The schema allows it, but every by-id lookup then reaches only one copy, and which
 * one depends on the lookup: patches take the first, a later removal makes the same id reach the
 * second. Give every later copy a fresh id, so each object, atom and bond is addressable again.
 *
 * The first occurrence keeps its id, as every first-wins lookup already resolved it, and so do
 * references that name the repeated id: they cannot say which copy they meant. Two kinds of
 * reference do say so, and follow the renumbered copy:
 * - a reference inside the renumbered object to the object's own id (a superatom attachment point
 *   on its own molecule, for example);
 * - an atom- or bond-qualified reference (an anchor, a bond reference) whose atom or bond exists
 *   only in that one renumbered copy, not in the first.
 *
 * Nothing about atoms, bonds, charges or coordinates changes: only `id` values do. Mutates the
 * freshly read document in place and returns what it renamed, in document order.
 */
export function renumberDuplicateIds(document: ChemDraftDocument): DuplicateIdRenumbering[] {
  if (!hasDuplicateIds(document)) return [];
  const taken = documentStrings(document);
  // The search for a base resumes where its last one stopped: `taken` only grows, so every lower
  // suffix is still taken, and the result is the one a search from 2 would find. A taken string
  // `${base}_${n}` belongs to exactly one base (the text before its last "_"), so across the whole
  // repair each taken string is stepped over at most once and the searches stay linear.
  const nextSuffix = new Map<string, number>();
  const fresh = (id: string) => {
    let suffix = nextSuffix.get(id) ?? 2;
    while (taken.has(`${id}_${suffix}`)) suffix += 1;
    const next = `${id}_${suffix}`;
    taken.add(next);
    nextSuffix.set(id, suffix + 1);
    return next;
  };
  const renumbered: DuplicateIdRenumbering[] = [];

  for (const page of document.pages) {
    const firstById = new Map<string, DocumentObject>();
    const copies: { object: DocumentObject; from: string }[] = [];
    for (const object of page.objects) {
      if (!firstById.has(object.id)) {
        firstById.set(object.id, object);
        continue;
      }
      const from = object.id;
      object.id = fresh(from);
      copies.push({ object, from });
      renumbered.push({ kind: "object", pageId: page.id, from, to: object.id });
    }
    if (copies.length) relinkReferences(page, firstById, copies);

    for (const object of page.objects) {
      if (object.type !== "molecule") continue;
      for (const kind of ["atom", "bond"] as const) {
        const items: { id: string }[] = kind === "atom" ? object.atoms : object.bonds;
        const seen = new Set<string>();
        for (const item of items) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            continue;
          }
          const from = item.id;
          item.id = fresh(from);
          renumbered.push({ kind, pageId: page.id, moleculeId: object.id, from, to: item.id });
        }
      }
    }
  }
  return renumbered;
}

/** Short, specific text for the single open warning. */
export function duplicateIdRenumberingMessage(renumbered: readonly DuplicateIdRenumbering[]): string {
  const shown = 5;
  const describe = (entry: DuplicateIdRenumbering) => entry.kind === "object"
    ? `object "${entry.from}" on page "${entry.pageId}" became "${entry.to}"`
    : `${entry.kind} "${entry.from}" in molecule "${entry.moleculeId}" became "${entry.to}"`;
  const listed = renumbered.slice(0, shown).map(describe).join("; ");
  const more = renumbered.length > shown ? `; and ${renumbered.length - shown} more` : "";
  const count = renumbered.length === 1 ? "1 repeated id" : `${renumbered.length} repeated ids`;
  return `Renumbered ${count} so each copy can be edited on its own: ${listed}${more}. `
    + "References to a repeated id stay with its first copy.";
}

function hasDuplicateIds(document: ChemDraftDocument): boolean {
  return document.pages.some((page) => {
    if (repeats(page.objects)) return true;
    return page.objects.some((object) => object.type === "molecule" && (repeats(object.atoms) || repeats(object.bonds)));
  });
}

function repeats(items: readonly { id: string }[]): boolean {
  return new Set(items.map((item) => item.id)).size !== items.length;
}

/** Every string in the document, so a fresh id cannot capture a dangling reference either. */
function documentStrings(document: ChemDraftDocument): Set<string> {
  const strings = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") strings.add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(document);
  return strings;
}

type Page = ChemDraftDocument["pages"][number];
type Reference = { objectId: string; atomId?: unknown; bondId?: unknown };

/** Atom and bond ids of one molecule, indexed once so each reference costs one lookup. */
interface MemberIds { atoms: ReadonlySet<string>; bonds: ReadonlySet<string> }
/** For one repeated object id: which renumbered copies hold each atom or bond id, in page order. */
interface CopiesByMember { atoms: Map<string, DocumentObject[]>; bonds: Map<string, DocumentObject[]> }

function relinkReferences(
  page: Page,
  firstById: ReadonlyMap<string, DocumentObject>,
  copies: readonly { object: DocumentObject; from: string }[]
): void {
  const renamedFrom = new Map(copies.map(({ object, from }) => [object, from]));
  const copiesByOriginal = new Map<string, CopiesByMember>();
  for (const { object, from } of copies) {
    let index = copiesByOriginal.get(from);
    if (!index) copiesByOriginal.set(from, index = { atoms: new Map(), bonds: new Map() });
    if (object.type !== "molecule") continue;
    for (const key of ["atoms", "bonds"] as const) {
      for (const item of object[key]) {
        const holders = index[key].get(item.id);
        // A copy can repeat an atom or bond id; list it once.
        if (!holders) index[key].set(item.id, [object]);
        else if (holders[holders.length - 1] !== object) holders.push(object);
      }
    }
  }
  // Only the first copies of repeated ids are ever asked about.
  const firstMembers = new Map<string, MemberIds>();
  for (const from of copiesByOriginal.keys()) {
    const first = firstById.get(from);
    if (first?.type === "molecule") {
      firstMembers.set(from, { atoms: new Set(first.atoms.map((atom) => atom.id)), bonds: new Set(first.bonds.map((bond) => bond.id)) });
    }
  }

  const relink = (reference: Reference, owner: DocumentObject | undefined) => {
    const ownFrom = owner && renamedFrom.get(owner);
    if (ownFrom !== undefined && reference.objectId === ownFrom) {
      reference.objectId = owner!.id;
      return;
    }
    const index = copiesByOriginal.get(reference.objectId);
    if (!index) return;
    const atomId = typeof reference.atomId === "string" ? reference.atomId : undefined;
    const bondId = typeof reference.bondId === "string" ? reference.bondId : undefined;
    const first = firstMembers.get(reference.objectId);
    if (first && ((atomId !== undefined && first.atoms.has(atomId)) || (bondId !== undefined && first.bonds.has(bondId)))) return;
    // The copies holding the atom or the bond; the reference follows only when that is exactly one.
    const byAtom = atomId === undefined ? undefined : index.atoms.get(atomId);
    const byBond = bondId === undefined ? undefined : index.bonds.get(bondId);
    if ((byAtom?.length ?? 0) > 1 || (byBond?.length ?? 0) > 1) return;
    const match = byAtom?.[0] ?? byBond?.[0];
    if (!match || (byAtom && byBond && byAtom[0] !== byBond[0])) return;
    reference.objectId = match.id;
  };

  for (const object of page.objects) visitReferences(object, (reference) => relink(reference, object));
  visitReferences(page.crossings, (reference) => relink(reference, undefined));
}

/** Live references are records carrying a string `objectId` (anchors, bond references, reaction
 * components, bracket members). Opaque preserved payloads and style metadata are never touched. */
function visitReferences(value: unknown, visit: (reference: Reference) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item) => visitReferences(item, visit));
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.objectId === "string") visit(record as Reference);
  for (const [key, child] of Object.entries(record)) {
    if (key === "raw" || key === "style") continue;
    visitReferences(child, visit);
  }
}
