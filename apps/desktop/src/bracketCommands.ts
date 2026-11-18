import { applyPatches, bracketPairs, bracketPairUsage, isRepeatUnitBoundaryBond, resolveRepeatUnitAtomMembership,
  type BracketObject, type ChemDraftDocument } from "@chemdraft/chem-core";
import { transformPointForObject } from "@chemdraft/layout-engine";
import type { CommandSpec } from "./commands";
import { nativeBracketPairForDrag } from "./documentWorkflow";
import { toSelectionItemsMulti, type NativeMoleculePartSelection } from "./selection/selectionPolicy";

const membershipOptions = { atomPosition: transformPointForObject };

export function selectedBracketPair(document: ChemDraftDocument): BracketObject[] {
  const page = document.pages.find(page => page.id === document.selection.pageId) ?? document.pages[0];
  const objects = page.objects;
  const selected = objects.filter(object => document.selection.objectIds.includes(object.id));
  if (!selected.length || selected.some(object => object.type !== "bracket")) return [];
  const first = selected[0] as BracketObject;
  if (!first.pairId || selected.some(object => object.type !== "bracket" || object.pairId !== first.pairId)) return [];
  return bracketPairs(objects).get(first.pairId) ?? [];
}

function prepareAtomRepeatUnit(document: ChemDraftDocument, parts: readonly NativeMoleculePartSelection[]):
  { pageId: string; pair: [BracketObject, BracketObject] } | { reason: string } {
  const page = document.pages.find(page => page.id === document.selection.pageId) ?? document.pages[0];
  const items = toSelectionItemsMulti(document.selection.objectIds, parts);
  if (items.some(item => item.kind === "object" || item.kind === "ring")) {
    return { reason: "Select atoms and optionally bonds only. Deselect whole objects and rings first." };
  }
  const atomItems = items.filter(item => item.kind === "atom");
  if (!atomItems.length) return { reason: "Select a bracket pair or atoms from one molecule." };
  const { objectId } = atomItems[0];
  if (items.some(item => item.objectId !== objectId)) return { reason: "Select atoms and bonds from a single molecule." };
  const molecule = page.objects.find(object => object.id === objectId);
  if (molecule?.type !== "molecule") return { reason: "The selected molecule is no longer on this page." };
  const atomIds = new Set(atomItems.map(item => item.atomId));
  const atoms = molecule.atoms.filter(atom => atomIds.has(atom.id));
  if (atoms.length !== atomIds.size) return { reason: "Some selected atoms are no longer in the molecule." };
  if ([...bracketPairs(page.objects).values()].some(pair => bracketPairUsage(pair) === "sru" &&
    resolveRepeatUnitAtomMembership(pair, page.objects, membershipOptions).members.some(member =>
      member.molecule === molecule && member.atomIds.some(id => atomIds.has(id))))) {
    return { reason: "Some selected atoms are already inside a repeat unit." };
  }
  if (!molecule.bonds.some(bond => isRepeatUnitBoundaryBond(bond, atomIds))) {
    return { reason: "The selected atoms have no crossing bonds to unselected atoms." };
  }

  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const atom of atoms) {
    const { x, y } = transformPointForObject(molecule, atom);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  // Allow clearance for the glyphs, reducing it when an unselected atom sits just outside the box.
  let padding = 8;
  for (const object of page.objects) {
    if (object.type !== "molecule") continue;
    for (const atom of object.atoms) {
      if (object === molecule && atomIds.has(atom.id)) continue;
      const { x, y } = transformPointForObject(object, atom);
      const gap = Math.max(left - x, x - right, top - y, y - bottom);
      padding = Math.min(padding, gap / 2);
    }
  }
  const enclosureReason = "A rectangular bracket pair around the selected atoms would also enclose unselected atoms.";
  if (padding <= 0) return { reason: enclosureReason };
  const pair = nativeBracketPairForDrag(document, page,
    { x: left - padding, y: top - padding }, "square", { x: right + padding, y: bottom + padding });
  const membership = resolveRepeatUnitAtomMembership(pair, page.objects, membershipOptions);
  if (membership.members.length !== 1 || membership.members[0].molecule !== molecule ||
    membership.members[0].atomIds.length !== atomIds.size || membership.members[0].atomIds.some(id => !atomIds.has(id))) {
    return { reason: enclosureReason };
  }
  if (membership.reason) return { reason: `The proposed bracket pair cannot be marked because ${membership.reason}.` };
  return { pageId: page.id, pair };
}

