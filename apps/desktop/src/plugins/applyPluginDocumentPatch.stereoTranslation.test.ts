import { applyPatch, createEmptyDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { ProposedDocumentPatchSchema, type NormalizedProposedDocumentPatch } from "@chemdraft/plugin-api";
import { describe, expect, it } from "vitest";
import { refreshPluginPatchChemistry } from "./applyPluginDocumentPatch";

type Point = readonly [number, number];

/** A stereocentre "c" with a wedge to "u" and its other neighbours at the given positions. */
function wedgedMolecule(neighbours: Record<"l" | "r" | "d", Point>): MoleculeObject {
  const at = (id: string, element: string, [x, y]: Point) => ({ id, element, x, y, formalCharge: 0 });
  return {
    id: "mol", type: "molecule", x: 60, y: 60, width: 80, height: 80, rotation: 0, style: {},
    structureFormat: "smiles", structure: "C[C@](N)(O)F",
    atoms: [at("c", "C", [100, 100]), at("u", "N", [100, 70]), at("l", "C", neighbours.l),
      at("r", "O", neighbours.r), at("d", "F", neighbours.d)],
    bonds: [
      { id: "cu", fromAtomId: "c", toAtomId: "u", order: "single", display: { bondStyle: "wedge" } },
      { id: "cl", fromAtomId: "c", toAtomId: "l", order: "single" },
      { id: "cr", fromAtomId: "c", toAtomId: "r", order: "single" },
      { id: "cd", fromAtomId: "c", toAtomId: "d", order: "single" }
    ],
    superatoms: [], rGroups: []
  };
}

/** A plus-shaped centre: l and r sit on opposite sides of c, so their side relative to each other is 0. */
const cross = wedgedMolecule({ l: [70, 100], r: [130, 100], d: [100, 130] });
/** The same centre with no two neighbours collinear. */
const skewed = wedgedMolecule({ l: [74, 115], r: [126, 115], d: [104, 130] });

function documentWith(molecule: MoleculeObject): ChemDraftDocument {
  const document = createEmptyDocument({ now: "2026-11-21T00:00:00.000Z" });
  return { ...document, pages: [{ ...document.pages[0]!, objects: [molecule] }] };
}

/** Undefined when the patch skips chemistry verification; a promise when it must inspect the molecule. */
function chemistryGate(molecule: MoleculeObject, move: (x: number, y: number) => Point) {
  const before = documentWith(molecule);
  const rebased = ProposedDocumentPatchSchema.parse({ reason: "Move the selected molecule", patch: {
    op: "updateObject", objectId: "mol",
    changes: { atoms: molecule.atoms.map(atom => { const [x, y] = move(atom.x, atom.y); return { ...atom, x, y }; }) }
  } }) as NormalizedProposedDocumentPatch;
  const draft = applyPatch(before, rebased.patch);
  // Aborted: an inspection that does start fails at once instead of waiting for RDKit.
  const gate = refreshPluginPatchChemistry(before, draft, rebased, ["mol"], AbortSignal.abort());
  void gate?.catch(() => undefined);
  return gate;
}

describe("CodeRabbit PR #422 cr4656567659: exact translations of wedged molecules", () => {
  const translate = (x: number, y: number): Point => [x + 40, y - 25];

  it("lets an exact translation of a wedged centre with no collinear neighbours skip verification (control)", () => {
    expect(chemistryGate(skewed, translate)).toBeUndefined();
  });

  it("lets an exact translation of a wedged centre with two opposite neighbours skip verification", () => {
    expect(chemistryGate(cross, translate)).toBeUndefined();
  });

  it("still verifies a real stereo change: the mirror image of the wedged centre", () => {
    const mirror = (x: number, y: number): Point => [200 - x, y];
    expect(chemistryGate(skewed, mirror)).toBeInstanceOf(Promise);
    expect(chemistryGate(cross, mirror)).toBeInstanceOf(Promise);
  });
});
