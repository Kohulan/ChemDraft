import { describe, expect, it } from "vitest";
import type { MoleculeAtom, MoleculeBond, MoleculeObject } from "@chemdraft/chem-core";
import {
  atomProblem,
  nativeAtomValidationState,
  nativeMoleculeExportWarnings,
  nativeSingleBondGraphMetadata,
  nativeSingleBondGraphSmiles
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
        "the stated count is kept, and the drawn label and formula count 1 until the count or the atom is changed."
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

  it("leaves a carbon bonded only datively alone: it has no single derived count", () => {
    const carbonyl = (hydrogenCount?: number) => molecule([
      { id: "c", element: "C", x: 0, y: 0, formalCharge: 0, ...(hydrogenCount === undefined ? {} : { hydrogenCount }) },
      { id: "fe", element: "Fe", x: 14, y: 0, formalCharge: 0 }
    ], [{ id: "b", fromAtomId: "c", toAtomId: "fe", order: "single", display: { bondStyle: "dashed" } }]);
    expect(state(carbonyl(0), "c")).toEqual(state(carbonyl(), "c"));
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

  it("keeps the formula and SMILES on the derived count, the one the drawn label shows, and says so", () => {
    const stated = ethanol({ hydrogenCount: 0 });
    const metadata = nativeSingleBondGraphMetadata(stated.atoms, stated.bonds);
    expect(metadata.formula).toBe("C2H6O");
    expect(metadata.warnings).toEqual([{
      code: "chemistry.invalid_valence",
      message: state(stated, "o").invalidDetail,
      objectId: "o"
    }]);
    expect(nativeSingleBondGraphSmiles(stated.atoms, stated.bonds)).toBe("CCO");
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
