// @vitest-environment jsdom
// FAIL 6.5 regression: the shortcut scheme chosen on tour step 2 must reach the same setting,
// persistence and live update that Preferences > Keyboard uses. The tour runs in its own native
// dialog window, so this drives the real chain: TourForm in DialogWindow → DialogCoordinator →
// useGuidedTour → updateShortcutPreference → every window's useShortcutPreference.
import { act, createElement, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { createEmptyDocument } from "@chemdraft/chem-core";
import { MemoryStorage } from "../testSupport/memoryStorage";
import type { DialogMessage } from "../dialogs/dialogProtocol";
import type { KeybindingSettings } from "../keybindingSettings";

const host = vi.hoisted(() => ({
  native: {} as Record<string, unknown>,
  invoke: vi.fn(),
  listeners: new Set<(settings: KeybindingSettings) => void>(),
  toDialog: undefined as ((message: DialogMessage) => void) | undefined,
  toOwner: undefined as ((message: DialogMessage) => void) | undefined
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: host.invoke }));
vi.mock("../dialogs/dialogContentFit", () => ({
  measureDialogContentWhenFontsReady: async () => undefined, observeDialogContent: () => () => {}
}));
vi.mock("../window-manager", async original => ({
  ...await original<typeof import("../window-manager")>(),
  isDesktopRuntime: () => true,
  // Tauri's emit reaches every window, the sender included.
  listenForKeybindingSettings: async (handler: (settings: KeybindingSettings) => void) => {
    host.listeners.add(handler);
    return () => { host.listeners.delete(handler); };
  },
  broadcastKeybindingSettings: async (settings: KeybindingSettings) => {
    host.listeners.forEach(listener => listener(JSON.parse(JSON.stringify(settings)) as KeybindingSettings));
  }
}));
// The dialog window's side of the native host: messages hop through a macrotask, as over IPC.
vi.mock("../dialogs/dialogTransport", () => ({
  subscribeDialogHost: async (_hostId: string, receive: (message: DialogMessage) => void) => {
    host.toDialog = receive;
    return () => {};
  },
  sendDialogMessage: async (_hostId: string, message: DialogMessage) => { setTimeout(() => host.toOwner!(message), 0); }
}));

import { DialogWindow } from "../dialogs/DialogWindow";
import { DialogCoordinator } from "../dialogs/DialogCoordinator";
import { PreferencesWindow } from "../PreferencesWindow";
import { useShortcutPreference } from "../useShortcutPreference";
import { loadKeybindingSettings, saveKeybindingSettings } from "../keybindingSettings";
import { buildAppMenuModel, flattenAppMenuCommands } from "../appMenu";
import { createMainWindowShortcutCommands } from "../keyboardShortcuts";
import { createQuickActions } from "../commands";
import { formatShortcutLabel, getToolsetCommandSpecs } from "../toolsets";
import { useGuidedTour } from "./useGuidedTour";
import type { TourAction } from "./tourCommands";

const DIALOG_LABEL = "dialog-main-guidedTour-1";
let mainScheme: string | undefined;

/** The document window's part of the tour, wired as MainWindow wires it. */
function DocumentWindow() {
  const settings = useShortcutPreference();
  mainScheme = settings.scheme;
  const coordinator = useRef<DialogCoordinator>(undefined);
  const action = useRef<(action: TourAction) => Promise<void>>(async () => {});
  const tour = useGuidedTour({
    coordinator: () => coordinator.current, readyAndIdle: () => true, scheme: settings.scheme,
    mode: "suppress", setStatus: () => {}
  });
  action.current = next => tour.completeOrRun(next, { invoke: async () => {}, has: () => true });
  useEffect(() => {
    coordinator.current = new DialogCoordinator({
      subscribe: async handler => {
        host.toOwner = message => handler({ message, senderWindowId: DIALOG_LABEL, windowLabel: DIALOG_LABEL });
        return () => {};
      },
      open: async snapshot => {
        setTimeout(() => host.toDialog!(snapshot), 0);
        return { hostId: "tour", windowLabel: DIALOG_LABEL };
      },
      publish: async (_hostId, message) => { setTimeout(() => host.toDialog!(message), 0); },
      close: async () => {}
    }, { guidedTourAction: next => action.current(next), applyPageSize: () => {}, onError: () => {} });
    void tour.open();
  }, []);
  return null;
}

/** Resolve a command's shortcut label the way the document window does for the active scheme. */
function shortcutFor(commandId: string, settings: KeybindingSettings, platform: ShortcutPlatform) {
  const commands = createMainWindowShortcutCommands({
    quickActions: createQuickActions(createEmptyDocument(), undefined), layerActions: [], toolCommandSpecs: getToolsetCommandSpecs()
  }, settings.scheme, settings.overrides?.[settings.scheme]);
  const spec = commands.find(command => command.id === commandId);
  return formatShortcutLabel(spec?.shortcut || spec?.defaultShortcut, platform);
}
function menuShortcut(commandId: string, settings: KeybindingSettings, platform: ShortcutPlatform) {
  return flattenAppMenuCommands(buildAppMenuModel({
    platform, keybindingScheme: settings.scheme, keybindingOverrides: settings.overrides?.[settings.scheme],
    rulersVisible: true, crosshairsVisible: true, canUndo: false, canRedo: false,
    hasSelection: false, hasSelectedMolecule: false, toolbars: []
  })).find(item => item.commandId === commandId)?.shortcut;
}

const roots: Root[] = [];
const mount = async (element: Parameters<Root["render"]>[0]) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};
const settle = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 10)); });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new MemoryStorage());
  host.native = {};
  host.listeners.clear();
  // The native preferences file: a patch updates only the fields it names (lib.rs apply_patch).
  host.invoke.mockReset().mockImplementation(async (command: string, args?: { patch?: Record<string, unknown> }) => {
    if (command === "desktop_preferences") {
      if (args?.patch) host.native = { ...host.native, ...args.patch };
      return { ...host.native };
    }
    return undefined;
  });
  mainScheme = undefined;
});
afterEach(() => {
  act(() => roots.splice(0).forEach(root => root.unmount()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each(["macos", "windows"] as const)("applies Classic from tour step 2 through the Preferences setting on %s", async platform => {
  // Start from ChemDraft's scheme, as an existing install has it after shortcutDefaultMigration.ts,
  // so choosing Classic is a real switch.
  host.native = { shortcutScheme: "chemdraft" };
  saveKeybindingSettings({ scheme: "chemdraft" });
  const preferences = await mount(createElement(PreferencesWindow));
  const tour = await mount(createElement(DialogWindow, { hostId: "tour" }));
  await mount(createElement(DocumentWindow));
  await act(async () => { await import("./TourForm"); });
  await settle();

  const before = loadKeybindingSettings();
  expect(before.scheme).toBe("chemdraft");
  expect(shortcutFor("view.toggleRulers", before, platform)).toBe(platform === "macos" ? "⌘R" : "Ctrl+R");
  const checked = (root: HTMLElement, name: string) =>
    [...root.querySelectorAll<HTMLInputElement>(`input[type=radio][name="${name}"]`)].map(radio => radio.checked);
  expect(checked(preferences, "keybinding-scheme")).toEqual([true, false]);

  const button = (text: string) => [...tour.querySelectorAll("button")].find(item => item.textContent === text)!;
  await act(async () => button("Next").click());
  expect(tour.textContent).toContain("Your choice applies right away.");
  await act(async () => tour.querySelectorAll<HTMLInputElement>("input[name=tour-shortcuts]")[1]!.click());
  await settle();

  // Same stored setting and native file as Preferences, and the document window switched live.
  const after = loadKeybindingSettings();
  expect(after.scheme).toBe("chemdraw");
  expect(host.native.shortcutScheme).toBe("chemdraw");
  expect(host.invoke).toHaveBeenCalledWith("desktop_preferences", { patch: { shortcutScheme: "chemdraw" } });
  expect(mainScheme).toBe("chemdraw");
  expect(shortcutFor("view.toggleRulers", after, platform)).toBe(platform === "macos" ? "⌘;" : "Ctrl+;");
  expect(menuShortcut("view.toggleRulers", after, platform)).toBe(platform === "macos" ? "⌘;" : "Ctrl+;");
  // Preferences, already open, shows the new scheme; the tour confirms the choice.
  expect(checked(preferences, "keybinding-scheme")).toEqual([false, true]);
  expect(checked(tour, "tour-shortcuts")).toEqual([false, true]);
  expect(tour.querySelector("[role=alert]")).toBeNull();

  // Next does not undo or re-apply the choice.
  await act(async () => button("Next").click());
  await settle();
  expect(loadKeybindingSettings().scheme).toBe("chemdraw");
  expect(mainScheme).toBe("chemdraw");
});
