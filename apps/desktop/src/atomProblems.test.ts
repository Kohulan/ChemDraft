import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Molecule } from "openchemlib";
import { atomProblem, nativeAtomValidationState, nativeAtomLabelReading, nativeSingleBondGraphSmiles } from "@chemdraft/document-workflow-core";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { allShellCommands } from "./commands";
import { createCoreCommandRegistrar } from "./commands/coreCommandRegistrar";
import { atomProblemCommandId, atomProblemCommands } from "./atomProblemCommands";
import {
  applyNativeAtomElementTarget,
  applyNativeAtomProblemFix,
  applyNativeMoleculeBondOrderValueTarget,
  createNativeSavePayload,
  createSelectionClipboardPayload,
  duplicateSelectedDocumentObjects,
  moveNativeMoleculeParts,
  normalizeCommittedDocument,
  openNativeDocument,
  pasteSelectionClipboardPayload,
  rotateSelectedDocumentObjects90
} from "./documentWorkflow";
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
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
    const neighbour = oxygenBond.fromAtomId === oxygen.id ? oxygenBond.toAtomId : oxygenBond.fromAtomId;
    const paste = (atomIds: string[], bondIds: string[]) => {
      const payload = createSelectionClipboardPayload(document, [{ objectId: molecule.id, atomIds, bondIds }])!;
      return moleculesOrThrow(pasteSelectionClipboardPayload(document, payload, { x: 300, y: 300 })).at(-1)!;
    };
    expect(oxygenOf(paste([oxygen.id, neighbour], [oxygenBond.id])).hydrogenCount).toBe(0);
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

function moleculesOrThrow(document: ChemDraftDocument): [MoleculeObject, ...MoleculeObject[]] {
  const molecules = moleculesOf(document);
  if (molecules.length === 0) throw new Error("Expected a molecule");
  return molecules as [MoleculeObject, ...MoleculeObject[]];
}
