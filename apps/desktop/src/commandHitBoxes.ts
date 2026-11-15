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
