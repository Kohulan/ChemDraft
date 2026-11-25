// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImageGraphicObject, serializeDocument, type ChemDraftDocument, type GraphicObject } from "@chemdraft/chem-core";
import { MainWindow, objectResizeStretches } from "./MainWindow";
import { createPhase4Document } from "./documentWorkflow";
import { browserDecodeCheck, browserRasterToPng } from "./imageDrop/rasterDecode";
import { jpegHeader, pngBytes, svgBytes } from "./imageDrop/testFixtures";
import { picturePngBase64 } from "./testSupport/imageFixture";
import { MemoryStorage } from "./testSupport/memoryStorage";

const native = vi.hoisted(() => ({
  desktop: false,
  events: new Map<string, (payload: unknown) => void>(),
  files: new Map<string, Uint8Array>(),
  stat: vi.fn<(path: string) => Promise<{ size: number }>>()
}));

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
// jsdom has no canvas: the webview decoder is replaced by one returning a real 1 × 1 PNG.
vi.mock("./imageDrop/rasterDecode", async (original) => {
  const { pngBytes: png } = await import("./imageDrop/testFixtures");
  const browserRasterToPng = vi.fn(async () => ({ png: png(), width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, downscaled: false }));
  // The PNG and SVG decode checks: jsdom cannot decode, so every picture decodes.
  const browserDecodeCheck = vi.fn(async () => ({ width: 1, height: 1 }));
  return { ...await original<typeof import("./imageDrop/rasterDecode")>(),
    browserRasterToPng, browserDecodeCheck, browserImageDecoders: { rasterToPng: browserRasterToPng, decodeCheck: browserDecodeCheck } };
});
vi.mock("./window-manager", async (original) => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => native.desktop,
  loadDocumentSession: async () => undefined,
  saveDocumentSession: async () => undefined
}));
vi.mock("./window-manager/tauriEvents", async (original) => {
  const listen = async (name: string, handler: (event: { payload: unknown }) => void) => {
    const callback = (payload: unknown) => handler({ payload });
    native.events.set(name, callback);
    return () => { if (native.events.get(name) === callback) native.events.delete(name); };
  };
  return { ...await original<typeof import("./window-manager/tauriEvents")>(), listenTauriEvent: listen, listenCurrentWindowEvent: listen };
});
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn(async () => null)
}));
vi.mock("@tauri-apps/plugin-fs", async (original) => ({
  ...await original<typeof import("@tauri-apps/plugin-fs")>(),
  stat: native.stat,
  readFile: async (path: string) => native.files.get(path)!,
  open: async (path: string) => {
    const bytes = native.files.get(path)!;
    let offset = 0;
    return {
      read: async (buffer: Uint8Array) => {
        const count = Math.min(buffer.length, bytes.length - offset);
        buffer.set(bytes.subarray(offset, offset + count));
        offset += count;
        return count;
      },
      close: async () => {}
    };
  }
}));

type DropFile = { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> };

function dropFile(name: string, bytes: Uint8Array, size = bytes.length): DropFile & { reads: () => number } {
  let reads = 0;
  return { name, size, reads: () => reads, arrayBuffer: async () => { reads += 1; return bytes.slice().buffer as ArrayBuffer; } };
}

const documentFile = (title: string) => {
  const bytes = new TextEncoder().encode(serializeDocument(createPhase4Document(title)));
  return dropFile(`${title}.chemdraft`, bytes);
};

const SVG = svgBytes('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><script>alert(1)</script><rect width="40" height="20" fill="red"/></svg>');

/** How long a drop may take on a loaded runner before a positive assertion gives up. */
const DROP_WAIT_MS = 10_000;

