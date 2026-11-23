import { describe, expect, it } from "vitest";
import { applyPatches, applyPatchWithHistory, atomStatedHydrogenCount, createDocumentHistory, createEmptyDocument, dropOrphanedHydrogenHints,
  hydrogenAtomIgnoresStatedCount, hydrogenAtomWithIgnoredCount, redo, serializeDocument, deserializeDocument, undo, type MoleculeObject } from "./index";

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
    ["change charge", (m: MoleculeObject) => { m.atoms[0]!.formalCharge = 1; }],
    ["add radical", (m: MoleculeObject) => { m.atoms[0]!.markRadicals = 1; }],
    ["set isotope", (m: MoleculeObject) => { m.atoms[0]!.isotope = 15; }]
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
    ["its bond removed", (m: MoleculeObject) => { m.bonds.pop(); }],
    ["a radical added to it", (m: MoleculeObject) => { m.atoms[2]!.markRadicals = 1; }],
    ["an isotope set on it", (m: MoleculeObject) => { m.atoms[2]!.isotope = 18; }],
    // Master decision 2026-11-22: retyping is an explicit user statement; the typed label wins.
    ["its label retyped as the same element (a typed literal O)", (m: MoleculeObject) => { m.atoms[2]!.labelLiteral = true; }],
    ["its label retyped with its hydrogens spelled (a typed literal OH)", (m: MoleculeObject) => {
      m.atoms[2] = { ...m.atoms[2]!, element: "OH", labelLiteral: true };
    }]
  ] as const)("drops it on %s", (_name, edit) => {
    expect(oxygen(update(edit)).hydrogenCount).toBeUndefined();
  });

  it.each([
    ["a radical removed from it", { markRadicals: 1 }, { markRadicals: 2 }],
    ["its isotope cleared", { isotope: 18 }, { isotope: 17 }]
  ] as const)("drops it on %s, or changed", (_name, marked, changed) => {
    const document = createEmptyDocument();
    const before = ethoxy();
    before.atoms[2] = { ...before.atoms[2]!, hydrogenCount: 1, ...marked };
    const { markRadicals: _radicals, isotope: _isotope, ...cleared } = before.atoms[2]!;
    for (const atom of [cleared, { ...before.atoms[2]!, ...changed }]) {
      const result = applyPatches(document, [
        { op: "addObject", pageId: document.pages[0]!.id, object: before },
        { op: "updateObject", objectId: before.id, changes: { atoms: before.atoms.map((candidate) => candidate.id === "o" ? atom : candidate) } }
      ]).pages[0]!.objects[0] as MoleculeObject;
      expect(oxygen(result).hydrogenCount).toBeUndefined();
    }
  });

  it("drops it when a typed literal label is made a plain one again (the label was retyped)", () => {
    const document = createEmptyDocument();
    const before = ethoxy();
    before.atoms[2] = { ...before.atoms[2]!, labelLiteral: true };
    const { labelLiteral: _literal, ...plain } = before.atoms[2]!;
    const result = applyPatches(document, [
      { op: "addObject", pageId: document.pages[0]!.id, object: before },
      { op: "updateObject", objectId: before.id, changes: { atoms: before.atoms.map((atom) => atom.id === "o" ? plain : atom) } }
    ]).pages[0]!.objects[0] as MoleculeObject;
    expect(oxygen(result)).toMatchObject({ element: "O" });
    expect(oxygen(result).hydrogenCount).toBeUndefined();
  });

  it("undo of a retype restores the stated count exactly", () => {
    const document = createEmptyDocument();
    const before = ethoxy();
    const added = applyPatchWithHistory(createDocumentHistory(document),
      { op: "addObject", pageId: document.pages[0]!.id, object: before });
    const retyped = applyPatchWithHistory(added, { op: "updateObject", objectId: before.id, changes: {
      atoms: before.atoms.map((atom) => atom.id === "o" ? { ...atom, labelLiteral: true } : atom) } });
    expect(oxygen(retyped.present.pages[0]!.objects[0] as MoleculeObject)).toMatchObject({ labelLiteral: true });
    expect(oxygen(retyped.present.pages[0]!.objects[0] as MoleculeObject).hydrogenCount).toBeUndefined();
    const undone = undo(retyped);
    expect(undone.present).toBe(added.present);
    expect(oxygen(undone.present.pages[0]!.objects[0] as MoleculeObject)).toEqual(before.atoms[2]);
  });

  it("keeps it through a dismissed warning, a hidden label and a label bond side recorded on it", () => {
    expect(oxygen(update((m) => {
      m.atoms[2] = { ...m.atoms[2]!, warningSuppressed: true, labelVisible: false, labelBondSide: { side: "left", atomId: "c2" } };
    })).hydrogenCount).toBe(0);
  });

  it("a merge keeps the absorbed atoms' counts on their new ids; the joining bond drops its two ends'", () => {
    // As the bond tool merges two molecules: the absorbed atoms and bonds are re-minted onto ids the
    // host does not have (one update), then one bond joins the host's S to the absorbed C1 (another).
    const host = ethoxy();
    host.atoms[3] = { ...host.atoms[3]!, hydrogenCount: 1 };
    const absorbedAtoms: MoleculeObject["atoms"] = [
      { id: "m1", element: "C", x: 0, y: 40, formalCharge: 0, hydrogenCount: 2 },
      { id: "m2", element: "C", x: 14, y: 48, formalCharge: 0 },
      { id: "m3", element: "O", x: 28, y: 40, formalCharge: 0, hydrogenCount: 0 }
    ];
    const absorbedBonds: MoleculeObject["bonds"] = [
      { id: "m-b1", fromAtomId: "m1", toAtomId: "m2", order: "single" },
      { id: "m-b2", fromAtomId: "m2", toAtomId: "m3", order: "single" }
    ];
    const atoms = [...host.atoms, ...absorbedAtoms];
    const bonds = [...host.bonds, ...absorbedBonds];
    const document = createEmptyDocument();
    const merged = applyPatches(document, [
      { op: "addObject", pageId: document.pages[0]!.id, object: host },
      { op: "updateObject", objectId: host.id, changes: { atoms, bonds } }
    ]);
    const counts = (result: typeof merged) => Object.fromEntries(
      (result.pages[0]!.objects[0] as MoleculeObject).atoms.map((atom) => [atom.id, atom.hydrogenCount]));
    expect(counts(merged)).toEqual({ c1: undefined, c2: undefined, o: 0, s: 1, m1: 2, m2: undefined, m3: 0 });
    const joined = applyPatches(merged, [{ op: "updateObject", objectId: host.id, changes: {
      bonds: [...bonds, { id: "join", fromAtomId: "s", toAtomId: "m1", order: "single" }]
    } }]);
    expect(counts(joined)).toEqual({ c1: undefined, c2: undefined, o: 0, s: undefined, m1: undefined, m2: undefined, m3: 0 });
  });

  it("a one-update merge (absorbed atoms and joining bond together, as a plugin writes it) drops the same counts", () => {
    // An imported C-C-O (C1 stated 2, O stated 0) joined onto an ethane in one updateObject: the
    // absorbed atoms arrive on re-minted ids with the bond that joins C1 to the ethane's end.
    const ethane = (): MoleculeObject => ({
      ...ethoxy(),
      id: "e",
      atoms: [
        { id: "e1", element: "C", x: 0, y: 0, formalCharge: 0 },
        { id: "e2", element: "C", x: 14, y: 8, formalCharge: 0 }
      ],
      bonds: [{ id: "eb", fromAtomId: "e1", toAtomId: "e2", order: "single" }]
    });
    const absorbedAtoms: MoleculeObject["atoms"] = [
      { id: "m1", element: "C", x: 0, y: 40, formalCharge: 0, hydrogenCount: 2 },
      { id: "m2", element: "C", x: 14, y: 48, formalCharge: 0 },
      { id: "m3", element: "O", x: 28, y: 40, formalCharge: 0, hydrogenCount: 0 }
    ];
    const absorbedBonds: MoleculeObject["bonds"] = [
      { id: "m-b1", fromAtomId: "m1", toAtomId: "m2", order: "single" },
      { id: "m-b2", fromAtomId: "m2", toAtomId: "m3", order: "single" }
    ];
    const join: MoleculeObject["bonds"][number] = { id: "join", fromAtomId: "e2", toAtomId: "m1", order: "single" };
    const document = createEmptyDocument();
    const added = applyPatches(document, [{ op: "addObject", pageId: document.pages[0]!.id, object: ethane() }]);
    const host = ethane();
    const atoms = [...host.atoms, ...absorbedAtoms];
    const counts = (result: typeof added) => Object.fromEntries(
      (result.pages[0]!.objects[0] as MoleculeObject).atoms.map((atom) => [atom.id, atom.hydrogenCount]));
    const onePatch = applyPatches(added, [{ op: "updateObject", objectId: host.id, changes: {
      atoms, bonds: [...host.bonds, ...absorbedBonds, join]
    } }]);
    const twoPatches = applyPatches(applyPatches(added, [{ op: "updateObject", objectId: host.id, changes: {
      atoms, bonds: [...host.bonds, ...absorbedBonds]
    } }]), [{ op: "updateObject", objectId: host.id, changes: { bonds: [...host.bonds, ...absorbedBonds, join] } }]);
    expect(counts(onePatch)).toEqual({ e1: undefined, e2: undefined, m1: undefined, m2: undefined, m3: 0 });
    expect(counts(onePatch)).toEqual(counts(twoPatches));
  });

  it("a new atom bonded only to other new atoms keeps its count; one bonded to an existing atom drops it", () => {
    const document = createEmptyDocument();
    const host = ethoxy();
    const added = applyPatches(document, [{ op: "addObject", pageId: document.pages[0]!.id, object: host }]);
    const result = applyPatches(added, [{ op: "updateObject", objectId: host.id, changes: {
      atoms: [...host.atoms,
        { id: "n1", element: "N", x: 60, y: 20, formalCharge: 0, hydrogenCount: 3 },
        { id: "n2", element: "N", x: 80, y: 20, formalCharge: 0, hydrogenCount: 0 },
        { id: "n3", element: "N", x: 100, y: 20, formalCharge: 0, hydrogenCount: 1 }],
      bonds: [...host.bonds,
        { id: "nb1", fromAtomId: "n1", toAtomId: "n2", order: "single" },
        { id: "nb2", fromAtomId: "s", toAtomId: "n3", order: "single" }]
    } }]).pages[0]!.objects[0] as MoleculeObject;
    expect(Object.fromEntries(result.atoms.map((atom) => [atom.id, atom.hydrogenCount])))
      .toEqual({ c1: undefined, c2: undefined, o: 0, s: undefined, n1: 3, n2: 0, n3: undefined });
  });

  it("is kept when the molecule is added whole (an import, a paste or a duplicate)", () => {
    const document = createEmptyDocument();
    const added = applyPatches(document, [{ op: "addObject", pageId: document.pages[0]!.id, object: ethoxy() }])
      .pages[0]!.objects[0] as MoleculeObject;
    expect(oxygen(added).hydrogenCount).toBe(0);
  });
});

