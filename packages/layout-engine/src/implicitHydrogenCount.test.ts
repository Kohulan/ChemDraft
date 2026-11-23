import { describe, expect, it } from "vitest";

import { atomImpliedRadicalCount, createEmptyDocument, DefaultNativeDrawingStyle, type MoleculeAtom, type MoleculeBond, type MoleculeObject } from "@chemdraft/chem-core";

import { atomDerivedHydrogenCount, atomDisplayLabel, atomDrawnHydrogenCount, atomImplicitHydrogenCount, planPageSvgRender } from "./index";
import { nativeBondOrderResolution } from "./valence";

/**
 * `atomImplicitHydrogenCount` is the one implicit-hydrogen count the label planner draws and the
 * CDXML importer compares stated NumHydrogens against (AGENTS.md §9: atom-label content math lives
 * only here). Each case pins both the count and the label the planner draws with it, so moving the
 * calculation into the helper is proven not to change a single drawn label.
 */
const atom = (id: string, element: string, x: number, y = 0, extra: Partial<MoleculeAtom> = {}): MoleculeAtom =>
  ({ id, element, x, y, formalCharge: 0, ...extra });
const bond = (id: string, fromAtomId: string, toAtomId: string, order: MoleculeBond["order"] = "single", dashed = false): MoleculeBond =>
  ({ id, fromAtomId, toAtomId, order, ...(dashed ? { display: { bondStyle: "dashed" as const } } : {}) });

function both(target: string, atoms: MoleculeAtom[], bonds: MoleculeBond[] = []) {
  const subject = atoms.find((candidate) => candidate.id === target)!;
  const resolution = nativeBondOrderResolution(atoms, bonds);
  return {
    count: atomImplicitHydrogenCount(subject, bonds, atoms, resolution),
    countWithoutResolution: atomImplicitHydrogenCount(subject, bonds, atoms),
    label: atomDisplayLabel(subject, bonds, DefaultNativeDrawingStyle, atoms, resolution)
  };
}

function ring(prefix: string, elements: string[], orders: MoleculeBond["order"][]) {
  const atoms = elements.map((element, index) => {
    const angle = (Math.PI * 2 * index) / elements.length;
    return atom(`${prefix}${index}`, element, 40 + 14 * Math.cos(angle), 40 + 14 * Math.sin(angle));
  });
  const bonds = atoms.map((current, index) =>
    bond(`${prefix}b${index}`, current.id, atoms[(index + 1) % atoms.length]!.id, orders[index % orders.length]));
  return { atoms, bonds };
}

