import { describe, expect, it } from "vitest";
import { browserDropClientPoint, drawableCanvasRect, dropPagePoint, tauriDropClientPoint } from "./dropPosition";

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

describe("drawableCanvasRect", () => {
  const box = (clientLeft = 0) => ({
    getBoundingClientRect: () => ({ left: 100, top: 80, right: 900, bottom: 700 }),
    clientLeft, clientTop: 0, clientWidth: 785, clientHeight: 605
  });

  it("leaves out the rulers and the scrollbars, as the canvas pointer check does", () => {
    // 15 px scrollbars on the right and at the bottom, 20 px rulers on the left and top.
    expect(drawableCanvasRect(box(), 20)).toEqual({ left: 120, top: 100, right: 885, bottom: 685 });
    expect(drawableCanvasRect(box(), 0)).toEqual({ left: 100, top: 80, right: 885, bottom: 685 });
    // A leading-edge scrollbar (right-to-left) moves the client area right.
    expect(drawableCanvasRect(box(15), 0)).toEqual({ left: 115, top: 80, right: 900, bottom: 685 });
  });

  it("puts a drop over a ruler or a scrollbar at the nearest drawable point, not under it", () => {
    const drawable = drawableCanvasRect(box(), 20);
    // Over the top ruler and over the vertical scrollbar.
    expect(dropPagePoint({ x: 400, y: 85 }, drawable, { left: 100, top: 80 }, 1, page())).toEqual({ x: 300, y: 20 });
    expect(dropPagePoint({ x: 895, y: 300 }, drawable, { left: 100, top: 80 }, 1, page())).toEqual({ x: 785, y: 220 });
  });

  function page() { return { width: 816, height: 1056 }; }
});
