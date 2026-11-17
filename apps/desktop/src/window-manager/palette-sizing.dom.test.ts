// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentWindowLogicalWorkArea, fitCurrentPaletteWindow, monitorLogicalBoundsAt } from "./index";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  workArea: vi.fn(),
  boundsAt: vi.fn(),
  setSize: vi.fn(),
  position: { x: 100, y: 100 }
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setSize: native.setSize }),
  LogicalSize: class {
    constructor(public width: number, public height: number) {}
  }
}));

describe("palette work-area sizing", () => {
  beforeEach(() => {
    vi.stubGlobal("__TAURI__", {});
    native.position = { x: 100, y: 100 };
    native.setSize.mockReset().mockResolvedValue(undefined);
    native.workArea.mockReset();
    native.boundsAt.mockReset().mockResolvedValue(null);
    native.invoke.mockReset().mockImplementation(async (command, payload) => {
      if (command === "window_logical_position") return { ...native.position };
      if (command === "set_current_window_global_position") native.position = { ...payload };
      if (command === "current_window_logical_work_area") return native.workArea();
      if (command === "monitor_logical_bounds_at") return native.boundsAt(payload);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // The scale conversion itself is tested in Rust (monitor_query.rs).
  it("uses the native work area, which excludes OS chrome", async () => {
    native.workArea.mockResolvedValue({ left: -1920, top: 24, right: 0, bottom: 1040 });
    expect(await currentWindowLogicalWorkArea()).toEqual({ left: -1920, top: 24, right: 0, bottom: 1040 });
    expect(native.invoke).toHaveBeenCalledWith("current_window_logical_work_area");
  });

  it.each([
    ["fails", () => native.workArea.mockRejectedValue(new Error("No monitor"))],
    ["finds no monitor", () => native.workArea.mockResolvedValue(null)]
  ])("uses available screen dimensions when the monitor query %s", async (_case, arrange) => {
    arrange();
    vi.spyOn(window.screen, "availHeight", "get").mockReturnValue(720);
    vi.spyOn(window.screen, "availWidth", "get").mockReturnValue(1280);
    expect(await currentWindowLogicalWorkArea()).toEqual({ left: 0, top: 0, right: 1280, bottom: 720 });
  });

  it("asks the native side for the monitor under a point", async () => {
    native.boundsAt.mockResolvedValue({ left: 1920, top: 0, right: 4480, bottom: 1440 });
    expect(await monitorLogicalBoundsAt(2000, 100)).toEqual({ left: 1920, top: 0, right: 4480, bottom: 1440 });
    expect(native.boundsAt).toHaveBeenCalledWith({ x: 2000, y: 100 });
    native.boundsAt.mockResolvedValue(null);
    expect(await monitorLogicalBoundsAt(9000, 0)).toBeUndefined();
    native.boundsAt.mockRejectedValue(new Error("no runtime"));
    expect(await monitorLogicalBoundsAt(0, 0)).toBeUndefined();
  });

  it("caps an oversized inspector and moves its entire frame into the work area", async () => {
    native.position = { x: 1500, y: 700 };
    await fitCurrentPaletteWindow({ width: 553, height: 1214 }, { left: 0, top: 24, right: 1920, bottom: 1040 });
    expect(native.setSize).toHaveBeenCalledWith({ width: 553, height: 1016 });
    expect(native.invoke).toHaveBeenCalledWith("set_current_window_global_position", { x: 1367, y: 24 });
  });

  it("restores the top-left when a native resize shifts the window's top edge", async () => {
    native.setSize.mockImplementation(async () => { native.position.y = -200; });
    await fitCurrentPaletteWindow({ width: 520, height: 600 }, { left: 0, top: 24, right: 1920, bottom: 1040 });
    expect(native.invoke).toHaveBeenCalledWith("set_current_window_global_position", { x: 100, y: 100 });
  });

  it("does not move a window whose resized frame already fits", async () => {
    await fitCurrentPaletteWindow({ width: 520, height: 600 }, { left: 0, top: 24, right: 1920, bottom: 1040 });
    expect(native.setSize).toHaveBeenCalledWith({ width: 520, height: 600 });
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual([
      "window_logical_position", "window_logical_position"
    ]);
  });
});
