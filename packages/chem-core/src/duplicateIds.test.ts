import { describe, expect, it } from "vitest";
import { createEmptyDocument, parseDocument, readSerializedDocument, serializeDocument } from "./document";
import { snapshotChemicalIdentity } from "./identity";
import { applyPatch } from "./patches";
import type { ChemDraftDocument, DocumentObject, MoleculeObject } from "./schemas";

const now = "2026-11-24T00:00:00.000Z";

function molecule(id: string, x: number, atoms: MoleculeObject["atoms"], bonds: MoleculeObject["bonds"]): MoleculeObject {
  return { id, type: "molecule", x, y: 100, width: 40, height: 20, rotation: 0, style: {},
    structure: "", structureFormat: "unknown", superatoms: [], rGroups: [], atoms, bonds };
}

const ethanol = () => molecule("mol", 100, [
  { id: "a1", element: "C", x: 0, y: 0, formalCharge: 0 },
  { id: "a2", element: "C", x: 20, y: 0, formalCharge: 0 },
  { id: "a3", element: "O", x: 40, y: 0, formalCharge: 0 }
], [
  { id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" },
  { id: "b2", fromAtomId: "a2", toAtomId: "a3", order: "single" }
]);

const ammonium = () => molecule("mol", 300, [
  { id: "n1", element: "N", x: 0, y: 0, formalCharge: 1 },
  { id: "c1", element: "C", x: 20, y: 0, formalCharge: 0 }
], [{ id: "b1", fromAtomId: "n1", toAtomId: "c1", order: "single" }]);

function documentWith(objects: DocumentObject[]): ChemDraftDocument {
  const document = createEmptyDocument({ now });
  document.pages[0]!.objects = objects;
  // The strict in-memory validator accepts repeated ids, as files in the wild carry them.
  return parseDocument(document);
}

function open(document: ChemDraftDocument) {
  return readSerializedDocument(serializeDocument(document));
}

/** Everything but ids: the chemistry and placement a renumbering must not touch. */
function withoutIds(object: DocumentObject): unknown {
  const { id: _id, ...rest } = structuredClone(object) as DocumentObject & Record<string, unknown>;
  if (object.type === "molecule") {
    return { ...rest, atoms: object.atoms.map(({ id: _atom, ...atom }) => atom),
      bonds: object.bonds.map(({ id: _bond, ...bond }) => bond) };
  }
  return rest;
}

describe("native open renumbers repeated ids", () => {
  it("gives a later same-page object a fresh id, one warning, and edits by id reach the first copy only", () => {
    const source = documentWith([
      ethanol(),
      ammonium(),
      { id: "mark", type: "electron-mark", markKind: "lone-pair", x: 300, y: 80, width: 6, height: 6, rotation: 0,
        style: {}, anchor: { kind: "atom", objectId: "mol", atomId: "n1" } },
      { id: "rxn", type: "reaction", x: 0, y: 0, width: 0, height: 0, rotation: 0, style: {},
        components: [{ role: "reactant", objectId: "mol" }], conditionsTextObjectIds: [], mappingState: "unknown" }
    ]);
    const { document, warnings } = open(source);
    const objects = document.pages[0]!.objects;

    expect(objects.map((object) => object.id)).toEqual(["mol", "mol_2", "mark", "rxn"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "NATIVE_DUPLICATE_IDS_RENUMBERED", path: ["pages"],
      originalValue: [{ kind: "object", pageId: "page_001", from: "mol", to: "mol_2" }] });
    expect(warnings[0]!.message).toBe(
      "Renumbered 1 repeated id so each copy can be edited on its own: object \"mol\" on page \"page_001\" became \"mol_2\". "
      + "References to a repeated id stay with its first copy.");

    // Chemistry and placement are untouched: same atoms, bonds, charges and coordinates.
    source.pages[0]!.objects.slice(0, 2).forEach((object, index) => expect(withoutIds(objects[index]!)).toEqual(withoutIds(object)));
    const [first, second] = objects as [MoleculeObject, MoleculeObject];
    expect(snapshotChemicalIdentity(first)).toEqual(snapshotChemicalIdentity(source.pages[0]!.objects[0] as MoleculeObject));
    expect(snapshotChemicalIdentity(second)).toEqual(snapshotChemicalIdentity(source.pages[0]!.objects[1] as MoleculeObject));
    expect(second.atoms.map((atom) => atom.id)).toEqual(["n1", "c1"]);

    // The mark names an atom only the second copy has, so it follows that copy. The reaction
    // cannot say which copy it meant and stays with the first.
    expect(objects[2]).toMatchObject({ anchor: { objectId: "mol_2", atomId: "n1" } });
    expect(objects[3]).toMatchObject({ components: [{ role: "reactant", objectId: "mol" }] });

    const updated = applyPatch(document, { op: "updateObject", objectId: "mol", changes: { x: 999 } }, { now });
    expect(updated.pages[0]!.objects.map((object) => object.x)).toEqual([999, 300, 300, 0]);
    const removed = applyPatch(document, { op: "removeObject", objectId: "mol" }, { now });
    expect(() => applyPatch(removed, { op: "updateObject", objectId: "mol", changes: { x: 999 } }, { now })).toThrow();
    expect(removed.pages[0]!.objects.find((object) => object.id === "mol_2")!.x).toBe(300);
  });

  it("keeps a renumbered copy's reference to itself pointing at itself", () => {
    const copy = ammonium();
    copy.superatoms = [{ label: "Me", attachmentPoints: [{ kind: "atom", objectId: "mol", atomId: "c1" }], warnings: [] }];
    const { document } = open(documentWith([ethanol(), copy]));
    const second = document.pages[0]!.objects[1] as MoleculeObject;
    expect(second.id).toBe("mol_2");
    expect(second.superatoms[0]!.attachmentPoints[0]).toMatchObject({ objectId: "mol_2", atomId: "c1" });
  });

  it("renumbers repeated atom and bond ids inside one molecule without changing its chemistry", () => {
    const repeated = molecule("mol", 100, [
      { id: "a1", element: "C", x: 0, y: 0, formalCharge: 0 },
      { id: "a2", element: "O", x: 20, y: 0, formalCharge: -1 },
      { id: "a2", element: "Na", x: 60, y: 0, formalCharge: 1 },
      { id: "a4", element: "C", x: 0, y: 20, formalCharge: 0 }
    ], [
      { id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" },
      { id: "b1", fromAtomId: "a1", toAtomId: "a4", order: "single" }
    ]);
    const source = documentWith([repeated]);
    const { document, warnings } = open(source);
    const opened = document.pages[0]!.objects[0] as MoleculeObject;

    expect(opened.id).toBe("mol");
    expect(opened.atoms.map((atom) => atom.id)).toEqual(["a1", "a2", "a2_2", "a4"]);
    expect(opened.bonds.map((bond) => bond.id)).toEqual(["b1", "b1_2"]);
    expect(warnings.map((warning) => warning.code)).toEqual(["NATIVE_DUPLICATE_IDS_RENUMBERED"]);
    expect(warnings[0]!.message).toContain("2 repeated ids");
    expect(warnings[0]!.message).toContain("atom \"a2\" in molecule \"mol\" became \"a2_2\"");
    expect(warnings[0]!.message).toContain("bond \"b1\" in molecule \"mol\" became \"b1_2\"");

    // Same atoms, charges, coordinates and bonds; the bonds still join the first a2.
    expect(withoutIds(opened)).toEqual(withoutIds(source.pages[0]!.objects[0]!));
    expect(opened.bonds.map((bond) => [bond.fromAtomId, bond.toAtomId])).toEqual([["a1", "a2"], ["a1", "a4"]]);
    // The identity a file with unique ids would have had, with bonds on the first a2.
    const unique = structuredClone(opened);
    unique.atoms[2]!.id = "a3";
    expect(snapshotChemicalIdentity(opened)).toEqual(snapshotChemicalIdentity(unique));
  });

  it("opens a document without repeated ids exactly as before", () => {
    const source = documentWith([ethanol(), { ...ammonium(), id: "mol_other" }]);
    const serialized = serializeDocument(source);
    const { document, warnings } = readSerializedDocument(serialized);
    expect(warnings).toEqual([]);
    expect(document).toEqual(parseDocument(JSON.parse(serialized)));
    expect(serializeDocument(document)).toBe(serialized);
  });

  it("keeps a preserved unknown field on the copy it came from", () => {
    const raw = JSON.parse(serializeDocument(documentWith([
      { id: "plus", type: "plus", x: 0, y: 0, width: 10, height: 10, rotation: 0, style: {} },
      { id: "plus", type: "plus", x: 50, y: 0, width: 10, height: 10, rotation: 0, style: {} }
    ])));
    raw.formatVersion = raw.minAppVersion = "9.0.0";
    raw.pages[0].objects[1].futureGlow = 3;
    const { document, warnings } = readSerializedDocument(JSON.stringify(raw));
    expect(document.pages[0]!.objects.map((object) => object.id)).toEqual(["plus", "plus_2"]);
    expect(warnings.filter((warning) => warning.code === "NATIVE_DUPLICATE_IDS_RENUMBERED")).toHaveLength(1);
    const saved = JSON.parse(serializeDocument(document));
    expect(saved.pages[0].objects[0]).not.toHaveProperty("futureGlow");
    expect(saved.pages[0].objects[1]).toMatchObject({ id: "plus_2", futureGlow: 3 });
  });
});
