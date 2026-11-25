// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaletteWindow } from "./PaletteWindow";
import { PALETTE_TOOLTIP_DISMISS_DOM_EVENT, TOOLTIP_DELAY_MS } from "./toolbars/toolbarTooltip";

// The macOS palettes never receive hover natively: Rust's pointer feed pushes positions and a
// leave, and PaletteWindow synthesizes pointerover/out. These tests drive that feed directly.
const native = vi.hoisted(() => {
  // Every subscriber to the native leave: on Linux the PR #488 dismissal listens too.
  const leaves = new Set<() => void>();
  return {
    move: undefined as ((payload: { x: number; y: number }) => void) | undefined,
    leaves,
    leave: () => { for (const handler of [...leaves]) handler(); },
    position: vi.fn(async () => ({ x: 100, y: 100 })),
    showTooltip: vi.fn(async () => {}),
    hideTooltip: vi.fn(async () => {})
  };
});
vi.mock("./window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("./window-manager")>(),
  currentWindowLogicalPosition: native.position,
  showPaletteFloatingTooltip: native.showTooltip,
  hidePaletteFloatingTooltip: native.hideTooltip,
  listenForPalettePointer: vi.fn(async (_toolsetId: string, handler: (payload: { x: number; y: number }) => void) => {
    native.move = handler;
    return () => { native.move = undefined; };
  }),
  listenForPalettePointerLeave: vi.fn(async (_toolsetId: string, handler: () => void) => {
    native.leaves.add(handler);
    return () => { native.leaves.delete(handler); };
  })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each(["macos", "windows", "linux"] as const)("palette tooltip dismissal on the pointer feed's leave on %s", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let underPointer: Element | null = null;
  const originalElementFromPoint = document.elementFromPoint;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    underPointer = null;
    document.elementFromPoint = () => underPointer;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(PaletteWindow, { toolsetId: "core.art", platform })));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.elementFromPoint = originalElementFromPoint;
    vi.useRealTimers();
  });

  async function hoverTooltipOwner(): Promise<HTMLElement> {
    const owner = container.querySelector<HTMLElement>("[data-tooltip-owner-id]");
    expect(owner).not.toBeNull();
    expect(native.move).toBeDefined();
    underPointer = owner;
    await act(async () => native.move!({ x: 4, y: 4 }));
    await act(async () => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 10); });
    expect(owner!.dataset.tooltipVisible).toBe("true");
    expect(native.showTooltip).toHaveBeenCalledTimes(1);
    // Named so Rust can hide it when this palette closes, and refuse it once the palette is gone.
    expect(native.showTooltip).toHaveBeenCalledWith(expect.objectContaining({ sourceToolsetId: "core.art" }));
    return owner!;
  }

  it("dismisses the tooltip when the native leave arrives, dispatching the dismissal once", async () => {
    const owner = await hoverTooltipOwner();
    const dismissals = vi.fn();
    window.addEventListener(PALETTE_TOOLTIP_DISMISS_DOM_EVENT, dismissals);
    try {
      await act(async () => native.leave());
    } finally {
      window.removeEventListener(PALETTE_TOOLTIP_DISMISS_DOM_EVENT, dismissals);
    }
    expect(owner.dataset.tooltipVisible).toBeUndefined();
    expect(native.hideTooltip).toHaveBeenCalled();
    // Linux keeps PR #488's dismissal as the only one; elsewhere the pointer feed's leave sends it.
    expect(dismissals).toHaveBeenCalledTimes(1);
  });

  it("dismisses the tooltip on the native leave even when the synthetic pointerout cannot reach React", async () => {
    const owner = await hoverTooltipOwner();
    // A pointerout on a node React no longer renders never reaches its onPointerLeave. Model it by
    // stopping this palette's pointerout at the window before React's root listener sees it.
    const swallow = (event: Event) => event.stopPropagation();
    window.addEventListener("pointerout", swallow, true);
    try {
      await act(async () => native.leave());
    } finally {
      window.removeEventListener("pointerout", swallow, true);
    }
    expect(owner.dataset.tooltipVisible).toBeUndefined();
    expect(native.hideTooltip).toHaveBeenCalled();
  });

  it("dismisses the tooltip when the hovered node was re-rendered away under a moving cursor", async () => {
    const owner = await hoverTooltipOwner();
    // The node last under the cursor is no longer in the document, so its pointerout never
    // reaches React. Model that without tearing React's tree: report the node as detached and
    // stop its pointerout before React's root listener sees it.
    Object.defineProperty(owner, "isConnected", { configurable: true, get: () => false });
    const swallow = (event: Event) => event.stopPropagation();
    window.addEventListener("pointerout", swallow, true);
    try {
      underPointer = container;
      await act(async () => native.move!({ x: 6, y: 6 }));
    } finally {
      window.removeEventListener("pointerout", swallow, true);
      delete (owner as { isConnected?: boolean }).isConnected;
    }
    expect(owner.dataset.tooltipVisible).toBeUndefined();
    expect(native.hideTooltip).toHaveBeenCalled();
  });
});