describe("dropping picture files on the document window", { timeout: 3 * DROP_WAIT_MS }, () => {
  let container: HTMLDivElement;
  let root: Root;
  const agent = () => window.__CHEMDRAFT_AGENT__!;
  const snapshot = () => agent().snapshot().document;
  const status = () => container.querySelector("[data-status-message]")?.textContent;
  const canvas = () => container.querySelector<HTMLElement>(".canvas-region")!;
  const pictures = (document: ChemDraftDocument = snapshot()) =>
    document.pages[0]!.objects.filter((object): object is GraphicObject => object.type === "graphic" && object.graphicKind === "image");
  const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

  beforeEach(() => {
    native.desktop = false;
    native.events.clear();
    native.files.clear();
    native.stat.mockReset();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    for (const method of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
      Object.defineProperty(Element.prototype, method, { configurable: true, value: vi.fn(() => false) });
    }
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete window.__CHEMDRAFT_AGENT__;
    window.history.replaceState(null, "", "/");
    for (const method of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
      Reflect.deleteProperty(Element.prototype, method);
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount(initialDocument = createPhase4Document("Drop target"), platform: "macos" | "windows" | "linux" = "macos",
    options: { scrollbar?: number } = {}) {
    await act(async () => root.render(<MainWindow initialDocument={initialDocument} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} initialCrosshairsVisible={false}
      nativePalette={false} shortcutPlatform={platform} />));
    stubLayout(options.scrollbar ?? 0);
    await settle();
  }

  /** jsdom has no layout: the page and canvas are drawn 1:1 from (0, 0), less any scrollbars. */
  function stubLayout(scrollbar: number) {
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700, toJSON() {} };
    for (const element of container.querySelectorAll(".page, .canvas-region")) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
    }
    vi.spyOn(canvas(), "clientWidth", "get").mockReturnValue(rect.width - scrollbar);
    vi.spyOn(canvas(), "clientHeight", "get").mockReturnValue(rect.height - scrollbar);
  }

  async function settle() {
    await act(async () => { for (let index = 0; index < 30; index += 1) await new Promise(resolve => setTimeout(resolve, 0)); });
  }

  /**
   * Settles until `assertion` holds. A drop finishes on its own clock (the write gate polls on a real
   * timer while a gesture is live), so a fixed number of ticks is no proof it has finished.
   */
  async function eventually(assertion: () => void) {
    await vi.waitFor(async () => { await settle(); assertion(); }, { timeout: DROP_WAIT_MS, interval: 0 });
  }

  async function browserDrop(files: DropFile[], client?: { x: number; y: number }, target: Element = canvas()) {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } });
    if (client) Object.defineProperties(event, { clientX: { value: client.x }, clientY: { value: client.y } });
    await act(async () => { target.dispatchEvent(event); });
    await settle();
    return event;
  }

  async function command(id: string) {
    await act(async () => { await agent().command(id); });
  }

  const centre = (object: GraphicObject) => ({ x: object.x + object.width / 2, y: object.y + object.height / 2 });

  it("inserts PNG, JPEG and SVG at the drop point as one selected 'Insert Image' entry, undone and redone exactly", async () => {
    await mount();
    const before = snapshot();
    const client = agent().resolvePoint({ page: { x: 300, y: 200 } }).client;
    const event = await browserDrop([dropFile("a.png", pngBytes()), dropFile("b.jpg", jpegHeader(8, 8)), dropFile("c.svg", SVG)], client);
    expect(event.defaultPrevented).toBe(true);
    await eventually(() => expect(status()).toBe("Inserted 3 pictures (a.png, b.jpg, c.svg); c.svg: scripts and animation were removed"));
    expect(vi.mocked(browserRasterToPng)).toHaveBeenCalledTimes(1);
    const inserted = pictures();
    expect(inserted.map(object => object.data.image!.mimeType)).toEqual(["image/png", "image/png", "image/svg+xml"]);
    expect(centre(inserted[0]!)).toEqual({ x: 300, y: 200 });
    expect(centre(inserted[1]!)).toEqual({ x: 324, y: 224 });
    expect([inserted[2]!.width, inserted[2]!.height]).toEqual([40, 20]);
    expect(atob(inserted[2]!.data.image!.dataBase64)).not.toContain("script");
    expect(snapshot().selection.objectIds).toEqual(inserted.map(object => object.id));
    expect(document.activeElement).toBe(canvas());
    const after = snapshot();

    await command("edit.undo");
    expect(status()).toBe("Undid Insert Image");
    expect(snapshot()).toEqual(before);
    await command("edit.redo");
    expect(snapshot()).toEqual(after);
    await command("edit.undo");
    expect(snapshot()).toEqual(before);
  });

  it("puts a drop over a toolbar at the nearest visible page point and keeps the picture on the page", async () => {
    await mount();
    await browserDrop([dropFile("edge.png", pngBytes())], { x: -50, y: -80 }, container.querySelector("main") ?? canvas());
    await eventually(() => expect(pictures()).toHaveLength(1));
    const [picture] = pictures();
    expect(picture).toMatchObject({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("puts a drop over a ruler or a scrollbar at the nearest drawable point, as the pointer check reads the canvas", async () => {
    await mount(createPhase4Document("Rulers"), "macos", { scrollbar: 15 });
    // The ruler widget needs a real canvas to draw; the strips it occupies are what matter here.
    canvas().classList.add("rulers-visible");
    // Over the top ruler (32 px), then over the bottom scrollbar (the last 15 px).
    await browserDrop([dropFile("ruler.png", pngBytes())], { x: 300, y: 5 });
    await browserDrop([dropFile("scrollbar.png", pngBytes())], { x: 400, y: 695 });
    await eventually(() => expect(pictures()).toHaveLength(2));
    expect(pictures().map(centre)).toEqual([{ x: 300, y: 32 }, { x: 400, y: 685 }]);
  });

  it("waits for a live resize to finish, then inserts the picture as its own entry on top", async () => {
    const drawing = createPhase4Document("Gesture");
    drawing.pages[0]!.objects = [{
      id: "rect-a", type: "graphic", graphicKind: "rect", x: 100, y: 100, width: 80, height: 50, rotation: 0, style: {}, data: {}
    }];
    drawing.selection.objectIds = ["rect-a"];
    await mount(drawing);
    const page = container.querySelector<HTMLElement>(".page")!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: DropFile = { name: "slow.png", size: pngBytes().length, arrayBuffer: async () => { await gate; return pngBytes().buffer as ArrayBuffer; } };
    // The decode check is the drop's last asynchronous step: once it has returned, the commit is
    // queued at the write gate within the same microtask run.
    let decoded = false;
    vi.mocked(browserDecodeCheck).mockImplementationOnce(async () => { decoded = true; return { width: 1, height: 1 }; });
    await browserDrop([slow], { x: 400, y: 400 });
    async function pointer(target: Element, type: string, x: number, y: number) {
      const event = new MouseEvent(type, { button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y, bubbles: true, cancelable: true });
      Object.defineProperty(event, "pointerId", { value: 7 });
      await act(async () => target.dispatchEvent(event));
    }
    const handle = container.querySelector('[data-object-resize-corner="bottom-right"]')!;
    expect(handle).not.toBeNull();
    await pointer(handle, "pointerdown", 180, 150);
    await pointer(page, "pointermove", 220, 175);
    // The picture is read and decoded while the resize is still live: nothing is written yet.
    release();
    await eventually(() => expect(decoded).toBe(true));
    await settle();
    expect(pictures()).toHaveLength(0);
    await pointer(page, "pointermove", 260, 200);
    await pointer(page, "pointerup", 260, 200);
    await eventually(() => expect(status()).toMatch(/^Inserted picture slow\.png/));
    const [picture] = pictures();
    expect(picture).toBeDefined();
    const resized = snapshot().pages[0]!.objects.find(object => object.id === "rect-a") as GraphicObject;
    expect(resized.width).toBeGreaterThan(80);
    // Two entries: the picture on top of the resize, each undone on its own.
    await command("edit.undo");
    expect(pictures()).toHaveLength(0);
    expect((snapshot().pages[0]!.objects.find(object => object.id === "rect-a") as GraphicObject).width).toBe(resized.width);
    await command("edit.undo");
    expect((snapshot().pages[0]!.objects.find(object => object.id === "rect-a") as GraphicObject).width).toBe(80);
  });

  it("refuses BMP, TIFF and oversize files by name before reading them, and inserts the rest", async () => {
    await mount();
    const bmp = dropFile("scan.bmp", new Uint8Array(30));
    const big = dropFile("huge.png", pngBytes(), 20 * 1024 * 1024 + 1);
    const fake = dropFile("fake.jpg", new TextEncoder().encode("not a picture"));
    await browserDrop([bmp, big, fake, dropFile("ok.png", pngBytes())], { x: 100, y: 100 });
    await eventually(() => expect(status()).toBe([
      "Inserted picture ok.png",
      "Couldn't drop \"scan.bmp\": BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first",
      "Couldn't drop \"huge.png\": it is just over 20.0 MB; a dropped picture can be at most 20.0 MB",
      "Couldn't drop \"fake.jpg\": its contents are not a PNG, JPEG, GIF, WebP or SVG picture."
    ].join("; ")));
    // Checked once the drop has finished, so no later read could still be on its way.
    expect(bmp.reads()).toBe(0);
    expect(big.reads()).toBe(0);
    expect(pictures()).toHaveLength(1);
  });

  it("still opens a dropped document exactly as before, and does both for a mixed drop", async () => {
    await mount();
    await browserDrop([documentFile("Only document")]);
    await eventually(() => expect(snapshot().title).toBe("Only document"));
    expect(tabs()).toHaveLength(1);

    await browserDrop([dropFile("mixed.png", pngBytes()), documentFile("Mixed document")], { x: 200, y: 200 });
    // The picture went into the tab under the drop; the document then opened in a tab of its own.
    await eventually(() => expect(status()).toMatch(/^Inserted picture mixed\.png/));
    await eventually(() => expect(snapshot().title).toBe("Mixed document"));
    expect(tabs()).toHaveLength(2);
    await act(async () => { tabs()[0]!.click(); });
    await eventually(() => expect(snapshot().title).toBe("Only document"));
    expect(pictures()).toHaveLength(1);
  });

  it("never inserts into a document that replaced the drop target while the picture was read", async () => {
    await mount();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: DropFile = { name: "slow.png", size: pngBytes().length, arrayBuffer: async () => { await gate; return pngBytes().buffer as ArrayBuffer; } };
    await browserDrop([slow], { x: 100, y: 100 });
    // The blank tab is reused by this open: same tab, different document.
    await browserDrop([documentFile("Replacement")]);
    await eventually(() => expect(snapshot().title).toBe("Replacement"));
    release();
    await eventually(() => expect(status()).toBe("The dropped pictures were not inserted: the document they were dropped on is no longer the active tab; drop them again."));
    expect(pictures()).toHaveLength(0);
    expect(tabs()).toHaveLength(1);
  });

  it("prevents navigation for a file dropped outside the canvas and shows copy over the canvas", async () => {
    await mount();
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    const transfer = { types: ["Files"], dropEffect: "none" };
    Object.defineProperty(over, "dataTransfer", { value: transfer });
    await act(async () => { canvas().dispatchEvent(over); });
    expect(over.defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe("copy");
    const outside = await browserDrop([], undefined, document.body);
    expect(outside.defaultPrevented).toBe(false);
    const files = await browserDrop([documentFile("From the tab strip")], undefined, container.querySelector('[role="tablist"]') ?? document.body);
    expect(files.defaultPrevented).toBe(true);
    await eventually(() => expect(snapshot().title).toBe("From the tab strip"));
  });

  describe("desktop drag-drop event", () => {
    it.each([
      ["macos", 2, { x: 300, y: 200 }],
      ["linux", 1.5, { x: 300, y: 200 }],
      ["windows", 1.5, { x: 450, y: 300 }],
      ["windows", 2, { x: 600, y: 400 }]
    ] as const)("places the picture at the converted %s position (scale %s)", async (platform, scale, position) => {
      native.desktop = true;
      vi.stubGlobal("devicePixelRatio", scale);
      native.files.set("/Users/me/Pictures/mol.png", pngBytes());
      native.stat.mockImplementation(async path => ({ size: native.files.get(path)?.length ?? 0 }));
      await mount(createPhase4Document("Desktop"), platform);
      await eventually(() => expect(native.events.has("tauri://drag-drop")).toBe(true));
      await act(async () => native.events.get("tauri://drag-drop")!({ paths: ["/Users/me/Pictures/mol.png"], position }));
      await eventually(() => expect(status()).toBe("Inserted picture mol.png"));
      expect(centre(pictures()[0]!)).toEqual({ x: 300, y: 200 });
    });

    it("refuses an oversize native file from stat, without opening it, and still opens a dropped document", async () => {
      native.desktop = true;
      native.files.set("C:\\Drawings\\doc.chemdraft", new TextEncoder().encode(serializeDocument(createPhase4Document("Native document"))));
      native.stat.mockImplementation(async path => ({ size: path.endsWith(".png") ? 21 * 1024 * 1024 : native.files.get(path)!.length }));
      await mount(createPhase4Document("Desktop"), "windows");
      await eventually(() => expect(native.events.has("tauri://drag-drop")).toBe(true));
      await act(async () => native.events.get("tauri://drag-drop")!({ paths: ["C:\\Pictures\\big.png", "C:\\Drawings\\doc.chemdraft"], position: { x: 10, y: 10 } }));
      await eventually(() => expect(status()).toBe("No pictures were inserted; Couldn't drop \"big.png\": it is 21.0 MB; a dropped picture can be at most 20.0 MB."));
      expect(snapshot().title).toBe("Native document");
    });
  });
});

describe("picture stretch entry", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete window.__CHEMDRAFT_AGENT__;
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  it("links X and Y for a picture, so the typed value is the scale applied", async () => {
    const base = createPhase4Document("Stretch");
    const picture = createImageGraphicObject({ mimeType: "image/png", dataBase64: picturePngBase64, center: { x: 300, y: 300 }, id: "image-1" });
    const drawing = { ...base, pages: [{ ...base.pages[0]!, objects: [picture] }], selection: { ...base.selection, objectIds: ["image-1"] } };
    await act(async () => root.render(<MainWindow initialDocument={drawing} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} initialCrosshairsVisible={false} nativePalette={false} shortcutPlatform="macos" />));
    const handle = container.querySelector('[data-object-resize-corner]');
    expect(handle).not.toBeNull();
    await act(async () => handle!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const x = container.querySelector<HTMLInputElement>('[aria-label="X stretch percent"]')!;
    const y = container.querySelector<HTMLInputElement>('[aria-label="Y stretch percent"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(x, "200");
      x.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The readout and the entry agree with what the picture actually does.
    expect(y.value).toBe("200");
    const stretched = window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0]!.objects[0] as GraphicObject;
    expect([stretched.width, stretched.height]).toEqual([picture.width * 2, picture.height * 2]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(y, "50");
      y.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(x.value).toBe("50");
    const shrunk = window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0]!.objects[0] as GraphicObject;
    expect([shrunk.width, shrunk.height]).toEqual([picture.width / 2, picture.height / 2]);
  });
});

describe("picture resize keeps the aspect ratio", () => {
  it("turns a Shift stretch of a picture into a uniform resize, leaving other graphics stretchable", () => {
    const document = createPhase4Document("Resize");
    const picture = { id: "image-1", type: "graphic", graphicKind: "image" } as unknown as ChemDraftDocument["pages"][number]["objects"][number];
    const rect = { id: "rect-1", type: "graphic", graphicKind: "rect" } as unknown as ChemDraftDocument["pages"][number]["objects"][number];
    const withObjects = { ...document, pages: [{ ...document.pages[0]!, objects: [picture, rect] }] };
    expect(objectResizeStretches({ startDocument: withObjects, objectId: "image-1", target: undefined }, true)).toBe(false);
    expect(objectResizeStretches({ startDocument: withObjects, objectId: "rect-1", target: undefined }, true)).toBe(true);
    expect(objectResizeStretches({ startDocument: withObjects, objectId: "image-1", target: undefined }, false)).toBe(false);
  });
});
