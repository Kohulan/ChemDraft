import { describe, expect, it, vi } from "vitest";
import { applyPatch, applyPatches, resolveRepeatUnitAtomMembership, toEngineDocument, undo, redo, withoutBracketPairMetadata,
  type BracketObject, type ChemDraftDocument, type GroupObject, type MoleculeObject } from "@chemdraft/chem-core";
import { exportDocumentToCdxml, openChemDraftPayload } from "@chemdraft/cdx-compat";
import { repeatUnitExportWarnings } from "@chemdraft/export-engine";
import { bracketRepeatUnitStatus, createBracketCommands, prepareCleanupRepeatUnits, selectedBracketPair, setBracketRepeatLabel, toggleBracketRepeatUnit } from "./bracketCommands";
import { bracketLabelContainsPoint, bracketLabelPlan, transformPointForObject } from "@chemdraft/layout-engine";
import { applyEraserSweep } from "./MainWindow";
import { applyNativeMoleculePartsDelete, nativeFreeformSingleBondToolAtPoint, applySingleBondToolAtPoint, copyAsMolfile, copyAsSmiles, createPhase4Document,
  analysisFacingStructure, createSelectionClipboardPayload, deleteSelectedDocumentObjects, duplicateSelectedDocumentObjects, insertNativeBracket, pasteSelectionClipboardPayload } from "./documentWorkflow";
import { exportStructureListSdf, exportStructureListSmi } from "./structureListExport";
import { allShellCommands } from "./commands";
import type { NativeMoleculePartSelection } from "./selection/selectionPolicy";

vi.mock("@chemdraft/rdkit-adapter/identifiers", () => ({ computeStructureIdentifiers: vi.fn(async () => undefined) }));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

const brackets = () => insertNativeBracket(createPhase4Document("Bracket unit"), { x: 100, y: 100 }, "round", { x: 260, y: 200 });
const bracketObjects = (document: ChemDraftDocument) => document.pages[0].objects.filter((object): object is BracketObject => object.type === "bracket");
const repeatAroundMolecule = () => toggleBracketRepeatUnit(insertNativeBracket(
  applySingleBondToolAtPoint(createPhase4Document("Unit"), { x: 140, y: 140 }),
  { x: 100, y: 100 }, "round", { x: 260, y: 200 }));
function expectPlainBracket(object: BracketObject) {
  expect(object.pairId).toBeUndefined();
  expect(object.repeatUnit).toBeUndefined();
  expect(object.label).toBeUndefined();
  expect(object.bracketUsage).toBeUndefined();
  expect(object.repeatCount).toBeUndefined();
  expect(object.crossingBondIds).toBeUndefined();
}

function repeatChain() {
  const document = createPhase4Document("Repeat chain");
  const molecule: MoleculeObject = { id: "chain", type: "molecule", x: 110, y: 140, width: 120, height: 1, rotation: 0,
    style: {}, structure: "CCCCC", structureFormat: "smiles", superatoms: [], rGroups: [],
    atoms: [110, 140, 170, 200, 230].map((x, index) => ({ id: `a${index + 1}`, element: "C", x, y: 140, formalCharge: 0 })),
    bonds: [1, 2, 3, 4].map(index => ({ id: `b${index}`, fromAtomId: `a${index}`, toAtomId: `a${index + 1}`, order: "single" })) };
  return { molecule, document: applyPatch(document, { op: "addObject", pageId: document.pages[0].id, object: molecule }) };
}

const repeatAction = (document: ChemDraftDocument, parts: NativeMoleculePartSelection[]) =>
  createBracketCommands(document, parts).find(action => action.id === "bracket.repeatUnit.toggle")!;
const chainParts = (atomIds: string[], bondIds: string[] = []): NativeMoleculePartSelection =>
  ({ objectId: "chain", kind: "parts", atomIds, bondIds });

it("refits the paired glyph while leaving a later bracket with the same id alone", () => {
  const { document, molecule } = repeatChain();
  const marked = toggleBracketRepeatUnit(document, [chainParts(["a2", "a3", "a4"])]);
  const page = marked.pages[0]!;
  const opening = bracketObjects(marked).find(bracket => bracket.side === "open")!;
  const spectator = withoutBracketPairMetadata({ ...opening, x: 400, y: 300 });
  const before = toEngineDocument({ ...marked, pages: [{ ...page, objects: [...page.objects, spectator] }] });
  const candidate = applyPatch(before, { op: "updateObject", objectId: molecule.id, changes: {
    x: molecule.x + 200, atoms: molecule.atoms.map(atom => ({ ...atom, x: atom.x + 200 }))
  } }, { preserveRepeatUnitBrackets: true });

  const { document: cleaned } = prepareCleanupRepeatUnits(before, candidate, [molecule.id]);

  expect(bracketObjects(cleaned)[0]!.x).toBe(opening.x + 200);
  expect(cleaned.pages[0]!.objects.at(-1)).toBe(candidate.pages[0]!.objects.at(-1));
});

