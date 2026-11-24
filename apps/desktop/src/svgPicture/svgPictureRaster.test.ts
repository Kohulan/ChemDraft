import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  rasterizeSvgPicture,
  type SvgRasterCanvas,
  type SvgRasterEnvironment,
  type SvgRasterImage
} from "./svgPictureRaster";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

interface Harness {
  environment: SvgRasterEnvironment;
  blobs: Blob[];
  revoked: string[];
  images: SvgRasterImage[];
  canvases: SvgRasterCanvas[];
  draws: Array<[number, number, number, number]>;
}

function harness(options: {
  load?: "load" | "error" | "hang";
  drawError?: Error;
  blob?: Blob | null;
  noContext?: boolean;
} = {}): Harness {
  const window = new JSDOM("").window;
  const state: Harness = { blobs: [], revoked: [], images: [], canvases: [], draws: [],
    environment: undefined as unknown as SvgRasterEnvironment };
  state.environment = {
    parseSvg: (svg) => new window.DOMParser().parseFromString(svg, "image/svg+xml") as unknown as Document,
    serialize: (node) => new window.XMLSerializer().serializeToString(node as never),
    createImage: () => {
      const image: SvgRasterImage = { onload: null, onerror: null, src: "" };
      let source = "";
      Object.defineProperty(image, "src", {
        get: () => source,
        set: (value: string) => {
          source = value;
          if (value === "") return;
          if (options.load === "hang") return;
          queueMicrotask(() => (options.load === "error" ? image.onerror : image.onload)?.());
        }
      });
      state.images.push(image);
      return image;
    },
    createCanvas: () => {
      const canvas: SvgRasterCanvas = {
        width: 0, height: 0,
        getContext: () => options.noContext ? null : { drawImage: (_image, x, y, width, height) => {
          if (options.drawError) throw options.drawError;
          state.draws.push([x, y, width, height]);
        } },
        toBlob: (callback) => callback(options.blob === undefined ? new Blob([PNG], { type: "image/png" }) : options.blob)
      };
      state.canvases.push(canvas);
      return canvas;
    },
    createObjectUrl: (blob) => { state.blobs.push(blob); return `blob:test/${state.blobs.length}`; },
    revokeObjectUrl: (url) => { state.revoked.push(url); },
    decodeTimeoutMs: 5000
  };
  return state;
}

const request = (svg: string, pixelWidth = 300, pixelHeight = 150) => ({ svg, width: 96, height: 48, pixelWidth, pixelHeight });
const attribute = async (state: Harness, name: string) =>
  new JSDOM(await state.blobs[0]!.text(), { contentType: "image/svg+xml" }).window.document.documentElement.getAttribute(name);

afterEach(() => vi.useRealTimers());

describe("rasterizeSvgPicture", () => {
  it("draws the SVG through an Image onto a canvas and returns the PNG bytes", async () => {
    const state = harness();
    const bytes = await rasterizeSvgPicture(request('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48" viewBox="0 0 96 48"/>'), state.environment);
    expect([...bytes]).toEqual([...PNG]);
    expect(state.draws).toEqual([[0, 0, 300, 150]]);
    expect(state.blobs[0]!.type).toBe("image/svg+xml");
    expect(state.images[0]!.onload).toBeNull();
  });

  it("releases the canvas and the URL, on success and on failure", async () => {
    const ok = harness();
    await rasterizeSvgPicture(request('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"/>'), ok.environment);
    expect(ok.revoked).toEqual(["blob:test/1"]);
    expect([ok.canvases[0]!.width, ok.canvases[0]!.height]).toEqual([0, 0]);
    const failed = harness({ load: "error" });
    await expect(rasterizeSvgPicture(request('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"/>'), failed.environment))
      .rejects.toThrow("the SVG could not be decoded");
    expect(failed.revoked).toEqual(["blob:test/1"]);
    expect(failed.images[0]!.src).toBe("");
  });

  it.each([
    ["no size", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"/>', "viewBox", "0 0 100 50"],
    ["percentage size", '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 100 50"/>', "viewBox", "0 0 100 50"],
    ["no size and no viewBox", '<svg xmlns="http://www.w3.org/2000/svg"/>', "viewBox", "0 0 300 150"],
    ["a size in points and no viewBox", '<svg xmlns="http://www.w3.org/2000/svg" width="72pt" height="36pt"/>', "viewBox", "0 0 96 48"]
  ])("gives a root with %s an explicit size without cropping it", async (_name, svg, name, expected) => {
    const state = harness();
    await rasterizeSvgPicture(request(svg, 600, 300), state.environment);
    expect(await attribute(state, name)).toBe(expected);
    expect(await attribute(state, "width")).toBe("600");
    expect(await attribute(state, "height")).toBe("300");
  });

  it("keeps the SVG's own preserveAspectRatio and renders at the intrinsic aspect when the frame is stretched", async () => {
    const state = harness();
    await rasterizeSvgPicture(request('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 10 10" preserveAspectRatio="xMinYMin slice"/>', 400, 100), state.environment);
    expect(await attribute(state, "preserveAspectRatio")).toBe("xMinYMin slice");
    // A square SVG stretched into a 4:1 frame is drawn square and covers the frame's long side, then stretched.
    expect([await attribute(state, "width"), await attribute(state, "height")]).toEqual(["400", "400"]);
    expect(state.draws).toEqual([[0, 0, 400, 100]]);
  });

  it("turns a tainted canvas into an error about content that can't be drawn", async () => {
    const state = harness({ drawError: Object.assign(new Error("tainted"), { name: "SecurityError" }) });
    await expect(rasterizeSvgPicture(request('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"/>'), state.environment))
      .rejects.toThrow("the SVG has content that can't be drawn");
    expect(state.revoked).toHaveLength(1);
  });

  it("reports unparseable SVG, a missing context, failed PNG encoding and bad sizes", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"/>';
    await expect(rasterizeSvgPicture(request("<svg><oops></svg>"), harness().environment)).rejects.toThrow("the SVG could not be parsed");
    await expect(rasterizeSvgPicture(request(svg), harness({ noContext: true }).environment)).rejects.toThrow("no 2D context");
    await expect(rasterizeSvgPicture(request(svg), harness({ blob: null }).environment)).rejects.toThrow("PNG could not be encoded at 300 x 150");
    for (const [w, h] of [[0, 10], [10.5, 10], [20_000, 10], [Number.NaN, 10]]) {
      await expect(rasterizeSvgPicture(request(svg, w, h), harness().environment)).rejects.toThrow("is not usable");
    }
  });

  describe("decode timeout", () => {
    beforeEach(() => vi.useFakeTimers());

    it("gives up after 5 seconds and still releases the URL", async () => {
      const state = harness({ load: "hang" });
      const result = rasterizeSvgPicture(request('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"/>'), state.environment);
      const outcome = expect(result).rejects.toThrow("the SVG took too long to decode");
      await vi.advanceTimersByTimeAsync(4999);
      expect(state.revoked).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await outcome;
      expect(state.revoked).toEqual(["blob:test/1"]);
      expect(state.images[0]!.src).toBe("");
    });
  });
});
