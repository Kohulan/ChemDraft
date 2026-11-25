import { describe, expect, it } from "vitest";
import { browserDropClientPoint, dropPagePoint, tauriDropClientPoint } from "./dropPosition";

describe("tauriDropClientPoint", () => {
  // The same pointer at CSS point (300, 150) as each platform's webview layer reports it.
  it.each([1, 1.5, 2])("macOS reports CSS points at scale %s", (scale) => {
    expect(tauriDropClientPoint({ x: 300, y: 150 }, "macos", scale)).toEqual({ x: 300, y: 150 });
  });

  it.each([1, 1.5, 2])("Linux reports logical pixels at scale %s", (scale) => {
    expect(tauriDropClientPoint({ x: 300, y: 150 }, "linux", scale)).toEqual({ x: 300, y: 150 });
  });

  it.each([1, 1.5, 2])("Windows reports physical client pixels at scale %s", (scale) => {
    expect(tauriDropClientPoint({ x: 300 * scale, y: 150 * scale }, "windows", scale)).toEqual({ x: 300, y: 150 });
  });

  it("has no point for a missing or malformed position, and ignores a bad scale", () => {
    expect(tauriDropClientPoint(undefined, "windows", 2)).toBeUndefined();
    expect(tauriDropClientPoint({ x: "1", y: 2 }, "macos", 1)).toBeUndefined();
    expect(tauriDropClientPoint({ x: Number.NaN, y: 2 }, "linux", 1)).toBeUndefined();
    expect(tauriDropClientPoint({ x: 10, y: 20 }, "windows", 0)).toEqual({ x: 10, y: 20 });
  });
});

describe("browserDropClientPoint", () => {
  it("reads clientX/clientY and rejects synthetic events without them", () => {
    expect(browserDropClientPoint({ clientX: 4, clientY: 5 })).toEqual({ x: 4, y: 5 });
    expect(browserDropClientPoint({})).toBeUndefined();
  });
});

describe("dropPagePoint", () => {
  const canvas = { left: 100, top: 80, right: 900, bottom: 700 };
  const page = { width: 816, height: 1056 };

  it("maps a client point to page units at the current zoom", () => {
    expect(dropPagePoint({ x: 300, y: 280 }, canvas, { left: 150, top: 130 }, 2, page)).toEqual({ x: 75, y: 75 });
    expect(dropPagePoint({ x: 300, y: 280 }, canvas, { left: 150, top: 130 }, 0.5, page)).toEqual({ x: 300, y: 300 });
  });

  it("puts a drop over a toolbar or the pasteboard at the nearest point of the visible page", () => {
    // Above the canvas (a toolbar): pulled down to the canvas top, then to the page.
    expect(dropPagePoint({ x: 400, y: 10 }, canvas, { left: 150, top: 130 }, 1, page)).toEqual({ x: 250, y: 0 });
    // On the pasteboard left of the page.
    expect(dropPagePoint({ x: 120, y: 300 }, canvas, { left: 150, top: 130 }, 1, page)).toEqual({ x: 0, y: 170 });
    // The page scrolled up: a toolbar drop lands at the top of what is visible, not the page's top.
    expect(dropPagePoint({ x: 400, y: 10 }, canvas, { left: 150, top: -400 }, 1, page)).toEqual({ x: 250, y: 480 });
  });
});