describe("marking an atom selection as a repeat unit", () => {
  it("creates the same selected bracket objects and MOL crossing bonds as drawing the pair first", () => {
    const { document, molecule } = repeatChain();
    const before = applyPatch(document, { op: "setSelection", objectIds: [molecule.id] });
    const parts = [chainParts(["a2", "a3", "a4"], ["b2", "b3"])];
    expect(repeatAction(before, parts)).toMatchObject({ title: "Mark as Repeat Unit", enabled: true });
    expect(repeatAction(before, parts).disabledReason).toBeUndefined();
    const marked = toggleBracketRepeatUnit(before, parts);
    const drawn = toggleBracketRepeatUnit(insertNativeBracket(before, { x: 132, y: 132 }, "square", { x: 208, y: 148 }));
    expect(bracketObjects(marked)).toEqual(bracketObjects(drawn));
    expect(marked.selection).toEqual(drawn.selection);
    expect(bracketRepeatUnitStatus(marked)).toBe('Marked 3 atoms as repeat unit "n"');
    expect(copyAsMolfile(marked, "v3000")).toEqual(copyAsMolfile(drawn, "v3000"));
    expect(copyAsMolfile(marked, "v3000")).toContain("SRU 0 ATOMS=(3 2 3 4) XBONDS=(2 1 4) LABEL=n CONNECT=EU");
    const retained = marked.pages[0].objects.find(object => object.id === molecule.id) as MoleculeObject;
    expect(retained.atoms).toEqual(molecule.atoms);
    expect(retained.bonds).toEqual(molecule.bonds);
  });

  it("allocates a pair id independently of object ids and keeps an unrelated existing pair", () => {
    const { document } = repeatChain();
    const existing = toggleBracketRepeatUnit(insertNativeBracket(document,
      { x: 400, y: 250 }, "square", { x: 480, y: 300 }));
    const pair = bracketObjects(existing);
    const oldPairId = "bracket_004"; // The object allocator's next opening glyph id.
    const before = applyPatches(existing, [
      ...pair.map(bracket => ({
        op: "updateObject" as const, objectId: bracket.id, changes: { pairId: oldPairId }
      })),
      { op: "setSelection", objectIds: [] }
    ]);
    const marked = toggleBracketRepeatUnit(before, [chainParts(["a2"])]);
    const [oldOpen, oldClose, newOpen, newClose] = bracketObjects(marked);
    expect(oldOpen.pairId).toBe(oldPairId);
    expect(oldClose).toMatchObject({ pairId: oldPairId, label: "n" });
    expect(newOpen.id).toBe(oldPairId);
    expect(newOpen.pairId).toBeTruthy();
    expect(newOpen.pairId).not.toBe(oldPairId);
    expect(newClose).toMatchObject({ pairId: newOpen.pairId, label: "n" });
  });

  it("accepts three crossing bonds under the existing MOL boundary rules", () => {
    const { document, molecule } = repeatChain();
    const branched = applyPatch(document, { op: "updateObject", objectId: molecule.id, changes: {
      atoms: [...molecule.atoms, { id: "branch", element: "C", x: 170, y: 110, formalCharge: 0 }],
      bonds: [...molecule.bonds, { id: "b5", fromAtomId: "a3", toAtomId: "branch", order: "single" }]
    } });
    const parts = [chainParts(["a3"])];
    expect(repeatAction(branched, parts).enabled).toBe(true);
    expect(copyAsMolfile(toggleBracketRepeatUnit(branched, parts), "v3000")).toContain("XBONDS=(3 2 3 5)");
  });

  it.each([
    ["all atoms", "no crossing bonds"], ["isolated atom", "no crossing bonds"],
    ["multiple molecules", "from a single molecule"], ["mixed objects", "Deselect whole objects"],
    ["a bond without atoms", "Select a bracket pair or atoms"], ["already bracketed", "already inside a repeat unit"],
    ["nonmembers inside the box", "would also enclose unselected atoms"]
  ] as const)("refuses %s with a specific reason and no edit", (reasonCase, expected) => {
    const chain = repeatChain();
    let { document } = chain;
    let parts = [chainParts(["a2"])];
    if (reasonCase === "all atoms") parts = [chainParts(chain.molecule.atoms.map(atom => atom.id))];
    if (reasonCase === "isolated atom") document = applyPatch(document, {
      op: "updateObject", objectId: chain.molecule.id, changes: { bonds: chain.molecule.bonds.slice(2) }
    });
    if (reasonCase === "multiple molecules") {
      const other = { ...chain.molecule, id: "other" };
      document = applyPatch(document, { op: "addObject", pageId: document.pages[0].id, object: other });
      parts.push({ objectId: other.id, kind: "atom", atomId: "a2" });
    }
    if (reasonCase === "mixed objects") document = insertNativeBracket(document, { x: 400, y: 400 }, "square");
    if (reasonCase === "a bond without atoms") parts = [chainParts([], ["b2"])];
    if (reasonCase === "already bracketed") document = applyPatch(toggleBracketRepeatUnit(document, parts), { op: "setSelection", objectIds: [] });
    if (reasonCase === "nonmembers inside the box") parts = [chainParts(["a2", "a4"])];
    const action = repeatAction(document, parts);
    expect(action.enabled).toBe(false);
    expect(action.disabledReason).toContain(expected);
    expect(toggleBracketRepeatUnit(document, parts)).toBe(document);
  });
});

