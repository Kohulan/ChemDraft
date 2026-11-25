/**
 * Prove a PNG's image data is intact before it becomes a picture. Engines draw a damaged PNG rather
 * than refuse it: WebKit's `createImageBitmap` and `Image.decode` both resolve for image data that
 * cannot be inflated (the picture is invisible) and for data that inflates to the wrong bytes (half of
 * it is black), so the webview decoder proves nothing here. This walks the chunks, checks the critical
 * CRCs and header values, then inflates the image data once, without keeping it, to check its size,
 * every row's filter byte and the zlib Adler-32 (computed here, because engines differ on whether
 * their inflater checks it). Pixels are never reconstructed.
 */

import { crc32 } from "../crc32";
import { abortReason, untilAborted } from "./rasterDecode";

/** The clause after "could not be decoded: ". */
export const DAMAGED_PNG_IMAGE_DATA = "its image data is damaged.";

/** Some encoders write a little more image data than the picture uses; decoders ignore it. */
export const PNG_SURPLUS_IMAGE_DATA_BYTES = 64 * 1024;

/** An inflater for a zlib stream: `DecompressionStream("deflate")` in the webview. */
export type PngInflateStream = () => ReadableWritablePair<Uint8Array, BufferSource>;

export interface PngIntegrityOptions {
  signal?: AbortSignal;
  /**
   * Defaults to the webview's `DecompressionStream`. `null`, or a webview without one, skips the
   * inflate step: the chunks and header are still checked, and a good picture is never refused
   * for the missing stream.
   */
  inflate?: PngInflateStream | null;
}

export function webviewPngInflateStream(): PngInflateStream | null {
  return typeof DecompressionStream === "function" ? () => new DecompressionStream("deflate") : null;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Bit depths each colour type allows. */
const BIT_DEPTHS: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/** Adam7: x start, y start, x step, y step. */
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;
const ADLER_MOD = 65521;
/** The most bytes that can be summed before the Adler-32 `b` sum must be reduced (zlib's NMAX). */
const ADLER_BLOCK = 5552;

const TYPE_IHDR = 0x49484452;
const TYPE_PLTE = 0x504c5445;
const TYPE_IDAT = 0x49444154;
const TYPE_IEND = 0x49454e44;

interface PngLayout {
  /** The image data, one view per non-empty IDAT chunk, in order. */
  data: Uint8Array[];
  /** Rows as the decoder reads them: a row count and a stride (filter byte included) per pass. */
  passes: { rows: number; stride: number }[];
  expectedSize: number;
}

/** Rows of `width` pixels: a filter byte, then the pixels packed into whole bytes. */
function rowStride(width: number, bitsPerPixel: number): number {
  return 1 + Math.ceil(width * bitsPerPixel / 8);
}

/** The chunks, critical CRCs and header; undefined when any of them is damaged. */
function readPngLayout(bytes: Uint8Array): PngLayout | undefined {
  if (bytes.length < 8 || !SIGNATURE.every((value, index) => bytes[index] === value)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data: Uint8Array[] = [];
  let header: { width: number; height: number; colourType: number; bitDepth: number; interlaced: boolean } | undefined;
  let palette = false;
  let inData = false;
  let afterData = false;
  for (let offset = 8; ;) {
    if (offset + 12 > bytes.length) return undefined;
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) return undefined;
    const type = view.getUint32(offset + 4);
    const body = offset + 8;
    const end = body + length;
    // Decoders ignore a bad CRC on an ancillary chunk, so only the critical ones are checked.
    const critical = type === TYPE_IHDR || type === TYPE_PLTE || type === TYPE_IDAT || type === TYPE_IEND;
    if (critical && crc32(bytes.subarray(offset + 4, end)) !== view.getUint32(end)) return undefined;
    if ((offset === 8) !== (type === TYPE_IHDR)) return undefined;
    if (type !== TYPE_IDAT && inData) { inData = false; afterData = true; }
    if (type === TYPE_IHDR) {
      if (length !== 13) return undefined;
      const width = view.getUint32(body);
      const height = view.getUint32(body + 4);
      const bitDepth = bytes[body + 8];
      const colourType = bytes[body + 9];
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) return undefined;
      if (!BIT_DEPTHS[colourType]?.includes(bitDepth)) return undefined;
      // Compression and filter method 0; interlace none or Adam7.
      if (bytes[body + 10] !== 0 || bytes[body + 11] !== 0 || bytes[body + 12] > 1) return undefined;
      header = { width, height, colourType, bitDepth, interlaced: bytes[body + 12] === 1 };
    } else if (type === TYPE_PLTE) {
      if (palette || inData || afterData) return undefined;
      if (header?.colourType === 3 && (length === 0 || length % 3 !== 0 || length > 3 * 256)) return undefined;
      palette = true;
    } else if (type === TYPE_IDAT) {
      if (afterData) return undefined;
      inData = true;
      if (length) data.push(bytes.subarray(body, end));
    } else if (type === TYPE_IEND) {
      // Whatever follows IEND is not part of the picture.
      break;
    }
    offset = end + 4;
  }
  if (!header || !data.length || (header.colourType === 3 && !palette)) return undefined;
  const bitsPerPixel = CHANNELS[header.colourType] * header.bitDepth;
  const passes = header.interlaced
    ? ADAM7.map(([x, y, stepX, stepY]) => ({ columns: Math.ceil((header.width - x) / stepX), rows: Math.ceil((header.height - y) / stepY) }))
      // A pass with no pixels has no rows at all, not even filter bytes.
      .filter(pass => pass.columns > 0 && pass.rows > 0)
      .map(pass => ({ rows: pass.rows, stride: rowStride(pass.columns, bitsPerPixel) }))
    : [{ rows: header.height, stride: rowStride(header.width, bitsPerPixel) }];
  return { data, passes, expectedSize: passes.reduce((total, pass) => total + pass.rows * pass.stride, 0) };
}

