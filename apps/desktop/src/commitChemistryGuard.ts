import type { ChemDraftDocument, DocumentPage, ElectronMarkObject, MoleculeAtom, MoleculeObject } from "@chemdraft/chem-core";
import { electronMarkAtomContribution } from "@chemdraft/document-workflow-core";

/**
 * The commit-time chemistry guard (AGENTS.md section 7: an operation that is not a chemistry edit
 * never changes chemistry). Earlier fixes guarded Duplicate and paste one path at a time, and each
 * review found another path (a paste placed after its own check, a move, a style change) where
 * commit normalization re-attributed a loose charge mark to a different molecule. So the check
 * runs once, in MainWindow's commit funnel, on the FINAL document: after placement and after
 * normalization. Every commit is checked unless its caller declares it a chemistry edit.
 *
 * Pure: the funnel injects commit normalization and the mark-to-atom resolver, so this module
 * never imports `documentWorkflow` (which imports this module's comparison for Duplicate).
 */

/** What the guard compares per atom: the stored charge and what charge and radical marks resolve to. */
export interface AtomChemistry {
  formalCharge: number;
  markCharge: number;
  markRadicals: number;
}

/** One atom of `expected` that is missing from, or has different chemistry in, `actual`. */
export interface AtomChemistryChange {
  atomId: string;
  before: AtomChemistry;
  /** Absent when the atom is gone. */
  after?: AtomChemistry;
}

/** A change to a molecule that existed before the operation (on page `pageId` before it). */
export interface MoleculeChemistryChange {
  pageId: string;
  moleculeId: string;
  /** Absent when the whole molecule is gone. */
  atomId?: string;
  before?: AtomChemistry;
  /** Absent when the atom, or its molecule, is gone. */
  after?: AtomChemistry;
}

/**
 * How the commit funnel treats one commit. `preserve` (the default) refuses the commit when a
 * molecule that existed before it would change; `operation` names it in the refusal ("Cannot
 * <operation> without changing…"). Moves and selection transforms preserve: owner ruling 2026-11-21
 * (charge always follows) carries every mark with its atom, so a move never changes chemistry and
 * this guard is the check that it did not. `exempt` is declared by a caller whose commit is meant to
 * change chemistry, or that is verified elsewhere; `reason` says which.
 */
export type CommitChemistryPolicy =
  | {
    readonly kind: "preserve";
    readonly operation?: string;
    /**
     * A SCOPED chemistry edit: the molecules whose atoms or bonds the operation itself added,
     * removed or changed (`structurallyEditedMoleculeKeys`, `before` against the operation's own
     * `next`) may change, and so may the molecules named in `editedMoleculeIds`. Every other
     * molecule that existed before stays guarded. Bond, chain and template placement use it
     * (`structureEditChemistry`): a ring fused onto A legitimately changes A, but a standalone
     * template placed beside B must not take B's legacy loose "+".
     */
    readonly structureEdit?: boolean;
    /** Molecules (by id, on any page) the operation is meant to change: `chemistryEditOf`. */
    readonly editedMoleculeIds?: readonly string[];
    /**
     * Molecules whose atoms the operation rebuilt with ids that do not name the same atoms as
     * before (`structureEditorChemistry`). The commit funnel then does not run the charge-follows
     * rule (`marksFollowAtoms`): it pairs atoms by id, and would carry a mark to, and anchor it on,
     * whichever atom inherited its atom's id.
     */
    readonly rebuiltMoleculeIds?: readonly string[];
    /** See `IndependentMarkMoves`. */
    readonly independentlyMovedMarkIds?: ReadonlySet<string>;
  }
  | {
    readonly kind: "exempt";
    readonly reason: "chemistry edit" | "text edit" | "plugin write";
    /** See `IndependentMarkMoves`: an exempt commit is not checked, but the charge-follows rule still reads it. */
    readonly independentlyMovedMarkIds?: ReadonlySet<string>;
  };