describe("deleting repeat-unit members", () => {
  it.each([false, true])("deletes bracket geometry and label with the molecule (explicitly select one glyph: %s)", includeGlyph => {
    const { document, molecule } = repeatChain();
    const marked = toggleBracketRepeatUnit(document, [chainParts(["a2", "a3", "a4"])]);
    const repeat = setBracketRepeatLabel(marked, bracketObjects(marked).find(bracket => bracket.side === "close")!.id, "m");
    const [open, close] = bracketObjects(repeat);
    expect(close.label).toBe("m");
    const selection = includeGlyph ? [molecule.id, open.id] : [molecule.id];
    const before = applyPatch(repeat, { op: "setSelection", objectIds: selection });
    const deleted = deleteSelectedDocumentObjects(before);
    expect(deleted.pages[0].objects).toEqual([]);
    expect(repeatUnitExportWarnings(deleted, "MOL")).toEqual([]);
    expect(exportDocumentToCdxml(deleted, { embedNativePayload: false }).contents).not.toContain("bracketedgroup");
    expect(undo({ past: [before], present: deleted, future: [] }).present).toBe(before);
  });

  it.each([false, true])("counts explicitly contained structure-only members until the last deletion (mixed: %s)", mixed => {
    const chain = repeatChain();
    const pageId = chain.document.pages[0].id;
    const stored: MoleculeObject = { ...chain.molecule, id: "stored", x: 150, y: 160, structure: "CO", atoms: [], bonds: [] };
    let document = applyPatch(chain.document, { op: "addObject", pageId, object: stored });
    if (!mixed) document = applyPatch(document, { op: "removeObject", objectId: chain.molecule.id });
    const repeat = toggleBracketRepeatUnit(insertNativeBracket(document, { x: 90, y: 100 }, "square", { x: 270, y: 210 }));
    expect(bracketObjects(repeat).every(bracket => bracket.containedObjectIds.includes(stored.id))).toBe(true);
    const remaining = mixed ? deleteSelectedDocumentObjects(repeat, [chain.molecule.id]) : repeat;
    expect(bracketObjects(remaining)).toEqual(bracketObjects(repeat).map(bracket => ({ ...bracket, containedObjectIds: [stored.id] })));
    expect(deleteSelectedDocumentObjects(remaining, [stored.id]).pages[0].objects).toEqual([]);
  });

  it("prunes the explicitly erased molecule and both orphaned glyphs from nested groups", () => {
    const repeat = repeatAroundMolecule();
    const page = repeat.pages[0];
    const molecule = page.objects.find(object => object.type === "molecule")!;
    const [open, close] = bracketObjects(repeat);
    const group: GroupObject = { id: "survivingGroup", type: "group", childObjectIds: [open.id, "retained"],
      x: 75, y: 75, width: 120, height: 120, rotation: 0, style: {} };
    const before = applyPatches(repeat, [
      { op: "addObject", pageId: page.id, object: { id: "retained", type: "plus", x: 75, y: 75, width: 12, height: 12, rotation: 0, style: {} } },
      { op: "addObject", pageId: page.id, object: group },
      { op: "addObject", pageId: page.id, object: { ...group, id: "emptyGroup", childObjectIds: [molecule.id, open.id, close.id] } },
      { op: "addObject", pageId: page.id, object: { ...group, id: "parent", childObjectIds: ["emptyGroup"] } }
    ]);
    const after = applyEraserSweep(before, { objectIds: [molecule.id], moleculeParts: [] });
    expect(after.pages[0].objects.map(object => object.id)).toEqual(["retained", group.id]);
    expect(after.pages[0].objects.at(-1)).toEqual({ ...group, childObjectIds: ["retained"] });
  });

  it("prunes only the ids removed by separate erasures of two repeat-unit members", () => {
    let drawing = applySingleBondToolAtPoint(createPhase4Document("Two members"), { x: 140, y: 140 });
    drawing = applySingleBondToolAtPoint(drawing, { x: 220, y: 140 });
    const repeat = toggleBracketRepeatUnit(insertNativeBracket(drawing, { x: 100, y: 100 }, "square", { x: 300, y: 200 }));
    const page = repeat.pages[0];
    const [first, second] = page.objects.filter(object => object.type === "molecule");
    const glyphIds = bracketObjects(repeat).map(bracket => bracket.id);
    const group: GroupObject = { id: "group", type: "group", childObjectIds: [first.id, ...glyphIds, "previously-missing"],
      x: 75, y: 75, width: 220, height: 120, rotation: 0, style: {} };
    const before = applyPatch(repeat, { op: "addObject", pageId: page.id, object: group });
    const partial = applyEraserSweep(before, { objectIds: [first.id], moleculeParts: [] });
    expect(partial.pages[0].objects.find(object => object.id === group.id))
      .toEqual({ ...group, childObjectIds: [...glyphIds, "previously-missing"] });
    const after = applyEraserSweep(partial, { objectIds: [second.id], moleculeParts: [] });
    expect(after.pages[0].objects).toEqual([{ ...group, childObjectIds: ["previously-missing"] }]);
  });

  it("removes the opposite glyph when one eraser sweep hits a glyph and every member atom", () => {
    const { document, molecule } = repeatChain();
    const repeat = toggleBracketRepeatUnit(document, [chainParts(["a2", "a3", "a4"])]);
    const [open] = bracketObjects(repeat);
    const after = applyEraserSweep(repeat, { objectIds: [open.id], moleculeParts: [
      { objectId: molecule.id, kind: "parts", atomIds: ["a2", "a3", "a4"], bondIds: [] }
    ] });
    expect(bracketObjects(after)).toEqual([]);
    expect(after.pages[0].objects[0]).toMatchObject({ id: molecule.id, atoms: [{ id: "a1" }, { id: "a5" }] });
  });

  it.each([false, true])("retains an imported atom SRU through a merge and resolves only proven membership (unresolved: %s)", unresolved => {
    const imported = openChemDraftPayload(`<CDXML><page id="1">
      <fragment id="10"><n id="11" Element="6" p="100 140"/><n id="12" Element="6" p="130 140"/>
        <b id="13" B="11" E="12" Order="1"/></fragment>
      <graphic id="20" GraphicType="Bracket" BracketType="Round" BoundingBox="85 120 90 160"/>
      <graphic id="21" GraphicType="Bracket" BracketType="Round" BoundingBox="110 120 115 160"/>
      <bracketedgroup id="30" BracketedObjectIDs="${unresolved ? "11 999" : "11"}" BracketUsage="SRU" SRULabel="n">
        <bracketattachment id="31" GraphicID="20"><crossingbond id="32" BondID="13" InnerAtomID="11"/></bracketattachment>
        <bracketattachment id="33" GraphicID="21"/>
      </bracketedgroup></page></CDXML>`).document!;
    const page = imported.pages[0];
    const absorbed = page.objects.find(object => object.type === "molecule")!;
    const [member, outside] = absorbed.atoms;
    const { molecule } = repeatChain();
    const host = { ...molecule, atoms: molecule.atoms.map((atom, index) => ({ ...atom,
      x: outside.x + 40 + index * 30, y: outside.y
    })) };
    const before = applyPatch(imported, { op: "addObject", pageId: page.id, object: host });
    const after = nativeFreeformSingleBondToolAtPoint(before, host.id, host.atoms[0].id, outside).document;
    expect(after.pages[0].objects.some(object => object.id === absorbed.id)).toBe(false);
    const kept = bracketObjects(after);
    expect(kept).toHaveLength(2);
    expect(kept[1]).toMatchObject({ label: "n", pairId: bracketObjects(before)[1].pairId });
    const membership = resolveRepeatUnitAtomMembership(kept, after.pages[0].objects);
    const merged = after.pages[0].objects.find(object => object.id === host.id && object.type === "molecule") as MoleculeObject;
    const moved = merged.atoms.find(atom => atom.cdxmlSourceId === "11")!;
    expect(moved.id).not.toBe(member.id);
    expect(membership.members.map(({ molecule, atomIds }) => [molecule.id, atomIds])).toEqual([[host.id, [moved.id]]]);
    if (unresolved) {
      expect(membership.reason).toContain('member "999" does not resolve');
      expect(bracketObjects(deleteSelectedDocumentObjects(before, [absorbed.id]))).toHaveLength(2);
    } else {
      expect(membership.reason).toBeUndefined();
      expect(copyAsMolfile(after, "v3000")).toContain("SRU 0 ATOMS=(1");
    }
  });

  it("carries staged atom-deletion proof through a merge after an incident bond was erased", () => {
    const imported = openChemDraftPayload(`<CDXML><page id="1">
      <fragment id="10"><n id="11" Element="6" p="100 140"/><n id="12" Element="6" p="130 140"/>
        <n id="14" Element="6" p="160 140"/><b id="13" B="11" E="12" Order="1"/>
        <b id="15" B="12" E="14" Order="1"/></fragment>
      <graphic id="20" GraphicType="Bracket" BracketType="Round" BoundingBox="85 120 90 160"/>
      <graphic id="21" GraphicType="Bracket" BracketType="Round" BoundingBox="145 120 150 160"/>
      <bracketedgroup id="30" BracketedObjectIDs="11 12" BracketUsage="SRU" SRULabel="n">
        <bracketattachment id="31" GraphicID="20"/><bracketattachment id="33" GraphicID="21"/>
      </bracketedgroup></page></CDXML>`).document!;
    const absorbed = imported.pages[0].objects.find(object => object.type === "molecule")!;
    const [first, second, outside] = absorbed.atoms;
    const staged = applyNativeMoleculePartsDelete(imported, { objectId: absorbed.id, atomIds: [first.id], bondIds: [] });
    const { molecule } = repeatChain();
    const host = { ...molecule, atoms: molecule.atoms.map((atom, i) => ({ ...atom, x: outside.x + 40 + 30 * i, y: outside.y })) };
    const before = applyPatch(staged, { op: "addObject", pageId: staged.pages[0].id, object: host });
    const after = nativeFreeformSingleBondToolAtPoint(before, host.id, host.atoms[0].id, outside).document;
    const merged = after.pages[0].objects.find(object => object.id === host.id && object.type === "molecule") as MoleculeObject;
    const remapped = merged.atoms.find(atom => atom.cdxmlSourceId === "12")!;
    expect(remapped.id).not.toBe(second.id);
    expect(bracketObjects(after)).toHaveLength(2);
    for (const glyph of bracketObjects(after)) {
      const metadata = glyph.compatibility?.unknown;
      expect(metadata?.cdxmlBracketDeletedAtoms).toEqual([["11", first.id]]);
      expect(metadata?.cdxmlBracketAtomSnapshots?.find(snapshot => snapshot.sourceId === "12")?.atomId).toBe(remapped.id);
    }
    expect(deleteSelectedDocumentObjects(after, [merged.id]).pages[0].objects).toEqual([]);
  });

  it("keeps a partial unit and prunes only crossing references to deleted bonds", () => {
    const { document, molecule } = repeatChain();
    const repeat = toggleBracketRepeatUnit(document, [chainParts(["a2", "a3", "a4"])]);
    const [open, close] = bracketObjects(repeat);
    const before = applyPatch(repeat, { op: "updateObject", objectId: open.id, changes: {
      crossingBondIds: ["b1", "b4"].map(bondId => ({ objectId: molecule.id, bondId }))
    } });
    const partial = applyNativeMoleculePartsDelete(before, { objectId: molecule.id, atomIds: ["a2"], bondIds: [] });
    expect(bracketObjects(partial)).toEqual([{ ...open, crossingBondIds: [{ objectId: molecule.id, bondId: "b4" }] }, close]);
    expect(copyAsMolfile(partial, "v3000")).toContain("SRU 0 ATOMS=(2 2 3) XBONDS=(1 2) LABEL=n CONNECT=EU");
    const orphaned = applyNativeMoleculePartsDelete(partial, { objectId: molecule.id, atomIds: ["a3", "a4"], bondIds: [] });
    expect(bracketObjects(orphaned)).toEqual([]);
    expect(repeatUnitExportWarnings(orphaned, "SMILES")).toEqual([]);
  });

  it("cleans up a unit drawn around page-space atoms of a rotated molecule", () => {
    const { document, molecule } = repeatChain();
    const rotated = applyPatch(document, { op: "updateObject", objectId: molecule.id, changes: { rotation: 90 } });
    const marked = toggleBracketRepeatUnit(rotated, [chainParts(["a2", "a3", "a4"])]);
    expect(bracketRepeatUnitStatus(marked)).toBe('Marked 3 atoms as repeat unit "n"');
    const removed = applyPatch(marked, { op: "removeObject", objectId: molecule.id });
    expect(removed.pages[0].objects).toEqual([]);
  });

  it("waits until the last member of a multi-molecule drawn unit is deleted, including in a batch", () => {
    let plain = applySingleBondToolAtPoint(createPhase4Document("Two members"), { x: 140, y: 140 });
    plain = applySingleBondToolAtPoint(plain, { x: 220, y: 140 });
    const repeat = toggleBracketRepeatUnit(insertNativeBracket(plain, { x: 100, y: 100 }, "square", { x: 300, y: 200 }));
    const [first, second] = repeat.pages[0].objects.filter(object => object.type === "molecule");
    const [open, close] = bracketObjects(repeat);
    const firstRemoval = { op: "removeObject" as const, objectId: first.id };
    const secondRemoval = { op: "removeObject" as const, objectId: second.id };
    expect(bracketObjects(applyPatch(repeat, firstRemoval))).toEqual([open, close].map(bracket =>
      ({ ...bracket, containedObjectIds: [second.id] })));
    const removed = applyPatches(repeat, [firstRemoval,
      { op: "updateObject", objectId: open.id, changes: { height: open.height + 2 } },
      { op: "updateObject", objectId: close.id, changes: { height: close.height + 2, label: "m" } },
      secondRemoval]);
    expect(removed.pages[0].objects).toEqual([]);
  });
});

