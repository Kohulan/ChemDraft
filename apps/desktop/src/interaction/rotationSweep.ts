type Point = { x: number; y: number };

// A few CSS pixels absorb pointer jitter where small moves can cause large bearing changes.
const holdRadiusCssPx = 6;

/** Accumulate the signed pointer sweep about a fixed rotation center. */
export function createRotationSweep(center: Point, start: Point) {
  let previous = { x: start.x - center.x, y: start.y - center.y };
  let radians = 0;

  function update(point: Point, viewScale: number) {
    const from = previous;
    const to = { x: point.x - center.x, y: point.y - center.y };
    // Rebase even when this segment is held so the next segment starts at the latest sample.
    previous = to;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return;

    // Project the pivot (the origin here) onto the finite pointer segment.
    const t = Math.max(0, Math.min(1, -(from.x * dx + from.y * dy) / lengthSquared));
    const holdRadius = holdRadiusCssPx / viewScale;
    if (Math.hypot(from.x + t * dx, from.y + t * dy) <= holdRadius) {
      return;
    }

    const cross = from.x * to.y - from.y * to.x;
    const dot = from.x * to.x + from.y * to.y;
    radians += Math.atan2(cross, dot);
  }

  return {
    update,
    get degrees() {
      return Number((radians * 180 / Math.PI).toFixed(3));
    }
  };
}
