import type { DocumentPage, ElectronMarkObject, MoleculeObject } from "@chemdraft/chem-core";
import { ElectronMarkPlacementIndex, nativeChargeMarkSizePx, nativeRadicalPlacementPointForAtom, transformPointForObject } from "@chemdraft/layout-engine";

/**
 * `markRadicals` is a mark contribution, never an intrinsic atom radical. Supply the same editable
 * handle the atom tool creates, or the desktop commit normalizer must remove it. Run after source
 * coordinate transforms so placement sees the final page and atom positions.
 *
 * The page's electron marks are indexed once (layout-engine's ElectronMarkPlacementIndex: marks by
 * the atom they are anchored to, charge and radical-dot centres in a grid), and the index grows with
 * each dot added, so the pass is linear in atoms plus marks. It used to filter the whole mark list
 * for every atom, and then score each dot's candidates against every charge mark on the page: a
 * crafted file of many atoms carrying marks cost (atoms x marks) before validation (Codex security
 * finding on #442). The index places every dot exactly where the whole page would.
 */
export function addImportedRadicalMarks(page: DocumentPage, warnings?: { code: string; message: string }[]): void {
  const marks = ElectronMarkPlacementIndex.of(page.objects);
  const ids = new Set<string>();
  const molecules: MoleculeObject[] = [];
  for (const object of page.objects) {
    ids.add(object.id);
    if (object.type === "molecule") molecules.push(object);
  }
  for (const molecule of molecules) {
    for (const atom of molecule.atoms) {
      const markRadicals = atom.markRadicals ?? 0;
      if (markRadicals <= 0) continue;
      const carried = marks.marksOnAtom(molecule.id, atom.id)
        .reduce((sum, mark) => sum + (mark.markKind === "radical-dot" || mark.markKind === "charge" && mark.radical ? 1 : 0), 0);
      const missing = markRadicals - carried;
      for (let index = 0; index < missing; index++) {
        const point = nativeRadicalPlacementPointForAtom(molecule, atom.id, marks, page.width, page.height)!;
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
        marks.add(mark);
      }
    }
  }
  if (marks.scoreCapHits > 0) warnings?.push({ code: "cdxml.radical_mark_placement_approximate",
    message: `${marks.scoreCapHits} electron mark placement${marks.scoreCapHits === 1 ? " was" : "s were"} approximate: more than 256 marks crowd one atom, so only the first 256 were scored by distance.` });
}
