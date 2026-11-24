import { describe, expect, it } from "vitest";
import { renumberDuplicateIds, type DuplicateIdRenumbering } from "./duplicateIds";
import type { ChemDraftDocument, DocumentObject, MoleculeObject } from "./schemas";

/*
 * The repair must stay linear in document size and give exactly the results the first version
 * (d94bfacc3) gave. `quadraticReference` below is that version, frozen, so both can be compared.
 */

type Page = ChemDraftDocument["pages"][number];
type Reference = { objectId: string; atomId?: unknown; bondId?: unknown };

function quadraticReference(document: ChemDraftDocument): DuplicateIdRenumbering[] {
  const taken = new Set<string>();
  const collect = (value: unknown) => {
    if (typeof value === "string") taken.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(document);
  const fresh = (id: string) => {
    let suffix = 2;
    while (taken.has(`${id}_${suffix}`)) suffix += 1;
    const next = `${id}_${suffix}`;
    taken.add(next);
    return next;
  };
  const visitReferences = (value: unknown, visit: (reference: Reference) => void): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => visitReferences(item, visit));
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.objectId === "string") visit(record as Reference);
    for (const [key, child] of Object.entries(record)) {
      if (key === "raw" || key === "style") continue;
      visitReferences(child, visit);
    }
  };
  const moleculeHas = (molecule: MoleculeObject, key: "atoms" | "bonds", id: string) => molecule[key].some((item) => item.id === id);
  const relinkReferences = (page: Page, firstById: ReadonlyMap<string, DocumentObject>, copies: readonly { object: DocumentObject; from: string }[]) => {
    const renamedFrom = new Map(copies.map(({ object, from }) => [object, from]));
    const copiesByOriginal = new Map<string, DocumentObject[]>();
    for (const { object, from } of copies) copiesByOriginal.set(from, [...(copiesByOriginal.get(from) ?? []), object]);
    const relink = (reference: Reference, owner: DocumentObject | undefined) => {
      const ownFrom = owner && renamedFrom.get(owner);
      if (ownFrom !== undefined && reference.objectId === ownFrom) {
        reference.objectId = owner!.id;
        return;
      }
      const candidates = copiesByOriginal.get(reference.objectId);
      if (!candidates) return;
      const holds = (object: DocumentObject | undefined) => object?.type === "molecule" && (
        (typeof reference.atomId === "string" && moleculeHas(object, "atoms", reference.atomId))
        || (typeof reference.bondId === "string" && moleculeHas(object, "bonds", reference.bondId)));
      if (holds(firstById.get(reference.objectId))) return;
      const matches = candidates.filter(holds);
      if (matches.length === 1) reference.objectId = matches[0]!.id;
    };
    for (const object of page.objects) visitReferences(object, (reference) => relink(reference, object));
    visitReferences(page.crossings, (reference) => relink(reference, undefined));
  };

  const renumbered: DuplicateIdRenumbering[] = [];
  for (const page of document.pages) {
    const firstById = new Map<string, DocumentObject>();
    const copies: { object: DocumentObject; from: string }[] = [];
    for (const object of page.objects) {
      if (!firstById.has(object.id)) {
        firstById.set(object.id, object);
        continue;
      }
      const from = object.id;
      object.id = fresh(from);
      copies.push({ object, from });
      renumbered.push({ kind: "object", pageId: page.id, from, to: object.id });
    }
    if (copies.length) relinkReferences(page, firstById, copies);
    for (const object of page.objects) {
      if (object.type !== "molecule") continue;
      for (const kind of ["atom", "bond"] as const) {
        const items: { id: string }[] = kind === "atom" ? object.atoms : object.bonds;
        const seen = new Set<string>();
        for (const item of items) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            continue;
          }
          const from = item.id;
          item.id = fresh(from);
          renumbered.push({ kind, pageId: page.id, moleculeId: object.id, from, to: item.id });
        }
      }
    }
  }
  return renumbered;
}