describe("bracket pair annotations", () => {
  it.each([false, true])("preserves imported pair compatibility only with all referenced objects copied (%s)", includeMolecule => {
    const source = openChemDraftPayload(`<CDXML><page id="1">
      <fragment id="10"><n id="11" Element="6" p="100 100"/><n id="12" Element="8" p="130 100"/><b id="13" B="11" E="12" Order="1"/></fragment>
      <graphic id="20" GraphicType="Bracket" BracketType="Round" BoundingBox="70 80 80 130"/>
      <graphic id="21" GraphicType="Bracket" BracketType="Round" BoundingBox="150 80 160 130"/>
      <bracketedgroup id="30" BracketedObjectIDs="10 11" BracketUsage="SRU" RepeatCount="7" SRULabel="x-y" PolymerRepeatPattern="HeadToTail">
        <bracketattachment id="31" GraphicID="20"><crossingbond id="32" BondID="13" InnerAtomID="11"/></bracketattachment>
        <bracketattachment id="33" GraphicID="21"/>
      </bracketedgroup></page></CDXML>`).document!;
    const molecule = source.pages[0].objects.find(object => object.type === "molecule")!;
    const selected = applyPatch(source, { op: "setSelection", objectIds: source.pages[0].objects.filter(object => includeMolecule || object.type === "bracket").map(object => object.id) });
    const originalCompatibility = structuredClone(bracketObjects(source).map(object => object.compatibility));
    const payload = createSelectionClipboardPayload(selected)!;
    const duplicateWarnings: string[] = [];
    const pasteWarnings: string[] = [];
    const results = [duplicateSelectedDocumentObjects(selected, undefined, duplicateWarnings),
      pasteSelectionClipboardPayload(source, payload, { x: 400, y: 400 }, pasteWarnings)];
    for (const result of results) {
      const copies = result.pages[0].objects.filter(object => result.selection.objectIds.includes(object.id));
      const copiedMolecule = copies.find(object => object.type === "molecule");
      const copiedBrackets = copies.filter((object): object is BracketObject => object.type === "bracket");
      for (const bracket of copiedBrackets) {
        const unknown = bracket.compatibility!.unknown;
        if (includeMolecule) {
          expect(unknown.bracketedGroup).toBeDefined();
          expect(unknown.cdxmlBracketMembers).toEqual([
            { sourceId: "10", objectId: copiedMolecule!.id },
            { sourceId: "11", objectId: copiedMolecule!.id, atomId: molecule.atoms[0].id }
          ]);
          expect(unknown.cdxmlBracketMembership).toBe(JSON.stringify([copiedMolecule!.id]));
          expect(unknown.cdxmlBracketMemberObjectIds).toEqual([copiedMolecule!.id]);
          expect(bracket.containedObjectIds).toEqual([copiedMolecule!.id]);
          if (bracket.side === "open") expect(unknown.cdxmlBracketCrossings).toEqual([expect.objectContaining({
            ref: { objectId: copiedMolecule!.id, bondId: molecule.bonds[0].id }, innerAtomId: molecule.atoms[0].id
          })]);
        } else {
          for (const key of ["bracketedGroup", "cdxmlBracketCrossings", "cdxmlBracketMembers", "cdxmlBracketState", "cdxmlBracketMembership"]) expect(unknown[key]).toBeUndefined();
        }
      }
      if (includeMolecule) {
        const scoped = { ...result, pages: [{ ...result.pages[0], objects: copies }] };
        const exported = exportDocumentToCdxml(scoped, { embedNativePayload: false });
        expect(exported.contents).toContain('PolymerRepeatPattern="HeadToTail"');
        expect(exported.contents).toContain('RepeatCount="7"');
        const reopened = openChemDraftPayload(exported.contents).document!;
        const reopenedMolecule = reopened.pages[0].objects.find(object => object.type === "molecule")!;
        const reopenedOpen = bracketObjects(reopened).find(object => object.side === "open")!;
        expect(reopenedOpen.crossingBondIds).toEqual([{ objectId: reopenedMolecule.id, bondId: reopenedMolecule.bonds[0].id }]);
        expect(reopenedOpen.compatibility!.unknown.cdxmlBracketMembers).toEqual(expect.arrayContaining([expect.objectContaining({
          objectId: reopenedMolecule.id, atomId: reopenedMolecule.atoms[0].id
        })]));
      }
    }
    if (includeMolecule) {
      expect(payload.warnings ?? []).toEqual([]);
      expect(duplicateWarnings).toEqual([]);
      expect(pasteWarnings).toEqual([]);
    } else {
      for (const warnings of [payload.warnings!, duplicateWarnings, pasteWarnings]) {
        expect(warnings.some(message => message.includes("bracketedGroup") && message.includes(molecule.id))).toBe(true);
      }
    }
    const half = applyPatch(source, { op: "setSelection", objectIds: [bracketObjects(source)[0].id] });
    const halfPayload = createSelectionClipboardPayload(half)!;
    expectPlainBracket(halfPayload.objects[0] as BracketObject);
    expect(halfPayload.warnings).toEqual([expect.stringContaining("complete pair was not copied")]);
    expect(bracketObjects(source).map(object => object.compatibility)).toEqual(originalCompatibility);
  });

  it.each([false, true])("remaps copied crossing bonds and drops uncopied ones (copy molecule: %s)", includeMolecule => {
    const original = repeatAroundMolecule();
    const molecule = original.pages[0].objects.find(object => object.type === "molecule")!;
    const source = { ...original, pages: [{ ...original.pages[0], objects: original.pages[0].objects.map(object =>
      object.type === "bracket" ? { ...object, bracketUsage: "multiple" as const, repeatCount: 3,
        crossingBondIds: [{ objectId: molecule.id, bondId: molecule.bonds[0].id }] } : object) }] };
    const selected = includeMolecule ? applyPatch(source, { op: "setSelection", objectIds: source.pages[0].objects.map(object => object.id) }) : source;
    const payload = createSelectionClipboardPayload(selected)!;
    const target = createPhase4Document("Target");
    for (const result of [duplicateSelectedDocumentObjects(selected), pasteSelectionClipboardPayload(target, payload, { x: 400, y: 300 })]) {
      const copies = result.pages[0].objects.filter(object => result.selection.objectIds.includes(object.id));
      const copiedMolecule = copies.find(object => object.type === "molecule");
      for (const bracket of copies.filter((object): object is BracketObject => object.type === "bracket")) {
        expect(bracket.crossingBondIds).toEqual(includeMolecule ? [{ objectId: copiedMolecule!.id, bondId: molecule.bonds[0].id }] : []);
        expect(bracket).toMatchObject({ bracketUsage: "multiple", repeatCount: 3 });
      }
    }
    const plain = toggleBracketRepeatUnit(source);
    for (const bracket of bracketObjects(plain)) {
      expect(bracket.bracketUsage).toBeUndefined();
      expect(bracket.repeatCount).toBeUndefined();
      expect(bracket.crossingBondIds).toBeUndefined();
    }
    const generic = { ...source, pages: [{ ...source.pages[0], objects: source.pages[0].objects.map(object => object.type === "bracket" ?
      { ...object, bracketUsage: "generic" as const, repeatUnit: false, repeatCount: undefined } : object) }] };
    const marked = toggleBracketRepeatUnit(generic);
    expect(bracketObjects(marked).every(object => object.bracketUsage === "sru" && object.crossingBondIds?.length === 1)).toBe(true);
    expect(createBracketCommands({ ...source, pages: [{ ...source.pages[0], objects: source.pages[0].objects.map(object =>
      object.type === "bracket" ? { ...object, repeatUnit: false } : object) }] }).find(command => command.id === "bracket.label.edit")!.enabled).toBe(false);
    const deleted = applyPatch(source, { op: "updateObject", objectId: molecule.id, changes: { bonds: [] } });
    expect(bracketObjects(deleted).every(object => !object.crossingBondIds?.length)).toBe(true);
  });

  it.each(["multiple", "sru", "unknown"] as const)("declines property analysis for a molecule inside %s", usage => {
    const original = repeatAroundMolecule();
    const document = { ...original, pages: [{ ...original.pages[0], objects: original.pages[0].objects.map(object => object.type === "bracket" ?
      { ...object, bracketUsage: usage, repeatUnit: usage === "sru", repeatCount: usage === "multiple" ? 3 : undefined } : object) }] };
    const molecule = document.pages[0].objects.find(object => object.type === "molecule")!;
    const request = analysisFacingStructure(molecule, document);
    expect(request.structure).toBe("");
    expect(request.refusalReason).toContain(usage === "multiple" ? "multiple group x3" : usage === "sru" ? "repeat unit n" : "unknown usage");
  });
  it.each([0, 1, 2, 5])("reports %s enclosed atoms with the actual label and singular/plural wording", count => {
    const original = repeatAroundMolecule();
    const molecule = original.pages[0].objects.find(object => object.type === "molecule")!;
    const repeat = { ...original, pages: [{ ...original.pages[0], objects: original.pages[0].objects.map(object =>
      object.type === "molecule" ? { ...object, atoms: Array.from({ length: count }, (_, index) =>
        ({ ...molecule.atoms[0], id: `count_atom_${index}`, x: 140 + index * 5, y: 140 })), bonds: [] } : object) }] };
    const closing = selectedBracketPair(repeat).find(object => object.side === "close")!;
    const edited = setBracketRepeatLabel(repeat, closing.id, "m");
    expect(bracketRepeatUnitStatus(edited)).toBe(`Marked ${count} ${count === 1 ? "atom" : "atoms"} as repeat unit "m"`);
    expect(bracketRepeatUnitStatus(toggleBracketRepeatUnit(edited))).toBe('Removed repeat unit "m"');
  });
  it("counts enclosed atoms of a partially bracketed molecule without counting outside atoms", () => {
    const original = repeatAroundMolecule();
    const partial = { ...original, pages: [{ ...original.pages[0], objects: original.pages[0].objects.map(object =>
      object.type === "bracket" ? { ...object, containedObjectIds: [] } : object.type === "molecule"
        ? { ...object, atoms: object.atoms.map((atom, index) => index ? { ...atom, x: 400 } : atom) } : object) }] };
    expect(bracketRepeatUnitStatus(partial)).toBe('Marked 1 atom as repeat unit "n"');
  });
  it("reports the same unresolved frame for mismatched bracket rotations in the UI and export", () => {
    const original = repeatAroundMolecule();
    const rotated = { ...original, pages: [{ ...original.pages[0], objects: original.pages[0].objects.map(object =>
      object.type === "bracket" && object.side === "close" ? { ...object, rotation: 35 } : object) }] };
    const warnings: string[] = [];
    copyAsMolfile(rotated, "v3000", warnings);
    // Only one glyph rotates, so the pair has no common planar frame; rotation alone is supported.
    expect(warnings[0]).toContain("its brackets do not share a known planar rotation frame");
    expect(bracketRepeatUnitStatus(rotated)).toBe('Marked repeat unit "n"; membership is ambiguous: its brackets do not share a known planar rotation frame');
  });
  it("keeps unresolved membership ambiguous even when no atoms are found", () => {
    const original = repeatAroundMolecule();
    const rotated = { ...original, pages: [{ ...original.pages[0], objects: original.pages[0].objects.map(object =>
      object.type === "bracket" && object.side === "close" ? { ...object, rotation: 35 }
        : object.type === "molecule" ? { ...object, atoms: [], bonds: [] } : object) }] };
    expect(bracketRepeatUnitStatus(rotated)).toBe('Marked repeat unit "n"; membership is ambiguous: its brackets do not share a known planar rotation frame');
  });
  it("hits the shared label bounds after rotating a bracket, and excludes its glyph", () => {
    const closing = selectedBracketPair(repeatAroundMolecule()).find(object => object.side === "close")!;
    const rotated = { ...closing, rotation: 35 };
    const bounds = bracketLabelPlan(rotated)!.bounds;
    const point = transformPointForObject(rotated, { x: rotated.x + bounds.x + bounds.width / 2,
      y: rotated.y + bounds.y + bounds.height / 2 });
    expect(bracketLabelContainsPoint(rotated, point)).toBe(true);
    expect(bracketLabelContainsPoint(rotated, transformPointForObject(rotated,
      { x: rotated.x + rotated.width / 2, y: rotated.y + rotated.height / 2 }))).toBe(false);
    expect(bracketLabelContainsPoint({ ...rotated, repeatUnit: false }, point)).toBe(false);
  });
  it("exposes the repeat-unit command with selection-dependent availability", () => {
    const document = brackets();
    expect(allShellCommands(document).find(command => command.id === "bracket.repeatUnit.toggle")).toMatchObject({ enabled: true });
    const unselected = applyPatch(document, { op: "setSelection", objectIds: [] });
    expect(allShellCommands(unselected).find(command => command.id === "bracket.repeatUnit.toggle")).toMatchObject({ enabled: false, disabledReason: expect.any(String) });
  });
  it("toggles both glyphs, labels only the closing side and keeps both selected", () => {
    const original = brackets();
    const repeat = toggleBracketRepeatUnit(original);
    expect(selectedBracketPair(repeat).every(object => object.repeatUnit)).toBe(true);
    const close = selectedBracketPair(repeat).find(object => object.side === "close")!;
    expect(close.label).toBe("n");
    const edited = setBracketRepeatLabel(repeat, close.id, "m");
    expect(selectedBracketPair(edited).find(object => object.side === "close")!.label).toBe("m");
    expect(edited.selection.objectIds).toEqual(original.selection.objectIds);
    expect(selectedBracketPair(toggleBracketRepeatUnit(edited)).every(object => !object.repeatUnit)).toBe(true);
    expect(createBracketCommands(original).find(action => action.id === "bracket.label.edit")).toMatchObject({ enabled: false, disabledReason: expect.any(String) });
  });
  it("also finds a pair from a selection of either side and refuses unrelated selections", () => {
    const original = brackets();
    const document = applyPatch(original, { op: "setSelection", objectIds: [original.selection.objectIds[1]] });
    expect(selectedBracketPair(document)).toHaveLength(2);
    const unselected = applyPatch(document, { op: "setSelection", objectIds: [] });
    expect(toggleBracketRepeatUnit(unselected)).toBe(unselected);
  });
  it("gives duplicated and pasted pairs independent identities", () => {
    const original = brackets();
    const duplicate = duplicateSelectedDocumentObjects(original);
    const copied = selectedBracketPair(duplicate);
    expect(copied).toHaveLength(2);
    expect(copied[0].pairId).not.toBe(selectedBracketPair(original)[0].pairId);
    const payload = createSelectionClipboardPayload(original)!;
    const pasted = pasteSelectionClipboardPayload(original, payload, { x: 300, y: 300 });
    expect(selectedBracketPair(pasted)).toHaveLength(2);
    expect(selectedBracketPair(pasted)[0].pairId).not.toBe(selectedBracketPair(original)[0].pairId);
  });

  it.each([false, true])("keeps only copied membership on duplicate and paste (molecule copied: %s)", includeMolecule => {
    const original = repeatAroundMolecule();
    const molecule = original.pages[0].objects.find(object => object.type === "molecule")!;
    expect(bracketObjects(original).every(object => object.containedObjectIds.includes(molecule.id))).toBe(true);
    const source = includeMolecule ? applyPatch(original, { op: "setSelection", objectIds: original.pages[0].objects.map(object => object.id) }) : original;
    const target = applySingleBondToolAtPoint(createPhase4Document("Other document"), { x: 400, y: 400 });
    expect(target.pages[0].objects[0].id).toBe(molecule.id);
    const payload = createSelectionClipboardPayload(source)!;
    expect(payload.objects.filter((object): object is BracketObject => object.type === "bracket")
      .map(object => object.containedObjectIds)).toEqual(includeMolecule ? [[molecule.id], [molecule.id]] : [[], []]);
    // Also accept older clipboard payloads that still contain uncopied member IDs.
    const olderPayload = { ...payload, objects: original.pages[0].objects.filter(object => includeMolecule || object.type === "bracket") };
    for (const [index, result] of [duplicateSelectedDocumentObjects(source),
      pasteSelectionClipboardPayload(target, payload, { x: 300, y: 300 }),
      pasteSelectionClipboardPayload(target, olderPayload, { x: 300, y: 300 })].entries()) {
      const selected = result.pages[0].objects.filter(object => result.selection.objectIds.includes(object.id));
      const copiedMolecule = selected.find(object => object.type === "molecule");
      for (const bracket of selected.filter((object): object is BracketObject => object.type === "bracket")) {
        expect(bracket.containedObjectIds).toEqual(includeMolecule ? [copiedMolecule!.id] : []);
        expect(bracket.containedObjectIds).not.toContain(molecule.id);
      }
      const exported = exportDocumentToCdxml(result);
      const visible = exported.contents.replace(/<objecttag\b[^>]*\/>/g, "");
      if (!includeMolecule) {
        const groups = [...visible.matchAll(/<bracketedgroup\b([^>]*)>/g)];
        // The duplicated pair still encloses the original atoms; pasted pairs enclose no atoms.
        const memberIds = groups.at(-1)![1].match(/BracketedObjectIDs="([^"]+)"/)?.[1].split(/\s+/) ?? [];
        expect(memberIds).toEqual(index === 0 ? [...visible.matchAll(/<n\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]) : []);
      }
      const reopened = openChemDraftPayload(exported.contents).document!;
      expect(bracketObjects(reopened).map(object => object.containedObjectIds)).toEqual(bracketObjects(result).map(object => object.containedObjectIds));
    }
    expect(bracketObjects(original).every(object => object.containedObjectIds.includes(molecule.id))).toBe(true);
  });

  it.each(["open", "close"] as const)("copies only the %s glyph without pair metadata", side => {
    const original = repeatAroundMolecule();
    const selected = bracketObjects(original).find(object => object.side === side)!;
    const source = applyPatch(original, { op: "setSelection", objectIds: [selected.id] });
    const payload = createSelectionClipboardPayload(source)!;
    expect(payload.objects).toHaveLength(1);
    expectPlainBracket(payload.objects[0] as BracketObject);
    const olderPayload = { ...payload, objects: [selected] };
    for (const result of [duplicateSelectedDocumentObjects(source),
      pasteSelectionClipboardPayload(source, payload, { x: 400, y: 400 }),
      pasteSelectionClipboardPayload(source, olderPayload, { x: 400, y: 400 })]) {
      const copy = bracketObjects(result).find(object => result.selection.objectIds.includes(object.id))!;
      expectPlainBracket(copy);
      expect(copy.containedObjectIds).toEqual([]);
    }
    expect(selectedBracketPair(source)).toHaveLength(2);
  });

  it.each(["open", "close"] as const)("deletes/cuts the %s half and clears the survivor in one undo entry", side => {
    const original = repeatAroundMolecule();
    const removed = bracketObjects(original).find(object => object.side === side)!;
    for (const capturedIds of [undefined, [removed.id]]) {
      const before = capturedIds ? original : applyPatch(original, { op: "setSelection", objectIds: [removed.id] });
      const deleted = deleteSelectedDocumentObjects(before, capturedIds);
      const survivor = bracketObjects(deleted)[0];
      expect(bracketObjects(deleted)).toHaveLength(1);
      expectPlainBracket(survivor);
      expect(repeatUnitExportWarnings(deleted, "MOL")).toEqual([]);
      expect(setBracketRepeatLabel(deleted, survivor.id, "m")).toBe(deleted);
      const exported = exportDocumentToCdxml(deleted);
      expect(exported.contents).toContain('GraphicType="Bracket"');
      expect(exported.contents).not.toContain("<bracketedgroup");
      expect(exported.warnings).toEqual([]);
      const history = { past: [before], present: deleted, future: [] };
      expect(undo(history).present).toBe(before);
      expect(undo(history).present.pages[0].objects).toEqual(before.pages[0].objects);
      expect(redo(undo(history)).present).toBe(deleted);
    }
  });
});

