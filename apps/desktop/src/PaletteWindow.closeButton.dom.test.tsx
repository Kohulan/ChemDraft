// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { PaletteWindow } from "./PaletteWindow";

const native = vi.hoisted(() => ({
  close: vi.fn(async (_toolsetId: string) => {}),
  drag: vi.fn(async (_x: number, _y: number) => {})
}));
vi.mock("./window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("./window-manager")>(),
  closeToolsetWindow: native.close,
  startPaletteWindowDrag: native.drag,
  setPaletteCommandHitBoxes: vi.fn(async () => {}),
  setCurrentWindowLogicalSize: vi.fn(async () => {}),
  setCurrentWindowLogicalPosition: vi.fn(async () => {})
}));
vi.mock("./plugins/pluginPanelInputFocus", async importOriginal => ({
  ...await importOriginal<typeof import("./plugins/pluginPanelInputFocus")>(),
  installPaletteInputFocus: () => () => {}
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement, root: Root | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
});

async function renderPalette(platform: ShortcutPlatform) {
  await act(async () => root!.render(createElement(PaletteWindow, { toolsetId: "core.main", platform })));
  const title = container.querySelector<HTMLElement>(".palette-title")!;
  const button = title.querySelector<HTMLButtonElement>("button.palette-close-button")!;
  expect(button).not.toBeNull();
  return { title, button };
}

function press(target: Element, type: "pointerdown" | "mousedown" | "pointerup" | "mouseup") {
  // jsdom has no PointerEvent constructor; React dispatches on the event type, so a MouseEvent works
  // once it carries the pointer fields the handlers read.
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
  if (type.startsWith("pointer")) {
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  }
  target.dispatchEvent(event);
}

describe("floating palette close control", () => {
  it("on Windows is a labelled × at the top right that closes once on click without starting a drag", async () => {
    const { title, button } = await renderPalette("windows");

    expect(title.dataset.platform).toBe("windows");
    expect(button.classList.contains("palette-close-button--end")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Close Main");
    expect(button.title).toBe("Close");
    expect(button.textContent).toBe("×");

    // A full press-and-release: the press must neither close nor start a window drag.
    await act(async () => {
      press(button, "pointerdown");
      press(button, "mousedown");
    });
    expect(native.drag).not.toHaveBeenCalled();
    expect(native.close).not.toHaveBeenCalled();

    await act(async () => {
      press(button, "pointerup");
      press(button, "mouseup");
      button.click();
    });
    expect(native.close).toHaveBeenCalledTimes(1);
    expect(native.close).toHaveBeenCalledWith("core.main");
    expect(native.drag).not.toHaveBeenCalled();
  });

  it("on macOS keeps the left stoplight dot with its existing label and close path", async () => {
    const { title, button } = await renderPalette("macos");

    expect(title.dataset.platform).toBe("macos");
    expect(button.className).toBe("palette-close-button");
    expect(button.getAttribute("aria-label")).toBe("Hide Main Toolbar");
    expect(button.title).toBe("Hide Main Toolbar");
    expect(button.textContent).toBe("");

    await act(async () => press(button, "mousedown"));
    expect(native.drag).not.toHaveBeenCalled();
    expect(native.close).not.toHaveBeenCalled();

    await act(async () => button.click());
    expect(native.close).toHaveBeenCalledTimes(1);
    expect(native.close).toHaveBeenCalledWith("core.main");
    expect(native.drag).not.toHaveBeenCalled();
  });

  it.each(["windows", "macos"] as const)("still starts a drag from the title label on %s", async (platform) => {
    const { title } = await renderPalette(platform);

    await act(async () => press(title.querySelector(".palette-title-label")!, "mousedown"));
    expect(native.drag).toHaveBeenCalledTimes(1);
    expect(native.close).not.toHaveBeenCalled();
  });
});
