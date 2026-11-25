// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, type ChemDraftDocument, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import type { PluginCommandContext } from "@chemdraft/plugin-api";
import { MainWindow } from "./MainWindow";
import type { DesktopPluginRuntime } from "./plugins/createPluginRuntime";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { refreshNativeSingleBondGraph } from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./plugins/rdkitAppLoader", () => ({ loadRdkitWithAppLoader: (load: () => Promise<unknown>) => load() }));
// jsdom does not implement the ruler's canvas painting context.
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
const captured = vi.hoisted(() => ({ runtime: undefined as DesktopPluginRuntime | undefined }));
vi.mock("./plugins/createPluginRuntime", async original => {
  const actual = await original<typeof import("./plugins/createPluginRuntime")>();
  return { ...actual, createPluginRuntime: (options: import("./plugins/createPluginRuntime").DesktopPluginRuntimeOptions) => {
    captured.runtime = actual.createPluginRuntime(options);
    return captured.runtime;
  } };
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

// A plugin insert (a direct documents.applyPatch, or a proposal the user accepts) whose lone-H (H•)
// cache refresh is declined keeps the molecule's stored chemistry. When verification accepts that
// chemistry the write applies, and the status line it sets names the molecule and why (AGENTS.md
// section 7), as open and paste do; when it does not (a stale H2 cache), the write is refused.
describe("a plugin insert whose lone-H cache refresh is declined", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    captured.runtime = undefined;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  const atom = (id: string, element: string, x: number, y: number): MoleculeAtom => ({ id, element, x, y, formalCharge: 0 });
  // Ethane beside a lone H as the H2 reading stored it: ChemDraft's own earlier output for the drawing
  // ("CC.[HH]", C2H8, no radical), so the refresh replaces it with today's ("CC.[H]", H•).
  const refreshable = (id = "fresh", dx = 0): MoleculeObject => ({
    id, type: "molecule", x: 290 + dx, y: 290, width: 70, height: 24, rotation: 0, style: {},
    structureFormat: "smiles", structure: "CC.[HH]", superatoms: [], rGroups: [],
    atoms: [atom("c1", "C", 300 + dx, 300), atom("c2", "C", 314 + dx, 308), atom("h", "H", 350 + dx, 300)],
    bonds: [{ id: "b1", fromAtomId: "c1", toAtomId: "c2", order: "single" }],
    chemistry: { formula: "C2H8", averageMass: 32.086, exactMass: 32.0626, atomCount: 3, bondCount: 1,
      totalCharge: 0, radicalCount: 0, isotopeLabels: [], stereochemistry: [], warnings: [] }
  });
  const refreshedStructure = "CC.[H]";
  // CHBrClF (F on a wedge) beside a lone H, its chemistry record the canvas's own derivation with
  // its stereochemistry label, and no cached structure. The native writer never writes a stereo
  // label, so this is not ChemDraft's own output and the refresh keeps it as stored, with its
  // warning. It states the drawing (H•) truly, so verification accepts it and the write applies.
  const declined = (): MoleculeObject => {
    const atoms = [atom("c", "C", 300, 300), atom("f", "F", 314, 300), atom("cl", "Cl", 293, 312), atom("br", "Br", 293, 288),
      atom("h", "H", 340, 300)];
    const bonds = [
      { id: "cf", fromAtomId: "c", toAtomId: "f", order: "single" as const, display: { bondStyle: "wedge" as const } },
      { id: "ccl", fromAtomId: "c", toAtomId: "cl", order: "single" as const },
      { id: "cbr", fromAtomId: "c", toAtomId: "br", order: "single" as const }
    ];
    const drawn: MoleculeObject = { id: "kept", type: "molecule", x: 280, y: 280, width: 70, height: 40, rotation: 0, style: {},
      structureFormat: "smiles", structure: "", superatoms: [], rGroups: [], atoms, bonds };
    const derived = refreshNativeSingleBondGraph(drawn, atoms, bonds);
    const { compatibility: _compatibility, ...record } = derived;
    // The label RDKit reads from this drawing; the commit's verification checks it.
    return { ...record, structureFormat: "smiles", structure: "", chemistry: { ...derived.chemistry!, stereochemistry: ["atom 0 (S)"] } };
  };
  // The same drawing as saved under the H2 reading, with its stereo: "F[C@@H](Cl)Br.[HH]", CH3BrClF,
  // no radical. Kept as stored (it carries stereo), and then refused by verification, which checks it
  // against the drawing (H•) as it checks any insertion.
  const staleH2 = (): MoleculeObject => {
    const molecule = declined();
    return { ...molecule, structure: "F[C@@H](Cl)Br.[HH]", chemistry: { ...molecule.chemistry!,
      formula: "CH3BrClF", averageMass: 149.387, exactMass: 147.90907, radicalCount: 0 } };
  };
  const reason = "not ChemDraft's own earlier output";

  async function mount(drawing: ChemDraftDocument) {
    await act(async () => root.render(<MainWindow initialDocument={drawing} initialPaletteMode="hidden"
      initialRulersVisible={false} nativePalette={false} />));
    return getAssistantHistoryPort();
  }
  const status = () => container.querySelector("[role=status]")?.textContent ?? "";
  const command = "plugin.loneHydrogenTest.run";
  function registerInserter(molecule: MoleculeObject, pageId: string) {
    act(() => captured.runtime!.registerPlugin({ id: "org.chemdraft.loneHydrogenTest", name: "Lone H test", version: "0.1.0",
      apiVersion: "^0.1.14", entry: "test.js", permissions: ["document.write"], contributes: { commands: [{ id: command, title: "Test" }] }
    }, { commandHandlers: { [command]: (context: PluginCommandContext) => context.documents.applyPatch!({
      reason: "Insert structure", patch: { op: "addObject", pageId, object: molecule } }).then(() => undefined) } }));
  }
  async function directInsert(molecule: MoleculeObject, pageId: string) {
    registerInserter(molecule, pageId);
    await act(async () => { await captured.runtime!.host.invokeCommand(command); });
  }
  async function acceptInsert(molecule: MoleculeObject, pageId: string) {
    const runtime = captured.runtime!;
    let proposalId!: string;
    await act(async () => {
      runtime.registerPlugin({ id: "org.chemdraft.proposalTest", name: "Proposal test", version: "0.1.0", apiVersion: "^0.1.14",
        entry: "test.js", permissions: ["document.proposePatch"] });
      proposalId = runtime.host.proposePatch("org.chemdraft.proposalTest", { reason: "Insert structure",
        patch: { op: "addObject", pageId, object: molecule } }).id;
    });
    await act(async () => { container.querySelector<HTMLButtonElement>(".patch-review-badge")!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>(`[data-proposal-id="${proposalId}"] button`)!.click(); });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(runtime.host.listProposedPatches("pending")).toHaveLength(0);
    }, { timeout: 15_000 });
  }
  const inserted = (document: ChemDraftDocument, id: string) =>
    document.pages[0]!.objects.find((object): object is MoleculeObject => object.id === id && object.type === "molecule");

  it("names the kept molecule in the status of a direct plugin write", async () => {
    const blank = createEmptyDocument();
    const port = await mount(blank);
    const molecule = declined();
    await directInsert(molecule, blank.pages[0]!.id);
    expect(inserted(port.read("initial")!, "kept")?.chemistry).toEqual(molecule.chemistry);
    expect(status()).toMatch(/^Lone H test: inserted structure\. Kept the stored chemistry of molecule "kept": /);
    expect(status()).toContain(reason);
    expect(status().split("Kept the stored chemistry")).toHaveLength(2);
  }, 20_000);

  it("names the kept molecule in the status of an accepted proposal", async () => {
    const blank = createEmptyDocument();
    const port = await mount(blank);
    const molecule = declined();
    await acceptInsert(molecule, blank.pages[0]!.id);
    expect(inserted(port.read("initial")!, "kept")?.chemistry).toEqual(molecule.chemistry);
    expect(status()).toMatch(/^Proposal test: applied proposal\. Kept the stored chemistry of molecule "kept": /);
    expect(status()).toContain(reason);
    expect(status().split("Kept the stored chemistry")).toHaveLength(2);
  }, 20_000);

  it("refuses a stale H2 cache that carries stereo, written directly: verification checks the cache it kept", async () => {
    const blank = createEmptyDocument();
    const port = await mount(blank);
    registerInserter(staleH2(), blank.pages[0]!.id);
    let failure: unknown;
    await act(async () => { await captured.runtime!.host.invokeCommand(command).catch((error: unknown) => { failure = error; }); });
    expect(inserted(port.read("initial")!, "kept")).toBeUndefined();
    expect(status()).not.toContain("inserted");
    expect(String(failure)).toMatch(/stored structure doesn't match the drawn atoms/);
  }, 20_000);

  it("keeps the insert's warning beside a selection warning when the plugin runs from the menu", async () => {
    const blank = createEmptyDocument();
    const port = await mount(blank);
    registerInserter(declined(), blank.pages[0]!.id);
    const runtime = captured.runtime!;
    const invoke = runtime.invokeCommand.bind(runtime);
    const selectionWarning = "Molecule m1 could not be written from its graph: boom; using its stored structure.";
    // The command reads a selection that could not be fully serialized, then inserts.
    vi.spyOn(runtime, "invokeCommand").mockImplementation((id, options) => {
      options?.selectionWarnings?.push(selectionWarning);
      return invoke(id, options);
    });
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: command } })); });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(status()).toContain(selectionWarning);
    }, { timeout: 15_000 });
    expect(inserted(port.read("initial")!, "kept")?.chemistry?.stereochemistry).toEqual(["atom 0 (S)"]);
    expect(status()).toMatch(/^Lone H test: inserted structure\. Kept the stored chemistry of molecule "kept": /);
    expect(status()).toContain(reason);
    expect(status().endsWith(selectionWarning)).toBe(true);
  }, 20_000);

  it("keeps the first write's warning when a second, warning-free write follows it from the menu", async () => {
    const blank = createEmptyDocument();
    const port = await mount(blank);
    const pageId = blank.pages[0]!.id;
    // One command, two writes: a cache the refresh keeps as stored, then a lone H it refreshes.
    act(() => captured.runtime!.registerPlugin({ id: "org.chemdraft.loneHydrogenTest", name: "Lone H test", version: "0.1.0",
      apiVersion: "^0.1.14", entry: "test.js", permissions: ["document.write"], contributes: { commands: [{ id: command, title: "Test" }] }
    }, { commandHandlers: { [command]: async (context: PluginCommandContext) => {
      await context.documents.applyPatch!({ reason: "Insert structure", patch: { op: "addObject", pageId, object: declined() } });
      await context.documents.applyPatch!({ reason: "Insert structure", patch: { op: "addObject", pageId, object: refreshable("fresh", 200) } });
    } } }));
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: command } })); });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(inserted(port.read("initial")!, "fresh")?.structure).toBe(refreshedStructure);
      expect(status()).toContain(reason);
    }, { timeout: 15_000 });
    expect(inserted(port.read("initial")!, "kept")?.chemistry?.stereochemistry).toEqual(["atom 0 (S)"]);
    expect(status()).toMatch(/^Lone H test: inserted structure\. Kept the stored chemistry of molecule "kept": /);
    expect(status().split("Kept the stored chemistry")).toHaveLength(2);
  }, 20_000);

  it("adds nothing to the status for a lone H it refreshes, written directly or accepted", async () => {
    const blank = createEmptyDocument();
    const port = await mount(blank);
    await directInsert(refreshable(), blank.pages[0]!.id);
    expect(inserted(port.read("initial")!, "fresh")?.structure).toBe(refreshedStructure);
    expect(inserted(port.read("initial")!, "fresh")?.chemistry?.radicalCount).toBe(1);
    expect(status()).toBe("Lone H test: inserted structure");
    await acceptInsert(refreshable("fresh2", 200), blank.pages[0]!.id);
    expect(inserted(port.read("initial")!, "fresh2")?.structure).toBe(refreshedStructure);
    expect(status()).toBe("Proposal test: applied proposal");
  }, 20_000);
});