function molecule(id: string, atomIds: string[], bondIds: string[], extra: Partial<MoleculeObject> = {}): MoleculeObject {
  return { id, type: "molecule", x: 0, y: 0, width: 40, height: 20, rotation: 0, style: {},
    structure: "", structureFormat: "unknown", superatoms: [], rGroups: [],
    atoms: atomIds.map((atomId, index) => ({ id: atomId, element: "C", x: index * 20, y: 0, formalCharge: 0 })),
    bonds: bondIds.map((bondId) => ({ id: bondId, fromAtomId: atomIds[0] ?? "", toAtomId: atomIds[1] ?? "", order: "single" as const })),
    ...extra };
}

function mark(id: string, anchor: Record<string, unknown>): DocumentObject {
  return { id, type: "electron-mark", markKind: "lone-pair", x: 0, y: 0, width: 6, height: 6, rotation: 0, style: {},
    anchor } as DocumentObject;
}

function documentOf(pages: { objects: DocumentObject[]; crossings?: unknown[] }[]): ChemDraftDocument {
  return { pages: pages.map((page, index) => ({ id: `page_${index + 1}`, objects: page.objects, crossings: page.crossings ?? [] })) } as unknown as ChemDraftDocument;
}

/** Small deterministic generator (mulberry32). */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]) => items[int(items.length)]!;
  return { next, int, pick };
}

const objectIds = ["m", "m", "m", "m_2", "m_3", "m_2_2", "p", "p", "a"];
const atomIds = ["a", "a", "a_2", "b", "c", "m_2", "a_3"];
const bondIds = ["x", "x", "x_2", "y", "a", "b"];

function randomReference(rng: ReturnType<typeof random>): Record<string, unknown> {
  const reference: Record<string, unknown> = { objectId: rng.pick(objectIds) };
  const shape = rng.int(4);
  if (shape === 0 || shape === 2) reference.atomId = rng.pick(atomIds);
  if (shape === 1 || shape === 2) reference.bondId = rng.pick(bondIds);
  if (shape === 3 && rng.next() < 0.5) reference.atomId = 7; // not a string: never qualifies
  return reference;
}

function randomDocument(seed: number): ChemDraftDocument {
  const rng = random(seed);
  const pages = Array.from({ length: 1 + rng.int(2) }, () => {
    const objects = Array.from({ length: 1 + rng.int(9) }, (): DocumentObject => {
      const id = rng.pick(objectIds);
      const kind = rng.int(10);
      if (kind < 6) {
        const atoms = Array.from({ length: rng.int(5) }, () => rng.pick(atomIds));
        const bonds = Array.from({ length: rng.int(4) }, () => rng.pick(bondIds));
        const superatoms = rng.next() < 0.4
          ? [{ label: "R", attachmentPoints: [{ kind: "atom", ...randomReference(rng) }], warnings: [] }]
          : [];
        return molecule(id, atoms, bonds, { superatoms } as Partial<MoleculeObject>);
      }
      if (kind < 9) return mark(id, { kind: "atom", ...randomReference(rng) });
      return { id, type: "reaction", x: 0, y: 0, width: 0, height: 0, rotation: 0, style: {},
        components: [{ role: "reactant", ...randomReference(rng) }], conditionsTextObjectIds: [], mappingState: "unknown" } as unknown as DocumentObject;
    });
    const crossings = Array.from({ length: rng.int(3) }, () => ({
      bonds: [randomReference(rng), randomReference(rng)], front: randomReference(rng)
    }));
    return { objects, crossings };
  });
  return documentOf(pages);
}

describe("duplicate-id repair matches the first version exactly", () => {
  it("on many random documents with repeated ids, occupied suffixes and qualified references", () => {
    let renamed = 0;
    for (let seed = 1; seed <= 1500; seed += 1) {
      const expected = randomDocument(seed);
      const actual = structuredClone(expected);
      const expectedRenumbering = quadraticReference(expected);
      const actualRenumbering = renumberDuplicateIds(actual);
      expect(actualRenumbering, `seed ${seed}`).toEqual(expectedRenumbering);
      expect(actual, `seed ${seed}`).toEqual(expected);
      renamed += actualRenumbering.length;
    }
    // The generator really exercises the repair.
    expect(renamed).toBeGreaterThan(1500);
  });
});

/**
 * Counts the primitive steps the repair takes: Set and Map lookups and writes, every array
 * iteration step (for-of, spread), elements visited by array callbacks, and own values read by
 * Object.values / Object.entries.
 */
