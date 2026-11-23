import { afterEach, describe, expect, it, vi } from "vitest";
import { admitParsedDocument, createEmptyDocument, serializeDocument, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import { moleculeSmiles } from "@chemdraft/document-workflow-core";
import type { ExportWarning } from "@chemdraft/export-engine";
import * as workflow from "./documentWorkflow";

// A lone hydrogen atom is ONE hydrogen atom, a radical (owner decision 2026-11-23): H•, formula H,
// SMILES [H]. Documents saved before that decision cache the H2 reading RDKit gave the old molfile
// ("[HH]", formula H2, mass ~2.016). Opening or restoring such a document re-derives that molecule's
// cached chemistry, so the formula the app shows agrees with the H• the canvas draws.
describe("opening a document whose lone H carries the old H2 cache", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const atom = (id: string, element: string, x = 0): MoleculeAtom => ({ id, element, x, y: 0, formalCharge: 0 });
  const molecule = (id: string, atoms: MoleculeAtom[], structure: string, formula: string, bonds: MoleculeObject["bonds"] = []): MoleculeObject => ({
    id, type: "molecule", x: 0, y: 0, width: 20, height: 20, rotation: 0, style: {},
    structureFormat: "smiles", structure, superatoms: [], rGroups: [], atoms, bonds,
    chemistry: {
      formula, averageMass: 2.016, exactMass: 2.01565, atomCount: atoms.length, bondCount: bonds.length,
      totalCharge: 0, radicalCount: 0, isotopeLabels: [], stereochemistry: [], warnings: []
    }
  });
  function opened(objects: MoleculeObject[]) {
    const base = createEmptyDocument();
    const document = { ...base, pages: [{ ...base.pages[0]!, objects }] };
    const read = workflow.openNativeDocument(serializeDocument(document)).document!;
    // What File > Open and session restore commit (MainWindow `resetDocumentHistory`, restore).
    return workflow.normalizeCommittedDocument(admitParsedDocument(read), { preserveElectronMarks: true });
  }

  it("re-derives the lone H's structure, formula and masses as H•", async () => {
    const result = opened([molecule("lone", [atom("h", "H")], "[HH]", "H2")]);
    const lone = result.pages[0]!.objects.find((object): object is MoleculeObject => object.id === "lone")!;
    expect(lone.structure).toBe("[H]");
    expect(lone.chemistry?.formula).toBe("H");
    expect(lone.chemistry?.averageMass).toBeCloseTo(1.008, 3);
    expect(lone.chemistry?.exactMass).toBeCloseTo(1.00783, 4);
    const warnings: ExportWarning[] = [];
    expect(await moleculeSmiles(lone, 0, warnings, undefined)).toBe("[H]");
    // Idempotent: a second open normalization changes nothing.
    expect(workflow.normalizeCommittedDocument(result, { preserveElectronMarks: true })).toBe(result);
  });

  it("leaves every molecule without an implied radical exactly as stored", () => {
    // Deliberately inconsistent caches: if open recomputed them, they would change.
    const methane = molecule("methane", [atom("c", "C")], "C-stored", "CH4-stored");
    // A dative-only H has no implied radical (e7ef3bc68); its stored data is not touched either.
    const dative = molecule("dative", [atom("h", "H"), atom("fe", "Fe", 14)], "dative-stored", "FeH-stored",
      [{ id: "b", fromAtomId: "h", toAtomId: "fe", order: "single", display: { bondStyle: "dashed" } }]);
    const typed = molecule("typed", [{ ...atom("h", "H"), labelLiteral: true }], "typed-stored", "H-stored");
    const read = workflow.openNativeDocument(serializeDocument((() => {
      const base = createEmptyDocument();
      return { ...base, pages: [{ ...base.pages[0]!, objects: [methane, dative, typed] }] };
    })())).document!;
    const before = read.pages[0]!.objects.map((object) => structuredClone(object));
    const result = opened([methane, dative, typed]);
    for (const object of before) {
      expect(result.pages[0]!.objects.find((candidate) => candidate.id === object.id)).toEqual(object);
    }
  });
  it("a throwing recompute for one molecule leaves it as stored, logs its id, and opens the rest refreshed", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stale = molecule("stale", [atom("h", "H")], "[HH]", "H2");
    const poisoned = molecule("poisoned", [atom("h", "H")], "[HH]-stored", "H2-stored");
    // Iterating this bond list throws once, as the recompute (`[...bonds]`) would on an unusual
    // molecule; the rest of normalization, which runs after the recompute, iterates it normally.
    const iterate = Array.prototype[Symbol.iterator];
    let thrown = 0;
    Object.defineProperty(poisoned.bonds, Symbol.iterator, {
      value(this: unknown[]) {
        if (thrown++ === 0) throw new Error("recompute boom");
        return iterate.call(this);
      }
    });
    const base = createEmptyDocument();
    const document = admitParsedDocument({ ...base, pages: [{ ...base.pages[0]!, objects: [poisoned, stale] }] });
    const result = workflow.normalizeCommittedDocument(document, { preserveElectronMarks: true });
    const get = (id: string) => result.pages[0]!.objects.find((object): object is MoleculeObject => object.id === id)!;
    // The molecule that threw keeps its stored chemistry untouched (same object, no silent change).
    expect(get("poisoned")).toBe(poisoned);
    expect(get("poisoned").structure).toBe("[HH]-stored");
    expect(get("poisoned").chemistry?.formula).toBe("H2-stored");
    // The other molecule is still refreshed to H•.
    expect(get("stale").structure).toBe("[H]");
    expect(get("stale").chemistry?.formula).toBe("H");
    expect(thrown).toBeGreaterThan(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain("poisoned");
  });
});
