// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Molecule } from "openchemlib";
import { parseDocument, serializeDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createNativeMolfileMolecule, createPhase4Document } from "./documentWorkflow";
import { buildDocumentSessionEnvelope } from "./documentSession";
import { MemoryStorage } from "./testSupport/memoryStorage";

/**
 * Session restore of a tab whose saved payload holds two objects with one id on page 1: the reader
 * gives the later copy a new id, so the restored document differs from what the session (and its
 * file) recorded. The tab restores dirty, with the open warning, even though the session said it was
 * clean. A normal tab restores exactly as recorded, clean and without the warning.
 */
const native = vi.hoisted(() => ({ session: undefined as unknown }));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => true,
  loadDocumentSession: async () => native.session,
  saveDocumentSession: async () => {},
  loadToolsetLayoutState: async () => undefined,
  listToolsetWindowStates: async () => [],
  setToolbarsMenu: async () => {}
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

/** A clean, untitled session tab as autosave records it. */
function sessionTab(ids: [string, string], displayName: string) {
  return buildDocumentSessionEnvelope({ contents: fileWith(ids), payloadHash: `test-${displayName}` }, { dirty: false }, displayName, false);
}

describe.each(["macos", "windows"] as const)("restoring a session tab with duplicate same-page ids (%s)", platform => {
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
    native.session = undefined;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  });
  /** Mounts with `session` as the saved session and waits until its tab replaced the blank start. */
  async function mountRestoring(session: unknown, displayName: string) {
    native.session = session;
    await act(async () => root.render(<MainWindow initialDocument={createPhase4Document("Start")} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialCrosshairsVisible={false} initialRulersVisible={false} nativePalette shortcutPlatform={platform} />));
    for (let attempt = 0; attempt < 100 && snapshot().document.pages[0]!.objects.length === 0; attempt += 1) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    }
    expect(snapshot().document.title).toBe("Duplicates");
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(displayName);
  }

  it("restores the renumbered tab dirty, with the warning, though the session recorded it clean", async () => {
    await mountRestoring(sessionTab(["X", "X"], "duplicates"), "duplicates");
    expect(ids()).toEqual(["X", "X_002"]);
    expect(snapshot().file.dirty).toBe(true);
    expect(warningsButton()).not.toBeNull();
    expect(status().title).toContain(message);
  }, 30_000);

  it("restores a normal tab clean, with no warning", async () => {
    await mountRestoring(sessionTab(["X", "Y"], "normal"), "normal");
    expect(ids()).toEqual(["X", "Y"]);
    expect(snapshot().file.dirty).toBe(false);
    expect(warningsButton()).toBeNull();
    expect(status().title ?? "").not.toContain("sharing an id");
  }, 30_000);

  it("marks only the renumbered tab dirty when both are restored together", async () => {
    const normal = sessionTab(["X", "Y"], "normal");
    await mountRestoring({ version: normal.version, tabs: [normal, sessionTab(["X", "X"], "duplicates")], activeTabIndex: 0 }, "normal");
    const tabs = () => container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs()).toHaveLength(2);
    expect(ids()).toEqual(["X", "Y"]);
    expect(snapshot().file.dirty).toBe(false);
    expect(warningsButton()).toBeNull();

    // The inactive tab carried its renumbering and dirty state from restore.
    await act(async () => tabs()[1]!.click());
    expect(ids()).toEqual(["X", "X_002"]);
    expect(snapshot().file.dirty).toBe(true);
    expect(warningsButton()).not.toBeNull();
    expect(status().title).toContain(message);

    await act(async () => tabs()[0]!.click());
    expect(ids()).toEqual(["X", "Y"]);
    expect(snapshot().file.dirty).toBe(false);
  }, 30_000);
});
