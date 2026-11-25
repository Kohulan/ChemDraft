import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";

export interface DropClientPoint { x: number; y: number }

/**
 * The `tauri://drag-drop` position in the webview's CSS pixels. The payload is typed as a physical
 * position, but the webview layer (wry 0.55) fills it differently per platform:
 *
 * - macOS: `draggingLocation` in the WKWebView's own frame, flipped to a top-left origin. That is
 *   in points, which are CSS pixels.
 * - Linux: GTK's drag motion coordinates, logical pixels relative to the webview widget.
 * - Windows: `ScreenToClient` on the webview's own container window, so physical pixels relative to
 *   the webview. The container sits below a window menu bar (which is in the frame's non-client
 *   area), so no menu offset applies; dividing by the device pixel ratio gives CSS pixels.
 *
 * `scaleFactor` should be the webview's `devicePixelRatio`, which also folds in any webview zoom.
 */
export function tauriDropClientPoint(
  position: { x?: unknown; y?: unknown } | null | undefined,
  platform: ShortcutPlatform,
  scaleFactor: number
): DropClientPoint | undefined {
  const x = position?.x;
  const y = position?.y;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const scale = platform === "windows" && Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  return { x: x / scale, y: y / scale };
}

/** A browser drop event's point; synthetic events without coordinates have none. */
export function browserDropClientPoint(event: { clientX?: unknown; clientY?: unknown }): DropClientPoint | undefined {
  const { clientX: x, clientY: y } = event;
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

export interface ClientRectLike { left: number; top: number; right: number; bottom: number }

/**
 * Where a drop lands on the page. A point outside the visible canvas (over a toolbar, the tab strip
 * or the rulers) is first pulled to the nearest visible canvas point, then mapped to page units and
 * clamped to the page: the picture goes to the nearest point of the visible page. Without a point
 * the caller uses the visible centre, as Paste Picture does.
 */
export function dropPagePoint(
  client: DropClientPoint,
  canvas: ClientRectLike,
  pageOrigin: { left: number; top: number },
  scale: number,
  page: { width: number; height: number }
): DropClientPoint {
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
  const visible = { x: clamp(client.x, canvas.left, canvas.right), y: clamp(client.y, canvas.top, canvas.bottom) };
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    x: clamp((visible.x - pageOrigin.left) / safeScale, 0, page.width),
    y: clamp((visible.y - pageOrigin.top) / safeScale, 0, page.height)
  };
}
