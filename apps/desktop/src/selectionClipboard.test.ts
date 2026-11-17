// @vitest-environment jsdom
import { Resvg } from "@resvg/resvg-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPngInfo } from "@chemdraft/chem-core";
import {
  CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, copyAsScopedDocument, createPhase4Document,
  createSelectionClipboardPayload, exportPhase4Svg, insertNativeSingleBondMolecule,
  insertNativeTextObject, serializeSelectionClipboardPayload
} from "./documentWorkflow";
import { selectionClipboardImageItems } from "./selectionClipboard";
import { pngWithPhysicalDensity, writeClipboardItems } from "./clipboard";
import { rasterizeSvgNative } from "./nativeRasterExport";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./window-manager", () => ({ isDesktopRuntime: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("./nativeRasterExport", () => ({ rasterizeSvgNative: vi.fn() }));

describe("selection picture copy", () => {
  beforeEach(() => {
    Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true,
      value: () => ({ x: 0, y: 0, width: 80, height: 16 }) });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    native.invoke.mockReset().mockImplementation(async (_command, { items }) => ({
      ok: true, written: items.map((item: { type: string }) => item.type), failed: [], warnings: []
    }));
    vi.mocked(rasterizeSvgNative).mockReset().mockImplementation(async svg => {
      const image = new Resvg(svg).render();
      return { bytes: pngWithPhysicalDensity(image.asPng(), 384), width: image.width, height: image.height, warnings: [] };
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  });

  it.each(["macos", "windows"] as const)("writes JSON and real image flavors together on %s without changing chemistry", async platform => {
    let source = insertNativeTextObject(createPhase4Document(), { x: 20, y: 20 }, "Unselected text");
    source = insertNativeSingleBondMolecule(source, { x: 300, y: 300 });
    const before = structuredClone(source);
    const payload = createSelectionClipboardPayload(source)!;
    const prepared = await selectionClipboardImageItems(source, payload, platform);
    expect(prepared.warnings).toEqual([]);
    const svg = prepared.items.find(item => item.type === "image/svg+xml")!;
    expect(svg).toMatchObject({ text: (await exportPhase4Svg(copyAsScopedDocument(source), { includeWarnings: false })).contents });
    expect("text" in svg && svg.text).not.toContain("Unselected text");
    expect(rasterizeSvgNative).toHaveBeenCalledWith("text" in svg ? svg.text : "", "png", {
      scale: 4, background: "#ffffff", maxDimensionPx: 8192, cssPxPerInch: 96
    });
    expect(prepared.items.map(item => item.type)).toEqual([
      CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, "image/png", "image/svg+xml",
      ...(platform === "macos" ? ["public.svg-image", "application/pdf"] : [])
    ]);
    expect(prepared.items[0]).toEqual({ type: CHEMDRAFT_SELECTION_CLIPBOARD_TYPE,
      text: serializeSelectionClipboardPayload(payload), required: true });
    const png = prepared.items[1];
    expect(png.required).toBe(true);
    if (!("bytes" in png)) throw new Error("Expected PNG bytes");
    expect(readPngInfo(png.bytes)?.pixelsPerMeter).toEqual({ x: Math.round(384 / 0.0254), y: Math.round(384 / 0.0254) });
    expect(Buffer.from(png.bytes).toString("utf8")).toContain(serializeSelectionClipboardPayload(payload));
    if (platform === "macos") {
      const pdf = prepared.items.at(-1)!;
      expect("bytes" in pdf && Buffer.from(pdf.bytes).subarray(0, 5).toString()).toBe("%PDF-");
    }
    await writeClipboardItems(prepared.items);
    expect(native.invoke).toHaveBeenCalledOnce();
    const [command, request] = native.invoke.mock.calls[0];
    expect(command).toBe("write_clipboard_items");
    expect(request.items[0].text).toBe(serializeSelectionClipboardPayload(payload));
    expect(Buffer.from(request.items[1].bytesBase64, "base64")).toEqual(Buffer.from(png.bytes));
    expect(source).toEqual(before);
  });

  it.each(["macos", "windows"] as const)("renders exactly the copied molecule fragment on %s", async platform => {
    const source = structuredClone(insertNativeSingleBondMolecule(createPhase4Document(), { x: 300, y: 300 }));
    const molecule = source.pages[0].objects.find(object => object.type === "molecule")!;
    source.selection.objectIds = [];
    const payload = createSelectionClipboardPayload(source, [{ objectId: molecule.id,
      atomIds: [molecule.atoms[0].id], bondIds: [] }])!;
    await selectionClipboardImageItems(source, payload, platform);
    const expected = copyAsScopedDocument({ ...source, pages: [{ ...source.pages[0], objects: payload.objects }] });
    expect(rasterizeSvgNative).toHaveBeenCalledWith((await exportPhase4Svg(expected, { includeWarnings: false })).contents,
      "png", expect.anything());
    expect(source.pages[0].objects[0]).toEqual(molecule);
    expect(payload.objects[0]).toMatchObject({ atoms: [molecule.atoms[0]], bonds: [] });
  });

  it.each(["macos", "windows"] as const)("keeps plain text alongside every image flavor for a mixed selection on %s", async platform => {
    let source = insertNativeSingleBondMolecule(createPhase4Document(), { x: 300, y: 300 });
    source = insertNativeTextObject(source, { x: 20, y: 20 }, "Reaction conditions");
    source = { ...source, selection: { ...source.selection,
      objectIds: source.pages[0].objects.map(object => object.id) } };
    const before = structuredClone(source);
    const payload = createSelectionClipboardPayload(source)!;
    expect(payload.objects.map(object => object.type)).toEqual(["molecule", "text"]);
    const prepared = await selectionClipboardImageItems(source, payload, platform);
    expect(prepared.items).toContainEqual({ type: "text/plain", text: "Reaction conditions", required: false });
    expect(prepared.items.map(item => item.type)).toEqual(expect.arrayContaining([
      CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, "text/plain", "image/png", "image/svg+xml",
      ...(platform === "macos" ? ["public.svg-image", "application/pdf"] : [])
    ]));
    await writeClipboardItems(prepared.items);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("write_clipboard_items", {
      items: expect.arrayContaining([
        expect.objectContaining({ type: "text/plain", text: "Reaction conditions", required: false }),
        expect.objectContaining({ type: "image/png", required: true }),
        expect.objectContaining({ type: "image/svg+xml" })
      ])
    });
    expect(source).toEqual(before);
  });

  it("does not fall back to a JSON-only copy when rasterization fails", async () => {
    vi.mocked(rasterizeSvgNative).mockRejectedValue(new Error("Rasterizer unavailable"));
    const source = insertNativeSingleBondMolecule(createPhase4Document(), { x: 300, y: 300 });
    await expect(selectionClipboardImageItems(source, createSelectionClipboardPayload(source)!, "windows"))
      .rejects.toThrow("Rasterizer unavailable");
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("keeps PNG and reports PDF's unsupported text without silently dropping it", async () => {
    const source = insertNativeTextObject(createPhase4Document(), { x: 20, y: 20 }, "שלום");
    const prepared = await selectionClipboardImageItems(source, createSelectionClipboardPayload(source)!, "macos");
    expect(prepared.items.map(item => item.type)).toContain("image/png");
    expect(prepared.items.map(item => item.type)).not.toContain("application/pdf");
    expect(prepared.warnings.join(" ")).toContain("PDF was not copied:");
  });
});
