import { Resvg } from "@resvg/resvg-js";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { sanitizeSvgPicture, type ExportWarning, type SanitizedSvg } from "@chemdraft/export-engine";
import type { SvgPictureRasterRequest } from "@chemdraft/export-engine/pdf";

/**
 * The headless `rasterizeSvgPicture` hook for PDF export, and the picture flattening for PNG export: the
 * same stretched-to-frame drawing the canvas does, rendered by resvg. The picture is untrusted, and
 * @resvg/resvg-js 2.6 has no switch for its default resolver (no resolver, resourcesDir or
 * resolve-nothing option; `imagesToResolve()` stays empty even for a path it then reads), so resvg would
 * read a path that an `href` names. Nothing reaches resvg until the shared SVG safety check
 * (`@chemdraft/export-engine`, the one the desktop drop uses) has read it: under its refusing policy a
 * picture that refers to anything outside itself is not drawn at all, bitmaps are checked by their
 * bytes and sizes before any Resvg is built, and what resvg draws is the serialisation of what was
 * checked.
 */

const MAX_RENDER_SIDE = 8192;
/** PNG flattening: the longest side of one flattened picture. */
export const FLATTEN_MAX_SIDE = 8192;
/** PNG flattening: decoded pixels of every flattened picture in one export together. */
export const FLATTEN_MAX_PIXELS = 64 * 1024 * 1024;
/** A picture the remaining budget would shrink below this longest side is not drawn; as in the PDF export. */
const FLATTEN_MIN_SIDE = 64;
const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_DATA = /^\s*data:image\/svg\+xml[;,]/i;

interface Xml { parser: DOMParser; serializer: XMLSerializer }
let xmlTools: Promise<Xml> | undefined;
/** jsdom's XML parser, as the PDF export uses; its own window, so no globals are touched. */
function xml(): Promise<Xml> {
  xmlTools ??= import("jsdom").then(({ JSDOM }) => {
    const { window } = new JSDOM("<!doctype html><html><body></body></html>");
    return { parser: new window.DOMParser() as unknown as DOMParser, serializer: new window.XMLSerializer() as unknown as XMLSerializer };
  });
  return xmlTools;
}

/** The shared safety check, refusing what reaches outside the picture; throws with the reason. */
export async function sanitizeSvgForResvg(source: string): Promise<SanitizedSvg> {
  const { parser, serializer } = await xml();
  const result = sanitizeSvgPicture(source, { domParser: parser, xmlSerializer: serializer, outsideReferences: "refuse" });
  if (!result.ok) throw new Error(result.error.replace(/\.$/, ""));
  return result;
}

export async function rasterizeSvgPictureWithResvg(request: SvgPictureRasterRequest): Promise<Uint8Array> {
  const { svg } = await sanitizeSvgForResvg(request.svg);
  const { pixelWidth, pixelHeight } = request;
  // resvg-js does not draw an image nested inside an SVG that is itself nested as an image, so render the
  // picture directly, at its own aspect and large enough to cover the frame on both axes...
  const intrinsic = new Resvg(svg);
  const scale = Math.min(Math.max(pixelWidth / intrinsic.width, pixelHeight / intrinsic.height),
    MAX_RENDER_SIDE / Math.max(intrinsic.width, intrinsic.height));
  const rendered = new Resvg(svg, { fitTo: { mode: "width", value: Math.max(1, Math.round(intrinsic.width * scale)) } })
    .render().asPng();
  // ...then stretch that to the frame (preserveAspectRatio="none"), as the canvas does.
  const href = `data:image/png;base64,${Buffer.from(rendered).toString("base64")}`;
  const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelWidth}" height="${pixelHeight}" viewBox="0 0 ${pixelWidth} ${pixelHeight}">` +
    `<image x="0" y="0" width="${pixelWidth}" height="${pixelHeight}" preserveAspectRatio="none" href="${href}"/></svg>`;
  return new Uint8Array(new Resvg(wrapper).render().asPng());
}

/**
 * resvg-js draws PNG, JPEG and GIF bitmaps only: a WebP an SVG picture embeds is left out. One warning
 * per such picture on the rendered (first) page, so the loss is never silent. Pictures the check
 * refuses get their own "not drawn" warning from the export, not this one.
 */
