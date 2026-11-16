import { describe, expect, it } from "vitest";
import { NativeStylePresets, stylePresetToObjectStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { BoldBondStyle, nativeMoleculeBondDrawingStyle, planMoleculeAtomLabels, planPageSvgRender } from "./index";
import { elementFragments } from "./testing";
import { boldBondFixture } from "./boldBond.fixture";
import { boldBondWidth } from "./boldBonds";

function fragments(object: MoleculeObject) {
  const { document } = boldBondFixture("ring");
  // Plans cache immutable objects; each edited fixture must be a new snapshot.
  document.pages[0]!.objects = [structuredClone(object)];
  return planPageSvgRender(document.pages[0]!).fragments.flatMap(elementFragments);
}
function ink(object: MoleculeObject, id = "b0") {
  return fragments(object).filter(f => f.attrs["data-bond-id"] === id && String(f.attrs.class).includes("native-bond-line"));
}
function polygon(object: MoleculeObject, id = "b0") {
  const band = ink(object, id).find(f => f.tag === "polygon")!;
  expect(band).toBeDefined();
  expect(band.attrs.stroke).toBe("none");
  expect(band.attrs["stroke-linecap"]).toBeUndefined();
  return String(band.attrs.points).split(" ").map(p => {
    const [x, y] = p.split(",").map(Number); return { x: x!, y: y! };
  });
}
function terminal() {
  const { object } = boldBondFixture("chain");
  object.atoms = object.atoms.slice(1, 3);
  object.bonds = [object.bonds[1]!];
  return object;
}

type Point = { x: number; y: number };
const minus = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const inside = (points: Point[], p: Point) => {
  const turns = points.map((a, i) => cross(minus(points[(i + 1) % 4]!, a), minus(p, a)));
  return turns.every(t => t >= -1e-8) || turns.every(t => t <= 1e-8);
};

function expectUniformConvexBand(object: MoleculeObject, id: string, points: Point[]) {
  expect(points).toHaveLength(4);
  const turns = points.map((p, i) => cross(minus(points[(i + 1) % 4]!, p),
    minus(points[(i + 2) % 4]!, points[(i + 1) % 4]!)));
  expect(turns.every(t => t > 0) || turns.every(t => t < 0)).toBe(true);
  const bond = object.bonds.find(b => b.id === id)!;
  const a = object.atoms.find(a => a.id === bond.fromAtomId)!;
  const b = object.atoms.find(a => a.id === bond.toAtomId)!;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const unit = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  const normal = { x: -unit.y, y: unit.x };
  const local = points.map(p => ({ x: dot(minus(p, a), unit), y: dot(minus(p, a), normal) }));
  for (const fraction of [0.3, 0.5, 0.7]) {
    const x = length * fraction;
    const hits = local.flatMap((p, i) => {
      const q = local[(i + 1) % 4]!;
      if ((x - p.x) * (x - q.x) > 0 || Math.abs(q.x - p.x) < 1e-8) return [];
      return [p.y + (q.y - p.y) * (x - p.x) / (q.x - p.x)];
    });
    expect(hits).toHaveLength(2);
    expect(Math.abs(Math.abs(hits[1]! - hits[0]!) - 6.48)).toBeLessThan(0.002);
  }
}

describe("bold band geometry", () => {
  for (const count of [2, 3, 6]) {
    for (const reverseMask of count === 2 ? [0, 1, 2, 3] : [0, 1, 2, 5, (1 << count) - 1]) {
      it.each([
        { withDouble: false, angle: 0 }, { withDouble: true, angle: 0 },
        { withDouble: false, angle: 0.37 }, { withDouble: true, angle: 0.37 }
      ])(`shares cuts without gaps or overlaps for ${count} bold ring bonds (directions ${reverseMask}, double $withDouble, rotation $angle)`, ({ withDouble, angle }) => {
        const { object } = boldBondFixture(withDouble ? "double" : "ring");
        for (const atom of object.atoms) {
          const { x, y } = atom;
          atom.x = x * Math.cos(angle) - y * Math.sin(angle);
          atom.y = x * Math.sin(angle) + y * Math.cos(angle);
        }
        for (let i = 0; i < count; i++) {
          const bond = object.bonds[i]!;
          bond.display = { ...bond.display, bondStyle: "bold" };
        }
        const originals = Array.from({ length: count }, (_, i) => polygon(object, `b${i}`)
          .map(p => `${p.x},${p.y}`).sort());
        for (let i = 0; i < count; i++) {
          const bond = object.bonds[i]!;
          if (reverseMask & (1 << i)) [bond.fromAtomId, bond.toAtomId] = [bond.toAtomId, bond.fromAtomId];
        }
        object.bonds.reverse(); // Also exercise which band computes the cached joint first.
        const before = JSON.stringify(object);
        const bands = Array.from({ length: count }, (_, i) => polygon(object, `b${i}`));
        bands.forEach((band, i) => {
          expectUniformConvexBand(object, `b${i}`, band);
          expect(band.map(p => `${p.x},${p.y}`).sort()).toEqual(originals[i]);
        });
        for (let i = 0; i < (count === 6 ? count : count - 1); i++) {
          const j = (i + 1) % count;
          const bond = object.bonds.find(b => b.id === `b${i}`)!;
          const next = object.bonds.find(b => b.id === `b${j}`)!;
          const atomId = [bond.fromAtomId, bond.toAtomId].find(id => [next.fromAtomId, next.toAtomId].includes(id))!;
          const cut = (points: Point[], from: boolean) => from ? points.slice(0, 2) : points.slice(2, 4);
          const a = cut(bands[i]!, bond.fromAtomId === atomId);
          const b = cut(bands[j]!, next.fromAtomId === atomId);
          for (const p of a) expect(Math.min(...b.map(q => Math.hypot(p.x - q.x, p.y - q.y)))).toBeLessThan(1e-6);
          // Convex bands occupy opposite half-planes of exactly the same cut:
          // their interiors cannot overlap, and their union fills both sides.
          const edge = minus(a[1]!, a[0]!);
          const side = (p: Point) => cross(edge, minus(p, a[0]!));
          const interiorA = bands[i]!.filter(p => !a.includes(p)).map(side);
          const interiorB = bands[j]!.filter(p => !b.includes(p)).map(side);
          expect(interiorA.every(s => s * interiorA[0]! > 0)).toBe(true);
          expect(interiorB.every(s => s * interiorA[0]! < 0)).toBe(true);
          const size = Math.hypot(edge.x, edge.y);
          for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
            for (const sign of [-1, 1]) {
              const p = { x: a[0]!.x + edge.x * t - sign * edge.y / size * 0.01,
                y: a[0]!.y + edge.y * t + sign * edge.x / size * 0.01 };
              expect(Number(inside(bands[i]!, p)) + Number(inside(bands[j]!, p))).toBe(1);
            }
          }
        }
        expect(JSON.stringify(object)).toBe(before);
      });
    }
  }

  it("reports the default and ACS-like width ratios", () => {
    expect(boldBondWidth(2, 22)).toBeCloseTo(3.6);
    expect(boldBondWidth(2, 22) / 22).toBeCloseTo(0.16363636);
    expect(boldBondWidth(0.6 * 22 / 14.4, 22)).toBeCloseTo(2.97);
    expect(boldBondWidth(0.6 * 22 / 14.4, 22) / 22).toBeCloseTo(0.135);
  });

  it.each([0, 0.37, 1.8])("keeps the ibuprofen band convex, uniformly wide, and mitered to ring edges at rotation %s", angle => {
    const { object } = boldBondFixture("ibuprofen");
    for (const atom of object.atoms) {
      const { x, y } = atom;
      atom.x = x * Math.cos(angle) - y * Math.sin(angle);
      atom.y = x * Math.sin(angle) + y * Math.cos(angle);
    }
    const before = JSON.stringify(object);
    const points = polygon(object);
    expect(points).toHaveLength(4);
    const cross = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x * b.y - a.y * b.x;
    const minus = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: a.x - b.x, y: a.y - b.y });
    const turns = points.map((p, i) => cross(minus(points[(i + 1) % 4]!, p), minus(points[(i + 2) % 4]!, points[(i + 1) % 4]!)));
    expect(turns.every(turn => turn > 0) || turns.every(turn => turn < 0)).toBe(true);
    const a = object.atoms[0]!, b = object.atoms[1]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const u = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    const n = { x: -u.y, y: u.x };
    const dot = (p: { x: number; y: number }, axis: { x: number; y: number }) => p.x * axis.x + p.y * axis.y;
    const local = points.map(p => ({ x: dot(minus(p, a), u), y: dot(minus(p, a), n) }));
    const low = Math.min(...local.map(p => p.y)), high = Math.max(...local.map(p => p.y));
    expect(high - low).toBeCloseTo(6.48, 2);
    // Intersect transverse sample planes with all four sides, rather than just
    // checking a bounding box (which would also accept a taper or stepped band).
    for (const fraction of [0.2, 0.4, 0.6, 0.8]) {
      const x = length * fraction;
      const hits = local.flatMap((p, i) => {
        const q = local[(i + 1) % 4]!;
        if ((x - p.x) * (x - q.x) > 0 || Math.abs(q.x - p.x) < 1e-8) return [];
        return [p.y + (q.y - p.y) * (x - p.x) / (q.x - p.x)];
      });
      expect(hits).toHaveLength(2);
      expect(Math.abs(hits[1]! - hits[0]!)).toBeCloseTo(6.48, 2);
    }
    const neighbors = [{ origin: a, other: object.atoms[5]!, corners: [points[0]!, points[1]!] },
      { origin: b, other: object.atoms[2]!, corners: [points[3]!, points[2]!] }];
    const strips = neighbors.map(({ origin, other, corners }, i) => {
      const delta = minus(other, origin), size = Math.hypot(delta.x, delta.y);
      const axis = { x: delta.x / size, y: delta.y / size };
      const distance = (p: { x: number; y: number }) => cross(axis, minus(p, origin));
      const along = (p: { x: number; y: number }) => dot(minus(p, origin), axis);
      const neighborLine = ink(object, i === 0 ? "b5" : "b1").find(f => f.tag === "line")!;
      const near = Math.min(along({ x: Number(neighborLine.attrs.x1), y: Number(neighborLine.attrs.y1) }),
        along({ x: Number(neighborLine.attrs.x2), y: Number(neighborLine.attrs.y2) }));
      // Its normal ink reaches the outer corner exactly: no uncovered triangle,
      // and no overshoot behind the band that could create another flag.
      expect(near).toBeCloseTo(Math.min(0, ...corners.map(along)), 2);
      // Both miter endpoints are exactly on the matching inner/outer neighbor
      // outlines, so their connecting segment traverses only the normal strip.
      expect(corners.map(distance).sort((x, y) => x - y)).toEqual([expect.closeTo(-1, 2), expect.closeTo(1, 2)]);
      for (let i = 0; i <= 10; i++) {
        const t = i / 10, p = { x: corners[0]!.x * (1 - t) + corners[1]!.x * t, y: corners[0]!.y * (1 - t) + corners[1]!.y * t };
        expect(Math.abs(distance(p))).toBeLessThanOrEqual(1.001);
      }
      return distance;
    });
    for (const [i, point] of points.entries()) {
      const p = local[i]!;
      const inBandStrip = p.x >= 0 && p.x <= length && p.y >= low - 0.001 && p.y <= high + 0.001;
      expect(inBandStrip || strips.some(distance => Math.abs(distance(point)) <= 1.001)).toBe(true);
    }
    // The exocyclic branch contributes ink at the atom but owns neither cut.
    const withoutBranch = structuredClone(object);
    withoutBranch.bonds = withoutBranch.bonds.filter(bond => bond.id !== "b6");
    expect(polygon(withoutBranch)).toEqual(points);
    expect(JSON.stringify(object)).toBe(before);
  });

  it.each(NativeStylePresets)("preserves the ibuprofen pi line for $id, even when the band needs outward growth", preset => {
    const { object } = boldBondFixture("ibuprofen");
    object.style = stylePresetToObjectStyle(preset);
    const points = polygon(object);
    const pi = ink(object).find(f => f.tag === "line")!;
    const normal = structuredClone(object);
    delete normal.bonds[0]!.display!.bondStyle;
    const normalPi = ink(normal).find(f => f.attrs["data-bond-segment"] === "secondary")!;
    for (const key of ["x1", "y1", "x2", "y2", "stroke-width"]) expect(pi.attrs[key]).toBe(normalPi.attrs[key]);
    const a = object.atoms[0]!, b = object.atoms[1]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const offset = (x: number, y: number) => (-(b.y - a.y) * (x - a.x) + (b.x - a.x) * (y - a.y)) / length;
    const gap = offset(Number(pi.attrs.x1), Number(pi.attrs.y1)) - Number(pi.attrs["stroke-width"]) / 2
      - Math.max(...points.map(p => offset(p.x, p.y)));
    expect(gap).toBeGreaterThanOrEqual(preset.drawing.bondStrokeWidthPx - 0.001);
  });

  it.each(NativeStylePresets)("sizes the band from line width and bond length for $id", preset => {
    const { object } = boldBondFixture("ring");
    object.style = stylePresetToObjectStyle(preset);
    const before = JSON.stringify(object);
    const points = polygon(object);
    const xs = points.map(p => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(Math.max(1.8 * preset.drawing.bondStrokeWidthPx,
      Math.min(3.4 * preset.drawing.bondStrokeWidthPx, 0.135 * preset.drawing.bondLengthPx)), 2);
    expect(Math.min(...xs)).toBeCloseTo(75 - preset.drawing.bondStrokeWidthPx / 2, 2);
    expect(JSON.stringify(object)).toBe(before);
  });

  it("miters each ring end to both edges of ONE ring neighbor, without junction circles", () => {
    const { object } = boldBondFixture("ring");
    const points = polygon(object);
    const bottom = points.filter(p => p.y > 90);
    expect(bottom).toHaveLength(2);
    expect(bottom.map(p => -(p.x - 75) / 2 + (p.y - 98) * Math.sqrt(3) / 2).sort((a, b) => a - b))
      .toEqual([expect.closeTo(-1, 2), expect.closeTo(1, 2)]);
    expect(bottom[0]!.y).not.toBe(bottom[1]!.y);
    const top = points.filter(p => p.y < 60);
    expect(top).toHaveLength(2);
    expect(top.map(p => (p.x - 75) / 2 + (p.y - 50) * Math.sqrt(3) / 2).sort((a, b) => a - b))
      .toEqual([expect.closeTo(-1, 2), expect.closeTo(1, 2)]);
    expect(fragments(object).filter(f => f.attrs.class === "native-carbon-junction" && ["a0", "a1"].includes(String(f.attrs["data-atom-id"])))).toHaveLength(0);
  });

  it("joins a chain band to its two angled normal strokes", () => {
    const { object } = boldBondFixture("chain");
    const points = polygon(object, "b1");
    expect(Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y))).toBeCloseTo(6.48, 3);
    for (const p of points) {
      const atLeft = p.x < 100;
      const distance = ((atLeft ? 23 : -23) * (p.x - (atLeft ? 75 : 123)) + 40 * (p.y - 62)) / Math.hypot(40, 23);
      expect(Math.abs(distance)).toBeCloseTo(1, 2);
    }
  });

  it("has square terminal ends even with a round document line cap", () => {
    const object = terminal();
    object.style.bondLineCap = "round";
    const points = polygon(object, "b1");
    expect(points.map(p => p.x)).toEqual([75, 75, 123, 123]);
    expect(points.map(p => p.y)).toEqual([58.76, 65.24, 65.24, 58.76]);
  });

  it("keeps square ends outside oblique labels and leaves chemistry unchanged", () => {
    const object = terminal();
    object.atoms[0]!.element = "O";
    object.atoms[1]!.element = "N";
    object.atoms[1]!.y = 98;
    const before = JSON.stringify(object);
    const points = polygon(object, "b1");
    const unit = { x: 0.8, y: 0.6 };
    const projection = (p: { x: number; y: number }) => p.x * unit.x + p.y * unit.y;
    expect(projection(points[0]!)).toBeCloseTo(projection(points[1]!), 2);
    expect(projection(points[2]!)).toBeCloseTo(projection(points[3]!), 2);
    const labels = planMoleculeAtomLabels(object);
    for (const [i, label] of labels.entries()) {
      const box = label.layout.bounds;
      const corners = [box.x, box.x + box.width].flatMap(x => [box.y, box.y + box.height]
        .map(y => projection({ x: label.atom.x + x, y: label.atom.y + y })));
      if (i === 0) expect(projection(points[0]!)).toBeGreaterThanOrEqual(Math.max(...corners) - 0.002);
      else expect(projection(points[2]!)).toBeLessThanOrEqual(Math.min(...corners) + 0.002);
    }
    expect(JSON.stringify(object)).toBe(before);
  });

  it("keeps the pi width, coordinates and shortening, with at least one line width of white gap", () => {
    const { object } = boldBondFixture("double");
    const points = polygon(object);
    const pi = ink(object).find(f => f.tag === "line")!;
    expect(pi.attrs["stroke-width"]).toBe(2);
    expect(pi.attrs.y1).toBe(57);
    expect(pi.attrs.y2).toBe(91);
    const normal = structuredClone(object);
    delete normal.bonds[0]!.display!.bondStyle;
    const normalPi = ink(normal).find(f => f.attrs["data-bond-segment"] === "secondary")!;
    for (const key of ["x1", "y1", "x2", "y2", "stroke-width"]) expect(pi.attrs[key]).toBe(normalPi.attrs[key]);
    expect(Number(pi.attrs.x1) - 1 - Math.max(...points.map(p => p.x))).toBeGreaterThanOrEqual(2 * BoldBondStyle.clearGapRatio - 0.001);
  });

  it("honors an explicit opposite double side and centered double spacing", () => {
    for (const side of ["left", "center"] as const) {
      const { object } = boldBondFixture("double");
      object.bonds[0]!.display!.doubleBondSide = side;
      const points = polygon(object);
      const pi = ink(object).find(f => f.tag === "line")!;
      expect(pi.attrs["stroke-width"]).toBe(2);
      const xs = points.map(p => p.x), x = Number(pi.attrs.x1);
      const clearGap = Math.max(Math.min(...xs) - x, x - Math.max(...xs)) - 1;
      expect(clearGap).toBeGreaterThanOrEqual(2 - 0.001);
      const normal = structuredClone(object);
      delete normal.bonds[0]!.display!.bondStyle;
      const normalPi = ink(normal).find(f => f.attrs["data-bond-segment"] === "secondary")!;
      for (const key of ["x1", "y1", "x2", "y2", "stroke-width"]) expect(pi.attrs[key]).toBe(normalPi.attrs[key]);
    }
  });

  it.each([0, 0.37, 1.8])("keeps ordinary junction ink beside an uncovered wide centered bold double at rotation %s", angle => {
    const { object } = boldBondFixture("double");
    object.bonds[0]!.display!.doubleBondSide = "center";
    object.style.multipleBondGapPx = 20;
    for (const atom of object.atoms) {
      const { x, y } = atom;
      atom.x = x * Math.cos(angle) - y * Math.sin(angle);
      atom.y = x * Math.sin(angle) + y * Math.cos(angle);
    }
    const before = JSON.stringify(object);
    const atom = object.atoms[0]!; // Two ordinary bonds and the centered bold double meet here.
    const other = object.atoms[1]!;
    const length = Math.hypot(other.x - atom.x, other.y - atom.y);
    const offset = (point: { x: number; y: number }) =>
      (-(other.y - atom.y) * (point.x - atom.x) + (other.x - atom.x) * (point.y - atom.y)) / length;
    const offsets = polygon(object).map(offset);
    // The new 6.48-unit band still sits entirely away from the carbon at a 20-unit gap.
    expect(Math.min(...offsets.map(Math.abs))).toBeGreaterThan(1.16);
    expect(offsets.every(value => value > 0) || offsets.every(value => value < 0)).toBe(true);
    const pi = ink(object).find(f => f.tag === "line")!;
    expect(Math.abs(offset({ x: Number(pi.attrs.x1), y: Number(pi.attrs.y1) })))
      .toBeGreaterThan(1.16 + Number(pi.attrs["stroke-width"]) / 2);
    const junction = fragments(object).find(f => f.attrs.class === "native-carbon-junction" && f.attrs["data-atom-id"] === atom.id);
    expect(junction?.tag).toBe("circle");
    expect(junction?.attrs).toMatchObject({ cx: atom.x, cy: atom.y, r: "1.16", fill: "#000000", stroke: "none" });
    expect(JSON.stringify(object)).toBe(before);
  });

  it.each(["single", "double"])("omits extra junction ink where the %s band covers the carbon", kind => {
    const { object } = boldBondFixture(kind === "single" ? "ring" : "double");
    const atom = object.atoms[0]!;
    const points = polygon(object);
    // A point lies in this convex quadrilateral when every edge has the same
    // signed orientation to it. Assert coverage separately from circle omission.
    const sides = points.map((point, index) => {
      const next = points[(index + 1) % points.length]!;
      return (next.x - point.x) * (atom.y - point.y) - (next.y - point.y) * (atom.x - point.x);
    });
    expect(sides.every(side => side >= 0) || sides.every(side => side <= 0)).toBe(true);
    expect(fragments(object).filter(f => f.attrs.class === "native-carbon-junction" && f.attrs["data-atom-id"] === atom.id))
      .toHaveLength(0);
  });

  it("leaves pi endpoints unchanged beside oblique labels and at centered chain joins", () => {
    for (const labeled of [false, true]) {
      const { object } = boldBondFixture("chain");
      object.bonds[1]!.order = "double";
      object.bonds[1]!.display!.doubleBondSide = "center";
      if (labeled) {
        object.atoms[1]!.element = "N";
        object.atoms[2]!.element = "O";
        object.atoms[2]!.y += 25;
      }
      const pi = ink(object, "b1").find(f => f.attrs["data-bond-segment"] === "secondary")!;
      const normal = structuredClone(object);
      delete normal.bonds[1]!.display!.bondStyle;
      const normalPi = ink(normal, "b1").find(f => f.attrs["data-bond-segment"] === "secondary")!;
      for (const key of ["x1", "y1", "x2", "y2", "stroke-width"]) expect(pi.attrs[key]).toBe(normalPi.attrs[key]);
      expect(polygon(object, "b1")).toHaveLength(4);
    }
  });

  it.each(["ring", "ibuprofen"] as const)("is independent of bond traversal order and direction in %s", kind => {
    const { object } = boldBondFixture(kind);
    const signature = (m: MoleculeObject) => polygon(m).map(p => `${p.x},${p.y}`).sort();
    const original = signature(object);
    object.bonds.reverse();
    const bold = object.bonds.find(b => b.id === "b0")!;
    [bold.fromAtomId, bold.toAtomId] = [bold.toAtomId, bold.fromAtomId];
    expect(signature(object)).toEqual(original);
  });

  it("honors custom widths, normal per-bond width and uniformly scaled presets", () => {
    const object = terminal();
    object.style.bondBoldWidthPx = 9;
    expect(nativeMoleculeBondDrawingStyle(object, "b1").bondBoldWidthPx).toBe(9);
    object.style.bondBoldWidths = { b1: 11 };
    expect(nativeMoleculeBondDrawingStyle(object, "b1").bondBoldWidthPx).toBe(11);
    object.style = { bondStrokeWidths: { b1: 3 } };
    expect(nativeMoleculeBondDrawingStyle(object, "b1").bondBoldWidthPx).toBeCloseTo(5.4);
    object.style = { ...stylePresetToObjectStyle(NativeStylePresets[0]), bondLengthPx: 44, bondStrokeWidthPx: 4, bondBoldWidthPx: 9.6 };
    expect(nativeMoleculeBondDrawingStyle(object, "b1").bondBoldWidthPx).toBeCloseTo(7.2);
    object.style.bondLengths = { b1: 100 };
    expect(nativeMoleculeBondDrawingStyle(object, "b1").bondBoldWidthPx).toBeCloseTo(13.5);
  });

  it("bounds an acute chain join and ignores coincident neighbor coordinates", () => {
    const { object } = boldBondFixture("chain");
    object.atoms[0]!.x = 120;
    object.atoms[0]!.y = 62.0001;
    for (const p of polygon(object, "b1")) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(63);
      expect(p.x).toBeLessThanOrEqual(135);
    }
    object.atoms[0]!.x = 75; object.atoms[0]!.y = 62;
    expect(polygon(object, "b1").slice(0, 2).map(p => p.x)).toEqual([75, 75]);
  });

  it("uses the same band for effects and splits crossing cuts into square ends", () => {
    const object = terminal();
    object.style.visualEffects = [{ kind: "shadow", offsetX: 2, offsetY: 2, blur: 1, color: "#000000" }];
    const band = ink(object, "b1")[0]!;
    expect(fragments(object).some(f => f.tag === "polygon" && f.key.startsWith("molecule-effect-source-bond-") && f.attrs.points === band.attrs.points)).toBe(true);
    object.style.visualEffects = [];
    object.atoms.push({ id: "x", element: "C", formalCharge: 0, x: 99, y: 30 }, { id: "y", element: "C", formalCharge: 0, x: 99, y: 90 });
    object.bonds.push({ id: "xy", fromAtomId: "x", toAtomId: "y", order: "single" });
    const pieces = ink(object, "b1");
    expect(pieces).toHaveLength(2);
    for (const piece of pieces) {
      const xs = String(piece.attrs.points).split(" ").map(p => Number(p.split(",")[0]));
      expect(new Set(xs).size).toBe(2);
    }
  });

  it("clears an underlying bond across the bold band's fixed pi line", () => {
    const { document, object } = boldBondFixture("double");
    const back = terminal();
    back.id = "under";
    back.atoms[0]!.x = 35; back.atoms[0]!.y = 74;
    back.atoms[1]!.x = 135; back.atoms[1]!.y = 74;
    back.bonds[0]!.display = undefined;
    document.pages[0]!.objects = [back, object];
    const rendered = planPageSvgRender(document.pages[0]!).fragments.flatMap(elementFragments);
    const lines = rendered.filter(f => f.key.startsWith("bond-under-") && f.tag === "line");
    expect(lines).toHaveLength(2);
    const pi = rendered.find(f => f.attrs["data-bond-id"] === "b0" && f.attrs["data-bond-segment"] === "secondary" && f.attrs.stroke)!;
    expect(Number(lines[1]!.attrs.x1)).toBeGreaterThan(Number(pi.attrs.x1) + Number(pi.attrs["stroke-width"]) / 2);
  });
});
