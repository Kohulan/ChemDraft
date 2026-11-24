import { describe, expect, it } from "vitest";
import type { DocumentObject, ElectronMarkObject, MoleculeObject } from "@chemdraft/chem-core";
import {
  addOnesExactly, ElectronMarkPlacementIndex, nativeChargePlacementPointForAtom, nativeRadicalPlacementPointForAtom,
  transformPointForObject
} from "./index";

// Electron-mark placement scored every candidate against every charge mark on the page (and every
// radical dot on an occupied atom), so placing dots on many atoms cost (atoms x page marks). The
// placement index reads only nearby marks. The object-list form is the unchanged reference: the index
// must give the same points, bit for bit (toEqual on the coordinates, no tolerance).

/** Deterministic pseudo-random numbers, so every run checks the same pages. */
function random(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

function chain(id: string, cx: number, cy: number, length: number, rotation: number, nitrogen: (index: number) => boolean): MoleculeObject {
  const atoms = Array.from({ length }, (_, index) => ({ id: `a${index}`, element: nitrogen(index) ? "N" : "C", formalCharge: 0,
    x: cx + 22 * Math.cos(index * Math.PI / 3), y: cy + 22 * Math.sin(index * Math.PI / 3) }));
  return { id, type: "molecule", x: cx - 30, y: cy - 30, width: 60, height: 60, rotation, style: {}, structureFormat: "smiles",
    structure: "", atoms, bonds: atoms.slice(1).map((_, index) => ({ id: `b${index}`, fromAtomId: `a${index}`, toAtomId: `a${index + 1}`, order: "single" })),
    superatoms: [], rGroups: [] };
}

function mark(id: string, markKind: ElectronMarkObject["markKind"], center: { x: number; y: number }, anchor: ElectronMarkObject["anchor"]): ElectronMarkObject {
  return { id, type: "electron-mark", markKind, x: center.x - 9, y: center.y - 9, width: 18, height: 18, rotation: 0, style: {}, anchor };
}

/** A page of a few small molecules (some rotated) with charges, radical dots and lone pairs on and between their atoms. */
function realisticPage(seed: number, looseMarks: number): { objects: DocumentObject[]; molecules: MoleculeObject[] } {
  const r = random(seed);
  const molecules = Array.from({ length: 1 + Math.floor(r() * 4) }, (_, index) => chain(`m${index}`, 60 + r() * 600, 60 + r() * 450,
    1 + Math.floor(r() * 7), r() < 0.4 ? Math.floor(r() * 360) : 0, () => r() < 0.3));
  const objects: DocumentObject[] = [...molecules];
  const kinds = ["charge", "radical-dot", "lone-pair"] as const;
  for (let index = 0; index < 12 + looseMarks; index++) {
    const kind = kinds[Math.floor(r() * 3)];
    if (index < 12) {
      // On (or close to) an atom, anchored to it most of the time.
      const molecule = molecules[Math.floor(r() * molecules.length)];
      const atom = molecule.atoms[Math.floor(r() * molecule.atoms.length)];
      const page = transformPointForObject(molecule, atom);
      objects.push(mark(`e${index}`, kind, { x: page.x + (r() - 0.5) * 60, y: page.y + (r() - 0.5) * 60 },
        r() < 0.7 ? { kind: "atom", objectId: molecule.id, atomId: atom.id } : { kind: "point" }));
    } else objects.push(mark(`e${index}`, kind, { x: r() * 780, y: r() * 600 }, { kind: "point" }));
  }
  return { objects, molecules };
}

describe("addOnesExactly", () => {
  it("equals that many successive + 1 steps, bit for bit", () => {
    const r = random(7);
    const starts = [0, 0.1, 0.5, 0.75, 1 - 2 ** -53, 1, 1.5, 3.999999999, 7 + 1 / 3, 1023.3, 2 ** 20 - 0.1, 12345.678901234,
      ...Array.from({ length: 200 }, () => r() * 2 ** Math.floor(r() * 24))];
    for (const start of starts) for (const count of [0, 1, 2, 3, 7, 64, 1000, 4099]) {
      let expected = start;
      for (let step = 0; step < count; step++) expected += 1;
      expect(addOnesExactly(start, count), `${start} + ${count} ones`).toBe(expected);
    }
    expect(addOnesExactly(NaN, 3)).toBeNaN();
  });
});

describe("electron-mark placement index (#442 follow-up)", () => {
  it("places radicals and charges exactly where the whole page does, on realistic pages", () => {
    let rotated = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const { objects, molecules } = realisticPage(seed, seed % 4 === 0 ? 150 : 8);
      const index = ElectronMarkPlacementIndex.of(objects);
      const r = random(seed + 1000);
      for (const molecule of molecules) for (const atom of molecule.atoms) {
        expect(nativeRadicalPlacementPointForAtom(molecule, atom.id, index, 792, 612))
          .toEqual(nativeRadicalPlacementPointForAtom(molecule, atom.id, objects, 792, 612));
        expect(nativeChargePlacementPointForAtom(molecule, atom.id, index, 792, 612))
          .toEqual(nativeChargePlacementPointForAtom(molecule, atom.id, objects, 792, 612));
        // A mark being dropped does not obstruct itself.
        const dropped = objects.find((object): object is ElectronMarkObject => object.type === "electron-mark")!;
        expect(nativeChargePlacementPointForAtom(molecule, atom.id, index, 792, 612, dropped))
          .toEqual(nativeChargePlacementPointForAtom(molecule, atom.id, objects, 792, 612, dropped));
        // A prefix view stands for the objects before a position (Save As checks each dot against those).
        const cut = Math.floor(r() * (objects.length + 1));
        expect(nativeRadicalPlacementPointForAtom(molecule, atom.id, index.before(cut), 792, 612))
          .toEqual(nativeRadicalPlacementPointForAtom(molecule, atom.id, objects.slice(0, cut), 792, 612));
        expect(index.before(cut).marksOnAtom(molecule.id, atom.id)).toEqual(objects.slice(0, cut).filter(object =>
          object.type === "electron-mark" && object.anchor.kind === "atom" && object.anchor.objectId === molecule.id && object.anchor.atomId === atom.id));
        if (molecule.rotation) rotated++;
      }
    }
    expect(rotated).toBeGreaterThan(100);
  });

  it("stays exact as dots are added one by one, and with a mark centre too far out to grid", () => {
    const { objects, molecules } = realisticPage(5, 20);
    // Beyond the grid bound (2^40 px): every query reads it, and it scores 1 like any far mark.
    objects.push(mark("far", "charge", { x: 2 ** 41, y: 300 }, { kind: "point" }));
    const index = ElectronMarkPlacementIndex.of(objects);
    for (const molecule of molecules) for (const atom of molecule.atoms) for (let dot = 0; dot < 2; dot++) {
      const expected = nativeRadicalPlacementPointForAtom(molecule, atom.id, objects, 792, 612)!;
      expect(nativeRadicalPlacementPointForAtom(molecule, atom.id, index, 792, 612)).toEqual(expected);
      const added = mark(`${molecule.id}_${atom.id}_${dot}`, "radical-dot", expected, { kind: "atom", objectId: molecule.id, atomId: atom.id });
      objects.push(added);
      index.add(added);
    }
  });

  /** Property reads on the page's objects while placing one radical on every atom. */
  function placementReads(count: number, stacked: boolean, source: "list" | "index", maxScoredMarks?: number): number {
    let reads = 0;
    const counted = <T extends object>(object: T): T => new Proxy(object, {
      get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver) as unknown; }
    });
    const objects: DocumentObject[] = [];
    const molecules: MoleculeObject[] = [];
    // Single-atom fragments, each with a lone pair on its atom (so the radical scores against
    // charges and radical dots) and a charge. Spread: 150 px apart on one line, each charge beside its
    // atom, so every atom has the same surroundings. Stacked: every atom within 20 px of one spot, and
    // every charge on that spot.
    const width = stacked ? 792 : 200 + count * 150;
    for (let index = 0; index < count; index++) {
      const angle = 2 * Math.PI * index / count;
      const x = stacked ? 300 + 20 * Math.cos(angle) : 40 + index * 150, y = stacked ? 300 + 20 * Math.sin(angle) : 300;
      const molecule = chain(`m${index}`, x, y, 1, 0, () => false);
      molecules.push(molecule);
      objects.push(counted(molecule),
        counted(mark(`lp${index}`, "lone-pair", { x, y: y - 14 }, { kind: "atom", objectId: molecule.id, atomId: "a0" })),
        counted(mark(`c${index}`, "charge", stacked ? { x: 300, y: 300 } : { x: x + 14, y: y + 14 }, { kind: "point" })));
    }
    const placementSource = source === "index" ? ElectronMarkPlacementIndex.of(objects, { maxScoredMarks }) : objects;
    for (const molecule of molecules) expect(nativeRadicalPlacementPointForAtom(molecule, "a0", placementSource, width, 612)).toBeDefined();
    return reads;
  }

  it("reads the page a number of times linear in atoms plus marks", () => {
    // The object list is the quadratic reference, so the counter is shown to detect it.
    expect(placementReads(80, false, "list") / placementReads(40, false, "list")).toBeGreaterThan(3.2);
    expect(placementReads(80, false, "index") / placementReads(40, false, "index")).toBeLessThan(2.5);
  });

  it("bounds the marks scored per candidate when a crafted page stacks them on one spot", () => {
    // Every charge sits in the same cell. Up to the cap (256; lowered to 8 here) they are all scored
    // exactly; past it, only the first 8 by page order are, and the rest count as far.
    expect(placementReads(80, true, "index", 8) / placementReads(40, true, "index", 8)).toBeLessThan(2.5);
    // Below the cap the stack is scored in full, so the cap is what bounds it.
    expect(placementReads(80, true, "index") / placementReads(40, true, "index")).toBeGreaterThan(3.2);
    // At the real cap such a small page is still scored in full, exactly as the whole page.
    const { objects, molecules } = realisticPage(9, 0);
    const near = transformPointForObject(molecules[0], molecules[0].atoms[0]);
    for (let index = 0; index < 40; index++) objects.push(mark(`stack${index}`, "charge", { x: near.x + 20 + index * 0.25, y: near.y }, { kind: "point" }));
    const index = ElectronMarkPlacementIndex.of(objects);
    for (const molecule of molecules) for (const atom of molecule.atoms) {
      expect(nativeChargePlacementPointForAtom(molecule, atom.id, index, 792, 612))
        .toEqual(nativeChargePlacementPointForAtom(molecule, atom.id, objects, 792, 612));
    }
  });
});
