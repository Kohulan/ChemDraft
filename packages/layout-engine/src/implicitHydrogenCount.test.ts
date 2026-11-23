import { describe, expect, it } from "vitest";

import { DefaultNativeDrawingStyle, type MoleculeAtom, type MoleculeBond } from "@chemdraft/chem-core";

import { atomDerivedHydrogenCount, atomDisplayLabel, atomDrawnHydrogenCount, atomImplicitHydrogenCount } from "./index";
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
    expect(derived("h", { atoms: [atom("h", "H", 0)], bonds: [] })).toEqual([1, 1]);
    expect(derived("d", { atoms: [atom("d", "D", 0)], bonds: [] })).toEqual([1, 1]);
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
 * A lone hydrogen atom with no stated count is what the structure engine reads from the molfile the
 * app writes (no valence field): RDKit gives a lone H one implicit hydrogen (H2, [HH]), a lone D one
 * (HD, [2HH]) and a lone T one (HT, [3HH]). The label draws that hydrogen, as the formula and SMILES
 * count it (AGENTS.md §8: never re-decide hydrogens against the engine).
 */
describe("a lone H, D or T atom draws the hydrogen the structure engine gives it", () => {
  it("a lone H draws H2, a lone D DH and a lone T TH, each with one hydrogen", () => {
    expect(both("h", [atom("h", "H", 0)])).toEqual({ count: 1, countWithoutResolution: 1, label: "H2" });
    expect(both("d", [atom("d", "D", 0)])).toEqual({ count: 1, countWithoutResolution: 1, label: "DH" });
    expect(both("t", [atom("t", "T", 0)])).toEqual({ count: 1, countWithoutResolution: 1, label: "TH" });
    for (const element of ["H", "D", "T"]) {
      expect(atomDrawnHydrogenCount(atom("h", element, 0), [], [atom("h", element, 0)])).toBe(1);
    }
  });

  it("a bonded H, D or T draws no hydrogen and reads as its symbol, as before", () => {
    for (const element of ["H", "D", "T"]) {
      const atoms = [atom("h", element, 0), atom("cl", "Cl", 14)];
      expect(both("h", atoms, [bond("b", "h", "cl")])).toEqual({ count: 0, countWithoutResolution: 0, label: element });
    }
  });

  it("a charged or radical lone H or D has no room for a hydrogen", () => {
    expect(both("h", [atom("h", "H", 0, 0, { formalCharge: 1 })]).label).toBe("H+");
    expect(both("h", [atom("h", "H", 0, 0, { formalCharge: -1 })]).label).toBe("H-");
    expect(both("d", [atom("d", "D", 0, 0, { formalCharge: 1 })])).toEqual({ count: 0, countWithoutResolution: 0, label: "D+" });
    expect(both("h", [atom("h", "H", 0, 0, { markRadicals: 1 })]).count).toBe(0);
  });

  it("a lone H, D or T stated with 0, or typed, draws its symbol alone", () => {
    for (const element of ["H", "D", "T"]) {
      expect(both("h", [atom("h", element, 0, 0, { hydrogenCount: 0 })]).label).toBe(element);
      expect(both("h", [atom("h", element, 0, 0, { labelLiteral: true })]).label).toBe(element);
    }
  });
});