function countOperations(run: () => void): number {
  let count = 0;
  const restores: (() => void)[] = [];
  const wrap = (target: object, key: string, cost: (self: unknown, args: unknown[], result: unknown) => number) => {
    const holder = target as Record<string, unknown>;
    const original = holder[key] as (...args: unknown[]) => unknown;
    holder[key] = function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args);
      count += cost(this, args, result);
      return result;
    };
    restores.push(() => { holder[key] = original; });
  };
  const one = () => 1;
  const length = (self: unknown) => (self as unknown[]).length;
  const resultLength = (_self: unknown, _args: unknown[], result: unknown) => (result as unknown[]).length;
  for (const key of ["has", "add"]) wrap(Set.prototype, key, one);
  for (const key of ["has", "get", "set"]) wrap(Map.prototype, key, one);
  for (const key of ["some", "filter", "map", "forEach", "every", "find"]) wrap(Array.prototype, key, length);
  wrap(Object.getPrototypeOf([][Symbol.iterator]()) as object, "next", one);
  wrap(Object, "values", resultLength);
  wrap(Object, "entries", resultLength);
  try {
    run();
  } finally {
    for (let index = restores.length - 1; index >= 0; index -= 1) restores[index]!();
  }
  return count;
}

/**
 * A document of size proportional to n, built to make each old quadratic path bite:
 * - n copies of one object id "x", whose suffixes x_2 … x_{n+1} are all already taken;
 * - n references to "x", each naming an atom only one copy holds, and n crossings naming bonds;
 * - one molecule repeating atom id "q" n times, with q_2 … q_{n+1} taken.
 */
function stressDocument(n: number): ChemDraftDocument {
  const objects: DocumentObject[] = [];
  for (let index = 2; index <= n + 1; index += 1) objects.push(mark(`x_${index}`, { kind: "free" }));
  objects.push(molecule("x", ["shared"], ["shared_bond"]));
  for (let index = 0; index < n; index += 1) objects.push(molecule("x", [`atom${index}`, "shared"], [`bond${index}`]));
  for (let index = 0; index < n; index += 1) objects.push(mark(`mark${index}`, { kind: "atom", objectId: "x", atomId: `atom${index}` }));
  const atoms = [...Array.from({ length: n }, () => "q"), ...Array.from({ length: n }, (_, index) => `q_${index + 2}`)];
  objects.push(molecule("qs", atoms, []));
  const crossings = Array.from({ length: n }, (_, index) => ({
    bonds: [{ objectId: "x", bondId: `bond${index}` }, { objectId: "x", bondId: "shared_bond" }],
    front: { objectId: "x", bondId: `bond${index}` }
  }));
  return documentOf([{ objects, crossings }]);
}

describe("duplicate-id repair is linear in document size", () => {
  const n = 150;
  const growth = (repair: (document: ChemDraftDocument) => unknown) => {
    const small = stressDocument(n);
    const large = stressDocument(2 * n);
    return countOperations(() => repair(large)) / countOperations(() => repair(small));
  };

  it("doubles its work, no more, when the document doubles", () => {
    // Sanity of the fixture: it is repaired, and the references follow their copies.
    const document = stressDocument(4);
    const renumbering = renumberDuplicateIds(document);
    expect(renumbering.filter((entry) => entry.kind === "object").map((entry) => entry.to)).toEqual(["x_6", "x_7", "x_8", "x_9"]);
    expect(renumbering.filter((entry) => entry.kind === "atom").map((entry) => entry.to)).toEqual(["q_6", "q_7", "q_8"]);
    const marks = document.pages[0]!.objects.filter((object) => object.id.startsWith("mark"));
    expect(marks.map((object) => (object as { anchor: { objectId: string } }).anchor.objectId)).toEqual(["x_6", "x_7", "x_8", "x_9"]);
    expect(document.pages[0]!.crossings.map((crossing) => crossing.front.objectId)).toEqual(["x_6", "x_7", "x_8", "x_9"]);

    expect(growth(renumberDuplicateIds)).toBeLessThan(2.3);
  });

  it("the counter does catch quadratic work: the first version more than triples", () => {
    expect(growth(quadraticReference)).toBeGreaterThan(3);
  });
});
