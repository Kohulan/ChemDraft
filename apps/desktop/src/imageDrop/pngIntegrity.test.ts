// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { DAMAGED_PNG_IMAGE_DATA, PNG_SURPLUS_IMAGE_DATA_BYTES, pngImageDataError } from "./pngIntegrity";
import { bytesToBase64, prepareDroppedImage } from "./prepareDroppedImage";
import type { DecodeCheck, DroppedImageDecoders } from "./rasterDecode";
import { damagedDropFixture, testPng, writeTestPng, type TestPngChunk, type TestPngOptions } from "./pngTestImages";
import { zlibOfZeros } from "./zlibTestStreams";

const DAMAGED = "the PNG could not be decoded: its image data is damaged.";
const NS = 'xmlns="http://www.w3.org/2000/svg"';

/** Like WebKit's: every PNG decodes, whatever its image data. */
const acceptsEverything: DecodeCheck = async () => ({ width: 4, height: 4 });
const decoders: DroppedImageDecoders = {
  decodeCheck: acceptsEverything,
  rasterToPng: async () => { throw new Error("not used"); }
};

const prepare = (bytes: Uint8Array, name = "picture.png") => prepareDroppedImage(name, bytes, decoders);

async function expectKept(label: string, bytes: Uint8Array) {
  expect(await prepare(bytes), label).toEqual({
    ok: true, image: { name: "picture.png", mimeType: "image/png", dataBase64: bytesToBase64(bytes), notes: [] }
  });
}

async function expectRefused(label: string, bytes: Uint8Array) {
  expect(await prepare(bytes), label).toEqual({ ok: false, reason: DAMAGED });
}

const withChunks = (options: TestPngOptions, change: (chunks: TestPngChunk[]) => TestPngChunk[]) => testPng({ ...options, chunks: change });
const swapLastAdler = (stream: Uint8Array) => {
  const copy = stream.slice();
  copy[copy.length - 1] ^= 0x01;
  return copy;
};

/**
 * An RGBA picture whose image data is all zeros (filter 0, black transparent pixels), with `extra`
 * zero bytes more: built from a hand-made stream, so a large one costs nothing to make.
 */
function zeroPng(width: number, height: number, extra = 0): Uint8Array {
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const stream = zlibOfZeros((1 + width * 4) * height + extra);
  return writeTestPng([{ type: "IHDR", data: header }, { type: "IDAT", data: stream }, { type: "IEND", data: new Uint8Array() }]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the dropped PNGs from the hands-on pass", () => {
  it("refuses image data that cannot be inflated and image data that inflates to the wrong bytes", async () => {
    // Their chunk framing and CRCs are good, and the webview decodes both.
    await expectRefused("r8-damaged.png", damagedDropFixture("r8-damaged.png"));
    await expectRefused("r9-midcorrupt.png", damagedDropFixture("r9-midcorrupt.png"));
  });

  it("refuses an SVG that embeds either one, naming the embedded PNG", async () => {
    for (const name of ["r8-damaged.png", "r9-midcorrupt.png"] as const) {
      const href = `data:image/png;base64,${bytesToBase64(damagedDropFixture(name))}`;
      const svg = new TextEncoder().encode(`<svg ${NS} width="200" height="200"><image href="${href}" width="100" height="80"/></svg>`);
      expect(await prepareDroppedImage("wrap.svg", svg, decoders), name)
        .toEqual({ ok: false, reason: "an embedded PNG picture could not be decoded: its image data is damaged." });
    }
    const good = `data:image/png;base64,${bytesToBase64(testPng({ width: 5, height: 4 }))}`;
    const svg = new TextEncoder().encode(`<svg ${NS} width="20" height="20"><image href="${good}" width="5" height="4"/></svg>`);
    expect((await prepareDroppedImage("good.svg", svg, decoders)).ok).toBe(true);
  });
});

