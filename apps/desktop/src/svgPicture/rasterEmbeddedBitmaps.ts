import type { SvgPictureRasterRequest } from "@chemdraft/export-engine/pdf";
import { bytesToBase64, RasterPictureMaxSidePx, type RasterPicturePreStep } from "../rasterPictureDecode";

/**
 * SVG pictures that embed a bitmap, for native raster export (PNG, JPEG, BMP, GIF, TIFF, Copy as PNG).
 *
 * The native renderer is built without a bitmap decoder, so an `<image>` whose SVG carries its own
 * PNG, JPEG, GIF or WebP would be drawn without it. Here, in the webview, such a picture is rasterised
 * with the same hook the PDF export uses and its href becomes the resulting PNG, which the existing
 * PNG path (`rasterPictureDecode.ts`) then hands to Rust as pixels. Frame, transform, opacity and
 * z-order stay on the `<image>` and its group; only the href changes. Pure-vector SVG pictures are
 * left alone: Rust draws those itself.
 *
 * This is a step of `prepareRasterPictures` (`beforeDecode`), run on each picture in drawing order, so
 * there is one decoded-pixel ledger: pictures before it are charged only once they have decoded, and
 * this one is sized to what is truly left. The raster is made at the size the export draws the
 * picture (frame × the page's user-unit scale × ancestor scale groups × the export scale, after the
 * same longest-side clamp Rust applies), within 16384 px a side, then shrunk to the remaining bytes.
 * Its final integer size is checked against them before anything is drawn. A picture that cannot get
 * even the smallest useful size, or whose rasterising fails, keeps its href, so it is drawn as before
 * and Rust reports the missing bitmap.
 */

export type EmbeddedBitmapRasterizer = (request: SvgPictureRasterRequest) => Promise<Uint8Array>;

export interface RasterizeEmbeddedBitmapsOptions {
  /** The export's `scale` and `maxDimensionPx`, as sent to `rasterize_svg`. */
  scale?: number;
  maxDimensionPx?: number;
  /** Defaults to the webview rasteriser (`svgPictureRaster.ts`), loaded on first use. */
  rasterize?: EmbeddedBitmapRasterizer;
}

const SvgNamespace = "http://www.w3.org/2000/svg";
const XlinkNamespace = "http://www.w3.org/1999/xlink";
const SvgDataUri = /^data:image\/svg\+xml(;[^,]*)?,/i;
/** A bitmap embedded in the picture's own markup; anything else it references is not decoded either way. */
const EmbeddedBitmap = /data:\s*image\/(?:png|jpe?g|gif|webp)\b/i;
/** `DEFAULT_MAX_DIMENSION_PX` in `export.rs`. */
const DefaultMaxDimensionPx = 8192;
/** A picture the remaining budget would shrink below this longest side is not worth drawing; as in the PDF export. */
const MinRasterSide = 64;

/**
 * The `beforeDecode` step for one export: an SVG picture that embeds a bitmap gets a PNG of itself,
 * sized to fit `remainingBytes`. Identical pictures at one size are rasterised once.
 */