describe("atomImplicitHydrogenCount agrees with the drawn label", () => {
  it("neutral: ethanol's O carries one H and reads OH", () => {
    const atoms = [atom("c1", "C", 0), atom("c2", "C", 14, 8), atom("o", "O", 28)];
    const bonds = [bond("b1", "c1", "c2"), bond("b2", "c2", "o")];
    expect(both("o", atoms, bonds)).toEqual({ count: 1, countWithoutResolution: 1, label: "OH" });
    expect(both("c2", atoms, bonds)).toEqual({ count: 2, countWithoutResolution: 2, label: undefined });
  });

  it("charged: a free ammonium N carries four H; a free hydroxide O one", () => {
    expect(both("n", [atom("n", "N", 0, 0, { formalCharge: 1 })])).toEqual({ count: 4, countWithoutResolution: 4, label: "NH4+" });
    expect(both("o", [atom("o", "O", 0, 0, { formalCharge: -1 })])).toEqual({ count: 1, countWithoutResolution: 1, label: "OH-" });
  });

  it("charge from a floating mark still counts for hydrogens but not the label's sign", () => {
    expect(both("n", [atom("n", "N", 0, 0, { formalCharge: 1, markCharge: 1 })]))
      .toEqual({ count: 4, countWithoutResolution: 4, label: "NH4" });
  });

  it("radical: each unpaired electron takes a hydrogen's place", () => {
    expect(both("c", [atom("c", "C", 0, 0, { markRadicals: 1 })])).toEqual({ count: 3, countWithoutResolution: 3, label: "CH3" });
  });

  it("aromatic: bonds count at Kekulé order (benzene CH, pyridine N)", () => {
    const benzene = ring("c", ["C", "C", "C", "C", "C", "C"], ["aromatic"]);
    expect(both("c0", benzene.atoms, benzene.bonds)).toEqual({ count: 1, countWithoutResolution: 1, label: undefined });
    const pyridine = ring("p", ["N", "C", "C", "C", "C", "C"], ["aromatic"]);
    expect(both("p0", pyridine.atoms, pyridine.bonds)).toEqual({ count: 0, countWithoutResolution: 0, label: "N" });
  });

  it("dative: a pyrrole N–H donating to a metal is deprotonated and reads N", () => {
    const pyrrole = ring("r", ["N", "C", "C", "C", "C"], ["single", "double", "single", "double", "single"]);
    const atoms = [...pyrrole.atoms, atom("fe", "Fe", 80, 40)];
    const bonds = [...pyrrole.bonds, bond("d", "r0", "fe", "single", true)];
    expect(both("r0", atoms, bonds)).toEqual({ count: 0, countWithoutResolution: 0, label: "N" });
  });

  it("a carbon bonded only datively has no single count and reads C", () => {
    const atoms = [atom("c", "C", 0, 0, { labelVisible: true }), atom("fe", "Fe", 14)];
    const bonds = [bond("d", "c", "fe", "single", true)];
    expect(both("c", atoms, bonds)).toEqual({ count: undefined, countWithoutResolution: undefined, label: "C" });
  });

  it("labels: a group label has no count; a literal label keeps its count but draws none", () => {
    const methoxy = [atom("c", "C", 0), atom("g", "OMe", 14)];
    expect(both("g", methoxy, [bond("b", "c", "g")]).count).toBeUndefined();
    expect(both("g", methoxy, [bond("b", "c", "g")]).label).toBe("OMe");
    const literal = [atom("o", "O", 0, 0, { labelLiteral: true })];
    expect(both("o", literal)).toEqual({ count: 2, countWithoutResolution: 2, label: "O" });
  });

  it("the hidden-hydrogen style draws no H while the count is unchanged", () => {
    const atoms = [atom("o", "O", 0)];
    const resolution = nativeBondOrderResolution(atoms, []);
    expect(atomImplicitHydrogenCount(atoms[0]!, [], atoms, resolution)).toBe(2);
    expect(atomDisplayLabel(atoms[0]!, [], { ...DefaultNativeDrawingStyle, atomLabelHideImplicitHydrogens: true }, atoms, resolution)).toBe("O");
  });
});

/**
 * Owner ruling (1.2.3): a stated hydrogen count kept on an atom (a CDXML NumHydrogens that disagrees
 * with the derived count; chem-core's `atomStatedHydrogenCount`) shows in the drawn label exactly as
 * a hand-drawn under-filled atom does. `atomImplicitHydrogenCount` stays the derived count, the one
 * the badge and the importer compare the stated count against.
 */