describe("pngImageDataError accepts every valid PNG, byte for byte", () => {
  it("accepts each colour type at each bit depth it allows", async () => {
    const kinds: Array<[number, number[]]> = [[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]];
    for (const [colourType, depths] of kinds) {
      for (const bitDepth of depths) {
        // Odd widths leave sub-byte rows to round up.
        await expectKept(`type ${colourType} depth ${bitDepth}`, testPng({ width: 13, height: 7, colourType, bitDepth }));
      }
    }
  });

  it("accepts Adam7, including pictures too small to fill every pass", async () => {
    for (const [width, height] of [[1, 1], [3, 5], [8, 8], [9, 1], [1, 9], [37, 23]]) {
      for (const [colourType, bitDepth] of [[0, 1], [3, 4], [2, 8], [6, 16]]) {
        await expectKept(`${width} × ${height} type ${colourType} depth ${bitDepth}`,
          testPng({ width, height, colourType, bitDepth, interlace: true }));
      }
    }
  });

  it("accepts image data split over many IDAT chunks, empty ones among them", async () => {
    await expectKept("one-byte chunks", testPng({ width: 20, height: 20, idatSizes: Array(300).fill(1) }));
    await expectKept("an empty IDAT first and in the middle", testPng({ width: 20, height: 20, idatSizes: [0, 10, 0, 0, 7] }));
    await expectKept("an empty IDAT last", withChunks({ width: 20, height: 20 }, chunks =>
      chunks.flatMap(chunk => chunk.type === "IEND" ? [{ type: "IDAT", data: new Uint8Array() }, chunk] : [chunk])));
  });

  it("accepts an Adler-32 that an IDAT boundary splits", async () => {
    for (const keep of [1, 2, 3]) {
      const stream = testPngStream(testPng({ width: 30, height: 9 }));
      await expectKept(`last IDAT holds ${keep}`, testPng({ width: 30, height: 9, idatSizes: [stream.length - keep] }));
    }
  });

  it("ignores a bad CRC on an ancillary chunk, and anything after IEND", async () => {
    await expectKept("ancillary CRC", withChunks({ width: 6, height: 6 }, chunks => [chunks[0],
      { type: "tEXt", data: new TextEncoder().encode("Comment\0hello"), crc: 0x12345678 }, ...chunks.slice(1)]));
    await expectKept("trailing bytes", testPng({ width: 6, height: 6, trailing: new Uint8Array([1, 2, 3, 0, 0, 0, 0]) }));
  });

  it("ignores bytes after the zlib stream, in its last IDAT or in an IDAT of their own", async () => {
    // libpng and the webviews read no further than the stream's end.
    for (const padding of [[0], [0, 0, 0, 0], [0xff, 0x13, 0x37, 0, 1, 2, 3, 4, 5]]) {
      await expectKept(`${padding.length} bytes in the last IDAT`,
        testPng({ width: 20, height: 9, zlib: stream => concat(stream, Uint8Array.from(padding)) }));
      await expectKept(`${padding.length} bytes in an IDAT after it`, withChunks({ width: 20, height: 9 }, chunks =>
        chunks.flatMap(chunk => chunk.type === "IEND" ? [{ type: "IDAT", data: Uint8Array.from(padding) }, chunk] : [chunk])));
    }
    // The Adler-32 is where the stream ends, not the last four bytes of the image data.
    await expectRefused("wrong Adler-32 before padding",
      testPng({ width: 20, height: 9, zlib: stream => concat(swapLastAdler(stream), Uint8Array.of(0, 0, 0, 0)) }));
  });

  it("tolerates up to 64 KiB of surplus image data and no more", async () => {
    const surplus = (extra: number) => testPng({ width: 10, height: 10, imageData: data => concat(data, new Uint8Array(extra)) });
    await expectKept("1000 bytes", surplus(1000));
    await expectKept("64 KiB", surplus(PNG_SURPLUS_IMAGE_DATA_BYTES));
    await expectRefused("64 KiB and one", surplus(PNG_SURPLUS_IMAGE_DATA_BYTES + 1));
  });
});

