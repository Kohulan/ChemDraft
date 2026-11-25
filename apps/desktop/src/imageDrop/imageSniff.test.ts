import { describe, expect, it } from "vitest";
import {
  readGifHeaderSize, readJpegHeaderSize, readWebpHeaderSize, sniffBinaryImageFormat
} from "./imageSniff";
import { gifHeader, jpegHeader, pngBytes, webpVp8Header, webpVp8lHeader, webpVp8xHeader } from "./testFixtures";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("sniffBinaryImageFormat", () => {
  it("recognises every supported and refused signature", () => {
    expect(sniffBinaryImageFormat(pngBytes())).toBe("png");
    expect(sniffBinaryImageFormat(jpegHeader(2, 2))).toBe("jpeg");
    expect(sniffBinaryImageFormat(gifHeader(2, 2))).toBe("gif");
    expect(sniffBinaryImageFormat(text("GIF87a\u0001\u0000\u0001\u0000"))).toBe("gif");
    expect(sniffBinaryImageFormat(webpVp8Header(2, 2))).toBe("webp");
    expect(sniffBinaryImageFormat(new Uint8Array([...text("BM"), ...new Array(30).fill(0)]))).toBe("bmp");
    expect(sniffBinaryImageFormat(bytes(0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0))).toBe("tiff");
    expect(sniffBinaryImageFormat(bytes(0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8))).toBe("tiff");
    expect(sniffBinaryImageFormat(bytes(0, 0, 1, 0, 1, 0))).toBe("ico");
    expect(sniffBinaryImageFormat(text("%PDF-1.7\n"))).toBe("pdf");
    expect(sniffBinaryImageFormat(bytes(0x1f, 0x8b, 8, 0))).toBe("svgz");
    expect(sniffBinaryImageFormat(new Uint8Array([0, 0, 0, 0x18, ...text("ftypheic")]))).toBe("heic");
    expect(sniffBinaryImageFormat(new Uint8Array([0, 0, 0, 0x18, ...text("ftypavif")]))).toBe("avif");
  });

  it("leaves text, empty and near-miss bytes unrecognised", () => {
    expect(sniffBinaryImageFormat(text("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
    expect(sniffBinaryImageFormat(new Uint8Array())).toBeUndefined();
    expect(sniffBinaryImageFormat(bytes(0x89, 0x50, 0x4e, 0x47))).toBeUndefined();
    expect(sniffBinaryImageFormat(text("RIFF\u0000\u0000\u0000\u0000WAVE"))).toBeUndefined();
    expect(sniffBinaryImageFormat(text("BM"))).toBeUndefined();
  });
});

describe("JPEG header size", () => {
  it("reads baseline, progressive and fill-padded frame headers", () => {
    expect(readJpegHeaderSize(jpegHeader(640, 480))).toEqual({ width: 640, height: 480 });
    expect(readJpegHeaderSize(jpegHeader(3, 70000 & 0xffff, { sofMarker: 0xc2 }))).toEqual({ width: 3, height: 70000 & 0xffff });
    expect(readJpegHeaderSize(jpegHeader(65535, 65535, { fill: true }))).toEqual({ width: 65535, height: 65535 });
  });

  it("refuses truncated, scan-first, zero-height and hostile lengths", () => {
    const header = jpegHeader(10, 10);
    expect(readJpegHeaderSize(header.subarray(0, 25))).toBeUndefined();
    expect(readJpegHeaderSize(bytes(0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0))).toBeUndefined();
    expect(readJpegHeaderSize(jpegHeader(10, 0))).toBeUndefined();
    // A segment length past the end of the buffer.
    expect(readJpegHeaderSize(bytes(0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0, 0))).toBeUndefined();
    // A length below its own two bytes would loop forever if trusted.
    expect(readJpegHeaderSize(bytes(0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01, 0xff, 0xc0))).toBeUndefined();
    expect(readJpegHeaderSize(bytes(0xff, 0xd8, 0x00, 0x00, 0x00))).toBeUndefined();
    expect(readJpegHeaderSize(pngBytes())).toBeUndefined();
  });
});

describe("GIF header size", () => {
  it("reads the logical screen, widened by a frame that reaches past it", () => {
    expect(readGifHeaderSize(gifHeader(12, 7))).toEqual({ width: 12, height: 7 });
    expect(readGifHeaderSize(gifHeader(10, 10, { left: 5, top: 0, width: 60000, height: 9 }))).toEqual({ width: 60005, height: 10 });
  });

  it("refuses truncated and malformed blocks", () => {
    const gif = gifHeader(10, 10);
    expect(readGifHeaderSize(gif.subarray(0, 12))).toBeUndefined();
    expect(readGifHeaderSize(gif.subarray(0, 24))).toBeUndefined();
    const broken = gif.slice();
    broken[19] = 0x99;
    expect(readGifHeaderSize(broken)).toBeUndefined();
    expect(readGifHeaderSize(text("GIF89a\u0000\u0000\u0000\u0000\u0000\u0000\u0000"))).toBeUndefined();
  });
});

describe("WebP header size", () => {
  it("reads VP8, VP8L and VP8X headers", () => {
    expect(readWebpHeaderSize(webpVp8Header(300, 200))).toEqual({ width: 300, height: 200 });
    expect(readWebpHeaderSize(webpVp8lHeader(16384, 1))).toEqual({ width: 16384, height: 1 });
    expect(readWebpHeaderSize(webpVp8xHeader(16_777_216, 3))).toEqual({ width: 16_777_216, height: 3 });
  });

  it("refuses truncated headers and bad signatures", () => {
    expect(readWebpHeaderSize(webpVp8Header(300, 200).subarray(0, 28))).toBeUndefined();
    const badStart = webpVp8Header(300, 200);
    badStart[23] = 0;
    expect(readWebpHeaderSize(badStart)).toBeUndefined();
    const badLossless = webpVp8lHeader(4, 4);
    badLossless[20] = 0;
    expect(readWebpHeaderSize(badLossless)).toBeUndefined();
    expect(readWebpHeaderSize(webpVp8xHeader(4, 4).subarray(0, 29))).toBeUndefined();
    expect(readWebpHeaderSize(webpVp8Header(0, 5))).toBeUndefined();
  });
});
