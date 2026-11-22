import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, parseDocument, readSerializedDocument, serializeDocument } from "./document";
import { nextObjectId } from "./objectIds";
import type { ChemDraftDocument, DocumentObject, MoleculeObject } from "./schemas";

const now = "2026-11-22T00:00:00.000Z";

function molecule(id: string, x: number): MoleculeObject {
  return {
    id, type: "molecule", x, y: 40, width: 22, height: 20, rotation: 0, style: {},
    structureFormat: "smiles", structure: "C[C@H](N)C(=O)O", rGroups: [], superatoms: [],
    atoms: [
      { id: "a1", element: "C", x, y: 40, formalCharge: 0 },
      { id: "a2", element: "N", x: x + 22, y: 40, formalCharge: 1, isotope: 15 }
    ],
    bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single", display: { bondStyle: "wedge" } }]
  } as MoleculeObject;
}

function text(id: string, x: number): DocumentObject {
  return { id, type: "text", x, y: 200, width: 40, height: 14, rotation: 0, style: {}, text: id, spans: [] } as DocumentObject;
}

/** A native file: page 1 holds `objects`, page 2 (when given) holds `second`. */
function file(objects: DocumentObject[], options: { second?: DocumentObject[]; selection?: string[] } = {}): string {
  const empty = createEmptyDocument({ now });
  const page = { ...empty.pages[0]!, id: "page-1", objects };
  const pages = options.second ? [page, { ...empty.pages[0]!, id: "page-2", objects: options.second }] : [page];
  return serializeDocument({ ...empty, pages, selection: { pageId: "page-1", objectIds: options.selection ?? [] } } as ChemDraftDocument);
}

/** Everything a molecule carries apart from its id: atoms, bonds, charges, isotopes, stereo, coordinates. */
const chemistry = ({ id: _id, ...rest }: DocumentObject) => rest;

afterEach(() => vi.restoreAllMocks());

describe("native open renumbers duplicate object ids on the same page", () => {
  it("gives the second copy a new unique id, warns once, logs once, and changes nothing else", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const second = { ...molecule("X", 100), compatibility: { warnings: [{ code: "x.note", message: "about this copy", objectId: "X" }], unknown: {} } };
    const source = file([molecule("X", 0), second, text("label", 0)], { selection: ["X"] });
    const read = readSerializedDocument(source);
    const objects = read.document.pages[0]!.objects;

    expect(objects.map(object => object.id)).toEqual(["X", "X_003", "label"]);
    expect(new Set(objects.map(object => object.id)).size).toBe(objects.length);
    expect(read.warnings).toEqual([{
      code: "NATIVE_DUPLICATE_OBJECT_IDS_RENUMBERED", path: ["pages"],
      originalValue: [{ pageIndex: 0, objectIndex: 1, from: "X", to: "X_003" }],
      message: "This file had 2 objects sharing an id on page 1; ChemDraft gave the duplicates new ids."
    }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]!.join(" ")).toMatch(/renumbered duplicate same-page object ids.*page 1 object 1: X -> X_003/);

    // Chemistry is untouched: each copy equals what the file held, apart from the renamed id.
    const original = parseDocument(JSON.parse(source)).pages[0]!.objects;
    expect(objects[0]).toEqual(original[0]);
    expect(chemistry(objects[1]!)).toEqual(chemistry({ ...original[1]!,
      compatibility: { ...original[1]!.compatibility!, warnings: [{ code: "x.note", message: "about this copy", objectId: "X_003" }] } }));
    expect(objects[2]).toEqual(original[2]);
    // The selection names the id, which cannot tell the copies apart: it keeps meaning the first copy.
    expect(read.document.selection).toEqual({ pageId: "page-1", objectIds: ["X"] });
    // Saving writes the new ids, so the file reopens with no warning.
    expect(readSerializedDocument(serializeDocument(read.document)).warnings).toEqual([]);
  });

  it("keeps ambiguous references from other objects on the first copy, and leaves cross-page repeats alone", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const group = { id: "g", type: "group", x: 0, y: 0, width: 1, height: 1, rotation: 0, style: {}, childObjectIds: ["X"] } as DocumentObject;
    const read = readSerializedDocument(file([molecule("X", 0), molecule("X", 100), group], { second: [molecule("X", 0)] }));
    expect(read.document.pages[0]!.objects.map(object => object.id)).toEqual(["X", "X_003", "g"]);
    expect(read.document.pages[0]!.objects[2]).toMatchObject({ childObjectIds: ["X"] });
    // Ids are page-scoped: page 2's X is a different, legitimate object.
    expect(read.document.pages[1]!.objects.map(object => object.id)).toEqual(["X"]);
    expect(read.warnings.map(warning => warning.message))
      .toEqual(["This file had 2 objects sharing an id on page 1; ChemDraft gave the duplicates new ids."]);
  });

  it("names every page and counts every object sharing an id", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const read = readSerializedDocument(file([molecule("X", 0), molecule("X", 50), molecule("X", 100), text("t", 0), text("t", 9)],
      { second: [text("u", 0), text("u", 1)] }));
    const ids = read.document.pages.flatMap(page => page.objects.map(object => object.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(read.document.pages[0]!.objects.map(object => object.id)).toEqual(["X", "X_004", "X_005", "t", "t_006"]);
    expect(read.warnings.map(warning => warning.message)).toEqual([
      "This file had 5 objects sharing ids on page 1 and 2 objects sharing an id on page 2; ChemDraft gave the duplicates new ids."
    ]);
  });

  it("opens a normal file exactly as before: the same document model and no warning or log", () => {
    const warn = vi.spyOn(console, "warn");
    const source = file([molecule("X", 0), molecule("Y", 100), text("label", 0)], { second: [molecule("X", 0)], selection: ["X"] });
    const read = readSerializedDocument(source);
    expect(read.warnings).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(JSON.stringify(read.document)).toBe(JSON.stringify(parseDocument(JSON.parse(source))));
    expect(serializeDocument(read.document)).toBe(source);
  });

  it("allocates with the shared nextObjectId scheme", () => {
    const document = parseDocument(JSON.parse(file([molecule("mol_001", 0), molecule("mol_002", 10)])));
    expect(nextObjectId(document, "mol")).toBe("mol_003");
    expect(nextObjectId(document, "mol", new Set(["mol_003"]))).toBe("mol_004");
  });
});
