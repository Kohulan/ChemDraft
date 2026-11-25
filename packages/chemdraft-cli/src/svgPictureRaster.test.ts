import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExportWarning } from "@chemdraft/export-engine";
import { DIAGRAM_SAMPLE, EDITOR_SAMPLE, PLOT_SAMPLE, TOOLKIT_SAMPLE } from "../../export-engine/src/svgSafety/benignSamples";
import { jpegHeader, pngWithSize } from "../../export-engine/src/svgSafety/testFixtures";
import { flattenSvgPictures, rasterizeSvgPictureWithResvg } from "./svgPictureRaster";

const decode = (png: Uint8Array, width: number, height: number) => {
  const image = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${Buffer.from(png).toString("base64")}"/></svg>`).render();
  return { width: image.width, height: image.height, pixels: image.pixels };
};
const pixel = (image: ReturnType<typeof decode>, x: number, y: number) => [...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
const request = (svg: string, pixelWidth = 40, pixelHeight = 20) => ({ svg, width: 40, height: 20, pixelWidth, pixelHeight });
const SVG = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";
const solid = (color: string, size = 4) => Buffer.from(new Resvg(`<svg xmlns="${SVG}" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="${color}"/></svg>`).render().asPng());

// The first call loads jsdom for the XML parser, which can take several seconds on a cold machine.
describe("rasterizeSvgPictureWithResvg", { timeout: 30_000 }, () => {
  it("rasterises at the requested size and stretches to the frame", async () => {
    // Left half red, right half blue, stretched from a square source into a 40 x 20 frame.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" preserveAspectRatio="none"><rect width="5" height="10" fill="#ff0000"/><rect x="5" width="5" height="10" fill="#0000ff"/></svg>';
    const image = decode(await rasterizeSvgPictureWithResvg(request(svg)), 40, 20);
    expect([image.width, image.height]).toEqual([40, 20]);
    expect(pixel(image, 5, 10)).toEqual([255, 0, 0, 255]);
    expect(pixel(image, 35, 10)).toEqual([0, 0, 255, 255]);
  });

  it("draws a root with no viewBox", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#00ff00"/></svg>';
    const image = decode(await rasterizeSvgPictureWithResvg(request(svg, 80, 40)), 80, 40);
    expect(pixel(image, 2, 2)).toEqual([0, 255, 0, 255]);
    expect(pixel(image, 77, 37)).toEqual([0, 255, 0, 255]);
  });

  it("draws an inline PNG nested in the SVG", async () => {
    const png = solid("#ff0000", 2).toString("base64");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="20"><image width="40" height="20" xlink:href="data:image/png;base64,${png}"/></svg>`;
    const image = decode(await rasterizeSvgPictureWithResvg(request(svg)), 40, 20);
    expect(pixel(image, 20, 10)).toEqual([255, 0, 0, 255]);
  });

  it("allows internal fragment references", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="40" height="20" fill="url(#g)"/></svg>';
    expect((await rasterizeSvgPictureWithResvg(request(svg))).length).toBeGreaterThan(8);
  });

  it("keeps the benign drawing the desktop sanitiser keeps: fragments, quoted spaced url(), <use>, clip, style block, embedded PNG", async () => {
    const png = solid("#ff0000", 4).toString("base64");
    const svg = `<svg xmlns="${SVG}" xmlns:xlink="${XLINK}" viewBox="0 0 100 50" width="100" height="50">
  <defs>
    <linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>
    <clipPath id="clip"><rect width="40" height="40"/></clipPath>
    <marker id="m" markerWidth="4" markerHeight="4"><path d="M0 0L4 2L0 4z"/></marker>
    <filter id="f"><feGaussianBlur stdDeviation="1"/></filter>
    <symbol id="s"><circle r="3"/></symbol>
  </defs>
  <style>.a{fill:url(#g);stroke:#000} @media print{.a{stroke:none}}</style>
  <rect class="a" width="50" height="20" clip-path="url(#clip)" filter="url( '#f' )"/>
  <path d="M0 0L10 10" marker-end="url(#m)" style="stroke: red; stroke-width: 2; fill: url( &quot;#g&quot; )"/>
  <use href="#s" x="5"/><use xlink:href="#s" x="9"/>
  <image href="data:image/png;base64,${png}" x="60" width="20" height="20"/>
  <text x="1" y="9" font-family="serif">Benzene ⌬ αβ</text>
</svg>`;
    const image = decode(await rasterizeSvgPictureWithResvg(request(svg, 100, 50)), 100, 50);
    // Below the text baseline, which crosses the picture.
    expect(pixel(image, 75, 18)).toEqual([255, 0, 0, 255]);
  });
});

describe("rasterizeSvgPictureWithResvg refuses host files", () => {
  let directory: string, marker: string, markerUrl: string, markerData: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "chemdraft-svg-picture-"));
    marker = join(directory, "marker.png");
    writeFileSync(marker, solid("#ff0000"));
    markerUrl = `file://${marker.startsWith("/") ? "" : "/"}${marker.replace(/\\/g, "/")}`;
    markerData = Buffer.from(`<svg xmlns="${SVG}" width="4" height="4"><image width="4" height="4" href="${marker}"/></svg>`).toString("base64");
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const svgWith = (body: string, root = "") => `<svg xmlns="${SVG}" xmlns:xlink="${XLINK}" ${root} width="4" height="4">${body}</svg>`;

  it("control: resvg itself reads an absolute path an href names, which is why the guard exists", () => {
    const image = new Resvg(svgWith(`<image width="4" height="4" href="${marker}"/>`)).render();
    expect([...image.pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
  });

  const spellings: Array<[string, (marker: string, url: string, data: string) => string]> = [
    ["a plain href path", (m) => svgWith(`<image width="4" height="4" href="${m}"/>`)],
    ["an xlink:href path", (m) => svgWith(`<image width="4" height="4" xlink:href="${m}"/>`)],
    ["a path with whitespace around it", (m) => svgWith(`<image width="4" height="4" href="  ${m}&#10;"/>`)],
    ["a path spelled with character references", (m) => svgWith(`<image width="4" height="4" href="${[...m].map((c) => `&#x${c.charCodeAt(0).toString(16)};`).join("")}"/>`)],
    ["an XLink namespace under another prefix", (m) => `<svg xmlns="${SVG}" xmlns:q="${XLINK}" width="4" height="4"><image width="4" height="4" q:href="${m}"/></svg>`],
    ["an SVG-namespace prefix on the attribute", (m) => `<svg xmlns="${SVG}" xmlns:s="${SVG}" width="4" height="4"><image width="4" height="4" s:href="${m}"/></svg>`],
    ["an upper-case attribute value scheme", (_m, url) => svgWith(`<image width="4" height="4" href="${url.replace("file", "FILE")}"/>`)],
    ["a file URL", (_m, url) => svgWith(`<image width="4" height="4" href="${url}"/>`)],
    ["a path through an internal entity", (m) => `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY p "${m}">]><svg xmlns="${SVG}" width="4" height="4"><image width="4" height="4" href="&p;"/></svg>`],
    ["an external entity", (m) => `<!DOCTYPE svg [<!ENTITY p SYSTEM "${m}">]><svg xmlns="${SVG}" width="4" height="4"><text>&p;</text></svg>`],
    ["a CSS url() in a style attribute", (m) => svgWith(`<rect width="4" height="4" style="fill:url(${m})"/>`)],
    ["a CSS url() in a presentation attribute", (m) => svgWith(`<rect width="4" height="4" fill="url(${m})"/>`)],
    ["a CSS url() in a style block", (m) => svgWith(`<style>rect{fill:url('${m}')}</style><rect width="4" height="4"/>`)],
    ["a CSS url() in a CDATA style block", (m) => svgWith(`<style><![CDATA[rect{fill:URL( "${m}" )}]]></style><rect width="4" height="4"/>`)],
    ["a CSS url() spelled with an escape", (m) => svgWith(`<style>rect{fill:\\75rl(${m})}</style><rect width="4" height="4"/>`)],
    ["a CSS url() spelled with a character reference", (m) => svgWith(`<rect width="4" height="4" style="fill:&#117;rl(${m})"/>`)],
    ["a CSS url() with a comment before the target", (m) => svgWith(`<rect width="4" height="4" style="fill:url(/**/${m})"/>`)],
    ["a CSS @import", (m) => svgWith(`<style>@import url(${m});</style>`)],
    ["a CSS @import of a bare string", (m) => svgWith(`<style>@import "${m}";</style>`)],
    ["a CSS image-set()", (m) => svgWith(`<style>rect{fill:image-set("${m}" 1x)}</style><rect width="4" height="4"/>`)],
    ["a stylesheet processing instruction", (m) => `<?xml-stylesheet href="${m}" type="text/css"?><svg xmlns="${SVG}" width="4" height="4"/>`],
    ["an href on <use> to another file", (m) => svgWith(`<use href="${m}#x"/>`)],
    ["an href on a filter image", (m) => svgWith(`<filter id="f"><feImage href="${m}"/></filter><rect width="4" height="4" filter="url(#f)"/>`)],
    ["a nested SVG (base64) that names the file", (_m, _u, data) => svgWith(`<image width="4" height="4" href="data:image/svg+xml;base64,${data}"/>`)],
    ["a nested SVG (percent-encoded) that names the file", (m) => svgWith(`<image width="4" height="4" href="data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="${SVG}" width="4" height="4"><image width="4" height="4" href="${m}"/></svg>`)}"/>`)],
    ["a nested SVG (xlink) that names the file", (_m, _u, data) => svgWith(`<image width="4" height="4" xlink:href="data:image/svg+xml;base64,${data}"/>`)],
    ["an image data URI that is not base64", () => svgWith(`<image width="4" height="4" href="data:image/png,%89PNG"/>`)],
    ["a web address", () => svgWith(`<image width="4" height="4" href="https://example.com/a.png"/>`)]
  ];
  it.each(spellings)("refuses %s, so the marker is never drawn", async (_name, build) => {
    await expect(rasterizeSvgPictureWithResvg(request(build(marker, markerUrl, markerData), 4, 4))).rejects.toThrow();
  });

  it("names the reason: outside the picture, nested SVG, or unreadable", async () => {
    await expect(rasterizeSvgPictureWithResvg(request(svgWith(`<image href="${marker}"/>`)))).rejects.toThrow("outside the picture");
    await expect(rasterizeSvgPictureWithResvg(request(svgWith(`<image href="data:image/svg+xml;base64,${markerData}"/>`)))).rejects.toThrow("nests another SVG");
    await expect(rasterizeSvgPictureWithResvg(request("<svg"))).rejects.toThrow("not well-formed");
  });

  it("rejects instead of throwing synchronously", () => {
    const pending = rasterizeSvgPictureWithResvg(request(svgWith(`<image href="${marker}"/>`)));
    expect(pending).toBeInstanceOf(Promise);
    return expect(pending).rejects.toThrow();
  });
});

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const pngSize = (dataUri: string) => {
  const bytes = Buffer.from(dataUri.replace(/^data:image\/png;base64,/, ""), "base64");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

describe("rasterizeSvgPictureWithResvg uses the shared SVG safety check", { timeout: 30_000 }, () => {
  const svgWith = (body: string) => `<svg xmlns="${SVG}" xmlns:xlink="${XLINK}" width="4" height="4">${body}</svg>`;

  it("refuses a fragment on <image> or <feImage>, which resvg's resolver could read as a relative file name", async () => {
    for (const body of ['<rect id="a" width="4" height="4"/><image width="4" height="4" href="#a"/>',
      '<rect id="a" width="4" height="4"/><image width="4" height="4" xlink:href="#a"/>',
      '<rect id="a" width="4" height="4"/><filter id="f"><feImage href="#a"/></filter><rect width="4" height="4" filter="url(#f)"/>']) {
      await expect(rasterizeSvgPictureWithResvg(request(svgWith(body), 4, 4)), body).rejects.toThrow("outside the picture");
    }
  });

  it("draws a <use> of an element in the picture, and a dangling one draws nothing instead of being read elsewhere", async () => {
    const svg = svgWith('<defs><rect id="r" width="4" height="4" fill="#ff0000"/></defs><use href="#r"/><use href="#missing"/>');
    const image = decode(await rasterizeSvgPictureWithResvg(request(svg, 4, 4)), 4, 4);
    expect(pixel(image, 2, 2)).toEqual([255, 0, 0, 255]);
  });

  it("checks inline bitmaps by their bytes and header size before any Resvg is built", async () => {
    await expect(rasterizeSvgPictureWithResvg(request(svgWith(`<image width="4" height="4" href="data:image/png;base64,${base64(jpegHeader(4, 4))}"/>`), 4, 4)))
      .rejects.toThrow("labelled image/png but its contents are JPEG");
    await expect(rasterizeSvgPictureWithResvg(request(svgWith(`<image width="4" height="4" href="data:image/png;base64,${base64(pngWithSize(20_000, 1))}"/>`), 4, 4)))
      .rejects.toThrow("20000 × 1 pixels; the limit is 16384 pixels on a side");
  });

  it("reads CSS with the shared forward-only tokenizer: a style full of url() takes linear time", async () => {
    const svg = svgWith(`<style>rect{--x:${"url(#a) ".repeat(90_000)}}</style><rect id="a" width="4" height="4" fill="#00ff00"/>`);
    const started = performance.now();
    const image = decode(await rasterizeSvgPictureWithResvg(request(svg, 4, 4)), 4, 4);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(pixel(image, 2, 2)).toEqual([0, 255, 0, 255]);
  });

  it("reads only <style>, style= and reference-bearing presentation attributes as CSS", async () => {
    const svg = svgWith('<desc>@import url(/etc/hosts)</desc><rect width="4" height="4" fill="#0000ff" aria-label="see url(/etc/hosts) and @import"/>'
      + '<text x="0" y="3" font-size="1" fill="#0000ff">url(file:///etc/hosts)</text>');
    const image = decode(await rasterizeSvgPictureWithResvg(request(svg, 4, 4)), 4, 4);
    expect(pixel(image, 2, 2)).toEqual([0, 0, 255, 255]);
  });

  it("draws a DOCTYPE with no internal subset, which the check drops", async () => {
    const svg = `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="${SVG}" width="4" height="4"><rect width="4" height="4" fill="#ff0000"/></svg>`;
    expect(pixel(decode(await rasterizeSvgPictureWithResvg(request(svg, 4, 4)), 4, 4), 2, 2)).toEqual([255, 0, 0, 255]);
  });

  it("draws the benign samples, the diagram's text fallback included", async () => {
    for (const sample of [EDITOR_SAMPLE, PLOT_SAMPLE, DIAGRAM_SAMPLE, TOOLKIT_SAMPLE]) {
      expect((await rasterizeSvgPictureWithResvg(request(sample, 80, 40))).length).toBeGreaterThan(8);
    }
  });

  it("control: resvg-js leaves out a WebP an SVG embeds, which is why render-document warns about it", () => {
    // A real, decodable 4 x 4 opaque red lossless WebP.
    const webp = "UklGRhwAAABXRUJQVlA4TA8AAAAvA8AAAAcQ/Y/+ByKi/wEA";
    const image = new Resvg(svgWith(`<image width="4" height="4" href="data:image/webp;base64,${webp}"/>`)).render();
    expect([...image.pixels.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
  });
});

describe("flattenSvgPictures", { timeout: 30_000 }, () => {
  const picture = (id: string, width: number, height: number, body = `<rect width="40" height="20" fill="#ff0000"/>`) =>
    `<g data-object-id="${id}"><image x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none" `
    + `href="data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="${SVG}" width="40" height="20">${body}</svg>`).toString("base64")}"/></g>`;
  const page = (...items: string[]) => `<svg xmlns="${SVG}" width="400" height="300" viewBox="0 0 400 300">${items.join("")}</svg>`;
  const hrefs = (svg: string) => [...svg.matchAll(/href="(data:image\/png;base64,[^"]*)"/g)].map((match) => match[1]!);

  it("rasterises each picture at the size the output draws it, not at a 300 dpi minimum", async () => {
    const warnings: ExportWarning[] = [];
    const flattened = await flattenSvgPictures(page(picture("p", 40, 20)), 1.5, warnings);
    expect(warnings).toEqual([]);
    expect(hrefs(flattened).map(pngSize)).toEqual([[60, 30]]);
  });

  it("keeps every flattened picture of one export within one pixel budget, and names the picture it could not draw", async () => {
    const warnings: ExportWarning[] = [];
    // The first picture takes 40 x 20 = 800 pixels; 1000 leaves too little for the second to be worth drawing.
    const flattened = await flattenSvgPictures(page(picture("first", 40, 20), picture("second", 40, 20)), 1, warnings, 1000);
    expect(hrefs(flattened).map(pngSize)).toEqual([[40, 20]]);
    expect(warnings).toEqual([expect.objectContaining({ code: "export.png.svg_picture_not_drawn", objectId: "second",
      message: expect.stringContaining("too many SVG pictures") })]);
    // With room for a smaller copy, a later picture is shrunk rather than dropped.
    const shrunk = await flattenSvgPictures(page(picture("first", 200, 100), picture("second", 200, 100)), 1, [], 20000 + 5000);
    const [, second] = hrefs(shrunk).map(pngSize);
    expect(second![0]! * second![1]!).toBeLessThanOrEqual(5000);
  });

  it("names the picture's own object from the parsed tree, not an earlier object's id nearby in the text", async () => {
    const warnings: ExportWarning[] = [];
    const refused = picture("pic", 40, 20, '<image width="4" height="4" href="/etc/hosts"/>');
    await flattenSvgPictures(page('<g data-object-id="mol1"><path d="M0 0"/></g>', refused), 1, warnings);
    expect(warnings).toEqual([expect.objectContaining({ objectId: "pic", message: expect.stringContaining("SVG picture pic was not drawn") })]);
  });
});
