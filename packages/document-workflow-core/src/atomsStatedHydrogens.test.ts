import { describe, expect, it } from "vitest";
import type { MoleculeAtom, MoleculeBond, MoleculeObject } from "@chemdraft/chem-core";
import type { ExportWarning } from "@chemdraft/export-engine";
import {
  atomProblem,
  moleculeSmiles,
  nativeAtomValidationState,
  nativeMoleculeExportWarnings,
  nativeSingleBondGraphMetadata,
  nativeSingleBondGraphSmiles,
  nativeSmilesRadicalWarnings
} from "./index";

/**
 * A stated hydrogen count (`hydrogenCount`, a CDXML NumHydrogens kept on import) on an atom with no
 * aromatic bond is the source's count for that atom. Owner ruling (1.2.3): where it disagrees with
 * the count ChemDraft derives it is kept, and the atom is badged like any under-filled or
 * over-filled atom, so the disagreement is visible rather than silently resolved either way.
 */
function molecule(atoms: MoleculeAtom[], bonds: MoleculeBond[]): MoleculeObject {
  return {
    id: "m", type: "molecule", x: 0, y: 0, width: 60, height: 20, rotation: 0, style: {},
    structureFormat: "smiles", structure: "", superatoms: [], rGroups: [], atoms, bonds
  };
}

function ethanol(oxygen: Partial<MoleculeAtom> = {}, firstCarbon: Partial<MoleculeAtom> = {}): MoleculeObject {
  return molecule([
    { id: "c1", element: "C", x: 0, y: 0, formalCharge: 0, ...firstCarbon },
    { id: "c2", element: "C", x: 14, y: 8, formalCharge: 0 },
    { id: "o", element: "O", x: 28, y: 0, formalCharge: 0, ...oxygen }
  ], [
    { id: "b1", fromAtomId: "c1", toAtomId: "c2", order: "single" },
    { id: "b2", fromAtomId: "c2", toAtomId: "o", order: "single" }
  ]);
}

const state = (subject: MoleculeObject, atomId: string) => {
  const atom = subject.atoms.find((candidate) => candidate.id === atomId)!;
  return nativeAtomValidationState(atom, subject.bonds, atom.formalCharge, subject.atoms);
};

