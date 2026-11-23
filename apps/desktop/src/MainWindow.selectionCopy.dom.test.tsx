// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { deserializeDocument } from "@chemdraft/chem-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import {
  CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, createPhase4Document, createSelectionClipboardPayload,
  insertNativeSingleBondMolecule, insertNativeTextObject, serializeSelectionClipboardPayload
} from "./documentWorkflow";
import { readClipboardPayload, writeClipboardItems } from "./clipboard";
import { selectionClipboardImageItems } from "./selectionClipboard";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";

const runtime = vi.hoisted(() => ({ desktop: false }));
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(), isDesktopRuntime: () => runtime.desktop
}));
vi.mock("./clipboard", async original => ({
  ...await original<typeof import("./clipboard")>(), readClipboardPayload: vi.fn(), writeClipboardItems: vi.fn()
}));
vi.mock("./selectionClipboard", () => ({ selectionClipboardImageItems: vi.fn() }));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each(["macos", "windows", "linux"] as const)("MainWindow selection copy on %s", platform => {
  let container: HTMLDivElement;
  let root: Root;
  const source = () => insertNativeSingleBondMolecule(createPhase4Document(), { x: 300, y: 300 });
  beforeEach(() => {
    runtime.desktop = false;
    window.history.replaceState(null, "", "/?agentBridge=1");
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.mocked(readClipboardPayload).mockReset().mockResolvedValue({ types: [], textItems: [] });
    vi.mocked(selectionClipboardImageItems).mockReset().mockImplementation(async (_source, payload) => ({
      items: [{ type: CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, text: serializeSelectionClipboardPayload(payload), required: true },
        { type: "image/png", bytes: Uint8Array.from([137, 80]), required: true }], warnings: []
    }));
    vi.mocked(writeClipboardItems).mockReset().mockResolvedValue({ ok: true,
      written: [CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, "image/png"], failed: [], warnings: [] });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    runtime.desktop = false;
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  });
  async function mount(drawing = source()) {
    await act(async () => root.render(<MainWindow initialDocument={drawing} shortcutPlatform={platform}
      initialActiveToolCommandId="tool.select" initialCrosshairsVisible={false}
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette />));
    runtime.desktop = true;
    return drawing;
  }
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  it.each(["input", "textarea", "contenteditable"])("leaves native cut, copy, and paste to a focused %s", async kind => {
    const drawing = await mount();
    const field = document.createElement(kind === "contenteditable" ? "div" : kind);
    if (kind === "contenteditable") field.setAttribute("contenteditable", "true");
    container.append(field);
    field.focus();
    expect(document.activeElement).toBe(field);
    await act(async () => {
      // Desktop menu actions go through the WebView's clipboard event path.
      for (const operation of ["cut", "copy", "paste"]) {
        for (const type of [`before${operation}`, operation]) {
          expect(field.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))).toBe(true);
        }
      }
    });
    expect(readClipboardPayload).not.toHaveBeenCalled();
    expect(writeClipboardItems).not.toHaveBeenCalled();
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0].objects).toEqual(drawing.pages[0].objects);
  });

  it("preserves canvas clipboard handling for native menu actions", async () => {
    await mount();
    for (const operation of ["paste", "copy", "cut"]) {
      await act(async () => {
        const before = new Event(`before${operation}`, { bubbles: true, cancelable: true });
        expect(document.body.dispatchEvent(before)).toBe(platform !== "linux");
        const event = new Event(operation, { bubbles: true, cancelable: true });
        expect(document.body.dispatchEvent(event)).toBe(false);
      });
    }
    expect(readClipboardPayload).toHaveBeenCalledOnce();
    expect(writeClipboardItems).toHaveBeenCalledTimes(2);
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0].objects).toEqual([]);
  });

  it.each(["event", "command"])("%s copy sends the prepared image and JSON in one transaction", async path => {
    const drawing = await mount();
    if (path === "event") {
      const event = new Event("copy", { bubbles: true, cancelable: true });
      await act(async () => { window.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(true);
    } else await command("clipboard.copy");
    expect(selectionClipboardImageItems).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ pages: drawing.pages }), createSelectionClipboardPayload(drawing), platform);
    expect(writeClipboardItems).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ type: CHEMDRAFT_SELECTION_CLIPBOARD_TYPE }),
      expect.objectContaining({ type: "image/png", required: true })
    ]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Copied ChemDraft selection");
  });
  it.each(["render", "write"])("does not cut when the required image %s fails", async failure => {
    const drawing = await mount();
    if (failure === "render") vi.mocked(selectionClipboardImageItems).mockRejectedValue(new Error("Rasterizer unavailable"));
    else vi.mocked(writeClipboardItems).mockResolvedValue({ ok: false, written: [CHEMDRAFT_SELECTION_CLIPBOARD_TYPE],
      failed: [{ type: "image/png", reason: "clipboard busy" }], warnings: [] });
    await command("clipboard.cut");
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0].objects).toEqual(drawing.pages[0].objects);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Cut canceled");
    if (failure === "render") expect(writeClipboardItems).not.toHaveBeenCalled();
  });
  it.each(["copy", "cut"] as const)("%s forwards all prepared mixed-selection flavors in one transaction", async mode => {
    const drawing = insertNativeTextObject(source(), { x: 20, y: 20 }, "Reaction conditions");
    const selected = { ...drawing, selection: { ...drawing.selection,
      objectIds: drawing.pages[0].objects.map(object => object.id) } };
    const payload = createSelectionClipboardPayload(selected)!;
    expect(payload.objects.map(object => object.type)).toEqual(["molecule", "text"]);
    const items = [
      { type: CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, text: serializeSelectionClipboardPayload(payload), required: true },
      { type: "image/png", bytes: Uint8Array.from([137, 80]), required: true },
      { type: "image/svg+xml", text: "<svg/>", required: false },
      ...(platform === "macos" ? [
        { type: "public.svg-image", text: "<svg/>", required: false },
        { type: "application/pdf", bytes: Uint8Array.from([37, 80, 68, 70]), required: false }
      ] : []),
      { type: "text/plain", text: "Reaction conditions", required: false }
    ];
    vi.mocked(selectionClipboardImageItems).mockResolvedValue({ items, warnings: [] });
    await mount(selected);
    await command(`clipboard.${mode}`);
    expect(selectionClipboardImageItems).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ pages: selected.pages }), payload, platform);
    expect(writeClipboardItems).toHaveBeenCalledExactlyOnceWith(items);
    const objects = window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0].objects;
    expect(objects).toEqual(mode === "copy" ? selected.pages[0].objects : []);
  });
  it("retains readable plain text for a text-only selection", async () => {
    await mount(insertNativeTextObject(createPhase4Document(), { x: 20, y: 20 }, "Reaction conditions"));
    await command("clipboard.copy");
    expect(selectionClipboardImageItems).not.toHaveBeenCalled();
    expect(writeClipboardItems).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ type: CHEMDRAFT_SELECTION_CLIPBOARD_TYPE }),
      { type: "text/plain", text: "Reaction conditions" }
    ]);
  });
  it("retains editable Office HTML and RTF for a table-only selection", async () => {
    const drawing = deserializeDocument(readFileSync("packages/fixtures/tables/sharpless-reagent-table.json", "utf8"));
    drawing.selection = { pageId: drawing.pages[0].id, objectIds: [drawing.pages[0].objects[0].id] };
    await mount(drawing);
    await command("clipboard.copy");
    expect(selectionClipboardImageItems).not.toHaveBeenCalled();
    expect(vi.mocked(writeClipboardItems).mock.calls[0][0].map(item => item.type)).toEqual([
      CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, "text/html", "text/rtf", "text/plain"
    ]);
  });
});
