import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { PALETTE_TOOLTIP_DISMISS_DOM_EVENT } from "./toolbars/toolbarTooltip";

/** Clear the tooltip state of every palette shell in `target` (usePaletteTooltipState). */
export function dispatchPaletteTooltipDismiss(target: Window = window): void {
  target.dispatchEvent(new Event(PALETTE_TOOLTIP_DISMISS_DOM_EVENT));
}

/**
 * Linux last resort (B5): hide a palette tooltip after this long without pointer movement in its
 * palette. Windows' own tooltips pop down after a similar time. The native leave below normally
 * hides it much sooner; this only catches a leave nothing reported.
 */
export const LINUX_PALETTE_TOOLTIP_IDLE_HIDE_MS = 8000;

export interface PaletteTooltipDismissal {
  /** A tooltip was announced for this palette: arm the idle timeout. */
  shown(): void;
  /** The tooltip was hidden through the normal path: disarm the idle timeout. */
  hidden(): void;
  dispose(): void;
}

const inactiveDismissal: PaletteTooltipDismissal = {
  shown: () => undefined,
  hidden: () => undefined,
  dispose: () => undefined
};

/**
 * Linux only (B5). On KDE/XWayland a palette tooltip stayed on screen for 10 s or more after the
 * pointer left the palette, when another window covered the palette, or when the pointer jumped
 * straight to another window: WebKitGTK did not always deliver a DOM pointerleave for those, and
 * the tooltip cleared only on the next palette hover. Call `dismiss` when any of these says the
 * pointer has gone:
 * - the native leave Rust reports from the palette's GtkWindow (`subscribePointerLeave`; a GDK
 *   leave-notify, which X11 also sends when another window is mapped over the pointer);
 * - the page being hidden (the palette closed, minimized or suspended for a native dialog);
 * - as a last resort, `idleHideMs` without pointer movement in the palette while a tooltip is up.
 * macOS and Windows get an inert object and keep their existing hide paths unchanged.
 */
export function createPaletteTooltipDismissal(options: {
  platform: ShortcutPlatform;
  dismiss: () => void;
  subscribePointerLeave: (handler: () => void) => Promise<() => void>;
  target?: Window;
  idleHideMs?: number;
}): PaletteTooltipDismissal {
  if (options.platform !== "linux") return inactiveDismissal;
  const target = options.target ?? window;
  const doc = target.document;
  const idleHideMs = options.idleHideMs ?? LINUX_PALETTE_TOOLTIP_IDLE_HIDE_MS;
  let disposed = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;

  const disarm = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const dismiss = () => {
    if (disposed) return;
    disarm();
    options.dismiss();
  };
  const arm = () => {
    disarm();
    idleTimer = setTimeout(dismiss, idleHideMs);
  };
  // Movement inside the palette proves the pointer is still here: restart the countdown.
  const pointerMoved = () => {
    if (idleTimer !== undefined) arm();
  };
  const visibilityChanged = () => {
    if (doc.visibilityState === "hidden") dismiss();
  };

  target.addEventListener("pointermove", pointerMoved, true);
  target.addEventListener("mousemove", pointerMoved, true);
  doc.addEventListener("visibilitychange", visibilityChanged);
  void options.subscribePointerLeave(dismiss).then(cleanup => {
    if (disposed) cleanup();
    else unsubscribe = cleanup;
  }).catch(() => undefined);

  return {
    shown: () => {
      if (!disposed) arm();
    },
    hidden: disarm,
    dispose: () => {
      disposed = true;
      disarm();
      target.removeEventListener("pointermove", pointerMoved, true);
      target.removeEventListener("mousemove", pointerMoved, true);
      doc.removeEventListener("visibilitychange", visibilityChanged);
      unsubscribe?.();
    }
  };
}
