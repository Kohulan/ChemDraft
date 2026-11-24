import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, parseDocument, readDocument, readSerializedDocument, serializeDocument } from "./document";
import { nextObjectId, renumberDuplicatePageObjectIds, type RenumberedId } from "./objectIds";
import type { ChemDraftDocument, DocumentObject, MoleculeObject } from "./schemas";

const now = "2026-11-24T00:00:00.000Z";

type Atom = MoleculeObject["atoms"][number];
type Bond = MoleculeObject["bonds"][number];

function molecule(id: string, atoms: Atom[], bonds: Bond[], extra: Partial<MoleculeObject> = {}): MoleculeObject {
  return {
    id, type: "molecule", x: 0, y: 40, width: 60, height: 20, rotation: 0, style: {},
    structureFormat: "unknown", structure: "", rGroups: [], superatoms: [], atoms, bonds, ...extra
  } as MoleculeObject;
}

const atom = (id: string, element: string, x: number, more: Partial<Atom> = {}): Atom =>
  ({ id, element, x, y: 40, formalCharge: 0, ...more }) as Atom;
const bond = (id: string, fromAtomId: string, toAtomId: string, more: Partial<Bond> = {}): Bond =>
  ({ id, fromAtomId, toAtomId, order: "single", ...more }) as Bond;

function text(id: string, value: string): DocumentObject {
  return { id, type: "text", x: 0, y: 200, width: 40, height: 14, rotation: 0, style: {}, text: value, spans: [] } as DocumentObject;
}

function file(objects: DocumentObject[], second?: DocumentObject[]): string {
  const empty = createEmptyDocument({ now });
  const page = { ...empty.pages[0]!, id: "page-1", objects };
  const pages = second ? [page, { ...empty.pages[0]!, id: "page-2", objects: second }] : [page];
  return serializeDocument({ ...empty, pages, selection: { pageId: "page-1", objectIds: [] } } as ChemDraftDocument);
}

/** The molecule with every atom and bond id blanked: what must not change apart from ids. */
const withoutItemIds = (object: DocumentObject) => {
  const { id: _id, ...rest } = object as MoleculeObject;
  return { ...rest, atoms: rest.atoms.map(({ id: _atom, ...item }) => item), bonds: rest.bonds.map(({ id: _bond, ...item }) => item) };
};

afterEach(() => vi.restoreAllMocks());

