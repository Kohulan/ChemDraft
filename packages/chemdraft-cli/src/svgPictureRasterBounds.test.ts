import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportWarning } from "@chemdraft/export-engine";
import { flattenSvgPictures, rasterizeSvgPictureWithResvg } from "./svgPictureRaster";

/**
 * Every pixmap the rasteriser asks resvg for is recorded here, and one past the bound is refused instead
 * of drawn, so no test ever allocates the huge pixmap a picture asks for: the size is computed from the
 * Resvg's own size and `fitTo`, as resvg computes it, before `render()` would allocate it.
 */
const { requested, LIMIT_SIDE } = vi.hoisted(() => ({ requested: [] as Array<[number, number]>, LIMIT_SIDE: 8192 }));
vi.mock("@resvg/resvg-js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@resvg/resvg-js")>();
  type Options = ConstructorParameters<typeof real.Resvg>[1];
  class Resvg extends real.Resvg {
    readonly #fitTo: NonNullable<Options>["fitTo"];
    constructor(svg: string | Buffer, options?: Options) {
      super(svg, options);
      this.#fitTo = options?.fitTo;
    }
    override render() {
      const { width, height } = this, fit = this.#fitTo;
      const size: [number, number] = fit?.mode === "width" ? [fit.value, Math.ceil(height * fit.value / width)]
        : fit?.mode === "height" ? [Math.ceil(width * fit.value / height), fit.value]
          : fit?.mode === "zoom" ? [Math.ceil(width * fit.value), Math.ceil(height * fit.value)]
            : [Math.ceil(width), Math.ceil(height)];
      requested.push(size);
      if (Math.max(...size) > LIMIT_SIDE || size[0] * size[1] > LIMIT_SIDE * LIMIT_SIDE) {
        throw new Error(`test refused an oversize pixmap: ${size[0]} x ${size[1]}`);
      }
      return super.render();
    }
  }
  return { ...real, Resvg };
});

const SVG = "http://www.w3.org/2000/svg";
const picture = (attributes: string) => `<svg xmlns="${SVG}" ${attributes}><rect width="100%" height="100%" fill="#ff0000"/></svg>`;
const request = (svg: string, pixelWidth = 40, pixelHeight = 20) => ({ svg, width: 40, height: 20, pixelWidth, pixelHeight });
const withinBounds = () => requested.every(([width, height]) => width >= 1 && height >= 1 && width <= LIMIT_SIDE && height <= LIMIT_SIDE);

beforeEach(() => { requested.length = 0; });

// The first call loads jsdom for the XML parser, which can take several seconds on a cold machine.
describe("rasterizeSvgPictureWithResvg bounds every pixmap on both sides", { timeout: 30_000 }, () => {
  it("refuses a 1 x 500000000 picture before any pixmap is asked for", async () => {
    await expect(rasterizeSvgPictureWithResvg(request(picture('width="1" height="500000000"'))))
      .rejects.toThrow(/16384 pixels on a side/);
    expect(requested).toEqual([]);
  });

  it("refuses a 500000000 x 1 picture before any pixmap is asked for", async () => {
    await expect(rasterizeSvgPictureWithResvg(request(picture('width="500000000" height="1"'))))
      .rejects.toThrow(/16384 pixels on a side/);
    expect(requested).toEqual([]);
  });

  it("draws a 1 x 9000 picture with its long side capped, not only its short side", async () => {
    const png = await rasterizeSvgPictureWithResvg(request(picture('width="1" height="9000"')));
    expect(png.length).toBeGreaterThan(8);
    // The intermediate render at the picture's own aspect, then the stretch to the 40 x 20 frame.
    expect(requested).toEqual([[1, 8192], [40, 20]]);
  });

  it("refuses a huge viewBox with no width or height", async () => {
    await expect(rasterizeSvgPictureWithResvg(request(picture('viewBox="0 0 1 1000000000"'))))
      .rejects.toThrow(/16384 pixels on a side/);
    await expect(rasterizeSvgPictureWithResvg(request(picture('viewBox="0 0 1000000000 1000000000"'))))
      .rejects.toThrow(/16384 pixels on a side/);
    expect(requested).toEqual([]);
  });

  it("refuses a width or height that is not finite, zero or negative", async () => {
    for (const attributes of ['width="1e309" height="10"', 'width="10" height="1e309"', 'width="1e309"', 'width="0" height="10"', 'width="10" height="-5"']) {
      await expect(rasterizeSvgPictureWithResvg(request(picture(attributes))), attributes).rejects.toThrow(/is not a usable size/);
    }
    expect(requested).toEqual([]);
  });

  it("refuses a requested frame size past the bound, or not a whole number of pixels", async () => {
    for (const [width, height] of [[1, 100_000], [100_000, 1], [0, 20], [Number.NaN, 20], [40.5, 20]] as const) {
      await expect(rasterizeSvgPictureWithResvg(request(picture('width="40" height="20"'), width, height))).rejects.toThrow(/not usable/);
    }
    expect(requested).toEqual([]);
  });

  it("keeps a picture of a normal size drawn at its own aspect", async () => {
    await rasterizeSvgPictureWithResvg(request(picture('width="10" height="10"'), 40, 20));
    expect(requested).toEqual([[40, 40], [40, 20]]);
    expect(withinBounds()).toBe(true);
  });
});

describe("flattenSvgPictures bounds every pixmap on both sides", { timeout: 30_000 }, () => {
  const image = (id: string, width: string, height: string, source: string) =>
    `<g data-object-id="${id}"><image x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none" `
    + `href="data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}"/></g>`;
  const page = (...items: string[]) => `<svg xmlns="${SVG}" width="400" height="300" viewBox="0 0 400 300">${items.join("")}</svg>`;
  const pngSizes = (svg: string) => [...svg.matchAll(/href="data:image\/png;base64,([^"]*)"/g)]
    .map((match) => { const bytes = Buffer.from(match[1]!, "base64"); return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]; });

  it("removes a 1 x 500000000 picture with its warning, without asking for its pixmap", async () => {
    const warnings: ExportWarning[] = [];
    const flattened = await flattenSvgPictures(page(image("tall", "40", "20", picture('width="1" height="500000000"'))), 1, warnings);
    expect(pngSizes(flattened)).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ code: "export.png.svg_picture_not_drawn", objectId: "tall",
      message: expect.stringContaining("16384 pixels on a side") })]);
    expect(requested).toEqual([]);
  });

  it("removes a picture whose frame is 1e309 wide, and still draws the next picture within the budget", async () => {
    const warnings: ExportWarning[] = [];
    const flattened = await flattenSvgPictures(page(
      image("infinite", "1e309", "20", picture('width="40" height="20"')),
      image("next", "40", "20", picture('width="40" height="20"'))
    ), 1, warnings);
    expect(warnings).toEqual([expect.objectContaining({ objectId: "infinite", message: expect.stringContaining("frame can't be read") })]);
    expect(pngSizes(flattened)).toEqual([[40, 20]]);
    expect(withinBounds()).toBe(true);
  });

  it("draws a frame of extreme aspect at most the flattening side on either side", async () => {
    const warnings: ExportWarning[] = [];
    const flattened = await flattenSvgPictures(page(image("thin", "1", "500000000", picture('width="40" height="20"'))), 1, warnings);
    expect(warnings).toEqual([]);
    expect(pngSizes(flattened)).toEqual([[1, 8192]]);
    expect(withinBounds()).toBe(true);
  });
});
