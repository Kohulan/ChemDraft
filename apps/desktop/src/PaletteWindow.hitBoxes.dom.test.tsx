// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultNativeTextStyle } from "@chemdraft/chem-core";
import { PaletteWindow } from "./PaletteWindow";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import {
  broadcastToolsetCustomizeMode, broadcastToolsetTextStyle, createToolsetTextStylePayload,
  type ToolsetPopoverContentPayload
} from "./window-manager";

const native = vi.hoisted(() => ({
  publish: vi.fn(async (_boxes: unknown[], _choosers: unknown[]) => {}),
  content: undefined as undefined | ((payload: ToolsetPopoverContentPayload) => void)
}));
vi.mock("./window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("./window-manager")>(),
  setPaletteCommandHitBoxes: native.publish,
  listenForToolsetPopoverContent: vi.fn(async handler => { native.content = handler; return () => {}; }),
  setCurrentWindowLogicalSize: vi.fn(async () => {}),
  setCurrentWindowLogicalPosition: vi.fn(async () => {}),
  showCurrentToolsetPopoverWindow: vi.fn(async () => {})
}));
vi.mock("./plugins/pluginPanelInputFocus", async importOriginal => ({
  ...await importOriginal<typeof import("./plugins/pluginPanelInputFocus")>(),
  installPaletteInputFocus: () => () => {}
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement, root: Root | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(5, 10, 20, 30));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function frame() { await act(async () => { await vi.advanceTimersByTimeAsync(20); }); }
async function selectCaption() {
  await act(async () => broadcastToolsetTextStyle(createToolsetTextStylePayload(
    DefaultNativeTextStyle, "normal", undefined, undefined, undefined,
    { kind: "text", objectTypes: ["text"], moleculeContext: "none", arrowToolIds: [], textEditing: true, selectedCount: 1 }
  )));
}

describe("native palette hit-region lifetime", () => {
  it("keeps command and chooser rectangles through selection broadcasts; clears on customize and unmount", async () => {
    await act(async () => root!.render(createElement(PaletteWindow, { toolsetId: "core.main", platform: "windows" })));
    await frame();
    await selectCaption();
    await frame();
    const snapshot = native.publish.mock.calls.at(-1)!;
    expect(snapshot[0].length).toBeGreaterThan(0);
    expect(snapshot[1].length).toBeGreaterThan(0);
    native.publish.mockClear();
    for (let i = 0; i < 3; i++) {
      await selectCaption(); // New deserialized selection identity each time.
      expect(native.publish.mock.calls.some(([boxes, choosers]) => !boxes.length && !choosers.length)).toBe(false);
      await frame();
    }
    expect(native.publish.mock.calls.every(([boxes, choosers]) => boxes.length && choosers.length)).toBe(true);
    await act(async () => broadcastToolsetCustomizeMode({ toolsetId: "core.main", active: true }));
    expect(native.publish).toHaveBeenLastCalledWith([], []);
    await frame();
    expect(native.publish).toHaveBeenLastCalledWith([], []);
    await act(async () => broadcastToolsetCustomizeMode({ toolsetId: "core.main", active: false }));
    await frame();
    expect(native.publish.mock.calls.at(-1)![0].length).toBeGreaterThan(0);
    await act(async () => root!.unmount());
    root = undefined;
    expect(native.publish).toHaveBeenLastCalledWith([], []);
    const calls = native.publish.mock.calls.length;
    await frame();
    expect(native.publish).toHaveBeenCalledTimes(calls);
  });

  it("replaces reused popover chooser bounds with command bounds and clears both on unmount", async () => {
    await act(async () => root!.render(createElement(PalettePopoverWindow, {
      toolsetId: "core.main", kind: "textColor", prewarm: true, platform: "windows"
    })));
    await frame();
    expect(native.publish.mock.calls.at(-1)![1].length).toBeGreaterThan(0);
    native.publish.mockClear();
    await act(async () => native.content?.({
      toolsetId: "core.main", kind: "flyout", openedAt: 1,
      flyout: { flyoutId: "charge", title: "Charge", commands: [
        { id: "charge.plus", title: "Positive", enabled: true, active: false }
      ] }
    }));
    expect(native.publish).not.toHaveBeenCalledWith([], []);
    await frame();
    expect(native.publish.mock.calls.at(-1)![0].length).toBeGreaterThan(0);
    expect(native.publish.mock.calls.at(-1)![1]).toEqual([]);
    await act(async () => root!.unmount());
    root = undefined;
    expect(native.publish).toHaveBeenLastCalledWith([], []);
  });

  it("does not publish or clear native regions on macOS", async () => {
    await act(async () => root!.render(createElement(PaletteWindow, { toolsetId: "core.main", platform: "macos" })));
    await selectCaption();
    await frame();
    await act(async () => root!.unmount());
    root = undefined;
    expect(native.publish).not.toHaveBeenCalled();
  });
});
