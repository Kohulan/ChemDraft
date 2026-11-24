import { applyPatch, createEmptyDocument, DocumentObjectSchema, type DocumentPatch } from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";

import { proposedHydrogenCountNotCountedWarnings } from "./nativeDocument";

// The proposal warning is read from the document the proposal produces, not from its raw patch.
describe("proposedHydrogenCountNotCountedWarnings", () => {
  const carbon = { id: "c", element: "C", x: 0, y: 0 };
  const hydrogen = { id: "h", element: "H", x: 20, y: 0 };
  const carbonHydrogen = { id: "b", fromAtomId: "c", toAtomId: "h", order: "single" };
  const molecule = (id: string, atoms: object[], bonds: object[]) =>
    DocumentObjectSchema.parse({ id, type: "molecule", x: 0, y: 0, width: 20, height: 1, rotation: 0, style: {},
      structureFormat: "smiles", structure: "", superatoms: [], rGroups: [], atoms, bonds });
  const blank = createEmptyDocument();
  const pageId = blank.pages[0]!.id;
  const before = applyPatch(blank, { op: "addObject", pageId, object: molecule("m", [carbon, hydrogen], [carbonHydrogen]) });
  const produce = (patch: DocumentPatch) => ({ after: applyPatch(before, patch), patch });

  it("reports a count the update keeps", () => {
    const { after, patch } = produce({ op: "updateObject", objectId: "m",
      changes: { atoms: [carbon, { ...hydrogen, hydrogenCount: 1 }], bonds: [carbonHydrogen] } } as DocumentPatch);
    expect(proposedHydrogenCountNotCountedWarnings(before, after, patch)).toMatchObject([
      { code: "document.atom_hydrogen_count_not_counted", sourceObjectId: "m", atomIds: ["h"] }
    ]);
    expect(proposedHydrogenCountNotCountedWarnings(before, after, patch)[0]!.message).toMatch(/^Proposed change: atom h \(H\) states 1/);
  });

  it("reports nothing when applying the update clears the count (the H's bond changed)", () => {
    const { after, patch } = produce({ op: "updateObject", objectId: "m",
      changes: { atoms: [carbon, { ...hydrogen, hydrogenCount: 1 }], bonds: [] } } as DocumentPatch);
    const committedH = after.pages[0]!.objects.flatMap(object => object.type === "molecule" ? object.atoms : [])
      .find(atom => atom.id === "h");
    expect(committedH?.hydrogenCount).toBeUndefined();
    expect(proposedHydrogenCountNotCountedWarnings(before, after, patch)).toEqual([]);
  });

  it("reports an insertion and heads the message with the given source", () => {
    const { after, patch } = produce({ op: "addObject", pageId,
      object: molecule("n", [carbon, { ...hydrogen, hydrogenCount: 1 }], [carbonHydrogen]) });
    expect(proposedHydrogenCountNotCountedWarnings(before, after, patch, "Accepted change")).toMatchObject([
      { sourceObjectId: "n", atomIds: ["h"], message: expect.stringMatching(/^Accepted change: /) }
    ]);
  });

  it("leaves a count already stored in a molecule the proposal does not write to the open report", () => {
    const flagged = applyPatch(blank, { op: "addObject", pageId,
      object: molecule("m", [carbon, { ...hydrogen, hydrogenCount: 1 }], [carbonHydrogen]) });
    const patch = { op: "addObject", pageId, object: molecule("n", [carbon], []) } as DocumentPatch;
    expect(proposedHydrogenCountNotCountedWarnings(flagged, applyPatch(flagged, patch), patch)).toEqual([]);
    const moved = { op: "updateObject", objectId: "m", changes: { x: 40 } } as DocumentPatch;
    expect(proposedHydrogenCountNotCountedWarnings(flagged, applyPatch(flagged, moved), moved)).toEqual([]);
  });

  it("reports nothing when the dry run failed", () => {
    expect(proposedHydrogenCountNotCountedWarnings(before, undefined, { op: "updateObject", objectId: "m" })).toEqual([]);
  });
});
