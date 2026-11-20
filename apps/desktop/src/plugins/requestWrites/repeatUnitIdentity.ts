import { bracketPairs, bracketPairSemantics, resolveRepeatUnitAtomMembership, type DocumentPage } from "@chemdraft/chem-core";
import { visibleBracketGroup } from "@chemdraft/cdx-compat";
import { transformPointForObject } from "@chemdraft/layout-engine";
import { RequestWriteError } from "@chemdraft/plugin-host";

function repeatUnits(page: DocumentPage) {
  const units = new Map<string, { identity: string; generic: boolean; unresolved?: string }>();
  const objects = new Map(page.objects.map(object => [object.id, object]));
  for (const [id, pair] of bracketPairs(page.objects)) {
    const semantics = bracketPairSemantics(pair);
    const { usage, label, count } = semantics;
    const resolved = resolveRepeatUnitAtomMembership(pair, page.objects, { atomPosition: transformPointForObject });
    const members = resolved.members.map(({ molecule, atomIds }) => [molecule.id, [...atomIds].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    const brackets = [...pair].sort((a, b) => Number(a.side === "close") - Number(b.side === "close"))
      .map(({ side, bracketKind, bracketUsage, repeatUnit, repeatCount, label, crossingBondIds }) =>
        ({ side, bracketKind, bracketUsage, repeatUnit, repeatCount, label, crossingBondIds }));
    const visible = visibleBracketGroup(pair, semantics, resolved, objects);
    const visibleMembers = [...new Set(visible.members.map(member => JSON.stringify(member)))].sort();
    units.set(id, { identity: JSON.stringify([usage, label, count, members, resolved.connectivity, brackets,
      visible.usage, visible.usageConflict, visible.caseOnlyGlyphUsages, visible.sruLabel, visible.repeatCount, visibleMembers]),
      generic: usage === "generic", unresolved: resolved.reason });
  }
  return units;
}

/** Membership belongs to the page. Moving an unreferenced bracket or a molecule can change
 * just one enclosed atom while every cached formula and the finite graph remain identical. */
export function assertRepeatUnitIdentity(before: DocumentPage, after: DocumentPage): void {
  if (!before.objects.some(object => object.type === "bracket") && !after.objects.some(object => object.type === "bracket")) return;
  // Visible CDXML membership can also reference imported non-molecular objects.
  const relevant = (page: DocumentPage) => {
    const importedIds = new Set<string>();
    for (const object of page.objects) {
      if (object.type !== "bracket") continue;
      const records = object.compatibility?.unknown.cdxmlBracketMembers;
      if (Array.isArray(records)) for (const record of records) {
        if (typeof record?.objectId === "string") importedIds.add(record.objectId);
      }
    }
    return page.objects.filter(object => object.type === "bracket" || object.type === "molecule" || importedIds.has(object.id));
  };
  const original = relevant(before), proposed = relevant(after);
  if (original.length === proposed.length && original.every((object, i) => object === proposed[i])) return;
  const previous = repeatUnits(before), next = repeatUnits(after);
  for (const id of new Set([...previous.keys(), ...next.keys()])) {
    const a = previous.get(id), b = next.get(id);
    if ((!a && b?.generic) || (!b && a?.generic)) continue;
    if (a?.identity !== b?.identity) throw new RequestWriteError("chemistry", `The write would change repeat unit "${id}" or its atom membership.`);
    // An empty enclosure is a known empty atom set. Other resolver failures leave membership uncertain.
    const reason = a?.unresolved ?? b?.unresolved;
    if (a?.unresolved !== b?.unresolved || reason && reason !== "its atom membership is empty") {
      throw new RequestWriteError("chemistry", `Cannot verify repeat unit "${id}" because ${reason}.`);
    }
  }
}
