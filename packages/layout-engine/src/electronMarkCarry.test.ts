// The one placement rule for marks a redrawn molecule carries (Spin 3D overlay, flatten, typed
// rotations, Interactive 3D, 3D clean-up): keep the 2D offset from the atom; if that spot lands on
// another atom or a bond, turn about the atom, at the same distance, to the nearest free side.
import { describe, expect, it } from "vitest";
import {
  carriedElectronMarkInkRadius, carriedElectronMarkSvgTransform, carryElectronMarksToRedrawnMolecule, carryElectronMarksWithAtoms,
  type ElectronMarkCarryEntry, type ElectronMarkCarryMolecule
} from "./index";

const size = { width: 18, height: 18 };
const ink = carriedElectronMarkInkRadius(size);

function segmentDistance(point: { x: number; y: number }, from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - from.x - t * dx, point.y - from.y - t * dy);
}

describe("carryElectronMarksWithAtoms", () => {
  it("keeps the offset when the carried spot is free", () => {
    const atoms = [{ id: "a", x: 0, y: 0 }, { id: "b", x: -30, y: 0 }];
    const [placed] = carryElectronMarksWithAtoms(atoms, [{ fromAtomId: "a", toAtomId: "b" }], [{ atomId: "a", offset: { x: 15, y: -15 }, ...size }]);
    expect(placed).toEqual({ center: { x: 15, y: -15 }, turn: 0 });
  });

  it("turns, at the same distance, off a spot another atom has moved next to", () => {
    // After the move another atom sits just past the mark: kept, it would read as that atom's.
    const atoms = [{ id: "a", x: 0, y: 0 }, { id: "b", x: 30, y: 4 }];
    const [placed] = carryElectronMarksWithAtoms(atoms, [], [{ atomId: "a", offset: { x: 22, y: 0 }, ...size }]);
    expect(placed!.turn).not.toBe(0);
    expect(Math.hypot(placed!.center.x, placed!.center.y)).toBeCloseTo(22, 9);
    expect(Math.hypot(placed!.center.x - 30, placed!.center.y - 4)).toBeGreaterThanOrEqual(22);
    // The nearest free side: b sits just below the kept spot's line, so the mark turns up (negative y), and only as far as needed.
    expect(placed!.center.y).toBeLessThan(0);
    expect(Math.abs(placed!.turn)).toBeLessThanOrEqual(Math.PI / 2);
  });

  it("turns off a bond that now runs under the mark", () => {
    const atoms = [{ id: "a", x: 0, y: 0 }, { id: "c", x: 0, y: 40 }];
    const bonds = [{ fromAtomId: "a", toAtomId: "c" }];
    const [placed] = carryElectronMarksWithAtoms(atoms, bonds, [{ atomId: "a", offset: { x: 0, y: 22 }, ...size }]);
    expect(placed!.turn).not.toBe(0);
    expect(Math.hypot(placed!.center.x, placed!.center.y)).toBeCloseTo(22, 9);
    expect(segmentDistance(placed!.center, atoms[0]!, atoms[1]!)).toBeGreaterThan(ink);
  });

  it("keeps two turning marks off each other", () => {
    const atoms = [{ id: "a", x: 0, y: 0 }, { id: "c", x: 0, y: 40 }];
    const bonds = [{ fromAtomId: "a", toAtomId: "c" }];
    const [first, second] = carryElectronMarksWithAtoms(atoms, bonds, [
      { atomId: "a", offset: { x: 0, y: 22 }, ...size }, { atomId: "a", offset: { x: 0.5, y: 22 }, ...size }
    ]);
    expect(Math.hypot(first!.center.x - second!.center.x, first!.center.y - second!.center.y)).toBeGreaterThan(2 * ink);
  });

  it("leaves a mark drawn on its atom, and skips one whose atom is gone", () => {
    const atoms = [{ id: "a", x: 5, y: 5 }];
    expect(carryElectronMarksWithAtoms(atoms, [], [
      { atomId: "a", offset: { x: 0, y: 0 }, ...size }, { atomId: "gone", offset: { x: 10, y: 0 }, ...size }
    ])).toEqual([{ center: { x: 5, y: 5 }, turn: 0 }, undefined]);
  });
});

function molecule(atoms: ElectronMarkCarryMolecule["atoms"], rotation = 0, bonds: ElectronMarkCarryMolecule["bonds"] = []): ElectronMarkCarryMolecule {
  return { atoms, bonds, x: 0, y: 0, width: 100, height: 100, rotation };
}

describe("carryElectronMarksToRedrawnMolecule", () => {
  const charge: ElectronMarkCarryEntry = { atomId: "a", mark: { id: "m", markKind: "charge", x: 21, y: 1, ...size, rotation: 0 } };

  it("holds the mark's page offset from its atom when the molecule moves", () => {
    const before = molecule([{ id: "a", x: 10, y: 10 }, { id: "b", x: -20, y: 10 }]);
    const after = molecule([{ id: "a", x: 60, y: 40 }, { id: "b", x: 30, y: 40 }]);
    expect(carryElectronMarksToRedrawnMolecule(before, after, [charge]).get("m")).toEqual({
      markId: "m", atomId: "a", x: 71, y: 31, rotation: 0, turnDegrees: 0
    });
  });

  it("reads the page offset in a rotated molecule's own frame", () => {
    const before = molecule([{ id: "a", x: 10, y: 10 }]);
    // Redrawn turned a quarter about its centre (50, 50): atom a draws on the page at (90, 10).
    const after = molecule([{ id: "a", x: 10, y: 10 }], 90);
    const placed = carryElectronMarksToRedrawnMolecule(before, after, [charge]).get("m")!;
    // The mark's centre stays 20 px to the right of its atom on the page.
    expect(placed.x + 9).toBeCloseTo(110, 9);
    expect(placed.y + 9).toBeCloseTo(10, 9);
  });

  it("turns a lone pair with it, and keeps every other mark's own rotation", () => {
    const before = molecule([{ id: "a", x: 0, y: 0 }]);
    const after = molecule([{ id: "a", x: 0, y: 0 }, { id: "b", x: 30, y: 4 }]);
    const lonePair: ElectronMarkCarryEntry = { atomId: "a", mark: { id: "lp", markKind: "lone-pair", x: 13, y: -9, ...size, rotation: 90 } };
    const radical: ElectronMarkCarryEntry = { atomId: "a", mark: { id: "r", markKind: "radical-dot", x: 13, y: -9, ...size, rotation: 30 } };
    const placements = carryElectronMarksToRedrawnMolecule(before, after, [lonePair]);
    const turned = placements.get("lp")!;
    expect(turned.turnDegrees).not.toBe(0);
    expect(turned.rotation).toBeCloseTo(((90 + turned.turnDegrees) % 360 + 360) % 360, 9);
    const kept = carryElectronMarksToRedrawnMolecule(before, after, [radical]).get("r")!;
    expect(kept.turnDegrees).not.toBe(0);
    expect(kept.rotation).toBe(30);
  });

  it("paints the stored drawing at the placement: a move, plus a turn about its centre when it turned", () => {
    const mark = { id: "m", markKind: "lone-pair" as const, x: 10, y: 20, ...size, rotation: 350 };
    expect(carriedElectronMarkSvgTransform(mark, { x: 15, y: 18, rotation: 350 })).toBe("translate(5 -2)");
    expect(carriedElectronMarkSvgTransform(mark, { x: 15, y: 18, rotation: 20 })).toBe("translate(5 -2) rotate(30 19 29)");
  });
});
