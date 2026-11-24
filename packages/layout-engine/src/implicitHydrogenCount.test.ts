import { describe, expect, it } from "vitest";

import { DefaultNativeDrawingStyle, type MoleculeAtom, type MoleculeBond } from "@chemdraft/chem-core";

import { atomDisplayLabel, atomImplicitHydrogenCount } from "./index";
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
