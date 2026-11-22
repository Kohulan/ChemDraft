import { afterEach, describe, expect, it, vi } from "vitest";
import { Molecule } from "openchemlib";
import { createEmptyDocument, parseDocument, serializeDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { createNativeMolfileMolecule, createNativeSavePayload, openNativeDocument } from "./documentWorkflow";

/**
 * A native .chemdraft file whose page 1 holds two objects with one id (the schema has no uniqueness
 * rule, so a hand-made or third-party file can). Opening it gives the later copy a new id, reports it
 * as an open warning, and never changes chemistry (AGENTS.md section 7).
 */
const canonical = (molecule: MoleculeObject) => Molecule.fromMolfile(molecule.structure).toIsomericSmiles();
const message = "This file had 2 objects sharing an id on page 1; ChemDraft gave the duplicates new ids.";

function documentWith(objects: (base: ChemDraftDocument) => MoleculeObject[]): ChemDraftDocument {
  const empty = createEmptyDocument();
  const page = { ...empty.pages[0]!, id: "page-1", objects: objects(empty) };
  return parseDocument({ ...empty, pages: [page], selection: { pageId: "page-1", objectIds: [page.objects[0]!.id] } });
}

function alanine(base: ChemDraftDocument, id: string, x: number): MoleculeObject {
  const molfile = Molecule.fromSmiles("C[C@H]([NH3+])C(=O)[O-]").toMolfile();
  return { ...createNativeMolfileMolecule(base, { x, y: 200 }, molfile, "molfile-v2000"), id };
}

/** What chemistry is: canonical SMILES, atom and bond records (elements, charges, isotopes, stereo, coordinates). */
function chemistryOf(molecule: MoleculeObject) {
  const { id: _id, ...rest } = molecule;
  return { smiles: canonical(molecule), atoms: molecule.atoms.length, bonds: molecule.bonds.length, rest };
}

afterEach(() => vi.restoreAllMocks());

describe("opening a native file with two same-page objects sharing an id", () => {
  const duplicated = () => documentWith(base => [alanine(base, "X", 120), alanine(base, "X", 320)]);

  it.each([
    ["native JSON", (document: ChemDraftDocument) => serializeDocument(document)],
    ["CDXML envelope with an embedded native payload", (document: ChemDraftDocument) => createNativeSavePayload(document).contents]
  ])("renumbers the duplicate, warns, and keeps chemistry identical (%s)", (_name, save) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const before = duplicated();
    const opened = openNativeDocument(save(before));
    expect(opened.document).toBeDefined();
    const objects = opened.document!.pages[0]!.objects as MoleculeObject[];

    expect(objects.map(object => object.id)).toEqual(["X", "X_002"]);
    expect(opened.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "NATIVE_DUPLICATE_OBJECT_IDS_RENUMBERED", message })]));
    expect(opened.warnings.filter(warning => warning.code === "NATIVE_DUPLICATE_OBJECT_IDS_RENUMBERED")).toHaveLength(1);
    expect(warn.mock.calls.some(call => /renumbered duplicate same-page object ids/.test(call.join(" ")))).toBe(true);

    const original = before.pages[0]!.objects as MoleculeObject[];
    expect(canonical(objects[0]!)).toBe(canonical(original[0]!));
    objects.forEach((object, index) => expect(chemistryOf(object)).toEqual(chemistryOf(original[index]!)));
    expect(opened.document!.selection.objectIds).toEqual(["X"]);
  });

  it("opens a normal file unchanged: the same document model, and no renumbering warning", () => {
    const warn = vi.spyOn(console, "warn");
    const before = documentWith(base => [alanine(base, "X", 120), alanine(base, "Y", 320)]);
    const json = serializeDocument(before);
    const opened = openNativeDocument(json);
    expect(opened.warnings).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(serializeDocument(opened.document!)).toBe(json);
    const viaEnvelope = openNativeDocument(createNativeSavePayload(before).contents);
    expect(viaEnvelope.warnings.some(warning => warning.code === "NATIVE_DUPLICATE_OBJECT_IDS_RENUMBERED")).toBe(false);
    expect(serializeDocument(viaEnvelope.document!)).toBe(json);
  });
});