/** The zlib stream's own Adler-32: its last four bytes, which an IDAT boundary may split. */
function storedAdler(data: Uint8Array[]): number | undefined {
  let value = 0;
  let found = 0;
  for (let part = data.length - 1; part >= 0 && found < 4; part -= 1) {
    const chunk = data[part];
    for (let index = chunk.length - 1; index >= 0 && found < 4; index -= 1, found += 1) {
      value += chunk[index] * 2 ** (8 * found);
    }
  }
  return found === 4 ? value : undefined;
}

/**
 * Feed the IDAT views to the inflater one at a time and read its output as it comes, never joining
 * the input or keeping the output. False when the output is short, far too long, has a filter byte
 * other than 0-4 at a row start, or does not match the stored Adler-32.
 */
async function imageDataInflates(layout: PngLayout, inflate: PngInflateStream, signal: AbortSignal | undefined): Promise<boolean> {
  const expectedAdler = storedAdler(layout.data);
  if (expectedAdler === undefined) return false;
  const limit = layout.expectedSize + PNG_SURPLUS_IMAGE_DATA_BYTES;
  let next = 0;
  const source = new ReadableStream<BufferSource>({
    pull(controller) {
      if (next < layout.data.length) controller.enqueue(layout.data[next++] as Uint8Array<ArrayBuffer>);
      else controller.close();
    }
  }, { highWaterMark: 0 });
  const reader = source.pipeThrough(inflate()).getReader();
  let size = 0;
  let a = 1;
  let b = 0;
  let pass = 0;
  let rowsLeft = layout.passes[0]?.rows ?? 0;
  /** Where the next row's filter byte is, in the whole output. */
  let rowStart = 0;
  let finished = false;
  try {
    for (;;) {
      if (signal?.aborted) throw abortReason(signal);
      const { value, done } = await untilAborted(reader.read(), signal);
      if (done) {
        finished = true;
        return size >= layout.expectedSize && ((b << 16) | a) >>> 0 === expectedAdler;
      }
      if (value.length > limit - size) return false;
      const chunkEnd = size + value.length;
      while (pass < layout.passes.length && rowStart < chunkEnd) {
        if (value[rowStart - size] > 4) return false;
        rowStart += layout.passes[pass].stride;
        if (--rowsLeft === 0) {
          pass += 1;
          rowsLeft = layout.passes[pass]?.rows ?? 0;
        }
      }
      // Adler-32 in blocks short enough that neither sum overflows before it is reduced.
      for (let index = 0; index < value.length;) {
        const blockEnd = Math.min(value.length, index + ADLER_BLOCK);
        for (; index < blockEnd; index += 1) {
          a += value[index];
          b += a;
        }
        a %= ADLER_MOD;
        b %= ADLER_MOD;
      }
      size = chunkEnd;
    }
  } catch {
    if (signal?.aborted) throw abortReason(signal);
    // The inflater refused the stream: bad block type, bad distance, bad header, truncated, ...
    finished = true;
    return false;
  } finally {
    // Stop inflating what is left; the source and the inflater are cancelled with the reader.
    if (!finished) reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // An engine that will not release a reader with a read still pending: cancelled above.
    }
  }
}

/**
 * Why the PNG's image data cannot be drawn as it stands (the clause after "could not be decoded: "),
 * or undefined when it is intact. Rejects only when `options.signal` aborts, with its reason.
 */
export async function pngImageDataError(bytes: Uint8Array, options: PngIntegrityOptions = {}): Promise<string | undefined> {
  const { signal } = options;
  if (signal?.aborted) throw abortReason(signal);
  const layout = readPngLayout(bytes);
  if (!layout) return DAMAGED_PNG_IMAGE_DATA;
  const inflate = options.inflate === undefined ? webviewPngInflateStream() : options.inflate;
  if (!inflate) return undefined;
  return await imageDataInflates(layout, inflate, signal) ? undefined : DAMAGED_PNG_IMAGE_DATA;
}
