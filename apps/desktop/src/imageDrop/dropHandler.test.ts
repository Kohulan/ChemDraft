// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_OBJECT_BYTES } from "@chemdraft/chem-core";
import {
  MAX_DROPPED_IMAGES, MAX_DROPPED_IMAGE_BYTES, MAX_DROPPED_IMAGE_TOTAL_BYTES, classifyDroppedFile, rewordPictureError
} from "./dropFiles";
import {
  formatImageDropStatus, handleDroppedFiles, prepareDroppedImages, splitDrop, type DroppedImageSource
} from "./dropHandler";
import { prepareDroppedImage } from "./prepareDroppedImage";
import type { RasterToPng } from "./rasterDecode";
import { browserDroppedImageSource, nativeDroppedImageSource } from "./readDroppedFile";
import { gifHeader, jpegHeader, pngBytes, pngWithSize, svgBytes, webpVp8Header } from "./testFixtures";

const NS = 'xmlns="http://www.w3.org/2000/svg"';

/** A decoder that never runs a webview: it returns a real PNG with the requested size claimed. */
function fakeRaster(width = 1, height = 1): RasterToPng & { calls: number } {
  const fn = Object.assign(async () => {
    fn.calls += 1;
    return { png: pngBytes(), width, height, sourceWidth: width, sourceHeight: height, downscaled: false };
  }, { calls: 0 });
  return fn;
}

function memorySource(name: string, bytes: Uint8Array, size = bytes.length): DroppedImageSource & { reads: number } {
  const source = {
    name, reads: 0,
    size: async () => size,
    read: async () => { source.reads += 1; return bytes; }
  };
  return source;
}

describe("classifyDroppedFile", () => {
  it("reads pictures by extension, refuses undecodable picture types and leaves documents alone", () => {
    for (const name of ["a.png", "B.JPG", "c.jpeg", "d.jfif", "e.gif", "f.webp", "g.SVG", "C:\\x\\h.png"]) {
      expect(classifyDroppedFile(name).kind, name).toBe("image");
    }
    for (const name of ["a.bmp", "a.tif", "a.TIFF", "a.ico", "a.heic", "a.heif", "a.avif", "a.pdf", "a.svgz"]) {
      expect(classifyDroppedFile(name).kind, name).toBe("refused");
    }
    expect(classifyDroppedFile("a.bmp")).toEqual({ kind: "refused",
      reason: "BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first." });
    for (const name of ["a.cdxml", "a.chemdraft", "a.cdx", "a.mol", "a.sdf", "a.rxn", "a.smi", "noextension", ".png"]) {
      expect(classifyDroppedFile(name).kind, name).toBe("document");
    }
  });

  it("rewords the shared paste validators for a drop", () => {
    expect(rewordPictureError("Couldn't paste the picture: the PNG has invalid structure.")).toBe("the PNG has invalid structure.");
  });
});

