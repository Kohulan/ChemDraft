// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAnalysisRun } from "@chemdraft/analysis-core";
import { sourceInterpretation } from "@chemdraft/rdkit-adapter/constants";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeSingleBondMolecule, selectDocumentObjects } from "./documentWorkflow";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { moleculeStructureBondColorCommandId } from "./commands";
import { PALETTE_COMMAND_COMMIT_EVENT } from "./window-manager";
import { ANALYSIS_WINDOW_OWNER_ID, MOLECULAR_INSPECTOR_WINDOW_ID, PLUGIN_PANEL_WINDOW_CLOSED_EVENT,
  PLUGIN_PANEL_REQUEST_EVENT, pluginPanelWindowLabel } from "./plugins/panelBridge";

const host = vi.hoisted(() => ({ analyze: vi.fn(), open: vi.fn(), publish: vi.fn(), cancel: vi.fn() }));
vi.mock("./analysisClient", () => ({ analysisClient: () => ({ analyze: host.analyze, cancel: host.cancel }) }));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./window-manager", async original => ({ ...await original<typeof import("./window-manager")>(), isDesktopRuntime: () => true,
  openToolsetWindow: vi.fn(async () => ({ open: true })) }));
vi.mock("./plugins/panelBridge", async original => ({ ...await original<typeof import("./plugins/panelBridge")>(),
  openPluginPanelWindow: host.open, broadcastAnalysisWindowSnapshot: host.publish }));

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  host.open.mockResolvedValue(undefined); host.publish.mockResolvedValue(undefined);
  host.analyze.mockImplementation(async (_slot, spec) => emptyAnalysisRun({ runId: crypto.randomUUID(),
    startedAt: "2026-11-10T00:00:00Z", interpretation: sourceInterpretation(spec.format, spec.value), status: "unsupported",
    warnings: [{ code: "test.unsupported", severity: "info", message: "Test result", affectedResultIds: [] }] }));
  window.history.replaceState(null, "", "/?agentBridge=1");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.__CHEMDRAFT_AGENT__;
  window.history.replaceState(null, "", "/");
});
async function command(id: string) { await act(async () => { await window.__CHEMDRAFT_AGENT__!.command(id); }); }
describe.each(["MacIntel", "Win32"])("inspector selection (%s)", platform => {
  it("analyzes a selection made after opening but ignores style and zoom changes", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const inserted = insertNativeSingleBondMolecule(createPhase4Document("Inserted structure"), { x: 300, y: 300 });
    const initialDocument = selectDocumentObjects(inserted, inserted.pages[0]!.id, []);
    await act(async () => root.render(createElement(MainWindow, { initialDocument, initialActiveToolCommandId: "tool.select",
      initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: true })));
    await command("analyze.molecularProperties");
    expect(host.analyze).not.toHaveBeenCalled();
    await command("edit.selectAll");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(host.analyze).toHaveBeenCalledTimes(1);
    expect(host.publish.mock.calls.at(-1)?.[0]).toMatchObject({ pluginId: ANALYSIS_WINDOW_OWNER_ID,
      panelId: MOLECULAR_INSPECTOR_WINDOW_ID, content: { kind: "molecularInspector", busy: false, stale: false, report: expect.any(Object) } });
    await act(async () => window.dispatchEvent(new CustomEvent(PALETTE_COMMAND_COMMIT_EVENT,
      { detail: { commandId: moleculeStructureBondColorCommandId("#00ff00") } })));
    const molecule = window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0]!.objects.find(object => object.type === "molecule");
    expect(molecule?.style.bondColor).toBe("#00ff00");
    await command("view.zoomIn");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(host.analyze).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_WINDOW_CLOSED_EVENT,
      { detail: pluginPanelWindowLabel({ pluginId: ANALYSIS_WINDOW_OWNER_ID, panelId: MOLECULAR_INSPECTOR_WINDOW_ID }) })));
    await command("edit.deleteHoveredNativeTarget");
    await command("edit.undo");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(host.analyze).toHaveBeenCalledTimes(1);
  });

  it("analyzes immediately when the toolbar opens", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const initialDocument = insertNativeSingleBondMolecule(createPhase4Document("Selected"), { x: 300, y: 300 });
    await act(async () => root.render(createElement(MainWindow, { initialDocument, initialActiveToolCommandId: "tool.select",
      initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: true })));
    await command("view.toolset.toggle.core.molecularInspector");
    expect(host.analyze).toHaveBeenCalledTimes(1);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(host.analyze).toHaveBeenCalledTimes(1);
  });

  it("refreshes for a dative bond edit but not a color edit", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const initialDocument = insertNativeSingleBondMolecule(createPhase4Document("Selected"), { x: 300, y: 300 });
    await act(async () => root.render(createElement(MainWindow, { initialDocument, initialActiveToolCommandId: "tool.select",
      initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: true })));
    await command("analyze.molecularProperties");
    expect(host.analyze).toHaveBeenCalledTimes(1);
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
    const molecule = window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0]!.objects.find(object => object.type === "molecule")!;
    if (molecule.type !== "molecule") throw new Error("Expected molecule");
    const bond = molecule.bonds[0]!;
    const from = molecule.atoms.find(atom => atom.id === bond.fromAtomId)!;
    const to = molecule.atoms.find(atom => atom.id === bond.toAtomId)!;
    await act(async () => {
      const event = new MouseEvent("pointermove", { bubbles: true, clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2 });
      Object.defineProperties(event, { pointerId: { value: 77 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      container.querySelector(".page")!.dispatchEvent(event);
    });
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: bond.id });
    await command("bond.setHoveredBondDisplay.dashed");
    const edited = window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0]!.objects.find(object => object.type === "molecule");
    expect(edited?.type === "molecule" && edited.bonds[0]?.display?.bondStyle).toBe("dashed");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(host.analyze).toHaveBeenCalledTimes(2);
    await act(async () => window.dispatchEvent(new CustomEvent(PALETTE_COMMAND_COMMIT_EVENT,
      { detail: { commandId: moleculeStructureBondColorCommandId("#00ff00") } })));
    const recolored = window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0]!.objects.find(object => object.type === "molecule");
    expect(recolored?.style.bondColor).toBe("#00ff00");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(host.analyze).toHaveBeenCalledTimes(2);
    await command("edit.undo");
    await command("edit.undo");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(host.analyze).toHaveBeenCalledTimes(3);
  });

  it("publishes and replays the current analysis when opened immediately after insertion", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const initialDocument = insertNativeSingleBondMolecule(createPhase4Document("Selected insertion"), { x: 300, y: 300 });
    await act(async () => root.render(createElement(MainWindow, { initialDocument, initialActiveToolCommandId: "tool.select",
      initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: true })));
    await command("analyze.molecularProperties");
    expect(host.analyze).toHaveBeenCalledTimes(1);
    host.publish.mockClear();
    await act(async () => window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_REQUEST_EVENT,
      { detail: { pluginId: ANALYSIS_WINDOW_OWNER_ID, panelId: MOLECULAR_INSPECTOR_WINDOW_ID } })));
    expect(host.publish.mock.calls.at(-1)?.[0]).toMatchObject({ content: { kind: "molecularInspector", busy: false,
      stale: false, report: expect.any(Object) } });
  });
});
