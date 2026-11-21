import type { ChemDraftDocument, DocumentPage, ElectronMarkObject, MoleculeAtom, MoleculeObject } from "@chemdraft/chem-core";
import { electronMarkAtomContribution } from "@chemdraft/document-workflow-core";
import { transformPointForObject } from "@chemdraft/layout-engine";

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
  }
  | { readonly kind: "exempt"; readonly reason: "chemistry edit" | "text edit" | "plugin write" };

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
 * moved or not, with no exempt atom. Only a selected mark the transform moved without its atom (a
 * mark drop) may change chemistry, under the mark-move policy (`movedSelectedMarkAtomKeys`).
 */
export function selectionTransformChemistry(operation?: string): CommitChemistryPolicy {
  return preserveChemistry(operation);
}

/** Object ids are unique only within a page, so an atom is keyed by its page as well. */
export const atomChemistryKey = (pageId: string, moleculeId: string, atomId: string) => `${pageId}\n${moleculeId}\n${atomId}`;

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
 * Every molecule in `before` against the molecule with the same id in `after`: changed atoms,
 * removed atoms, and molecules that are gone. Object ids are unique only within a page, so a
 * molecule is matched on its own page, and on another page only when that page set holds the id
 * once (it moved pages). Molecules only `after` has (pasted, duplicated, drawn) are ignored.
 * Compare committed (normalized) documents: that is the chemistry the user sees.
 */
