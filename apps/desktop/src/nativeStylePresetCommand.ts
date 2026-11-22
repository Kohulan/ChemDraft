import { applyPatches, nativeDrawingStyleFromObjectStyle, type ChemDraftDocument, type CompatibilityWarning,
  type DocumentPatch, type ElectronMarkObject } from "@chemdraft/chem-core";
import { applyNativeStylePreset, nativeChargeAssociationRadiusPx, nativeElectronMarkAssignments } from "@chemdraft/document-workflow-core";
import { electronMarkCentreClearOfAtomLabel, moleculeLayoutLabelBoxes } from "@chemdraft/layout-engine";

/** Adapt the desktop's fragment selection to the shared molecule/text style scope. */
export function nativeStylePresetPatchForSelection(
  document: ChemDraftDocument, presetId: string, fragmentObjectIds: readonly string[],
  warnings: CompatibilityWarning[] = []
) {
  const objectIds = [...new Set([...document.selection.objectIds, ...fragmentObjectIds])];
  const scoped = fragmentObjectIds.length
    ? { ...document, selection: { ...document.selection, objectIds } } : document;
  const patch = applyNativeStylePreset(scoped, presetId, objectIds.length ? "selection" : "document", warnings);
  // The planner sees fragment hosts as selected. If all hosts changed it need not emit selection,
  // but the original document may have an empty object-ID selection (a lassoed fragment).
  if (scoped !== document && patch.patches.length && !patch.patches.some(leaf => leaf.op === "setSelection")) {
    patch.patches.push({ op: "setSelection", pageId: document.selection.pageId, objectIds });
  }
  patch.patches = clearScaledElectronMarksOfLabels(document, patch.patches);
  return patch;
}

/**
 * A style change that scales a molecule scales each mark's offset from its atom with the bonds, but
 * not the atom label, so a shorter bond (ACS 1996, say) can put a + right on its N's label and bond.
 * Keep each moved mark's direction from its atom and, where its frame would now overlap the label
 * box, push it out along that direction just far enough to clear the box (the geometry is
 * `electronMarkCentreClearOfAtomLabel` in layout-engine, rotated marks included). A mark already
 * clear stays where the scaling put it. A style change never changes chemistry, so the push stops short of the
 * atom's association radius, and a push that would still hand any mark to another owner is dropped.
 */
export function clearScaledElectronMarksOfLabels(
  document: ChemDraftDocument, patches: DocumentPatch[]
): DocumentPatch[] {
  const movedMarkPatches = patches.filter((leaf): leaf is Extract<DocumentPatch, { op: "updateObject" }> =>
    leaf.op === "updateObject" && (leaf.changes as Partial<ElectronMarkObject>).anchor?.kind === "atom");
  if (!movedMarkPatches.length) return patches;
  const proposed = applyPatches(document, patches);
  const objects = new Map(proposed.pages.flatMap(page => page.objects.map(object => [object.id, object] as const)));
  const corrections = new Map<DocumentPatch, DocumentPatch>();
  const labelBoxesByMolecule = new Map<string, ReturnType<typeof moleculeLayoutLabelBoxes>>();
  for (const leaf of movedMarkPatches) {
    const mark = objects.get(leaf.objectId);
    if (mark?.type !== "electron-mark" || mark.anchor.kind !== "atom" || !mark.anchor.objectId) continue;
    const molecule = objects.get(mark.anchor.objectId);
    if (molecule?.type !== "molecule") continue;
    const atomId = (mark.anchor as { atomId?: string }).atomId;
    if (!atomId || !molecule.atoms.some(atom => atom.id === atomId)) continue;
    let boxes = labelBoxesByMolecule.get(molecule.id);
    if (!boxes) labelBoxesByMolecule.set(molecule.id, boxes = moleculeLayoutLabelBoxes(molecule));
    const radius = Math.max(nativeChargeAssociationRadiusPx,
      nativeDrawingStyleFromObjectStyle(molecule.style).bondLengthPx * 1.15) * 0.95;
    const cleared = electronMarkCentreClearOfAtomLabel(molecule, atomId, mark, radius, { labelBoxes: boxes });
    if (!cleared) continue;
    corrections.set(leaf, { ...leaf, changes: { ...leaf.changes,
      x: cleared.x - mark.width / 2, y: cleared.y - mark.height / 2 } });
  }
  if (!corrections.size) return patches;
  // Owners as the scaled document assigns them; a correction must leave every one in place.
  const owners = (candidate: ChemDraftDocument) => new Map(candidate.pages.flatMap(page =>
    [...nativeElectronMarkAssignments(page).anchorByMarkId].map(([id, owner]) => [id, JSON.stringify(owner ?? null)] as const)));
  const expected = owners(proposed);
  const corrected = patches.map(leaf => corrections.get(leaf) ?? leaf);
  const actual = owners(applyPatches(document, corrected));
  const unchanged = [...expected].every(([id, owner]) => actual.get(id) === owner);
  return unchanged ? corrected : patches;
}
