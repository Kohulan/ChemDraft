import { describe, expect, it } from "vitest";
import { createRotationSweep } from "./interaction/rotationSweep";
import { snapRotationDegrees } from "./rotationSnap";

const center = { x: 200, y: 150 };
function atAngle(degrees: number, radius = 20) {
  const radians = degrees * Math.PI / 180;
  return { x: center.x + radius * Math.cos(radians), y: center.y + radius * Math.sin(radians) };
}

describe("pointer rotation sweep", () => {
  it.each([20, 200])("turns 45° along a %spx radius", (radius) => {
    const turn = createRotationSweep(center, atAngle(0, radius));
    turn.update(atAngle(45, radius));
    expect(turn.degrees).toBe(45);
  });

  it.each([1, -1])("keeps accumulating in direction %s through 180° and past one full turn", (direction) => {
    const turn = createRotationSweep(center, atAngle(0));
    for (const angle of [90, 170, 180, 190, 270, 360, 405]) {
      turn.update(atAngle(direction * angle));
      expect(turn.degrees).toBe(direction * angle);
    }
  });

  it("holds the previous turn at the center and resumes from the new bearing", () => {
    const turn = createRotationSweep(center, atAngle(0));
    turn.update(atAngle(45));
    for (const point of [center, atAngle(135, 0.5), atAngle(225)]) {
      turn.update(point);
      expect(turn.degrees).toBe(45);
    }
    turn.update(atAngle(240));
    expect(turn.degrees).toBe(60);
  });

  it("starts at zero if the drag begins at the center", () => {
    const turn = createRotationSweep(center, center);
    turn.update(atAngle(120));
    expect(turn.degrees).toBe(0);
    turn.update(atAngle(105));
    expect(turn.degrees).toBe(-15);
  });
});

describe("rotation drag snapping", () => {
  it.each([
    [12, 15], [14.9, 15], [15, 15], [18, 15], [18.1, 18.1],
    [-12, -15], [-14.9, -15], [-15, -15], [-18, -15], [-18.1, -18.1],
    [22, 22], [-22, -22],
    [178, 180], [192, 195], [-192, -195],
    [358, 360], [374.9, 375], [378.1, 378.1], [-374.9, -375],
    [718, 720]
  ])("magnetically snaps %s° to %s°", (degrees, expected) => {
    expect(snapRotationDegrees(degrees)).toBe(expected);
  });

  it.each([
    [4, 0], [8, 15], [22, 15], [23, 30], [-8, -15], [-23, -30],
    [184, 180], [188, 195], [364, 360], [368, 375], [-368, -375]
  ])("rounds %s° to %s° with Shift", (degrees, expected) => {
    expect(snapRotationDegrees(degrees, { shiftKey: true })).toBe(expected);
  });

  it("retains junction fragments' absolute grid and relative bond targets", () => {
    expect(snapRotationDegrees(18, { referenceDegrees: 10, stepDegrees: 30 })).toBe(20);
    expect(snapRotationDegrees(9, {
      referenceDegrees: 10, stepDegrees: 30, additionalAbsoluteAngles: [20]
    })).toBe(10);
    expect(snapRotationDegrees(22, {
      shiftKey: true, referenceDegrees: 10, stepDegrees: 30, additionalAbsoluteAngles: [20]
    })).toBe(20);
  });

  it.each([
    [7, 8, 15], [7, 15, 15], [7, 22, 30], [7, 37, 45],
    [100, -7, 90], [100, 4, 105], [358, 8, 360], [-7, -22, -30]
  ])("Shift snaps orientation %s° plus delta %s° to %s°", (referenceDegrees, delta, expected) => {
    expect(referenceDegrees + snapRotationDegrees(delta, { referenceDegrees, shiftKey: true })).toBe(expected);
  });

  it("reproduces Shift snapping from an off-grid 7° start for triage 469e", () => {
    const referenceDegrees = 7;
    const snapDrag = (delta: number) => snapRotationDegrees(delta, { referenceDegrees, shiftKey: true });
    const drag = 44;
    const turn = snapDrag(drag);
    expect(turn).toBe(38);
    expect(referenceDegrees + turn).toBe(45);
    expect(snapDrag(45)).toBe(38);

    expect(snapDrag(0)).toBe(-7);
    expect(snapDrag(0.4)).toBe(-7);
    expect(snapDrag(0.5)).toBe(8);
    expect(snapDrag(0.5) - 0.5).toBe(7.5);
    expect(snapDrag(0.5) - snapDrag(0.4)).toBe(15);
  });

  it("snaps a 45° pointer arc from a 7° starting orientation to 45° with Shift", () => {
    const turn = createRotationSweep(center, atAngle(0));
    turn.update(atAngle(45));
    const referenceDegrees = 7;
    expect(referenceDegrees + snapRotationDegrees(turn.degrees, { referenceDegrees, shiftKey: true })).toBe(45);
  });

  it.each([
    [7, 6, 15], [7, 10, 15], [7, 15, 22], [7, 20, 30],
    [100, 3, 105], [100, 8.1, 108.1], [358, 4, 360], [-7, -6, -15]
  ])("magnetically snaps orientation %s° plus delta %s° to %s°", (referenceDegrees, delta, expected) => {
    expect(referenceDegrees + snapRotationDegrees(delta, { referenceDegrees })).toBeCloseTo(expected, 8);
  });
});
