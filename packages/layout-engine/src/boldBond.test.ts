import { describe, expect, it } from "vitest";
import { NativeStylePresets, stylePresetToObjectStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { BoldBondStyle, nativeMoleculeBondDrawingStyle, planMoleculeAtomLabels, planPageSvgRender } from "./index";
import { elementFragments } from "./testing";
import { boldBondFixture } from "./boldBond.fixture";

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

describe("bold band geometry", () => {
  it.each(NativeStylePresets)("scales the 3.4x band with preset $id and keeps the outer ring edge flush", preset => {
    const { object } = boldBondFixture("ring");
    object.style = stylePresetToObjectStyle(preset);
    const before = JSON.stringify(object);
    const points = polygon(object);
    const xs = points.map(p => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(preset.drawing.bondStrokeWidthPx * 3.4, 2);
    expect(Math.min(...xs)).toBeCloseTo(75 - preset.drawing.bondStrokeWidthPx / 2, 2);
    expect(JSON.stringify(object)).toBe(before);
  });

  it("clips both ring ends into the adjoining stroke edges, without junction circles", () => {
    const { object } = boldBondFixture("ring");
    const points = polygon(object);
    const bottom = points.filter(p => p.y > 90);
    expect(bottom).toHaveLength(2);
    // The lower neighboring bond is 30 degrees from horizontal: both corners lie
    // on its outside edge, one normal stroke half-width from the original axis.
    for (const p of bottom) expect(-(p.x - 75) / 2 + (p.y - 98) * Math.sqrt(3) / 2).toBeCloseTo(1, 2);
    expect(bottom[0]!.y).not.toBe(bottom[1]!.y);
    const top = points.filter(p => p.y < 60);
    expect(top).toHaveLength(3); // The ethyl branch and ring neighbor each own their cut.
    for (const p of top) expect(Math.abs(p.x - 75) / 2 + (p.y - 50) * Math.sqrt(3) / 2).toBeCloseTo(-1, 2);
    expect(fragments(object).filter(f => f.attrs.class === "native-carbon-junction" && ["a0", "a1"].includes(String(f.attrs["data-atom-id"])))).toHaveLength(0);
  });

  it("joins a chain band to its two angled normal strokes", () => {
    const { object } = boldBondFixture("chain");
    const points = polygon(object, "b1");
    expect(Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y))).toBeCloseTo(6.8, 3);
    for (const p of points) {
      const atLeft = p.x < 100;
      const distance = ((atLeft ? 23 : -23) * (p.x - (atLeft ? 75 : 123)) + 40 * (p.y - 62)) / Math.hypot(40, 23);
      expect(distance).toBeCloseTo(-1, 2);
    }
  });

  it("has square terminal ends even with a round document line cap", () => {
    const object = terminal();
    object.style.bondLineCap = "round";
    const points = polygon(object, "b1");
    expect(points.map(p => p.x)).toEqual([75, 75, 123, 123]);
    expect(points.map(p => p.y)).toEqual([58.6, 65.4, 65.4, 58.6]);
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

  it("keeps the pi width and shortening, with a band-width white gap", () => {
    const { object } = boldBondFixture("double");
    const points = polygon(object);
    const pi = ink(object).find(f => f.tag === "line")!;
    expect(pi.attrs["stroke-width"]).toBe(2);
    expect(pi.attrs.y1).toBe(57);
    expect(pi.attrs.y2).toBe(91);
    expect(Number(pi.attrs.x1) - 1 - Math.max(...points.map(p => p.x))).toBeCloseTo(2 * BoldBondStyle.clearGapRatio, 6);
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
      expect(clearGap).toBeCloseTo(6.8, 3);
    }
  });

  it("is independent of bond traversal order and direction", () => {
    const { object } = boldBondFixture("ring");
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
    expect(nativeMoleculeBondDrawingStyle(object, "b1").bondBoldWidthPx).toBeCloseTo(10.2);
    object.style = { ...stylePresetToObjectStyle(NativeStylePresets[0]), bondStrokeWidthPx: 4, bondBoldWidthPx: 9.6 };
    expect(nativeMoleculeBondDrawingStyle(object, "b1").bondBoldWidthPx).toBeCloseTo(13.6);
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

  it("clears an underlying bond across the bold band's displaced pi line", () => {
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
