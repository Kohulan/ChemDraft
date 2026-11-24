import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";
import { rasterizeSvgPictureWithResvg } from "./svgPictureRaster";

const decode = (png: Uint8Array, width: number, height: number) => {
  const image = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${Buffer.from(png).toString("base64")}"/></svg>`).render();
  return { width: image.width, height: image.height, pixels: image.pixels };
};
const pixel = (image: ReturnType<typeof decode>, x: number, y: number) => [...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
const request = (svg: string, pixelWidth = 40, pixelHeight = 20) => ({ svg, width: 40, height: 20, pixelWidth, pixelHeight });

describe("rasterizeSvgPictureWithResvg", () => {
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
    const png = Buffer.from(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#ff0000"/></svg>').render().asPng()).toString("base64");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="20"><image width="40" height="20" xlink:href="data:image/png;base64,${png}"/></svg>`;
    const image = decode(await rasterizeSvgPictureWithResvg(request(svg)), 40, 20);
    expect(pixel(image, 20, 10)).toEqual([255, 0, 0, 255]);
  });

  it.each([
    ["a file path", '<svg xmlns="http://www.w3.org/2000/svg"><image href="/etc/hosts"/></svg>'],
    ["a file URL", '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/hosts"/></svg>'],
    ["a web address", '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://example.com/a.png"/></svg>'],
    ["a stylesheet url()", '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(/etc/x)"/></svg>'],
    ["a stylesheet import", '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "x.css";</style></svg>']
  ])("refuses %s", async (_name, svg) => {
    await expect(rasterizeSvgPictureWithResvg(request(svg))).rejects.toThrow("outside the picture");
  });

  it("refuses a file path hidden inside nested inline SVG", async () => {
    const inner = '<svg xmlns="http://www.w3.org/2000/svg"><image href="/etc/hosts"/></svg>';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,${Buffer.from(inner).toString("base64")}"/></svg>`;
    await expect(rasterizeSvgPictureWithResvg(request(svg))).rejects.toThrow("outside the picture");
  });

  it("allows internal fragment references", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="40" height="20" fill="url(#g)"/></svg>';
    expect((await rasterizeSvgPictureWithResvg(request(svg))).length).toBeGreaterThan(8);
  });
});