describe("repeat-unit graph-export warnings", () => {
  it.each(["multiple", "unknown"] as const)("keeps %s context and never substitutes an SRU", async usage => {
    const repeat = repeatAroundMolecule();
    const document = applyPatch(repeat, { op: "batch", patches: bracketObjects(repeat).map(object => ({
      op: "updateObject" as const, objectId: object.id,
      changes: { bracketUsage: usage, repeatUnit: false, repeatCount: usage === "multiple" ? 3 : undefined }
    })) });
    const description = usage === "multiple" ? "multiple group x3" : "unknown usage";
    const smilesWarnings: string[] = [];
    expect(await copyAsSmiles(document, smilesWarnings)).toBe("CC");
    expect(smilesWarnings).toEqual([expect.stringContaining(description)]);
    for (const flavor of ["v2000", "v3000"] as const) {
      const warnings: string[] = [];
      const contents = copyAsMolfile(document, flavor, warnings)!;
      expect(contents).not.toContain("SRU");
      expect(warnings).toEqual([
        expect.stringContaining("cannot be represented as an SRU"), expect.stringContaining(description)
      ]);
    }
  });

  it("encodes an atom subset without changing the molecule and warns with its atom count", async () => {
    const document = applySingleBondToolAtPoint(createPhase4Document("Partial unit"), { x: 140, y: 140 });
    const molecule = document.pages[0].objects.find(object => object.type === "molecule")!;
    const atom = molecule.atoms[0];
    const repeat = toggleBracketRepeatUnit(insertNativeBracket(document,
      { x: atom.x - 5, y: atom.y - 10 }, "square", { x: atom.x + 5, y: atom.y + 10 }));
    expect(bracketObjects(repeat).every(object => object.containedObjectIds.length === 0)).toBe(true);
    expect(copyAsMolfile(repeat, "v3000")).toContain("SRU 0 ATOMS=(1 1) XBONDS=(1 1) LABEL=n CONNECT=EU");
    const warnings: string[] = [];
    expect(await copyAsSmiles(repeat, warnings)).toBe("CC");
    expect(warnings).toEqual([expect.stringContaining("repeat unit n around 1 atoms")]);
    const repeatedMolecule = repeat.pages[0].objects.find(object => object.type === "molecule")!;
    expect(repeatedMolecule.atoms).toEqual(molecule.atoms);
    expect(repeatedMolecule.bonds).toEqual(molecule.bonds);
  });

  it("keeps merged SRU membership without a graph-only loss warning in MOL", () => {
    let document = applySingleBondToolAtPoint(createPhase4Document("Two members"), { x: 140, y: 140 });
    document = applySingleBondToolAtPoint(document, { x: 220, y: 140 });
    const repeat = toggleBracketRepeatUnit(insertNativeBracket(document,
      { x: 100, y: 100 }, "round", { x: 300, y: 200 }));
    const warnings: string[] = [];
    expect(copyAsMolfile(repeat, "v3000", warnings)).toContain("SRU 0 ATOMS=(4 1 2 3 4) LABEL=n CONNECT=EU");
    // The merged SRU represents both member molecules, so neither needs a one-copy loss warning.
    expect(warnings).toEqual([]);
  });

  it.each(["square", "round"] as const)("leaves ordinary %s exports unchanged, writes SRU and warns for SMILES", async kind => {
    const molecule = applySingleBondToolAtPoint(createPhase4Document("Unit"), { x: 140, y: 140 });
    const plain = insertNativeBracket(molecule, { x: 100, y: 100 }, kind, { x: 260, y: 200 });
    const beforeWarnings: string[] = [];
    copyAsMolfile(plain, "v3000", beforeWarnings);
    expect(beforeWarnings).toEqual([]);
    expect(repeatUnitExportWarnings(plain, "SMILES")).toEqual([]);
    const repeat = applyPatch(toggleBracketRepeatUnit(plain), { op: "setSelection", objectIds: [] });
    const repeatedMolecule = repeat.pages[0].objects.find(object => object.type === "molecule")!;
    const plainMolecule = molecule.pages[0].objects.find(object => object.type === "molecule")!;
    expect(repeatedMolecule.atoms).toEqual(plainMolecule.atoms);
    expect(repeatedMolecule.bonds).toEqual(plainMolecule.bonds);
    expect(repeatedMolecule.chemistry).toEqual({ ...plainMolecule.chemistry, warnings: [expect.objectContaining({ code: "chemistry.bracket_multiplier" })] });
    for (const flavor of ["v2000", "v3000"] as const) {
      const warnings: string[] = [];
      const contents = copyAsMolfile(repeat, flavor, warnings);
      expect(copyAsMolfile(plain, flavor)).toBe(copyAsMolfile(molecule, flavor));
      // Both MOL flavors encode the SRU; only graph-only exports lose its polymer semantics.
      expect(warnings).toEqual([]);
      expect(contents).toContain(flavor === "v3000" ? "SRU 0 ATOMS=(2 1 2) LABEL=n CONNECT=EU" : "  1 SRU");
      expect(contents).toContain(flavor === "v3000" ? "BEGIN SGROUP" : "M  SMT   1 n");
    }
    const smilesWarnings: string[] = [];
    expect(await copyAsSmiles(repeat, smilesWarnings)).toBe("CC");
    expect(smilesWarnings).toHaveLength(1);
    expect(smilesWarnings[0]).toContain("SMILES cannot hold the repeat unit n around 2 atoms");
    for (const writer of [exportStructureListSmi, exportStructureListSdf]) {
      const result = await writer(repeat);
      expect(result.contents.length).toBeGreaterThan(0);
      const omission = expect.objectContaining({ code: "export.repeat_unit_not_represented",
        message: expect.stringContaining("SMILES cannot hold the repeat unit n around 2 atoms") });
      // SDF also retains the low-level writer's one-copy chemistry context alongside its
      // graph-only SMILES property's omission warning; its connection table now carries SRU.
      expect(result.warnings).toEqual(writer === exportStructureListSdf ? [expect.objectContaining({
        code: "export.sdf_v2000_loss", message: expect.stringContaining("inside a repeat unit n")
      }), omission] : [omission]);
    }
    expect((await exportStructureListSdf(repeat)).contents).toContain("  1 SRU");
    await expect(copyAsSmiles(repeat)).resolves.toBe("CC");
  });

  it.each([false, true])("does not warn for an unrelated selected molecule (pair on another page: %s)", async anotherPage => {
    const repeat = repeatAroundMolecule();
    const withOther = applySingleBondToolAtPoint(repeat, { x: 400, y: 400 });
    const selectedMolecule = withOther.pages[0].objects.find(object => object.type === "molecule" && withOther.selection.objectIds.includes(object.id))!;
    const document = anotherPage ? { ...withOther, pages: [
      { ...withOther.pages[0], objects: [selectedMolecule] },
      { ...repeat.pages[0], id: "other_page" }
    ] } : withOther;
    const warnings: string[] = [];
    expect(copyAsMolfile(document, "v3000", warnings)).toBeDefined();
    expect(await copyAsSmiles(document, warnings)).toBe("CC");
    expect(warnings).toEqual([]);
    for (const writer of [exportStructureListSmi, exportStructureListSdf]) expect((await writer(document)).warnings).toEqual([]);
  });

  it("warns for exported members even when the pair is outside the export selection", () => {
    const repeat = repeatAroundMolecule();
    const molecule = repeat.pages[0].objects.find(object => object.type === "molecule")!;
    expect(repeatUnitExportWarnings(repeat, "MOL", { objects: [molecule], molecules: [molecule] })).toHaveLength(1);
    expect(repeatUnitExportWarnings(repeat, "MOL", { objects: bracketObjects(repeat), molecules: [] })).toEqual([]);
    // Selecting just the molecule must still report the semantic loss of its repeat brackets.
    expect(repeatUnitExportWarnings(repeat, "SMILES", { molecules: [molecule] })).toHaveLength(1);
    expect(repeatUnitExportWarnings(repeat, "MOL", { molecules: [] })).toEqual([]);
    expect(repeatUnitExportWarnings(repeat, "MOL")).toHaveLength(1);
    const enclosed = { ...repeat, pages: [{ ...repeat.pages[0], objects: repeat.pages[0].objects.map(object =>
      object.type === "bracket" ? { ...object, containedObjectIds: [] } : object) }] };
    expect(repeatUnitExportWarnings(enclosed, "MOL")).toHaveLength(1);
    const outside = { ...enclosed, pages: [{ ...enclosed.pages[0], objects: enclosed.pages[0].objects.map(object =>
      object.type === "molecule" ? { ...object, x: 400, y: 400, atoms: object.atoms.map(atom => ({ ...atom, x: atom.x + 400, y: atom.y + 400 })) } : object) }] };
    // An empty native unit is unresolved too; full-page exports must retain its diagnostic.
    expect(repeatUnitExportWarnings(outside, "MOL")).toEqual([expect.objectContaining({
      objectId: bracketObjects(outside).find(object => object.side === "close")!.id,
      message: expect.stringContaining("its atom membership cannot be resolved: its atom membership is empty")
    })]);
  });

  it("stays quiet when an included pair contains only molecules excluded from the export", async () => {
    const repeat = repeatAroundMolecule();
    const withOther = applySingleBondToolAtPoint(repeat, { x: 400, y: 400 });
    const scoped = applyPatch(withOther, { op: "setSelection", objectIds: [
      ...withOther.selection.objectIds, ...bracketObjects(repeat).map(object => object.id)
    ] });
    const warnings: string[] = [];
    expect(copyAsMolfile(scoped, "v3000", warnings)).toBeDefined();
    expect(await copyAsSmiles(scoped, warnings)).toBe("CC");
    expect(warnings).toEqual([]);
    for (const writer of [exportStructureListSmi, exportStructureListSdf]) expect((await writer(scoped)).warnings).toEqual([]);
  });
});
