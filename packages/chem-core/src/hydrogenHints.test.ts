import { describe, expect, it } from "vitest";
import { applyPatches, atomStatedHydrogenCount, createEmptyDocument, dropOrphanedHydrogenHints, type MoleculeObject } from "./index";

// A pyrrole as CDXML imports it (aromatic ring bonds, the N's NumHydrogens and one carbon's kept),
// with a single N–Zn bond whose dative meaning an edit can toggle.
const imported = (): MoleculeObject => ({
  id: "m", type: "molecule", x: 0, y: 0, width: 40, height: 40, rotation: 0, style: {},
  structureFormat: "molfile-v2000", structure: "", superatoms: [], rGroups: [],
  atoms: [
    { id: "n", element: "N", x: 0, y: 0, formalCharge: 0, hydrogenCount: 1 },
    { id: "c", element: "C", x: 20, y: 0, formalCharge: 0, hydrogenCount: 1 },
    { id: "c2", element: "C", x: 26, y: 18, formalCharge: 0 },
    { id: "c3", element: "C", x: 10, y: 30, formalCharge: 0 },
    { id: "c4", element: "C", x: -6, y: 18, formalCharge: 0 },
    { id: "zn", element: "Zn", x: 40, y: 0, formalCharge: 0 },
    { id: "zn2", element: "Zn", x: -20, y: 0, formalCharge: 0 }
  ],
  bonds: [
    { id: "b", fromAtomId: "n", toAtomId: "c", order: "aromatic" },
    { id: "b2", fromAtomId: "c", toAtomId: "c2", order: "aromatic" },
    { id: "b3", fromAtomId: "c2", toAtomId: "c3", order: "aromatic" },
    { id: "b4", fromAtomId: "c3", toAtomId: "c4", order: "aromatic" },
    { id: "b5", fromAtomId: "c4", toAtomId: "n", order: "aromatic" },
    { id: "bz", fromAtomId: "n", toAtomId: "zn2", order: "single" }
  ]
});

describe("imported hydrogen hints expire on chemical edits", () => {
  it.each([
    ["add covalent bond", (m: MoleculeObject) => m.bonds.push({ id: "new", fromAtomId: "n", toAtomId: "zn", order: "single" })],
    ["add dative bond", (m: MoleculeObject) => m.bonds.push({ id: "new", fromAtomId: "n", toAtomId: "zn", order: "single", display: { bondStyle: "dashed" } })],
    ["remove bond", (m: MoleculeObject) => { m.bonds = m.bonds.filter((bond) => bond.id !== "b5"); }],
    ["change order", (m: MoleculeObject) => { m.bonds[0]!.order = "double"; }],
    ["change dative meaning", (m: MoleculeObject) => { m.bonds[5]!.display = { bondStyle: "dashed" }; }],
    ["change element", (m: MoleculeObject) => { m.atoms[0]!.element = "C"; }],
    ["change charge", (m: MoleculeObject) => { m.atoms[0]!.formalCharge = 1; }]
  ] as const)("%s clears the affected atom's hint through document patches", (_name, edit) => {
    const document = createEmptyDocument();
    const before = imported();
    const after = structuredClone(before);
    edit(after);
    const result = applyPatches(document, [
      { op: "addObject", pageId: document.pages[0]!.id, object: before },
      { op: "updateObject", objectId: before.id, changes: after }
    ]).pages[0]!.objects[0] as MoleculeObject;
    expect(result.atoms[0]!.hydrogenCount).toBeUndefined();
    expect(before.atoms[0]!.hydrogenCount).toBe(1);
  });

  it("keeps imported hints on geometry, wedge and color edits", () => {
    const document = createEmptyDocument();
    const before = imported();
    const result = applyPatches(document, [
      { op: "addObject", pageId: document.pages[0]!.id, object: before },
      { op: "updateObject", objectId: before.id, changes: {
        atoms: before.atoms.map((atom) => ({ ...atom, x: atom.x + 1 })),
        bonds: before.bonds.map((bond) => ({
          ...bond, fromAtomId: bond.toAtomId, toAtomId: bond.fromAtomId, display: { bondStyle: "wedge" as const }
        })),
        style: { bondColor: "#123456" }
      } }
    ]).pages[0]!.objects[0] as MoleculeObject;
    expect(result.atoms.map((atom) => atom.hydrogenCount)).toEqual([1, 1, undefined, undefined, undefined, undefined, undefined]);
  });
});

