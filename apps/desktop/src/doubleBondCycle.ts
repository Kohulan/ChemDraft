import type { ChemDraftDocument, MoleculeBond, MoleculeObject } from "@chemdraft/chem-core";
import { isEditableNativeMoleculeGraph } from "@chemdraft/document-workflow-core";
import { renderedDoubleBondSide } from "@chemdraft/layout-engine";
import { applyMoleculeDoubleBondPosition, type NativeBondOrderTarget } from "./documentWorkflow";

/** The explicit stroke positions a repeated 2 press or Double Bond tool click steps through. */
export type DoubleBondCyclePosition = "left" | "center" | "right";

export const doubleBondCycleOrder: readonly DoubleBondCyclePosition[] = ["left", "center", "right"];

export interface DoubleBondCycleResult {
  document: ChemDraftDocument;
  position: DoubleBondCyclePosition;
  /** One history entry per step, worded like the inspector's Double-bond position action. */
  undoLabel: string;
}

/** left -> center -> right -> left. */
export function nextDoubleBondCyclePosition(current: DoubleBondCyclePosition): DoubleBondCyclePosition {
  return doubleBondCycleOrder[(doubleBondCycleOrder.indexOf(current) + 1) % doubleBondCycleOrder.length];
}

function cycleTargetBond(document: ChemDraftDocument, target: Pick<NativeBondOrderTarget, "objectId" | "bondId">):
  { molecule: MoleculeObject; bond: MoleculeBond } | undefined {
  const molecule = document.pages[0]?.objects.find((object): object is MoleculeObject =>
    object.type === "molecule" && object.id === target.objectId);
  const bond = molecule?.bonds.find(candidate => candidate.id === target.bondId);
  // A crossed (E/Z unspecified) double keeps its existing "2 again" behaviour: it is made plain.
  if (!molecule || !bond || bond.order !== "double" || bond.stereo !== undefined) return undefined;
  return isEditableNativeMoleculeGraph(molecule) ? { molecule, bond } : undefined;
}

/** Whether pressing 2 / clicking with the Double Bond tool should cycle this bond's stroke
 * position instead of changing its order. Only plain native double bonds cycle. */
export function isDoubleBondCycleTarget(
  document: ChemDraftDocument, target: Pick<NativeBondOrderTarget, "objectId" | "bondId">
): boolean {
  return cycleTargetBond(document, target) !== undefined;
}

/**
 * Move a double bond's second stroke to the next position after the one currently drawn.
 * Display-only: order, atoms, coordinates and stereo are untouched. A ring offset is stored as
 * the user's choice (`doubleBondSideSource: "user"`), so Clean Up and ring redraws keep it.
 * Returns undefined when the bond does not cycle, leaving callers' existing behaviour in place.
 */
export function cycleNativeDoubleBondPosition(
  document: ChemDraftDocument, target: Pick<NativeBondOrderTarget, "objectId" | "bondId">
): DoubleBondCycleResult | undefined {
  const found = cycleTargetBond(document, target);
  if (!found) return undefined;
  const current = renderedDoubleBondSide(found.molecule, found.bond);
  if (!current) return undefined;
  const position = nextDoubleBondCyclePosition(current);
  const next = applyMoleculeDoubleBondPosition(document, [{ objectId: target.objectId, bondId: target.bondId }], position);
  if (next === document) return undefined;
  return { document: next, position, undoLabel: `Double-bond position: ${position}` };
}

/**
 * The shared decision for both gestures, the hover key 2 (`bond.setHoveredBondOrder.double`)
 * and a click with the Double Bond tool: when the requested plain double meets a plain double,
 * the gesture cycles the stroke position. Anything else returns undefined and keeps the existing
 * bond-order path (single -> double, 3 -> triple, the E/Z-unspecified tool, crossed doubles).
 * No platform branch: the same key and click reach this on macOS and Windows.
 */
export function doubleBondGestureCycle(
  document: ChemDraftDocument,
  target: Pick<NativeBondOrderTarget, "objectId" | "bondId">,
  order: MoleculeBond["order"],
  stereo?: "either"
): DoubleBondCycleResult | undefined {
  if (order !== "double" || stereo !== undefined) return undefined;
  return cycleNativeDoubleBondPosition(document, target);
}
