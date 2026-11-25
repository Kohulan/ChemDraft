import { MAX_IMAGE_SIDE, readSvgInfo } from "@chemdraft/chem-core";
import type { SvgPictureRasterRequest } from "@chemdraft/export-engine/pdf";

/**
 * Webview rasteriser for SVG pictures in PDF export: the `rasterizeSvgPicture` hook of
 * `exportDocumentToPdf`. The SVG is untrusted, so it only ever reaches an Image element (which runs no
 * script and loads nothing external) through a blob URL, then a canvas. It is never put into the DOM.
 */

export const SVG_RASTER_DECODE_TIMEOUT_MS = 5000;
/** The intermediate render (before the stretch to the frame) stays below this on its long side. */
const MAX_RENDER_SIDE = 8192;

export interface SvgRasterImage {
  onload: (() => void) | null;
  onerror: (() => void) | null;
  src: string;
}

export interface SvgRasterCanvas {
  width: number;
  height: number;
  getContext(kind: "2d"): { drawImage(image: SvgRasterImage, x: number, y: number, width: number, height: number): void } | null;
  toBlob(callback: (blob: Blob | null) => void, type: string): void;
}

/** Everything the browser supplies, as parameters, so tests run without one. */
export interface SvgRasterEnvironment {
  parseSvg(svg: string): Document;
  serialize(node: Node): string;
  createImage(): SvgRasterImage;
  createCanvas(): SvgRasterCanvas;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  decodeTimeoutMs: number;
}

export function browserSvgRasterEnvironment(): SvgRasterEnvironment {
  return {
    parseSvg: (svg) => new DOMParser().parseFromString(svg, "image/svg+xml"),
    serialize: (node) => new XMLSerializer().serializeToString(node),
    createImage: () => new Image() as unknown as SvgRasterImage,
    createCanvas: () => document.createElement("canvas") as unknown as SvgRasterCanvas,
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    decodeTimeoutMs: SVG_RASTER_DECODE_TIMEOUT_MS
  };
}

/** The hook: rasterises one SVG picture to PNG bytes, or throws with a reason a user can read. */
export async function rasterizeSvgPicture(
  request: SvgPictureRasterRequest,
  environment: SvgRasterEnvironment = browserSvgRasterEnvironment()
): Promise<Uint8Array> {
  const { pixelWidth, pixelHeight } = request;
  for (const side of [pixelWidth, pixelHeight]) {
    if (!Number.isInteger(side) || side < 1 || side > MAX_IMAGE_SIDE) {
      throw new Error(`the requested raster size ${pixelWidth} x ${pixelHeight} is not usable`);
    }
  }
  const svg = sizedSvg(request, environment);
  const url = environment.createObjectUrl(new Blob([svg], { type: "image/svg+xml" }));
  const image = environment.createImage();
  const canvas = environment.createCanvas();
  try {
    await decode(image, url, environment.decodeTimeoutMs);
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("the canvas has no 2D context");
    try {
      // The canvas stretches the picture to its frame (preserveAspectRatio="none"); the SVG's own
      // preserveAspectRatio applies inside its intrinsic box, which `sizedSvg` keeps at the frame's scale.
      context.drawImage(image, 0, 0, pixelWidth, pixelHeight);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error(`the PNG could not be encoded at ${pixelWidth} x ${pixelHeight}`);
      return new Uint8Array(await blob.arrayBuffer());
    } catch (error) {
      if (error instanceof Error && error.name === "SecurityError") {
        throw new Error("the SVG has content that can't be drawn", { cause: error });
      }
      throw error;
    }
  } finally {
    // Release the decoded image and the canvas backing store now, not at garbage collection.
    image.onload = null;
    image.onerror = null;
    image.src = "";
    canvas.width = 0;
    canvas.height = 0;
    environment.revokeObjectUrl(url);
  }
}

/**
 * Give the root an explicit pixel size so WKWebView, WebView2 and WebKitGTK all rasterise at the size
 * asked for (a root with no size, or percentages, falls back to engine-specific defaults). The root's
 * viewBox and preserveAspectRatio are kept; a root with no viewBox gets one from its intrinsic size,
 * otherwise resizing it would crop instead of scale. Done on a parsed copy, never by string edits.
 */
function sizedSvg(request: SvgPictureRasterRequest, environment: SvgRasterEnvironment): string {
  const intrinsic = readSvgInfo(request.svg)?.physicalSize;
  const parsed = environment.parseSvg(request.svg);
  const root = parsed.documentElement;
  if (!intrinsic || !root || root.localName !== "svg" || parsed.getElementsByTagName("parsererror").length > 0) {
    throw new Error("the SVG could not be parsed");
  }
  // Render at the intrinsic aspect so the SVG's own preserveAspectRatio sees the box it was authored for,
  // large enough to cover the frame on both axes; drawImage then stretches that to the frame.
  let scale = Math.max(request.pixelWidth / intrinsic.width, request.pixelHeight / intrinsic.height);
  scale = Math.min(scale, MAX_RENDER_SIDE / Math.max(intrinsic.width, intrinsic.height));
  const renderWidth = Math.max(1, Math.round(intrinsic.width * scale));
  const renderHeight = Math.max(1, Math.round(intrinsic.height * scale));
  if (!root.hasAttribute("viewBox")) root.setAttribute("viewBox", `0 0 ${intrinsic.width} ${intrinsic.height}`);
  root.setAttribute("width", String(renderWidth));
  root.setAttribute("height", String(renderHeight));
  return environment.serialize(root);
}

function decode(image: SvgRasterImage, url: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the SVG took too long to decode")), timeoutMs);
    image.onload = () => { clearTimeout(timer); resolve(); };
    image.onerror = () => { clearTimeout(timer); reject(new Error("the SVG could not be decoded")); };
    image.src = url;
  });
}