describe("a new molecule drops only a hint orphaned from its aromatic ring", () => {
  const add = (molecule: MoleculeObject): MoleculeObject => {
    const document = createEmptyDocument();
    return applyPatches(document, [{ op: "addObject", pageId: document.pages[0]!.id, object: molecule }])
      .pages[0]!.objects[0] as MoleculeObject;
  };

  it("keeps the hints of a whole aromatic ring when the molecule is added", () => {
    expect(add(imported()).atoms.map((atom) => atom.hydrogenCount))
      .toEqual([1, 1, undefined, undefined, undefined, undefined, undefined]);
  });

  it("drops a hint when a new molecule keeps only part of the ring (a copied N plus one neighbour)", () => {
    // Built directly, as a fragment copy, split or external paste would: there is no previous
    // graph to diff, so the stale count must be dropped on the way in.
    const whole = imported();
    const fragment: MoleculeObject = {
      ...whole,
      atoms: whole.atoms.filter((atom) => atom.id === "n" || atom.id === "c"),
      bonds: whole.bonds.filter((bond) => bond.id === "b")
    };
    expect(fragment.bonds.map((bond) => bond.order)).toEqual(["aromatic"]);
    expect(add(fragment).atoms.map((atom) => atom.hydrogenCount)).toEqual([undefined, undefined]);
    // The input is never mutated.
    expect(fragment.atoms[0]!.hydrogenCount).toBe(1);
  });

  it("keeps a stated count on an atom with no aromatic bond at all: it describes the atom itself", () => {
    // Owner ruling (1.2.3): a CDXML NumHydrogens that disagrees with the derived count is kept as
    // written and badged, so a molecule entering the document (an import, a whole-molecule paste or
    // duplicate) keeps it. Only an atom whose aromatic bonds no longer sit in a ring loses its count.
    const molecule: MoleculeObject = {
      ...imported(),
      atoms: [
        { id: "n", element: "N", x: 0, y: 0, formalCharge: 0, hydrogenCount: 2 },
        { id: "c", element: "C", x: 20, y: 0, formalCharge: 0, hydrogenCount: 3 }
      ],
      bonds: [{ id: "b", fromAtomId: "n", toAtomId: "c", order: "single" }]
    };
    expect(add(molecule).atoms.map((atom) => atom.hydrogenCount)).toEqual([2, 3]);
    expect(dropOrphanedHydrogenHints(molecule.atoms, molecule.bonds)).toBe(molecule.atoms);
  });

  it("keeps a lone atom's stated count (no bonds, so no ring that could have been cut)", () => {
    const molecule: MoleculeObject = {
      ...imported(),
      atoms: [{ id: "o", element: "O", x: 0, y: 0, formalCharge: 0, hydrogenCount: 0 }],
      bonds: []
    };
    expect(add(molecule).atoms[0]!.hydrogenCount).toBe(0);
  });

  it("drops the hint through an update that cuts the ring down to an acyclic aromatic bond", () => {
    const document = createEmptyDocument();
    const before = imported();
    const result = applyPatches(document, [
      { op: "addObject", pageId: document.pages[0]!.id, object: before },
      { op: "updateObject", objectId: before.id, changes: {
        atoms: before.atoms.filter((atom) => atom.id === "n" || atom.id === "c"),
        bonds: before.bonds.filter((bond) => bond.id === "b")
      } }
    ]).pages[0]!.objects[0] as MoleculeObject;
    expect(result.atoms.map((atom) => atom.hydrogenCount)).toEqual([undefined, undefined]);
  });

  it("returns the same array when there is nothing to drop", () => {
    const { atoms, bonds } = imported();
    expect(dropOrphanedHydrogenHints(atoms, bonds)).toBe(atoms);
  });
});

// Ethanol as a CDXML file with NumHydrogens="0" on the O imports it: the O's stated count disagrees
// with the derived one and is kept on the atom (owner ruling, 1.2.3).
const ethoxy = (): MoleculeObject => ({
  id: "m", type: "molecule", x: 0, y: 0, width: 40, height: 20, rotation: 0, style: {},
  structureFormat: "molfile-v2000", structure: "", superatoms: [], rGroups: [],
  atoms: [
    { id: "c1", element: "C", x: 0, y: 0, formalCharge: 0 },
    { id: "c2", element: "C", x: 14, y: 8, formalCharge: 0 },
    { id: "o", element: "O", x: 28, y: 0, formalCharge: 0, hydrogenCount: 0 },
    { id: "s", element: "S", x: 60, y: 0, formalCharge: 0 }
  ],
  bonds: [
    { id: "b1", fromAtomId: "c1", toAtomId: "c2", order: "single" },
    { id: "b2", fromAtomId: "c2", toAtomId: "o", order: "single" }
  ]
});

