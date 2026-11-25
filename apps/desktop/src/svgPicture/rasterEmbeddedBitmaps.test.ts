// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { SvgPictureRasterRequest } from "@chemdraft/export-engine/pdf";
import { bytesToBase64, prepareRasterPictures, RasterPictureMaxCount, RasterPictureMaxSidePx, readPngSize } from "../rasterPictureDecode";
import { picturePngBase64 } from "../testSupport/imageFixture";
import { rasterizeEmbeddedBitmapPictures } from "./rasterEmbeddedBitmaps";

const PNG = Uint8Array.from(atob(picturePngBase64), char => char.charCodeAt(0));
const BITMAP_SVG = (extra = "") => `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" ${extra}>`
  + `<image href="data:image/jpeg;base64,/9j/4AAQ" width="40" height="20"/></svg>`;
const VECTOR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>';
const dataUri = (svg: string, base64 = true) => base64 ? `data:image/svg+xml;base64,${btoa(svg)}` : `data:image/svg+xml,${encodeURIComponent(svg)}`;

/** A page root as the SVG export writes it, then the pictures as `<image>` in a group. */
function page(images: string[], root = 'width="200" height="100" viewBox="0 0 200 100"') {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${root}>${images.join("")}</svg>`;
}
const picture = (href: string, attributes = 'x="10" y="20" width="40" height="20"', group = "") =>
  `<g ${group} data-object-id="p"><image ${attributes} preserveAspectRatio="none" href="${href}"/></g>`;
const hrefs = (svg: string) => Array.from(new DOMParser().parseFromString(svg, "image/svg+xml").getElementsByTagName("image"))
  .map(image => image.getAttribute("href")!);

const rasterizer = () => vi.fn(async (_request: SvgPictureRasterRequest) => PNG);

describe("rasterizeEmbeddedBitmapPictures", () => {
  it("replaces the href of an SVG picture that embeds a bitmap with a PNG, keeping frame, group and order", async () => {
    const rasterize = rasterizer();
    const before = page([
      picture(dataUri(VECTOR_SVG)),
      picture(dataUri(BITMAP_SVG()), 'x="10" y="20" width="40" height="20"', 'opacity="0.5" transform="rotate(30 30 30)"'),
      picture(`data:image/png;base64,${picturePngBase64}`)
    ]);
    const after = await rasterizeEmbeddedBitmapPictures(before, { rasterize });
    expect(rasterize).toHaveBeenCalledTimes(1);
    const [vector, bitmap, png] = hrefs(after);
    expect(vector).toBe(dataUri(VECTOR_SVG));
    expect(bitmap).toMatch(/^data:image\/png;base64,/);
    expect(atob(bitmap.split(",")[1]!)).toBe(atob(picturePngBase64));
    expect(png).toBe(`data:image/png;base64,${picturePngBase64}`);
    const parsed = new DOMParser().parseFromString(after, "image/svg+xml");
    const group = parsed.getElementsByTagName("g")[1]!;
    expect(group.getAttribute("opacity")).toBe("0.5");
    expect(group.getAttribute("transform")).toBe("rotate(30 30 30)");
    const image = group.getElementsByTagName("image")[0]!;
    expect(["x", "y", "width", "height", "preserveAspectRatio"].map(name => image.getAttribute(name))).toEqual(["10", "20", "40", "20", "none"]);
  });

  it("asks for the pixels the export draws: frame × page scale × ancestor scale × export scale", async () => {
    const rasterize = rasterizer();
    // A 200 x 100 unit page written as 150 x 75 pt (4/3 px per pt) inside a 0.5 scale group, as documentStyleSvg writes it.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="150pt" height="75pt" viewBox="0 0 150 75"><g transform="scale(0.5)">`
      + `<image x="0" y="0" width="40" height="20" href="${dataUri(BITMAP_SVG())}"/></g></svg>`;
    await rasterizeEmbeddedBitmapPictures(svg, { rasterize, scale: 3 });
    expect(rasterize.mock.calls[0]![0]).toMatchObject({ width: 40, height: 20, pixelWidth: 40 * (4 / 3) * 0.5 * 3, pixelHeight: 20 * (4 / 3) * 0.5 * 3 });
  });

  it("applies the longest-side clamp Rust applies, and the picture side limit", async () => {
    const rasterize = rasterizer();
    const svg = page([picture(dataUri(BITMAP_SVG()), 'x="0" y="0" width="200" height="100"')]);
    // 200 x 100 at scale 100 is 20000 px; clamped to 1000 it is a scale of 5.
    await rasterizeEmbeddedBitmapPictures(svg, { rasterize, scale: 100, maxDimensionPx: 1000 });
    expect(rasterize.mock.calls[0]![0]).toMatchObject({ pixelWidth: 1000, pixelHeight: 500 });
    const huge = page([picture(dataUri(BITMAP_SVG()), 'x="0" y="0" width="200" height="100"')], 'width="40000" height="20000" viewBox="0 0 200 100"');
    await rasterizeEmbeddedBitmapPictures(huge, { rasterize, maxDimensionPx: 1e9 });
    const { pixelWidth } = rasterize.mock.calls[1]![0];
    expect(pixelWidth).toBeLessThanOrEqual(RasterPictureMaxSidePx);
  });

  it("shrinks to the decoded budget, and leaves a picture alone when too little budget remains", async () => {
    const rasterize = rasterizer();
    const svg = page([picture(dataUri(BITMAP_SVG()), 'x="0" y="0" width="200" height="100"')]);
    await rasterizeEmbeddedBitmapPictures(svg, { rasterize, scale: 4, budgetBytes: 200 * 100 * 4 });
    const { pixelWidth, pixelHeight } = rasterize.mock.calls[0]![0];
    expect(pixelWidth * pixelHeight * 4).toBeLessThanOrEqual(200 * 100 * 4);
    expect(pixelWidth / pixelHeight).toBeCloseTo(2, 1);
    const refused = rasterizer();
    expect(await rasterizeEmbeddedBitmapPictures(svg, { rasterize: refused, budgetBytes: 100 })).toBe(svg);
    expect(refused).not.toHaveBeenCalled();
  });

  it("charges every picture against one budget and rasterises identical pictures at one size once", async () => {
    const rasterize = rasterizer();
    const same = picture(dataUri(BITMAP_SVG()), 'x="0" y="0" width="100" height="50"');
    const other = picture(dataUri(BITMAP_SVG('id="other"')), 'x="0" y="0" width="100" height="50"');
    await rasterizeEmbeddedBitmapPictures(page([same, same, other]), { rasterize });
    expect(rasterize).toHaveBeenCalledTimes(2);
    // 100 x 50 at 1x is 20000 bytes; a budget for one and a half leaves the second at about 0.71 of its size.
    const sized = rasterizer();
    await rasterizeEmbeddedBitmapPictures(page([same, other]), { rasterize: sized, budgetBytes: 30000 });
    expect(sized.mock.calls[0]![0].pixelWidth).toBe(100);
    expect(sized.mock.calls[1]![0].pixelWidth).toBeLessThan(100);
  });

  it("keeps today's href when rasterising fails or returns nothing, and when the SVG has no size", async () => {
    const svg = page([picture(dataUri(BITMAP_SVG()))]);
    expect(await rasterizeEmbeddedBitmapPictures(svg, { rasterize: vi.fn(async () => { throw new Error("no"); }) })).toBe(svg);
    expect(await rasterizeEmbeddedBitmapPictures(svg, { rasterize: vi.fn(async () => undefined as unknown as Uint8Array) })).toBe(svg);
    const rasterize = rasterizer();
    const skewed = page([picture(dataUri(BITMAP_SVG()), 'x="0" y="0" width="40" height="20"', 'transform="bogus(1)"')]);
    expect(await rasterizeEmbeddedBitmapPictures(skewed, { rasterize })).toBe(skewed);
    expect(rasterize).not.toHaveBeenCalled();
  });

  it("leaves pages without a bitmap-carrying SVG picture, and unparsable markup, untouched", async () => {
    const rasterize = rasterizer();
    for (const svg of [page([]), page([picture(dataUri(VECTOR_SVG))]), page([picture(`data:image/png;base64,${picturePngBase64}`)]), "<svg"]) {
      expect(await rasterizeEmbeddedBitmapPictures(svg, { rasterize })).toBe(svg);
    }
    expect(rasterize).not.toHaveBeenCalled();
  });

  it("reads percent-encoded SVG data URIs and xlink:href", async () => {
    const rasterize = rasterizer();
    const encoded = page([`<image width="40" height="20" xlink:href="${dataUri(BITMAP_SVG(), false).replace(/'/g, "%27")}"/>`]);
    const after = await rasterizeEmbeddedBitmapPictures(encoded, { rasterize });
    expect(rasterize).toHaveBeenCalledTimes(1);
    expect(after).toContain("data:image/png;base64,");
  });

  it("stops at the picture-count limit shared with prepareRasterPictures", async () => {
    const rasterize = rasterizer();
    const png = `<image width="1" height="1" href="data:image/png;base64,${picturePngBase64}"/>`;
    const svg = page([...Array(RasterPictureMaxCount).fill(png), picture(dataUri(BITMAP_SVG()))]);
    expect(await rasterizeEmbeddedBitmapPictures(svg, { rasterize })).toBe(svg);
    expect(rasterize).not.toHaveBeenCalled();
  });

  describe("with the pass that decodes the PNGs next (one budget in drawing order)", () => {
    const MiB = 1024 * 1024;
    /** A PNG signature and IHDR declaring the size: all `prepareRasterPictures` reads before its decoder runs. */
    const pngOfSize = (width: number, height: number) => {
      const header = new Uint8Array(33);
      header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
      new DataView(header.buffer).setUint32(16, width);
      new DataView(header.buffer).setUint32(20, height);
      return header;
    };
    const decode = async (png: Uint8Array) => {
      const size = readPngSize(png)!;
      return { ...size, rgba: new Uint8Array(size.width * size.height * 4) };
    };
    const sizing = () => vi.fn(async (request: SvgPictureRasterRequest) => pngOfSize(request.pixelWidth, request.pixelHeight));
    const pngPicture = (width: number, height: number, x: number) =>
      `<image x="${x}" y="0" width="${width}" height="${height}" href="data:image/png;base64,${bytesToBase64(pngOfSize(width, height))}"/>`;
    const svgPicture = (width: number, height: number, x: number) =>
      `<image x="${x}" y="0" width="${width}" height="${height}" href="${dataUri(BITMAP_SVG())}"/>`;
    const root = 'width="1000" height="800" viewBox="0 0 1000 800"';

    it("shrinks an SVG picture to what a 384 x 512 PNG before it leaves of a 1 MiB budget, instead of having it discarded", async () => {
      const rasterize = sizing();
      const svg = page([pngPicture(384, 512, 0), svgPicture(400, 300, 400)], root);
      const flattened = await rasterizeEmbeddedBitmapPictures(svg, { rasterize, budgetBytes: MiB });
      const { pictures } = await prepareRasterPictures(flattened, { decode, budgetBytes: MiB });
      // Both pictures reach Rust as pixels; none is refused for the budget.
      expect(pictures.map(picture => "refused" in picture)).toEqual([false, false]);
      const left = MiB - 384 * 512 * 4;
      const { pixelWidth, pixelHeight } = rasterize.mock.calls[0]![0];
      expect(pixelWidth * pixelHeight * 4).toBeLessThanOrEqual(left);
      expect(pixelWidth * pixelHeight * 4).toBeGreaterThan(left * 0.9);
      expect(pixelWidth).toBeLessThan(400);
      expect(pixelWidth / pixelHeight).toBeCloseTo(400 / 300, 1);
    });

    it("sizes a PNG's charge in drawing order: a PNG after the SVG picture does not shrink it", async () => {
      const rasterize = sizing();
      const svg = page([svgPicture(400, 300, 0), pngPicture(384, 512, 400)], root);
      const flattened = await rasterizeEmbeddedBitmapPictures(svg, { rasterize, budgetBytes: MiB });
      expect(rasterize.mock.calls[0]![0]).toMatchObject({ pixelWidth: 400, pixelHeight: 300 });
      const { pictures } = await prepareRasterPictures(flattened, { decode, budgetBytes: MiB });
      // The SVG picture took 480000 bytes first, so the PNG (786432) no longer fits: the PNG, not the SVG, is the one refused.
      expect(pictures.map(picture => "refused" in picture ? picture.refused : "drawn")).toEqual(["drawn", "overBudget"]);
    });

    it("does not charge a PNG the next pass refuses, or a picture whose rasterising failed", async () => {
      const rasterize = sizing();
      const tooBig = pngPicture(RasterPictureMaxSidePx + 1, 1, 0);
      const svg = page([tooBig, svgPicture(400, 300, 400)], root);
      await rasterizeEmbeddedBitmapPictures(svg, { rasterize, budgetBytes: 480000 });
      expect(rasterize.mock.calls[0]![0]).toMatchObject({ pixelWidth: 400, pixelHeight: 300 });
      const failing = vi.fn(async (request: SvgPictureRasterRequest) => {
        if (failing.mock.calls.length === 1) throw new Error("no");
        return pngOfSize(request.pixelWidth, request.pixelHeight);
      });
      await rasterizeEmbeddedBitmapPictures(page([svgPicture(400, 300, 0), svgPicture(200, 100, 400)], root), { rasterize: failing, budgetBytes: 480000 });
      expect(failing.mock.calls[1]![0]).toMatchObject({ pixelWidth: 200, pixelHeight: 100 });
    });
  });
});
