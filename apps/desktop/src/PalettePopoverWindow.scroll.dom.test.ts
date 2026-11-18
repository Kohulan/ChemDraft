// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import { installNativeFlyoutKeyboard } from "./nativeFlyoutKeyboard";
import type {
  AcceptedToolsetPopoverOpening, ToolsetFlyoutKey, ToolsetFlyoutSession, ToolsetPopoverContentPayload,
  ToolsetPopoverDismissPayload
} from "./window-manager";

const native = vi.hoisted(() => ({
  content: undefined as undefined | ((payload: ToolsetPopoverContentPayload) => void),
  accepted: undefined as undefined | ((payload: AcceptedToolsetPopoverOpening) => void),
  receiveClose: undefined as undefined | ((payload: ToolsetFlyoutSession) => void),
  dismiss: undefined as undefined | ((payload?: ToolsetPopoverDismissPayload) => void),
  key: undefined as undefined | ((payload: ToolsetFlyoutKey) => void),
  release: undefined as undefined | ((payload: { toolsetId: string; releasedAt: number }) => void),
  resized: undefined as undefined | (() => void),
  show: vi.fn(async () => {}), size: vi.fn(async () => {}), invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => {}),
  command: vi.fn(async () => {}), closed: vi.fn(async () => {}), flyoutClosed: vi.fn(async () => {}),
  sendKey: vi.fn(async (_payload: ToolsetFlyoutKey) => {})
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ hide: async () => {}, setFocus: async () => {} }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setFocus: async () => {} }) }));
vi.mock("./plugins/pluginPanelInputFocus", async importOriginal => ({
  ...await importOriginal<typeof import("./plugins/pluginPanelInputFocus")>(),
  installPaletteInputFocus: () => () => {}
}));
vi.mock("./window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("./window-manager")>(),
  listenForToolsetPopoverContent: vi.fn(async handler => { native.content = handler; return () => {}; }),
  listenForAcceptedToolsetPopoverContent: vi.fn(async handler => {
    native.accepted = handler;
    return () => { native.accepted = undefined; };
  }),
  notifyToolsetPopoverContentAccepted: async (opening: AcceptedToolsetPopoverOpening) => native.accepted?.(opening),
  listenForToolsetPopoverRelease: vi.fn(async handler => { native.release = handler; return () => {}; }),
  listenForToolsetFlyoutKeys: vi.fn(async handler => { native.key = handler; return () => {}; }),
  listenForToolsetFlyoutClosed: vi.fn(async handler => { native.receiveClose = handler; return () => {}; }),
  sendToolsetFlyoutKey: native.sendKey,
  notifyToolsetPopoverClosed: native.closed, notifyToolsetFlyoutClosed: native.flyoutClosed,
  sendPaletteCommand: native.command,
  listenForToolsetPopoverDismiss: vi.fn(async handler => { native.dismiss = handler; return () => {}; }),
  listenForBondStereoPopoverActions: vi.fn(async () => () => {}),
  listenForToolsetTextStyle: vi.fn(async () => () => {}),
  requestToolsetPopoverContent: vi.fn(async () => {}), requestToolsetTextStyle: vi.fn(async () => {}),
  setCurrentWindowLogicalSize: native.size, setCurrentWindowLogicalPosition: vi.fn(async () => {}),
  showCurrentToolsetPopoverWindow: native.show
}));

let root: Root, container: HTMLDivElement;
const host = window as typeof window & { __TAURI__?: unknown };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.useFakeTimers();
  host.__TAURI__ = {};
  vi.stubGlobal("__WORKTREE_LABEL__", "flyout [test]");
  vi.stubGlobal("visualViewport", { offsetTop: 28, height: 62 });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { native.resized = callback; }
    observe() {} disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 0, left: 0, width: 90, height: 90, bottom: 90, right: 90, x: 0, y: 0, toJSON() {}
  });
  Object.defineProperty(document, "scrollingElement", { configurable: true, value: document.documentElement });
  container = document.createElement("div"); container.id = "root";
  document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); delete host.__TAURI__;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
