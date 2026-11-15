import type { ElectronMarkObject } from "@chemdraft/chem-core";

/** Canvas-only targets in document units; never used for saved or exported geometry. */
export function electronMarkInteractionFrames(mark: Pick<ElectronMarkObject, "x" | "y" | "width" | "height" | "markKind">, pageScale: number) {
  const scale = Number.isFinite(pageScale) && pageScale > 0 ? pageScale : 1;
  // Electron glyphs are much smaller than their stored frames. Keep a generous grab
  // area in screen pixels, even for a tiny mark or a zoomed-out page.
  const minimumSize = 36;
  const width = Math.max(mark.width, minimumSize / scale);
  const height = Math.max(mark.height, minimumSize / scale);
  const x = mark.x + (mark.width - width) / 2;
  const y = mark.y + (mark.height - height) / 2;
  // The 18px corner buttons extend 10px into their frame (App.css offset -8px).
  // Twelve pixels leave a gap between those buttons and the entire move target.
  const margin = 12 / scale;
  return {
    move: { x, y, width, height },
    controls: { x: x - mark.x - margin, y: y - mark.y - margin,
      width: width + 2 * margin, height: height + 2 * margin }
  };
}
