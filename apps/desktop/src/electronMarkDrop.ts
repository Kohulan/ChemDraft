import { applyPatch, applyPatches, nativeDrawingStyleFromObjectStyle,
  type ChemDraftDocument, type DocumentObject, type DocumentPage, type DocumentPatch, type ElectronMarkObject, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import { atomDisplayLabel, transformPointForObject } from "@chemdraft/layout-engine";
import { documentDrawingDefaults, nativeAtomChargeSupportsValence, nativeAtomExternalValence, nativeChargeAssociationRadiusPx,
  nativeElectronMarkAssignments, nativeElectronMarkAtomKey, nativeElementFromAtomLabel, phase4Timestamp, type PagePoint } from "@chemdraft/document-workflow-core";
import { committedElectronMarkAssignments, committedElectronMarkAtoms, electronMarkAtomContribution, electronMarkChemistryChanges, findDocumentObject,
  followElectronMarksWithMovedAtoms, isEditableNativeMoleculeGraph, type ElectronMarkFollowOptions, moveDocumentObject, moveDocumentObjects, nativeChargeMarkCenter,
  nativeChargePlacementPointForAtom, normalizeCommittedDocument, resolveGroupedDocumentObjectIds, type NativeMoleculeDeleteTarget } from "./documentWorkflow";

/** Document-space radius, independent of zoom and of the direct-editing preference. */
export const ELECTRON_MARK_DROP_CAPTURE_BOND_LENGTHS = 0.5;

/** Geometric target shared by the drag highlight and the committed drop, including refused targets. */
export function electronMarkDropTarget(
  document: ChemDraftDocument, point: PagePoint, pageId = document.pages[0]?.id,
  reposition?: { mark: ElectronMarkObject; center: PagePoint }
): NativeMoleculeDeleteTarget | undefined {
  const radius = documentDrawingDefaults(document).bondLengthPx * ELECTRON_MARK_DROP_CAPTURE_BOND_LENGTHS;
  const source = reposition && existingMarkAtom(document, reposition.mark);
  const keepSource = source && reposition && withinAssociationRadius(source, reposition.center);
  const target = nearestElectronMarkAtom(document, pageId, point, () => radius,
    (molecule, atom) => keepSource === true || molecule.id !== source?.molecule.id || atom.id !== source.atom.id);
  if (target || !source || !keepSource) return target;
  const atomPoint = transformPointForObject(source.molecule, source.atom);
  return { kind: "atom", objectId: source.molecule.id, atomId: source.atom.id,
    distanceToPointer: Math.hypot(point.x - atomPoint.x, point.y - atomPoint.y) };
}

function associationRadius(molecule: MoleculeObject): number {
  return Math.max(nativeChargeAssociationRadiusPx, nativeDrawingStyleFromObjectStyle(molecule.style).bondLengthPx * 1.15);
}

function withinAssociationRadius({ molecule, atom }: AtomEndpoint, center: PagePoint): boolean {
  const point = transformPointForObject(molecule, atom);
  return Math.hypot(center.x - point.x, center.y - point.y) <= associationRadius(molecule);
}

function nearestElectronMarkAtom(
  document: ChemDraftDocument, pageId: string | undefined, point: PagePoint,
  radiusFor: (molecule: MoleculeObject) => number, eligible: (molecule: MoleculeObject, atom: MoleculeAtom) => boolean
): NativeMoleculeDeleteTarget | undefined {
  let nearest: NativeMoleculeDeleteTarget | undefined;
  for (const object of document.pages.find(page => page.id === pageId)?.objects ?? []) {
    if (object.type !== "molecule" || !isEditableNativeMoleculeGraph(object)) continue;
    // Atom coordinates precede the molecule's SVG rotation. Invert that same frame transform
    // for both preview and commit, so the target is the atom drawn under the pointer.
    const localPoint = transformPointForObject({ ...object, rotation: -object.rotation }, point);
    const radius = radiusFor(object);
    for (const atom of object.atoms) {
      if (!eligible(object, atom)) continue;
      const distanceToPointer = Math.hypot(localPoint.x - atom.x, localPoint.y - atom.y);
      if (distanceToPointer <= radius && (!nearest || distanceToPointer < nearest.distanceToPointer)) {
        nearest = { kind: "atom", objectId: object.id, atomId: atom.id, distanceToPointer };
      }
    }
  }
  return nearest;
}

interface AtomEndpoint {
  molecule: MoleculeObject;
  atom: MoleculeAtom;
}

function associatedAtom(document: ChemDraftDocument, anchor: ElectronMarkObject["anchor"]): AtomEndpoint | undefined {
  return anchor.kind === "atom" ? findAtomEndpoint(document, anchor) : undefined;
}

function existingMarkAtom(document: ChemDraftDocument, mark: ElectronMarkObject): AtomEndpoint | undefined {
  const { anchor } = mark;
  if (anchor.kind === "atom" || anchor.kind === "point") return associatedAtom(document, anchor);
  const page = document.pages.find(page => page.objects.some(object => object.id === mark.id));
  return page && findAtomEndpoint(document, committedElectronMarkAssignments(page).anchorByMarkId.get(mark.id));
}

function findAtomEndpoint(document: ChemDraftDocument, owner?: { objectId?: string; atomId?: string }): AtomEndpoint | undefined {
  return owner?.objectId ? atomEndpoint(findDocumentObject(document, owner.objectId), owner.atomId) : undefined;
}

function atomEndpoint(object: DocumentObject | undefined, atomId: string | undefined): AtomEndpoint | undefined {
  if (object?.type !== "molecule") return undefined;
  const atom = object.atoms.find(atom => atom.id === atomId);
  return atom ? { molecule: object, atom } : undefined;
}

function label({ molecule, atom }: AtomEndpoint): string {
  return atomDisplayLabel(atom, molecule.bonds, nativeDrawingStyleFromObjectStyle(molecule.style), molecule.atoms) ?? atom.element;
}

/** Context from the existing graph and displayed label, before a same-element transfer. */
function atomContextName(endpoint: AtomEndpoint): string {
  const { molecule, atom } = endpoint;
  const neighbours = molecule.bonds.flatMap(bond => {
    const neighbourId = bond.fromAtomId === atom.id ? bond.toAtomId : bond.toAtomId === atom.id ? bond.fromAtomId : undefined;
    const neighbour = molecule.atoms.find(candidate => candidate.id === neighbourId);
    return neighbour ? [{ atom: neighbour, order: bond.order }] : [];
  });
  const multiple = neighbours.find(neighbour => neighbour.order === "double" || neighbour.order === "triple");
  if (multiple) return `${multiple.atom.element}${multiple.order === "double" ? "=" : "≡"}${atom.element}`;
  const displayed = label(endpoint);
  if (displayed !== atom.element) return displayed;
  const heavy = neighbours.find(neighbour => neighbour.atom.element !== "H");
  return heavy ? `${heavy.atom.element}–${atom.element}` : atom.element;
}

export function electronMarkName(mark: ElectronMarkObject): string {
  return mark.markKind === "charge" ? (mark.radical ? "Radical ion" : "Charge")
    : mark.markKind === "radical-dot" ? "Radical electron"
    : mark.markKind === "lone-pair" ? "Lone pair" : "Electron mark";
}

export interface ElectronMarkDropResult {
  document: ChemDraftDocument;
  status: string;
  undoLabel: string;
  refused?: boolean;
  /** The mark this drop moved by itself, for the commit (`IndependentMarkMoves`). */
  independentlyMovedMarkIds: ReadonlySet<string>;
}

const NO_MARKS: ReadonlySet<string> = new Set();

/**
 * The electron marks among `objectIds` (selected groups' members included) on `page` that the
 * operation transforms as objects of their own: marks whose molecule is not among them. Its owner is
 * the molecule its anchor names, or for a loose mark the one commit normalization gives it. A mark
 * selected with its molecule is moved, if at all, by the charge-follows rule with its atom.
 */
function marksSelectedWithoutTheirMolecule(page: DocumentPage | undefined, objectIds: readonly string[]): Set<string> {
  const marks = new Set<string>();
  if (!page || !objectIds.length) return marks;
  const selected = new Set(resolveGroupedDocumentObjectIds(page.objects, objectIds));
  for (const mark of page.objects) {
    if (mark.type !== "electron-mark" || !selected.has(mark.id)) continue;
    const owners = mark.anchor.kind !== "point" && mark.anchor.objectId !== undefined ? [mark.anchor.objectId]
      : committedElectronMarkAtoms(page, mark).map(owner => owner.objectId);
    if (!owners.some(owner => selected.has(owner))) marks.add(mark.id);
  }
  return marks;
}

/**
 * Of `candidates`, the marks the operation did move or re-anchor (`before` against `after`) and
 * the charge-follows rule did not carry with a moved atom: the commit's `IndependentMarkMoves`.
 */
function independentMarkMoves(
  before: ChemDraftDocument, after: ChemDraftDocument, candidates: ReadonlySet<string>, followed: ReadonlySet<string>
): ReadonlySet<string> {
  if (!candidates.size || before === after) return NO_MARKS;
  const moved = new Set<string>();
  for (const page of before.pages) {
    const nextPage = after.pages.find(candidate => candidate.id === page.id);
    if (!nextPage || nextPage.objects === page.objects) continue;
    const nextObjects = new Map(nextPage.objects.map(object => [object.id, object]));
    for (const mark of page.objects) {
      if (mark.type !== "electron-mark" || !candidates.has(mark.id) || followed.has(mark.id)) continue;
      const next = nextObjects.get(mark.id);
      if (next && next !== mark) moved.add(mark.id);
    }
  }
  return moved;
}

/** The page of the document's selection (its `pageId`, else the first page). */
function selectionPage(document: ChemDraftDocument): DocumentPage | undefined {
  const pageId = document.selection.pageId ?? document.pages[0]?.id;
  return document.pages.find(page => page.id === pageId);
}

interface ElectronMarkDrop {
  mark: ElectronMarkObject;
  anchor: ElectronMarkObject["anchor"];
  source: AtomEndpoint | undefined;
  destination: AtomEndpoint | undefined;
  preserveAnchor?: boolean;
}

function sameAtom(first: AtomEndpoint | undefined, second: AtomEndpoint | undefined): boolean {
  return first?.molecule.id === second?.molecule.id && first?.atom.id === second?.atom.id;
}

function planElectronMarkDrop(
  before: ChemDraftDocument, moved: ChemDraftDocument, mark: ElectronMarkObject, center: PagePoint, dropPoint: PagePoint
): ElectronMarkDrop {
  const pageId = before.pages.find(page => page.objects.some(object => object.id === mark.id))?.id;
  const target = electronMarkDropTarget(moved, dropPoint, pageId, { mark, center });
  return planElectronMarkAssignment(before, mark, center, target);
}

function planElectronMarkAssignment(
  before: ChemDraftDocument, mark: ElectronMarkObject, center: PagePoint,
  target: NativeMoleculeDeleteTarget | undefined
): ElectronMarkDrop {
  const anchor: ElectronMarkObject["anchor"] = target?.kind === "atom"
    ? { kind: "atom", objectId: target.objectId, atomId: target.atomId }
    : { kind: "point", point: center };
  return { mark, anchor, source: existingMarkAtom(before, mark), destination: associatedAtom(before, anchor) };
}

function legacyAnchorAssociationChanges(
  document: ChemDraftDocument, page: DocumentPage, nextPage: DocumentPage
): ElectronMarkDrop[] {
  const legacyMarks = page.objects.filter((mark): mark is ElectronMarkObject => mark.type === "electron-mark" &&
    (mark.markKind === "charge" || mark.markKind === "radical-dot") &&
    (mark.anchor.kind === "bond" || mark.anchor.kind === "object"));
  if (!legacyMarks.length) return [];
  const before = committedElectronMarkAssignments(page).anchorByMarkId;
  const after = committedElectronMarkAssignments(nextPage).anchorByMarkId;
  const nextObjects = new Map(nextPage.objects.map(object => [object.id, object]));
  return legacyMarks.flatMap(mark => {
    const next = nextObjects.get(mark.id);
    if (next?.type !== "electron-mark" || next.anchor.kind !== mark.anchor.kind ||
        next.anchor.objectId !== mark.anchor.objectId || next.anchor.bondId !== mark.anchor.bondId) return [];
    const source = findAtomEndpoint(document, before.get(mark.id));
    const destination = findAtomEndpoint(document, after.get(mark.id));
    return sameAtom(source, destination) ? [] : [{ mark, anchor: mark.anchor, source, destination, preserveAnchor: true }];
  });
}

/** A direct drop uses the pointer for atom capture and the translated mark center for a free annotation. */
export function dropElectronMark(
  document: ChemDraftDocument, markId: string, position: PagePoint, dropPoint: PagePoint
): ElectronMarkDropResult {
  const mark = findDocumentObject(document, markId);
  if (mark?.type !== "electron-mark") {
    return { document, status: "Electron mark no longer exists", undoLabel: "Move electron mark", independentlyMovedMarkIds: NO_MARKS };
  }
  const center = { x: position.x + mark.width / 2, y: position.y + mark.height / 2 };
  const drop = planElectronMarkDrop(document, document, mark, center, dropPoint);
  const moved = moveDocumentObject(document, markId, position);
  const result = applyElectronMarkDrops(document, moved, [drop]);
  return { ...result, undoLabel: drop.source || drop.destination ? `Move ${electronMarkName(mark)}` : "Move electron mark",
    independentlyMovedMarkIds: result.document === document ? NO_MARKS : new Set([markId]) };
}

/**
 * Validate independent marks against the selection's final geometry and commit the move as a unit.
 * Marks associated with a moved atom follow it (`followElectronMarksWithMovedAtoms`, owner ruling
 * 2026-11-21); only selected marks moved without their molecule are drops under the mark-move
 * policy. The result names them (`independentlyMovedMarkIds`) for the commit: they are the only
 * marks whose atoms' chemistry the move may change.
 */
export function dropElectronMarksInSelection(
  document: ChemDraftDocument, objectIds: readonly string[], delta: PagePoint,
  release: { grabbedObjectId: string; point: PagePoint }
): { document: ChemDraftDocument; status?: string; independentlyMovedMarkIds: ReadonlySet<string> } {
  const translated = moveDocumentObjects(document, objectIds, delta.x, delta.y, { preserveCarriedMarkAnchors: true });
  if (translated === document) return { document, independentlyMovedMarkIds: NO_MARKS };
  const page = document.pages.find(page => page.objects.some(object => object.id === release.grabbedObjectId));
  const candidates = marksSelectedWithoutTheirMolecule(page, objectIds);
  const { document: moved, followedMarkIds } = followElectronMarksWithMovedAtoms(document, translated,
    { independentlyMovedMarkIds: candidates });

  const selectedIds = new Set(resolveGroupedDocumentObjectIds(page?.objects ?? [], objectIds));
  const drops = (page?.objects ?? []).flatMap((mark) => {
    if (mark.type !== "electron-mark" || !selectedIds.has(mark.id) || followedMarkIds.has(mark.id)) return [];
    const source = associatedAtom(document, mark.anchor);
    if (source && selectedIds.has(source.molecule.id)) return [];
    const translatedMark = findDocumentObject(moved, mark.id);
    if (translatedMark?.type !== "electron-mark") return [];
    const center = nativeChargeMarkCenter(translatedMark);
    return [planElectronMarkDrop(document, moved, mark, center, mark.id === release.grabbedObjectId ? release.point : center)];
  });
  const nextPage = moved.pages.find(candidate => candidate.id === page?.id);
  if (page && nextPage) {
    const directMarkIds = new Set(drops.map(drop => drop.mark.id));
    drops.push(...legacyAnchorAssociationChanges(document, page, nextPage)
      .filter(drop => !directMarkIds.has(drop.mark.id) && !followedMarkIds.has(drop.mark.id)));
  }
  const result = drops.length ? applyElectronMarkDrops(document, moved, drops) : { document: moved };
  return { ...result, independentlyMovedMarkIds: independentMarkMoves(document, result.document, candidates, followedMarkIds) };
}

/**
 * Part drags move atoms of a molecule. Owner ruling 2026-11-21 (charge always follows): every mark
 * associated with a moved atom moves with it, and the drag never changes chemistry, so there is
 * nothing to detach, transfer or refuse.
 */
export function resolveElectronMarksAfterMoleculePartMove(
  document: ChemDraftDocument, moved: ChemDraftDocument
): { document: ChemDraftDocument; status?: string } {
  if (moved === document) return { document };
  return { document: followElectronMarksWithMovedAtoms(document, moved).document };
}

/**
 * Marks associated with an atom the transform moved follow it (owner ruling 2026-11-21), and a mark
 * of an atom it left in place stays exactly where it was. A mark the transform moved as an object of
 * its own (selected in `document`'s selection without its molecule) keeps the mark-move policy: it
 * detaches when it leaves its atom's association radius, and a free mark stays free. The result
 * names those marks (`independentlyMovedMarkIds`) for the commit's policy. `follow` names the
 * transform where the caller knows it (a turn, a flip): see `ElectronMarkFollowOptions`.
 */
export function resolveElectronMarksInSelectionTransform(
  document: ChemDraftDocument, transformed: ChemDraftDocument, follow: Omit<ElectronMarkFollowOptions, "independentlyMovedMarkIds"> = {}
): { document: ChemDraftDocument; status?: string; refused?: boolean; independentlyMovedMarkIds: ReadonlySet<string> } {
  if (transformed === document) return { document, independentlyMovedMarkIds: NO_MARKS };
  const candidates = marksSelectedWithoutTheirMolecule(selectionPage(document), document.selection.objectIds);
  const { document: followed, followedMarkIds } = followElectronMarksWithMovedAtoms(document, transformed,
    { ...follow, independentlyMovedMarkIds: candidates });
  const drops: ElectronMarkDrop[] = [];
  const preserve: DocumentPatch[] = [];
  for (const page of document.pages) {
    const nextPage = followed.pages.find(candidate => candidate.id === page.id);
    if (!nextPage || nextPage.objects === page.objects) continue;
    const marks = page.objects.filter(object => object.type === "electron-mark");
    if (!marks.length) continue;
    drops.push(...legacyAnchorAssociationChanges(document, page, nextPage).filter(drop => !followedMarkIds.has(drop.mark.id)));
    const objects = new Map(page.objects.map(object => [object.id, object]));
    const nextObjects = new Map(nextPage.objects.map(object => [object.id, object]));
    let assignments: ReturnType<typeof nativeElectronMarkAssignments>["anchorByMarkId"] | undefined;
    for (const mark of marks) {
      if (followedMarkIds.has(mark.id)) continue;
      const next = nextObjects.get(mark.id);
      if (next?.type !== "electron-mark") continue;
      const anchor = mark.anchor;
      if (anchor.kind !== "atom" && anchor.kind !== "point") continue;
      const center = nativeChargeMarkCenter(next);
      const previousCenter = nativeChargeMarkCenter(mark);
      // Stationary marks keep their association through `followElectronMarksWithMovedAtoms`.
      if (Math.hypot(center.x - previousCenter.x, center.y - previousCenter.y) <= 1e-6) continue;
      const source = anchor.kind === "atom" && anchor.objectId ? atomEndpoint(objects.get(anchor.objectId), anchor.atomId) : undefined;
      const nextSource = source && atomEndpoint(nextObjects.get(source.molecule.id), source.atom.id);
      // A keyboard nudge or small transform can reposition a mark beside its original atom.
      // Use the sticky association radius there, and the drag capture radius for a new target.
      if (nextSource && !withinAssociationRadius(nextSource, center)) {
        drops.push(planElectronMarkDrop(document, followed, mark, center, center));
        continue;
      }
      assignments ??= nativeElectronMarkAssignments(nextPage).anchorByMarkId;
      const assignment = assignments.get(mark.id);
      const sameAnchor = next.anchor.kind === anchor.kind && next.anchor.objectId === anchor.objectId && next.anchor.atomId === anchor.atomId;
      const reassigned = assignment?.objectId !== source?.molecule.id || assignment?.atomId !== source?.atom.id;
      if (reassigned || (source && !sameAnchor)) {
        // A free mark may end up beside an atom, or a kept mark beyond the legacy radius.
        // Make the existing association explicit in either case.
        preserve.push({ op: "updateObject", objectId: mark.id, changes: {
          anchor: source ? anchor : { kind: "point", point: center },
          atomAssociation: "explicit"
        } });
      }
    }
  }
  const prepared = preserve.length ? applyPatches(followed, preserve, { now: phase4Timestamp }) : followed;
  const result = drops.length ? applyElectronMarkDrops(document, prepared, drops) : { document: prepared };
  return { ...result, independentlyMovedMarkIds: independentMarkMoves(document, result.document, candidates, followedMarkIds) };
}

function applyElectronMarkDrops(
  document: ChemDraftDocument, moved: ChemDraftDocument, drops: readonly ElectronMarkDrop[]
): { document: ChemDraftDocument; status: string; refused?: boolean } {
  const refusal = (affected: readonly ElectronMarkDrop[], reason: string) => {
    const moves = new Set(affected.map(({ mark, source, destination }) =>
      `${electronMarkName(mark)}${source ? ` from ${source.atom.element}` : ""}${destination ? ` to ${destination.atom.element}` : ""}`));
    return { document, refused: true, status: `Cannot move ${[...moves].join(" and ")}: ${reason}` };
  };
  // Validate the actual associations, including any destination that normalization resolved.
  const anchorUpdates = drops.filter(drop => !drop.preserveAnchor).map(({ mark, anchor }) => ({
    op: "updateObject", objectId: mark.id, changes: { anchor, atomAssociation: "explicit" }
  } as const));
  let after = normalizeCommittedDocument(anchorUpdates.length ? applyPatches(moved, anchorUpdates, { now: phase4Timestamp }) : moved);
  const expected = new Map<string, { endpoint: AtomEndpoint; charge: number; radicals: number; drops: ElectronMarkDrop[] }>();
  for (const drop of drops) {
    const { mark, source } = drop;
    const destination = committedDropDestination(document, after, drop);
    if (drop.destination && !sameAtom(drop.destination, destination)) {
      return refusal([drop], "the atom cannot accept this mark's charge or unpaired electrons");
    }
    const contribution = electronMarkAtomContribution(mark);
    if (sameAtom(source, destination) || (!contribution.charge && !contribution.radicals)) continue;
    const resolvedDrop = { ...drop, destination };
    for (const [endpoint, sign] of [[source, -1], [destination, 1]] as const) {
      if (!endpoint) continue;
      const { molecule, atom } = endpoint;
      const key = nativeElectronMarkAtomKey(molecule.id, atom.id);
      let totals = expected.get(key);
      if (!totals) {
        totals = { endpoint, charge: atom.formalCharge, radicals: atom.markRadicals ?? 0, drops: [] };
        expected.set(key, totals);
      }
      totals.charge += sign * contribution.charge;
      totals.radicals += sign * contribution.radicals;
      totals.drops.push(resolvedDrop);
    }
  }

  // Check each affected atom once, using all attachments and detachments in the gesture.
  for (const { endpoint, charge, radicals, drops: affected } of expected.values()) {
    const final = findAtomEndpoint(after, { objectId: endpoint.molecule.id, atomId: endpoint.atom.id });
    if (!final || final.atom.formalCharge !== charge || (final.atom.markRadicals ?? 0) !== radicals) {
      return refusal(affected, "the atom associations could not preserve the existing charges or unpaired electrons");
    }
    const element = nativeElementFromAtomLabel(final.atom.element);
    const usage = nativeAtomExternalValence(final.molecule, final.atom);
    if (element && !nativeAtomChargeSupportsValence(element, usage, charge)) {
      return refusal(affected, `${final.atom.element} cannot carry formal charge ${charge > 0 ? "+" : ""}${charge} with bond/radical valence ${usage}`);
    }
  }

  // Snap direct transfers beside the reconciled label. Same-atom marks keep their offsets,
  // and empty-space drops keep the free position.
  for (const drop of drops) {
    if (drop.preserveAnchor || !drop.destination || sameAtom(drop.source, drop.destination)) continue;
    const markId = drop.mark.id;
    const finalMark = findDocumentObject(after, markId) as ElectronMarkObject;
    const finalDestination = associatedAtom(after, finalMark.anchor)!;
    const page = after.pages.find(page => page.objects.some(object => object.id === markId))!;
    const point = nativeChargePlacementPointForAtom(finalDestination.molecule, finalDestination.atom.id,
      page.objects.filter(object => object.id !== markId), page.width, page.height, finalMark);
    if (point) after = applyPatch(after, { op: "updateObject", objectId: markId,
      changes: { x: point.x - finalMark.width / 2, y: point.y - finalMark.height / 2 } }, { now: phase4Timestamp });
  }
  return { document: after, status: drops.map(drop => describeElectronMarkDrop(document, after, drop)).join(". ") };
}

function committedDropDestination(document: ChemDraftDocument, after: ChemDraftDocument, drop: ElectronMarkDrop): AtomEndpoint | undefined {
  const page = drop.preserveAnchor && after.pages.find(page => page.objects.some(object => object.id === drop.mark.id));
  if (page) return findAtomEndpoint(document, committedElectronMarkAssignments(page).anchorByMarkId.get(drop.mark.id));
  const finalMark = findDocumentObject(after, drop.mark.id) as ElectronMarkObject;
  return associatedAtom(document, finalMark.anchor);
}

function describeElectronMarkDrop(document: ChemDraftDocument, after: ChemDraftDocument, drop: ElectronMarkDrop): string {
  const { mark, source, destination } = drop;
  const name = electronMarkName(mark);
  const finalDestination = committedDropDestination(after, after, drop);
  const finalSource = source && findAtomEndpoint(after, { objectId: source.molecule.id, atomId: source.atom.id });
  const chemistryChanges = electronMarkChemistryChanges(document, after, { markIds: [mark.id],
    atoms: [source, finalDestination].flatMap(endpoint => endpoint
      ? [{ objectId: endpoint.molecule.id, atomId: endpoint.atom.id }] : []) });
  let sourceName = source?.atom.element;
  let destinationName = finalDestination?.atom.element;
  const contextNames = new Map<MoleculeAtom, string>();
  if (source && destination && finalDestination && !sameAtom(source, destination) && sourceName === destinationName) {
    const sourceContext = atomContextName(source), destinationContext = atomContextName(destination);
    if (sourceContext !== destinationContext) {
      sourceName = `${sourceName} (${sourceContext})`;
      destinationName = `${destinationName} (${destinationContext})`;
      if (finalSource) contextNames.set(finalSource.atom, sourceContext);
      contextNames.set(finalDestination.atom, destinationContext);
    }
  }
  const endpoints = [finalDestination, finalSource].flatMap(endpoint => endpoint ? [endpoint] : []);
  const changedAtoms = endpoints.filter((endpoint, index, endpoints) =>
    endpoints.findIndex(other => other?.molecule.id === endpoint.molecule.id && other?.atom.id === endpoint.atom.id) === index);
  const chemistry = chemistryChanges.length
    ? ` (${changedAtoms.map(endpoint => `${contextNames.get(endpoint.atom) ?? endpoint.atom.element} now ${label(endpoint)}`).join(", ")})` : "";
  // Status describes the committed associations and chemistry, including any change made by
  // normalization, rather than relying on the intended geometric transfer alone.
  if (finalDestination && !sameAtom(source, finalDestination)) {
    return source
      ? `${name} moved from ${sourceName} to ${destinationName}${chemistry}`
      : `${name} attached to ${finalDestination.atom.element}${chemistry}`;
  }
  if (source && !finalDestination) {
    return `${name} removed from ${source.atom.element}${chemistry}`;
  }
  return source
    ? `${name} repositioned on ${source.atom.element}${chemistry}`
    : `Moved electron mark${chemistry}`;
}