/**
 * `independentlyMovedMarkIds`: the electron marks the operation moved BY ITSELF, as the operation
 * that moved them declares them (a mark dragged or dropped, a mark transformed in a selection
 * without its molecule: `electronMarkDrop.ts`). It is the only source of a mark-move exemption:
 * nothing infers from atom motion that a mark moved by itself. The commit guard exempts the old and
 * new atoms of these marks (a mark drop under the mark-move policy) and nothing else; a mark the
 * charge-follows rule carried with its atom is never exempt. The charge-follows rule leaves these
 * marks where the operation put them when their atom stayed put, and puts every other mark of an
 * unmoved atom back exactly as it was. Every other move path passes none.
 */
export type IndependentMarkMoves = ReadonlySet<string>;

export const PRESERVE_CHEMISTRY: CommitChemistryPolicy = { kind: "preserve" };
/**
 * Document-wide exemption: deleting, label edits, mark drops and drags, atom drags, the point-based
 * charge tool (a Ketcher save is scoped: `structureEditorChemistry`). Prefer the scoped `structureEditChemistry` / `chemistryEditOf`
 * wherever the molecules an operation is meant to change are known.
 */
export const CHEMISTRY_EDIT: CommitChemistryPolicy = { kind: "exempt", reason: "chemistry edit" };
/** Typing in a text object: the session's content was already the present while it was typed. */
export const TEXT_EDIT: CommitChemistryPolicy = { kind: "exempt", reason: "text edit" };
/** Plugin and assistant writes: `document.write` is declared and the host verifies them itself. */
export const PLUGIN_WRITE: CommitChemistryPolicy = { kind: "exempt", reason: "plugin write" };

export function preserveChemistry(operation?: string): CommitChemistryPolicy {
  return operation === undefined ? PRESERVE_CHEMISTRY : { kind: "preserve", operation };
}

/**
 * Bond, chain and template placement, standalone or fused: only the molecules whose atoms or bonds
 * the operation added, removed or changed (plus `moleculeIds`) may change chemistry.
 */
export function structureEditChemistry(operation?: string, moleculeIds?: readonly string[]): CommitChemistryPolicy {
  return { kind: "preserve", operation, structureEdit: true, ...(moleculeIds?.length ? { editedMoleculeIds: moleculeIds } : {}) };
}

/** A chemistry edit of the named molecules only (a charge placed on an atom, an atom-problem fix). */
export function chemistryEditOf(moleculeIds: readonly string[], operation?: string): CommitChemistryPolicy {
  return { kind: "preserve", operation, editedMoleculeIds: moleculeIds };
}

/**
 * A structure-editor (Ketcher) save of one molecule: only that molecule may change. The save
 * rebuilds the molecule and reuses its previous atom ids by array index (`parseV3000MoleculeGraph`),
 * so deleting or reordering an earlier atom shifts later atoms onto other atoms' old ids. No id can
 * be trusted to name the same atom, so marks are not carried by the charge-follows rule: they stay
 * where they are and normal mark association applies, inside the edited molecule only.
 */
export function structureEditorChemistry(moleculeId: string): CommitChemistryPolicy {
  return { kind: "preserve", operation: "apply this structure edit", editedMoleculeIds: [moleculeId], rebuiltMoleculeIds: [moleculeId] };
}

/**
 * Whether the commit funnel runs the charge-follows rule (owner ruling 2026-11-21) for a commit
 * under `policy`: always, except for a commit that rebuilt atoms under new ids
 * (`rebuiltMoleculeIds`), where pairing atoms by id would pair different atoms.
 */
export function marksFollowAtoms(policy: CommitChemistryPolicy | undefined): boolean {
  return !(policy?.kind === "preserve" && policy.rebuiltMoleculeIds?.length);
}

/**
 * A move or selection transform (align, rotate, nudge, a drag…). Owner ruling 2026-11-21 (charge
 * always follows): marks move with their atoms, so a move preserves every molecule's chemistry,
 * moved or not, with no exempt atom. Only the marks the transform itself reports it moved without
 * their atom (`independentlyMovedMarkIds`, a mark drop) may change chemistry, under the mark-move
 * policy; a transform that moved none passes none.
 */
