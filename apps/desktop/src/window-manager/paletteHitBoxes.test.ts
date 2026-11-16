import { afterEach, expect, it, vi } from "vitest";
import { setPaletteCommandHitBoxes } from "./index";

const native = vi.hoisted(() => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("publishes commands and tagged chooser bounds in one backwards-compatible native snapshot", async () => {
  vi.stubGlobal("__TAURI__", {});
  const command = { x: 10, y: 20, width: 30, height: 40 };
  const chooser = { x: 50, y: 20, width: 30, height: 40 };
  await setPaletteCommandHitBoxes([command], [chooser]);
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith("set_palette_command_hit_boxes", {
    boxes: [command, { ...chooser, nativeChooser: true }]
  });
  await setPaletteCommandHitBoxes([], []);
  expect(native.invoke).toHaveBeenLastCalledWith("set_palette_command_hit_boxes", { boxes: [] });
});

it("does not send native rectangles in the browser fallback", async () => {
  vi.stubGlobal("__TAURI__", undefined);
  vi.stubGlobal("__TAURI_INTERNALS__", undefined);
  await setPaletteCommandHitBoxes([{ x: 0, y: 0, width: 20, height: 20 }]);
  expect(native.invoke).not.toHaveBeenCalled();
});
