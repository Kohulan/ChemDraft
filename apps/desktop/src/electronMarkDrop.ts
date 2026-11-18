import { applyPatch, applyPatches, nativeDrawingStyleFromObjectStyle,
  type ChemDraftDocument, type DocumentObject, type DocumentPatch, type ElectronMarkObject, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import { atomDisplayLabel, transformPointForObject } from "@chemdraft/layout-engine";
import { documentDrawingDefaults, nativeAtomChargeSupportsValence, nativeAtomExternalValence, nativeChargeAssociationRadiusPx,
  nativeElectronMarkAssignments, nativeElectronMarkAtomKey, nativeElementFromAtomLabel, phase4Timestamp, type PagePoint } from "@chemdraft/document-workflow-core";
import { electronMarkAtomContribution, electronMarkChemistryChanges, findDocumentObject,
  isEditableNativeMoleculeGraph, moveDocumentObject, moveDocumentObjects, nativeChargeMarkCenter,
  nativeChargePlacementPointForAtom, normalizeCommittedDocument, resolveGroupedDocumentObjectIds, type NativeMoleculeDeleteTarget } from "./documentWorkflow";

/** Document-space radius, independent of zoom and of the direct-editing preference. */
export const ELECTRON_MARK_DROP_CAPTURE_BOND_LENGTHS = 0.5;

/** Geometric target shared by the drag highlight and the committed drop, including refused targets. */
export function electronMarkDropTarget(
  document: ChemDraftDocument, point: PagePoint, pageId = document.pages[0]?.id
): NativeMoleculeDeleteTarget | undefined {
  const radius = documentDrawingDefaults(document).bondLengthPx * ELECTRON_MARK_DROP_CAPTURE_BOND_LENGTHS;
  let nearest: NativeMoleculeDeleteTarget | undefined;
  for (const object of document.pages.find(page => page.id === pageId)?.objects ?? []) {
    if (object.type !== "molecule" || !isEditableNativeMoleculeGraph(object)) continue;
    // Atom coordinates precede the molecule's SVG rotation. Invert that same frame transform
    // for both preview and commit, so the target is the atom drawn under the pointer.
    const localPoint = transformPointForObject({ ...object, rotation: -object.rotation }, point);
    for (const atom of object.atoms) {
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
  const molecule = anchor.kind === "atom" && anchor.objectId ? findDocumentObject(document, anchor.objectId) : undefined;
  return atomEndpoint(molecule, anchor.atomId);
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

function markName(mark: ElectronMarkObject): string {
  return mark.markKind === "charge" ? (mark.radical ? "Radical ion" : "Charge")
    : mark.markKind === "radical-dot" ? "Radical electron"
    : mark.markKind === "lone-pair" ? "Lone pair" : "Electron mark";
}

export interface ElectronMarkDropResult {
  document: ChemDraftDocument;
  status: string;
  undoLabel: string;
  refused?: boolean;
}

interface ElectronMarkDrop {
  mark: ElectronMarkObject;
  anchor: ElectronMarkObject["anchor"];
  source: AtomEndpoint | undefined;
  destination: AtomEndpoint | undefined;
}

function sameAtom(first: AtomEndpoint | undefined, second: AtomEndpoint | undefined): boolean {
  return first?.molecule.id === second?.molecule.id && first?.atom.id === second?.atom.id;
}

function planElectronMarkDrop(
  before: ChemDraftDocument, moved: ChemDraftDocument, mark: ElectronMarkObject, center: PagePoint, dropPoint: PagePoint
): ElectronMarkDrop {
  const pageId = before.pages.find(page => page.objects.some(object => object.id === mark.id))?.id;
  const target = electronMarkDropTarget(moved, dropPoint, pageId);
  const anchor: ElectronMarkObject["anchor"] = target?.kind === "atom"
    ? { kind: "atom", objectId: target.objectId, atomId: target.atomId }
    : { kind: "point", point: center };
  return { mark, anchor, source: associatedAtom(before, mark.anchor), destination: associatedAtom(before, anchor) };
}

/** A direct drop uses the pointer for atom capture and the translated mark center for a free annotation. */
export function dropElectronMark(
  document: ChemDraftDocument, markId: string, position: PagePoint, dropPoint: PagePoint
): ElectronMarkDropResult {
  const mark = findDocumentObject(document, markId);
  if (mark?.type !== "electron-mark") return { document, status: "Electron mark no longer exists", undoLabel: "Move electron mark" };
  const center = { x: position.x + mark.width / 2, y: position.y + mark.height / 2 };
  const drop = planElectronMarkDrop(document, document, mark, center, dropPoint);
  const moved = moveDocumentObject(document, markId, position);
  const result = applyElectronMarkDrops(document, moved, [drop]);
  return { ...result, undoLabel: drop.source || drop.destination ? `Move ${markName(mark)}` : "Move electron mark" };
}

/** Validate independent marks against the selection's final geometry and commit the move as a unit. */
export function dropElectronMarksInSelection(
  document: ChemDraftDocument, objectIds: readonly string[], delta: PagePoint,
  release: { grabbedObjectId: string; point: PagePoint }
): { document: ChemDraftDocument; status?: string } {
  const moved = moveDocumentObjects(document, objectIds, delta.x, delta.y, { preserveCarriedMarkAnchors: true });
  if (moved === document) return { document };

  const page = document.pages.find(page => page.objects.some(object => object.id === release.grabbedObjectId));
  const selectedIds = new Set(resolveGroupedDocumentObjectIds(page?.objects ?? [], objectIds));
  const drops = (page?.objects ?? []).flatMap((mark) => {
    if (mark.type !== "electron-mark" || !selectedIds.has(mark.id)) return [];
    const source = associatedAtom(document, mark.anchor);
    if (source && selectedIds.has(source.molecule.id)) return [];
    const translated = findDocumentObject(moved, mark.id);
    if (translated?.type !== "electron-mark") return [];
    const center = nativeChargeMarkCenter(translated);
    return [planElectronMarkDrop(document, moved, mark, center, mark.id === release.grabbedObjectId ? release.point : center)];
  });
  return drops.length ? applyElectronMarkDrops(document, moved, drops) : { document: moved };
}

/** Preserve carried marks and admit independent detachments/transfers as one selection edit. */
export function resolveElectronMarksInSelectionTransform(
  document: ChemDraftDocument, transformed: ChemDraftDocument
): { document: ChemDraftDocument; status?: string; refused?: boolean } {
  if (transformed === document) return { document };
  const drops: ElectronMarkDrop[] = [];
  const preserve: DocumentPatch[] = [];
  for (const page of document.pages) {
    const nextPage = transformed.pages.find(candidate => candidate.id === page.id);
    if (!nextPage || nextPage.objects === page.objects) continue;
    const marks = page.objects.filter(object => object.type === "electron-mark");
    if (!marks.length) continue;
    const objects = new Map(page.objects.map(object => [object.id, object]));
    const nextObjects = new Map(nextPage.objects.map(object => [object.id, object]));
    const assignments = nativeElectronMarkAssignments(nextPage).anchorByMarkId;
    for (const mark of marks) {
      const next = nextObjects.get(mark.id);
      if (next?.type !== "electron-mark") continue;
      const anchor = mark.anchor;
      const source = anchor.kind === "atom" && anchor.objectId ? atomEndpoint(objects.get(anchor.objectId), anchor.atomId) : undefined;
      const nextSource = source && atomEndpoint(nextObjects.get(source.molecule.id), source.atom.id);
      const sameAnchor = next.anchor.kind === anchor.kind && next.anchor.objectId === anchor.objectId && next.anchor.atomId === anchor.atomId;
      const carried = source && nextSource && nextSource.molecule !== source.molecule && sameAnchor;
      const center = nativeChargeMarkCenter(next);
      const previousCenter = nativeChargeMarkCenter(mark);
      const moved = Math.hypot(center.x - previousCenter.x, center.y - previousCenter.y) > 1e-6;
      if (carried && next === mark) {
        // Atom-part transforms can move the atom without emitting a patch for its mark.
        const from = transformPointForObject(source.molecule, source.atom);
        const to = transformPointForObject(nextSource.molecule, nextSource.atom);
        const dx = to.x - from.x, dy = to.y - from.y;
        if (Math.hypot(dx, dy) > 1e-6) {
          preserve.push({ op: "updateObject", objectId: mark.id, changes: {
            x: mark.x + dx, y: mark.y + dy, atomAssociation: "explicit"
          } });
          continue;
        }
      }
      if (nextSource && moved && !carried) {
        // A keyboard nudge or small transform can reposition a mark beside its original atom.
        // Use the sticky association radius there, and the drag capture radius for a new target.
        const atomPoint = transformPointForObject(nextSource.molecule, nextSource.atom);
        const radius = Math.max(nativeChargeAssociationRadiusPx, nativeDrawingStyleFromObjectStyle(nextSource.molecule.style).bondLengthPx * 1.15);
        if (Math.hypot(center.x - atomPoint.x, center.y - atomPoint.y) > radius) {
          drops.push(planElectronMarkDrop(document, transformed, mark, center, center));
          continue;
        }
      }

      const assignment = assignments.get(mark.id);
      const reassigned = assignment?.objectId !== source?.molecule.id || assignment?.atomId !== source?.atom.id;
      if (reassigned || (source && !sameAnchor)) {
        // A carried mark may be outside the legacy radius after scaling. A floating mark
        // may end up beside an atom. Make the existing association explicit in either case.
        preserve.push({ op: "updateObject", objectId: mark.id, changes: {
          anchor: source ? anchor : { kind: "point", point: center },
          atomAssociation: "explicit"
        } });
      }
    }
  }
  const prepared = preserve.length ? applyPatches(transformed, preserve, { now: phase4Timestamp }) : transformed;
  return drops.length ? applyElectronMarkDrops(document, prepared, drops) : { document: prepared };
}

function applyElectronMarkDrops(
  document: ChemDraftDocument, moved: ChemDraftDocument, drops: readonly ElectronMarkDrop[]
): { document: ChemDraftDocument; status: string; refused?: boolean } {
  const refusal = ({ mark, source, destination }: ElectronMarkDrop, reason: string) => ({ document, refused: true,
    status: `Cannot move ${markName(mark)}${source ? ` from ${source.atom.element}` : ""}${destination ? ` to ${destination.atom.element}` : ""}: ${reason}` });
  const expected = new Map<string, { endpoint: AtomEndpoint; charge: number; radicals: number; drop: ElectronMarkDrop }>();
  for (const drop of drops) {
    const { mark, source, destination } = drop;
    const contribution = electronMarkAtomContribution(mark);
    if (sameAtom(source, destination) || (!contribution.charge && !contribution.radicals)) continue;
    // Use the same admission rule as typed charge stacking, including the radical bonding slots.
    // Check removal too: a four-bond N cannot lose its +1 without an explicit bond edit.
    for (const [endpoint, sign] of [[source, -1], [destination, 1]] as const) {
      if (!endpoint) continue;
      const { molecule, atom } = endpoint;
      const element = nativeElementFromAtomLabel(atom.element);
      const charge = atom.formalCharge + sign * contribution.charge;
      const usage = nativeAtomExternalValence(molecule, atom) + sign * contribution.radicals;
      if (element && !nativeAtomChargeSupportsValence(element, usage, charge)) {
        return refusal(drop, `${atom.element} cannot carry formal charge ${charge > 0 ? "+" : ""}${charge} with bond/radical valence ${usage}`);
      }
      const key = nativeElectronMarkAtomKey(molecule.id, atom.id);
      const previous = expected.get(key);
      expected.set(key, { endpoint, drop,
        charge: (previous?.charge ?? atom.formalCharge) + sign * contribution.charge,
        radicals: (previous?.radicals ?? atom.markRadicals ?? 0) + sign * contribution.radicals });
    }
  }

  // Install all explicit drop decisions before reconciliation sees any of the translated marks.
  let after = normalizeCommittedDocument(applyPatches(moved, drops.map(({ mark, anchor }) => ({
    op: "updateObject", objectId: mark.id, changes: { anchor, atomAssociation: "explicit" }
  })), { now: phase4Timestamp }));
  // Verify requested atom drops. For drops without a target, report the association
  // reconciliation actually made, including changes outside the pointer capture radius.
  for (const drop of drops) {
    if (!drop.destination) continue;
    const finalMark = findDocumentObject(after, drop.mark.id) as ElectronMarkObject;
    if (!sameAtom(drop.destination, associatedAtom(after, finalMark.anchor))) {
      return refusal(drop, "the atom cannot accept this mark's charge or unpaired electrons");
    }
  }
  // Two individually valid drops can exceed the same atom's capacity together.
  for (const { endpoint, charge, radicals, drop } of expected.values()) {
    const final = associatedAtom(after, { kind: "atom", objectId: endpoint.molecule.id, atomId: endpoint.atom.id });
    if (!final || final.atom.formalCharge !== charge || (final.atom.markRadicals ?? 0) !== radicals) {
      return refusal(drop, "the atom associations could not preserve the existing charges or unpaired electrons");
    }
    const element = nativeElementFromAtomLabel(final.atom.element);
    if (element && !nativeAtomChargeSupportsValence(element, nativeAtomExternalValence(final.molecule, final.atom), final.atom.formalCharge)) {
      return refusal(drop, `${final.atom.element} has unsupported valence after moving this mark`);
    }
  }

  // Only an actual atom drop snaps beside its label. Empty-space drops retain the user's
  // position as free annotations. Use reconciled chemistry so OH/NH2 includes the new H.
  for (const drop of drops) {
    if (!drop.destination) continue;
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

function describeElectronMarkDrop(document: ChemDraftDocument, after: ChemDraftDocument, { mark, source, destination }: ElectronMarkDrop): string {
  const name = markName(mark);
  const markId = mark.id;
  const finalMark = findDocumentObject(after, markId) as ElectronMarkObject;
  const finalDestination = associatedAtom(after, finalMark.anchor);
  const anchors = [mark.anchor, finalMark.anchor];
  const chemistryChanges = electronMarkChemistryChanges(document, after, { markIds: [markId], atoms: anchors.flatMap(anchor =>
    anchor.kind === "atom" && anchor.objectId && anchor.atomId ? [{ objectId: anchor.objectId, atomId: anchor.atomId }] : []) });
  const finalSource = source && associatedAtom(after, mark.anchor);
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