export function selectionTransformChemistry(operation?: string, independentlyMovedMarkIds?: IndependentMarkMoves): CommitChemistryPolicy {
  return withIndependentlyMovedMarks(preserveChemistry(operation), independentlyMovedMarkIds);
}

/** `policy` with the marks the operation moved by itself (`IndependentMarkMoves`); unchanged for none. */
export function withIndependentlyMovedMarks(policy: CommitChemistryPolicy, markIds?: IndependentMarkMoves): CommitChemistryPolicy {
  return markIds === undefined ? policy : { ...policy, independentlyMovedMarkIds: markIds };
}

/**
 * Object ids are unique only within a page, so an atom is keyed by its page as well. The key is a
 * JSON tuple, so no id (one holding a newline or any other delimiter) can alias another triple.
 */
export const atomChemistryKey = (pageId: string, moleculeId: string, atomId: string) => JSON.stringify([pageId, moleculeId, atomId]);

export function atomChemistry(atom: MoleculeAtom): AtomChemistry {
  return { formalCharge: atom.formalCharge, markCharge: atom.markCharge ?? 0, markRadicals: atom.markRadicals ?? 0 };
}

function sameAtomChemistry(a: MoleculeAtom, b: MoleculeAtom): boolean {
  return a.formalCharge === b.formalCharge && (a.markCharge ?? 0) === (b.markCharge ?? 0) &&
    (a.markRadicals ?? 0) === (b.markRadicals ?? 0);
}

/**
 * THE comparison: every atom of `expected` against the atom with the same id in `actual`. Used for
 * a molecule before and after an operation, and by Duplicate for an original and its copy (copies
 * keep their atom ids). Atoms only `actual` has are not reported. Empty when nothing changed.
 */
export function moleculeAtomChemistryChanges(expected: MoleculeObject, actual: MoleculeObject): AtomChemistryChange[] {
  if (expected === actual || expected.atoms === actual.atoms) return [];
  const actualAtoms = new Map(actual.atoms.map((atom) => [atom.id, atom]));
  const changes: AtomChemistryChange[] = [];
  for (const atom of expected.atoms) {
    const found = actualAtoms.get(atom.id);
    if (found === atom || (found && sameAtomChemistry(atom, found))) continue;
    changes.push(found
      ? { atomId: atom.id, before: atomChemistry(atom), after: atomChemistry(found) }
      : { atomId: atom.id, before: atomChemistry(atom) });
  }
  return changes;
}

export interface PreexistingChemistryOptions {
  /** Only molecules on this page of `before`; every page when absent. */
  pageId?: string;
  /** Molecules the caller compares itself. */
  skipMoleculeIds?: ReadonlySet<string>;
  /** Atoms (`atomChemistryKey`) whose change the operation itself explains; never reported. */
  exemptAtomKeys?: ReadonlySet<string>;
}

const moleculesById = (page: DocumentPage | undefined) => new Map((page?.objects ?? [])
  .flatMap((object) => object.type === "molecule" ? [[object.id, object] as const] : []));

/**
 * The molecule of `after` that a molecule of `before`, gone from its own page, moved to; matching is
 * one-to-one. A source is a molecule of `before` whose page no longer holds its id in `after`; a
 * destination is a molecule of `after` on a page that did not hold that id in `before` (a molecule
 * already on its page in `before` is that page's own and never stands in for a same-id molecule
 * removed from another page). For each id, every source is paired with at most one destination and
 * every destination with at most one source: first pairs where the destination IS the source, then
 * pairs with the same structure and chemistry, then any remaining pairs, each in document order. A
 * source left unpaired has no match and so is reported removed (pages A and B both held "m"; only
 * page C holds it now: one of them moved, the other is gone); a destination left unpaired is an
 * addition and matches nothing. Built lazily.
 */
