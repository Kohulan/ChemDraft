import { applyPatch, createEmptyDocument, DocumentObjectSchema, type DocumentPatch, type MoleculeObject } from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";

import { nativeAtomValidationState } from "./atoms";
import { nativeHydrogenCountNotCountedWarnings, proposedHydrogenCountNotCountedWarnings, readNativeDocumentContents } from "./nativeDocument";

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

/**
 * A typed "Ac", "Pr" or "Ts" on a bond is acetyl, n-propyl or tosyl to the label grammar, and the
 * formula and SMILES take its hydrogens from the group (`expandNativeLabelGroups`). A count stated
 * on it is counted by nothing, so opening a document that holds one reports it, and the atom is
 * badged, exactly as for OMe. Unbonded, or not typed, it is the element and is not reported.
 */
describe("a stated count on a typed Ac, Pr or Ts", () => {
  const molecule = (id: string, atoms: object[], bonds: object[]) =>
    DocumentObjectSchema.parse({ id, type: "molecule", x: 0, y: 0, width: 20, height: 1, rotation: 0, style: {},
      structureFormat: "smiles", structure: "", superatoms: [], rGroups: [], atoms, bonds }) as MoleculeObject;
  const carbon = { id: "c", element: "C", x: 0, y: 0 };
  const bond = { id: "b", fromAtomId: "c", toAtomId: "g", order: "single" };
  const documentWith = (object: ReturnType<typeof molecule>) => {
    const blank = createEmptyDocument();
    return applyPatch(blank, { op: "addObject", pageId: blank.pages[0]!.id, object });
  };
  const open = (document: ReturnType<typeof documentWith>) =>
    readNativeDocumentContents("", () => ({ document, warnings: [] })).warnings ?? [];

  it.each([["Ac", 2], ["Pr", 1], ["Ts", 3]] as const)("reports a typed %s on a bond stating %i on open, and badges it", (element, hydrogenCount) => {
    const group = { id: "g", element, x: 20, y: 0, labelLiteral: true, hydrogenCount };
    const subject = molecule("m", [carbon, group], [bond]);
    expect(open(documentWith(subject))).toEqual([{
      code: "document.atom_hydrogen_count_not_counted",
      message: `ChemDraft document: atom g (${element}) states ${hydrogenCount} hydrogen${hydrogenCount === 1 ? "" : "s"}, but an ` +
        "abbreviation's hydrogens come from what it stands for, so the stated count is kept as stored but not counted, and the atom is flagged.",
      sourceObjectId: "m", atomIds: ["g"]
    }]);
    const atom = subject.atoms.find((candidate) => candidate.id === "g")!;
    expect(nativeAtomValidationState(atom, subject.bonds, atom.formalCharge, subject.atoms)).toMatchObject({
      valid: false, hydrogenCountNotCounted: true,
      invalidReason: `${element} states ${hydrogenCount} H, which is not counted: an abbreviation's hydrogens come from what it stands for.`,
      invalidDetail: expect.stringContaining(`The label, formula and SMILES count what ${element} stands for.`)
    });
  });

  it.each([
    ["Ac", 2, true, false], ["Pr", 1, true, false], ["Ts", 3, true, false], ["Ac", 2, false, true], ["Ts", 0, true, true]
  ] as const)("does not report %s stating %i (typed %s, bonded %s): the element, or 0 on the group", (element, hydrogenCount, typed, bonded) => {
    const group = { id: "g", element, x: 20, y: 0, hydrogenCount, ...(typed ? { labelLiteral: true } : {}) };
    const document = documentWith(molecule("m", [carbon, group], bonded ? [bond] : []));
    expect(open(document)).toEqual([]);
    expect(nativeHydrogenCountNotCountedWarnings(document)).toEqual([]);
  });
});
