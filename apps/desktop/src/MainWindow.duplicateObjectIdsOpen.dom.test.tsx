// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Molecule } from "openchemlib";
import { parseDocument, serializeDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createNativeMolfileMolecule, createPhase4Document } from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";

/**
 * Opening a .chemdraft file whose page 1 holds two objects with one id: the reader gives the later
 * copy a new id, so the document in memory differs from the file. It opens dirty, with the open
 * warning, and the renumbering is part of opening (no undo entry). Save writes the fix, and the
 * saved file reopens clean.
 */
const native = vi.hoisted(() => ({ writeFile: vi.fn<(path: string, contents: string) => Promise<void>>() }));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => true,
  loadDocumentSession: async () => undefined,
  saveDocumentSession: async () => {},
  loadToolsetLayoutState: async () => undefined,
  listToolsetWindowStates: async () => [],
  setToolbarsMenu: async () => {}
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: async () => "/tmp/unexpected-save-as.chemdraft" }));
vi.mock("@tauri-apps/plugin-fs", async original => ({
  ...await original<typeof import("@tauri-apps/plugin-fs")>(), writeTextFile: native.writeFile
}));

const message = "This file had 2 objects sharing an id on page 1; ChemDraft gave the duplicates new ids. Save to keep the fix.";

function alanine(base: ChemDraftDocument, id: string, x: number): MoleculeObject {
  const molfile = Molecule.fromSmiles("C[C@H](N)C(=O)O").toMolfile();
  return { ...createNativeMolfileMolecule(base, { x, y: 200 }, molfile, "molfile-v2000"), id };
}

function fileWith(ids: [string, string]): string {
  const base = createPhase4Document("Duplicates");
  const page = { ...base.pages[0]!, objects: [alanine(base, ids[0], 120), alanine(base, ids[1], 320)] };
  return serializeDocument(parseDocument({ ...base, pages: [page], selection: { pageId: page.id, objectIds: [] } }));
}

describe.each(["macos", "windows"] as const)("opening a file with duplicate same-page ids (%s)", platform => {
  let container: HTMLDivElement, root: Root;
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const ids = () => snapshot().document.pages[0]!.objects.map(object => object.id);
  const status = () => container.querySelector<HTMLElement>('[role="status"]')!;
  const warningsButton = () => container.querySelector("[data-open-warnings-button]");
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(window, "focus").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    native.writeFile.mockReset().mockResolvedValue();
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  });
  async function mount() {
    await act(async () => root.render(<MainWindow initialDocument={createPhase4Document("Start")} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialCrosshairsVisible={false} initialRulersVisible={false} nativePalette shortcutPlatform={platform} />));
  }
  /** Opens `contents` as `path` through the real open path (the agent bridge's hash payload). */
  async function open(contents: string, path: string) {
    const params = new URLSearchParams({ openDocumentText: contents, displayName: path.split("/").at(-1)!, path });
    window.history.replaceState(null, "", `/?agentBridge=1#${params}`);
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
    for (let attempt = 0; attempt < 100 && snapshot().file.path !== path; attempt += 1) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    }
    expect(snapshot().file.path).toBe(path);
  }
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  async function save() {
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "s", bubbles: true, cancelable: true, metaKey: platform === "macos", ctrlKey: platform === "windows"
    })));
  }

  it("opens dirty with the new warning, undo leaves the new ids, and the saved file reopens clean", async () => {
    await mount();
    await open(fileWith(["X", "X"]), "/tmp/duplicates.chemdraft");
    expect(ids()).toEqual(["X", "X_002"]);
    expect(snapshot().file).toEqual({ path: "/tmp/duplicates.chemdraft", dirty: true });
    expect(warningsButton()).not.toBeNull();
    expect(status().title).toContain(message);

    // The renumbering is part of opening: there is nothing to undo, and the ids and dirty state stay.
    const opened = snapshot().document;
    await command("edit.undo");
    expect(ids()).toEqual(["X", "X_002"]);
    expect(snapshot().document).toEqual(opened);
    expect(snapshot().file.dirty).toBe(true);
    expect(status().textContent).toContain("Nothing to undo");

    await save();
    const writes = native.writeFile.mock.calls.filter(([path]) => path === "/tmp/duplicates.chemdraft");
    expect(writes).toHaveLength(1);
    expect(snapshot().file).toEqual({ path: "/tmp/duplicates.chemdraft", dirty: false });

    // The saved file carries the new ids: it reopens with no warning and no unsaved changes.
    await open(writes[0]![1], "/tmp/duplicates-saved.chemdraft");
    expect(ids()).toEqual(["X", "X_002"]);
    expect(snapshot().file).toEqual({ path: "/tmp/duplicates-saved.chemdraft", dirty: false });
    expect(warningsButton()).toBeNull();
    expect(status().title ?? "").not.toContain("sharing an id");
  }, 30_000);

  it("opens a normal file clean, with no warning", async () => {
    await mount();
    await open(fileWith(["X", "Y"]), "/tmp/normal.chemdraft");
    expect(ids()).toEqual(["X", "Y"]);
    expect(snapshot().file).toEqual({ path: "/tmp/normal.chemdraft", dirty: false });
    expect(warningsButton()).toBeNull();
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("renumbered duplicate"), expect.anything(), expect.anything());
  }, 30_000);
});
