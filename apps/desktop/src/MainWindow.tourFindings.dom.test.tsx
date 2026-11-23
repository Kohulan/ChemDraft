// @vitest-environment jsdom
// Guided Tour findings from the #422 review, driven through the real MainWindow and the real
// DialogCoordinator (only the native transport and the Tauri calls are stood in for).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { MainWindow } from "./MainWindow";
import { applyNativeChainTool, createPhase4Document } from "./documentWorkflow";
import { inspectStructureOffThread } from "./depiction2d/identityClient";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";
import type { TourMode } from "./tour/tourState";
import type { DesktopPreferences } from "./desktopPreferences";
import type { ChemDraftAgentBridge } from "./agentBridge";
import type { DialogMessage } from "./dialogs/dialogProtocol";
import type { DialogDelivery } from "./dialogs/dialogTransport";

const native = vi.hoisted(() => ({
  preferences: {} as DesktopPreferences,
  openDocumentSubscription: "ok" as "ok" | "refuse",
  dialogSnapshot: undefined as DialogMessage | undefined,
  dialogListener: undefined as ((delivery: DialogDelivery) => void) | undefined
}));
vi.mock("./desktopPreferences", () => ({
  desktopPreferences: async (patch?: DesktopPreferences) => {
    if (patch) native.preferences = { ...native.preferences, ...patch };
    return { ...native.preferences };
  }
}));
vi.mock("./dialogs/dialogTransport", () => ({ nativeDialogTransport: {
  subscribe: async (handler: (delivery: DialogDelivery) => void) => { native.dialogListener = handler; return () => { native.dialogListener = undefined; }; },
  open: async (snapshot: DialogMessage) => { native.dialogSnapshot = snapshot; return { hostId: "opaque", windowLabel: `dialog-main-${snapshot.dialogKind}-1` }; },
  publish: async () => undefined, close: async () => undefined
} }));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => true,
  loadDocumentSession: async () => undefined,
  saveDocumentSession: async () => undefined,
  loadToolsetLayoutState: async () => undefined,
  listToolsetWindowStates: async () => [],
  openToolsetWindow: async (toolsetId: string) => ({ toolsetId, open: false, focused: false }),
  closeToolsetWindow: async (toolsetId: string) => ({ toolsetId, open: false, focused: false }),
  setToolbarsMenu: async () => undefined,
  listenForQuitFlushRequest: async () => () => {},
  listenForQuitPromptRequest: async () => () => {},
  listenForQuitSettings: async () => () => {},
  setQuitPromptEnabled: async () => undefined
}));
vi.mock("./window-manager/tauriEvents", async original => {
  const listen = async (name: string) => {
    // The native open-document queue refuses to subscribe; nothing else is affected.
    if (name === "chemdraft://open-document" && native.openDocumentSubscription === "refuse") throw new Error("event bus unavailable");
    return () => {};
  };
  return { ...await original<typeof import("./window-manager/tauriEvents")>(), listenTauriEvent: listen, listenCurrentWindowEvent: listen };
});
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  isTauri: () => false,
  invoke: async (command: string) => command === "take_pending_open_document" ? [] : null
}));
vi.mock("./plugins/panelBridge", async original => ({
  ...await original<typeof import("./plugins/panelBridge")>(),
  broadcastAnalysisWindowSnapshot: async () => undefined,
  respondToProposalDecision: async () => undefined
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each(["macos", "windows"] as const)("Guided Tour findings on %s", platform => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeAll(async () => {
    expect((await inspectStructureOffThread("smiles", "C")).valid).toBe(true);
  }, 20_000);
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(window, "focus").mockImplementation(() => {});
    window.history.replaceState(null, "", "/?agentBridge=1");
    native.preferences = {};
    native.openDocumentSubscription = "ok";
    native.dialogSnapshot = undefined;
    native.dialogListener = undefined;
    container = document.createElement("div");
    document.body.append(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    container.remove();
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function mount(tourMode: TourMode, drawing = createPhase4Document("My drawing")) {
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(MainWindow, {
        initialDocument: drawing, initialActiveToolCommandId: "tool.select", shortcutPlatform: platform as ShortcutPlatform, tourMode,
        initialPaletteMode: "hidden", initialCrosshairsVisible: false, initialRulersVisible: false, nativePalette: true
      }));
    });
  }
  const bridge = () => (window as Window & { __CHEMDRAFT_AGENT__: ChemDraftAgentBridge }).__CHEMDRAFT_AGENT__;
  const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const command = (commandId: string) => act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  const idle = () => act(async () => vi.advanceTimersByTimeAsync(1000));
  const tourAction = (data: unknown) => act(async () => {
    const label = `dialog-main-${native.dialogSnapshot!.dialogKind}-1`;
    native.dialogListener!({ senderWindowId: label, windowLabel: label,
      message: { ...native.dialogSnapshot!, type: "action", data, requestId: crypto.randomUUID() } } as DialogDelivery);
  });
  const objectTypes = () => bridge().snapshot().document.pages.flatMap(page => page.objects).map(object => object.type);
  const openSample = () => tourAction({ action: "tryTourCommand", command: "help.tour.openSample" });

  async function openTour(drawing = createPhase4Document("My drawing")) {
    await mount("suppress", drawing);
    await command("help.showTour");
    await act(async () => native.dialogListener!({ senderWindowId: "dialog-main-guidedTour-1", windowLabel: "dialog-main-guidedTour-1",
      message: { ...native.dialogSnapshot!, type: "ready", data: {}, requestId: crypto.randomUUID() } } as DialogDelivery));
  }

  it("reuses the practice tab when Undo removed its sample and nothing was drawn since", async () => {
    await openTour();
    await openSample();
    expect(tabs()).toHaveLength(2);
    const sample = bridge().snapshot().document;
    await command("edit.undo");
    expect(objectTypes()).toEqual([]);
    await openSample();
    // Still two tabs: the first Tour tab holds the sample again, as a clean drawing with one undo.
    expect(tabs()).toHaveLength(2);
    expect(tabs()[1].getAttribute("aria-selected")).toBe("true");
    expect(objectTypes()).toEqual(["molecule"]);
    expect(bridge().snapshot().document.pages[0].objects).toEqual(sample.pages[0].objects);
    expect(bridge().snapshot().file.dirty).toBe(false);
    // Repeating the cycle never accumulates blank tabs.
    await command("edit.undo");
    await openSample();
    expect(tabs()).toHaveLength(2);
    await command("edit.undo");
    expect(objectTypes()).toEqual([]);
  });

  it("does not reset a practice tab that holds the user's drawing after Undo", async () => {
    await openTour();
    await openSample();
    await command("edit.undo");
    // The user draws in the emptied Tour tab; reopening must leave that drawing alone.
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"], getData: () => "CC" } });
    await act(async () => { window.dispatchEvent(event); });
    await vi.waitFor(() => expect(objectTypes()).toEqual(["molecule"]), { timeout: 10_000 });
    const drawn = bridge().snapshot().document.pages[0].objects;
    await openSample();
    expect(tabs()).toHaveLength(3);
    await act(async () => tabs()[1].click());
    expect(bridge().snapshot().document.pages[0].objects).toEqual(drawn);
  });

  it("control: the first-run tour opens when the open-file subscription works", async () => {
    vi.useFakeTimers();
    await mount("automatic");
    await idle();
    expect(native.dialogSnapshot).toMatchObject({ dialogKind: "guidedTour", data: { automatic: true } });
  });

  it("releases the first-run tour gate when the open-file subscription is refused", async () => {
    vi.useFakeTimers();
    native.openDocumentSubscription = "refuse";
    await mount("automatic");
    await idle();
    expect(native.dialogSnapshot).toMatchObject({ dialogKind: "guidedTour", data: { automatic: true } });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Could not check pending open files: event bus unavailable");
  });
});
