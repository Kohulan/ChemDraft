// @vitest-environment jsdom
// Save As where the macOS save panel returns a doubled extension (it appends `.chemdraft` to a
// typed `x.chemdraft` while the extension is hidden) writes `x.chemdraft`, and confirms before
// replacing a different file already at that path. Windows and Linux pickers return exactly what
// the user typed, so a doubled name chosen there is written as typed.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeTextObject } from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { setNativePromptProvider, type NativePromptOptions } from "./nativePrompt";
import { MemoryStorage } from "./testSupport/memoryStorage";

const native = vi.hoisted(() => ({
  writeFile: vi.fn<(path: string, contents: string) => Promise<void>>(),
  exists: vi.fn<(path: string) => Promise<boolean>>(),
  saveDialog: vi.fn<() => Promise<string | null>>()
}));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => true,
  loadDocumentSession: async () => undefined,
  saveDocumentSession: async () => {},
  loadToolsetLayoutState: async () => undefined,
  listToolsetWindowStates: async () => [],
  setToolbarsMenu: async () => {},
  listenForQuitPromptRequest: async () => () => {},
  listenForQuitSettings: async () => () => {},
  setQuitPromptEnabled: async () => {}
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: native.saveDialog }));
vi.mock("@tauri-apps/plugin-fs", async original => ({
  ...await original<typeof import("@tauri-apps/plugin-fs")>(), writeTextFile: native.writeFile, exists: native.exists
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each([
  ["macos", "/Users/me/x.chemdraft.chemdraft", "/Users/me/x.chemdraft"],
  ["windows", "C:\\Users\\me\\x.chemdraft.chemdraft", "C:\\Users\\me\\x.chemdraft"],
  ["linux", "/home/me/x.chemdraft.chemdraft", "/home/me/x.chemdraft"]
] as const)("Save As with a repeated extension (%s)", (platform, panelPath, collapsedPath) => {
  const collapses = platform === "macos";
  const itMac = collapses ? it : it.skip;
  const itElsewhere = collapses ? it.skip : it;
  let container: HTMLDivElement, root: Root;
  let prompts: NativePromptOptions[];
  let answer: string;
  let restorePrompt: () => void;
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  // Startup also writes runtime-build.json through the same plugin; count only document writes.
  const documentWrites = () => native.writeFile.mock.calls.map(([path]) => path).filter(path => /\.(chemdraft|cdxml|cdx)$/i.test(path));
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    prompts = []; answer = "cancel";
    restorePrompt = setNativePromptProvider(async prompt => { prompts.push(prompt); return answer; });
    native.writeFile.mockResolvedValue();
    native.exists.mockResolvedValue(false);
    native.saveDialog.mockResolvedValue(panelPath);
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    const source = insertNativeTextObject(createPhase4Document(), { x: 220, y: 200 }, "Original");
    await act(async () => root.render(<MainWindow initialDocument={source} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialCrosshairsVisible={false} initialRulersVisible={false} nativePalette shortcutPlatform={platform} />));
  });
  afterEach(async () => {
    restorePrompt(); await act(async () => root.unmount()); container.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  });

  itElsewhere("writes the picker's path exactly as typed, without checking or asking", async () => {
    native.exists.mockResolvedValue(true);
    await command("document.saveAs");
    expect(native.saveDialog).toHaveBeenCalledTimes(1);
    expect(native.exists).not.toHaveBeenCalled();
    expect(prompts).toEqual([]);
    expect(documentWrites()).toEqual([panelPath]);
    expect(snapshot().file.path).toBe(panelPath);
  });

  itMac("writes the collapsed path when no file is there", async () => {
    await command("document.saveAs");
    expect(native.saveDialog).toHaveBeenCalledTimes(1);
    expect(native.exists).toHaveBeenCalledWith(collapsedPath);
    expect(prompts).toEqual([]);
    expect(documentWrites()).toEqual([collapsedPath]);
    expect(snapshot().file.path).toBe(collapsedPath);
  });

  itMac.each([["replace", true], ["cancel", false]] as const)("asks before replacing an existing file (%s)", async (choice, writes) => {
    native.exists.mockResolvedValue(true);
    answer = choice;
    await command("document.saveAs");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.message).toContain("x.chemdraft");
    expect(prompts[0]!.message).not.toContain("x.chemdraft.chemdraft");
    if (writes) {
      expect(documentWrites()).toEqual([collapsedPath]);
    } else {
      expect(documentWrites()).toEqual([]);
      expect(snapshot().file.path).not.toBe(collapsedPath);
    }
  });

  itMac("does not ask before Save As onto exactly the document's own file", async () => {
    native.saveDialog.mockResolvedValueOnce(collapsedPath);
    await command("document.saveAs");
    expect(snapshot().file.path).toBe(collapsedPath);
    native.writeFile.mockClear(); native.exists.mockClear();
    native.exists.mockResolvedValue(true);
    await command("document.saveAs");
    expect(native.exists).not.toHaveBeenCalled();
    expect(prompts).toEqual([]);
    expect(documentWrites()).toEqual([collapsedPath]);
  });

  itMac("asks before replacing an existing file spelled differently from the document's own", async () => {
    native.saveDialog.mockResolvedValueOnce(collapsedPath);
    await command("document.saveAs");
    native.writeFile.mockClear(); native.exists.mockClear();
    native.exists.mockResolvedValue(true);
    const upper = panelPath.replace("x.chemdraft.chemdraft", "X.chemdraft.chemdraft");
    native.saveDialog.mockResolvedValueOnce(upper);
    await command("document.saveAs");
    // Never guess identity from spelling: an extra question, never a silent overwrite.
    expect(native.exists).toHaveBeenCalledWith(upper.slice(0, -".chemdraft".length));
    expect(prompts).toHaveLength(1);
    expect(documentWrites()).toEqual([]);
  });

  itMac("writes the panel's path unchanged when the collapsed path is outside the file access scope", async () => {
    native.exists.mockRejectedValue(new Error("forbidden path"));
    await command("document.saveAs");
    expect(prompts).toEqual([]);
    expect(documentWrites()).toEqual([panelPath]);
    expect(snapshot().file.path).toBe(panelPath);
  });
});
