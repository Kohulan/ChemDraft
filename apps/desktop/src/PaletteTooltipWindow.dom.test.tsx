// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PaletteTooltipWindow } from "./PaletteTooltipWindow";
import type { PaletteTooltipPayload } from "./window-manager";

const native = vi.hoisted(() => ({
  show: undefined as undefined | ((payload: PaletteTooltipPayload) => void),
  hide: undefined as undefined | (() => void),
  invoke: vi.fn(async () => {}),
  bounds: vi.fn(async () => ({ left: 0, top: 0, right: 1920, bottom: 1080 })),
  setSize: vi.fn(async () => {})
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("./window-manager", () => ({
  listenForPaletteTooltipShow: async (callback: typeof native.show) => { native.show = callback; return () => {}; },
  listenForPaletteTooltipHide: async (callback: typeof native.hide) => { native.hide = callback; return () => {}; },
  monitorLogicalBoundsAt: native.bounds,
  setCurrentWindowLogicalSize: native.setSize
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const payload = (title: string): PaletteTooltipPayload => ({ title, anchorCenterX: 200, belowY: 100, aboveY: 60 });

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 26, width: 100, height: 26, toJSON: () => undefined
  });
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  // jsdom reports no navigator.platform, which detects as Linux. These tests pin the macOS/Windows
  // path (resize from the webview, then show at a position); the Linux test below re-renders.
  await act(async () => root.render(createElement(PaletteTooltipWindow, { platform: "macos" })));
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks();
});

it("does not let A's queued native hide hide B's same-tick show", async () => {
  await act(async () => native.show!(payload("A")));
  native.invoke.mockClear();
  await act(async () => {
    native.hide!();
    native.show!(payload("B"));
  });
  expect(container.textContent).toBe("B");
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith("show_toolset_tooltip_window", { x: 150, y: 100 });
  await act(async () => native.hide!());
  expect(container.textContent).toBe("");
  expect(native.invoke).toHaveBeenLastCalledWith("hide_toolset_tooltip_window");
});

it("does not reveal a tooltip whose measurement finished after it was hidden", async () => {
  let finish!: (bounds: { left: number; top: number; right: number; bottom: number }) => void;
  native.bounds.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => native.show!(payload("A")));
  await act(async () => native.hide!());
  await act(async () => finish({ left: 0, top: 0, right: 1920, bottom: 1080 }));
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith("hide_toolset_tooltip_window");
  expect(container.textContent).toBe("");
});

it("keeps resizing from the webview before showing on macOS and Windows", async () => {
  await act(async () => native.show!(payload("A")));
  expect(native.setSize).toHaveBeenCalledExactlyOnceWith({ width: 100, height: 26 });
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith("show_toolset_tooltip_window", { x: 150, y: 100 });
});

it("on Linux sizes each tooltip in the show command, shrinking after a larger one", async () => {
  await act(async () => root.render(createElement(PaletteTooltipWindow, { platform: "linux" })));
  const rect = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
  rect.mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 220, bottom: 64, width: 220, height: 64, toJSON: () => undefined
  });
  await act(async () => native.show!(payload("Single Bond")));
  rect.mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 104.4, bottom: 21.2, width: 104.4, height: 21.2, toJSON: () => undefined
  });
  await act(async () => native.show!(payload("Orbital Lobe Tool")));
  // No separate resize from the webview: Rust pins and applies the size before mapping.
  expect(native.setSize).not.toHaveBeenCalled();
  expect(native.invoke.mock.calls).toEqual([
    ["show_toolset_tooltip_window", { x: 90, y: 100, width: 220, height: 64 }],
    ["show_toolset_tooltip_window", { x: 148, y: 100, width: 105, height: 22 }]
  ]);
});