export function embeddedBitmapPictureStep(options: RasterizeEmbeddedBitmapsOptions = {}): RasterPicturePreStep {
  const cache = new Map<string, Promise<string | undefined>>();
  let scales: { user: number | undefined; export: number } | undefined;
  return async (image, remainingBytes) => {
    const href = singleHref(image);
    if (!href || !SvgDataUri.test(href.value)) return;
    const text = decodeSvgDataUri(href.value);
    if (text === undefined || !EmbeddedBitmap.test(text)) return;
    const root = image.ownerDocument.documentElement;
    scales ??= { user: userUnitScale(root), export: effectiveExportScale(root, options) };
    const frame = { width: Number(image.getAttribute("width")), height: Number(image.getAttribute("height")) };
    const ancestors = ancestorScale(image);
    if (!ancestors || !scales.user || !(frame.width > 0) || !(frame.height > 0)) return;
    let pixelWidth = frame.width * scales.user * ancestors.x * scales.export;
    let pixelHeight = frame.height * scales.user * ancestors.y * scales.export;
    // The same side bound `prepareRasterPictures` applies to the PNG it decodes next.
    const fitSide = Math.min(1, RasterPictureMaxSidePx / Math.max(pixelWidth, pixelHeight));
    pixelWidth *= fitSide;
    pixelHeight *= fitSide;
    const fitBudget = Math.min(1, Math.sqrt(Math.max(remainingBytes, 0) / (4 * pixelWidth * pixelHeight)));
    if (fitBudget < 1 && Math.max(pixelWidth, pixelHeight) * fitBudget < MinRasterSide) return;
    const size = {
      pixelWidth: Math.max(1, Math.floor(pixelWidth * fitBudget)),
      pixelHeight: Math.max(1, Math.floor(pixelHeight * fitBudget))
    };
    // What the decode pass will charge: the final integer size must fit what is left.
    if (size.pixelWidth * size.pixelHeight * 4 > remainingBytes) return;
    const key = `${frame.width}x${frame.height}@${size.pixelWidth}x${size.pixelHeight}:${href.value}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = (async () => {
        const rasterize = options.rasterize ?? (await import("./svgPictureRaster")).rasterizeSvgPicture;
        return rasterizeToDataUri(rasterize, { svg: text, ...frame, ...size });
      })();
      cache.set(key, pending);
    }
    const png = await pending;
    if (png !== undefined) href.value = png;
  };
}

async function rasterizeToDataUri(
  rasterize: EmbeddedBitmapRasterizer,
  request: SvgPictureRasterRequest
): Promise<string | undefined> {
  try {
    const bytes = await rasterize(request);
    return ArrayBuffer.isView(bytes) ? `data:image/png;base64,${bytesToBase64(bytes)}` : undefined;
  } catch {
    // The picture keeps today's behaviour: drawn without its bitmap, with Rust's warning.
    return undefined;
  }
}

/** The one href (in any namespace usvg reads) of an `<image>` that has no id, or undefined. */
function singleHref(image: Element): Attr | undefined {
  if (image.hasAttribute("id")) return undefined;
  const hrefs = Array.from(image.attributes).filter((attribute) => attribute.localName === "href");
  const [attribute] = hrefs;
  if (hrefs.length !== 1 || ![null, SvgNamespace, XlinkNamespace].includes(attribute.namespaceURI)) return undefined;
  return attribute;
}

function decodeSvgDataUri(uri: string): string | undefined {
  const comma = uri.indexOf(",");
  const meta = uri.slice(0, comma);
  const payload = uri.slice(comma + 1);
  try {
    if (/;base64/i.test(meta)) {
      return new TextDecoder().decode(Uint8Array.from(atob(payload), (char) => char.charCodeAt(0)));
    }
    return decodeURIComponent(payload);
  } catch {
    return undefined;
  }
}

const LengthUnits: Record<string, number> = { "": 1, px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 };

function lengthInPixels(value: string | null): number | undefined {
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i.exec(value ?? "");
  const length = match ? Number(match[1]) * (LengthUnits[match[2].toLowerCase()] ?? NaN) : NaN;
  return length > 0 ? length : undefined;
}

function viewBoxOf(root: Element): { width: number; height: number } | undefined {
  const parts = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  return parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0
    ? { width: parts[2], height: parts[3] } : undefined;
}

/** The root's size in pixels as usvg reads it: width and height, else the viewBox, else nothing. */
function rootSizeInPixels(root: Element): { width: number; height: number } | undefined {
  const box = viewBoxOf(root);
  const width = lengthInPixels(root.getAttribute("width")) ?? box?.width;
  const height = lengthInPixels(root.getAttribute("height")) ?? box?.height;
  return width && height ? { width, height } : undefined;
}

/** Pixels per user unit at the root (the viewBox mapping, uniform as `meet` makes it). */
function userUnitScale(root: Element): number | undefined {
  const size = rootSizeInPixels(root);
  if (!size) return undefined;
  const box = viewBoxOf(root);
  return box ? Math.min(size.width / box.width, size.height / box.height) : 1;
}

/** Raster pixels per source pixel Rust applies: the requested scale after its longest-side clamp. */
function effectiveExportScale(
  root: Element,
  { scale = 1, maxDimensionPx = DefaultMaxDimensionPx }: RasterizeEmbeddedBitmapsOptions
): number {
  const size = rootSizeInPixels(root);
  if (!size || !(scale > 0) || !Number.isFinite(scale)) return 1;
  const limit = Math.min(Math.max(Math.round(maxDimensionPx), 1), DefaultMaxDimensionPx);
  const longest = Math.max(Math.ceil(size.width), Math.ceil(size.height)) * scale;
  return longest > limit ? scale * limit / longest : scale;
}

/** The scale the image's own and its ancestor groups' transforms add, or undefined if one cannot be read. */
function ancestorScale(image: Element): { x: number; y: number } | undefined {
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  // Stops below the root: its size and viewBox are handled by `userUnitScale`.
  for (let node: Element | null = image; node?.parentElement; node = node.parentElement) {
    const parsed = parseTransform(node.getAttribute("transform"));
    if (!parsed) return undefined;
    matrix = multiply(parsed, matrix);
  }
  return { x: Math.hypot(matrix[0], matrix[1]), y: Math.hypot(matrix[2], matrix[3]) };
}

type Matrix = [number, number, number, number, number, number];

function multiply(left: Matrix, right: Matrix): Matrix {
  const [a, b, c, d, e, f] = left;
  const [a2, b2, c2, d2, e2, f2] = right;
  return [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f];
}

/** An SVG transform list as one matrix; undefined for anything it cannot read. */
function parseTransform(value: string | null): Matrix | undefined {
  let result: Matrix = [1, 0, 0, 1, 0, 0];
  if (value === null || value.trim() === "") return result;
  const pattern = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/gy;
  let consumed = 0;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    consumed = pattern.lastIndex;
    const args = match[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (args.some((arg) => !Number.isFinite(arg))) return undefined;
    let next: Matrix | undefined;
    switch (match[1]) {
      case "matrix": next = args.length === 6 ? args as Matrix : undefined; break;
      case "translate": next = args.length === 1 || args.length === 2 ? [1, 0, 0, 1, args[0], args[1] ?? 0] : undefined; break;
      case "scale": next = args.length === 1 || args.length === 2 ? [args[0], 0, 0, args[1] ?? args[0], 0, 0] : undefined; break;
      case "rotate": {
        if (args.length !== 1 && args.length !== 3) return undefined;
        const radians = args[0] * Math.PI / 180;
        const cos = Math.cos(radians), sin = Math.sin(radians);
        const [cx, cy] = [args[1] ?? 0, args[2] ?? 0];
        next = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
        break;
      }
      case "skewX": next = args.length === 1 ? [1, 0, Math.tan(args[0] * Math.PI / 180), 1, 0, 0] : undefined; break;
      default: next = args.length === 1 ? [1, Math.tan(args[0] * Math.PI / 180), 0, 1, 0, 0] : undefined;
    }
    if (!next) return undefined;
    result = multiply(result, next);
  }
  return value.slice(consumed).trim() === "" ? result : undefined;
}
