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

describe("Kimi 1.2.3 finding 1: rounding tolerance cannot pass a changed configuration as a translation", () => {
  // One unit in the last place is 2 at 1e16, so 8 ULPs of the coordinates (about 17.8) exceed this
  // molecule's own size (bonds of 4 to 4.5): a reflection moves no atom further than 8 from a translation.
  const far = 1e16;
  const small = (molecule: MoleculeObject): MoleculeObject => ({ ...molecule, x: far, y: far,
    atoms: molecule.atoms.map(atom => ({ ...atom, ...{ c: { x: far, y: far }, u: { x: far, y: far - 4 },
      l: { x: far - 4, y: far + 2 }, r: { x: far + 4, y: far + 2 }, d: { x: far + 2, y: far + 4 } }[atom.id]! })) });
  const tiny = small(skewed);

  it("still verifies the mirror image of a small wedged centre at large coordinates", () => {
    expect(chemistryGate(tiny, (x, y) => [2 * far - x, y])).toBeInstanceOf(Promise);
  });

  it("still verifies a reshaping that moves one substituent across the wedge at large coordinates", () => {
    // Only "r" moves, by 8: it crosses to the other side of the line through l and c.
    expect(chemistryGate(tiny, (x, y) => x === far + 4 && y === far + 2 ? [x, y - 8] : [x, y])).toBeInstanceOf(Promise);
  });

  it("lets an exact translation at large but ordinary page coordinates skip verification (control)", () => {
    const shifted = { ...skewed, atoms: skewed.atoms.map(atom => ({ ...atom, x: atom.x + 1e6, y: atom.y + 1e6 })) };
    expect(chemistryGate(shifted, (x, y) => [x + 40, y - 25])).toBeUndefined();
  });
});
