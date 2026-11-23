import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Molecule } from "openchemlib";
import { atomProblem, moleculeSmiles, nativeAtomValidationState, nativeAtomLabelReading, nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles } from "@chemdraft/document-workflow-core";
import { exportDocumentToCdxml } from "@chemdraft/cdx-compat";
import type { ExportWarning } from "@chemdraft/export-engine";
import { atomDisplayLabel } from "@chemdraft/layout-engine";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { analyzeStructure, type AnalysisInputFormat } from "../../../packages/rdkit-adapter/src/analysis";
import { resetRdkitForTesting } from "../../../packages/rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/testing";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { allShellCommands } from "./commands";
import { createCoreCommandRegistrar } from "./commands/coreCommandRegistrar";
import { atomProblemCommandId, atomProblemCommands } from "./atomProblemCommands";
import {
  analysisFacingStructure,
  applyChargeToolAtNativeAtom,
  applyFreeformSingleBondToolAtPoint,
  applyMoleculeAtomLabelStylePatch,
  applyMoleculeObjectColorToSelection,
  applyNativeAtomElementTarget,
  applyNativeAtomProblemFix,
  commitNativeAtomLabelTarget,
  copyAsMolfile,
  applyNativeMoleculeBondOrderValueTarget,
  createNativeSavePayload,
  createSelectionClipboardPayload,
  duplicateSelectedDocumentObjects,
  insertNativeSingleBondMolecule,
  moveNativeMoleculeParts,
  nativeMoleculeInvalidAtomStates,
  normalizeCommittedDocument,
  openNativeDocument,
  pasteSelectionClipboardPayload,
  reconcileNativeChargeMarks,
  rotateSelectedDocumentObjects90
} from "./documentWorkflow";
import { applyPatches, applyPatchWithHistory, createDocumentHistory, createEmptyDocument, nativeDrawingStyleFromObjectStyle, redo, serializeDocument, undo,
  type ChemDraftDocument, type DocumentHistory, type MoleculeObject } from "@chemdraft/chem-core";
import { buildDocumentSessionEnvelope, parseDocumentSessionEnvelope } from "./documentSession";
import { restoreSessionWarningReports } from "./openWarnings";
import { problemDocument, problemMolecule } from "./testSupport/atomProblemFixtures";
import { DialogCoordinator } from "./dialogs/DialogCoordinator";
import { dialogEnvelope, parseDialogMessage, type AtomProblemSnapshot, type DialogMessage } from "./dialogs/dialogProtocol";
import type { DialogTransport } from "./dialogs/dialogTransport";

const canonical = (smiles: string) => Molecule.fromSmiles(smiles).toIsomericSmiles();
describe("atom problem suggestions", () => {
  it("accepts a scheme NaOH ion pair without suggesting atom fixes", () => {
    const molecule = problemMolecule("NaOH", []);
    molecule.atoms[0]!.schemeAbbreviation = "NaOH";
    expect(nativeAtomValidationState(molecule.atoms[0]!, molecule.bonds, 0, molecule.atoms).valid).toBe(true);
    expect(atomProblem(molecule, "a0")).toBeUndefined();
  });
  it.each([
    ["add H", problemMolecule("S", ["O", "C"], ["double", "single"]), "hydrogens", "C[SH]=O", 0, 1],
    ["remove H", problemMolecule("OH2"), "hydrogens", "CO", 0, 1],
    ["charge", problemMolecule("N", ["C", "C", "C", "C"]), "charge", "C[N+](C)(C)C", 1, undefined],
    ["Ru pincer", problemMolecule("N", ["Ru", "C", "C"], ["double", "single", "single"]), "charge", "C[N+](C)=[Ru]", 1, undefined]
  ] as const)("%s uses only the justified change and preserves its graph", (_name, molecule, action, smiles, charge, hydrogens) => {
    const before = problemDocument(molecule);
    const unchanged = JSON.stringify(before);
    const problem = atomProblem(molecule, "a0")!;
    expect(JSON.stringify(before)).toBe(unchanged); // Opening/probing is read-only.
    expect(problem.state.valid).toBe(false);
    const result = applyNativeAtomProblemFix(before, molecule.id, "a0", action)!;
    const updated = result.document.pages[0]!.objects[0]!;
    if (updated.type !== "molecule") throw new Error("Expected molecule");
    expect(result.label).toBe(problem.fixes.find(f => f.action === action)!.label);
    expect(updated.atoms[0]!.formalCharge).toBe(charge);
    if (hydrogens !== undefined) expect(nativeAtomLabelReading(updated.atoms[0]!.element)).toMatchObject({ kind: "spelled", hydrogens });
    expect(nativeAtomValidationState(updated.atoms[0]!, updated.bonds, charge, updated.atoms).valid).toBe(true);
    expect(canonical(nativeSingleBondGraphSmiles(updated.atoms, updated.bonds))).toBe(canonical(smiles));
    expect(updated.bonds).toEqual(molecule.bonds);
    expect(updated.atoms.map(a => [a.id, a.x, a.y])).toEqual(molecule.atoms.map(a => [a.id, a.x, a.y]));
    expect(result.document.selection.objectIds).toEqual([molecule.id]);
  });
  it("never offers a speculative charge or H fix for five-bond carbon or an unknown label", () => {
    for (const molecule of [problemMolecule("C", Array(5).fill("C")), problemMolecule("Qq")]) {
      expect(atomProblem(molecule, "a0")!.fixes.map(f => f.action)).toEqual(["ignore"]);
      expect(applyNativeAtomProblemFix(problemDocument(molecule), molecule.id, "a0", "charge")).toBeUndefined();
    }
  });
  it("changes only the stated H count of a composite label and preserves its methyl group", () => {
    const molecule = problemMolecule("NH2Me", ["C", "C"]);
    const result = applyNativeAtomProblemFix(problemDocument(molecule), molecule.id, "a0", "hydrogens")!;
    const updated = result.document.pages[0]!.objects[0]!;
    if (updated.type !== "molecule") throw new Error("Expected molecule");
    expect(atomProblem(updated, "a0")).toBeUndefined();
    expect(nativeAtomLabelReading(updated.atoms[0]!.element)).toMatchObject({ kind: "group" });
    expect(canonical(nativeSingleBondGraphSmiles(updated.atoms, updated.bonds))).toBe(canonical("CN(C)C"));
  });
  it("settles an inferred aromatic H with an explicit count through the same patch path", () => {
    const molecule = problemMolecule("N", ["C", "C", "C", "C"]);
    molecule.bonds = molecule.atoms.map((atom, i, atoms) => ({ id: `r${i}`, fromAtomId: atom.id,
      toAtomId: atoms[(i + 1) % atoms.length]!.id, order: "aromatic" }));
    expect(atomProblem(molecule, "a0")!.state).toMatchObject({ tautomerGuessed: true });
    const result = applyNativeAtomProblemFix(problemDocument(molecule), molecule.id, "a0", "hydrogens")!;
    const updated = result.document.pages[0]!.objects[0]!;
    if (updated.type !== "molecule") throw new Error("Expected molecule");
    expect(updated.atoms[0]!.hydrogenCount).toBe(1);
    expect(atomProblem(updated, "a0")).toBeUndefined();
    expect(canonical(nativeSingleBondGraphSmiles(updated.atoms, updated.bonds))).toBe(canonical("c1cc[nH]c1"));
  });
  it("Ignore/Restore keep the raw diagnostic and never change chemical identity", () => {
    const molecule = problemMolecule("N", Array(4).fill("C"));
    const ignored = applyNativeAtomProblemFix(problemDocument(molecule), molecule.id, "a0", "ignore")!.document;
    const suppressed = ignored.pages[0]!.objects[0]!;
    if (suppressed.type !== "molecule") throw new Error("Expected molecule");
    expect(atomProblem(suppressed, "a0")!.state).toMatchObject({ valid: false, warningSuppressed: true });
    expect(atomProblem(suppressed, "a0")!.fixes.map(f => f.action)).toContain("restore");
    const restored = applyNativeAtomProblemFix(ignored, molecule.id, "a0", "restore")!.document.pages[0]!.objects[0]!;
    if (restored.type !== "molecule") throw new Error("Expected molecule");
    expect(restored.atoms).toEqual(molecule.atoms);
    expect(nativeSingleBondGraphSmiles(suppressed.atoms, suppressed.bonds)).toBe(nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds));
  });
  it("exposes value-encoded atom commands in the shared catalog and registers one invocation", async () => {
    const document = problemDocument();
    const command = atomProblemCommands(document).find(c => c.action === "open")!;
    expect(allShellCommands(document)).toContainEqual(command.spec);
    const run = vi.fn();
    const bindings = new Map([[command.spec.id, { spec: command.spec, run }]]);
    const registry = new CommandRegistry();
    const sync = createCoreCommandRegistrar(registry, () => bindings);
    sync(bindings); sync(bindings);
    await registry.invoke(command.spec.id);
    expect(run).toHaveBeenCalledTimes(1);
    expect(command.spec.id).toBe(atomProblemCommandId(command.target));
    expect(atomProblemCommandId({ objectId: "a.b", atomId: "c" })).not.toBe(atomProblemCommandId({ objectId: "a", atomId: "b.c" }));
  });
});