describe("prepareDroppedImage", () => {
  it("keeps PNG byte for byte", async () => {
    const raster = fakeRaster();
    const result = await prepareDroppedImage("a.png", pngBytes(), raster);
    expect(result).toEqual({ ok: true, image: { name: "a.png", mimeType: "image/png",
      dataBase64: btoa(String.fromCharCode(...pngBytes())), notes: [] } });
    expect(raster.calls).toBe(0);
  });

  it("re-encodes JPEG, GIF and WebP through the injected decoder after a header check", async () => {
    for (const [name, bytes] of [["a.jpg", jpegHeader(8, 8)], ["a.gif", gifHeader(8, 8)], ["a.webp", webpVp8Header(8, 8)]] as const) {
      const raster = vi.fn(fakeRaster());
      const result = await prepareDroppedImage(name, bytes, raster);
      expect(result.ok, name).toBe(true);
      expect(raster).toHaveBeenCalledWith(bytes, expect.stringMatching(/^image\/(jpeg|gif|webp)$/), MAX_IMAGE_OBJECT_BYTES);
    }
  });

  it("refuses a decompression bomb from its header, before decoding", async () => {
    const raster = fakeRaster();
    expect(await prepareDroppedImage("bomb.jpg", jpegHeader(16_385, 4), raster))
      .toEqual({ ok: false, reason: "it is 16385 × 4 pixels; the limit is 16384 pixels on a side." });
    expect(await prepareDroppedImage("bomb.gif", gifHeader(16_000, 16_000), raster))
      .toEqual({ ok: false, reason: "it is 16000 × 16000 pixels; the decoded limit is 256 MiB." });
    expect(await prepareDroppedImage("bomb.webp", webpVp8Header(16_383, 16_383), raster)).toMatchObject({ ok: false });
    expect(await prepareDroppedImage("bomb.png", pngWithSize(20_000, 1), raster))
      .toEqual({ ok: false, reason: "it is 20000 × 1 pixels; the limit is 16384 pixels on a side." });
    expect(raster.calls).toBe(0);
  });

  it("refuses truncated headers and mislabelled contents by reason", async () => {
    const raster = fakeRaster();
    expect(await prepareDroppedImage("a.jpg", jpegHeader(8, 8).subarray(0, 24), raster))
      .toEqual({ ok: false, reason: "the JPEG header is damaged or truncated, so its size can't be read." });
    expect(await prepareDroppedImage("a.png", new TextEncoder().encode("hello"), raster))
      .toEqual({ ok: false, reason: "its contents are not a PNG, JPEG, GIF, WebP or SVG picture." });
    expect(await prepareDroppedImage("a.png", new Uint8Array([0x42, 0x4d, ...new Array(40).fill(0)]), raster))
      .toEqual({ ok: false, reason: "BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first." });
    expect(await prepareDroppedImage("a.svg", new Uint8Array([0x1f, 0x8b, 8, 0]), raster))
      .toEqual({ ok: false, reason: "compressed SVG (.svgz) can't be dropped; save it as plain SVG first." });
    expect(await prepareDroppedImage("a.png", pngBytes().subarray(0, 40), raster))
      .toEqual({ ok: false, reason: "the PNG has invalid structure." });
    expect(raster.calls).toBe(0);
  });

  it("recognises a PNG named .jpg by its bytes", async () => {
    expect(await prepareDroppedImage("photo.jpg", pngBytes(), fakeRaster())).toMatchObject({ ok: true, image: { mimeType: "image/png" } });
  });

  it("keeps the original drawn size when the decoder had to downscale", async () => {
    const raster: RasterToPng = async () => ({ png: pngBytes(), width: 3000, height: 2000, sourceWidth: 6000, sourceHeight: 4000, downscaled: true });
    const result = await prepareDroppedImage("big.jpg", jpegHeader(6000, 4000), raster);
    expect(result).toMatchObject({ ok: true, image: { naturalSize: { width: 6000, height: 4000 },
      notes: ["stored at 3000 × 2000 pixels (from 6000 × 4000) to fit the 25.0 MB picture limit"] } });
  });

  it("reports a decoder failure with the format", async () => {
    const raster: RasterToPng = async () => { throw new Error("the webview could not decode it."); };
    expect(await prepareDroppedImage("a.webp", webpVp8Header(2, 2), raster))
      .toEqual({ ok: false, reason: "the WebP could not be converted: the webview could not decode it." });
  });

  it("sanitizes SVG and embeds the sanitized text, decoding UTF-8 and UTF-16 with a BOM", async () => {
    const source = `<svg ${NS} width="10" height="5"><script>x()</script><rect width="10" height="5" fill="url(https://e.test/#g)"/><text>αβ</text></svg>`;
    const utf8 = await prepareDroppedImage("a.svg", svgBytes(source), fakeRaster());
    expect(utf8).toMatchObject({ ok: true, image: { mimeType: "image/svg+xml",
      notes: ["external content was removed", "scripts and animation were removed"] } });
    const text = utf8.ok ? new TextDecoder().decode(Uint8Array.from(atob(utf8.image.dataBase64), c => c.charCodeAt(0))) : "";
    expect(text).not.toContain("script");
    expect(text).not.toContain("e.test");
    expect(text).toContain("viewBox=\"0 0 10 5\"");
    expect(text).toContain("αβ");
    const units = [0xff, 0xfe, ...Array.from(source, character => [character.charCodeAt(0) & 0xff, character.charCodeAt(0) >> 8]).flat()];
    const utf16 = await prepareDroppedImage("b.svg", new Uint8Array(units), fakeRaster());
    expect(utf16.ok && utf16.image.dataBase64).toBe(utf8.ok && utf8.image.dataBase64);
    expect(await prepareDroppedImage("c.svg", new Uint8Array([...svgBytes(`<svg ${NS}><text>`), 0xc3, 0x28, ...svgBytes("</text></svg>")]), fakeRaster()))
      .toEqual({ ok: false, reason: "the SVG is not valid UTF-8 or UTF-16 text." });
    expect(await prepareDroppedImage("d.svg", svgBytes(`<svg ${NS}><g></svg>`), fakeRaster()))
      .toEqual({ ok: false, reason: "the SVG is not well-formed XML." });
  });
});

