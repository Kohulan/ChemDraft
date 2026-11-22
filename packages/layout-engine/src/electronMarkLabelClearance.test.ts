// electronMarkCentreClearOfAtomLabel: where a charge or radical mark must sit to clear its atom's
// label box. The label box and atoms are in the molecule's unrotated frame, so a mark turned relative
// to its molecule covers its rotated extents there, not its stored width and height.

import { describe, expect, it } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";

import {
  electronMarkCentreClearOfAtomLabel,
  electronMarkLabelGapPx,
  inverseTransformPointForObject,
  moleculeLayoutLabelBoxes,
  transformPointForObject
} from "./index";

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x)
  && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);

/** Methylamine, C left of N; N draws an "NH2" label. */
function methylamine(rotation: number): MoleculeObject {
  return {
    id: "m", type: "molecule", x: 20, y: 60, width: 50, height: 40, rotation,
    style: {}, structureFormat: "smiles", structure: "CN", superatoms: [], rGroups: [],
    atoms: [
      { id: "c", element: "C", x: 30, y: 80, formalCharge: 0 },
      { id: "n", element: "N", x: 60, y: 80, formalCharge: 0 }
    ],
    bonds: [{ id: "cn", fromAtomId: "c", toAtomId: "n", order: "single" }]
  };
}

/** A 30 × 8 mark (a wide, flat glyph) centred `rise` px above N's label top in the molecule frame. */
function markAboveLabel(molecule: MoleculeObject, rotation: number, rise = 8) {
  const label = moleculeLayoutLabelBoxes(molecule).find(box => molecule.atoms[box.atom].id === "n")!;
  const n = molecule.atoms[1];
  const centre = transformPointForObject(molecule, { x: n.x, y: label.y - rise });
  return { label, n, mark: { x: centre.x - 15, y: centre.y - 4, width: 30, height: 8, rotation } };
}

/** The mark's axis-aligned box in the molecule frame, for a centre given in the page frame. */
function frameBox(molecule: MoleculeObject, pageCentre: { x: number; y: number }, width: number, height: number, rotation: number): Box {
  const centre = inverseTransformPointForObject(molecule, pageCentre);
  const turn = ((rotation - molecule.rotation) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(turn)), sin = Math.abs(Math.sin(turn));
  const w = cos * width + sin * height, h = sin * width + cos * height;
  return { x: centre.x - w / 2, y: centre.y - h / 2, width: w, height: h };
}

describe("electronMarkCentreClearOfAtomLabel", () => {
  it("leaves an unrotated flat mark that already clears the label where it is", () => {
    const molecule = methylamine(0);
    const { mark } = markAboveLabel(molecule, 0);
    expect(electronMarkCentreClearOfAtomLabel(molecule, "n", mark, 100)).toBeUndefined();
  });

  it("moves the same mark turned 90° (30 px tall in the molecule frame) straight up, clear of the label", () => {
    const molecule = methylamine(0);
    const { mark, label, n } = markAboveLabel(molecule, 90);
    const cleared = electronMarkCentreClearOfAtomLabel(molecule, "n", mark, 100);
    expect(cleared).toBeDefined();
    expect(cleared!.x).toBeCloseTo(n.x);
    expect(cleared!.y).toBeLessThan(mark.y + mark.height / 2);
    const box = frameBox(molecule, cleared!, mark.width, mark.height, mark.rotation);
    expect(overlaps(box, label)).toBe(false);
    // Just far enough: the rotated box's bottom sits the gap above the label.
    expect(box.y + box.height).toBeCloseTo(label.y - electronMarkLabelGapPx);
  });

  it("in a molecule turned 90°, a mark turned with it keeps its stored extents and stays clear", () => {
    const molecule = methylamine(90);
    const { mark } = markAboveLabel(molecule, 90);
    expect(electronMarkCentreClearOfAtomLabel(molecule, "n", mark, 100)).toBeUndefined();
  });

  it("in a molecule turned 90°, an unrotated mark covers its swapped extents and is moved clear, in its direction", () => {
    const molecule = methylamine(90);
    const { mark, label, n } = markAboveLabel(molecule, 0);
    const cleared = electronMarkCentreClearOfAtomLabel(molecule, "n", mark, 100);
    expect(cleared).toBeDefined();
    const local = inverseTransformPointForObject(molecule, cleared!);
    expect(local.x).toBeCloseTo(n.x);
    expect(local.y).toBeLessThan(label.y);
    expect(overlaps(frameBox(molecule, cleared!, mark.width, mark.height, mark.rotation), label)).toBe(false);
  });

  it("never moves a mark farther than maxDistance from its atom", () => {
    const molecule = methylamine(0);
    const { mark, n } = markAboveLabel(molecule, 90);
    const plain = electronMarkCentreClearOfAtomLabel(molecule, "n", mark, 100)!;
    const capped = electronMarkCentreClearOfAtomLabel(molecule, "n", mark, Math.hypot(plain.x - n.x, plain.y - n.y) - 2);
    expect(capped).toBeDefined();
    expect(Math.hypot(capped!.x - n.x, capped!.y - n.y)).toBeCloseTo(Math.hypot(plain.x - n.x, plain.y - n.y) - 2);
  });

  it("returns undefined for an atom that draws no label or is not in the molecule", () => {
    const molecule = methylamine(0);
    const { mark } = markAboveLabel(molecule, 90);
    expect(electronMarkCentreClearOfAtomLabel(molecule, "c", mark, 100)).toBeUndefined();
    expect(electronMarkCentreClearOfAtomLabel(molecule, "missing", mark, 100)).toBeUndefined();
  });
});
