import type { DocumentObject, DocumentPage, ElectronMarkObject } from "@chemdraft/chem-core";
import {
  ElectronMarkPlacementIndex, nativeChargeMarkSizePx, nativeChargePlacementPointForAtom, nativeRadicalPlacementPointForAtom,
  transformPointForObject
} from "@chemdraft/layout-engine";

/**
 * What isStandardAtomRadicalMark reads from a page, indexed once per export: it used to filter every
 * page object once per radical-dot mark (and hand placement the whole page, or a slice of it, each
 * time), so Save As of a crafted page of many dots cost (dots x objects); the session autosave runs
 * it right after a file opens.
 */
export interface StandardRadicalMarkPageIndex {
  /** Every object on the page; `before(position)` stands for `page.objects.slice(0, position)`. */
  marks: ElectronMarkPlacementIndex;
  /** The page without its non-charge electron marks: the legacy (charge-tool) slot's view. */
  charges: ElectronMarkPlacementIndex;
  /** Each object's first position in `page.objects` (what `indexOf` returned). */
  positions: ReadonlyMap<DocumentObject, number>;
  /** Radical dots and radical-ion charges anchored to each atom, by molecule id then atom id. */
  carried: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

/** Built once per page per export, on the page's first radical dot that needs it. */
export function standardRadicalMarkPageIndex(page: DocumentPage): StandardRadicalMarkPageIndex {
  const positions = new Map<DocumentObject, number>();
  const carried = new Map<string, Map<string, number>>();
  page.objects.forEach((object, position) => {
    if (!positions.has(object)) positions.set(object, position);
    if (object.type !== "electron-mark" || object.anchor.kind !== "atom" || object.anchor.objectId === undefined
      || object.anchor.atomId === undefined || !(object.markKind === "radical-dot" || object.markKind === "charge" && object.radical)) return;
    let byAtom = carried.get(object.anchor.objectId);
    if (!byAtom) carried.set(object.anchor.objectId, byAtom = new Map());
    byAtom.set(object.anchor.atomId, (byAtom.get(object.anchor.atomId) ?? 0) + 1);
  });
  return {
    marks: ElectronMarkPlacementIndex.of(page.objects),
    charges: ElectronMarkPlacementIndex.of(page.objects.filter(object => object.type !== "electron-mark" || object.markKind === "charge")),
    positions,
    carried
  };
}

/** Default atom-tool dots carry the Radical attribute written on the atom, not separate
 * authored appearance. A moved or styled dot still needs the ordinary loss diagnostics.
 * `pageIndex` returns the page's index (standardRadicalMarkPageIndex), built once and shared by
 * every dot on the page. */
export function isStandardAtomRadicalMark(
  mark: ElectronMarkObject,
  page: DocumentPage,
  objectsById: ReadonlyMap<string, DocumentObject>,
  pageIndex: () => StandardRadicalMarkPageIndex
): boolean {
  if (mark.markKind !== "radical-dot" || mark.anchor.kind !== "atom"
      || mark.style.source !== "chemdraft-native-charge"
      || Object.entries(mark.style).some(([key, value]) => key !== "source" && value !== undefined)
      || mark.width !== nativeChargeMarkSizePx || mark.height !== nativeChargeMarkSizePx || mark.rotation !== 0) return false;
  const { objectId, atomId } = mark.anchor;
  const molecule = objectId && objectsById.get(objectId);
  if (!molecule || molecule.type !== "molecule") return false;
  const atom = molecule.atoms.find(atom => atom.id === atomId);
  if (!atom) return false;
  // Source handles follow direct edits to the atom's radical state, including its removal.
  // Compare the current atom-relative frame: a stationary dot must not stay exempt when
  // its atom moves away, while translating both together preserves the imported appearance.
  const imported = mark.compatibility?.unknown.cdxmlRadicalMarkPlacement;
  if (isRecord(imported)) {
    if (imported.objectId !== objectId || imported.atomId !== atomId) return false;
    if (typeof imported.offsetX === "number" && typeof imported.offsetY === "number") {
      const atomPoint = transformPointForObject(molecule, atom);
      return Math.abs(mark.x - atomPoint.x - imported.offsetX) < 1e-8
        && Math.abs(mark.y - atomPoint.y - imported.offsetY) < 1e-8;
    }
    // Older native payloads lack relative coordinates: require the current default below.
  }
  if (!isRecord(imported) && atom.markRadicals !== 1 && atom.markRadicals !== 2) return false;
  const index = pageIndex();
  const carried = index.carried.get(molecule.id)?.get(atom.id) ?? 0;
  if (!isRecord(imported) && carried !== atom.markRadicals) return false;
  // Legacy imports placed both triplet dots in the charge-tool slot. Keep those untouched
  // payloads warning-free too, but only while that slot still matches the atom's position.
  const point = isRecord(imported)
    // Reconstruct the legacy slot before mixed-mark collision avoidance existed.
    ? nativeChargePlacementPointForAtom(molecule, atom.id, index.charges, page.width, page.height)
    // The marks before this one (an object not on the page sees all but the last, as slice(0, -1) did).
    : nativeRadicalPlacementPointForAtom(molecule, atom.id,
      index.marks.before(index.positions.get(mark) ?? page.objects.length - 1), page.width, page.height);
  if (!point) return false;
  const size = nativeChargeMarkSizePx;
  const x = Math.max(0, Math.min(point.x - size / 2, page.width - size));
  const y = Math.max(0, Math.min(point.y - size / 2, page.height - size));
  return Math.abs(mark.x - x) < 1e-8 && Math.abs(mark.y - y) < 1e-8;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
