/**
 * Where the electron marks a molecule owns (charges, radical dots, lone pairs, radical ions) land
 * when the molecule is redrawn with new atom positions: the Spin 3D live overlay, its flatten, a
 * typed or dragged X/Y rotation of a stored 3D model, and 3D clean-up. One rule for all of them,
 * so the overlay paints each mark exactly where the commit puts it.
 *
 * A mark keeps its 2D offset from its atom. When that spot would land on another atom (one nearer
 * the mark than its own atom, so the mark would read as that atom's) or on a bond, the mark turns
 * about its atom, at the same distance, to the nearest free side. If no side is free it takes the side
 * with the most room, and stays where it was carried when nothing is better. Only positions are decided here;
 * the caller keeps every chemical fact (charge, anchor atom, association) as it was.
 *
 * All points are in the molecule's own frame (its atoms' coordinates). The page-frame wrapper every
 * caller uses is `carryElectronMarksToRedrawnMolecule` (index.ts, beside the frame transforms it needs).
 */

export interface CarriedMarkAtom {
  id: string;
  x: number;
  y: number;
}

export interface CarriedMarkBond {
  fromAtomId: string;
  toAtomId: string;
}

export interface CarriedElectronMark {
  /** The atom the mark follows. */
  atomId: string;
  /** The mark's center minus its atom's position, both from before the move. */
  offset: { x: number; y: number };
  width: number;
  height: number;
}

export interface CarriedMarkCenter {
  /** The mark's new center. */
  center: { x: number; y: number };
  /** How far the mark turned about its atom to reach a free side, in radians (0 when it kept its offset). */
  turn: number;
}

/** Pixels of air kept between a mark's ink and a bond line, or another mark's ink. */
const inkClearancePx = 1;
/** Candidate sides searched on each hand, one every π/16 (a full turn in all). */
const sideSteps = 16;
/** A crowded mark moves to a not-free side only when that side is clearly roomier than where it was carried. */
const minimumRoomGain = 0.05;

/** The radius of a mark's ink, as drawn in its frame. */
export function carriedElectronMarkInkRadius(mark: { width: number; height: number }): number {
  return Math.min(mark.width, mark.height) * 0.35;
}

function segmentDistance(point: { x: number; y: number }, from: { x: number; y: number }, to: { x: number; y: number }): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared))
    : 0;
  return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy));
}

/**
 * Place each carried mark (in the order given) against the moved atoms and bonds. A mark whose atom
 * is missing gets `undefined`. Marks never move onto each other: a mark that turns avoids where the
 * others already sit (or were carried, for those not yet placed).
 */
export function carryElectronMarksWithAtoms(
  atoms: readonly CarriedMarkAtom[],
  bonds: readonly CarriedMarkBond[],
  marks: readonly CarriedElectronMark[]
): Array<CarriedMarkCenter | undefined> {
  const atomById = new Map(atoms.map(atom => [atom.id, atom]));
  const segments = bonds.flatMap(bond => {
    const from = atomById.get(bond.fromAtomId);
    const to = atomById.get(bond.toAtomId);
    return from && to ? [{ from, to }] : [];
  });
  const placed: Array<{ center: { x: number; y: number }; ink: number } | undefined> = marks.map(mark => {
    const atom = atomById.get(mark.atomId);
    return atom ? { center: { x: atom.x + mark.offset.x, y: atom.y + mark.offset.y }, ink: carriedElectronMarkInkRadius(mark) } : undefined;
  });

  const placements: Array<CarriedMarkCenter | undefined> = [];
  marks.forEach((mark, index) => {
    const atom = atomById.get(mark.atomId);
    const carried = placed[index];
    if (!atom || !carried) {
      placements.push(undefined);
      return;
    }
    const placement = placeCarriedMark(atom, mark, carried, placed.filter((other, otherIndex): other is NonNullable<typeof other> =>
      otherIndex !== index && other !== undefined));
    placed[index] = { center: placement.center, ink: carried.ink };
    placements.push(placement);
  });
  return placements;

  function placeCarriedMark(
    atom: CarriedMarkAtom,
    mark: CarriedElectronMark,
    carried: { center: { x: number; y: number }; ink: number },
    others: readonly { center: { x: number; y: number }; ink: number }[]
  ): CarriedMarkCenter {
    const radius = Math.hypot(mark.offset.x, mark.offset.y);
    // A mark drawn on its atom has no side to turn to.
    if (!(radius > 1e-6)) return { center: carried.center, turn: 0 };
    const ink = carried.ink;
    // How clearly the spot reads as this atom's (>= 1: its own atom is the nearest), and how much
    // air its ink keeps from every bond line and every other mark.
    const atomRoom = (center: { x: number; y: number }) => {
      let nearest = Infinity;
      for (const other of atoms) {
        if (other.id === atom.id) continue;
        nearest = Math.min(nearest, Math.hypot(center.x - other.x, center.y - other.y));
      }
      return nearest / radius;
    };
    const bondRoom = (center: { x: number; y: number }) => {
      let room = Infinity;
      for (const segment of segments) room = Math.min(room, segmentDistance(center, segment.from, segment.to) - ink - inkClearancePx);
      return room;
    };
    const markRoom = (center: { x: number; y: number }) => {
      let room = Infinity;
      for (const other of others) {
        room = Math.min(room, Math.hypot(center.x - other.center.x, center.y - other.center.y) - ink - other.ink - inkClearancePx);
      }
      return room;
    };
    // Kept where it was carried unless another atom is now nearer than its own, or a bond runs under it.
    if (atomRoom(carried.center) >= 1 && bondRoom(carried.center) >= 0) return { center: carried.center, turn: 0 };

    const start = Math.atan2(mark.offset.y, mark.offset.x);
    const spot = (turn: number) => ({ x: atom.x + Math.cos(start + turn) * radius, y: atom.y + Math.sin(start + turn) * radius });
    // One number for "how much room": the tightest of the three, each scaled to the mark's distance.
    const room = (center: { x: number; y: number }) =>
      Math.min(atomRoom(center) - 1, bondRoom(center) / radius, markRoom(center) / radius);
    let roomiest: { turn: number; center: { x: number; y: number }; room: number } | undefined;
    for (let step = 1; step <= sideSteps; step += 1) {
      const sides = [step, -step].map(signed => {
        const turn = signed * Math.PI / sideSteps;
        const center = spot(turn);
        return { turn, center, room: room(center) };
      });
      // The smaller turn wins; between the two hands, the roomier one (then the positive one).
      sides.sort((left, right) => right.room - left.room);
      const free = sides.find(side => atomRoom(side.center) >= 1 && bondRoom(side.center) >= 0 && markRoom(side.center) >= 0);
      if (free) return { center: free.center, turn: free.turn };
      if (!roomiest || sides[0]!.room > roomiest.room) roomiest = sides[0];
    }
    return roomiest && roomiest.room > room(carried.center) + minimumRoomGain
      ? { center: roomiest.center, turn: roomiest.turn }
      : { center: carried.center, turn: 0 };
  }
}