describe("a stated hydrogen count on an atom with no aromatic bond", () => {
  it("badges an O stated with 0 H on one single bond", () => {
    expect(state(ethanol({ hydrogenCount: 0 }), "o")).toEqual({
      atomId: "o",
      element: "O",
      valenceUsed: 1,
      formalCharge: 0,
      valid: false,
      statedHydrogens: { stated: 0, derived: 1 },
      invalidReason: "O states 0 H, but its bonds and charge give 1.",
      invalidDetail: "O atom o states 0 hydrogens (NumHydrogens), but its bonds and charge give 1; " +
        "the stated count is kept, and the drawn label, formula and SMILES count 0 until the count or the atom is changed."
    });
  });

  it("badges a count above the derived one too (a methyl carbon stated with 2 H)", () => {
    expect(state(ethanol({}, { hydrogenCount: 2 }), "c1")).toMatchObject({
      valid: false, statedHydrogens: { stated: 2, derived: 3 },
      invalidReason: "C states 2 H, but its bonds and charge give 3."
    });
  });

  it("passes a stated count that agrees, exactly as the same atom without one", () => {
    expect(state(ethanol({ hydrogenCount: 1 }), "o")).toEqual(state(ethanol(), "o"));
    expect(state(ethanol({ hydrogenCount: 1 }), "o").valid).toBe(true);
  });

  it("counts charge and radicals into the derived count", () => {
    expect(state(ethanol({ hydrogenCount: 0, formalCharge: -1 }), "o").valid).toBe(true);
    expect(state(ethanol({ hydrogenCount: 0, markRadicals: 1 }), "o").valid).toBe(true);
    expect(state(ethanol({ hydrogenCount: 2, formalCharge: 1 }), "o").valid).toBe(true);
  });

  it("judges a carbon bonded only datively against the count its formula has, as a typed CH3 there is judged", () => {
    const carbonyl = (carbon: Partial<MoleculeAtom> = {}) => molecule([
      { id: "c", element: "C", x: 0, y: 0, formalCharge: 0, ...carbon },
      { id: "fe", element: "Fe", x: 14, y: 0, formalCharge: 0 }
    ], [{ id: "b", fromAtomId: "c", toAtomId: "fe", order: "single", display: { bondStyle: "dashed" } }]);
    // The bare carbon draws no H but its formula counts 4: a dative bond costs its donor nothing.
    expect(nativeSingleBondGraphMetadata(carbonyl().atoms, carbonyl().bonds).formula).toBe("CH4Fe");
    expect(state(carbonyl(), "c").valid).toBe(true);
    for (const stated of [0, 3]) {
      expect(state(carbonyl({ hydrogenCount: stated }), "c")).toMatchObject({
        valid: false, statedHydrogens: { stated, derived: 4 }, invalidReason: `C states ${stated} H, but its bonds and charge give 4.`
      });
      expect(nativeSingleBondGraphMetadata(carbonyl({ hydrogenCount: stated }).atoms, carbonyl().bonds).formula).toBe(stated ? `CH${stated}Fe` : "CFe");
    }
    expect(state(carbonyl({ element: "CH3", labelLiteral: true }), "c").valid).toBe(false);
    expect(state(carbonyl({ hydrogenCount: 4 }), "c").valid).toBe(true);
    expect(atomProblem(carbonyl({ hydrogenCount: 3 }), "c")!.fixes.map((fix) => fix.label))
      .toEqual(["Use the derived hydrogen count (4)", "Ignore warning"]);
  });

  it("badges a lone H stated with 0 as a typed H is badged, and judges no count on D", () => {
    const lone = (element: string, extra: Partial<MoleculeAtom> = {}) =>
      molecule([{ id: "h", element, x: 0, y: 0, formalCharge: 0, ...extra }], []);
    expect(state(lone("H", { hydrogenCount: 0 }), "h")).toMatchObject({ valid: false, statedHydrogens: { stated: 0, derived: 1 } });
    expect(state(lone("H", { labelLiteral: true }), "h").valid).toBe(false);
    expect(state(lone("D", { hydrogenCount: 0 }), "h")).toEqual(state(lone("D", { labelLiteral: true }), "h"));
    expect(state(lone("D", { hydrogenCount: 0 }), "h").valid).toBe(true);
    // A count a hydrogen atom cannot carry is not counted (the derived count stands), but it is
    // flagged rather than ignored silently: the document keeps it as stored.
    const { expectedFormalCharge: _expected, ...plain } = state(lone("H"), "h");
    expect(plain.valid).toBe(true);
    expect(state(lone("H", { hydrogenCount: 2 }), "h")).toEqual({ ...plain, valid: false, hydrogenCountNotCounted: true,
      statedHydrogens: { stated: 2, derived: 1 }, invalidReason: "H states 2 H, which a hydrogen atom cannot carry; only 0 counts.",
      invalidDetail: "atom h (H) states 2 hydrogens, which a hydrogen atom cannot carry: only 0 counts, as a typed H, D or T label means. " +
        "The stated count is kept as stored but not counted, and the atom is flagged. The label, formula and SMILES count 1." });
  });

  it("leaves a typed literal label to its own check", () => {
    const literal = ethanol({ labelLiteral: true, hydrogenCount: 1 });
    expect(state(literal, "o")).toEqual(state(ethanol({ labelLiteral: true }), "o"));
    expect(state(literal, "o").invalidReason).toBe("O has 1 of 2 bonds.");
  });

  it("reports the badge as an export warning", () => {
    expect(nativeMoleculeExportWarnings(ethanol({ hydrogenCount: 0 })).map((warning) => warning.message))
      .toEqual(["O3 states 0 H, but its bonds and charge give 1."]);
  });

  it("counts the stated hydrogens in the formula, mass and SMILES, exactly as a typed literal O, and says so", () => {
    const stated = ethanol({ hydrogenCount: 0 });
    const typed = ethanol({ labelLiteral: true });
    const metadata = nativeSingleBondGraphMetadata(stated.atoms, stated.bonds);
    const typedMetadata = nativeSingleBondGraphMetadata(typed.atoms, typed.bonds);
    expect(metadata.formula).toBe("C2H5O");
    expect({ ...metadata, warnings: [] }).toEqual({ ...typedMetadata, warnings: [] });
    expect(metadata.warnings).toEqual([{
      code: "chemistry.invalid_valence",
      message: state(stated, "o").invalidDetail,
      objectId: "o"
    }]);
    expect(typedMetadata.warnings.map((warning) => warning.code)).toEqual(["chemistry.invalid_valence"]);
    expect(nativeSingleBondGraphSmiles(stated.atoms, stated.bonds)).toBe("CC[O]");
    expect(nativeSingleBondGraphSmiles(stated.atoms, stated.bonds)).toBe(nativeSingleBondGraphSmiles(typed.atoms, typed.bonds));
  });

  it("writes a count above zero as the bracket atom the spelled label writes", () => {
    const amine = ethanol({ element: "N", hydrogenCount: 1 });
    const typed = ethanol({ element: "NH", labelLiteral: true });
    expect(nativeSingleBondGraphSmiles(amine.atoms, amine.bonds)).toBe("CC[NH]");
    expect(nativeSingleBondGraphSmiles(amine.atoms, amine.bonds)).toBe(nativeSingleBondGraphSmiles(typed.atoms, typed.bonds));
    expect(nativeSingleBondGraphMetadata(amine.atoms, amine.bonds).formula).toBe("C2H6N");
    const methyl = ethanol({}, { hydrogenCount: 2 });
    expect(nativeSingleBondGraphSmiles(methyl.atoms, methyl.bonds)).toBe("[CH2]CO");
    expect(nativeSingleBondGraphMetadata(methyl.atoms, methyl.bonds).formula).toBe("C2H5O");
  });

  it("changes nothing where the count agrees or there is none", () => {
    for (const subject of [ethanol(), ethanol({ hydrogenCount: 1 }), ethanol({}, { hydrogenCount: 3 })]) {
      expect(nativeSingleBondGraphMetadata(subject.atoms, subject.bonds).formula).toBe("C2H6O");
      expect(nativeSingleBondGraphSmiles(subject.atoms, subject.bonds)).toBe("CCO");
    }
  });
});