function movedPageMatcher(before: ChemDraftDocument, after: ChemDraftDocument): (pageId: string, id: string) => MoleculeObject | undefined {
  let matched: Map<string, MoleculeObject> | undefined;
  return (pageId, id) => {
    if (!matched) {
      matched = new Map();
      const beforePages = new Map(before.pages.map((page) => [page.id, page]));
      const afterPages = new Map(after.pages.map((page) => [page.id, page]));
      const destinations = new Map<string, MoleculeObject[]>();
      for (const page of after.pages) {
        const heldBefore = moleculesById(beforePages.get(page.id));
        for (const object of page.objects) {
          if (object.type !== "molecule" || heldBefore.has(object.id)) continue;
          const list = destinations.get(object.id);
          if (list) list.push(object); else destinations.set(object.id, [object]);
        }
      }
      const sources = new Map<string, { pageId: string; molecule: MoleculeObject }[]>();
      for (const page of before.pages) {
        if (!page.objects.some((object) => object.type === "molecule" && destinations.has(object.id))) continue;
        const heldAfter = moleculesById(afterPages.get(page.id));
        for (const object of page.objects) {
          if (object.type !== "molecule" || heldAfter.has(object.id) || !destinations.has(object.id)) continue;
          const list = sources.get(object.id);
          if (list) list.push({ pageId: page.id, molecule: object }); else sources.set(object.id, [{ pageId: page.id, molecule: object }]);
        }
      }
      const tiers: ((source: MoleculeObject, destination: MoleculeObject) => boolean)[] = [
        (source, destination) => source === destination,
        (source, destination) => sameMoleculeStructure(source, destination) &&
          moleculeAtomChemistryChanges(source, destination).length === 0,
        () => true
      ];
      for (const [moleculeId, candidates] of sources) {
        // By position, not identity: one molecule object can sit on several pages.
        const arrived = destinations.get(moleculeId)!;
        const sourcePaired = candidates.map(() => false);
        const destinationPaired = arrived.map(() => false);
        for (const pairs of tiers) {
          candidates.forEach((source, sourceIndex) => {
            if (sourcePaired[sourceIndex]) return;
            const destinationIndex = arrived.findIndex((destination, index) => !destinationPaired[index] && pairs(source.molecule, destination));
            if (destinationIndex < 0) return;
            matched.set(moleculeKey(source.pageId, moleculeId), arrived[destinationIndex]);
            sourcePaired[sourceIndex] = destinationPaired[destinationIndex] = true;
          });
        }
      }
    }
    return matched.get(moleculeKey(pageId, id));
  };
}

/**
 * Every molecule in `before` against the molecule with the same id in `after`: changed atoms,
 * removed atoms, and molecules that are gone. Object ids are unique only within a page, so a
 * molecule is matched on its own page, and on another page only when it moved pages
 * (`movedPageMatcher`, one-to-one): a same-id molecule another page already held never masks its
 * removal, and two removed same-id molecules never both match one arrival.
 * Molecules only `after` has (pasted, duplicated, drawn) are ignored.
 * Compare committed (normalized) documents: that is the chemistry the user sees.
 */
export function preexistingMoleculeChemistryChanges(
  before: ChemDraftDocument,
  after: ChemDraftDocument,
  options: PreexistingChemistryOptions = {}
): MoleculeChemistryChange[] {
  if (before === after || before.pages === after.pages) return [];
  const afterPages = new Map(after.pages.map((page) => [page.id, page]));
  const movedPages = movedPageMatcher(before, after);
  const changes: MoleculeChemistryChange[] = [];
  for (const page of before.pages) {
    if (options.pageId !== undefined && page.id !== options.pageId) continue;
    const afterPage = afterPages.get(page.id);
    if (afterPage?.objects === page.objects) continue;
    const samePage = moleculesById(afterPage);
    for (const molecule of page.objects) {
      if (molecule.type !== "molecule" || options.skipMoleculeIds?.has(molecule.id)) continue;
      const found = samePage.get(molecule.id) ?? movedPages(page.id, molecule.id);
      if (found === molecule) continue;
      if (!found) {
        changes.push({ pageId: page.id, moleculeId: molecule.id });
        continue;
      }
      for (const change of moleculeAtomChemistryChanges(molecule, found)) {
        if (options.exemptAtomKeys?.has(atomChemistryKey(page.id, molecule.id, change.atomId))) continue;
        changes.push({ pageId: page.id, moleculeId: molecule.id, ...change });
      }
    }
  }
  return changes;
}