describe("a stated count on an atom with no aromatic bond lasts until that atom is edited chemically", () => {
  const update = (edit: (molecule: MoleculeObject) => void): MoleculeObject => {
    const document = createEmptyDocument();
    const before = ethoxy();
    const after = structuredClone(before);
    edit(after);
    return applyPatches(document, [
      { op: "addObject", pageId: document.pages[0]!.id, object: before },
      { op: "updateObject", objectId: before.id, changes: after }
    ]).pages[0]!.objects[0] as MoleculeObject;
  };
  const oxygen = (molecule: MoleculeObject) => molecule.atoms.find((atom) => atom.id === "o")!;

  it.each([
    ["a move", (m: MoleculeObject) => { m.atoms.forEach((atom) => { atom.x += 50; atom.y -= 20; }); }],
    ["a rotation", (m: MoleculeObject) => { m.atoms.forEach((atom) => { [atom.x, atom.y] = [-atom.y, atom.x]; }); }],
    ["an alignment of one atom", (m: MoleculeObject) => { m.atoms[2]!.y = m.atoms[0]!.y; }],
    ["a reversed bond with a new style", (m: MoleculeObject) => {
      m.bonds[1] = { ...m.bonds[1]!, fromAtomId: "o", toAtomId: "c2", display: { bondStyle: "bold" } };
    }],
    ["a label offset and color", (m: MoleculeObject) => {
      m.atoms[2]!.labelOffset = { x: 2, y: 1 };
      m.style = { atomLabelColors: { o: "#123456" } };
    }],
    ["a chemical edit of another atom", (m: MoleculeObject) => { m.atoms[0]!.element = "N"; m.atoms[0]!.formalCharge = 1; }],
    ["a bond added elsewhere", (m: MoleculeObject) => { m.bonds.push({ id: "b3", fromAtomId: "c1", toAtomId: "s", order: "single" }); }]
  ] as const)("keeps it through %s", (_name, edit) => {
    expect(oxygen(update(edit)).hydrogenCount).toBe(0);
  });

  it.each([
    ["an element change", (m: MoleculeObject) => { m.atoms[2]!.element = "S"; }],
    ["a charge change", (m: MoleculeObject) => { m.atoms[2]!.formalCharge = -1; }],
    ["a bond order change at it", (m: MoleculeObject) => { m.bonds[1]!.order = "double"; }],
    ["a bond added at it", (m: MoleculeObject) => { m.bonds.push({ id: "b3", fromAtomId: "o", toAtomId: "s", order: "single" }); }],
    ["a dative bond added at it", (m: MoleculeObject) => {
      m.bonds.push({ id: "b3", fromAtomId: "o", toAtomId: "s", order: "single", display: { bondStyle: "dashed" } });
    }],
    ["its bond made dative", (m: MoleculeObject) => { m.bonds[1]!.display = { bondStyle: "dashed" }; }],
    ["its bond removed", (m: MoleculeObject) => { m.bonds.pop(); }]
  ] as const)("drops it on %s", (_name, edit) => {
    expect(oxygen(update(edit)).hydrogenCount).toBeUndefined();
  });

  it("is kept when the molecule is added whole (an import, a paste or a duplicate)", () => {
    const document = createEmptyDocument();
    const added = applyPatches(document, [{ op: "addObject", pageId: document.pages[0]!.id, object: ethoxy() }])
      .pages[0]!.objects[0] as MoleculeObject;
    expect(oxygen(added).hydrogenCount).toBe(0);
  });
});

describe("atomStatedHydrogenCount: the count an atom states for itself", () => {
  const chain = (atom: Partial<MoleculeObject["atoms"][number]>, order: MoleculeObject["bonds"][number]["order"] = "single", dashed = false) => {
    const atoms: MoleculeObject["atoms"] = [
      { id: "c", element: "C", x: 0, y: 0, formalCharge: 0 },
      { id: "x", element: "O", x: 20, y: 0, formalCharge: 0, ...atom }
    ];
    const bonds: MoleculeObject["bonds"] = [
      { id: "b", fromAtomId: "c", toAtomId: "x", order, ...(dashed ? { display: { bondStyle: "dashed" as const } } : {}) }
    ];
    return { atom: atoms[1]!, bonds };
  };
  const stated = (atom: Partial<MoleculeObject["atoms"][number]>, order?: MoleculeObject["bonds"][number]["order"], dashed?: boolean) => {
    const subject = chain(atom, order, dashed);
    return atomStatedHydrogenCount(subject.atom, subject.bonds);
  };

  it("is the stated count on an ordinary element atom, zero included", () => {
    expect(stated({ hydrogenCount: 0 })).toBe(0);
    expect(stated({ hydrogenCount: 2, element: "N" })).toBe(2);
    expect(stated({ hydrogenCount: 0 }, "double")).toBe(0);
    expect(stated({ hydrogenCount: 3, element: "C" })).toBe(3);
  });

  it("is undefined with no count, on a typed literal label, and on an aromatic bond", () => {
    expect(stated({})).toBeUndefined();
    expect(stated({ hydrogenCount: 0, labelLiteral: true })).toBeUndefined();
    expect(stated({ hydrogenCount: 0 }, "aromatic")).toBeUndefined();
    const pyrrole = imported();
    expect(pyrrole.atoms.map((atom) => atomStatedHydrogenCount(atom, pyrrole.bonds))).toEqual(pyrrole.atoms.map(() => undefined));
  });

  it("is undefined on hydrogen, a label that is not an element, and a carbon bonded only datively", () => {
    for (const element of ["H", "D", "T", "*", "R1", "OMe", "o"]) expect(stated({ hydrogenCount: 0, element })).toBeUndefined();
    expect(stated({ hydrogenCount: 0, element: "C" }, "single", true)).toBeUndefined();
    // Only carbon lacks a single derived count on a dative bond alone; a dative N donor has one.
    expect(stated({ hydrogenCount: 0, element: "N" }, "single", true)).toBe(0);
  });
});
