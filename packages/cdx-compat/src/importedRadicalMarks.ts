import type { DocumentPage, ElectronMarkObject, MoleculeObject } from "@chemdraft/chem-core";
import { nativeChargeMarkSizePx, nativeRadicalPlacementPointForAtom, transformPointForObject } from "@chemdraft/layout-engine";

/**
 * `markRadicals` is a mark contribution, never an intrinsic atom radical. Supply the same editable
 * handle the atom tool creates, or the desktop commit normalizer must remove it. Run after source
 * coordinate transforms so placement sees the final page and atom positions.
 *
 * The page's electron marks are indexed once by the atom they are anchored to, so the pass is linear
 * in atoms plus marks. It used to filter the whole mark list for every atom, and a crafted file of
 * many lone-pair symbols and many atoms cost (atoms x marks) checks before validation (Codex
 * security finding on #442). Placement is handed only the marks it reads (see `placementObjects`),
 * not every object on the page.
 */
export function addImportedRadicalMarks(page: DocumentPage): void {
  // Marks anchored to an atom, by molecule id then atom id.
  const marksByAtom = new Map<string, Map<string, ElectronMarkObject[]>>();
  // Charge and radical-dot marks in page order: the only marks placement scores against.
  const scoringMarks: ElectronMarkObject[] = [];
  const charges: ElectronMarkObject[] = [];
  const marksOnAtom = (objectId: string, atomId: string) => marksByAtom.get(objectId)?.get(atomId);
  const indexMark = (mark: ElectronMarkObject) => {
    if (mark.markKind === "charge") { charges.push(mark); scoringMarks.push(mark); }
    else if (mark.markKind === "radical-dot") scoringMarks.push(mark);
    // An atom anchor missing either id matches no atom (the whole-page filter compared them too).
    if (mark.anchor.kind !== "atom" || mark.anchor.objectId === undefined || mark.anchor.atomId === undefined) return;
    const { objectId, atomId } = mark.anchor;
    let byAtom = marksByAtom.get(objectId);
    if (!byAtom) marksByAtom.set(objectId, byAtom = new Map());
    const list = byAtom.get(atomId);
    if (list) list.push(mark);
    else byAtom.set(atomId, [mark]);
  };
  const ids = new Set<string>();
  const molecules: MoleculeObject[] = [];
  for (const object of page.objects) {
    ids.add(object.id);
    if (object.type === "electron-mark") indexMark(object);
    else if (object.type === "molecule") molecules.push(object);
  }
  for (const molecule of molecules) {
    for (const atom of molecule.atoms) {
      const markRadicals = atom.markRadicals ?? 0;
      if (markRadicals <= 0) continue;
      const carried = (marksOnAtom(molecule.id, atom.id) ?? [])
        .reduce((sum, mark) => sum + (mark.markKind === "radical-dot" || mark.markKind === "charge" && mark.radical ? 1 : 0), 0);
      const missing = markRadicals - carried;
      for (let index = 0; index < missing; index++) {
        const point = nativeRadicalPlacementPointForAtom(molecule, atom.id,
          placementObjects(marksOnAtom(molecule.id, atom.id), scoringMarks, charges), page.width, page.height)!;
        const size = nativeChargeMarkSizePx;
        const baseId = `${molecule.id}_${atom.id}_radical_${index + 1}`;
        let id = baseId;
        while (ids.has(id)) id += "_";
        ids.add(id);
        const mark: ElectronMarkObject = {
          id, type: "electron-mark", markKind: "radical-dot",
          x: Math.max(0, Math.min(point.x - size / 2, page.width - size)),
          y: Math.max(0, Math.min(point.y - size / 2, page.height - size)),
          width: size, height: size, rotation: 0, style: { source: "chemdraft-native-charge" },
          anchor: { kind: "atom", objectId: molecule.id, atomId: atom.id },
          atomAssociation: "explicit"
        };
        const atomPoint = transformPointForObject(molecule, atom);
        mark.compatibility = { warnings: [], unknown: { cdxmlRadicalMarkPlacement: {
          x: mark.x, y: mark.y, offsetX: mark.x - atomPoint.x, offsetY: mark.y - atomPoint.y,
          objectId: molecule.id, atomId: atom.id
        } } };
        page.objects.push(mark);
        indexMark(mark);
      }
    }
  }
}

/**
 * The objects nativeRadicalPlacementPointForAtom reads, out of the whole page: whether any mark sits
 * on the atom, the frames of the marks on it, and the centres of charge marks (on an occupied atom,
 * of radical dots too), in page order. Every other object is skipped by its type or anchor, so
 * leaving it out places the mark exactly where the whole page would.
 */
function placementObjects(
  onAtom: readonly ElectronMarkObject[] | undefined,
  scoringMarks: readonly ElectronMarkObject[],
  charges: readonly ElectronMarkObject[]
): readonly ElectronMarkObject[] {
  if (!onAtom?.length) return charges;
  return [...scoringMarks, ...onAtom.filter(mark => mark.markKind !== "charge" && mark.markKind !== "radical-dot")];
}