/** "Cannot <operation> without changing the chemistry of molecule "m": its atom "a" would …". */
export function describeMoleculeChemistryChange(change: MoleculeChemistryChange, operation = "complete this edit"): string {
  const prefix = `Cannot ${operation} without changing the chemistry of molecule "${change.moleculeId}": `;
  if (change.atomId === undefined) return `${prefix}it would be removed.`;
  const { before, after } = change;
  if (!after || !before) return `${prefix}its atom "${change.atomId}" would be removed.`;
  if (after.formalCharge === before.formalCharge && after.markRadicals === before.markRadicals) {
    return `${prefix}its atom "${change.atomId}" would take ${after.markCharge} of its charge ${after.formalCharge} ` +
      `from charge marks instead of ${before.markCharge}.`;
  }
  return `${prefix}its atom "${change.atomId}" would have charge ${after.formalCharge} and ${after.markRadicals} ` +
    `radical marks instead of ${before.formalCharge} and ${before.markRadicals}.`;
}

/** One status line for a refused commit: the first change, and how many more there are. */
export function chemistryRefusalStatus(messages: readonly string[]): string {
  if (messages.length <= 1) return messages[0] ?? "";
  return `${messages[0]} (and ${messages.length - 1} more)`;
}

/** The atom a charge or radical mark is attributed to on its page (commit's own resolver). */
export type MarkAtomResolver = (page: DocumentPage, mark: ElectronMarkObject) => readonly { objectId: string; atomId: string }[];

export interface CommitChemistryCheck {
  /** The committed document the operation started from. */
  before: ChemDraftDocument;
  /** The operation's own result, before commit normalization: decides which marks it moved. */
  next: ChemDraftDocument;
  /** The normalized document about to be committed: placement and normalization are done. */
  after: ChemDraftDocument;
  /**
   * Commit normalization (idempotent). The operation is judged against what a commit of the
   * UNCHANGED document would hold, `normalize(before)`, not against `before` itself: a file opened
   * with its stored marks preserved can differ from that, and the first commit of any kind settles
   * the difference. That settling is not the operation's doing, so it is never blamed on it, while a
   * change the operation causes is caught even where the stored value happened to match it.
   */
  normalize: (document: ChemDraftDocument) => ChemDraftDocument;
  /** Resolves which atoms a mark's chemistry goes to; see `independentlyMovedMarkAtomKeys`. */
  markAtoms: MarkAtomResolver;
  operation?: string;
  /** The marks the operation moved by itself (`IndependentMarkMoves`); none when absent. */
  independentlyMovedMarkIds?: IndependentMarkMoves;
  /** A scoped structure edit: the molecules it structurally edited may change (`structurallyEditedMoleculeKeys`). */
  structureEdit?: boolean;
  /** Molecules (by id, on any page) the operation is meant to change. */
  editedMoleculeIds?: readonly string[];
}

