// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { browserDecodeCheck, browserRasterToPng, encodeWithDownscale, untilAborted } from "./rasterDecode";

describe("encodeWithDownscale", () => {
  it("keeps full size when the PNG fits", async () => {
    const sizes: Array<[number, number]> = [];
    const result = await encodeWithDownscale({ width: 400, height: 300 }, 1000, async (width, height) => {
      sizes.push([width, height]);
      return new Uint8Array(10);
    });
    expect(sizes).toEqual([[400, 300]]);
    expect(result).toMatchObject({ width: 400, height: 300, sourceWidth: 400, sourceHeight: 300, downscaled: false });
  });

  it("steps down until the PNG fits, treating a refused canvas as too large", async () => {
    const sizes: Array<[number, number]> = [];
    const result = await encodeWithDownscale({ width: 4000, height: 3000 }, 1_000_000, async (width, height) => {
      sizes.push([width, height]);
      if (width > 3000) return undefined;
      return new Uint8Array(width * height / 4);
    });
    expect(sizes).toEqual([[4000, 3000], [3000, 2250], [2250, 1687]]);
    expect(result).toMatchObject({ width: 2250, height: 1687, sourceWidth: 4000, sourceHeight: 3000, downscaled: true });
  });

  it("gives up rather than shrinking to nothing", async () => {
    await expect(encodeWithDownscale({ width: 64, height: 64 }, 0, async () => new Uint8Array(1)))
      .rejects.toThrow("it is still too large as PNG after scaling it down.");
  });
});

describe("browser decoding under a deadline", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const bitmap = (width: number, height: number) => ({ width, height, close: vi.fn() });
  const deadline = () => {
    const controller = new AbortController();
    return { controller, expire: () => controller.abort(new Error("reading it took longer than 30 seconds.")) };
  };

  it("rejects at the deadline and closes a bitmap that arrives late", async () => {
    let deliver!: (value: ReturnType<typeof bitmap>) => void;
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise(resolve => { deliver = resolve; })));
    const { controller, expire } = deadline();
    const pending = browserRasterToPng(new Uint8Array([1]), "image/jpeg", 1000, { signal: controller.signal });
    expire();
    await expect(pending).rejects.toThrow("reading it took longer than 30 seconds.");
    const late = bitmap(10, 10);
    deliver(late);
    await Promise.resolve();
    expect(late.close).toHaveBeenCalledTimes(1);
  });

  it("checks the decoder's own size against the caps before making a canvas", async () => {
    const big = bitmap(16_385, 2);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => big));
    const createElement = vi.spyOn(document, "createElement");
    await expect(browserRasterToPng(new Uint8Array([1]), "image/gif", 1000))
      .rejects.toThrow("it is 16385 × 2 pixels; the limit is 16384 pixels on a side.");
    expect(createElement).not.toHaveBeenCalledWith("canvas");
    expect(big.close).toHaveBeenCalled();
  });

  it("ends an encoder that never calls back, without trying smaller sizes", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap(40, 30)));
    const context = { drawImage: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: "low" };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(() => {});
    const { controller, expire } = deadline();
    const pending = browserRasterToPng(new Uint8Array([1]), "image/webp", 1000, { signal: controller.signal });
    await vi.waitFor(() => expect(toBlob).toHaveBeenCalledTimes(1));
    expire();
    await expect(pending).rejects.toThrow("reading it took longer than 30 seconds.");
    expect(toBlob).toHaveBeenCalledTimes(1);
  });

  it("ends an image decode that never settles and releases its object URL", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: () => "blob:x", revokeObjectURL: revoke }));
    // jsdom has no decode(): stand in one that never settles.
    Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: () => new Promise(() => {}) });
    const { controller, expire } = deadline();
    const pending = browserDecodeCheck(new Uint8Array([1]), "image/svg+xml", { signal: controller.signal });
    expire();
    await expect(pending).rejects.toThrow("reading it took longer than 30 seconds.");
    expect(revoke).toHaveBeenCalledWith("blob:x");
    Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
  });

  it("untilAborted passes a value through when nothing aborts", async () => {
    await expect(untilAborted(Promise.resolve(3), new AbortController().signal)).resolves.toBe(3);
    await expect(untilAborted(Promise.reject(new Error("no")), undefined)).rejects.toThrow("no");
  });
});