const data: AtomProblemSnapshot = { title: "Drawing", explanation: "N has charge 0, expected 1 for valence 4.", targetVersion: 1,
  fixes: [{ action: "charge", label: "Set formal charge to +1" }, { action: "ignore", label: "Ignore warning" }] };
function dialogHost() {
  const registration = { hostId: "opaque", windowLabel: "dialog-main-atomProblem-1" };
  const transport: DialogTransport = { subscribe: vi.fn(async () => () => {}), open: vi.fn(async () => registration), publish: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const owner = { applyPageSize: vi.fn(), fixAtomProblem: vi.fn(), onError: vi.fn() };
  const coordinator = new DialogCoordinator(transport, owner);
  const message = (type: "ready" | "action", d: object, requestId = crypto.randomUUID()) => ({ ...dialogEnvelope(vi.mocked(transport.open).mock.calls[0]![0]), requestId, type, data: d }) as DialogMessage;
  const deliver = (m: DialogMessage) => coordinator.receive({ senderWindowId: registration.windowLabel, windowLabel: registration.windowLabel, message: m });
  return { transport, owner, coordinator, message, deliver };
}
describe("atom problem native host policy", () => {
  it("serializes concurrent opens across tabs and closes the previous session", async () => {
    const h = dialogHost();
    try {
      await Promise.all([h.coordinator.openAtomProblem("first", data), h.coordinator.openAtomProblem("second", data)]);
      expect(h.transport.open).toHaveBeenCalledTimes(2);
      expect(h.transport.close).toHaveBeenCalledExactlyOnceWith("opaque", "close");
    } finally { await h.coordinator.dispose(); }
  });
  it("retargets the retained window, rejects stale actions, and handles repeated actions once", async () => {
    const h = dialogHost();
    try {
      await h.coordinator.openAtomProblem("tab", data);
      await h.deliver(h.message("ready", {}));
      await h.coordinator.openAtomProblem("tab", { ...data, targetVersion: 2 });
      const opens = vi.mocked(h.transport.open).mock.calls;
      expect(opens).toHaveLength(2);
      expect(opens[1]![0].sessionId).toBe(opens[0]![0].sessionId);
      expect(h.transport.close).not.toHaveBeenCalled();
      await h.deliver(h.message("action", { action: "charge", targetVersion: 1 }));
      expect(h.owner.fixAtomProblem).not.toHaveBeenCalled();
      expect(h.transport.publish).toHaveBeenLastCalledWith("opaque", expect.objectContaining({ type: "result", data: expect.objectContaining({ status: "error" }) }));
      const action = h.message("action", { action: "charge", targetVersion: 2 });
      await Promise.all([h.deliver(action), h.deliver(action)]);
      expect(h.owner.fixAtomProblem).toHaveBeenCalledExactlyOnceWith("tab", "charge", 2);
      await h.deliver(h.message("action", { action: "ignore", targetVersion: 2 }));
      expect(h.owner.fixAtomProblem).toHaveBeenCalledTimes(2);
      await h.coordinator.updateAtomProblem("tab", { ...data, targetVersion: 3, explanation: "Another problem remains.", fixes: [{ action: "charge", label: "Set formal charge to +1" }] });
      expect(h.transport.publish).toHaveBeenLastCalledWith("opaque", expect.objectContaining({ type: "snapshot", data: expect.objectContaining({ targetVersion: 3, explanation: "Another problem remains." }) }));
      expect(h.transport.close).not.toHaveBeenCalled();
      await h.deliver(h.message("action", { action: "charge", targetVersion: 2 }));
      expect(h.owner.fixAtomProblem).toHaveBeenCalledTimes(2);
      expect(h.transport.publish).toHaveBeenLastCalledWith("opaque", expect.objectContaining({ type: "result", data: expect.objectContaining({ status: "error" }) }));
      const publishesBeforeClose = vi.mocked(h.transport.publish).mock.calls.length;
      await h.coordinator.updateAtomProblem("tab", { ...data, targetVersion: 4, explanation: "No problem.", fixes: [] });
      expect(h.transport.publish).toHaveBeenCalledTimes(publishesBeforeClose);
      expect(h.transport.close).toHaveBeenCalledExactlyOnceWith("opaque", "close");
      await h.coordinator.closeTab("tab");
      expect(h.transport.close).toHaveBeenCalledExactlyOnceWith("opaque", "close");
    } finally { await h.coordinator.dispose(); }
  });
  it("uses the restricted dialog host and fails closed on unsupported payloads", () => {
    const h = dialogHost();
    const capability = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/dialog-host.json", import.meta.url), "utf8"));
    expect(capability.windows).toContain("dialog-main-atomProblem-*");
    expect(capability.permissions).toEqual(["allow-dialog-request", "allow-dialog-send"]);
    const source = readFileSync(new URL("./MainWindow.tsx", import.meta.url), "utf8");
    expect(source).toContain("coordinator.openAtomProblem(tabId, data)");
    expect(source).not.toContain("<AtomProblemForm");
    const message = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab", dialogKind: "atomProblem", sessionId: "session", requestId: "request", snapshotRevision: 1, type: "snapshot", data };
    expect(parseDialogMessage(message)).toBeDefined();
    expect(parseDialogMessage({ ...message, data: { ...data, fixes: [{ action: "deleteBond", label: "Change chemistry" }] } })).toBeUndefined();
    expect(parseDialogMessage({ ...message, data: { ...data, path: "/private" } })).toBeUndefined();
    expect(h.transport.open).not.toHaveBeenCalled();
  });
});

// Owner ruling (1.2.3): a CDXML NumHydrogens that disagrees with the derived count is kept as written
// and badged. Ethanol whose O states 0 hydrogens, through the app's own open, save and edit paths.
const statedOxygenCdxml = `<CDXML><page id="1"><fragment id="2">
  <n id="10" p="100 100"/><n id="11" p="114 108"/><n id="12" p="128 100" Element="8" NumHydrogens="0"/>
  <b id="20" B="10" E="11"/><b id="21" B="11" E="12"/>
</fragment></page></CDXML>`;
const openedDocument = (contents = statedOxygenCdxml) => normalizeCommittedDocument(openNativeDocument(contents).document!);
const moleculesOf = (document: ChemDraftDocument) =>
  document.pages[0]!.objects.filter((object): object is MoleculeObject => object.type === "molecule");
const oxygenOf = (molecule: MoleculeObject) => molecule.atoms.find(atom => atom.element === "O")!;
const selecting = (document: ChemDraftDocument, objectIds: string[]): ChemDraftDocument =>
  ({ ...document, selection: { ...document.selection, objectIds } });
const bondTarget = (molecule: MoleculeObject, bondId: string) => {
  const bond = molecule.bonds.find(candidate => candidate.id === bondId)!;
  return { objectId: molecule.id, kind: "bond" as const, bondId, fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId, distanceToPointer: 0 };
};

describe("a CDXML atom whose stated hydrogen count disagrees, in the app", () => {
  it("opens with the stated 0 H and the badge; Save As writes NumHydrogens=\"0\" and reopens with it", () => {
    const document = openedDocument();
    const [molecule] = moleculesOf(document);
    const oxygen = oxygenOf(molecule!);
    expect(oxygen.hydrogenCount).toBe(0);
    expect(atomProblem(molecule!, oxygen.id)!.state).toMatchObject({ valid: false, statedHydrogens: { stated: 0, derived: 1 } });
    const saved = createNativeSavePayload(document);
    expect(saved.contents).toMatch(/<n [^>]*Element="8"[^>]*NumHydrogens="0"/);
    expect(saved.warnings.map(warning => warning.message)).toContain("O3 states 0 H, but its bonds and charge give 1.");
    expect(oxygenOf(moleculesOf(openedDocument(saved.contents))[0]!).hydrogenCount).toBe(0);
  });

  it("opens a file without NumHydrogens, or with an agreeing one, with nothing stored and no badge", () => {
    for (const contents of [statedOxygenCdxml.replace(' NumHydrogens="0"', ""), statedOxygenCdxml.replace('NumHydrogens="0"', 'NumHydrogens="1"')]) {
      const [molecule] = moleculesOrThrow(openedDocument(contents));
      expect(molecule.atoms.every(atom => atom.hydrogenCount === undefined)).toBe(true);
      expect(molecule.atoms.map(atom => atomProblem(molecule, atom.id))).toEqual([undefined, undefined, undefined]);
    }
  });

  it("keeps the count through a move, a rotation and a duplicate", () => {
    const document = openedDocument();
    const [molecule] = moleculesOrThrow(document);
    const oxygen = oxygenOf(molecule);
    const moved = moveNativeMoleculeParts(document, { objectId: molecule.id, kind: "atom", atomId: oxygen.id }, { x: 30, y: -12 });
    expect(oxygenOf(moleculesOrThrow(moved)[0]).hydrogenCount).toBe(0);
    expect(oxygenOf(moleculesOrThrow(moved)[0]).x).not.toBe(oxygen.x);
    const rotated = rotateSelectedDocumentObjects90(selecting(document, [molecule.id]));
    expect(oxygenOf(moleculesOrThrow(rotated)[0]).hydrogenCount).toBe(0);
    const duplicated = moleculesOrThrow(duplicateSelectedDocumentObjects(selecting(document, [molecule.id])));
    expect(duplicated).toHaveLength(2);
    expect(duplicated.map(copy => oxygenOf(copy).hydrogenCount)).toEqual([0, 0]);
  });

  it("a copied fragment keeps it while the O keeps its bond, and drops it when the copy cuts the O off", () => {
    const document = openedDocument();
    const [molecule] = moleculesOrThrow(document);
    const oxygen = oxygenOf(molecule);
    const oxygenBond = molecule.bonds.find(bond => bond.fromAtomId === oxygen.id || bond.toAtomId === oxygen.id)!;
    const neighbor = oxygenBond.fromAtomId === oxygen.id ? oxygenBond.toAtomId : oxygenBond.fromAtomId;
    const paste = (atomIds: string[], bondIds: string[]) => {
      const payload = createSelectionClipboardPayload(document, [{ objectId: molecule.id, atomIds, bondIds }])!;
      return moleculesOrThrow(pasteSelectionClipboardPayload(document, payload, { x: 300, y: 300 })).at(-1)!;
    };
    expect(oxygenOf(paste([oxygen.id, neighbor], [oxygenBond.id])).hydrogenCount).toBe(0);
    const lone = paste([oxygen.id], []);
    expect(lone.atoms).toHaveLength(1);
    expect(oxygenOf(lone).hydrogenCount).toBeUndefined();
  });

  it("drops it on a chemical edit of the O, and keeps it through one elsewhere", () => {
    const document = openedDocument();
    const [molecule] = moleculesOrThrow(document);
    const oxygen = oxygenOf(molecule);
    const oxygenBond = molecule.bonds.find(bond => bond.fromAtomId === oxygen.id || bond.toAtomId === oxygen.id)!;
    const otherBond = molecule.bonds.find(bond => bond !== oxygenBond)!;
    const relabeled = moleculesOrThrow(applyNativeAtomElementTarget(document,
      { objectId: molecule.id, kind: "atom", atomId: oxygen.id, distanceToPointer: 0 }, "S"))[0];
    expect(relabeled.atoms.find(atom => atom.id === oxygen.id)).toMatchObject({ element: "S" });
    expect(relabeled.atoms.find(atom => atom.id === oxygen.id)!.hydrogenCount).toBeUndefined();
    const carbonyl = moleculesOrThrow(applyNativeMoleculeBondOrderValueTarget(document, bondTarget(molecule, oxygenBond.id), "double"))[0];
    expect(oxygenOf(carbonyl).hydrogenCount).toBeUndefined();
    expect(atomProblem(carbonyl, oxygen.id)).toBeUndefined();
    const ethene = moleculesOrThrow(applyNativeMoleculeBondOrderValueTarget(document, bondTarget(molecule, otherBond.id), "double"))[0];
    expect(oxygenOf(ethene).hydrogenCount).toBe(0);
  });

  it("drops it when a radical is put on or taken off the O, or a write changes its isotope; keeps it through style", () => {
    const document = openedDocument();
    const [molecule] = moleculesOrThrow(document);
    const oxygen = oxygenOf(molecule);
    const target = { objectId: molecule.id, kind: "atom" as const, atomId: oxygen.id, distanceToPointer: 0 };
    const marksOf = (next: ChemDraftDocument) => next.pages[0]!.objects.filter(object => object.type === "electron-mark");
    // The radical tool: the mark's electron reaches the O through the charge-mark reconciliation.
    const radical = reconcileNativeChargeMarks(applyChargeToolAtNativeAtom(document, { kind: "radical-dot" }, target));
    expect(oxygenOf(moleculesOrThrow(radical)[0])).toMatchObject({ markRadicals: 1 });
    expect(oxygenOf(moleculesOrThrow(radical)[0]).hydrogenCount).toBeUndefined();
    // Taking a radical off: a file whose O carries a radical and states 1 H (it derives 0).
    const radicalFile = openedDocument(statedOxygenCdxml.replace('NumHydrogens="0"', 'Radical="Doublet" NumHydrogens="1"'));
    const radicalOxygen = oxygenOf(moleculesOrThrow(radicalFile)[0]);
    expect(radicalOxygen).toMatchObject({ markRadicals: 1, hydrogenCount: 1 });
    expect(marksOf(radicalFile)).toHaveLength(1);
    const unmarked = reconcileNativeChargeMarks(applyPatches(radicalFile, [{ op: "removeObject", objectId: marksOf(radicalFile)[0]!.id }]));
    expect(oxygenOf(moleculesOrThrow(unmarked)[0]).markRadicals).toBeUndefined();
    expect(oxygenOf(moleculesOrThrow(unmarked)[0]).hydrogenCount).toBeUndefined();
    // An isotope reaches an existing atom only through a write (a plugin's or the assistant's).
    const isotope = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes: {
      atoms: molecule.atoms.map(atom => atom.id === oxygen.id ? { ...atom, isotope: 18 } : atom) } }]);
    expect(oxygenOf(moleculesOrThrow(isotope)[0])).toMatchObject({ isotope: 18 });
    expect(oxygenOf(moleculesOrThrow(isotope)[0]).hydrogenCount).toBeUndefined();
    // Style, label placement and a label nudged by a write are not chemistry.
    const styled = applyMoleculeAtomLabelStylePatch(applyMoleculeObjectColorToSelection(document, "stroke", "#336699", [molecule.id]),
      [{ objectId: molecule.id, atomId: oxygen.id }], { atomLabelColor: "#cc0000", atomLabelPlacement: "above" });
    const nudged = applyPatches(styled, [{ op: "updateObject", objectId: molecule.id, changes: {
      atoms: moleculesOrThrow(styled)[0].atoms.map(atom => atom.id === oxygen.id ? { ...atom, labelOffset: { x: 3, y: -2 } } : atom) } }]);
    expect(moleculesOrThrow(nudged)[0].style).not.toEqual(molecule.style);
    expect(oxygenOf(moleculesOrThrow(nudged)[0])).toMatchObject({ hydrogenCount: 0, labelOffset: { x: 3, y: -2 } });
  });

  it("bonding another molecule to it keeps the O's count; the carbon the new bond reaches drops its own", () => {
    // The imported C1 states 2 H (it derives 3) and the O states 0. A drawn ethane is bonded to C1
    // with the bond tool, from either end: one molecule absorbs the other onto re-minted ids.
    const document = openedDocument(statedOxygenCdxml.replace('<n id="10" p="100 100"/>', '<n id="10" p="100 100" NumHydrogens="2"/>'));
    const [imported] = moleculesOrThrow(document);
    const [c1] = imported.atoms;
    expect(imported.atoms.map(atom => atom.hydrogenCount)).toEqual([2, undefined, 0]);
    const withEthane = insertNativeSingleBondMolecule(document, { x: 400, y: 400 });
    const ethane = moleculesOrThrow(withEthane).find(molecule => molecule.id !== imported.id)!;
    const ethaneEnd = ethane.atoms[1]!;
    const fromEthane = applyFreeformSingleBondToolAtPoint(withEthane, ethane.id, ethaneEnd.id, { x: c1!.x, y: c1!.y });
    const fromImported = applyFreeformSingleBondToolAtPoint(withEthane, imported.id, c1!.id, { x: ethaneEnd.x, y: ethaneEnd.y });
    for (const merged of [fromEthane, fromImported]) {
      const molecules = moleculesOrThrow(merged);
      expect(molecules).toHaveLength(1);
      const [molecule] = molecules;
      expect(molecule.atoms).toHaveLength(5);
      const oxygen = oxygenOf(molecule);
      const joined = molecule.atoms.find(atom => atom.x === c1!.x && atom.y === c1!.y)!;
      expect(molecule.bonds.filter(bond => bond.fromAtomId === joined.id || bond.toAtomId === joined.id)).toHaveLength(2);
      expect(oxygen.hydrogenCount).toBe(0);
      expect(joined.hydrogenCount).toBeUndefined();
      const style = nativeDrawingStyleFromObjectStyle(molecule.style);
      expect(atomDisplayLabel(oxygen, molecule.bonds, style, molecule.atoms)).toBe("O");
      expect(atomDisplayLabel(joined, molecule.bonds, style, molecule.atoms)).toBeUndefined();
      expect(nativeMoleculeInvalidAtomStates(molecule).map(state => state.atomId)).toEqual([oxygen.id]);
      expect(nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds).formula).toBe("C4H9O");
      expect(canonical(nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds))).toBe(canonical("CCCC[O]"));
    }
  });

  it("a plugin's one-patch merge keeps the same counts as the bond tool's merge", () => {
    // The same join as above, written as a plugin writes it: one updateObject of the ethane carrying
    // the imported atoms on re-minted ids and the joining bond together, and the import removed.
    const document = openedDocument(statedOxygenCdxml.replace('<n id="10" p="100 100"/>', '<n id="10" p="100 100" NumHydrogens="2"/>'));
    const [imported] = moleculesOrThrow(document);
    const c1 = imported.atoms[0]!;
    const withEthane = insertNativeSingleBondMolecule(document, { x: 400, y: 400 });
    const ethane = moleculesOrThrow(withEthane).find(molecule => molecule.id !== imported.id)!;
    const ethaneEnd = ethane.atoms[1]!;
    const id = (atomId: string) => `p_${atomId}`;
    const onePatch = applyPatches(withEthane, [
      { op: "updateObject", objectId: ethane.id, changes: {
        atoms: [...ethane.atoms, ...imported.atoms.map(atom => ({ ...atom, id: id(atom.id) }))],
        bonds: [
          ...ethane.bonds,
          ...imported.bonds.map(bond => ({ ...bond, id: id(bond.id), fromAtomId: id(bond.fromAtomId), toAtomId: id(bond.toAtomId) })),
          { id: "p_join", fromAtomId: ethaneEnd.id, toAtomId: id(c1.id), order: "single" as const }
        ]
      } },
      { op: "removeObject", objectId: imported.id }
    ]);
    const dragged = applyFreeformSingleBondToolAtPoint(withEthane, ethane.id, ethaneEnd.id, { x: c1.x, y: c1.y });
    const countsByPlace = (merged: ChemDraftDocument) => {
      const molecules = moleculesOrThrow(merged);
      expect(molecules).toHaveLength(1);
      return Object.fromEntries(molecules[0].atoms
        .filter(atom => imported.atoms.some(source => source.x === atom.x && source.y === atom.y))
        .map(atom => [`${atom.element}@${atom.x},${atom.y}`, atom.hydrogenCount]));
    };
    const expected = Object.fromEntries(imported.atoms.map(atom =>
      [`${atom.element}@${atom.x},${atom.y}`, atom.element === "O" ? 0 : undefined]));
    expect(countsByPlace(onePatch)).toEqual(expected);
    expect(countsByPlace(dragged)).toEqual(expected);
    const molecule = moleculesOrThrow(onePatch)[0];
    expect(molecule.atoms.find(atom => atom.id === ethaneEnd.id)!.hydrogenCount).toBeUndefined();
  });

  it("the problem window's hydrogen fix uses the derived count", () => {
    const document = openedDocument();
    const [molecule] = moleculesOrThrow(document);
    const oxygen = oxygenOf(molecule);
    expect(atomProblem(molecule, oxygen.id)!.fixes.map(fix => fix.label)).toEqual(["Use the derived hydrogen count (1)", "Ignore warning"]);
    const result = applyNativeAtomProblemFix(document, molecule.id, oxygen.id, "hydrogens")!;
    expect(result.label).toBe("Use the derived hydrogen count (1)");
    expect(result.status).toBe('Hydrogen count set to the derived 1 for "O"');
    const fixed = moleculesOrThrow(result.document)[0];
    expect(oxygenOf(fixed).hydrogenCount).toBeUndefined();
    expect(atomProblem(fixed, oxygen.id)).toBeUndefined();
    expect(canonical(nativeSingleBondGraphSmiles(fixed.atoms, fixed.bonds))).toBe(canonical("CCO"));
  });
});

