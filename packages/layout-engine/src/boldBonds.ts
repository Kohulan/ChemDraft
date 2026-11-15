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
export type BoldBondNeighbor = { bondId: string; origin: Point; unit: Point; length: number; width: number;
  /** Actual rendered edges, signed along the normal to the outward unit vector. */
  offsets?: readonly [number, number] };
export type BoldBondJoin = { neighbor: BoldBondNeighbor; points: readonly Point[] };
export type BoldBondJointCache = Map<string, ReadonlyMap<string, readonly Point[]> | undefined>;
type Segment = { x1: number; y1: number; x2: number; y2: number };

export function boldBondEdgeOffsets(width: number, lineWidth: number,
  side: "left" | "right" | undefined, piSeparation?: number): [number, number] {
  let low = side === "left" ? -lineWidth / 2 : side === "right" ? lineWidth / 2 - width : -width / 2;
  let high = low + width;
  if (piSeparation !== undefined && side) {
    // SVG points round to 0.001 units; keep that allowance in the minimum pi gap.
    const innerLimit = piSeparation - lineWidth * (0.5 + BoldBondStyle.clearGapRatio) - 0.001;
    const shift = Math.max(0, (side === "left" ? high : -low) - innerLimit);
    low += side === "left" ? -shift : shift;
    high += side === "left" ? -shift : shift;
  }
  return [low, high];
}

/** Intersect corresponding rendered edges once for BOTH bands. Both limits must
 * accept the cut, otherwise both ends stay square. Inputs point away from the atom. */
function sharedBoldBondCut(a: BoldBondNeighbor, b: BoldBondNeighbor): ReadonlyMap<string, readonly Point[]> | undefined {
  const normal = (n: BoldBondNeighbor) => ({ x: -n.unit.y, y: n.unit.x });
  const dot = (p: Point, q: Point) => p.x * q.x + p.y * q.y;
  const na = normal(a), nb = normal(b);
  const denominator = dot(a.unit, nb);
  if (!a.offsets || !b.offsets || Math.abs(denominator) < 1e-6) return undefined;
  const sameOrder = (dot(b.unit, na) > 0) === (dot(a.unit, nb) > 0);
  const bOffsets = sameOrder ? b.offsets : [...b.offsets].reverse();
  const points = a.offsets.map((offset, i) => {
    const delta = { x: a.origin.x - b.origin.x, y: a.origin.y - b.origin.y };
    const t = (bOffsets[i]! - dot(delta, nb) - offset * dot(na, nb)) / denominator;
    return { x: a.origin.x + na.x * offset + a.unit.x * t,
      y: a.origin.y + na.y * offset + a.unit.y * t };
  });
  for (const band of [a, b]) {
    const limit = Math.min(band.width * BoldBondStyle.miterLimit, a.length / 4, b.length / 4);
    if (!points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)
      && Math.abs(dot({ x: p.x - band.origin.x, y: p.y - band.origin.y }, band.unit)) <= limit)) return undefined;
  }
  return new Map([[a.bondId, points], [b.bondId, sameOrder ? points : [...points].reverse()]]);
}

/** Filled, constant-width quadrilateral. Each end joins ONE neighbor: inner edge to
 * inner edge, outer edge to outer edge. Ring callers supply only the same-ring neighbor;
 * a substituent must never cut a notch into the band. Degenerate/overlong miters and
 * absent neighbors use a square end. Side selects inward growth; if that would crowd
 * a fixed pi line, grow partly outward instead. The pi line itself is never displaced.
 */
export function boldBondPolygonPoints(segment: Segment, width: number, lineWidth: number,
  side: "left" | "right" | undefined, from: readonly BoldBondNeighbor[], to: readonly BoldBondNeighbor[],
  piSeparation?: number, onJoin?: (join: BoldBondJoin) => void,
  sharedJoints?: { bondId: string; cache: BoldBondJointCache }): string {
  const length = Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
  if (length < 1e-8) return "";
  const unit = { x: (segment.x2 - segment.x1) / length, y: (segment.y2 - segment.y1) / length };
  const normal = { x: -unit.y, y: unit.x };
  const [low, high] = boldBondEdgeOffsets(width, lineWidth, side, piSeparation);
  const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
  const end = (origin: Point, inward: Point, neighbors: readonly BoldBondNeighbor[], reverse: boolean) => {
    const candidates = neighbors.filter(n => Math.abs(dot(n.unit, normal)) > 1e-6);
    const onSide = candidates.filter(n => dot(n.unit, normal) * (side === "right" ? -1 : 1) > 0);
    const neighbor = (side && onSide.length ? onSide : candidates).slice().sort((a, b) =>
      Math.abs(dot(b.unit, normal)) - Math.abs(dot(a.unit, normal)) || a.unit.x - b.unit.x || a.unit.y - b.unit.y)[0];
    let distances = [0, 0];
    let mitered = false;
    if (neighbor?.offsets && sharedJoints) {
      const { bondId, cache } = sharedJoints;
      const key = JSON.stringify([bondId, neighbor.bondId].sort());
      if (!cache.has(key)) {
        const current: BoldBondNeighbor = { bondId, origin, unit: inward, length, width,
          offsets: reverse ? [-high, -low] : [low, high] };
        cache.set(key, sharedBoldBondCut(current, neighbor));
      }
      const cut = cache.get(key)?.get(bondId);
      // The outward normal flips at the to end. Polygon winding reverses it again.
      if (cut) return cut;
      // A rejected shared miter must not fall through to the symmetric-stroke path.
      return (reverse ? [high, low] : [low, high]).map(offset =>
        ({ x: origin.x + normal.x * offset, y: origin.y + normal.y * offset }));
    }
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
