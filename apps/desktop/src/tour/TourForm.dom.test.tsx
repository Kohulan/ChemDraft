// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TourForm } from "./TourForm";
import { tourShortcutChoices, tourSteps } from "./tourSteps";
import { TOUR_PLUGIN_COMMANDS } from "./tourCommands";
import { parseDialogMessage } from "../dialogs/dialogProtocol";
import { buildAppMenuModel, flattenAppMenuCommands } from "../appMenu";

let container: HTMLDivElement;
let root: Root;
const platforms = ["macos", "windows"] as const;
const schemes = ["chemdraft", "chemdraw"] as const;
// Every plugin a step can demonstrate, installed and enabled.
const allPlugins = TOUR_PLUGIN_COMMANDS;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe.each(platforms)("guided tour on %s", platform => {
  const button = (text: string) => [...container.querySelectorAll("button")].find(button => button.textContent === text)!;
  const click = (text: string) => act(() => button(text).click());

  it("offers a one-click Skip on every step and Finish on the last step", () => {
    const onAction = vi.fn();
    act(() => root.render(<TourForm scheme="chemdraft" platform={platform} plugins={allPlugins} onAction={onAction} />));
    expect(button("Back").disabled).toBe(true);
    for (let step = 1; step <= 8; step++) {
      expect(container.textContent).toContain(`Step ${step} of 8`);
      expect(button("Skip tour").disabled).toBe(false);
      click("Skip tour");
      expect(onAction).toHaveBeenLastCalledWith({ action: "cancel" });
      if (step < 8) click("Next");
    }
    expect(onAction).toHaveBeenCalledTimes(8);
    click("Back");
    expect(container.textContent).toContain("Step 7 of 8");
    click("Next");
    click("Finish");
    expect(onAction).toHaveBeenLastCalledWith({ action: "finish" });
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    expect(onAction).toHaveBeenLastCalledWith({ action: "cancel" });
  });

  it("offers real commands and displays platform-specific shortcut examples", () => {
    const onAction = vi.fn();
    act(() => root.render(<TourForm scheme="chemdraft" platform={platform} plugins={allPlugins} onAction={onAction} />));
    click("Next");
    const radios = container.querySelectorAll<HTMLInputElement>("input[type=radio]");
    expect(radios[0].checked).toBe(true);
    act(() => radios[1].click());
    expect(onAction).toHaveBeenLastCalledWith({ action: "chooseShortcuts", scheme: "chemdraw" });
    expect(container.textContent).toContain("Classic desktop-compatible");
    const choices = tourShortcutChoices(platform);
    expect(choices.map(choice => choice.examples.length)).toEqual([5, 5]);
    expect(choices.map(choice => choice.examples[0].key)).toEqual(["M", "X"]);
    expect(choices.map(choice => choice.examples.at(-1)?.key)).toEqual(platform === "macos" ? ["⌘S", "⌘S"] : ["Ctrl+S", "Ctrl+S"]);

    expect(container.textContent).toContain("Preferences > Keyboard");
    click("Try it");
    expect(onAction).toHaveBeenLastCalledWith({ action: "tryTourCommand", command: "view.openKeyboardPreferences" });

    for (const command of ["help.tour.openSample", undefined, "plugin.opsinNameToStructure.convert", "analyze.molecularProperties"]) {
      click("Next");
      if (!command) {
        // The plugins card explains plugins before the tour shows one; it has no Try it.
        expect(container.querySelector("h1")!.textContent).toBe("Add features with plugins");
        expect(button("Try it")).toBeUndefined();
        continue;
      }
      click("Try it");
      expect(onAction).toHaveBeenLastCalledWith({ action: "tryTourCommand", command });
    }
    click("Next");
    click("Next");
    const text = container.textContent;
    expect(text).toContain(platform === "macos" ? "Choose ChemDraft > Settings… (⌘,)" : "Choose File > Preferences… (Ctrl+,)");
  });

  it("names the Preferences menu item exactly as the menu bar labels it", () => {
    const sections = buildAppMenuModel({
      platform, rulersVisible: true, crosshairsVisible: true, canUndo: false, canRedo: false,
      hasSelection: false, hasSelectedMolecule: false, toolbars: []
    });
    const owner = sections.find(section => section.items.some(item => item.kind === "command" && item.commandId === "view.togglePreferences"))!;
    const item = flattenAppMenuCommands([owner]).find(command => command.commandId === "view.togglePreferences")!;
    expect([owner.label, item.label, item.shortcut]).toEqual(platform === "macos" ? ["ChemDraft", "Settings…", "⌘,"] : ["File", "Preferences…", "Ctrl+,"]);
    for (const scheme of schemes) {
      expect(tourSteps(scheme, platform).at(-1)!.text).toContain(`Choose ${owner.label} > ${item.label} (${item.shortcut}) to open Preferences.`);
    }
    if (platform !== "macos") {
      // Off macOS the native File menu shows the native item's own title.
      const source = readFileSync(resolve("apps", "desktop", "src-tauri", "src", "lib.rs"), "utf8");
      const native = source.split("fn preferences_menu_item<R: Runtime>")[1]!.split("fn create_view_menu")[0]!;
      expect(native).toContain(`"${item.label}",`);
    }
  });

  it("clears a step's error when the step changes, forward or back", () => {
    const onAction = vi.fn();
    const render = (error?: string) => act(() => root.render(<TourForm scheme="chemdraft" platform={platform} plugins={allPlugins} onAction={onAction} error={error} />));
    const alert = () => container.querySelector('[role="alert"]')?.textContent;
    const missing = "Add Name to Structure from Plugins > Add or Remove Plugins, then try again.";
    render();
    for (let step = 1; step < 5; step++) click("Next");
    expect(container.textContent).toContain("Step 5 of 8");
    click("Try it");
    render(missing);
    expect(alert()).toBe(missing);

    click("Next");
    expect(container.textContent).toContain("Step 6 of 8");
    expect(alert()).toBeUndefined();
    click("Back");
    expect(container.textContent).toContain("Step 5 of 8");
    expect(alert()).toBeUndefined();

    // A new action shows its own error again; leaving that step backward clears it too.
    click("Try it");
    render(undefined);
    render(missing);
    expect(alert()).toBe(missing);
    click("Back");
    expect(alert()).toBeUndefined();

    // A late error from an action sent on an earlier step does not appear on the new one.
    render(undefined);
    click("Next");
    click("Try it");
    click("Next");
    render("Late failure");
    expect(container.textContent).toContain("Step 6 of 8");
    expect(alert()).toBeUndefined();
    click("Try it");
    render(undefined);
    render("Inspector failed");
    expect(alert()).toBe("Inspector failed");
  });

  it("keeps public copy free of other drawing product names", () => {
    const banned = /chemdraw|marvin(?:sketch)?|isischem|isis\/draw|acd\/chemsketch|chemsketch|ketcher|chemwindow|bkchem/i;
    for (const scheme of schemes) {
      for (const step of [...tourSteps(scheme, platform), ...tourSteps(scheme, platform, allPlugins)]) {
        expect(step.title + step.text).not.toMatch(banned);
      }
    }
  });
});