/**
 * The commit-time check. Empty when no molecule that existed before the operation changes;
 * otherwise one message per changed atom (or removed molecule), naming both.
 *
 * Some changes are the operation's own, and only charge or radical changes on atoms that remain
 * (a removed atom or molecule is never exempt):
 * - a charge or radical mark the operation declares it moved by itself (`independentlyMovedMarkIds`:
 *   a mark drop, or a mark in a selection moved without its molecule) and did move or re-anchor:
 *   its old and new atoms (`independentlyMovedMarkAtomKeys`). No other mark explains anything; a
 *   mark the charge-follows rule carried with its atom never does;
 * - for a scoped chemistry edit (`structureEdit`, `editedMoleculeIds`), every change, removal
 *   included, to the molecules it structurally edited or names.
 * Molecules the operation did not select and move, edit or name are never exempt: the legacy loose
 * "+" that normalization would hand from B to a molecule placed beside it is refused, whether a
 * paste or a standalone template placed it.
 */
export function commitChemistryRefusals(check: CommitChemistryCheck): string[] {
  if (check.before === check.after) return [];
  const baseline = check.normalize(check.before);
  let changes = preexistingMoleculeChemistryChanges(baseline, check.after);
  if (changes.length === 0) return [];
  // A scoped edit: the molecules it edits are the operation's own, removal included (a bond that
  // joins B into A removes B); nothing else is.
  if (check.structureEdit || check.editedMoleculeIds?.length) {
    const edited = check.structureEdit ? structurallyEditedMoleculeKeys(check.before, check.next) : new Set<string>();
    const named = new Set(check.editedMoleculeIds ?? []);
    changes = changes.filter((change) => !named.has(change.moleculeId) && !edited.has(moleculeKey(change.pageId, change.moleculeId)));
    if (changes.length === 0) return [];
  }
  const exempt = independentlyMovedMarkAtomKeys(check.before, check.next, [baseline, check.after],
    check.independentlyMovedMarkIds, check.markAtoms);
  return changes
    .filter((change) => change.atomId === undefined || !change.after ||
      !exempt.has(atomChemistryKey(change.pageId, change.moleculeId, change.atomId)))
    .map((change) => describeMoleculeChemistryChange(change, check.operation));
}

/** A molecule on a page, as `structurallyEditedMoleculeKeys` keys it: a JSON tuple, so no id can alias another pair. */
export const moleculeKey = (pageId: string, moleculeId: string) => JSON.stringify([pageId, moleculeId]);

function sameAtomStructure(a: MoleculeAtom, b: MoleculeAtom): boolean {
  return a.element === b.element && a.isotope === b.isotope && a.x === b.x && a.y === b.y;
}

function sameMoleculeStructure(a: MoleculeObject, b: MoleculeObject): boolean {
  if (a === b) return true;
  if (a.atoms.length !== b.atoms.length || a.bonds.length !== b.bonds.length) return false;
  if (a.atoms !== b.atoms) {
    const atoms = new Map(b.atoms.map((atom) => [atom.id, atom]));
    if (a.atoms.some((atom) => { const other = atoms.get(atom.id); return !other || !sameAtomStructure(atom, other); })) return false;
  }
  if (a.bonds !== b.bonds) {
    const bonds = new Map(b.bonds.map((bond) => [bond.id, bond]));
    if (a.bonds.some((bond) => {
      const other = bonds.get(bond.id);
      return !other || other.fromAtomId !== bond.fromAtomId || other.toAtomId !== bond.toAtomId || other.order !== bond.order;
    })) return false;
  }
  return true;
}

/**
 * The molecules of `before` (`moleculeKey`) whose atoms or bonds the operation added, removed or
 * changed in its own result `next`: a different atom or bond set, an atom's element, isotope or
 * position, or a bond's atoms or order. A molecule gone from `next` (deleted, or joined into
 * another) counts as edited. Charge and radical fields are NOT structure: an operation that only
 * changes a molecule's charges did not edit it structurally. Pass the operation's own result, not
 * the normalized one, so commit normalization can never widen the set.
 */
