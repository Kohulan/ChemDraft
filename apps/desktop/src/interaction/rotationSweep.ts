type Point = { x: number; y: number };

const minimumRadius = 1; // document pixels

/** Accumulate the signed pointer sweep about a fixed rotation center. */
export function createRotationSweep(center: Point, start: Point) {
  let previousAngle: number | undefined;
  let radians = 0;

  function update(point: Point) {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    if (Math.hypot(dx, dy) <= minimumRadius) {
      // Hold the rotation and take a new bearing when the pointer leaves the center.
      previousAngle = undefined;
      return;
    }

    const angle = Math.atan2(dy, dx);
    if (previousAngle !== undefined) {
      let step = angle - previousAngle;
      if (step > Math.PI) step -= 2 * Math.PI;
      if (step < -Math.PI) step += 2 * Math.PI;
      radians += step;
    }
    previousAngle = angle;
  }

  update(start);
  return {
    update,
    get degrees() {
      return Number((radians * 180 / Math.PI).toFixed(3));
    }
  };
}