describe("SMILES export of a kept count, without the structure engine", () => {
  it("warns exactly as for a typed literal O: the written [O] implies a radical the drawing does not show", async () => {
    // The native writer writes the stated count (a bracket [O]), as it writes a typed O, so the SMILES
    // implies a radical electron; that warning accounts for the badge on both, as it always has.
    const stated = ethanol({ hydrogenCount: 0 });
    const typed = ethanol({ labelLiteral: true });
    expect(nativeSmilesRadicalWarnings(stated)).toEqual(nativeSmilesRadicalWarnings(typed));
    const warnings: ExportWarning[] = [];
    const typedWarnings: ExportWarning[] = [];
    expect(await moleculeSmiles(stated, 0, warnings, undefined)).toBe("CC[O]");
    expect(await moleculeSmiles(typed, 0, typedWarnings, undefined)).toBe("CC[O]");
    expect(warnings).toEqual(typedWarnings);
    expect(warnings.map((warning) => [warning.code, warning.message])).toEqual([
      ["export.smiles_radical_loss", "Atom o (O) is drawn with 0 radical electrons; SMILES would imply 1 radical electron with its hydrogen count and formal charge."]
    ]);
  });
});

describe("the atom-problem fix for a disagreeing stated count", () => {
  it("offers the derived count, which drops the stated one and leaves the atom ordinary", () => {
    const stated = ethanol({ hydrogenCount: 0 });
    const problem = atomProblem(stated, "o")!;
    expect(problem.state.valid).toBe(false);
    expect(problem.fixes.map((fix) => [fix.action, fix.label])).toEqual([
      ["hydrogens", "Use the derived hydrogen count (1)"],
      ["ignore", "Ignore warning"]
    ]);
    const fixed = problem.fixes[0]!.atom;
    expect(fixed).toEqual(ethanol().atoms[2]);
    expect(atomProblem({ ...stated, atoms: stated.atoms.map((atom) => atom.id === "o" ? fixed : atom) }, "o")).toBeUndefined();
  });

  it("still offers a charge where the bonds call for one, beside the derived count", () => {
    // A stated N–H on a four-bonded N: the derived count (0) leaves it needing a + charge.
    const ammonium = molecule([
      { id: "n", element: "N", x: 0, y: 0, formalCharge: 0, hydrogenCount: 1 },
      ...[1, 2, 3, 4].map((index) => ({ id: `c${index}`, element: "C", x: 14 * index, y: 0, formalCharge: 0 }))
    ], [1, 2, 3, 4].map((index) => ({ id: `b${index}`, fromAtomId: "n", toAtomId: `c${index}`, order: "single" as const })));
    const problem = atomProblem(ammonium, "n")!;
    expect(problem.fixes.map((fix) => fix.action)).toContain("charge");
    expect(problem.fixes.find((fix) => fix.action === "hydrogens")?.label ?? "").not.toBe("Use the derived hydrogen count (0)");
  });
});
