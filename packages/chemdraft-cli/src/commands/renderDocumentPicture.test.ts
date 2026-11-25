import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyDocument, createImageGraphicObject, serializeDocument } from "@chemdraft/chem-core";
import { runCli } from "../cli";
import type { CliIo } from "../output";

const SVG = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";
const solidPng = (color: string, size = 4) => Buffer.from(new Resvg(`<svg xmlns="${SVG}" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="${color}"/></svg>`).render().asPng());

let directory: string, marker: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "chemdraft-render-picture-"));
  marker = join(directory, "marker.png");
  await writeFile(marker, solidPng("#ff0000"));
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function run(args: string[]) {
  const stdout: string[] = [], stderr: string[] = [];
  const io: CliIo = { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) };
  const code = await runCli(args, io);
  return { code, result: stdout.length ? JSON.parse(stdout[0]!) : undefined };
}

/** A document whose only picture is an SVG picture; `source` replaces the stored data, as a file edited on disk would. */
async function pictureDocument(name: string, source: string): Promise<string> {
  const document = createEmptyDocument();
  const picture = createImageGraphicObject({ id: "picture", mimeType: "image/svg+xml", center: { x: 400, y: 300 },
    dataBase64: Buffer.from(`<svg xmlns="${SVG}" width="40" height="20"><rect width="40" height="20" fill="#000"/></svg>`).toString("base64") });
  picture.data.image!.dataBase64 = Buffer.from(source).toString("base64");
  document.pages[0]!.objects = [picture];
  const file = join(directory, `${name}.chemdraft`);
  await writeFile(file, serializeDocument(document));
  return file;
}

/** The pixel at the centre of a rendered PNG, which is the centre of the only picture. */
async function centre(png: string) {
  const bytes = await readFile(png);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20); // IHDR
  const image = new Resvg(`<svg xmlns="${SVG}" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${bytes.toString("base64")}"/></svg>`).render();
  const at = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
  return [...image.pixels.subarray(at, at + 4)];
}

const renderPng = async (name: string, source: string) => {
  const input = await pictureDocument(name, source);
  const output = join(directory, `${name}.png`);
  const rendered = await run(["render-document", "--document", input, "--out", output, "--width", "400", "--background", "white"]);
  expect(rendered.code, JSON.stringify(rendered.result)).toBe(0);
  return { rendered, pixel: await centre(output) };
};

describe("render-document PNG with SVG pictures", { timeout: 60_000 }, () => {
  it("draws the bitmap an SVG picture embeds, which resvg drops from a nested SVG", async () => {
    const svg = `<svg xmlns="${SVG}" xmlns:xlink="${XLINK}" width="40" height="20"><image width="40" height="20" preserveAspectRatio="none" xlink:href="data:image/png;base64,${solidPng("#ff0000").toString("base64")}"/></svg>`;
    const { rendered, pixel } = await renderPng("embedded-bitmap", svg);
    expect(pixel).toEqual([255, 0, 0, 255]);
    expect(rendered.result.warnings).toEqual([]);
  });

  it("still draws a plain vector SVG picture", async () => {
    const { pixel } = await renderPng("vector", `<svg xmlns="${SVG}" width="40" height="20"><rect width="40" height="20" fill="#0000ff"/></svg>`);
    expect(pixel).toEqual([0, 0, 255, 255]);
  });

  it("flattens the picture at the document style's pixel density", async () => {
    const input = await pictureDocument("document-style", `<svg xmlns="${SVG}" width="40" height="20"><rect width="40" height="20" fill="#00aa00"/></svg>`);
    const output = join(directory, "document-style.png");
    const rendered = await run(["render-document", "--document", input, "--out", output, "--style", "document", "--dpi", "150"]);
    expect(rendered.code, JSON.stringify(rendered.result)).toBe(0);
    expect(await centre(output)).toEqual([0, 170, 0, 255]);
  });

  it.each([
    ["an absolute path", (m: string) => `<svg xmlns="${SVG}" width="40" height="20"><image width="40" height="20" href="${m}"/></svg>`],
    ["an xlink path", (m: string) => `<svg xmlns="${SVG}" xmlns:xlink="${XLINK}" width="40" height="20"><image width="40" height="20" xlink:href="${m}"/></svg>`],
    ["a path through an entity", (m: string) => `<!DOCTYPE svg [<!ENTITY p "${m}">]><svg xmlns="${SVG}" width="40" height="20"><image width="40" height="20" href="&p;"/></svg>`],
    ["a CSS url()", (m: string) => `<svg xmlns="${SVG}" width="40" height="20"><rect width="40" height="20" style="fill:url('${m}')"/></svg>`],
    ["a nested SVG that names the file", (m: string) => `<svg xmlns="${SVG}" width="40" height="20"><image width="40" height="20" href="data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="${SVG}" width="4" height="4"><image width="4" height="4" href="${m}"/></svg>`).toString("base64")}"/></svg>`]
  ])("does not draw the host file marker for %s, and says the picture was not drawn", async (name, build) => {
    const { rendered, pixel } = await renderPng(`marker-${name.replace(/\W+/g, "-")}`, build(marker));
    expect(pixel).not.toEqual([255, 0, 0, 255]);
    expect(rendered.result.ok).toBe(true);
    expect(rendered.result.exportWarnings).toContainEqual(expect.objectContaining({ code: "export.png.svg_picture_not_drawn", objectId: "picture" }));
  });
});