// chem-core's patches never refuse such a count: they also replay paste, duplicate, undo and session
// restore, and refusing a user's own document there is worse than the ignored count. The plugin host
// refuses a plugin or assistant write that sets one (plugin-host writeScope.test.ts); the atom
// validator flags a stored one (apps/desktop atomProblems.test.ts).
describe("a hydrogen count an H, D or T atom cannot carry is stored as written, never refused", () => {
  const withHydrogen = (element: string, hydrogenCount?: number): MoleculeObject => {
    const molecule = ethoxy();
    return { ...molecule,
      atoms: [...molecule.atoms, { id: "h", element, x: 40, y: 10, formalCharge: 0, ...(hydrogenCount === undefined ? {} : { hydrogenCount }) }],
      bonds: [...molecule.bonds, { id: "bh", fromAtomId: "s", toAtomId: "h", order: "single" }] };
  };
  const pageId = () => createEmptyDocument().pages[0]!.id;
  const hydrogenOf = (document: ReturnType<typeof createEmptyDocument>) =>
    (document.pages[0]!.objects[0] as MoleculeObject).atoms.find((atom) => atom.id === "h")!;

  it("adds a molecule whose H, D or T atom states 2 or 0, keeping the count as written", () => {
    for (const element of ["H", "D", "T"]) {
      for (const count of [2, 0]) {
        const added = applyPatches(createEmptyDocument(), [{ op: "addObject", pageId: pageId(), object: withHydrogen(element, count) }]);
        expect(hydrogenOf(added).hydrogenCount).toBe(count);
      }
    }
  });

  it("an update setting 1 on an existing H stores it, and the native file round-trips it unchanged", () => {
    const document = applyPatches(createEmptyDocument(), [{ op: "addObject", pageId: pageId(), object: withHydrogen("H") }]);
    const updated = applyPatches(document, [{ op: "updateObject", objectId: "m", changes: { atoms: withHydrogen("H", 1).atoms } }]);
    expect(hydrogenOf(updated).hydrogenCount).toBe(1);
    expect(hydrogenOf(document).hydrogenCount).toBeUndefined();
    expect(hydrogenOf(deserializeDocument(serializeDocument(updated)))).toEqual(hydrogenOf(updated));
  });

  it("an edit elsewhere in a molecule that holds such a count keeps it", () => {
    const document = createEmptyDocument();
    document.pages[0]!.objects.push(withHydrogen("H", 1));
    const moved = applyPatches(document, [{ op: "updateObject", objectId: "m", changes: {
      atoms: withHydrogen("H", 1).atoms.map((atom) => ({ ...atom, x: atom.x + 5 }))
    } }]);
    expect(hydrogenOf(moved).hydrogenCount).toBe(1);
  });

  it("undo and redo across an edit of a document holding such a count restore each state exactly", () => {
    const document = createEmptyDocument();
    document.pages[0]!.objects.push(withHydrogen("H", 1));
    const edited = applyPatchWithHistory(createDocumentHistory(document), { op: "updateObject", objectId: "m", changes: {
      atoms: withHydrogen("H", 1).atoms.map((atom) => atom.id === "c1" ? { ...atom, x: atom.x + 7 } : atom)
    } });
    expect(hydrogenOf(edited.present).hydrogenCount).toBe(1);
    const undone = undo(edited);
    expect(undone.present).toBe(document);
    expect(hydrogenOf(undone.present)).toEqual({ id: "h", element: "H", x: 40, y: 10, formalCharge: 0, hydrogenCount: 1 });
    const redone = redo(undone);
    expect(redone.present).toBe(edited.present);
    expect(hydrogenOf(redone.present).hydrogenCount).toBe(1);
  });

  it("lets an element change drop the count as any element change does", () => {
    const document = applyPatches(createEmptyDocument(), [{ op: "addObject", pageId: pageId(), object: withHydrogen("C", 2) }]);
    const result = applyPatches(document, [{ op: "updateObject", objectId: "m", changes: { atoms: withHydrogen("H", 2).atoms } }]);
    expect(hydrogenOf(result).hydrogenCount).toBeUndefined();
  });

  it("names the atom a write sets such a count on, not one an earlier state already held unchanged", () => {
    const held = withHydrogen("H", 1).atoms;
    expect(hydrogenAtomIgnoresStatedCount(held.at(-1)!)).toBe(true);
    expect(["H", "D", "T"].map((element) => hydrogenAtomIgnoresStatedCount({ id: "h", element, x: 0, y: 0, formalCharge: 0, hydrogenCount: 0 })))
      .toEqual([false, false, false]);
    expect(hydrogenAtomIgnoresStatedCount({ id: "c", element: "C", x: 0, y: 0, formalCharge: 0, hydrogenCount: 2 })).toBe(false);
    expect(hydrogenAtomWithIgnoredCount(held)?.id).toBe("h");
    expect(hydrogenAtomWithIgnoredCount(held, held)).toBeUndefined();
    expect(hydrogenAtomWithIgnoredCount(withHydrogen("H", 2).atoms, held)?.id).toBe("h");
    expect(hydrogenAtomWithIgnoredCount(withHydrogen("D", 1).atoms, held)?.id).toBe("h");
    expect(hydrogenAtomWithIgnoredCount(withHydrogen("D", 0).atoms, held)).toBeUndefined();
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

  it("is 0 on an H, D or T atom stating 0, as a typed H, D or T label means, and undefined for any other count", () => {
    for (const element of ["H", "D", "T"]) {
      expect(stated({ hydrogenCount: 0, element })).toBe(0);
      expect(stated({ hydrogenCount: 0, element }, "single", true)).toBe(0);
      expect(stated({ hydrogenCount: 1, element })).toBeUndefined();
      expect(stated({ hydrogenCount: 2, element })).toBeUndefined();
    }
  });

  it("is undefined on a label that is not an element", () => {
    for (const element of ["*", "R1", "OMe", "o"]) expect(stated({ hydrogenCount: 0, element })).toBeUndefined();
  });

  it("is the stated count on a carbon bonded only datively, as a typed C … CH4 there spells it", () => {
    for (const hydrogenCount of [0, 2, 3, 4]) expect(stated({ hydrogenCount, element: "C" }, "single", true)).toBe(hydrogenCount);
    expect(stated({ hydrogenCount: 0, element: "N" }, "single", true)).toBe(0);
  });
});