export function createBracketCommands(document: ChemDraftDocument, parts: readonly NativeMoleculePartSelection[] = []): CommandSpec[] {
  const pair = parts.length ? [] : selectedBracketPair(document);
  const repeat = bracketPairUsage(pair) !== "generic";
  const labelEditable = pair.some(object => object.repeatUnit || object.bracketKind === "polymer" || object.bracketUsage === "sru");
  const atomTarget = pair.length ? undefined : prepareAtomRepeatUnit(document, parts);
  const disabledReason = atomTarget && "reason" in atomTarget ? atomTarget.reason : undefined;
  return [
    { id: "bracket.repeatUnit.toggle", title: repeat ? "Remove Repeat Unit" : "Mark as Repeat Unit", category: "annotation",
      icon: "bracket", enabled: !disabledReason, disabledReason },
    { id: "bracket.label.edit", title: "Edit Repeat Label", category: "annotation", icon: "text", enabled: labelEditable,
      disabledReason: labelEditable ? undefined : "Mark a bracket pair as a repeat unit first" }
  ];
}

function repeatUnitChanges(object: BracketObject, repeatUnit: boolean): Partial<BracketObject> {
  return {
    repeatUnit, bracketKind: object.bracketKind === "polymer" ? "square" : object.bracketKind,
    ...(repeatUnit ? { bracketUsage: "sru" as const } : { bracketUsage: undefined, repeatCount: undefined, crossingBondIds: undefined }),
    ...(repeatUnit && object.side === "close" ? { label: object.label || "n" } : {})
  };
}

export function toggleBracketRepeatUnit(document: ChemDraftDocument, parts: readonly NativeMoleculePartSelection[] = []): ChemDraftDocument {
  const pair = parts.length ? [] : selectedBracketPair(document);
  if (!pair.length) {
    const target = prepareAtomRepeatUnit(document, parts);
    if ("reason" in target) return document;
    const { pageId } = target;
    return applyPatches(document, [
      ...target.pair.map(object => ({ op: "addObject" as const, pageId, object: { ...object, ...repeatUnitChanges(object, true) } })),
      { op: "setSelection", pageId, objectIds: target.pair.map(object => object.id) }
    ]);
  }
  const repeatUnit = bracketPairUsage(pair) === "generic";
  return applyPatches(document, [
    ...pair.map(object => ({ op: "updateObject" as const, objectId: object.id, changes: repeatUnitChanges(object, repeatUnit) })),
    { op: "setSelection", pageId: document.selection.pageId, objectIds: pair.map(object => object.id) }
  ]);
}

/** Describe the result using the same explicit-or-enclosed atom membership as graph exports. */
export function bracketRepeatUnitStatus(document: ChemDraftDocument): string {
  const pair = selectedBracketPair(document);
  const close = pair.find(object => object.side === "close");
  if (!close) return "No bracket pair selected";
  const label = close.label ?? "n";
  if (!pair.some(object => object.repeatUnit || object.bracketKind === "polymer")) return `Removed repeat unit "${label}"`;
  const page = document.pages.find(page => page.objects.some(object => object.id === close.id))!;
  const membership = resolveRepeatUnitAtomMembership(pair, page.objects, membershipOptions);
  // Empty membership is known, even though it remains a diagnostic for graph exports.
  if (membership.reason && membership.reason !== "its atom membership is empty") {
    return `Marked repeat unit "${label}"; membership is ambiguous: ${membership.reason}`;
  }
  const count = membership.members.reduce((total, member) => total + member.atomIds.length, 0);
  return `Marked ${count} ${count === 1 ? "atom" : "atoms"} as repeat unit "${label}"`;
}

export function setBracketRepeatLabel(document: ChemDraftDocument, objectId: string, label: string): ChemDraftDocument {
  const object = document.pages.flatMap(page => page.objects).find(object => object.id === objectId);
  const page = document.pages.find(page => page.objects.some(item => item.id === objectId));
  const pair = object?.type === "bracket" && object.pairId && page ? bracketPairs(page.objects).get(object.pairId) : undefined;
  if (object?.type !== "bracket" || !pair || object.side !== "close" || !(object.repeatUnit || object.bracketKind === "polymer" || object.bracketUsage === "sru")) return document;
  const value = label.trim() || "n";
  if (value === (object.label ?? "n")) return document;
  return applyPatches(document, [
    { op: "updateObject", objectId, changes: { label: value } },
    { op: "setSelection", pageId: document.selection.pageId, objectIds: pair.map(item => item.id) }
  ]);
}
