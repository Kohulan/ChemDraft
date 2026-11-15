/** Shared by renderer defaults and native command hit regions, including custom palettes. */
export function isPaletteCommandButton(element: Element): boolean {
  const button = element.closest("button");
  return !!button && !element.closest('input, textarea, select, [contenteditable="true"], [role="slider"]') &&
    !button.closest(".customizing, .toolbar-color-popover, .art-color-popover");
}

export interface PhysicalClientRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Convert a DOM client rect to the physical client-pixel coordinates used by Win32 messages. */
export function physicalClientRect(
  rect: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
  scale: number
): PhysicalClientRect | undefined {
  if (!Number.isFinite(scale) || scale <= 0) return undefined;
  const x = Math.floor(rect.left * scale);
  const y = Math.floor(rect.top * scale);
  const right = Math.ceil(rect.right * scale);
  const bottom = Math.ceil(rect.bottom * scale);
  if (![x, y, right, bottom].every(Number.isFinite) || right <= x || bottom <= y) return undefined;
  return { x, y, width: right - x, height: bottom - y };
}

export function commandButtonHitBoxes(root: ParentNode, scale: number): PhysicalClientRect[] {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].flatMap((button) => {
    if (!isPaletteCommandButton(button)) return [];
    const bounds = physicalClientRect(button.getBoundingClientRect(), scale);
    return bounds ? [bounds] : [];
  });
}

/** Only these controls need Windows' default activation to open their native UI.
 * Text inputs use the input lease; disabled/hidden choosers cannot open anything. */
export function nativeChooserHitBoxes(root: ParentNode, scale: number): PhysicalClientRect[] {
  return [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[type="color"], select')]
    .flatMap(control => {
      if (control.matches(":disabled") || control.closest("[hidden], [inert]")) return [];
      const style = getComputedStyle(control);
      if (style.visibility === "hidden" || style.visibility === "collapse") return [];
      const bounds = physicalClientRect(control.getBoundingClientRect(), scale);
      return bounds ? [bounds] : [];
    });
}

/** Observe DOM/layout changes without an empty publication between snapshots.
 * The owner clears on unmount/customize; stopping an observer is not a clear. */
export function observePaletteHitBoxes(
  root: HTMLElement,
  publish: (boxes: PhysicalClientRect[], chooserRects: PhysicalClientRect[]) => Promise<void>,
  subscribeRefresh: (refresh: () => void) => Promise<() => void>
): () => void {
  let frame = 0;
  let disposed = false;
  const refresh = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (disposed) return;
      const scale = window.devicePixelRatio || 1;
      void publish(commandButtonHitBoxes(root, scale), nativeChooserHitBoxes(root, scale))
        .catch(() => undefined);
    });
  };
  const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(refresh);
  resizeObserver?.observe(root);
  const mutationObserver = new MutationObserver(refresh);
  mutationObserver.observe(root, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["disabled", "hidden", "inert", "type", "data-native-noactivate-command", "data-command-id", "style", "class"]
  });
  window.addEventListener("resize", refresh);
  window.addEventListener("scroll", refresh, true);
  let unlistenRefresh: (() => void) | undefined;
  void subscribeRefresh(refresh).then(unlisten => {
    if (disposed) unlisten();
    else unlistenRefresh = unlisten;
  }).catch(() => undefined);
  refresh();
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    resizeObserver?.disconnect();
    mutationObserver.disconnect();
    window.removeEventListener("resize", refresh);
    window.removeEventListener("scroll", refresh, true);
    unlistenRefresh?.();
  };
}
