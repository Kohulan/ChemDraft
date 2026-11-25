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
      message: "This file had 2 objects sharing an id on page 1; ChemDraft gave the duplicates new ids. Save to keep the fix."
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
      .toEqual(["This file had 2 objects sharing an id on page 1; ChemDraft gave the duplicates new ids. Save to keep the fix."]);
  });

  it("names every page and counts every object sharing an id", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const read = readSerializedDocument(file([molecule("X", 0), molecule("X", 50), molecule("X", 100), text("t", 0), text("t", 9)],
      { second: [text("u", 0), text("u", 1)] }));
    const ids = read.document.pages.flatMap(page => page.objects.map(object => object.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(read.document.pages[0]!.objects.map(object => object.id)).toEqual(["X", "X_004", "X_005", "t", "t_006"]);
    expect(read.warnings.map(warning => warning.message)).toEqual([
      "This file had 5 objects sharing ids on page 1 and 2 objects sharing an id on page 2; ChemDraft gave the duplicates new ids. Save to keep the fix."
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

  it("Kimi xhigh finding 3: a renamed copy's own chemistry warnings name its new id, the first copy's keep the old one", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Each copy carries its own chemical-metadata warnings naming its id; another object's warning stays as written.
    const note = (message: string, objectId?: string) => ({ code: "x.note", message, ...(objectId ? { objectId } : {}) });
    const withChemistry = (x: number, label: string) => ({ ...molecule("X", x),
      chemistry: { formula: "C3H8N2O2", isotopeLabels: [], stereochemistry: [], warnings: [note(`${label} chemistry`, "X"), note(`${label} other`, "label")] },
      superatoms: [{ label: "Ph", attachmentPoints: [], warnings: [note(`${label} superatom`, "X")] }],
      rGroups: [{ label: "R1", querySemantics: "unknown", attachmentPoints: [], warnings: [note(`${label} r-group`, "X")] }]
    }) as DocumentObject;
    const superatom = (x: number) => ({ id: "S", type: "superatom", x, y: 0, width: 10, height: 10, rotation: 0, style: {}, label: "Ph",
      metadata: { label: "Ph", attachmentPoints: [], warnings: [note("superatom object", "S")] } }) as DocumentObject;
    const rLabel = (x: number) => ({ id: "R", type: "r-group-label", x, y: 0, width: 10, height: 10, rotation: 0, style: {}, label: "R1",
      display: { label: "R1", querySemantics: "unknown", attachmentPoints: [], warnings: [note("r-group label", "R")] } }) as DocumentObject;
    const source = file([withChemistry(0, "first"), withChemistry(100, "second")]);
    const objects = readSerializedDocument(source).document.pages[0]!.objects as MoleculeObject[];
    expect(objects.map(object => object.id)).toEqual(["X", "X_002"]);
    expect(objects[0]!.chemistry!.warnings).toEqual([note("first chemistry", "X"), note("first other", "label")]);
    expect(objects[1]!.chemistry!.warnings).toEqual([note("second chemistry", "X_002"), note("second other", "label")]);
    expect(objects[0]!.superatoms[0]!.warnings).toEqual([note("first superatom", "X")]);
    expect(objects[1]!.superatoms[0]!.warnings).toEqual([note("second superatom", "X_002")]);
    expect(objects[0]!.rGroups[0]!.warnings).toEqual([note("first r-group", "X")]);
    expect(objects[1]!.rGroups[0]!.warnings).toEqual([note("second r-group", "X_002")]);
    // Chemistry is untouched apart from the renamed id in the copy's own warnings.
    const original = parseDocument(JSON.parse(source)).pages[0]!.objects as MoleculeObject[];
    expect(objects[0]).toEqual(original[0]);
    const rename = (warnings: { objectId?: string }[]) => warnings.map(warning => warning.objectId === "X" ? { ...warning, objectId: "X_002" } : warning);
    expect(chemistry(objects[1]!)).toEqual(chemistry({ ...original[1]!,
      chemistry: { ...original[1]!.chemistry!, warnings: rename(original[1]!.chemistry!.warnings) },
      superatoms: original[1]!.superatoms.map(entry => ({ ...entry, warnings: rename(entry.warnings) })),
      rGroups: original[1]!.rGroups.map(entry => ({ ...entry, warnings: rename(entry.warnings) })) } as MoleculeObject));

    // A superatom's metadata and an R-group label's display warnings follow the same policy.
    const labels = readSerializedDocument(file([superatom(0), superatom(20), rLabel(40), rLabel(60)])).document.pages[0]!.objects;
    expect(labels.map(object => object.id)).toEqual(["S", "S_003", "R", "R_004"]);
    expect(labels.map(object => object.type === "superatom" ? object.metadata.warnings : object.type === "r-group-label" ? object.display.warnings : []))
      .toEqual([[note("superatom object", "S")], [note("superatom object", "S_003")], [note("r-group label", "R")], [note("r-group label", "R_004")]]);
  });

  describe("a renamed copy never captures a dangling reference equal to its would-be new id", () => {
    // Objects X, X and one referrer: two distinct ids, so the shared scheme's first candidate is X_003.
    // The referrer names X_003, which no object holds; were the copy renamed X_003 it would silently
    // become that reference's target (a reaction product, a group member, an annotation's anchor).
    const base = { x: 0, y: 0, width: 10, height: 10, rotation: 0, style: {} };
    const referrers: [string, DocumentObject, (object: DocumentObject) => unknown][] = [
      ["a reaction product", { ...base, id: "rxn", type: "reaction", components: [{ role: "reactant", objectId: "X" }, { role: "product", objectId: "X_003" }],
        conditionsTextObjectIds: [], mappingState: "unknown" } as DocumentObject,
        object => object.type === "reaction" ? object.components : undefined],
      ["a group child", { ...base, id: "g", type: "group", childObjectIds: ["X_003"] } as DocumentObject,
        object => object.type === "group" ? object.childObjectIds : undefined],
      ["an annotation anchor", { ...base, id: "mark", type: "electron-mark", markKind: "radical-dot", anchor: { kind: "object", objectId: "X_003" } } as DocumentObject,
        object => object.type === "electron-mark" ? object.anchor : undefined]
    ];

    it.each(referrers)("%s", (_name, referrer, reference) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const source = file([molecule("X", 0), molecule("X", 100), referrer]);
      const read = readSerializedDocument(source);
      const objects = read.document.pages[0]!.objects;
      // The copy skips X_003 and takes the next index; numbering otherwise follows the shared scheme.
      expect(objects.map(object => object.id)).toEqual(["X", "X_004", referrer.id]);
      // The dangling reference is untouched and still dangles: no object took its id.
      const original = parseDocument(JSON.parse(source)).pages[0]!.objects;
      expect(reference(objects[2]!)).toEqual(reference(original[2]!));
      expect(objects[2]).toEqual(original[2]);
      expect(objects.some(object => object.id === "X_003")).toBe(false);
      // Chemistry of both copies is unchanged, and the single warning is the usual one.
      expect(objects[0]).toEqual(original[0]);
      expect(chemistry(objects[1]!)).toEqual(chemistry(original[1]!));
      expect(read.warnings.filter(warning => warning.code === "NATIVE_DUPLICATE_OBJECT_IDS_RENUMBERED")).toEqual([{
        code: "NATIVE_DUPLICATE_OBJECT_IDS_RENUMBERED", path: ["pages"],
        originalValue: [{ pageIndex: 0, objectIndex: 1, from: "X", to: "X_004" }],
        message: "This file had 2 objects sharing an id on page 1; ChemDraft gave the duplicates new ids. Save to keep the fix."
      }]);
    });
  });

  it("allocates with the shared nextObjectId scheme", () => {
    const document = parseDocument(JSON.parse(file([molecule("mol_001", 0), molecule("mol_002", 10)])));
    expect(nextObjectId(document, "mol")).toBe("mol_003");
    expect(nextObjectId(document, "mol", new Set(["mol_003"]))).toBe("mol_004");
  });
});