// Owner ruling (1.2.3), confirmed: the stated count shows everywhere, exactly like a hand-drawn
// under-filled atom. The same ethanol, its O made under-filled by hand through the label editor (a
// typed "O", which the app keeps literal), is the reference: label, badge, formula, exact mass and
// SMILES must be equal, each read the way the app reads it (layout-engine's label, the validator's
// badge, RDKit for the formula, mass and SMILES through the structure the app hands the engine).
describe("a stated hydrogen count shows everywhere, as a hand-drawn under-filled atom does", () => {
  beforeAll(() => { installRealRdkitModuleLoader(); });
  afterAll(() => { resetRdkitForTesting(); });

  const plainCdxml = statedOxygenCdxml.replace(' NumHydrogens="0"', "");
  const handDrawn = () => {
    const document = openedDocument(plainCdxml);
    const [molecule] = moleculesOrThrow(document);
    const oxygen = oxygenOf(molecule);
    const typed = commitNativeAtomLabelTarget(document, { objectId: molecule.id, kind: "atom", atomId: oxygen.id, distanceToPointer: 0 },
      "O", { literal: true, replaceElement: true });
    return normalizeCommittedDocument(typed.document);
  };
  let runs = 0;
  async function reading(document: ChemDraftDocument) {
    const [molecule] = moleculesOrThrow(document);
    const style = nativeDrawingStyleFromObjectStyle(molecule.style);
    const { structureFormat, structure } = analysisFacingStructure(molecule);
    runs += 1;
    const run = await analyzeStructure({ format: structureFormat as AnalysisInputFormat, value: structure,
      runId: `stated-h-${runs}`, startedAt: "2026-11-22T12:00:00.000Z" });
    const composition = run.results.find((entry) => entry.id === "rdkit.composition");
    if (composition?.kind !== "composition") throw new Error(`no composition result (run status ${run.status})`);
    const mass = run.results.find((entry) => entry.id === "rdkit.monoisotopic-mass");
    if (mass?.kind !== "scalar") throw new Error(`no monoisotopic mass result (run status ${run.status})`);
    const exactMass = mass.value;
    const smilesWarnings: ExportWarning[] = [];
    const smiles = await moleculeSmiles(molecule, 0, smilesWarnings, computeStructureIdentifiers);
    // The metadata an edit stores on the molecule (a freshly opened file has none cached yet).
    const native = nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds);
    return {
      labels: molecule.atoms.map((atom) => atomDisplayLabel(atom, molecule.bonds, style, molecule.atoms)),
      badged: nativeMoleculeInvalidAtomStates(molecule).filter((state) => !state.warningSuppressed).map((state) => state.atomId),
      formula: composition.formula,
      storedFormula: native.formula,
      storedExactMass: native.exactMass,
      exactMass,
      smiles,
      smilesWarnings: smilesWarnings.map((warning) => [warning.code, warning.message])
    };
  }

  it("opened with the O stated at 0 H: label O, the badge, and RDKit's formula and SMILES for that O", async () => {
    const document = openedDocument();
    const [molecule] = moleculesOrThrow(document);
    const read = await reading(document);
    expect(read.labels).toEqual([undefined, undefined, "O"]);
    expect(read.badged).toEqual([oxygenOf(molecule).id]);
    expect(read.formula).toBe("C2H5O");
    expect(read.storedFormula).toBe("C2H5O");
    expect(read.smiles).toBe("CC[O]");
    // C2H5O: 2 × 12 + 5 × 1.00782503207 + 15.99491461956, RDKit's monoisotopic mass for the radical.
    expect(read.exactMass).toBeCloseTo(45.0340, 4);
    expect(read.storedExactMass).toBeCloseTo(45.0340, 4);
  });

  it("is identical to the same O made under-filled by hand", async () => {
    const typedDocument = handDrawn();
    const [typedMolecule] = moleculesOrThrow(typedDocument);
    expect(oxygenOf(typedMolecule)).toMatchObject({ labelLiteral: true });
    expect(oxygenOf(typedMolecule).hydrogenCount).toBeUndefined();
    const typed = await reading(typedDocument);
    const stated = await reading(openedDocument());
    expect(stated).toEqual(typed);
    expect(typed.badged).toEqual([oxygenOf(typedMolecule).id]);
  });

  // The atoms whose label draws no count of its own get the same treatment: a lone H or D stated
  // with 0 is a typed literal "H" or "D", and a carbon bonded only datively stated with n is the typed
  // "C" … "CH4" (the iron on its left, so the typed text and the drawn label put the H on the same
  // side). The badge's wording differs (stated count against typed label); whether it shows does not.
  const fragmentCdxml = (body: string) => `<CDXML><page id="1"><fragment id="2">${body}</fragment></page></CDXML>`;
  const typedAt = (contents: string, atomIndex: number, label: string) => {
    const document = openedDocument(contents);
    const [molecule] = moleculesOrThrow(document);
    return normalizeCommittedDocument(commitNativeAtomLabelTarget(document,
      { objectId: molecule.id, kind: "atom", atomId: molecule.atoms[atomIndex]!.id, distanceToPointer: 0 },
      label, { literal: true, replaceElement: true }).document);
  };
  const badgeWordingAside = (read: Awaited<ReturnType<typeof reading>>) => ({ ...read,
    smilesWarnings: read.smilesWarnings.map(([code, message]) => code === "export.invalid_structure" ? [code] : [code, message]) });
  it.each([
    ["a lone H stated with 0", '<n id="10" p="100 100" Element="1"/>', "H", { labels: ["H"], formula: "H", smiles: "[H]", badged: true }],
    ["a lone D stated with 0", '<n id="10" p="100 100" Element="1" Isotope="2"/>', "D", { labels: ["D"], formula: "D", smiles: "[2H]", badged: false }],
    ["a dative-only C stated with 0", '<n id="10" p="114 100"/><n id="11" p="100 100" Element="26"/><b id="20" B="10" E="11" Order="dative"/>', "C",
      { labels: ["C", "Fe"], formula: "CFe", smiles: "[C][Fe]", badged: true }],
    ["a dative-only C stated with 3", '<n id="10" p="114 100"/><n id="11" p="100 100" Element="26"/><b id="20" B="10" E="11" Order="dative"/>', "CH3",
      { labels: ["CH3", "Fe"], formula: "CH3Fe", smiles: "[CH3][Fe]", badged: true }]
  ] as const)("%s is identical to the same atom typed by hand", async (_name, body, typedLabel, expected) => {
    const statedCount = typedLabel === "CH3" ? 3 : 0;
    const statedBody = body.replace('<n id="10" p', `<n id="10" NumHydrogens="${statedCount}" p`);
    const statedDocument = openedDocument(fragmentCdxml(statedBody));
    expect(moleculesOrThrow(statedDocument)[0].atoms[0]!.hydrogenCount).toBe(statedCount);
    const typedDocument = typedAt(fragmentCdxml(body), 0, typedLabel);
    const stated = await reading(statedDocument);
    const typed = await reading(typedDocument);
    expect(badgeWordingAside(stated)).toEqual(badgeWordingAside(typed));
    expect(stated).toMatchObject({ labels: expected.labels, formula: expected.formula, storedFormula: expected.formula, smiles: expected.smiles });
    expect(stated.badged).toEqual(expected.badged ? [moleculesOrThrow(statedDocument)[0].atoms[0]!.id] : []);
    // Plain, the same atoms count what their bonds give: H2, HD and CH4Fe.
    expect((await reading(openedDocument(fragmentCdxml(body)))).formula).toBe({ H: "H2", D: "HD", C: "CH4Fe", CH3: "CH4Fe" }[typedLabel]);
    if (typedLabel === "CH3") return; // Copy As MOL writes a typed "CH3" as a dummy atom; the engine spells it.
    for (const flavor of ["v2000", "v3000"] as const) {
      expect(copyAsMolfile(statedDocument, flavor, [])).toBe(copyAsMolfile(typedDocument, flavor, []));
    }
  });

  // Master decision 2026-11-22 (refined): typed text that differs from the label drawn for the atom
  // wins, so a retype through the label editor drops the O's stated count and the O is then exactly
  // the label that was typed; undo brings the stated count back. Typed text equal to the drawn label
  // ("O" over the drawn "O") says nothing new and changes nothing.
  const retyped = (label: string, document = openedDocument()) => {
    const [molecule] = moleculesOrThrow(document);
    return normalizeCommittedDocument(commitNativeAtomLabelTarget(document,
      { objectId: molecule.id, kind: "atom", atomId: oxygenOf(molecule).id, distanceToPointer: 0 },
      label, { literal: true, replaceElement: true }).document);
  };
  const retypedOxygen = (document: ChemDraftDocument) => {
    const [molecule] = moleculesOrThrow(document);
    return molecule.atoms[2]!;
  };

  it("retyping \"OH\" over the O stated at 0 H drops the count: label OH, C2H6O, CCO, no badge", async () => {
    const document = retyped("OH");
    expect(retypedOxygen(document)).toMatchObject({ element: "OH", labelLiteral: true });
    expect(retypedOxygen(document).hydrogenCount).toBeUndefined();
    const read = await reading(document);
    expect(read).toMatchObject({ labels: [undefined, undefined, "OH"], badged: [], formula: "C2H6O", storedFormula: "C2H6O", smiles: "CCO", smilesWarnings: [] });
    const [molecule] = moleculesOrThrow(document);
    expect(atomProblem(molecule, retypedOxygen(document).id)).toBeUndefined();
  });

  it("retyping \"O\" over the drawn O stated at 0 H changes nothing: the count, label, badge, formula and SMILES stay", async () => {
    const document = openedDocument();
    const [molecule] = moleculesOrThrow(document);
    expect((await reading(document)).labels[2]).toBe("O");
    const result = commitNativeAtomLabelTarget(document,
      { objectId: molecule.id, kind: "atom", atomId: oxygenOf(molecule).id, distanceToPointer: 0 },
      "O", { literal: true, replaceElement: true });
    expect(result.document).toBe(document);
    expect(result.refusal).toBeUndefined();
    const committed = normalizeCommittedDocument(result.document);
    expect(retypedOxygen(committed)).toEqual(oxygenOf(molecule));
    expect(retypedOxygen(committed)).toMatchObject({ element: "O", hydrogenCount: 0 });
    const read = await reading(committed);
    expect(read).toEqual(await reading(document));
    expect(read).toMatchObject({ labels: [undefined, undefined, "O"], formula: "C2H5O", smiles: "CC[O]", badged: [oxygenOf(molecule).id] });
    expect(atomProblem(moleculesOrThrow(committed)[0], oxygenOf(molecule).id)!.state)
      .toMatchObject({ statedHydrogens: { stated: 0, derived: 1 } });
  });

  it("\"O\" typed over a plain O, drawn \"OH\", is the hand-typed O: the typed text differs from the drawn label", async () => {
    const plain = openedDocument(plainCdxml);
    expect((await reading(plain)).labels[2]).toBe("OH");
    const document = retyped("O", plain);
    expect(retypedOxygen(document)).toEqual(retypedOxygen(handDrawn()));
    expect(await reading(document)).toMatchObject({ formula: "C2H5O", smiles: "CC[O]", badged: [retypedOxygen(document).id] });
  });

  it("undo of the \"OH\" retype restores the stated count exactly", () => {
    const document = openedDocument();
    const [molecule] = moleculesOrThrow(document);
    for (const label of ["OH"]) {
      // The app's history keeps whole committed documents; undo puts the one before the retype back.
      const committed = normalizeCommittedDocument(commitNativeAtomLabelTarget(document,
        { objectId: molecule.id, kind: "atom", atomId: oxygenOf(molecule).id, distanceToPointer: 0 },
        label, { literal: true, replaceElement: true }).document);
      const after: DocumentHistory = { ...createDocumentHistory(document), past: [document], present: committed };
      expect(retypedOxygen(after.present).hydrogenCount).toBeUndefined();
      const undone = undo(after);
      expect(undone.present).toBe(document);
      expect(retypedOxygen(undone.present)).toEqual(oxygenOf(molecule));
      expect(retypedOxygen(undone.present)).toMatchObject({ element: "O", hydrogenCount: 0 });
      expect(retypedOxygen(undone.present).labelLiteral).toBeUndefined();
      expect(atomProblem(moleculesOrThrow(undone.present)[0], oxygenOf(molecule).id)!.state)
        .toMatchObject({ statedHydrogens: { stated: 0, derived: 1 } });
    }
  });

  it("a style-only change keeps the stated count", async () => {
    const document = openedDocument();
    const [molecule] = moleculesOrThrow(document);
    const styled = normalizeCommittedDocument(applyMoleculeAtomLabelStylePatch(applyMoleculeObjectColorToSelection(document, "stroke", "#336699", [molecule.id]),
      [{ objectId: molecule.id, atomId: oxygenOf(molecule).id }], { atomLabelColor: "#cc0000" }));
    expect(oxygenOf(moleculesOrThrow(styled)[0])).toMatchObject({ hydrogenCount: 0 });
    expect(oxygenOf(moleculesOrThrow(styled)[0]).labelLiteral).toBeUndefined();
    const read = await reading(styled);
    expect(read).toMatchObject({ formula: "C2H5O", smiles: "CC[O]", badged: [oxygenOf(molecule).id] });
  });

  it("\"Use the derived hydrogen count\" gives OH, C2H6O and CCO", async () => {
    const document = openedDocument();
    const [molecule] = moleculesOrThrow(document);
    const fixed = normalizeCommittedDocument(applyNativeAtomProblemFix(document, molecule.id, oxygenOf(molecule).id, "hydrogens")!.document);
    const read = await reading(fixed);
    expect(read).toMatchObject({ labels: [undefined, undefined, "OH"], badged: [], formula: "C2H6O", storedFormula: "C2H6O", smiles: "CCO", smilesWarnings: [] });
    expect(read).toEqual(await reading(openedDocument(plainCdxml)));
  });

  it("leaves a file without NumHydrogens, or with agreeing ones, as it was", async () => {
    const agreeing = statedOxygenCdxml.replace('NumHydrogens="0"', 'NumHydrogens="1"').replace('<n id="10" p="100 100"/>', '<n id="10" p="100 100" NumHydrogens="3"/>');
    for (const contents of [plainCdxml, agreeing]) {
      expect(await reading(openedDocument(contents))).toMatchObject({
        labels: [undefined, undefined, "OH"], badged: [], formula: "C2H6O", storedFormula: "C2H6O", smiles: "CCO", smilesWarnings: []
      });
    }
  });

  it("exports the stated count as the hand-drawn O is exported: MOL valence, CDXML and SMILES, each with its warning", async () => {
    const stated = openedDocument();
    const typed = handDrawn();
    for (const flavor of ["v2000", "v3000"] as const) {
      const statedWarnings: string[] = [];
      const typedWarnings: string[] = [];
      const statedMolfile = copyAsMolfile(stated, flavor, statedWarnings)!;
      expect(statedMolfile).toBe(copyAsMolfile(typed, flavor, typedWarnings));
      expect(statedMolfile).toMatch(flavor === "v2000" ? /^.{31}O {3}0 {2}0 {2}0 {2}0 {2}0 {2}1/m : /V30 3 O [^\n]* VAL=1/);
      expect(statedWarnings).toEqual(["O3 states 0 H, but its bonds and charge give 1."]);
      expect(typedWarnings).toHaveLength(1);
    }
    // CDXML, plain (no ChemDraft payload) as another program reads it: reopened, both read the same.
    for (const document of [stated, typed]) {
      const plain = exportDocumentToCdxml(document, { embedNativePayload: false });
      expect(await reading(openedDocument(plain.contents))).toEqual(await reading(stated));
    }
    expect(exportDocumentToCdxml(stated, { embedNativePayload: false }).contents).toMatch(/<n [^>]*Element="8"[^>]*NumHydrogens="0"/);
    // SMILES: the radical the bare [O] implies is reported, for both, instead of a silent CCO.
    const read = await reading(stated);
    expect(read.smilesWarnings).toEqual([[
      "export.smiles_radical_loss", `Atom ${oxygenOf(moleculesOrThrow(stated)[0]).id} (O) is drawn with 0 radical electrons; SMILES reparses with 1 radical electron.`
    ]]);
  });
});

