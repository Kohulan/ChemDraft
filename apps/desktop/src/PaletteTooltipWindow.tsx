import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { detectShortcutPlatform, type ShortcutPlatform } from "@chemdraft/shortcut-engine";
import {
  listenForPaletteTooltipHide,
  listenForPaletteTooltipShow,
  monitorLogicalBoundsAt,
  setCurrentWindowLogicalSize,
  type MonitorLogicalBounds,
  type PaletteTooltipPayload
} from "./window-manager";

/**
 * The ONE shared floating tooltip window for all native palettes. A palette webview can't paint
 * outside its content-fit window, so its in-DOM tooltip span is hidden there (App.css) and the
 * visible tooltip lives here instead — a tiny always-existing window (pre-built hidden at app
 * setup, click-through via ignoresMouseEvents so the pointer feed's hit test never mistakes it
 * for "cursor left the palette") that any palette positions near its hovered button.
 *
 * Flow: a palette broadcasts show {text, anchor}; this window renders the text, measures itself,
 * sizes + positions the window (centered on the anchor, flipped above when there's no room
 * below), and shows. A hide broadcast (pointer left the button) hides it again.
 */
function hideTooltipWindow(isCurrent: () => boolean) {
  // Through Rust, like show: both sync commands run on the main thread in send order. The JS
  // window API's hide took a separate IPC path that could overtake a just-sent show and leave the
  // tooltip stranded visible (seen on Windows once showing stopped stealing activation).
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => isCurrent() ? invoke("hide_toolset_tooltip_window") : undefined)
    .catch(() => undefined);
}

/**
 * Linux sizes the tooltip inside the show command, not with a separate window resize first: Rust
 * pins the GtkWindow to this content size (min = max hints) and resizes it on the main thread
 * before placing and mapping it, so a short tooltip after a long one shrinks instead of keeping
 * the previous frame (a one-line tooltip in a 220x64 window). macOS and Windows keep resizing from
 * the webview first and pass only the position.
 */
export function paletteTooltipShowArgs(
  position: { x: number; y: number },
  size: { width: number; height: number },
  platform: ShortcutPlatform,
  sourceToolsetId?: string
): { x: number; y: number; width?: number; height?: number; sourceToolsetId?: string } {
  const args = platform === "linux"
    ? { x: position.x, y: position.y, width: size.width, height: size.height }
    : { x: position.x, y: position.y };
  // The palette that asked: Rust refuses the reveal when that palette closed or hid while this
  // window was still measuring (a keyboard close sends no hide here), on every platform.
  return sourceToolsetId === undefined ? args : { ...args, sourceToolsetId };
}

function showTooltipWindow(
  args: ReturnType<typeof paletteTooltipShowArgs>,
  isCurrent: () => boolean
) {
  // Rust places (in global logical coordinates, converted with the anchor monitor's scale) and
  // orders the panel front in one call — the same path that displays the palettes. Tauri's JS
  // show() resolved without error here but never actually displayed this focusable(false) panel.
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => isCurrent() ? invoke("show_toolset_tooltip_window", args) : undefined)
    .catch(() => undefined);
}

/**
 * Pure placement: center on the anchor, flip above when there's no room below, and clamp
 * within the bounds of the monitor the ANCHOR lives on (global logical coordinates). The
 * old clamp used `window.screen` — the display this (hidden, usually primary-screen)
 * window was on — which dragged tooltips for a second-screen palette back to the primary
 * display's edge. With no bounds (anchor on no known monitor), place at the anchor unclamped:
 * a tooltip at the anchor is always better than one on the wrong screen.
 */
export function placePaletteTooltip(input: {
  anchorCenterX: number;
  belowY: number;
  aboveY: number;
  width: number;
  height: number;
  bounds?: MonitorLogicalBounds;
}): { x: number; y: number } {
  const { anchorCenterX, belowY, aboveY, width, height, bounds } = input;
  const margin = 4;
  let x = Math.round(anchorCenterX - width / 2);
  let y = Math.round(belowY);
  if (bounds) {
    x = Math.max(bounds.left + margin, Math.min(x, bounds.right - width - margin));
    if (y + height > bounds.bottom - margin) {
      y = Math.round(aboveY - height);
    }
    y = Math.max(bounds.top + margin, y);
  }
  return { x, y };
}

