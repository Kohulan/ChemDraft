/** Tiny inline picture headers for the image-drop tests. Not shipped: imported only by tests. */

/** A real 1 × 1 PNG. */
export const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export function base64Bytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

export function pngBytes(): Uint8Array {
  return base64Bytes(PNG_1X1_BASE64);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/** zlib with stored (uncompressed) blocks: valid for any decoder, no compressor needed. */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 0xffff));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
  out.set([0x78, 0x01]);
  let offset = 2;
  for (let block = 0; block < blocks; block += 1) {
    const part = data.subarray(block * 0xffff, (block + 1) * 0xffff);
    out.set([block === blocks - 1 ? 1 : 0, part.length & 0xff, part.length >> 8, ~part.length & 0xff, (~part.length >> 8) & 0xff], offset);
    out.set(part, offset + 5);
    offset += 5 + part.length;
  }
  let a = 1;
  let b = 0;
  for (const byte of data) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  new DataView(out.buffer).setUint32(offset, ((b << 16) | a) >>> 0);
  return out;
}

/**
 * A real, decodable `width` × `height` grey PNG: its IHDR, CRCs and image data all agree, so the
 * header tells the truth about what a decoder would produce.
 */
export function pngWithSize(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 0, 0, 0, 0], 8);
  // One filter byte (none) and one grey byte per pixel, per row.
  const rows = new Uint8Array((width + 1) * height).fill(0x80);
  for (let row = 0; row < height; row += 1) rows[row * (width + 1)] = 0;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header),
    pngChunk("IDAT", zlibStored(rows)), pngChunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** SOI, an APP0 segment, then a baseline SOF0 frame header. */
export function jpegHeader(width: number, height: number, options: { sofMarker?: number; fill?: boolean } = {}): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [...(options.fill ? [0xff, 0xff] : []), 0xff, options.sofMarker ?? 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

export function gifHeader(width: number, height: number, frame?: { left: number; top: number; width: number; height: number }): Uint8Array {
  const u16 = (value: number) => [value & 0xff, value >> 8];
  const header = [...new TextEncoder().encode("GIF89a"), ...u16(width), ...u16(height), 0x80, 0, 0,
    // A two-entry global colour table.
    0, 0, 0, 255, 255, 255,
    // A graphic control extension before the frame.
    0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00];
  const descriptor = frame
    ? [0x2c, ...u16(frame.left), ...u16(frame.top), ...u16(frame.width), ...u16(frame.height), 0x00]
    : [0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0x00];
  return new Uint8Array([...header, ...descriptor, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]);
}

function riff(chunk: string, payload: number[]): Uint8Array {
  const text = (value: string) => [...new TextEncoder().encode(value)];
  const u32 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
  const body = [...text("WEBP"), ...text(chunk), ...u32(payload.length), ...payload];
  return new Uint8Array([...text("RIFF"), ...u32(body.length), ...body]);
}

export function webpVp8Header(width: number, height: number): Uint8Array {
  return riff("VP8 ", [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, width & 0xff, (width >> 8) & 0x3f, height & 0xff, (height >> 8) & 0x3f, 0, 0]);
}

export function webpVp8lHeader(width: number, height: number): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return riff("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0, 0]);
}

export function webpVp8xHeader(width: number, height: number): Uint8Array {
  const u24 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
  return riff("VP8X", [0x10, 0, 0, 0, ...u24(width - 1), ...u24(height - 1)]);
}

export function svgBytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}