describe("native open renumbers repeated atom and bond ids inside one molecule", () => {
  it("renames later atoms and bonds, keeps bonds on the first atom, warns once, and changes nothing else", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const source = file([molecule("M", [
      atom("a1", "C", 0), atom("a2", "N", 20, { formalCharge: 1, isotope: 15 }), atom("a1", "O", 40, { formalCharge: -1 })
    ], [
      bond("b1", "a1", "a2", { display: { bondStyle: "wedge" } }), bond("b2", "a2", "a1", { order: "double" }), bond("b1", "a1", "a2")
    ])]);
    const read = readSerializedDocument(source);
    const read2 = read.document.pages[0]!.objects[0] as MoleculeObject;

    expect(read2.id).toBe("M");
    expect(read2.atoms.map(item => item.id)).toEqual(["a1", "a2", "a1_2"]);
    expect(read2.bonds.map(item => item.id)).toEqual(["b1", "b2", "b1_2"]);
    // Endpoints name the repeated id and cannot tell the atoms apart: they stay on the first a1.
    expect(read2.bonds.map(item => [item.fromAtomId, item.toAtomId])).toEqual([["a1", "a2"], ["a2", "a1"], ["a1", "a2"]]);
    expect(read.warnings).toEqual([{
      code: "NATIVE_DUPLICATE_OBJECT_IDS_RENUMBERED", path: ["pages"],
      originalValue: [
        { kind: "atom", pageIndex: 0, objectIndex: 0, moleculeId: "M", itemIndex: 2, from: "a1", to: "a1_2" },
        { kind: "bond", pageIndex: 0, objectIndex: 0, moleculeId: "M", itemIndex: 2, from: "b1", to: "b1_2" }
      ],
      message: "This file had 2 atoms sharing an id within a molecule on page 1 and 2 bonds sharing an id within a molecule on page 1;"
        + " ChemDraft gave the duplicates new ids. Bonds to a shared atom id stay on the first atom with it. Save to keep the fix."
    }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]!.join(" ")).toMatch(/page 1 object 0 atom 2: a1 -> a1_2; page 1 object 0 bond 2: b1 -> b1_2/);

    // Elements, charges, isotopes, orders, styles, coordinates: identical to the file.
    const original = parseDocument(JSON.parse(source)).pages[0]!.objects[0]!;
    expect(withoutItemIds(read2)).toEqual(withoutItemIds(original));
    // Saving writes the fix, so the file reopens with no warning.
    expect(readSerializedDocument(serializeDocument(read.document)).warnings).toEqual([]);
  });

  it("issues ids no string in the file holds, with one forward-moving counter per id", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const read = readSerializedDocument(file([
      molecule("M", [atom("a", "C", 0), atom("a", "C", 10), atom("a", "C", 20), atom("a", "C", 30), atom("a_2", "C", 40)], [
        bond("b", "a", "a_2"), bond("b", "a", "a_2")
      ]),
      // Another molecule's atom, a text object's content and an object id all occupy suffixes too.
      molecule("N", [atom("a_3", "C", 0)], []),
      text("a_4", "a_6"),
      text("b_2", "b")
    ]));
    const [first, second] = read.document.pages[0]!.objects as MoleculeObject[];
    expect(first!.atoms.map(item => item.id)).toEqual(["a", "a_5", "a_7", "a_8", "a_2"]);
    expect(first!.bonds.map(item => item.id)).toEqual(["b", "b_3"]);
    // Atom ids are molecule-scoped: the same id in another molecule is not a repeat.
    expect(second!.atoms.map(item => item.id)).toEqual(["a_3"]);
    expect(read.warnings[0]!.message).toBe("This file had 4 atoms sharing an id within a molecule on page 1 and 2 bonds sharing"
      + " an id within a molecule on page 1; ChemDraft gave the duplicates new ids. Bonds to a shared atom id stay on the first"
      + " atom with it. Save to keep the fix.");
  });

  it("keeps every reference to a repeated atom or bond id on the first one", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const arrow = {
      id: "arrow", type: "reaction-arrow", x: 0, y: 0, width: 10, height: 10, rotation: 0, style: {}, arrowKind: "forward",
      start: { kind: "atom", objectId: "M", atomId: "a1" }, end: { kind: "bond", objectId: "M", bondId: "b1" }, labels: []
    } as DocumentObject;
    const source = file([molecule("M", [
      atom("a1", "C", 0), atom("a2", "S", 20, { labelBondSide: { side: "left", atomId: "a1" } }), atom("a1", "C", 40)
    ], [bond("b1", "a1", "a2"), bond("b1", "a2", "a1")], {
      superatoms: [{ label: "Me", atomIds: ["a1"], attachmentPoints: [{ kind: "atom", objectId: "M", atomId: "a1" }], warnings: [] }]
    }), arrow]);
    const read = readSerializedDocument(source);
    const [mol, readArrow] = read.document.pages[0]!.objects as [MoleculeObject, DocumentObject];
    expect(mol.atoms.map(item => item.id)).toEqual(["a1", "a2", "a1_2"]);
    expect(mol.bonds.map(item => [item.id, item.fromAtomId, item.toAtomId])).toEqual([["b1", "a1", "a2"], ["b1_2", "a2", "a1"]]);
    expect(mol.atoms[1]!.labelBondSide).toEqual({ side: "left", atomId: "a1" });
    expect(mol.superatoms[0]).toMatchObject({ atomIds: ["a1"], attachmentPoints: [{ kind: "atom", objectId: "M", atomId: "a1" }] });
    expect(readArrow).toMatchObject({ start: { objectId: "M", atomId: "a1" }, end: { objectId: "M", bondId: "b1" } });
  });

  it("repairs objects and their atoms in the same pass and the same warning, naming the molecule by its new id", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repeated = () => molecule("X", [atom("a1", "C", 0), atom("a2", "O", 10), atom("a1", "N", 20)], [bond("b1", "a1", "a2")]);
    const read = readSerializedDocument(file([repeated(), repeated()], [molecule("Y", [atom("c", "C", 0), atom("c", "C", 9)], [])]));
    expect(read.warnings).toHaveLength(1);
    expect(read.warnings[0]!.originalValue).toEqual([
      { pageIndex: 0, objectIndex: 1, from: "X", to: "X_003" },
      { kind: "atom", pageIndex: 0, objectIndex: 0, moleculeId: "X", itemIndex: 2, from: "a1", to: "a1_2" },
      { kind: "atom", pageIndex: 0, objectIndex: 1, moleculeId: "X_003", itemIndex: 2, from: "a1", to: "a1_3" },
      { kind: "atom", pageIndex: 1, objectIndex: 0, moleculeId: "Y", itemIndex: 1, from: "c", to: "c_2" }
    ] satisfies RenumberedId[]);
    expect(read.warnings[0]!.message).toBe("This file had 2 objects sharing an id on page 1, 4 atoms sharing ids within 2 molecules"
      + " on page 1 and 2 atoms sharing an id within a molecule on page 2; ChemDraft gave the duplicates new ids. Bonds to a shared"
      + " atom id stay on the first atom with it. Save to keep the fix.");
  });

  it("repairs the in-memory read path too, and leaves a file with molecule-scoped repeats only as it was", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repaired = readDocument(JSON.parse(file([molecule("M", [atom("a", "C", 0), atom("a", "C", 9)], [])])));
    expect((repaired.document.pages[0]!.objects[0] as MoleculeObject).atoms.map(item => item.id)).toEqual(["a", "a_2"]);

    warn.mockClear();
    const source = file([molecule("M", [atom("a", "C", 0), atom("b", "C", 9)], [bond("b", "a", "b")]),
      molecule("N", [atom("a", "C", 0), atom("b", "C", 9)], [bond("b", "a", "b")])]);
    const read = readSerializedDocument(source);
    expect(read.warnings).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(serializeDocument(read.document)).toBe(source);
  });
});

