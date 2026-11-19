// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TourForm } from "./TourForm";
import { tourShortcutChoices, tourSteps } from "./tourSteps";
import { parseDialogMessage } from "../dialogs/dialogProtocol";

let container: HTMLDivElement;
let root: Root;

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

describe.each(["macos", "windows"] as const)("guided tour on %s", platform => {
  const button = (text: string) => [...container.querySelectorAll("button")].find(button => button.textContent === text)!;
  const click = (text: string) => act(() => button(text).click());

  it("offers a one-click Skip on every step and Finish on the last step", () => {
    const onAction = vi.fn();
    act(() => root.render(<TourForm scheme="chemdraft" platform={platform} onAction={onAction} />));
    expect(button("Back").disabled).toBe(true);
    for (let step = 1; step <= 7; step++) {
      expect(container.textContent).toContain(`Step ${step} of 7`);
      expect(button("Skip tour").disabled).toBe(false);
      click("Skip tour");
      expect(onAction).toHaveBeenLastCalledWith({ action: "cancel" });
      if (step < 7) click("Next");
    }
    expect(onAction).toHaveBeenCalledTimes(7);
    click("Back");
    expect(container.textContent).toContain("Step 6 of 7");
    click("Next");
    click("Finish");
    expect(onAction).toHaveBeenLastCalledWith({ action: "finish" });
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    expect(onAction).toHaveBeenLastCalledWith({ action: "cancel" });
  });

  it("offers real commands and displays platform-specific shortcut examples", () => {
    const onAction = vi.fn();
    act(() => root.render(<TourForm scheme="chemdraft" platform={platform} onAction={onAction} />));
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

    for (const command of ["help.tour.openSample", "plugin.opsinNameToStructure.convert", "analyze.molecularProperties"]) {
      click("Next");
      click("Try it");
      expect(onAction).toHaveBeenLastCalledWith({ action: "tryTourCommand", command });
    }
    click("Next");
    click("Next");
    const text = container.textContent;
    expect(text).toContain(platform === "macos" ? "ChemDraft menu (⌘,)" : "File menu (Ctrl+,)");
  });

  it("keeps public copy free of other drawing product names", () => {
    const banned = /chemdraw|marvin(?:sketch)?|isischem|isis\/draw|acd\/chemsketch|chemsketch|ketcher|chemwindow|bkchem/i;
    for (const scheme of ["chemdraft", "chemdraw"] as const) {
      for (const step of tourSteps(scheme, platform)) {
        expect(step.title + step.text).not.toMatch(banned);
      }
    }
  });
});

it("validates the native tour action allowlist", () => {
  const envelope = {
    protocolVersion: 1, ownerWindowId: "main", documentTabId: "guidedTour", dialogKind: "guidedTour",
    sessionId: "session", requestId: "request", snapshotRevision: 1
  };
  expect(parseDialogMessage({ ...envelope, type: "snapshot", data: { title: "Take the Tour", scheme: "chemdraft", automatic: true } })).toBeDefined();
  for (const data of [
    { action: "tryTourCommand", command: "document.save" },
    { action: "chooseShortcuts", scheme: "other" },
    { action: "cancel", command: "document.save" }
  ]) {
    expect(parseDialogMessage({ ...envelope, type: "action", data })).toBeUndefined();
  }
});