describe("render-document PDF with SVG pictures", { timeout: 60_000 }, () => {
  // The desktop sanitiser's benign fixture: it must draw headlessly too, not be refused.
  const benign = `<svg xmlns="${SVG}" xmlns:xlink="${XLINK}" viewBox="0 0 100 50" width="100" height="50">
  <defs>
    <linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>
    <clipPath id="clip"><rect width="40" height="40"/></clipPath>
    <marker id="m" markerWidth="4" markerHeight="4"><path d="M0 0L4 2L0 4z"/></marker>
    <filter id="f"><feGaussianBlur stdDeviation="1"/></filter>
    <symbol id="s"><circle r="3"/></symbol>
  </defs>
  <style>.a{fill:url(#g);stroke:#000} @media print{.a{stroke:none}}</style>
  <rect class="a" width="50" height="20" clip-path="url(#clip)" filter="url( '#f' )"/>
  <path d="M0 0L10 10" marker-end="url(#m)" style="stroke: red; stroke-width: 2"/>
  <use href="#s" x="5"/><use xlink:href="#s" x="9"/>
  <image href="data:image/png;base64,${solidPng("#ff0000").toString("base64")}" width="1" height="1"/>
  <text x="1" y="9" font-family="serif">Benzene ⌬ αβ</text>
</svg>`;

  it("draws the benign fixture, including a quoted url() with spaces before the fragment", async () => {
    const output = join(directory, "benign.pdf");
    const rendered = await run(["render-document", "--document", await pictureDocument("benign", benign), "--out", output]);
    expect(rendered.code, JSON.stringify(rendered.result)).toBe(0);
    expect(rendered.result.warnings).toEqual([]);
    expect((await readFile(output)).toString("latin1")).toMatch(/\/Subtype \/Image/);
  });

  it("refuses a picture that names a host file, with a warning and no image", async () => {
    const output = join(directory, "marker.pdf");
    const source = `<svg xmlns="${SVG}" width="40" height="20"><image width="40" height="20" href="${marker}"/></svg>`;
    const rendered = await run(["render-document", "--document", await pictureDocument("marker-pdf", source), "--out", output]);
    expect(rendered.code, JSON.stringify(rendered.result)).toBe(0);
    expect(rendered.result.exportWarnings).toContainEqual(expect.objectContaining({ code: "export.pdf.svg_picture_not_drawn", objectId: "picture" }));
    expect((await readFile(output)).toString("latin1")).not.toMatch(/\/Subtype \/Image/);
  });
});