describe("size and count caps", () => {
  it("refuses a file over 20 MB from metadata without reading it, and accepts exactly 20 MB", async () => {
    const over = memorySource("over.png", pngBytes(), MAX_DROPPED_IMAGE_BYTES + 1);
    const exact = memorySource("exact.png", pngBytes(), MAX_DROPPED_IMAGE_BYTES);
    const result = await prepareDroppedImages([over, exact], fakeRaster());
    expect(over.reads).toBe(0);
    expect(exact.reads).toBe(1);
    expect(result.images.map(image => image.name)).toEqual(["exact.png"]);
    expect(result.refusals).toEqual([{ name: "over.png", reason: "it is just over 20.0 MB; a dropped picture can be at most 20.0 MB." }]);
  });

  it("caps pictures per drop and total bytes, naming each refused file", async () => {
    const many = Array.from({ length: MAX_DROPPED_IMAGES + 2 }, (_, index) => memorySource(`p${index}.png`, pngBytes()));
    const result = await prepareDroppedImages(many, fakeRaster());
    expect(result.images).toHaveLength(MAX_DROPPED_IMAGES);
    expect(result.refusals).toEqual([
      { name: "p50.png", reason: "only 50 pictures can be dropped at once." },
      { name: "p51.png", reason: "only 50 pictures can be dropped at once." }
    ]);
    const big = Array.from({ length: 11 }, (_, index) => memorySource(`b${index}.png`, pngBytes(), MAX_DROPPED_IMAGE_BYTES));
    const total = await prepareDroppedImages(big, fakeRaster());
    expect(total.images).toHaveLength(MAX_DROPPED_IMAGE_TOTAL_BYTES / MAX_DROPPED_IMAGE_BYTES);
    expect(total.refusals).toEqual([{ name: "b10.png", reason: "the pictures in one drop can total at most 200.0 MB." }]);
    expect(big[10]!.reads).toBe(0);
  });

  it("browser reads check File.size first and again after reading", async () => {
    const arrayBuffer = vi.fn(async () => pngBytes().buffer as ArrayBuffer);
    const lying = browserDroppedImageSource({ name: "x.png", size: 10, arrayBuffer });
    await expect(lying.read(9)).rejects.toThrow(/^it is just over 0\.0 MB; a dropped picture can be at most 0\.0 MB\.$/);
    expect(arrayBuffer).not.toHaveBeenCalled();
    const grows = browserDroppedImageSource({ name: "x.png", size: 1, arrayBuffer });
    await expect(grows.read(10)).rejects.toThrow("it is larger than the 0.0 MB limit for a dropped picture.");
    await expect(browserDroppedImageSource({ name: "x.png", size: 70, arrayBuffer }).read(70)).resolves.toHaveLength(70);
  });

  it("native reads stat first and stop one byte past the limit", async () => {
    vi.resetModules();
    const close = vi.fn(async () => {});
    vi.doMock("@tauri-apps/plugin-fs", () => ({
      stat: async () => ({ size: 3 }),
      open: async () => {
        let left = 100;
        return { read: async (buffer: Uint8Array) => { const count = Math.min(buffer.length, left); left -= count; return count; }, close };
      }
    }));
    const { nativeDroppedImageSource: fresh } = await import("./readDroppedFile");
    const source = fresh("/tmp/dir/grows.png");
    expect(source.name).toBe("grows.png");
    expect(await source.size()).toBe(3);
    await expect(source.read(10)).rejects.toThrow("limit for a dropped picture");
    expect(close).toHaveBeenCalled();
    await expect(source.read(100)).resolves.toHaveLength(100);
    vi.doUnmock("@tauri-apps/plugin-fs");
    expect(nativeDroppedImageSource("C:\\Pictures\\a.png").name).toBe("a.png");
  });
});