const rings: ToolsetPopoverContentPayload = { toolsetId: "core.main", kind: "flyout", openedAt: 1,
  flyout: { flyoutId: "rings", title: "Rings", columns: 3, commands: Array.from({ length: 9 }, (_, i) => ({
    id: `ring-${i}`, title: `Ring ${i}`, enabled: true, active: false
  })) } };
const ringSession = { toolsetId: rings.toolsetId, flyoutId: rings.flyout.flyoutId, openedAt: 1 };
function acceptContent(payload: ToolsetPopoverContentPayload) {
  native.accepted?.({ toolsetId: payload.toolsetId, openedAt: payload.openedAt!, generation: payload.generation,
    flyoutId: payload.kind === "flyout" ? payload.flyout.flyoutId : undefined });
}
function pressFlyoutArrow() {
  const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
function elements() {
  return [document.documentElement, document.body, container,
    container.querySelector<HTMLElement>(".palette-popover-shell")!,
    container.querySelector<HTMLElement>('[role="menu"]')!].filter(Boolean);
}
function offset() { for (const element of elements()) { element.scrollTop = 28; element.scrollLeft = 8; } }
function expectReset() { for (const element of elements()) { expect(element.scrollTop).toBe(0); expect(element.scrollLeft).toBe(0); } }
function records() {
  return native.invoke.mock.calls.filter(([command]) => command === "perf_log_append")
    .map(call => JSON.parse((call as unknown as [string, { line: string }])[1].line));
}

it("clears retained document/root/shell scrolling on content update, fit and reveal", async () => {
  await act(async () => root.render(createElement(PalettePopoverWindow, { toolsetId: "core.main", kind: "flyout", prewarm: true })));
  offset();
  let finishReveal!: () => void;
  native.show.mockImplementationOnce(() => new Promise<void>(resolve => { finishReveal = resolve; }));
  await act(async () => native.content?.(rings));
  expectReset();
  expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(9);
  offset();
  await act(async () => finishReveal());
  expectReset();
  expect(records().filter(record => record.geometry.phase === "reveal")).toEqual([
    expect.objectContaining({ event: "toolset-popover-geometry", geometry: {
      phase: "reveal",
      beforeReset: expect.objectContaining({ scrollTop: 28, shellScrollTop: 28 }),
      afterReset: expect.objectContaining({ scrollTop: 0, shellTop: 0, shellHeight: 90,
        innerHeight: window.innerHeight, scrollY: 0, documentTop: 0,
        visualViewportOffsetTop: 28, visualViewportHeight: 62 })
    } })]);
  offset();
  await act(async () => native.resized?.());
  expectReset();
  offset();
  await act(async () => native.content?.({ ...rings, generation: 2, flyout: { ...rings.flyout, title: "Updated rings" } }));
  expectReset();
});

it("samples the owner's release offset before resetting it, and ignores another palette's release", async () => {
  await act(async () => root.render(createElement(PalettePopoverWindow, { toolsetId: "core.main", kind: "flyout", prewarm: true })));
  await act(async () => native.content?.(rings));
  offset();
  await act(async () => { native.release?.({ toolsetId: "core.art", releasedAt: 2 }); await vi.advanceTimersByTimeAsync(0); });
  expect(records()).toHaveLength(1);
  await act(async () => { native.release?.({ toolsetId: "core.main", releasedAt: 2 }); await vi.advanceTimersByTimeAsync(0); });
  expect(records()[1].geometry).toMatchObject({ phase: "release",
    beforeReset: { scrollTop: 28, shellScrollTop: 28 }, afterReset: { scrollTop: 0, shellScrollTop: 0 } });
  expectReset();
  offset();
  document.documentElement.dispatchEvent(new Event("scroll"));
  expectReset();
  expect(records().at(-1).geometry).toMatchObject({ phase: "guard",
    beforeReset: { scrollTop: 28, shellScrollTop: 28 }, afterReset: { scrollTop: 0, shellScrollTop: 0 } });
  await act(async () => { native.release?.({ toolsetId: "core.main", releasedAt: 3 }); await vi.advanceTimersByTimeAsync(0); });
  // A capture-phase repair before release must leave its original offset in the preceding record.
  expect(records().at(-1).geometry).toMatchObject({ phase: "release", beforeReset: { scrollTop: 0 } });
});

it("keeps scroll guards active but diagnostics silent in an unlabelled stable build", async () => {
  vi.stubGlobal("__WORKTREE_LABEL__", "");
  await act(async () => root.render(createElement(PalettePopoverWindow, { toolsetId: "core.main", kind: "flyout", prewarm: true })));
  await act(async () => native.content?.(rings));
  offset();
  document.documentElement.dispatchEvent(new Event("scroll"));
  expectReset();
  await act(async () => { native.release?.({ toolsetId: "core.main", releasedAt: 2 }); await vi.advanceTimersByTimeAsync(0); });
  expect(records()).toEqual([]);
});

it("sends the live content kind on each reveal of a prewarmed Art popover", async () => {
  await act(async () => root.render(createElement(PalettePopoverWindow, { toolsetId: "core.art", kind: "artColor", prewarm: true })));
  expect(native.show).not.toHaveBeenCalled();
  await act(async () => native.content?.({ toolsetId: "core.art", kind: "artColor", openedAt: 0 }));
  expect(native.show).toHaveBeenLastCalledWith("focus", "artColor");
  await act(async () => native.content?.({ ...rings, toolsetId: "core.art" }));
  // Command navigation is routed from the document; even a failed native reveal
  // must not fall back to an activating show for this flyout.
  expect(native.show).toHaveBeenLastCalledWith("preserve", "flyout");
  await act(async () => native.content?.({ toolsetId: "core.art", kind: "artColor", openedAt: 2 }));
  expect(native.show).toHaveBeenLastCalledWith("focus", "artColor");
});

it("closes both flyout channels and resets keyboard navigation for a newer opening at the same timestamp", async () => {
  await act(async () => root.render(createElement(PalettePopoverWindow, { toolsetId: "core.main", kind: "flyout", prewarm: true })));
  const first = { ...rings, generation: 1 };
  const key = { toolsetId: "core.main", flyoutId: "rings", openedAt: 1, generation: 1, key: "ArrowDown" };
  await act(async () => native.content?.(first));
  await act(async () => native.key?.(key));
  expect(container.querySelector('[data-keyboard-highlighted="true"]')?.getAttribute("data-command-id")).toBe("ring-0");
  await act(async () => {
    native.key?.({ ...key, key: "Enter" });
    native.key?.({ ...key, key: "Enter" });
  });
  expect(native.command).toHaveBeenCalledExactlyOnceWith("ring-0");
  expect(native.closed).toHaveBeenCalledExactlyOnceWith("core.main", 1, 1);
  expect(native.flyoutClosed).toHaveBeenCalledExactlyOnceWith({ toolsetId: "core.main", flyoutId: "rings", openedAt: 1, generation: 1 });
  const reveals = native.show.mock.calls.length;
  await act(async () => native.content?.(first));
  expect(native.show).toHaveBeenCalledTimes(reveals);
  await act(async () => native.content?.({ ...first, generation: 2 }));
  expect(native.show).toHaveBeenCalledTimes(reveals + 1);
  expect(native.show).toHaveBeenLastCalledWith("preserve", "flyout");
  expect(container.querySelector('[data-keyboard-highlighted="true"]')).toBeNull();
  await act(async () => native.key?.({ ...key, generation: 2 }));
  expect(container.querySelector('[data-keyboard-highlighted="true"]')?.getAttribute("data-command-id")).toBe("ring-0");
});

it.each(["before", "after"])("routes keys to a newer same-time flyout when the old close arrives %s its opening", order => {
  const stop = installNativeFlyoutKeyboard();
  const press = () => {
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    const current = { toolsetId: rings.toolsetId, flyoutId: rings.flyout.flyoutId, openedAt: 1, generation: 2 };
    const closeOld = () => native.receiveClose?.({ ...current, generation: 1 });
    acceptContent({ ...rings, generation: 1 });
    if (order === "before") closeOld();
    acceptContent({ ...rings, generation: 2 });
    if (order === "after") closeOld();
    expect(press()).toBe(true);
    expect(native.sendKey).toHaveBeenCalledOnce();
    native.receiveClose?.(current);
    expect(press()).toBe(false);
    acceptContent({ ...rings, generation: 3 });
    expect(press()).toBe(true);
    // Old senders identify their close by timestamp.
    native.receiveClose?.({ toolsetId: current.toolsetId, flyoutId: current.flyoutId, openedAt: current.openedAt });
    expect(press()).toBe(false);
  } finally { stop(); }
});

it.each(["rings", "other"])("retires a superseded flyout when the newer %s close arrives before its content", flyoutId => {
  const stop = installNativeFlyoutKeyboard();
  const replacement = { ...rings, flyout: { ...rings.flyout, flyoutId } };
  try {
    acceptContent({ ...rings, generation: 1 });
    expect(pressFlyoutArrow()).toBe(true);
    native.receiveClose?.({ ...ringSession, flyoutId, generation: 2 });
    const routedBeforeContent = pressFlyoutArrow();
    acceptContent({ ...replacement, generation: 2 });
    expect([routedBeforeContent, pressFlyoutArrow()]).toEqual([false, false]);
    acceptContent({ ...replacement, generation: 3 });
    expect(pressFlyoutArrow()).toBe(true);
  } finally { stop(); }
});

it("scopes same-time opening and close generations to each toolset", () => {
  const { flyoutId } = ringSession;
  const toolsetId = "core.art";
  const stop = installNativeFlyoutKeyboard();
  try {
    acceptContent({ ...rings, generation: 9 });
    const next = { ...rings, toolsetId, generation: 1, flyout: { ...rings.flyout, flyoutId } };
    acceptContent(next);
    expect(pressFlyoutArrow()).toBe(true);
    expect(native.sendKey).toHaveBeenLastCalledWith(expect.objectContaining({ toolsetId, flyoutId }));
    acceptContent({ ...rings, generation: 9 });
    expect(pressFlyoutArrow()).toBe(true);
    expect(native.sendKey).toHaveBeenLastCalledWith(expect.objectContaining({ toolsetId, flyoutId }));
    native.receiveClose?.({ ...ringSession, generation: 9 });
    acceptContent(next);
    expect(pressFlyoutArrow()).toBe(true);
    expect(native.sendKey).toHaveBeenLastCalledWith(expect.objectContaining({ toolsetId, flyoutId }));
  } finally { stop(); }
});

it("keeps the newer menu when an older menu from the same toolset arrives late", () => {
  const stop = installNativeFlyoutKeyboard();
  try {
    acceptContent({ ...rings, generation: 2 });
    const delayed = { ...rings, generation: 1, flyout: { ...rings.flyout, flyoutId: "other" } };
    acceptContent(delayed);
    expect(pressFlyoutArrow()).toBe(true);
    expect(native.sendKey).toHaveBeenCalledExactlyOnceWith({ ...ringSession, generation: 2, key: "ArrowDown" });
  } finally { stop(); }
});

it("retains the generation through a legacy replay so queued Enter cannot choose from a replacement", async () => {
  await act(async () => root.render(createElement(PalettePopoverWindow, { toolsetId: rings.toolsetId, kind: "flyout", prewarm: true })));
  const stop = installNativeFlyoutKeyboard();
  try {
    await act(async () => {
      for (const opening of [{ ...rings, generation: 2 }, rings]) native.content?.(opening);
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const [queuedEnter] = native.sendKey.mock.lastCall!;
    await act(async () => {
      native.content?.({ ...rings, generation: 3 });
      native.key?.({ ...ringSession, generation: 3, key: "ArrowDown" });
    });
    expect(container.querySelector('[data-keyboard-highlighted="true"]')?.getAttribute("data-command-id")).toBe("ring-0");
    await act(async () => native.key?.(queuedEnter));
    expect(native.command).not.toHaveBeenCalled();
    expect(queuedEnter.generation).toBe(2);
  } finally { stop(); }
});

it("forwards keys with the generation of the active flyout", () => {
  const stop = installNativeFlyoutKeyboard();
  try {
    acceptContent({ ...rings, generation: 2 });
    expect(pressFlyoutArrow()).toBe(true);
    expect(native.sendKey).toHaveBeenCalledExactlyOnceWith({ ...ringSession, generation: 2, key: "ArrowDown" });
  } finally { stop(); }
});

it("ignores queued arrow and activation keys from a stale flyout generation", async () => {
  await act(async () => root.render(createElement(PalettePopoverWindow, { toolsetId: rings.toolsetId, kind: "flyout", prewarm: true })));
  await act(async () => native.content?.({ ...rings, generation: 2 }));
  await act(async () => native.key?.({ ...ringSession, generation: 1, key: "ArrowDown" }));
  expect(container.querySelector('[data-keyboard-highlighted="true"]')).toBeNull();
  await act(async () => native.key?.({ ...ringSession, generation: 2, key: "ArrowDown" }));
  expect(container.querySelector('[data-keyboard-highlighted="true"]')?.getAttribute("data-command-id")).toBe("ring-0");
  await act(async () => native.key?.({ ...ringSession, generation: 1, key: "Enter" }));
  expect(native.command).not.toHaveBeenCalled();
  await act(async () => native.key?.({ ...ringSession, generation: 2, key: "Enter" }));
  expect(native.command).toHaveBeenCalledExactlyOnceWith("ring-0");
});

it.each([1, undefined])("retains a newer same-time flyout after targeted Escape generation %s and honors broadcasts", generation => {
  const stop = installNativeFlyoutKeyboard();
  const target = { toolsetId: rings.toolsetId, openedAt: 1 };
  try {
    acceptContent({ ...rings, generation: 2 });
    native.dismiss?.({ requestedAt: 2, reason: "escape", openings: [{ ...target, generation }] });
    expect(pressFlyoutArrow()).toBe(true);
    native.dismiss?.({ requestedAt: 2, reason: "escape", openings: [{ ...target, toolsetId: "core.art", generation: 2 }] });
    expect(pressFlyoutArrow()).toBe(true);
    native.dismiss?.({ requestedAt: 2, reason: "escape", openings: [{ ...target, generation: 2 }] });
    expect(pressFlyoutArrow()).toBe(false);
    acceptContent({ ...rings, generation: 2 });
    expect(pressFlyoutArrow()).toBe(false);
    acceptContent({ ...rings, generation: 3 });
    expect(pressFlyoutArrow()).toBe(true);
    native.dismiss?.({ requestedAt: 1 });
    expect(pressFlyoutArrow()).toBe(false);
  } finally { stop(); }
});

it("focuses keyboard flyout choices and traverses Tab without scrolling", async () => {
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  await act(async () => root.render(createElement(PalettePopoverWindow, { toolsetId: "core.bondStereo", kind: "flyout", prewarm: true })));
  await act(async () => native.content?.({ ...rings, toolsetId: "core.bondStereo",
    flyout: { ...rings.flyout, id: "stereo", variant: "bondStereo", keyboardOpen: true } }));
  expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  expect(focus).toHaveBeenCalledTimes(2);
  expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
});

it("disables overflow and scroll anchoring only in the popover document and shell", () => {
  const css = readFileSync("apps/desktop/src/App.css", "utf8");
  for (const selector of ["body.palette-popover-window-body #root", ".palette-popover-shell"]) {
    const rule = css.slice(css.indexOf(`${selector} {`)).split("}")[0];
    expect(rule).toContain("overflow: hidden");
    expect(rule).toContain("overflow-anchor: none");
  }
});
