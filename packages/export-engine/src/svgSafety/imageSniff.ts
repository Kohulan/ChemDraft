/**
 * Picture format and pixel size from the file's own bytes, read before anything is decoded so a
 * decompression bomb is refused by its header. Parsers are bounded by the buffer and never trust a
 * length field past it.
 */

export type SniffedImageFormat =
  | "png" | "jpeg" | "gif" | "webp" | "svg"
  | "bmp" | "tiff" | "ico" | "heic" | "avif" | "pdf" | "svgz";

export interface HeaderPixelSize {
  width: number;
  height: number;
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0) =>
  bytes.length >= offset + prefix.length && prefix.every((value, index) => bytes[offset + index] === value);
const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  offset + length <= bytes.length ? String.fromCharCode(...bytes.subarray(offset, offset + length)) : "";

/** Binary signatures only; SVG text is recognised by `isSvgImageSource` once decoded. */
export function sniffBinaryImageFormat(bytes: Uint8Array): SniffedImageFormat | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (ascii(bytes, 0, 2) === "BM" && bytes.length >= 26) return "bmp";
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) || startsWith(bytes, [0x00, 0x00, 0x02, 0x00])) return "ico";
  if (ascii(bytes, 0, 5) === "%PDF-") return "pdf";
  if (startsWith(bytes, [0x1f, 0x8b])) return "svgz";
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
  }
  return undefined;
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** The first start-of-frame segment; a scan before any frame header means no size can be known. */
export function readJpegHeaderSize(bytes: Uint8Array): HeaderPixelSize | undefined {
  if (!startsWith(bytes, [0xff, 0xd8])) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    // Fill bytes may pad any marker.
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (offset + 2 > bytes.length) return undefined;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) return undefined;
    if (JPEG_SOF.has(marker)) {
      if (length < 7) return undefined;
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      // Height 0 defers to a DNL marker after the scan: refuse rather than guess.
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += length;
  }
  return undefined;
}

/**
 * The logical screen, widened by the first frame when that frame reaches past it. The global colour
 * table and the first image descriptor (10 bytes) must both be present: a file that ends before them
 * has no picture to size.
 */
export function readGifHeaderSize(bytes: Uint8Array): HeaderPixelSize | undefined {
  if (bytes.length < 13 || !/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return undefined;
  const u16 = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8);
  let width = u16(6);
  let height = u16(8);
  const flags = bytes[10]!;
  let offset = 13 + ((flags & 0x80) ? 3 * (1 << ((flags & 7) + 1)) : 0);
  for (;;) {
    if (offset >= bytes.length) return undefined;
    const block = bytes[offset]!;
    if (block === 0x2c) {
      if (offset + 10 > bytes.length) return undefined;
      width = Math.max(width, u16(offset + 1) + u16(offset + 5));
      height = Math.max(height, u16(offset + 3) + u16(offset + 7));
      break;
    }
    if (block !== 0x21 || offset + 2 > bytes.length) return undefined;
    offset += 2;
    // Extension sub-blocks end with a zero-length block.
    for (;;) {
      if (offset >= bytes.length) return undefined;
      const size = bytes[offset]!;
      offset += 1 + size;
      if (size === 0) break;
    }
  }
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Simple lossy (VP8), lossless (VP8L) and extended (VP8X, canvas size) WebP headers. */
export function readWebpHeaderSize(bytes: Uint8Array): HeaderPixelSize | undefined {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return undefined;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 ") {
    if (bytes.length < 30 || !startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return undefined;
    const width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff;
    const height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (chunk === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return undefined;
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    if (bytes.length < 30) return undefined;
    const u24 = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
    return { width: u24(24) + 1, height: u24(27) + 1 };
  }
  return undefined;
}

/** The IHDR chunk, which a PNG must start with. */
export function readPngHeaderSize(bytes: Uint8Array): HeaderPixelSize | undefined {
  if (sniffBinaryImageFormat(bytes) !== "png" || bytes.length < 24) return undefined;
  if (!startsWith(bytes, [0, 0, 0, 13], 8) || ascii(bytes, 12, 4) !== "IHDR") return undefined;
  const u32 = (offset: number) => ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
  const width = u32(16);
  const height = u32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

export type RasterHeaderFormat = "png" | "jpeg" | "gif" | "webp";

export function readRasterHeaderSize(format: RasterHeaderFormat, bytes: Uint8Array): HeaderPixelSize | undefined {
  switch (format) {
    case "png": return readPngHeaderSize(bytes);
    case "jpeg": return readJpegHeaderSize(bytes);
    case "gif": return readGifHeaderSize(bytes);
    case "webp": return readWebpHeaderSize(bytes);
  }
}