export async function headlessSvgPictureWarnings(document: ChemDraftDocument, format: "png" | "pdf"): Promise<ExportWarning[]> {
  const warnings: ExportWarning[] = [];
  for (const object of document.pages[0]?.objects ?? []) {
    const image = object.type === "graphic" ? object.data.image : undefined;
    if (!image || image.mimeType !== "image/svg+xml") continue;
    let sanitized: SanitizedSvg;
    try {
      sanitized = await sanitizeSvgForResvg(Buffer.from(image.dataBase64, "base64").toString("utf8"));
    } catch {
      continue;
    }
    if (!sanitized.embeddedBitmaps.some((bitmap) => bitmap.format === "webp")) continue;
    warnings.push({ code: `export.${format}.svg_picture_bitmap_not_drawn`, severity: "warning", objectId: object.id,
      message: `${format.toUpperCase()} export: SVG picture ${object.id} embeds a WebP bitmap, which headless export can't draw; the rest of the picture is drawn.` });
  }
  return warnings;
}

/** The id of the exported object an element belongs to: its nearest `data-object-id` ancestor. */
function owningObjectId(element: Element): string | undefined {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const id = node.getAttribute("data-object-id");
    if (id) return id;
  }
  return undefined;
}

/**
 * Replace every nested SVG picture in an exported document SVG with the PNG the headless rasteriser makes
 * of it. resvg draws no bitmap inside an SVG nested as an image, and it must never be handed the nested
 * source at all. Each picture is rasterised at the size the output draws it (`pixelsPerUnit`: output pixels
 * per user unit of the SVG), at most `FLATTEN_MAX_SIDE` a side, and all of them together within
 * `FLATTEN_MAX_PIXELS`: later pictures are shrunk to what is left, not failed. A picture that is refused,
 * fails or gets too few pixels is removed with a warning naming its object, not allowed to fail the PNG.
 */
export async function flattenSvgPictures(svg: string, pixelsPerUnit: number, warnings: ExportWarning[], budgetPixels = FLATTEN_MAX_PIXELS): Promise<string> {
  if (!/data:image\/svg\+xml/i.test(svg)) return svg;
  const { parser, serializer } = await xml();
  const parsed = parser.parseFromString(svg, "image/svg+xml");
  if (parsed.getElementsByTagName("parsererror").length) throw new Error("the exported SVG could not be read to draw its pictures");
  const done = new Map<string, Promise<string>>();
  let remainingPixels = budgetPixels;
  for (const image of Array.from(parsed.getElementsByTagNameNS(SVG_NS, "image"))) {
    const hrefs = Array.from(image.attributes).filter((attribute) => attribute.localName === "href");
    if (!hrefs.some((attribute) => SVG_DATA.test(attribute.value))) continue;
    const id = owningObjectId(image);
    let charged = 0;
    try {
      const base64 = hrefs.length === 1 ? /^data:image\/svg\+xml;base64,([A-Za-z0-9+/=]*)$/i.exec(hrefs[0]!.value)?.[1] : undefined;
      const width = Number(image.getAttribute("width")), height = Number(image.getAttribute("height"));
      if (base64 === undefined || !(width > 0) || !(height > 0)) throw new Error("the picture's data or frame can't be read");
      let pixelWidth = width * pixelsPerUnit, pixelHeight = height * pixelsPerUnit;
      const fitSide = Math.min(1, FLATTEN_MAX_SIDE / Math.max(pixelWidth, pixelHeight));
      const fitBudget = Math.min(1, Math.sqrt(Math.max(remainingPixels, 0) / (pixelWidth * pixelHeight * fitSide * fitSide)));
      if (fitBudget < 1 && Math.max(pixelWidth, pixelHeight) * fitSide * fitBudget < FLATTEN_MIN_SIDE) {
        throw new Error("the document has too many SVG pictures to draw within the memory limit");
      }
      pixelWidth = Math.max(1, Math.floor(pixelWidth * fitSide * fitBudget));
      pixelHeight = Math.max(1, Math.floor(pixelHeight * fitSide * fitBudget));
      if (pixelWidth * pixelHeight > remainingPixels) throw new Error("the document has too many SVG pictures to draw within the memory limit");
      // The final PNG decodes every picture on its own, so each one is charged, shared raster or not.
      charged = pixelWidth * pixelHeight;
      remainingPixels -= charged;
      const key = `${pixelWidth}x${pixelHeight}:${base64}`;
      let png = done.get(key);
      if (!png) {
        png = rasterizeSvgPictureWithResvg({ svg: Buffer.from(base64, "base64").toString("utf8"), width, height, pixelWidth, pixelHeight })
          .then((bytes) => Buffer.from(bytes).toString("base64"));
        done.set(key, png);
      }
      hrefs[0]!.value = `data:image/png;base64,${await png}`;
    } catch (error) {
      // Nothing is drawn for it, so it costs nothing.
      remainingPixels += charged;
      image.remove();
      warnings.push({ code: "export.png.svg_picture_not_drawn", severity: "warning", ...(id ? { objectId: id } : {}),
        message: `PNG export: SVG picture${id ? ` ${id}` : ""} was not drawn: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return serializer.serializeToString(parsed);
}