export function structurallyEditedMoleculeKeys(before: ChemDraftDocument, next: ChemDraftDocument): Set<string> {
  const keys = new Set<string>();
  if (before === next || before.pages === next.pages) return keys;
  const nextPages = new Map(next.pages.map((page) => [page.id, page]));
  const onAnyPage = movedPageMatcher(before, next);
  for (const page of before.pages) {
    const nextPage = nextPages.get(page.id);
    if (nextPage?.objects === page.objects) continue;
    const samePage = moleculesById(nextPage);
    for (const molecule of page.objects) {
      if (molecule.type !== "molecule") continue;
      const found = samePage.get(molecule.id) ?? onAnyPage(page.id, molecule.id);
      if (!found || !sameMoleculeStructure(molecule, found)) keys.add(moleculeKey(page.id, molecule.id));
    }
  }
  return keys;
}

/**
 * `commitChemistryRefusals` under a commit policy, as the commit funnel applies it: an exempt
 * policy is not checked; a preserving one passes its operation name (else `operation`) and scope. Empty when the commit may proceed.
 */
export function policyChemistryRefusals(
  policy: CommitChemistryPolicy,
  check: Omit<CommitChemistryCheck, "operation" | "structureEdit" | "editedMoleculeIds" | "independentlyMovedMarkIds">,
  operation?: string
): string[] {
  if (policy.kind !== "preserve") return [];
  return commitChemistryRefusals({ ...check, operation: policy.operation ?? operation,
    structureEdit: policy.structureEdit, editedMoleculeIds: policy.editedMoleculeIds,
    independentlyMovedMarkIds: policy.independentlyMovedMarkIds });
}

/**
 * Atoms whose change the operation's own mark moves explain: for every mark it declares it moved
 * by itself (`markIds`) that carries charge or radicals and that it did reposition, resize or give
 * an explicit anchor it did not have, the atoms the mark is attributed to in each of `documents`,
 * on the page where it moved. Normalization never moves a mark and never makes an anchor explicit,
 * so a declared mark that normalization merely re-attributed explains nothing. Nothing is inferred
 * from how atoms moved: a mark not declared, including every mark the charge-follows rule carried
 * with its atom, has no exempt atom, so a pure move (a selection drag, nudge, align, distribute,
 * arrange, spacing, rotate, flip, resize, a part drag) must leave every charge and radical as it was.
 */
export function independentlyMovedMarkAtomKeys(
  before: ChemDraftDocument,
  next: ChemDraftDocument,
  documents: readonly ChemDraftDocument[],
  markIds: IndependentMarkMoves | undefined,
  markAtoms: MarkAtomResolver
): Set<string> {
  const keys = new Set<string>();
  if (!markIds?.size) return keys;
  const nextPages = new Map(next.pages.map((page) => [page.id, page]));
  for (const page of before.pages) {
    const nextPage = nextPages.get(page.id);
    if (!nextPage || nextPage.objects === page.objects) continue;
    const nextMarks = new Map(nextPage.objects
      .flatMap((object) => object.type === "electron-mark" && markIds.has(object.id) ? [[object.id, object] as const] : []));
    const moved = new Set<string>();
    for (const mark of page.objects) {
      if (mark.type !== "electron-mark" || !markIds.has(mark.id)) continue;
      const { charge, radicals } = electronMarkAtomContribution(mark);
      if (charge === 0 && radicals === 0) continue;
      const after = nextMarks.get(mark.id);
      if (!after || after === mark) continue;
      const repositioned = after.x !== mark.x || after.y !== mark.y || after.width !== mark.width || after.height !== mark.height;
      const reanchored = after.atomAssociation === "explicit" &&
        (mark.atomAssociation !== "explicit" || JSON.stringify(after.anchor) !== JSON.stringify(mark.anchor));
      if (repositioned || reanchored) moved.add(mark.id);
    }
    if (moved.size === 0) continue;
    for (const document of documents) {
      const documentPage = document.pages.find((candidate) => candidate.id === page.id);
      for (const mark of documentPage?.objects ?? []) {
        if (mark.type !== "electron-mark" || !moved.has(mark.id)) continue;
        for (const owner of markAtoms(documentPage!, mark)) keys.add(atomChemistryKey(page.id, owner.objectId, owner.atomId));
      }
    }
  }
  return keys;
}