describe("the duplicate-id repair is linear", () => {
  /** The object renumbering this replaced: nextObjectId over a live view, rebuilt on every call. */
  function quadraticReference(root: { pages: { objects: { id?: unknown }[] }[] }): RenumberedId[] {
    const valid = (id: unknown): id is string => typeof id === "string" && id.length > 0;
    const view = root.pages.map(page => ({ objects: page.objects.filter(object => valid(object.id)).map(object => ({ id: object.id as string })) }));
    const out: RenumberedId[] = [];
    root.pages.forEach((page, pageIndex) => {
      const seen = new Set<string>();
      let viewIndex = 0;
      page.objects.forEach((object, objectIndex) => {
        const from = object.id;
        if (!valid(from)) return;
        const entry = view[pageIndex]!.objects[viewIndex++]!;
        if (!seen.has(from)) {
          seen.add(from);
          return;
        }
        const to = nextObjectId({ pages: view }, from);
        entry.id = to;
        seen.add(to);
        out.push({ pageIndex, objectIndex, from, to });
      });
    });
    return out;
  }

  it("gives exactly the ids the per-call nextObjectId scheme gave, on random files", () => {
    let seed = 0x2026_1124;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const pool = ["X", "Y", "X_003", "X_004", "X_005", "X_007", "Y_004", "X_003_004", "Z", "", 7];
    for (let round = 0; round < 400; round += 1) {
      const pages = Array.from({ length: 1 + random(3) }, () => ({
        objects: Array.from({ length: random(14) }, () => ({ id: pool[random(pool.length)], type: "text" }))
      }));
      const expected = quadraticReference(JSON.parse(JSON.stringify({ pages })));
      expect(renumberDuplicatePageObjectIds({ pages })).toEqual(expected);
    }
  });

  /** A file with n repeats of one object id, of one atom id and of one bond id, every early suffix occupied. */
  function crowded(n: number) {
    const objects: Record<string, unknown>[] = [];
    // Object ids X_n..X_3n are taken, so the allocator, which starts past the distinct count, must skip them.
    for (let index = n; index <= 3 * n; index += 1) objects.push({ id: `X_${String(index).padStart(3, "0")}`, type: "text" });
    for (let index = 0; index < n; index += 1) objects.push({ id: "X", type: "text" });
    const atoms: Record<string, unknown>[] = [];
    const bonds: Record<string, unknown>[] = [];
    for (let suffix = 2; suffix <= n + 1; suffix += 1) {
      atoms.push({ id: `a_${suffix}`, element: "C" });
      bonds.push({ id: `b_${suffix}`, fromAtomId: "a", toAtomId: `a_${suffix}` });
    }
    for (let index = 0; index < n; index += 1) {
      atoms.push({ id: "a", element: "C" });
      bonds.push({ id: "b", fromAtomId: "a", toAtomId: "a_2" });
    }
    objects.push({ id: "M", type: "molecule", atoms, bonds });
    return { pages: [{ objects }, { objects: [{ id: "X", type: "text" }, { id: "X", type: "text" }] }] };
  }

  /** Every Set and Map operation the repair makes: its lookups, insertions and allocator probes. */
  function countOperations(run: () => void): number {
    let count = 0;
    const patched: [object, string, (...args: unknown[]) => unknown][] = [];
    for (const [prototype, names] of [[Set.prototype, ["has", "add"]], [Map.prototype, ["has", "get", "set"]]] as const) {
      for (const name of names) {
        const original = (prototype as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!;
        patched.push([prototype, name, original]);
        Object.defineProperty(prototype, name, {
          configurable: true, writable: true,
          value(this: unknown, ...args: unknown[]) { count += 1; return original.apply(this, args); }
        });
      }
    }
    try {
      run();
    } finally {
      for (const [prototype, name, original] of patched) Object.defineProperty(prototype, name, { configurable: true, writable: true, value: original });
    }
    return count;
  }

  it("does at most about twice the work for twice the file, with many repeats of one id and occupied suffixes", () => {
    const n = 150;
    const small = crowded(n);
    const large = crowded(2 * n);
    const smallOps = countOperations(() => renumberDuplicatePageObjectIds(small));
    const largeOps = countOperations(() => renumberDuplicatePageObjectIds(large));

    // The repair really ran: every repeat renamed, every new id unique among the page's objects and the molecule's atoms and bonds.
    const page = large.pages[0]!.objects as { id: string; atoms?: { id: string }[]; bonds?: { id: string }[] }[];
    expect(new Set(page.map(object => object.id)).size).toBe(page.length);
    const mol = page.at(-1)!;
    expect(new Set(mol.atoms!.map(item => item.id)).size).toBe(mol.atoms!.length);
    expect(new Set(mol.bonds!.map(item => item.id)).size).toBe(mol.bonds!.length);
    // The first "a" keeps its id; the other 2n - 1 take a_{2n+2}..a_{4n}, past the occupied a_2..a_{2n+1}.
    expect(mol.atoms!.at(-1)!.id).toBe(`a_${4 * n}`);

    // A quadratic repair (rebuilding the id set per object, or restarting each atom's search at _2) would be ~4x.
    expect(largeOps / smallOps).toBeLessThan(2.3);
    // And the absolute work is a small constant per item in the file.
    const items = page.length + mol.atoms!.length + mol.bonds!.length;
    expect(largeOps).toBeLessThan(40 * items);
  });
});
