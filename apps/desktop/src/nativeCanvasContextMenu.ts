import { toNativeCanvasMenu, withStereoReadout, type CanvasMenuItem } from "./canvasContextMenuModel";

let nextRequest = 0;

/** A native popup cannot change once it is tracking, so the stereo readout gets this long to
 * resolve before the menu opens without it. With the stereo engine already loaded (the document
 * window preloads it) the readout resolves well inside this; a cold load is not waited for. */
export const NATIVE_STEREO_READOUT_BUDGET_MS = 120;

export interface NativeCanvasMenuOptions {
  /** Resolves the read-only stereo row; must not reject (see `resolveStereoReadout`). */
  loadStereoReadout?: () => Promise<string | undefined>;
  stereoReadoutBudgetMs?: number;
  /** Checked after every wait before the native invoke; once false, the popup is never shown. */
  isActive?: () => boolean;
}

async function readoutWithinBudget(load: () => Promise<string | undefined>, budgetMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      load().catch(() => undefined),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), budgetMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Returns undefined only when native presentation is unavailable; cancellation is a result.
 * Returns null, without presenting anything, when `isActive` turns false before the popup opens.
 * The same Tauri command serves macOS (app-wide menu host) and Windows (document window). */
export async function popupNativeCanvasMenu(
  items: readonly CanvasMenuItem[], position: { x: number; y: number }, options: NativeCanvasMenuOptions = {}
) {
  const readout = options.loadStereoReadout
    ? await readoutWithinBudget(options.loadStereoReadout, options.stereoReadoutBudgetMs ?? NATIVE_STEREO_READOUT_BUDGET_MS)
    : undefined;
  const inactive = () => options.isActive?.() === false;
  if (inactive()) return null;
  const route = toNativeCanvasMenu(withStereoReadout(items, readout), String(++nextRequest));
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    if (inactive()) return null;
    const selected = await invoke<string | null>("popup_canvas_context_menu", { items: route.items, position });
    return { select: (onInvoke: (commandId: string) => void) => route.select(selected, onInvoke) };
  } catch {
    return undefined;
  }
}
