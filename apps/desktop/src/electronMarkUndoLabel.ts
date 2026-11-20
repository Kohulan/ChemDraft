import type { ChemDraftDocument, DocumentObject, ElectronMarkObject } from "@chemdraft/chem-core";
import type { NativeElectronMarkSpec } from "./documentWorkflow";

/** Name the actual edit: an opposite-sign press reduces a charge, even on a radical ion. */
export function electronMarkUndoLabel(before: ChemDraftDocument, after: ChemDraftDocument, spec: NativeElectronMarkSpec): string {
  const magnitude = (document: ChemDraftDocument) => document.pages.reduce((total, page) => total +
    page.objects.reduce((sum, object) => sum + (object.type === "electron-mark" && object.markKind === spec.kind
      ? spec.kind === "charge" ? Math.abs(object.charge ?? 0) : 1 : 0), 0), 0);
  const noun = spec.kind === "charge" ? "Charge" : spec.kind === "radical-dot" ? "Radical" : "Lone Pair";
  return `${magnitude(after) < magnitude(before) ? "Remove" : "Add"} ${noun}`;
}

/** Describe the charge association changes between the endpoints of a geometry edit. */
export function chargeAssociationUndoLabel(before: ChemDraftDocument, after: ChemDraftDocument, label: string): string {
  if (before.pages === after.pages) return label;
  const actions = new Set<string>();
  for (const page of before.pages) {
    const nextPage = after.pages.find(candidate => candidate.id === page.id);
    if (!nextPage || nextPage.objects === page.objects) continue;
    const charges = page.objects.filter(isChargeMark);
    if (!charges.length) continue;
    const nextCharges = new Map(nextPage.objects.filter(isChargeMark).map(mark => [mark.id, mark]));
    for (const mark of charges) {
      const next = nextCharges.get(mark.id);
      if (!next || next === mark) continue;
      const from = mark.anchor.kind === "atom" ? mark.anchor : undefined;
      const to = next.anchor.kind === "atom" ? next.anchor : undefined;
      if (from?.objectId === to?.objectId && from?.atomId === to?.atomId) continue;
      actions.add(from && to ? "Transfer Charge" : from ? "Remove Charge" : "Attach Charge");
    }
  }
  return actions.size ? [label, ...actions].join(" and ") : label;
}

function isChargeMark(object: DocumentObject): object is ElectronMarkObject {
  return object.type === "electron-mark" && object.markKind === "charge";
}
