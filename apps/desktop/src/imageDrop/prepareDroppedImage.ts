import {
  MAX_IMAGE_DECODED_BYTES, MAX_IMAGE_OBJECT_BYTES, MAX_IMAGE_SIDE, isSvgImageSource, readPngInfo,
  validatePngImage, validateSvgImage, type ImageObjectData
} from "@chemdraft/chem-core";
import { formatDropBytes, rewordPictureError } from "./dropFiles";
import { readRasterHeaderSize, sniffBinaryImageFormat, type SniffedImageFormat } from "./imageSniff";
import type { RasterToPng } from "./rasterDecode";
import { decodeSvgBytes, encodeSvgText } from "./svgText";
import { sanitizeDroppedSvg } from "./svgSanitizer";

/** A picture ready to become a native image object; built at commit time, not here. */
export interface PreparedDroppedImage {
  name: string;
  mimeType: ImageObjectData["mimeType"];
  dataBase64: string;
  /** Natural drawn size in page units when it differs from what the stored pixels give (downscaled). */
  naturalSize?: { width: number; height: number };
  /** Short status notes, e.g. "scaled down to 4000 × 3000 pixels". */
  notes: string[];
}

export type PrepareDroppedImageResult =
  | { ok: true; image: PreparedDroppedImage }
  | { ok: false; reason: string };

const REFUSED_CONTENT: Partial<Record<SniffedImageFormat, string>> = {
  bmp: "BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first.",
  tiff: "BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first.",
  ico: "icon files can't be dropped as pictures; save it as PNG first.",
  heic: "HEIC/HEIF pictures can't be dropped yet; save it as PNG or JPEG first.",
  avif: "AVIF pictures can't be dropped yet; save it as PNG or JPEG first.",
  pdf: "PDF files can't be placed as pictures; export the page as PNG or SVG first.",
  svgz: "compressed SVG (.svgz) can't be dropped; save it as plain SVG first."
};

const RASTER_MIME = { jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as const;
const FORMAT_LABEL = { jpeg: "JPEG", gif: "GIF", webp: "WebP" } as const;

export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

/** The paste caps, worded for a drop. */
export function dropPixelLimitError(width: number, height: number): string | undefined {
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
    return `it is ${width} × ${height} pixels; the limit is ${MAX_IMAGE_SIDE} pixels on a side.`;
  }
  if (width * height * 4 > MAX_IMAGE_DECODED_BYTES) {
    return `it is ${width} × ${height} pixels; the decoded limit is ${MAX_IMAGE_DECODED_BYTES / (1024 * 1024)} MiB.`;
  }
  return undefined;
}

function payloadSizeError(bytes: number): string | undefined {
  return bytes > MAX_IMAGE_OBJECT_BYTES
    ? `it is ${formatDropBytes(bytes)} as stored; the picture limit is ${formatDropBytes(MAX_IMAGE_OBJECT_BYTES)}.`
    : undefined;
}

/**
 * Recognise a dropped picture by its bytes and turn it into PNG or sanitized SVG. PNG is kept byte
 * for byte. Every refusal is a reason without the file name; the caller names the file.
 */
export async function prepareDroppedImage(
  name: string,
  bytes: Uint8Array,
  rasterToPng: RasterToPng
): Promise<PrepareDroppedImageResult> {
  const format = sniffBinaryImageFormat(bytes);
  const refused = format && REFUSED_CONTENT[format];
  if (refused) return { ok: false, reason: refused };

  if (format === "png") {
    const info = readPngInfo(bytes);
    const limit = info && dropPixelLimitError(info.pixelWidth, info.pixelHeight);
    if (limit) return { ok: false, reason: limit };
    const result = validatePngImage(bytes);
    if (result.error) return { ok: false, reason: rewordPictureError(result.error) };
    const sizeError = payloadSizeError(bytes.length);
    if (sizeError) return { ok: false, reason: sizeError };
    return { ok: true, image: { name, mimeType: "image/png", dataBase64: bytesToBase64(bytes), notes: [] } };
  }

  if (format === "jpeg" || format === "gif" || format === "webp") {
    const header = readRasterHeaderSize(format, bytes);
    if (!header) return { ok: false, reason: `the ${FORMAT_LABEL[format]} header is damaged or truncated, so its size can't be read.` };
    const limit = dropPixelLimitError(header.width, header.height);
    if (limit) return { ok: false, reason: limit };
    let encoded;
    try {
      encoded = await rasterToPng(bytes, RASTER_MIME[format], MAX_IMAGE_OBJECT_BYTES);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `the ${FORMAT_LABEL[format]} could not be converted: ${message}` };
    }
    const decodedLimit = dropPixelLimitError(encoded.sourceWidth, encoded.sourceHeight);
    if (decodedLimit) return { ok: false, reason: decodedLimit };
    const result = validatePngImage(encoded.png);
    if (result.error) return { ok: false, reason: `the converted picture is invalid: ${rewordPictureError(result.error)}` };
    const notes: string[] = [];
    let naturalSize: PreparedDroppedImage["naturalSize"];
    if (encoded.downscaled) {
      // Fewer stored pixels, same drawn size: one page unit per original pixel (the 96 dpi default).
      naturalSize = { width: encoded.sourceWidth, height: encoded.sourceHeight };
      notes.push(`stored at ${encoded.width} × ${encoded.height} pixels (from ${encoded.sourceWidth} × ${encoded.sourceHeight}) to fit the ${formatDropBytes(MAX_IMAGE_OBJECT_BYTES)} picture limit`);
    }
    return {
      ok: true,
      image: { name, mimeType: "image/png", dataBase64: bytesToBase64(encoded.png), ...(naturalSize ? { naturalSize } : {}), notes }
    };
  }

  const decoded = decodeSvgBytes(bytes);
  if ("error" in decoded) return { ok: false, reason: decoded.error };
  if (!isSvgImageSource(decoded.text)) {
    return { ok: false, reason: "its contents are not a PNG, JPEG, GIF, WebP or SVG picture." };
  }
  const sanitized = sanitizeDroppedSvg(decoded.text);
  if (!sanitized.ok) return { ok: false, reason: sanitized.error };
  const validated = validateSvgImage(sanitized.svg);
  if (validated.error) return { ok: false, reason: rewordPictureError(validated.error) };
  const svgBytes = encodeSvgText(sanitized.svg);
  const sizeError = payloadSizeError(svgBytes.length);
  if (sizeError) return { ok: false, reason: sizeError };
  const notes = [
    ...(sanitized.removedExternal ? ["external content was removed"] : []),
    ...(sanitized.removedActive ? ["scripts and animation were removed"] : [])
  ];
  return { ok: true, image: { name, mimeType: "image/svg+xml", dataBase64: bytesToBase64(svgBytes), notes } };
}
