// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { SvgPictureRasterRequest } from "@chemdraft/export-engine/pdf";
import {
  bytesToBase64, prepareRasterPictures, RasterPictureMaxCount, RasterPictureOverCountHref, RasterPictureMaxSidePx, readPngSize,
  type PicturePixelDecoder
} from "../rasterPictureDecode";
import { picturePngBase64 } from "../testSupport/imageFixture";
import { embeddedBitmapPictureStep, type RasterizeEmbeddedBitmapsOptions } from "./rasterEmbeddedBitmaps";

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

const rasterizer = () => vi.fn(async (_request: SvgPictureRasterRequest) => PNG);
/** A PNG signature and IHDR declaring the size: all `prepareRasterPictures` reads before its decoder runs. */
const pngOfSize = (width: number, height: number) => {
  const header = new Uint8Array(33);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(header.buffer).setUint32(16, width);
  new DataView(header.buffer).setUint32(20, height);
  return header;
};
/** Stands in for the webview decoder: pixels of the size the PNG declares. */
const decode: PicturePixelDecoder = async png => {
  const size = readPngSize(png)!;
  return { ...size, rgba: new Uint8Array(size.width * size.height * 4) };
};

/** The native raster export's picture pass, with the step that rasterises SVG pictures. */
function prepare(svg: string, options: RasterizeEmbeddedBitmapsOptions & { budgetBytes?: number; decoder?: PicturePixelDecoder } = {}) {
  const { budgetBytes, decoder = decode, ...step } = options;
  return prepareRasterPictures(svg, { decode: decoder, budgetBytes, beforeDecode: embeddedBitmapPictureStep(step) });
}
const status = (pictures: Awaited<ReturnType<typeof prepare>>["pictures"]) =>
  pictures.map(entry => "refused" in entry ? entry.refused : `${entry.width}x${entry.height}`);
const images = (svg: string) => Array.from(new DOMParser().parseFromString(svg, "image/svg+xml").getElementsByTagName("image"));

