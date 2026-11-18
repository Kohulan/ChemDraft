// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentWindowLogicalWorkArea, fitCurrentPaletteWindow } from "./index";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  currentMonitor: vi.fn()
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  currentMonitor: native.currentMonitor
}));

describe("palette work-area sizing", () => {
  beforeEach(() => {
    vi.stubGlobal("__TAURI__", {});
    native.currentMonitor.mockReset();
    native.invoke.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([1, 1.5, 2])("uses the monitor's own scale (%s) and excludes OS chrome", async (scaleFactor) => {
    native.currentMonitor.mockResolvedValue({
      scaleFactor,
      position: { x: -1920 * scaleFactor, y: 0 },
      size: { width: 1920 * scaleFactor, height: 1080 * scaleFactor },
      workArea: {
        position: { x: -1920 * scaleFactor, y: 24 * scaleFactor },
        size: { width: 1920 * scaleFactor, height: 1016 * scaleFactor }
      }
    });
    expect(await currentWindowLogicalWorkArea()).toEqual({ left: -1920, top: 24, right: 0, bottom: 1040 });
  });

  it("uses available screen dimensions when the monitor query fails", async () => {
    native.currentMonitor.mockRejectedValue(new Error("No monitor"));
    vi.spyOn(window.screen, "availHeight", "get").mockReturnValue(720);
    vi.spyOn(window.screen, "availWidth", "get").mockReturnValue(1280);
    expect(await currentWindowLogicalWorkArea()).toEqual({ left: 0, top: 0, right: 1280, bottom: 720 });
  });

  it("caps an oversized inspector without supplying a replacement origin", async () => {
    await fitCurrentPaletteWindow({ width: 553, height: 1214 }, { left: 0, top: 24, right: 1920, bottom: 1040 });
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("resize_toolset_window", { width: 553, height: 1016 });
  });

  it("uses the calling palette's live position and native work area for title-strip recovery", () => {
    const nativeSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/lib.rs"), "utf8");
    const resize = nativeSource.split("fn resize_toolset_window(")[1]!.split("/// Pre-build")[0]!;
    expect(resize).toMatch(/window\.outer_position\(\)[\s\S]*toolset_content_placement\([\s\S]*monitor_logical_work_area\(&monitor\)/);
    expect(resize).toContain("toolset_position_in_work_area(position, width, height, area)");
    const recover = nativeSource.split("fn toolset_position_in_work_area(")[1]!.split("/// Pull a palette")[0]!;
    expect(recover).toContain("area.contains_title_strip(position.x, position.y, width, TOOLSET_TITLE_HEIGHT)");
    const reopen = nativeSource.split("fn clamp_toolset_position<")[1]!.split("/// Move an already-built palette")[0]!;
    expect(reopen).toContain("monitor_logical_work_area(monitor).contains_title_strip(");
  });

  it("samples the visible native palette instead of persisting queued move coordinates", () => {
    const nativeSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/lib.rs"), "utf8");
    const moved = nativeSource.split("WindowEvent::Moved(_) => {")[1]!.split("WindowEvent::CloseRequested")[0]!;
    expect(moved).toMatch(/visible_toolset_physical_position\(window\)[\s\S]*persist_toolset_position\(/);
    const sample = nativeSource.split("fn visible_toolset_physical_position<")[1]!.split("fn current_toolset_window_position<")[0]!;
    expect(sample).toMatch(/!window\.is_visible\(\)[\s\S]*toolset_frame_is_transient\([\s\S]*return None;[\s\S]*window\.outer_position\(\)/);
  });

  it("sends the requested size unchanged when it fits within the work area", async () => {
    await fitCurrentPaletteWindow({ width: 520, height: 600 }, { left: 0, top: 24, right: 1920, bottom: 1040 });
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("resize_toolset_window", { width: 520, height: 600 });
  });

  it("reports a skipped native resize so the caller can retry the same measurement", async () => {
    native.invoke.mockResolvedValueOnce(false);
    const size = { width: 520, height: 600 };
    const area = { left: 0, top: 24, right: 1920, bottom: 1040 };
    await expect(fitCurrentPaletteWindow(size, area)).resolves.toBe(false);
    await expect(fitCurrentPaletteWindow(size, area)).resolves.toBe(true);
    expect(native.invoke.mock.calls).toEqual([
      ["resize_toolset_window", size],
      ["resize_toolset_window", size]
    ]);
  });
});
