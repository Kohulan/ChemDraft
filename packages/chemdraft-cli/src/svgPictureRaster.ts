import { Resvg } from "@resvg/resvg-js";
import type { ExportWarning } from "@chemdraft/export-engine";
import type { SvgPictureRasterRequest } from "@chemdraft/export-engine/pdf";

/**
 * The headless `rasterizeSvgPicture` hook for PDF export, and the picture flattening for PNG export: the
 * same stretched-to-frame drawing the canvas does, rendered by resvg. The picture is untrusted, and
 * @resvg/resvg-js 2.6 has no switch for its default resolver (no resolver, resourcesDir or
 * resolve-nothing option; `imagesToResolve()` stays empty even for a path it then reads), so resvg would
 * read an absolute path that an `href` names. Nothing reaches resvg until it has been parsed as XML and
 * checked attribute by attribute, and what resvg draws is the serialisation of what was checked.
 */

const MAX_RENDER_SIDE = 8192;
const OUTSIDE = "the SVG refers to a file or address outside the picture";
/** Inline bitmaps only: a nested SVG could carry anything, and a percent-encoded body hides what it is. */
const INLINE_BITMAP = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/i;
const NESTED_SVG = /^data:image\/svg\+xml/i;

let domParser: Promise<{ parser: DOMParser; serializer: XMLSerializer }> | undefined;
/** jsdom's XML parser, as the PDF export uses; its own window, so no globals are touched. */
function xml(): Promise<{ parser: DOMParser; serializer: XMLSerializer }> {
  domParser ??= import("jsdom").then(({ JSDOM }) => {
    const { window } = new JSDOM("<!doctype html><html><body></body></html>");
    return { parser: new window.DOMParser() as unknown as DOMParser, serializer: new window.XMLSerializer() as unknown as XMLSerializer };
  });
  return domParser;
}

export async function rasterizeSvgPictureWithResvg(request: SvgPictureRasterRequest): Promise<Uint8Array> {
  const svg = await sanitizeSvgForResvg(request.svg);
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
 * Parse the picture and refuse anything that could make resvg read outside it: a DOCTYPE or entity, any
 * `href` (in any namespace) that is not a same-document fragment or an inline PNG/JPEG/GIF/WebP, and any
 * CSS `url()` or `@import` that is not a same-document fragment. Returns the checked tree, serialised.
 */
export async function sanitizeSvgForResvg(source: string): Promise<string> {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(source)) throw new Error("the SVG declares a DOCTYPE or entities, which are not drawn");
  const { parser, serializer } = await xml();
  const document = parser.parseFromString(source, "image/svg+xml");
  const root = document.documentElement;
  if (document.doctype || !root || root.localName !== "svg" || document.getElementsByTagName("parsererror").length) {
    throw new Error("the SVG can't be read as XML");
  }
  for (const node of Array.from(document.childNodes)) {
    if (node.nodeType === 7 && (node as ProcessingInstruction).target.toLowerCase() === "xml-stylesheet") throw new Error(OUTSIDE);
  }
  for (const element of [root, ...Array.from(root.getElementsByTagName("*"))]) {
    for (const attribute of Array.from(element.attributes)) {
      // `href` and `xlink:href`, and any other prefix bound to the XLink namespace, share the local name.
      if (attribute.localName === "href") assertLocalHref(attribute.value);
      else assertLocalCss(attribute.value, attribute.localName === "style" && !attribute.namespaceURI);
    }
    if (element.localName === "style") assertLocalCss(element.textContent ?? "", true);
  }
  return serializer.serializeToString(document);
}

function assertLocalHref(raw: string): void {
  const value = raw.trim();
  if (value.startsWith("#") || INLINE_BITMAP.test(value)) return;
  throw new Error(NESTED_SVG.test(value) ? "the SVG nests another SVG picture, which is not drawn" : OUTSIDE);
}

/** Every `url()` must name a fragment of this document (quotes and spaces around it are fine); no `@import`. */
function assertLocalCss(css: string, escapesMatter: boolean): void {
  // A CSS escape (`\75rl(`) can spell any of the tokens below, so a style that uses one is refused.
  if (escapesMatter && css.includes("\\")) throw new Error(OUTSIDE);
  if (/@import\b/i.test(css)) throw new Error(OUTSIDE);
  for (const match of css.matchAll(/(?:url|image-set)\s*\(/gi)) {
    const value = /^\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/.exec(css.slice(match.index + match[0].length));
    const target = (value?.[1] ?? value?.[2] ?? value?.[3] ?? "").trim();
    if (!target.startsWith("#")) throw new Error(OUTSIDE);
  }
}

/**
 * Replace every nested SVG picture in an exported document SVG with the PNG the headless rasteriser makes
 * of it (`pixelsPerUnit`: output pixels per user unit of the SVG). resvg draws no bitmap inside an SVG nested
 * as an image, and it must never be handed the nested source at all. A picture that is refused or fails is dropped with a warning, not allowed to fail the PNG.
 */
export async function flattenSvgPictures(svg: string, pixelsPerUnit: number, warnings: ExportWarning[]): Promise<string> {
  const tags = [...svg.matchAll(/<image\b[^>]*>/g)].filter((match) => /\s(?:xlink:)?href="data:image\/svg\+xml/i.test(match[0]));
  if (!tags.length) return svg;
  const { svgPictureRasterSize } = await import("@chemdraft/export-engine/pdf");
  const done = new Map<string, Promise<string>>();
  let result = "";
  let cursor = 0;
  for (const match of tags) {
    result += svg.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const tag = match[0];
    const attribute = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
    const href = /\s(?:xlink:)?href="data:image\/svg\+xml;base64,([^"]*)"/i.exec(tag)?.[1];
    const width = Number(attribute("width")), height = Number(attribute("height"));
    const id = /data-object-id="([^"]*)"/.exec(svg.slice(Math.max(0, match.index - 400), match.index))?.[1];
    try {
      if (href === undefined || !(width > 0) || !(height > 0)) throw new Error("the picture's data or frame can't be read");
      const { pixelWidth, pixelHeight } = svgPictureRasterSize({ width, height },
        { pixelWidth: width * pixelsPerUnit, pixelHeight: height * pixelsPerUnit });
      const key = `${pixelWidth}x${pixelHeight}:${href}`;
      let png = done.get(key);
      if (!png) {
        png = rasterizeSvgPictureWithResvg({ svg: Buffer.from(href, "base64").toString("utf8"), width, height, pixelWidth, pixelHeight })
          .then((bytes) => Buffer.from(bytes).toString("base64"));
        done.set(key, png);
      }
      result += tag.replace(/(\s(?:xlink:)?href=")[^"]*"/i, `$1data:image/png;base64,${await png}"`);
    } catch (error) {
      warnings.push({ code: "export.png.svg_picture_not_drawn", severity: "warning", ...(id ? { objectId: id } : {}),
        message: `PNG export: SVG picture${id ? ` ${id}` : ""} was not drawn: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return result + svg.slice(cursor);
}