// A native document written before plugin and assistant writes were refused such a count: an H atom
// on ethane stating 1 H, and a D stating 0. Nothing in the app refuses it: it opens, restores, pastes,
// duplicates and undoes as stored, round-trips unchanged, and the H is flagged with the native twin of
// the CDXML importer's "not kept" warning, since no label, formula or export counts it.
describe("an H atom a native document stores a hydrogen count on, in the app", () => {
  const notCounted = {
    code: "document.atom_hydrogen_count_not_counted",
    message: "ChemDraft document: atom h (H) states 1 hydrogen, which a hydrogen atom cannot carry: only 0 counts, as a typed H, D " +
      "or T label means. The stated count is kept as stored but not counted, and the atom is flagged.",
    sourceObjectId: "mol_h",
    atomIds: ["h"]
  };
  const stored = (): ChemDraftDocument => {
    const document = createEmptyDocument();
    document.pages[0]!.objects.push({ id: "mol_h", type: "molecule", x: 100, y: 100, width: 50, height: 10, rotation: 0, style: {},
      structureFormat: "molfile-v2000", structure: "", superatoms: [], rGroups: [],
      atoms: [{ id: "c1", element: "C", x: 100, y: 100, formalCharge: 0 }, { id: "c2", element: "C", x: 114, y: 108, formalCharge: 0 },
        { id: "h", element: "H", x: 128, y: 100, formalCharge: 0, hydrogenCount: 1 },
        { id: "d", element: "D", x: 100, y: 84, formalCharge: 0, hydrogenCount: 0 }],
      bonds: [{ id: "b1", fromAtomId: "c1", toAtomId: "c2", order: "single" }, { id: "b2", fromAtomId: "c2", toAtomId: "h", order: "single" },
        { id: "b3", fromAtomId: "c1", toAtomId: "d", order: "single" }] });
    return document;
  };
  const atomOf = (molecule: MoleculeObject, id: string) => molecule.atoms.find(atom => atom.id === id)!;
  const expectFlagged = (molecule: MoleculeObject) => {
    expect(atomOf(molecule, "h").hydrogenCount).toBe(1);
    expect(atomOf(molecule, "d").hydrogenCount).toBe(0);
    const problem = atomProblem(molecule, "h")!;
    expect(problem.state).toMatchObject({ valid: false, hydrogenCountNotCounted: true, statedHydrogens: { stated: 1, derived: 0 },
      invalidReason: "H states 1 H, which a hydrogen atom cannot carry; only 0 counts." });
    expect(problem.fixes.map(fix => fix.label)).toEqual(["Use the derived hydrogen count (0)", "Ignore warning"]);
    expect(atomProblem(molecule, "d")).toBeUndefined();
  };

  it("a .chemdraft holding it opens with the count kept, the warning and the badge, and saves and reopens it unchanged", () => {
    for (const contents of [serializeDocument(stored()), createNativeSavePayload(stored()).contents]) {
      const opened = openNativeDocument(contents);
      expect(opened.warnings).toContainEqual(notCounted);
      expect(opened.warnings.filter(warning => warning.code === notCounted.code)).toHaveLength(1);
      const document = normalizeCommittedDocument(opened.document!);
      const [molecule] = moleculesOrThrow(document);
      expectFlagged(molecule);
      const saved = createNativeSavePayload(document);
      expect(saved.warnings.map(warning => warning.message)).toContain("H3 states 1 H, which a hydrogen atom cannot carry; only 0 counts.");
      const reopened = openNativeDocument(saved.contents);
      expect(reopened.warnings).toContainEqual(notCounted);
      expect(atomOf(moleculesOrThrow(reopened.document!)[0], "h")).toEqual(atomOf(molecule, "h"));
    }
  });

  it("a D or H stating 0, or no count, opens with no warning and no badge", () => {
    const document = stored();
    const molecule = document.pages[0]!.objects[0] as MoleculeObject;
    for (const hydrogenCount of [0, undefined]) {
      molecule.atoms[2] = { id: "h", element: "H", x: 128, y: 100, formalCharge: 0, ...(hydrogenCount === undefined ? {} : { hydrogenCount }) };
      const opened = openNativeDocument(serializeDocument(document));
      expect(opened.warnings.filter(warning => warning.code === notCounted.code)).toEqual([]);
      const [reopened] = moleculesOrThrow(normalizeCommittedDocument(opened.document!));
      expect(reopened.atoms.map(atom => atomProblem(reopened, atom.id))).toEqual([undefined, undefined, undefined, undefined]);
    }
  });

  it("session restore reads it as File > Open does: the count kept, the warning shown", () => {
    const opened = openNativeDocument(serializeDocument(stored()));
    const document = normalizeCommittedDocument(opened.document!);
    const envelope = { ...buildDocumentSessionEnvelope(createNativeSavePayload(document), { dirty: true }, "Stored H", false),
      openWarnings: { displayName: "Stored H", sourceLabel: "ChemDraft", warnings: opened.warnings } };
    const session = parseDocumentSessionEnvelope(JSON.parse(JSON.stringify(envelope)), true)!;
    expect(restoreSessionWarningReports(session).warnings?.warnings).toContainEqual(notCounted);
    // The restore reads the autosaved contents through the same open path.
    const restored = openNativeDocument(session.contents);
    expect(restored.warnings).toContainEqual(notCounted);
    expectFlagged(moleculesOrThrow(normalizeCommittedDocument(restored.document!))[0]);
  });

  it("session restore shows it beside an unrelated warning the session's saved open report holds", () => {
    const document = normalizeCommittedDocument(openNativeDocument(serializeDocument(stored())).document!);
    const unrelated = { code: "cdxml.unsupported_object", message: "Skipped an unsupported object.", sourceObjectId: "other" };
    const envelope = { ...buildDocumentSessionEnvelope(createNativeSavePayload(document), { dirty: true }, "Stored H", false),
      openWarnings: { displayName: "Stored H", sourceLabel: "external CDXML subset", warnings: [unrelated] } };
    const session = parseDocumentSessionEnvelope(JSON.parse(JSON.stringify(envelope)), true)!;
    // As the restore does: read the autosaved contents, then restore the reports with what that read found.
    const reread = openNativeDocument(session.contents);
    const { warnings } = restoreSessionWarningReports(session, { displayName: "Stored H", sourceLabel: "ChemDraft", warnings: reread.warnings });
    expect(warnings).toMatchObject({ displayName: "Stored H", sourceLabel: "external CDXML subset" });
    expect(warnings?.warnings).toEqual([unrelated, notCounted]);
  });

  it("paste and duplicate keep it and flag each copy", () => {
    const document = normalizeCommittedDocument(openNativeDocument(serializeDocument(stored())).document!);
    const payload = createSelectionClipboardPayload(selecting(document, ["mol_h"]))!;
    const pasted = moleculesOrThrow(pasteSelectionClipboardPayload(document, payload, { x: 300, y: 300 }));
    expect(pasted).toHaveLength(2);
    for (const molecule of pasted) expectFlagged(molecule);
    const [molecule] = moleculesOrThrow(document);
    const fragment = createSelectionClipboardPayload(document, [{ objectId: molecule.id,
      atomIds: molecule.atoms.map(atom => atom.id), bondIds: molecule.bonds.map(bond => bond.id) }])!;
    expectFlagged(moleculesOrThrow(pasteSelectionClipboardPayload(document, fragment, { x: 300, y: 300 })).at(-1)!);
    const duplicated = moleculesOrThrow(duplicateSelectedDocumentObjects(selecting(document, ["mol_h"])));
    expect(duplicated).toHaveLength(2);
    for (const copy of duplicated) expectFlagged(copy);
  });

  it("undo and redo across an edit of the document restore each state exactly", () => {
    const document = normalizeCommittedDocument(openNativeDocument(serializeDocument(stored())).document!);
    const [molecule] = moleculesOrThrow(document);
    const edited = applyPatchWithHistory(createDocumentHistory(document), { op: "updateObject", objectId: molecule.id, changes: {
      atoms: molecule.atoms.map(atom => atom.id === "c1" ? { ...atom, x: atom.x - 6 } : atom) } });
    expectFlagged(moleculesOrThrow(edited.present)[0]);
    const undone = undo(edited);
    expect(undone.present).toBe(document);
    expectFlagged(moleculesOrThrow(undone.present)[0]);
    const redone = redo(undone);
    expect(redone.present).toBe(edited.present);
    expect(atomOf(moleculesOrThrow(redone.present)[0], "c1").x).toBe(atomOf(molecule, "c1").x - 6);
    expectFlagged(moleculesOrThrow(redone.present)[0]);
  });
});

function moleculesOrThrow(document: ChemDraftDocument): [MoleculeObject, ...MoleculeObject[]] {
  const molecules = moleculesOf(document);
  if (molecules.length === 0) throw new Error("Expected a molecule");
  return molecules as [MoleculeObject, ...MoleculeObject[]];
}