export function preexistingMoleculeChemistryChanges(
  before: ChemDraftDocument,
  after: ChemDraftDocument,
  options: PreexistingChemistryOptions = {}
): MoleculeChemistryChange[] {
  if (before === after || before.pages === after.pages) return [];
  const afterPages = new Map(after.pages.map((page) => [page.id, page]));
  let elsewhere: Map<string, MoleculeObject | undefined> | undefined;
  const movedPages = (id: string) => {
    if (!elsewhere) {
      elsewhere = new Map();
      for (const page of after.pages) {
        for (const object of page.objects) {
          if (object.type !== "molecule") continue;
          // An id held by more than one page names no single molecule.
          elsewhere.set(object.id, elsewhere.has(object.id) ? undefined : object);
        }
      }
    }
    return elsewhere.get(id);
  };
  const changes: MoleculeChemistryChange[] = [];
  for (const page of before.pages) {
    if (options.pageId !== undefined && page.id !== options.pageId) continue;
    const afterPage = afterPages.get(page.id);
    if (afterPage?.objects === page.objects) continue;
    const samePage = moleculesById(afterPage);
    for (const molecule of page.objects) {
      if (molecule.type !== "molecule" || options.skipMoleculeIds?.has(molecule.id)) continue;
      const found = samePage.get(molecule.id) ?? movedPages(molecule.id);
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
  /** Resolves which atoms a mark's chemistry goes to; see `movedSelectedMarkAtomKeys`. */
  markAtoms: MarkAtomResolver;
  operation?: string;
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
 * - a charge or radical mark the user selected and the operation moved or explicitly re-anchored
 *   without its atom (a mark drop, or a mark in a selection moved without its molecule): its old
 *   and new atoms. A mark that followed its moved atom explains nothing (`movedSelectedMarkAtomKeys`);
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
  const exempt = movedSelectedMarkAtomKeys(check.before, check.next, [baseline, check.after], check.markAtoms);
  return changes
    .filter((change) => change.atomId === undefined || !change.after ||
      !exempt.has(atomChemistryKey(change.pageId, change.moleculeId, change.atomId)))
    .map((change) => describeMoleculeChemistryChange(change, check.operation));
}

/** A molecule on a page, as `structurallyEditedMoleculeKeys` keys it. */
export const moleculeKey = (pageId: string, moleculeId: string) => `${pageId}\n${moleculeId}`;

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
  let elsewhere: Map<string, MoleculeObject | undefined> | undefined;
  const onAnyPage = (id: string) => {
    if (!elsewhere) {
      elsewhere = new Map();
      for (const page of next.pages) {
        for (const object of page.objects) {
          if (object.type === "molecule") elsewhere.set(object.id, elsewhere.has(object.id) ? undefined : object);
        }
      }
    }
    return elsewhere.get(id);
  };
  for (const page of before.pages) {
    const nextPage = nextPages.get(page.id);
    if (nextPage?.objects === page.objects) continue;
    const samePage = moleculesById(nextPage);
    for (const molecule of page.objects) {
      if (molecule.type !== "molecule") continue;
      const found = samePage.get(molecule.id) ?? onAnyPage(molecule.id);
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
  check: Omit<CommitChemistryCheck, "operation" | "structureEdit" | "editedMoleculeIds">,
  operation?: string
): string[] {
  if (policy.kind !== "preserve") return [];
  return commitChemistryRefusals({ ...check, operation: policy.operation ?? operation,
    structureEdit: policy.structureEdit, editedMoleculeIds: policy.editedMoleculeIds });
}

/**
 * The selection's page and its ids plus every member of a selected group, nested groups included.
 * A selection belongs to one page (its `pageId`, else the first page).
 */
function selectedTargets(document: ChemDraftDocument): { pageId: string | undefined; ids: Set<string> } {
  const pageId = document.selection.pageId ?? document.pages[0]?.id;
  const page = document.pages.find((candidate) => candidate.id === pageId);
  const ids = new Set<string>(document.selection.objectIds);
  const members = new Map<string, readonly string[]>();
  for (const object of page?.objects ?? []) if (object.type === "group") members.set(object.id, object.childObjectIds);
  const pending: string[] = [...ids];
  while (pending.length > 0) {
    for (const child of members.get(pending.pop()!) ?? []) {
      if (!ids.has(child)) { ids.add(child); pending.push(child); }
    }
  }
  return { pageId, ids };
}

/** Page positions closer than this are the same place (frame rotation leaves float noise). */
const ATOM_PAGE_EPSILON_PX = 1e-6;

/** Whether `atom` of `molecule` and `after` of `moved` are drawn at different page positions. */
function atomPageMoved(molecule: MoleculeObject, atom: MoleculeAtom, moved: MoleculeObject, after: MoleculeAtom): boolean {
  const p = transformPointForObject(molecule, atom), q = transformPointForObject(moved, after);
  return Math.hypot(q.x - p.x, q.y - p.y) > ATOM_PAGE_EPSILON_PX;
}

/** Whether the molecule's stored transform (scale, rotation, tilt) changed; absent is the identity. */
function moleculeTransformChanged(molecule: MoleculeObject, moved: MoleculeObject): boolean {
  const state = (object: MoleculeObject) => [object.transform?.scaleX ?? 1, object.transform?.scaleY ?? 1,
    object.transform?.rotationDegrees ?? 0, object.transform?.tiltXDegrees ?? 0, object.transform?.tiltYDegrees ?? 0];
  const before = state(molecule), after = state(moved);
  return before.some((value, index) => Math.abs(value - after[index]) > 1e-9);
}

/**
 * Atoms whose change a selected charge or radical mark moved BY ITSELF explains: the atoms the mark
 * is attributed to in each of `documents`, on the selection's page. A mark counts as moved when the
 * operation changed its position or size, or gave it an explicit anchor it did not have
 * (normalization never moves a mark and never makes an anchor explicit, so a mark it merely
 * re-attributed does not count), and its own atom did not move: that is a mark drop or a mark
 * moved off its atom, under the mark-move policy. A mark whose atom moved followed it (owner ruling
 * 2026-11-21, charge always follows) and explains nothing, so a pure move (a selection drag, nudge,
 * align, distribute, arrange, spacing, rotate, flip, resize, a part drag) has no exempt atom at
 * all: every molecule's charges and radicals must come out as they were.
 */
export function movedSelectedMarkAtomKeys(
  before: ChemDraftDocument,
  next: ChemDraftDocument,
  documents: readonly ChemDraftDocument[],
  markAtoms: MarkAtomResolver
): Set<string> {
  const keys = new Set<string>();
  const { pageId, ids } = selectedTargets(before);
  const page = before.pages.find((candidate) => candidate.id === pageId);
  if (!page || ids.size === 0) return keys;
  const nextPage = next.pages.find((candidate) => candidate.id === pageId);
  const nextMarks = new Map((nextPage?.objects ?? [])
    .flatMap((object) => object.type === "electron-mark" ? [[object.id, object] as const] : []));
  const molecules = moleculesById(page), nextMolecules = moleculesById(nextPage);
  // Whether the operation moved the atom the mark belonged to before it, read from the atom itself
  // (review 2 P2b), never from the molecule's frame size (another atom moving changes that):
  // - its page position changed (its coordinates under the molecule's frame rotation); or
  // - the molecule's transform changed (a turn or scale about this very atom, such as a lone atom
  //   turned or scaled about itself, carries its marks while the atom stays put); or
  // - every other atom of the molecule moved: the whole molecule was turned, flipped or scaled
  //   with this atom as its fixed point.
  // A mark moved while none of these holds moved by itself.
  const ownAtomMoved = (mark: ElectronMarkObject) => markAtoms(page, mark).some((owner) => {
    const molecule = molecules.get(owner.objectId), moved = nextMolecules.get(owner.objectId);
    if (!molecule || !moved || moved === molecule) return false;
    const atom = molecule.atoms.find((candidate) => candidate.id === owner.atomId);
    const after = moved.atoms.find((candidate) => candidate.id === owner.atomId);
    if (!atom || !after) return false;
    if (atomPageMoved(molecule, atom, moved, after) || moleculeTransformChanged(molecule, moved)) return true;
    const nextAtoms = new Map(moved.atoms.map((candidate) => [candidate.id, candidate]));
    const others = molecule.atoms.filter((candidate) => candidate.id !== atom.id && nextAtoms.has(candidate.id));
    return others.length > 0 && others.every((candidate) => atomPageMoved(molecule, candidate, moved, nextAtoms.get(candidate.id)!));
  });
  const moved = new Set<string>();
  for (const mark of page.objects) {
    if (mark.type !== "electron-mark" || !ids.has(mark.id)) continue;
    const { charge, radicals } = electronMarkAtomContribution(mark);
    if (charge === 0 && radicals === 0) continue;
    const after = nextMarks.get(mark.id);
    if (!after) continue;
    const repositioned = after.x !== mark.x || after.y !== mark.y || after.width !== mark.width || after.height !== mark.height;
    const reanchored = after.atomAssociation === "explicit" &&
      (mark.atomAssociation !== "explicit" || JSON.stringify(after.anchor) !== JSON.stringify(mark.anchor));
    if ((repositioned || reanchored) && !ownAtomMoved(mark)) moved.add(mark.id);
  }
  if (moved.size === 0) return keys;
  for (const document of documents) {
    const documentPage = document.pages.find((candidate) => candidate.id === pageId);
    for (const mark of documentPage?.objects ?? []) {
      if (mark.type !== "electron-mark" || !moved.has(mark.id)) continue;
      for (const owner of markAtoms(documentPage!, mark)) keys.add(atomChemistryKey(pageId!, owner.objectId, owner.atomId));
    }
  }
  return keys;
}
