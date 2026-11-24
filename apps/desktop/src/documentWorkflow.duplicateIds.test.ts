import { describe, expect, it } from "vitest";
import { applyPatch, createEmptyDocument, parseDocument, serializeDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { createNativeSavePayload, openNativeDocument } from "./documentWorkflow";

const now = "2026-11-24T00:00:00.000Z";

function moleculeAt(x: number, element: string): MoleculeObject {
  return { id: "molecule_001", type: "molecule", x, y: 100, width: 22, height: 22, rotation: 0, style: {},
    structure: "", structureFormat: "unknown", superatoms: [], rGroups: [],
    atoms: [{ id: "a", element: "C", x: 0, y: 0, formalCharge: 0 }, { id: "b", element, x: 22, y: 0, formalCharge: 0 }],
    bonds: [{ id: "bond", fromAtomId: "a", toAtomId: "b", order: "single" }] };
}

function documentWithRepeatedId(): ChemDraftDocument {
  const document = createEmptyDocument({ now });
  document.pages[0]!.objects = [moleculeAt(100, "O"), moleculeAt(300, "N")];
  return parseDocument(document);
}

const routes: [string, (document: ChemDraftDocument) => string, string][] = [
  ["native JSON", serializeDocument, "legacy-json"],
  ["CDXML with a native payload", (document) => createNativeSavePayload(document).contents, "native-payload"]
];

describe("opening a native document with a repeated same-page id", () => {
  it.each(routes)("renumbers the later copy once, with one warning, through %s", (_route, save, source) => {
    const opened = openNativeDocument(save(documentWithRepeatedId()));
    expect(opened.source).toBe(source);
    const document = opened.document!;
    const objects = document.pages[0]!.objects as MoleculeObject[];

    expect(objects.map((object) => object.id)).toEqual(["molecule_001", "molecule_001_2"]);
    expect(objects.map((object) => object.atoms.map((atom) => atom.element))).toEqual([["C", "O"], ["C", "N"]]);
    expect(objects.map((object) => object.x)).toEqual([100, 300]);
    const renumbered = opened.warnings.filter((warning) => warning.code === "NATIVE_DUPLICATE_IDS_RENUMBERED");
    expect(renumbered).toHaveLength(1);
    expect(renumbered[0]!.message).toContain("object \"molecule_001\" on page \"page_001\" became \"molecule_001_2\"");

    const updated = applyPatch(document, { op: "updateObject", objectId: "molecule_001", changes: { x: 999 } }, { now });
    expect(updated.pages[0]!.objects.map((object) => object.x)).toEqual([999, 300]);
  });

  it.each(routes)("leaves a document without repeated ids unchanged through %s", (_route, save) => {
    const source = documentWithRepeatedId();
    source.pages[0]!.objects[1]!.id = "molecule_002";
    const opened = openNativeDocument(save(source));
    expect(opened.warnings.filter((warning) => warning.code === "NATIVE_DUPLICATE_IDS_RENUMBERED")).toEqual([]);
    expect(opened.document!.pages[0]!.objects.map((object) => object.id)).toEqual(["molecule_001", "molecule_002"]);
  });
});