export interface PaletteTooltipWindowProps {
  platform?: ShortcutPlatform;
}

export function PaletteTooltipWindow({
  platform = detectShortcutPlatform()
}: PaletteTooltipWindowProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [payload, setPayload] = useState<PaletteTooltipPayload | undefined>();
  // Bumped SYNCHRONOUSLY by every show/hide broadcast. The layout effect's `cancelled` flag only
  // flips when React commits the new payload — a later scheduler task — so a hide arriving while a
  // show was awaiting its IPC could still be followed by that show, stranding an empty tooltip.
  const generationRef = useRef(0);

  useEffect(() => {
    document.documentElement.classList.add("palette-tooltip-window-html");
    document.body.classList.add("palette-tooltip-window-body");
    return () => {
      document.documentElement.classList.remove("palette-tooltip-window-html");
      document.body.classList.remove("palette-tooltip-window-body");
    };
  }, []);

  useEffect(() => {
    let unlistenShow: (() => void) | undefined;
    let unlistenHide: (() => void) | undefined;
    void listenForPaletteTooltipShow((next) => {
      generationRef.current += 1;
      setPayload(next);
    })
      .then((cleanup) => {
        unlistenShow = cleanup;
      })
      .catch(() => undefined);
    void listenForPaletteTooltipHide(() => {
      generationRef.current += 1;
      setPayload(undefined);
      const generation = generationRef.current;
      hideTooltipWindow(() => generationRef.current === generation);
    })
      .then((cleanup) => {
        unlistenHide = cleanup;
      })
      .catch(() => undefined);
    return () => {
      unlistenShow?.();
      unlistenHide?.();
    };
  }, []);

  // Size to the rendered text, position at the anchor, then show. Measured synchronously —
  // useLayoutEffect runs after the DOM mutation and getBoundingClientRect forces layout, and a
  // requestAnimationFrame would NEVER fire here while the window is hidden (no display link), so
  // the popover's measure-on-next-frame pattern would deadlock this window shut.
  useLayoutEffect(() => {
    if (!payload) {
      return;
    }
    const rect = shellRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) {
      return;
    }
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    let cancelled = false;
    const generation = generationRef.current;
    const superseded = () => cancelled || generationRef.current !== generation;
    void (async () => {
      // Clamp against the monitor that contains the ANCHOR (the hovered button), not
      // whichever display this floating window is currently on — see placePaletteTooltip.
      // The monitor query and the resize are independent, so they run together; placement and
      // reveal are then one command (see show_toolset_tooltip_window).
      // Linux applies the size in the show command instead (paletteTooltipShowArgs).
      const anchorProbeY = (payload.aboveY + payload.belowY) / 2;
      const [bounds] = await Promise.all([
        monitorLogicalBoundsAt(payload.anchorCenterX, anchorProbeY),
        platform === "linux" ? undefined : setCurrentWindowLogicalSize({ width, height })
      ]);
      // Superseded while awaiting: placing now would drag the (already re-placed, visible) window
      // back to the previous button's anchor, or re-show a tooltip the pointer already left.
      if (superseded()) {
        return;
      }
      const { x, y } = placePaletteTooltip({
        anchorCenterX: payload.anchorCenterX,
        belowY: payload.belowY,
        aboveY: payload.aboveY,
        width,
        height,
        bounds
      });
      showTooltipWindow(
        paletteTooltipShowArgs({ x, y }, { width, height }, platform, payload.sourceToolsetId),
        () => !superseded()
      );
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [payload, platform]);

  return (
    <div ref={shellRef} className="palette-floating-tooltip" role="tooltip">
      <span>{payload?.title ?? ""}</span>
      {payload?.description ? <span className="tool-tooltip-description">{payload.description}</span> : null}
      {payload?.shortcut ? <span className="tool-tooltip-shortcut">{payload.shortcut}</span> : null}
    </div>
  );
}
