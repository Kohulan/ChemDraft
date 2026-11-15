import { formatNumber } from "./formatNumber";

/** Display-only dimensions. The minimum wins when the ordinary line is already thick. */
export const BoldBondStyle = {
  widthRatio: 3.4, bondLengthRatio: 0.135, minimumWidthRatio: 1.8, clearGapRatio: 1, miterLimit: 2
} as const;

export function boldBondWidth(lineWidth: number, bondLength: number): number {
  return Math.max(lineWidth * BoldBondStyle.minimumWidthRatio,
    Math.min(lineWidth * BoldBondStyle.widthRatio, bondLength * BoldBondStyle.bondLengthRatio));
}

type Point = { x: number; y: number };
export type BoldBondNeighbor = { bondId: string; origin: Point; unit: Point; length: number; width: number };
export type BoldBondJoin = { neighbor: BoldBondNeighbor; points: readonly Point[] };
type Segment = { x1: number; y1: number; x2: number; y2: number };

/** Filled, constant-width quadrilateral. Each end joins ONE neighbor: inner edge to
 * inner edge, outer edge to outer edge. Ring callers supply only the same-ring neighbor;
 * a substituent must never cut a notch into the band. Degenerate/overlong miters and
 * absent neighbors use a square end. Side selects inward growth; if that would crowd
 * a fixed pi line, grow partly outward instead. The pi line itself is never displaced.
 */
export function boldBondPolygonPoints(segment: Segment, width: number, lineWidth: number,
  side: "left" | "right" | undefined, from: readonly BoldBondNeighbor[], to: readonly BoldBondNeighbor[],
  piSeparation?: number, onJoin?: (join: BoldBondJoin) => void): string {
  const length = Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
  if (length < 1e-8) return "";
  const unit = { x: (segment.x2 - segment.x1) / length, y: (segment.y2 - segment.y1) / length };
  const normal = { x: -unit.y, y: unit.x };
  let low = side === "left" ? -lineWidth / 2 : side === "right" ? lineWidth / 2 - width : -width / 2;
  let high = low + width;
  if (piSeparation !== undefined && side) {
    // SVG points round to 0.001 units; leave one such unit so that rounding an
    // oblique edge cannot turn the promised minimum gap into slightly less ink clearance.
    const innerLimit = piSeparation - lineWidth * (0.5 + BoldBondStyle.clearGapRatio) - 0.001;
    const shift = Math.max(0, (side === "left" ? high : -low) - innerLimit);
    low += side === "left" ? -shift : shift;
    high += side === "left" ? -shift : shift;
  }
  const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
  const end = (origin: Point, inward: Point, neighbors: readonly BoldBondNeighbor[], reverse: boolean) => {
    const candidates = neighbors.filter(n => Math.abs(dot(n.unit, normal)) > 1e-6);
    const onSide = candidates.filter(n => dot(n.unit, normal) * (side === "right" ? -1 : 1) > 0);
    const neighbor = (side && onSide.length ? onSide : candidates).slice().sort((a, b) =>
      Math.abs(dot(b.unit, normal)) - Math.abs(dot(a.unit, normal)) || a.unit.x - b.unit.x || a.unit.y - b.unit.y)[0];
    let distances = [0, 0];
    let mitered = false;
    if (neighbor) {
      let edgeNormal = { x: -neighbor.unit.y, y: neighbor.unit.x };
      if (dot(edgeNormal, inward) < 0) edgeNormal = { x: -edgeNormal.x, y: -edgeNormal.y };
      const displacement = { x: origin.x - neighbor.origin.x, y: origin.y - neighbor.origin.y };
      const innerIsHigh = dot(neighbor.unit, normal) > 0;
      const intersections = [low, high].map((offset, i) => {
        const edge = (i === 1) === innerIsHigh ? neighbor.width / 2 : -neighbor.width / 2;
        return (edge - dot(displacement, edgeNormal) - offset * dot(normal, edgeNormal)) / dot(inward, edgeNormal);
      });
      const limit = Math.min(width * BoldBondStyle.miterLimit, length / 4, neighbor.length / 4);
      // Fall back as a pair: clamping each corner independently creates a false miter.
      if (intersections.every(t => Number.isFinite(t) && Math.abs(t) <= limit)) {
        distances = intersections;
        mitered = true;
      }
    }
    const points = [low, high].map((offset, i) => {
      const t = distances[i]!;
      return { x: origin.x + normal.x * offset + inward.x * t,
        y: origin.y + normal.y * offset + inward.y * t };
    });
    if (neighbor && mitered) onJoin?.({ neighbor, points });
    return reverse ? points.reverse() : points;
  };
  return [...end({ x: segment.x1, y: segment.y1 }, unit, from, false),
    ...end({ x: segment.x2, y: segment.y2 }, { x: -unit.x, y: -unit.y }, to, true)]
    .map(p => `${formatNumber(p.x)},${formatNumber(p.y)}`).join(" ");
}