describe("embeddedBitmapPictureStep", () => {
  it("turns an SVG picture that embeds a bitmap into a decoded picture, keeping frame, group and order", async () => {
    const rasterize = rasterizer();
    const before = page([
      picture(dataUri(VECTOR_SVG)),
      picture(dataUri(BITMAP_SVG()), 'x="10" y="20" width="40" height="20"', 'opacity="0.5" transform="rotate(30 30 30)"'),
      picture(`data:image/png;base64,${picturePngBase64}`)
    ]);
    const { svg, pictures } = await prepare(before, { rasterize });
    expect(rasterize).toHaveBeenCalledTimes(1);
    expect(status(pictures)).toEqual(["144x72", "144x72"]);
    const [vector, bitmap] = images(svg);
    expect(vector!.getAttribute("href")).toBe(dataUri(VECTOR_SVG));
    expect(bitmap!.getAttribute("id")).toBe(pictures[0]!.id);
    const group = bitmap!.parentElement!;
    expect(group.getAttribute("opacity")).toBe("0.5");
    expect(group.getAttribute("transform")).toBe("rotate(30 30 30)");
    expect(["x", "y", "width", "height", "preserveAspectRatio"].map(name => bitmap!.getAttribute(name))).toEqual(["10", "20", "40", "20", "none"]);
  });

  it("asks for the pixels the export draws: frame × page scale × ancestor scale × export scale", async () => {
    const rasterize = rasterizer();
    // A 200 x 100 unit page written as 150 x 75 pt (4/3 px per pt) inside a 0.5 scale group, as documentStyleSvg writes it.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="150pt" height="75pt" viewBox="0 0 150 75"><g transform="scale(0.5)">`
      + `<image x="0" y="0" width="40" height="20" href="${dataUri(BITMAP_SVG())}"/></g></svg>`;
    await prepare(svg, { rasterize, scale: 3 });
    expect(rasterize.mock.calls[0]![0]).toMatchObject({ width: 40, height: 20, pixelWidth: 40 * (4 / 3) * 0.5 * 3, pixelHeight: 20 * (4 / 3) * 0.5 * 3 });
  });

  it("reads the root size in linear time, and a long valid length whole", async () => {
    const rasterize = rasterizer();
    const bitmap = picture(dataUri(BITMAP_SVG()), 'x="0" y="0" width="200" height="100"');
    const started = performance.now();
    // Fifty thousand digits and a stray character: a backtracking pattern takes seconds here.
    await prepare(page([bitmap], `width="${"1".repeat(50_000)}!" height="1" viewBox="0 0 200 100"`), { rasterize });
    expect(performance.now() - started).toBeLessThan(1500);
    await prepare(page([bitmap], `width="${"0".repeat(5_000)}400" height="200.${"0".repeat(5_000)}" viewBox="0 0 200 100"`), { rasterize });
    expect(rasterize.mock.calls.at(-1)![0]).toMatchObject({ pixelWidth: 400, pixelHeight: 200 });
  });

  it("applies the longest-side clamp Rust applies, and the picture side limit", async () => {
    const rasterize = rasterizer();
    const svg = page([picture(dataUri(BITMAP_SVG()), 'x="0" y="0" width="200" height="100"')]);
    // 200 x 100 at scale 100 is 20000 px; clamped to 1000 it is a scale of 5.
    await prepare(svg, { rasterize, scale: 100, maxDimensionPx: 1000 });
    expect(rasterize.mock.calls[0]![0]).toMatchObject({ pixelWidth: 1000, pixelHeight: 500 });
    const huge = page([picture(dataUri(BITMAP_SVG()), 'x="0" y="0" width="200" height="100"')], 'width="40000" height="20000" viewBox="0 0 200 100"');
    await prepare(huge, { rasterize, maxDimensionPx: 1e9 });
    expect(rasterize.mock.calls[1]![0].pixelWidth).toBeLessThanOrEqual(RasterPictureMaxSidePx);
  });

  it("shrinks to the decoded budget, and leaves a picture alone when too little budget remains", async () => {
    const rasterize = rasterizer();
    const svg = page([picture(dataUri(BITMAP_SVG()), 'x="0" y="0" width="200" height="100"')]);
    await prepare(svg, { rasterize, scale: 4, budgetBytes: 200 * 100 * 4 });
    const { pixelWidth, pixelHeight } = rasterize.mock.calls[0]![0];
    expect(pixelWidth * pixelHeight * 4).toBeLessThanOrEqual(200 * 100 * 4);
    expect(pixelWidth / pixelHeight).toBeCloseTo(2, 1);
    const refused = rasterizer();
    const untouched = await prepare(svg, { rasterize: refused, budgetBytes: 100 });
    expect(untouched).toEqual({ svg, pictures: [] });
    expect(refused).not.toHaveBeenCalled();
  });

  it("checks the final integer size against what is left: a one-pixel minimum never overdraws the ledger", async () => {
    const rasterize = rasterizer();
    // A 2000 x 1 frame (8000 bytes) with 3999 left scales to about 1414 x 0.71; the one-pixel minimum height
    // makes that 1414 x 1 = 5656 bytes, more than is left, so nothing is drawn.
    const svg = page([picture(dataUri(BITMAP_SVG()), 'x="0" y="0" width="2000" height="1"')], 'width="2000" height="100" viewBox="0 0 2000 100"');
    await prepare(svg, { rasterize, budgetBytes: 3999 });
    expect(rasterize).not.toHaveBeenCalled();
    await prepare(svg, { rasterize, budgetBytes: 2000 * 4 });
    expect(rasterize.mock.calls[0]![0]).toMatchObject({ pixelWidth: 2000, pixelHeight: 1 });
  });

  it("rasterises identical pictures at one size once, and charges each one as it decodes", async () => {
    const rasterize = vi.fn(async (request: SvgPictureRasterRequest) => pngOfSize(request.pixelWidth, request.pixelHeight));
    const same = picture(dataUri(BITMAP_SVG()), 'x="0" y="0" width="100" height="50"');
    const other = picture(dataUri(BITMAP_SVG('id="other"')), 'x="0" y="0" width="100" height="50"');
    await prepare(page([same, same, other]), { rasterize });
    expect(rasterize).toHaveBeenCalledTimes(2);
    // 100 x 50 at 1x is 20000 bytes; a budget for one and a half leaves the second at about 0.71 of its size.
    const sized = vi.fn(async (request: SvgPictureRasterRequest) => pngOfSize(request.pixelWidth, request.pixelHeight));
    const { pictures } = await prepare(page([same, other]), { rasterize: sized, budgetBytes: 30000 });
    expect(sized.mock.calls[0]![0].pixelWidth).toBe(100);
    expect(sized.mock.calls[1]![0].pixelWidth).toBeLessThan(100);
    expect(pictures.every(entry => !("refused" in entry))).toBe(true);
  });

  it("keeps today's href when rasterising fails or returns nothing, and when the SVG has no size", async () => {
    const svg = page([picture(dataUri(BITMAP_SVG()))]);
    expect(await prepare(svg, { rasterize: vi.fn(async () => { throw new Error("no"); }) })).toEqual({ svg, pictures: [] });
    expect(await prepare(svg, { rasterize: vi.fn(async () => undefined as unknown as Uint8Array) })).toEqual({ svg, pictures: [] });
    const rasterize = rasterizer();
    const skewed = page([picture(dataUri(BITMAP_SVG()), 'x="0" y="0" width="40" height="20"', 'transform="bogus(1)"')]);
    expect(await prepare(skewed, { rasterize })).toEqual({ svg: skewed, pictures: [] });
    expect(rasterize).not.toHaveBeenCalled();
  });

  it("leaves pages without a bitmap-carrying SVG picture, and unparsable markup, untouched", async () => {
    const rasterize = rasterizer();
    for (const svg of [page([]), page([picture(dataUri(VECTOR_SVG))]), "<svg"]) {
      expect(await prepare(svg, { rasterize })).toEqual({ svg, pictures: [] });
    }
    expect(rasterize).not.toHaveBeenCalled();
  });

  it("reads percent-encoded SVG data URIs and xlink:href", async () => {
    const rasterize = rasterizer();
    const encoded = page([`<image width="40" height="20" xlink:href="${dataUri(BITMAP_SVG(), false).replace(/'/g, "%27")}"/>`]);
    const { pictures } = await prepare(encoded, { rasterize });
    expect(rasterize).toHaveBeenCalledTimes(1);
    expect(pictures).toHaveLength(1);
  });

  it("stops at the picture-count limit shared with prepareRasterPictures", async () => {
    const rasterize = rasterizer();
    const png = `<image width="1" height="1" href="data:image/png;base64,${picturePngBase64}"/>`;
    const svg = page([...Array(RasterPictureMaxCount).fill(png), picture(dataUri(BITMAP_SVG()))]);
    const { pictures } = await prepare(svg, { rasterize });
    expect(pictures).toHaveLength(RasterPictureMaxCount);
    expect(rasterize).not.toHaveBeenCalled();
  });

  it("counts an SVG picture it took on against the limit even when rasterising it failed", async () => {
    const rasterize = vi.fn(async (_request: SvgPictureRasterRequest): Promise<Uint8Array> => { throw new Error("no"); });
    // Distinct pictures, so the per-export cache cannot absorb the calls.
    const failing = Array.from({ length: RasterPictureMaxCount + 1 }, (_, index) => picture(dataUri(BITMAP_SVG(`data-n="${index}"`))));
    const png = `<image width="1" height="1" href="data:image/png;base64,${picturePngBase64}"/>`;
    const { svg, pictures } = await prepare(page([...failing, png]), { rasterize });
    expect(rasterize).toHaveBeenCalledTimes(RasterPictureMaxCount);
    // The slots are spent: the PNG after them is past the limit and is not decoded.
    expect(pictures).toHaveLength(0);
    // ...and reaches Rust marked as over the count, not as a generic omission.
    expect(images(svg).at(-1)!.getAttribute("href")).toBe(RasterPictureOverCountHref);
  });

  describe("one budget in drawing order", () => {
    const MiB = 1024 * 1024;
    const sizing = () => vi.fn(async (request: SvgPictureRasterRequest) => pngOfSize(request.pixelWidth, request.pixelHeight));
    const pngPicture = (width: number, height: number, x: number) =>
      `<image x="${x}" y="0" width="${width}" height="${height}" href="data:image/png;base64,${bytesToBase64(pngOfSize(width, height))}"/>`;
    const svgPicture = (width: number, height: number, x: number) =>
      `<image x="${x}" y="0" width="${width}" height="${height}" href="${dataUri(BITMAP_SVG())}"/>`;
    const root = 'width="1000" height="800" viewBox="0 0 1000 800"';

    it("shrinks an SVG picture to what a 384 x 512 PNG before it leaves of a 1 MiB budget, instead of having it discarded", async () => {
      const rasterize = sizing();
      const { pictures } = await prepare(page([pngPicture(384, 512, 0), svgPicture(400, 300, 400)], root), { rasterize, budgetBytes: MiB });
      // Both pictures reach Rust as pixels; none is refused for the budget.
      expect(pictures.map(entry => "refused" in entry)).toEqual([false, false]);
      const left = MiB - 384 * 512 * 4;
      const { pixelWidth, pixelHeight } = rasterize.mock.calls[0]![0];
      expect(pixelWidth * pixelHeight * 4).toBeLessThanOrEqual(left);
      expect(pixelWidth * pixelHeight * 4).toBeGreaterThan(left * 0.9);
      expect(pixelWidth / pixelHeight).toBeCloseTo(400 / 300, 1);
    });

    it("sizes in drawing order: a PNG after the SVG picture does not shrink it", async () => {
      const rasterize = sizing();
      const { pictures } = await prepare(page([svgPicture(400, 300, 0), pngPicture(384, 512, 400)], root), { rasterize, budgetBytes: MiB });
      expect(rasterize.mock.calls[0]![0]).toMatchObject({ pixelWidth: 400, pixelHeight: 300 });
      // The SVG picture took 480000 bytes first, so the PNG (786432) no longer fits: the PNG, not the SVG, is the one refused.
      expect(status(pictures)).toEqual(["400x300", "overBudget"]);
    });

    it("charges a PNG only once it has decoded: one whose header fits but whose data fails reserves nothing", async () => {
      const rasterize = sizing();
      const failing: PicturePixelDecoder = async png => {
        const size = readPngSize(png)!;
        if (size.width === 384) throw new Error("corrupt data chunk");
        return { ...size, rgba: new Uint8Array(size.width * size.height * 4) };
      };
      const { pictures } = await prepare(page([pngPicture(384, 512, 0), svgPicture(400, 300, 400)], root),
        { rasterize, budgetBytes: MiB, decoder: failing });
      // Before, the failed PNG's 786432 header bytes were reserved and the SVG picture was shrunk to the 262144 left.
      expect(rasterize.mock.calls[0]![0]).toMatchObject({ pixelWidth: 400, pixelHeight: 300 });
      expect(status(pictures)).toEqual(["decodeFailed", "400x300"]);
    });

    it("does not charge a PNG it refuses by size, or a picture whose rasterising failed", async () => {
      const rasterize = sizing();
      await prepare(page([pngPicture(RasterPictureMaxSidePx + 1, 1, 0), svgPicture(400, 300, 400)], root), { rasterize, budgetBytes: 480000 });
      expect(rasterize.mock.calls[0]![0]).toMatchObject({ pixelWidth: 400, pixelHeight: 300 });
      const failing = vi.fn(async (request: SvgPictureRasterRequest) => {
        if (failing.mock.calls.length === 1) throw new Error("no");
        return pngOfSize(request.pixelWidth, request.pixelHeight);
      });
      await prepare(page([svgPicture(400, 300, 0), svgPicture(200, 100, 400)], root), { rasterize: failing, budgetBytes: 480000 });
      expect(failing.mock.calls[1]![0]).toMatchObject({ pixelWidth: 200, pixelHeight: 100 });
    });
  });
});
