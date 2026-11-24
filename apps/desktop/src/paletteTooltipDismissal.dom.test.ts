// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createPaletteTooltipDismissal,
  dispatchPaletteTooltipDismiss,
  LINUX_PALETTE_TOOLTIP_IDLE_HIDE_MS
} from "./paletteTooltipDismissal";
import { PALETTE_TOOLTIP_DISMISS_DOM_EVENT } from "./toolbars/toolbarTooltip";

let leave: (() => void) | undefined;
const unsubscribe = vi.fn();
const subscribePointerLeave = vi.fn(async (handler: () => void) => {
  leave = handler;
  return unsubscribe;
});

beforeEach(() => {
  vi.useFakeTimers();
  leave = undefined;
  unsubscribe.mockClear();
  subscribePointerLeave.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["macos", "windows"] as const)("does nothing on %s", async platform => {
  const dismiss = vi.fn();
  const addListener = vi.spyOn(window, "addEventListener");
  const dismissal = createPaletteTooltipDismissal({ platform, dismiss, subscribePointerLeave });
  dismissal.shown();
  await vi.advanceTimersByTimeAsync(LINUX_PALETTE_TOOLTIP_IDLE_HIDE_MS * 2);
  expect(subscribePointerLeave).not.toHaveBeenCalled();
  expect(addListener).not.toHaveBeenCalled();
  expect(dismiss).not.toHaveBeenCalled();
  dismissal.dispose();
});

it("on Linux dismisses on the native leave, even with no tooltip announced", async () => {
  const dismiss = vi.fn();
  const dismissal = createPaletteTooltipDismissal({ platform: "linux", dismiss, subscribePointerLeave });
  await vi.advanceTimersByTimeAsync(0);
  leave!();
  expect(dismiss).toHaveBeenCalledTimes(1);
  dismissal.dispose();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  leave!();
  expect(dismiss).toHaveBeenCalledTimes(1);
});

it("on Linux dismisses when the page is hidden", async () => {
  const dismiss = vi.fn();
  const dismissal = createPaletteTooltipDismissal({ platform: "linux", dismiss, subscribePointerLeave });
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(dismiss).not.toHaveBeenCalled();
  visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(dismiss).toHaveBeenCalledTimes(1);
  dismissal.dispose();
});

it("on Linux hides an idle tooltip as a last resort; pointer movement restarts the countdown", async () => {
  const dismiss = vi.fn();
  const dismissal = createPaletteTooltipDismissal({ platform: "linux", dismiss, subscribePointerLeave });
  // No tooltip up: the countdown is not running and movement does not start it.
  window.dispatchEvent(new Event("pointermove"));
  await vi.advanceTimersByTimeAsync(LINUX_PALETTE_TOOLTIP_IDLE_HIDE_MS * 2);
  expect(dismiss).not.toHaveBeenCalled();

  dismissal.shown();
  await vi.advanceTimersByTimeAsync(LINUX_PALETTE_TOOLTIP_IDLE_HIDE_MS - 1);
  window.dispatchEvent(new Event("mousemove"));
  await vi.advanceTimersByTimeAsync(LINUX_PALETTE_TOOLTIP_IDLE_HIDE_MS - 1);
  expect(dismiss).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(dismiss).toHaveBeenCalledTimes(1);

  // A normal hide stops the countdown.
  dismissal.shown();
  dismissal.hidden();
  await vi.advanceTimersByTimeAsync(LINUX_PALETTE_TOOLTIP_IDLE_HIDE_MS * 2);
  expect(dismiss).toHaveBeenCalledTimes(1);

  dismissal.shown();
  dismissal.dispose();
  await vi.advanceTimersByTimeAsync(LINUX_PALETTE_TOOLTIP_IDLE_HIDE_MS * 2);
  expect(dismiss).toHaveBeenCalledTimes(1);
});

it("drops a native leave subscription that resolves after dispose", async () => {
  const dismissal = createPaletteTooltipDismissal({ platform: "linux", dismiss: vi.fn(), subscribePointerLeave });
  dismissal.dispose();
  await vi.advanceTimersByTimeAsync(0);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it("broadcasts the dismiss event the palette tooltip state listens for", () => {
  const listener = vi.fn();
  window.addEventListener(PALETTE_TOOLTIP_DISMISS_DOM_EVENT, listener);
  dispatchPaletteTooltipDismiss();
  window.removeEventListener(PALETTE_TOOLTIP_DISMISS_DOM_EVENT, listener);
  expect(listener).toHaveBeenCalledTimes(1);
});