const envelope = {
  protocolVersion: 1, ownerWindowId: "main", documentTabId: "guidedTour", dialogKind: "guidedTour",
  sessionId: "session", requestId: "request", snapshotRevision: 1
};

it("keeps TypeScript tour commands in sync with the native allowlist", () => {
  const source = readFileSync(resolve("apps", "desktop", "src-tauri", "src", "dialog_windows.rs"), "utf8");
  const nativeEnum = source.match(/enum GuidedTourCommand\s*\{([^}]*)\}/)?.[1] ?? "";
  const nativeCommands = new Set([...nativeEnum.matchAll(/#\[serde\(rename = "([^"]+)"\)\]/g)].map(match => match[1]!));
  const tourCommands = new Set(platforms
    .flatMap(platform => schemes.flatMap(scheme => tourSteps(scheme, platform, TOUR_PLUGIN_COMMANDS)))
    .map(step => step.tryCommand)
    .filter(command => command !== undefined));
  expect(nativeCommands).toEqual(tourCommands);
  for (const command of tourCommands) {
    expect(parseDialogMessage({ ...envelope, type: "action", data: { action: "tryTourCommand", command } })).toBeDefined();
  }
});

it("rejects invalid tour actions in the TypeScript dialog protocol", () => {
  expect(parseDialogMessage({ ...envelope, type: "snapshot", data: { title: "Take the Tour", scheme: "chemdraft", automatic: true } })).toBeDefined();
  for (const data of [
    { action: "tryTourCommand", command: "document.save" },
    { action: "chooseShortcuts", scheme: "other" },
    { action: "cancel", command: "document.save" }
  ]) {
    expect(parseDialogMessage({ ...envelope, type: "action", data })).toBeUndefined();
  }
});