describe("a stated hydrogen count draws in the label", () => {
  const ethanol = (oxygen: Partial<MoleculeAtom> = {}, methyl: Partial<MoleculeAtom> = {}) => {
    const atoms = [atom("c1", "C", 0, 0, methyl), atom("c2", "C", 14, 8), atom("o", "O", 28, 0, oxygen)];
    return { atoms, bonds: [bond("b1", "c1", "c2"), bond("b2", "c2", "o")] };
  };
  const label = (target: string, { atoms, bonds }: { atoms: MoleculeAtom[]; bonds: MoleculeBond[] }) =>
    atomDisplayLabel(atoms.find((candidate) => candidate.id === target)!, bonds, DefaultNativeDrawingStyle, atoms);

  it("an O stated with 0 H reads O, exactly as a typed literal O, while the derived count stays 1", () => {
    const stated = ethanol({ hydrogenCount: 0 });
    expect(both("o", stated.atoms, stated.bonds)).toEqual({ count: 1, countWithoutResolution: 1, label: "O" });
    const typed = ethanol({ labelLiteral: true });
    expect(label("o", stated)).toBe(label("o", typed));
  });

  it("a count above or below the derived one draws as stated, on either side of its bond", () => {
    expect(label("o", ethanol({ hydrogenCount: 2 }))).toBe("OH2");
    const amine = ethanol({ element: "N", hydrogenCount: 1 });
    expect(label("o", amine)).toBe("NH");
    // Bond from the right: the hydrogens go before the element, as for any implicit count.
    const turned = { atoms: amine.atoms.map((candidate) => candidate.id === "o" ? { ...candidate, x: -14 } : candidate), bonds: amine.bonds };
    turned.bonds = [bond("b1", "c1", "c2"), bond("b2", "c1", "o")];
    expect(label("o", turned)).toBe("HN");
  });

  it("a carbon whose stated count disagrees shows its label, as a typed carbon does", () => {
    // A methyl stated with 2 H (derived 3), internal and terminal; skeletal style hides an ordinary one.
    // c1's bond comes from its right, so the hydrogens go first, as for H3C.
    expect(label("c1", ethanol({}, { hydrogenCount: 2 }))).toBe("H2C");
    expect(label("c1", ethanol())).toBeUndefined();
    const ring = ringOf(["C", "C", "C", "C", "C", "C"], ["single", "double"]);
    ring.atoms[0] = { ...ring.atoms[0]!, hydrogenCount: 0 };
    expect(label("k0", ring)).toBe("C");
    expect(label("k1", ring)).toBeUndefined();
    // A label hidden on purpose stays hidden; the badge still marks the atom.
    expect(label("c1", ethanol({}, { hydrogenCount: 2, labelVisible: false }))).toBeUndefined();
  });

  it("changes nothing where the count agrees, on an aromatic atom, or with no count", () => {
    expect(label("o", ethanol({ hydrogenCount: 1 }))).toBe("OH");
    expect(label("c1", ethanol({}, { hydrogenCount: 3 }))).toBeUndefined();
    expect(label("o", ethanol())).toBe("OH");
    // A pyrrole N–H stated on the ring: the Kekulé resolution carries it, as before.
    const pyrrole = ringOf(["N", "C", "C", "C", "C"], ["aromatic"]);
    pyrrole.atoms[0] = { ...pyrrole.atoms[0]!, hydrogenCount: 1 };
    expect(label("k0", pyrrole)).toBe("NH");
    const pyridine = ringOf(["N", "C", "C", "C", "C", "C"], ["aromatic"]);
    pyridine.atoms[0] = { ...pyridine.atoms[0]!, hydrogenCount: 0 };
    expect(label("k0", pyridine)).toBe("N");
  });

  it("a lone H or D stated with 0 reads as the typed literal H or D", () => {
    for (const element of ["H", "D"]) {
      expect(label("h", { atoms: [atom("h", element, 0, 0, { hydrogenCount: 0 })], bonds: [] }))
        .toBe(label("h", { atoms: [atom("h", element, 0, 0, { labelLiteral: true })], bonds: [] }));
    }
    expect(label("h", { atoms: [atom("h", "H", 0, 0, { hydrogenCount: 0 })], bonds: [] })).toBe("H");
    // A count a hydrogen atom cannot carry is not drawn (the importer does not keep one).
    expect(label("h", { atoms: [atom("h", "H", 0, 0, { hydrogenCount: 2 })], bonds: [] }))
      .toBe(label("h", { atoms: [atom("h", "H", 0, 0)], bonds: [] }));
  });

  it("a carbon bonded only datively draws a stated count as the typed C … CH4 there reads", () => {
    // The metal on the left, so the hydrogens follow the element as in the typed text.
    const carbonyl = (extra: Partial<MoleculeAtom>) =>
      ({ atoms: [atom("c", "C", 0, 0, extra), atom("fe", "Fe", -14)], bonds: [bond("d", "c", "fe", "single", true)] });
    expect(label("c", carbonyl({}))).toBeUndefined();
    expect(label("c", carbonyl({ hydrogenCount: 0 }))).toBe("C");
    expect(label("c", carbonyl({ hydrogenCount: 2 }))).toBe("CH2");
    expect(label("c", carbonyl({ hydrogenCount: 3 }))).toBe(label("c", carbonyl({ element: "CH3", labelLiteral: true })));
    expect(label("c", carbonyl({ labelVisible: false, hydrogenCount: 2 }))).toBeUndefined();
  });

  it("atomDerivedHydrogenCount is atomImplicitHydrogenCount, and a dative-only carbon's formula count", () => {
    const derived = (target: string, { atoms, bonds }: { atoms: MoleculeAtom[]; bonds: MoleculeBond[] }) => {
      const subject = atoms.find((candidate) => candidate.id === target)!;
      return [atomDerivedHydrogenCount(subject, bonds, atoms), atomImplicitHydrogenCount(subject, bonds, atoms)];
    };
    expect(derived("o", ethanol())).toEqual([1, 1]);
    expect(derived("c1", ethanol())).toEqual([3, 3]);
    expect(derived("h", { atoms: [atom("h", "H", 0)], bonds: [] })).toEqual([0, 0]);
    expect(derived("d", { atoms: [atom("d", "D", 0)], bonds: [] })).toEqual([0, 0]);
    const carbonyl = { atoms: [atom("c", "C", 0), atom("fe", "Fe", 14)], bonds: [bond("d", "c", "fe", "single", true)] };
    expect(derived("c", carbonyl)).toEqual([4, undefined]);
    const cation = { atoms: [atom("c", "C", 0, 0, { formalCharge: 1 }), atom("fe", "Fe", 14)], bonds: [bond("d", "c", "fe", "single", true)] };
    expect(derived("c", cation)).toEqual([3, undefined]);
  });

  it("atomDrawnHydrogenCount is the count the label draws: the stated one where the atom has it", () => {
    const drawn = (target: string, { atoms, bonds }: { atoms: MoleculeAtom[]; bonds: MoleculeBond[] }) =>
      atomDrawnHydrogenCount(atoms.find((candidate) => candidate.id === target)!, bonds, atoms);
    expect(drawn("o", ethanol({ hydrogenCount: 0 }))).toBe(0);
    expect(drawn("o", ethanol({ hydrogenCount: 2 }))).toBe(2);
    expect(drawn("o", ethanol())).toBe(1);
    expect(drawn("c1", ethanol())).toBe(3);
    const pyrrole = ringOf(["N", "C", "C", "C", "C"], ["aromatic"]);
    pyrrole.atoms[0] = { ...pyrrole.atoms[0]!, hydrogenCount: 1 };
    expect(drawn("k0", pyrrole)).toBe(1);
    const carbonyl = (extra: Partial<MoleculeAtom>) =>
      ({ atoms: [atom("c", "C", 0, 0, extra), atom("fe", "Fe", 14)], bonds: [bond("d", "c", "fe", "single", true)] });
    expect(drawn("c", carbonyl({}))).toBeUndefined();
    expect(drawn("c", carbonyl({ hydrogenCount: 2 }))).toBe(2);
  });

  it("the hidden-hydrogen style hides a stated count as it hides a derived one", () => {
    const stated = ethanol({ element: "N", hydrogenCount: 1 });
    const o = stated.atoms[2]!;
    expect(atomDisplayLabel(o, stated.bonds, { ...DefaultNativeDrawingStyle, atomLabelHideImplicitHydrogens: true }, stated.atoms)).toBe("N");
  });
});

