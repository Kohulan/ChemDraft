import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import { ProposedDocumentPatchSchema } from "@chemdraft/plugin-api";
import { rebasePluginPatch } from "@chemdraft/plugin-host";
import { normalizeCommittedDocument } from "../documentWorkflow";
import { applyAcceptedPluginProposal, applyPluginDocumentPatch, refreshPluginPatchChemistry } from "./applyPluginDocumentPatch";

// A recompute that throws, for the fail-safe: the native metadata derivation throws for any graph
// holding the atom id "poison-h". Every other graph is derived by the real implementation.
vi.mock("@chemdraft/document-workflow-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chemdraft/document-workflow-core")>();
  return {
    ...actual,
    nativeSingleBondGraphMetadata: (...args: Parameters<typeof actual.nativeSingleBondGraphMetadata>) => {
      if (args[0].some((atom) => atom.id === "poison-h")) throw new Error("recompute boom");
      return actual.nativeSingleBondGraphMetadata(...args);
    }
  };
});

// A plugin's documents.applyPatch (and an accepted proposal) can insert a molecule object copied from
// a document saved before the H• reading (owner decision 2026-11-23), carrying the old H2 cache. The
// insert re-derives that molecule's cached chemistry before it is verified and committed, in the
// write's one history entry, so the app never shows H2 for a lone H.
describe("a plugin inserting a lone H that carries the old H2 cache", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const atom = (id: string, element: string, x = 300): MoleculeAtom => ({ id, element, x, y: 300, formalCharge: 0 });
  const molecule = (id: string, atoms: MoleculeAtom[], structure: string, formula: string, x = 290): MoleculeObject => ({
    id, type: "molecule", x, y: 290, width: 20, height: 20, rotation: 0, style: {},
    structureFormat: "smiles", structure, superatoms: [], rGroups: [], atoms, bonds: [],
    chemistry: {
      formula, averageMass: 2.016, exactMass: 2.01565, atomCount: atoms.length, bondCount: 0,
      totalCharge: 0, radicalCount: 0, isotopeLabels: [], stereochemistry: [], warnings: []
    }
  });
  const insert = (pageId: string, objects: MoleculeObject[]) => ProposedDocumentPatchSchema.parse({
    reason: "Insert structure", patch: { op: "batch", patches: objects.map((object) => ({ op: "addObject", pageId, object })) }
  });
  const molecules = (document: ReturnType<typeof createEmptyDocument>) =>
    document.pages[0]!.objects.filter((object): object is MoleculeObject => object.type === "molecule");

  it("re-derives the inserted lone H as H• (formula H, radicalCount 1), selected, with nothing else changed", async () => {
    const before = createEmptyDocument();
    const stale = molecule("lone", [atom("h", "H")], "[HH]", "H2");
    const patch = insert(before.pages[0]!.id, [stale]);
    const { document, receipt } = applyPluginDocumentPatch(before, patch);
    const [lone] = molecules(document);
    expect(lone!.structure).toBe("[H]");
    expect(lone!.chemistry?.formula).toBe("H");
    expect(lone!.chemistry?.radicalCount).toBe(1);
    expect(lone!.atoms).toEqual(stale.atoms);
    expect([lone!.x, lone!.y]).toEqual([stale.x, stale.y]);
    expect(receipt.objectIds).toEqual(["lone"]);
    expect(document.selection.objectIds).toEqual(["lone"]);
    // The commit's own verification accepts it as the native derivation it now is: no further
    // refresh (and no RDKit inspection) is needed, so the write commits as authored, once.
    const normalized = normalizeCommittedDocument(document);
    expect(molecules(normalized)[0]!.chemistry?.formula).toBe("H");
    expect(refreshPluginPatchChemistry(before, normalized, rebasePluginPatch(before, patch))).toBeUndefined();
  });

  it("re-derives a lone H the user accepts from a proposal the same way", () => {
    const before = createEmptyDocument();
    const { document } = applyAcceptedPluginProposal(before, insert(before.pages[0]!.id, [molecule("lone", [atom("h", "H")], "[HH]", "H2")]));
    expect(molecules(document)[0]!.chemistry?.formula).toBe("H");
    expect(molecules(document)[0]!.chemistry?.radicalCount).toBe(1);
  });

  it("inserts molecules without a lone H exactly as authored, and leaves resident molecules alone", () => {
    const base = createEmptyDocument();
    // A stale lone H already on the page: not part of this write, so not re-derived by it.
    const resident = molecule("resident", [atom("r", "H", 100)], "[HH]", "H2", 90);
    const before = { ...base, pages: [{ ...base.pages[0]!, objects: [resident] }] };
    const methane = molecule("methane", [atom("c", "C")], "C-stored", "CH4-stored");
    const typed = molecule("typed", [{ ...atom("t", "H", 340), labelLiteral: true }], "typed-stored", "H-stored", 330);
    const { document } = applyPluginDocumentPatch(before, insert(before.pages[0]!.id, [methane, typed]));
    const [keptResident, insertedMethane, insertedTyped] = molecules(document);
    expect(keptResident).toEqual(resident);
    expect(insertedMethane).toEqual(methane);
    expect(insertedTyped).toEqual(typed);
    expect(document.selection.objectIds).toEqual(["methane", "typed"]);
  });

  it("keeps an inserted molecule whose recompute throws exactly as authored, logs it, and completes the insert", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = createEmptyDocument();
    const poisoned = molecule("poisoned", [atom("poison-h", "H")], "[HH]-stored", "H2-stored");
    const stale = molecule("stale", [atom("h", "H", 360)], "[HH]", "H2", 350);
    const { document, receipt } = applyPluginDocumentPatch(before, insert(before.pages[0]!.id, [poisoned, stale]));
    const [insertedPoisoned, insertedStale] = molecules(document);
    expect(insertedPoisoned).toEqual(poisoned);
    expect(insertedStale!.chemistry?.formula).toBe("H");
    expect(receipt.objectIds).toEqual(["poisoned", "stale"]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain("poisoned");
    expect(String(error.mock.calls[0]![0])).toContain("on plugin insert");
  });
});
