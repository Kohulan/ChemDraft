import type { NativeDrawingStyle } from "@chemdraft/chem-core";
import { formatNumber } from "./formatNumber";

/** Display-only dimensions, relative to the document's ordinary line width. */
export const BoldBondStyle = { widthRatio: 3.4, clearGapRatio: 3.4, miterLimit: 2 } as const;

export function boldDoubleBondSeparation(style: NativeDrawingStyle, normalGap: number, depthScale: number): number {
  const line = style.bondStrokeWidthPx * depthScale;
  const band = style.bondBoldWidthPx * depthScale;
  // A flush outside edge puts the inside edge at band - line/2, and the pi edge
  // at separation - line/2. Their white gap is therefore separation - band.
  return band + Math.max(normalGap - line, line * BoldBondStyle.clearGapRatio);
}

type Point = { x: number; y: number };
export type BoldBondNeighbor = { origin: Point; unit: Point; length: number; width: number };
type Segment = { x1: number; y1: number; x2: number; y2: number };

/** Filled band. Its end cuts meet the outside edges of the incident strokes: the
 * overlap stays inside those strokes, so there is no exposed cap or antialiasing slit.
 * Acute/near-collinear joints are bounded by a bevel; absent joints give square caps.
 * Side selects inward growth with the opposite edge fixed at the ordinary half-width.
 */
export function boldBondPolygonPoints(segment: Segment, width: number, lineWidth: number,
  side: "left" | "right" | undefined, from: readonly BoldBondNeighbor[], to: readonly BoldBondNeighbor[]): string {
  const length = Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
  if (length < 1e-8) return "";
  const unit = { x: (segment.x2 - segment.x1) / length, y: (segment.y2 - segment.y1) / length };
  const normal = { x: -unit.y, y: unit.x };
  const low = side === "left" ? -lineWidth / 2 : side === "right" ? lineWidth / 2 - width : -width / 2;
  const high = low + width;
  const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
  const end = (origin: Point, inward: Point, neighbors: readonly BoldBondNeighbor[], reverse: boolean) => {
    const offsets = [low, high];
    const jointOffset = neighbors[0] ? dot({ x: neighbors[0].origin.x - origin.x, y: neighbors[0].origin.y - origin.y }, normal) : 0;
    // At a branch, each edge joins the ray on its own side; retain the corner
    // between those cuts instead of drawing a diagonal across the atom.
    if (low < jointOffset && high > jointOffset && neighbors.some(n => dot(n.unit, normal) > 1e-6)
      && neighbors.some(n => dot(n.unit, normal) < -1e-6)) offsets.splice(1, 0, jointOffset);
    const points = offsets.map(offset => {
      const candidates = neighbors.filter(n => Math.abs(dot(n.unit, normal)) > 1e-6);
      const onSide = candidates.filter(n => dot(n.unit, normal) * (offset - jointOffset) > 0);
      const joins = (onSide.length ? onSide : candidates).map(neighbor => {
        let edgeNormal = { x: -neighbor.unit.y, y: neighbor.unit.x };
        if (dot(edgeNormal, inward) < 0) edgeNormal = { x: -edgeNormal.x, y: -edgeNormal.y };
        const displacement = { x: origin.x - neighbor.origin.x, y: origin.y - neighbor.origin.y };
        const t = (-neighbor.width / 2 - dot(displacement, edgeNormal) - offset * dot(normal, edgeNormal)) / dot(inward, edgeNormal);
        const limit = Math.min(width * BoldBondStyle.miterLimit, length / 4, neighbor.length / 4);
        return Math.max(-limit, Math.min(limit, t));
      });
      const t = joins.length ? Math.min(...joins) : 0;
      return { x: origin.x + normal.x * offset + inward.x * t,
        y: origin.y + normal.y * offset + inward.y * t };
    });
    return reverse ? points.reverse() : points;
  };
  return [...end({ x: segment.x1, y: segment.y1 }, unit, from, false),
    ...end({ x: segment.x2, y: segment.y2 }, { x: -unit.x, y: -unit.y }, to, true)]
    .map(p => `${formatNumber(p.x)},${formatNumber(p.y)}`).join(" ");
}