describe("handleDroppedFiles", () => {
  type File = { name: string; bytes: Uint8Array };
  const file = (name: string, bytes: Uint8Array = pngBytes()): File => ({ name, bytes });

  function harness(insert: "ok" | "refuse" = "ok") {
    const calls = { opened: [] as string[][], inserted: [] as string[][], status: [] as string[] };
    return {
      calls,
      handler: {
        nameOf: (entry: File) => entry.name,
        imageSource: (entry: File) => memorySource(entry.name, entry.bytes),
        openDocuments: async (entries: File[]) => { calls.opened.push(entries.map(entry => entry.name)); return "Opened 1 document"; },
        insertImages: (images: { name: string }[]) => {
          calls.inserted.push(images.map(image => image.name));
          return insert === "ok" ? { ok: true as const, scaledToPage: [] } : { ok: false as const, reason: "the document tab changed while they were read; drop them again." };
        },
        rasterToPng: fakeRaster(),
        setStatus: (status: string) => calls.status.push(status)
      }
    };
  }

  it("sends a drop without pictures to the document-open path unchanged", async () => {
    const { calls, handler } = harness();
    await handleDroppedFiles([file("a.cdxml"), file("b.chemdraft")], handler);
    expect(calls).toEqual({ opened: [["a.cdxml", "b.chemdraft"]], inserted: [], status: [] });
  });

  it("does both in a mixed drop: pictures first in one insertion, documents after, one combined status", async () => {
    const { calls, handler } = harness();
    await handleDroppedFiles([file("a.cdxml"), file("one.png"), file("bad.bmp"), file("fake.jpg", new TextEncoder().encode("nope")), file("two.png")], handler);
    expect(calls.inserted).toEqual([["one.png", "two.png"]]);
    expect(calls.opened).toEqual([["a.cdxml"]]);
    expect(calls.status.at(-1)).toBe([
      "Inserted 2 pictures (one.png, two.png)",
      "Couldn't drop \"bad.bmp\": BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first.",
      "Couldn't drop \"fake.jpg\": its contents are not a PNG, JPEG, GIF, WebP or SVG picture.",
      "Opened 1 document"
    ].join("; "));
  });

  it("reports a refused insertion and still opens the documents", async () => {
    const { calls, handler } = harness("refuse");
    await handleDroppedFiles([file("one.png"), file("a.mol")], handler);
    expect(calls.opened).toEqual([["a.mol"]]);
    expect(calls.status.at(-1)).toBe("The dropped pictures were not inserted: the document tab changed while they were read; drop them again.; Opened 1 document");
  });

  it("serializes the picture work of overlapping drops", async () => {
    const order: string[] = [];
    let queue = Promise.resolve();
    const serialize = <R,>(task: () => Promise<R>) => {
      const run = queue.then(task);
      queue = run.then(() => undefined, () => undefined);
      return run;
    };
    const slow = harness();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = handleDroppedFiles([file("first.png")], { ...slow.handler, serialize,
      imageSource: entry => ({ ...memorySource(entry.name, entry.bytes), read: async () => { await gate; order.push("read first"); return entry.bytes; } }),
      insertImages: images => { order.push(`insert ${images[0]!.name}`); return { ok: true, scaledToPage: [] }; } });
    const second = handleDroppedFiles([file("second.png")], { ...slow.handler, serialize,
      insertImages: images => { order.push(`insert ${images[0]!.name}`); return { ok: true, scaledToPage: [] }; } });
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["read first", "insert first.png", "insert second.png"]);
  });
});

describe("formatImageDropStatus", () => {
  it("lists a few names, then counts the rest", () => {
    const images = Array.from({ length: 7 }, (_, index) => ({ name: `p${index}.png`, mimeType: "image/png" as const, dataBase64: "", notes: [] }));
    expect(formatImageDropStatus({ inserted: images, refusals: [], scaledToPage: ["p1.png"] }))
      .toBe("Inserted 7 pictures (p0.png, p1.png, p2.png, p3.png, p4.png and 2 more); scaled to fit the page: p1.png");
    expect(formatImageDropStatus({ inserted: [], refusals: [{ name: "C:\\a\\x.tif", reason: "r." }] }))
      .toBe("No pictures were inserted; Couldn't drop \"x.tif\": r.");
  });
});

describe("splitDrop", () => {
  it("keeps drop order within each group", () => {
    expect(splitDrop(["b.png", "a.cdx", "c.svg", "d.heic"], name => name))
      .toEqual({ images: ["b.png", "c.svg"], documents: ["a.cdx"], refusals: [{ name: "d.heic", reason: "HEIC/HEIF pictures can't be dropped yet; save it as PNG or JPEG first." }] });
  });
});