describe("pngImageDataError refuses damaged image data", () => {
  it("refuses short, truncated and corrupted image data", async () => {
    await expectRefused("a row short", testPng({ width: 10, height: 10, imageData: data => data.subarray(0, data.length - 11) }));
    await expectRefused("a byte short", testPng({ width: 10, height: 10, imageData: data => data.subarray(0, data.length - 1) }));
    await expectRefused("a byte short, interlaced", testPng({ width: 10, height: 10, interlace: true, imageData: data => data.subarray(0, data.length - 1) }));
    await expectRefused("truncated stream", testPng({ width: 40, height: 40, zlib: stream => stream.subarray(0, stream.length - 9) }));
    await expectRefused("wrong Adler-32", testPng({ width: 40, height: 40, zlib: swapLastAdler }));
    // The framing check before this one already refuses a PNG with no IDAT at all.
    expect(await pngImageDataError(withChunks({ width: 4, height: 4 }, chunks => chunks.filter(chunk => chunk.type !== "IDAT"))))
      .toBe(DAMAGED_PNG_IMAGE_DATA);
  });

  it("refuses a filter byte above 4 at any row start, pass by pass", async () => {
    const badFilter = (row: number, options: Partial<TestPngOptions> = {}) => testPng({
      width: 300, height: 300, colourType: 6, ...options,
      imageData: (data, rowStarts) => { const copy = data.slice(); copy[rowStarts.at(row)!] = 5; return copy; }
    });
    for (const row of [0, 1, 150, -1]) await expectRefused(`row ${row}`, badFilter(row));
    // The first row of the last Adam7 pass, and the very last row.
    for (const row of [-150, -1]) await expectRefused(`interlaced row ${row}`, badFilter(row, { interlace: true }));
    // A byte above 4 inside a row is only a pixel.
    await expectKept("pixel bytes", testPng({ width: 300, height: 20, colourType: 6,
      imageData: data => data.map((byte, index) => index % 1201 === 0 ? byte : 0xff) }));
  });

  it("refuses a bad CRC on IHDR, PLTE, IDAT or IEND", async () => {
    for (const type of ["IHDR", "PLTE", "IDAT", "IEND"]) {
      await expectRefused(`${type} CRC`, withChunks({ width: 4, height: 4, colourType: 3 }, chunks =>
        chunks.map(chunk => chunk.type === type ? { ...chunk, crc: 0 } : chunk)));
    }
  });

  it("refuses a missing palette, invalid header values and IDAT chunks that are not consecutive", async () => {
    await expectRefused("no PLTE", withChunks({ width: 4, height: 4, colourType: 3 }, chunks => chunks.filter(chunk => chunk.type !== "PLTE")));
    const header = (index: number, value: number) => withChunks({ width: 4, height: 4 }, chunks => chunks.map(chunk => {
      if (chunk.type !== "IHDR") return chunk;
      const data = chunk.data.slice();
      data[index] = value;
      return { ...chunk, data };
    }));
    await expectRefused("RGB at depth 4", header(8, 4));
    await expectRefused("depth 3", header(8, 3));
    await expectRefused("colour type 5", header(9, 5));
    await expectRefused("compression method 1", header(10, 1));
    await expectRefused("filter method 1", header(11, 1));
    await expectRefused("interlace method 2", header(12, 2));
    await expectRefused("split IDAT", withChunks({ width: 20, height: 20, idatSizes: [10] }, chunks =>
      [chunks[0], chunks[1], { type: "tEXt", data: new TextEncoder().encode("a\0b") }, ...chunks.slice(2)]));
  });

  it("stops inflating far too much image data rather than reading it all", async () => {
    // 2 GiB of zeros behind a 10 × 10 picture: inflating it all would take seconds.
    const png = zeroPng(10, 10, 2 * 1024 * 1024 * 1024);
    const started = performance.now();
    expect(await pngImageDataError(png)).toBe(DAMAGED_PNG_IMAGE_DATA);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(await pngImageDataError(zeroPng(10, 10, PNG_SURPLUS_IMAGE_DATA_BYTES))).toBeUndefined();
  });
});

describe("pngImageDataError keeps the window responsive and honours the file's deadline", () => {
  it("lets a timer run during a large check, and makes a small one wait for none", async () => {
    const large = zeroPng(3000, 3000);
    let fired = false;
    setTimeout(() => { fired = true; }, 0);
    expect(await pngImageDataError(large)).toBeUndefined();
    expect(fired).toBe(true);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    expect(await pngImageDataError(testPng({ width: 64, height: 64, colourType: 6 }))).toBeUndefined();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it("rejects with the abort reason when the deadline passes mid-check", async () => {
    const controller = new AbortController();
    const reason = new Error("reading it took longer than 30 seconds.");
    const png = zeroPng(8000, 4000);
    setTimeout(() => controller.abort(reason), 5);
    await expect(pngImageDataError(png, { signal: controller.signal })).rejects.toBe(reason);
    await expect(pngImageDataError(png, { signal: controller.signal })).rejects.toBe(reason);
  });

  it("refuses through prepareDroppedImage with the deadline wording", async () => {
    const controller = new AbortController();
    const reason = new Error("reading it took longer than 30 seconds.");
    controller.abort(reason);
    await expect(prepareDroppedImage("late.png", testPng({ width: 4, height: 4 }), decoders, { signal: controller.signal })).rejects.toBe(reason);
  });

  it("needs nothing from the webview: the same verdicts where it has no DecompressionStream (macOS 11)", async () => {
    vi.stubGlobal("DecompressionStream", undefined);
    await expectKept("good", testPng({ width: 13, height: 7, colourType: 6, interlace: true }));
    await expectRefused("r8-damaged.png", damagedDropFixture("r8-damaged.png"));
    await expectRefused("r9-midcorrupt.png", damagedDropFixture("r9-midcorrupt.png"));
  });
});

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const out = new Uint8Array(first.length + second.length);
  out.set(first);
  out.set(second, first.length);
  return out;
}

/** The zlib stream of a PNG with a single IDAT. */
function testPngStream(png: Uint8Array): Uint8Array {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let offset = 8; offset < png.length;) {
    const length = view.getUint32(offset);
    if (String.fromCharCode(...png.subarray(offset + 4, offset + 8)) === "IDAT") return png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
  }
  throw new Error("no IDAT");
}