function ringOf(elements: string[], orders: MoleculeBond["order"][]) {
  return ring("k", elements, orders);
}

/**
 * A lone hydrogen atom is ONE hydrogen atom, a radical (owner decision 2026-11-23): a lone, neutral
 * H, D or T with no stated count reads "H", "D" or "T", carries no hydrogen, and has one unpaired
 * electron (chem-core's `atomImpliedRadicalCount`), drawn with the radical dot a radical mark draws.
 * The molfile writes it with the zero-valence sentinel, so RDKit reads the same bare atom ([H], one
 * radical electron; AGENTS.md §8). A hydrogen atom never carries hydrogens of its own: bonded
 * (dative bonds included), charged or radical-marked it is its symbol alone, with no implied radical.
 */
describe("a lone H, D or T atom is one hydrogen atom, a radical", () => {
  it("a lone H, D or T reads as its symbol, carries no hydrogen and one implied radical electron", () => {
    for (const element of ["H", "D", "T"]) {
      const lone = atom("h", element, 0);
      expect(both("h", [lone])).toEqual({ count: 0, countWithoutResolution: 0, label: element });
      expect(atomDrawnHydrogenCount(lone, [], [lone])).toBe(0);
      expect(atomDerivedHydrogenCount(lone, [], [lone])).toBe(0);
      expect(atomImpliedRadicalCount(lone, [])).toBe(1);
    }
  });

  it("a bonded H, D or T, dative bonds included, reads as its symbol with no hydrogen and no radical", () => {
    for (const element of ["H", "D", "T"]) {
      for (const dashed of [false, true]) {
        const atoms = [atom("h", element, 0), atom("m", dashed ? "Fe" : "Cl", 14)];
        const bonds = [bond("b", "h", "m", "single", dashed)];
        expect(both("h", atoms, bonds), `${element} dashed=${dashed}`).toEqual({ count: 0, countWithoutResolution: 0, label: element });
        expect(atomDerivedHydrogenCount(atoms[0]!, bonds, atoms)).toBe(0);
        expect(atomImpliedRadicalCount(atoms[0]!, bonds)).toBe(0);
      }
    }
  });

  it("a charged or radical-marked lone H or D has no hydrogen and no implied radical", () => {
    expect(both("h", [atom("h", "H", 0, 0, { formalCharge: 1 })])).toEqual({ count: 0, countWithoutResolution: 0, label: "H+" });
    expect(both("h", [atom("h", "H", 0, 0, { formalCharge: -1 })])).toEqual({ count: 0, countWithoutResolution: 0, label: "H-" });
    expect(both("d", [atom("d", "D", 0, 0, { formalCharge: 1 })])).toEqual({ count: 0, countWithoutResolution: 0, label: "D+" });
    expect(both("h", [atom("h", "H", 0, 0, { markRadicals: 1 })])).toEqual({ count: 0, countWithoutResolution: 0, label: "H" });
    for (const extra of [{ formalCharge: 1 }, { formalCharge: -1 }, { markRadicals: 1 }]) {
      expect(atomImpliedRadicalCount(atom("h", "H", 0, 0, extra), [])).toBe(0);
    }
  });

  it("a lone H, D or T stated with 0, or typed, draws its symbol alone and keeps its stated reading", () => {
    for (const element of ["H", "D", "T"]) {
      for (const extra of [{ hydrogenCount: 0 }, { labelLiteral: true }]) {
        expect(both("h", [atom("h", element, 0, 0, extra)]).label).toBe(element);
        expect(atomImpliedRadicalCount(atom("h", element, 0, 0, extra), [])).toBe(0);
      }
    }
    // A count a hydrogen atom cannot carry is not counted (`atomIgnoresStatedHydrogenCount`): the
    // atom reads as an unstated one.
    expect(atomImpliedRadicalCount(atom("h", "H", 0, 0, { hydrogenCount: 2 }), [])).toBe(1);
  });

  it("draws the implied radical with the radical dot a radical mark draws, and only on a lone neutral hydrogen atom", () => {
    const molecule = (atoms: MoleculeAtom[], bonds: MoleculeBond[] = []): MoleculeObject => ({
      id: "m", type: "molecule", x: 0, y: 0, width: 40, height: 40, rotation: 0, style: {},
      structureFormat: "smiles", structure: "", superatoms: [], rGroups: [], atoms, bonds
    });
    const dots = (object: MoleculeObject) => planPageSvgRender({ ...createEmptyDocument({ title: "lone H" }).pages[0]!, objects: [object] })
      .fragments.filter((fragment) => fragment.attrs["data-implied-radical-atom-id"] !== undefined);
    for (const element of ["H", "D", "T"]) {
      const [dot, ...rest] = dots(molecule([atom("h", element, 100, 100)]));
      expect(rest).toEqual([]);
      // The radical mark's own glyph: one filled circle, r 2.1, beside the atom, inside the molecule's
      // own object (so selecting or moving the molecule carries it), never a stored object of its own.
      expect(dot).toMatchObject({ tag: "g", attrs: { "data-object-id": "m", "data-mark-kind": "radical-dot", "data-implied-radical-atom-id": "h" } });
      expect(dot!.children).toHaveLength(1);
      const circle = dot!.children[0]!;
      expect(circle).toMatchObject({ tag: "circle", attrs: { r: 2.1, fill: "#111111" } });
      const attrs = circle.kind === "element" ? circle.attrs : {};
      expect(Math.hypot(Number(attrs.cx) - 100, Number(attrs.cy) - 100)).toBeGreaterThan(10);
    }
    expect(dots(molecule([atom("h", "H", 100, 100, { formalCharge: 1 })]))).toEqual([]);
    expect(dots(molecule([atom("h", "H", 100, 100, { formalCharge: -1 })]))).toEqual([]);
    expect(dots(molecule([atom("h", "H", 100, 100, { hydrogenCount: 0 })]))).toEqual([]);
    expect(dots(molecule([atom("h", "H", 100, 100), atom("cl", "Cl", 114, 100)], [bond("b", "h", "cl")]))).toEqual([]);
    expect(dots(molecule([atom("d", "D", 100, 100), atom("fe", "Fe", 114, 100)], [bond("b", "d", "fe", "single", true)]))).toEqual([]);
    // Master ruling 2026-11-23: an H held only by a dative bond is a single H exactly like D (and T): no radical dot.
    for (const element of ["H", "D", "T"]) {
      expect(dots(molecule([atom("h", element, 100, 100), atom("fe", "Fe", 114, 100)], [bond("b", "h", "fe", "single", true)])), element).toEqual([]);
    }
  });
});
