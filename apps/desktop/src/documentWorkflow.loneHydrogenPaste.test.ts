import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitParsedDocument, applyPatch, createDocumentHistory, createEmptyDocument, undo,
  type ChemDraftDocument, type MoleculeAtom, type MoleculeObject
} from "@chemdraft/chem-core";
import * as workflow from "./documentWorkflow";

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

// A lone H is H• (formula H, SMILES [H], one radical; owner decision 2026-11-23). A ChemDraft
// clipboard payload copied from a document saved before that reading carries the old H2 cache
// ("[HH]", formula H2, radicalCount 0). Pasting it re-derives that molecule's cached chemistry as
// part of the paste itself, so the inspector and formula labels never show H2 for a lone H.
describe("pasting a native ChemDraft payload whose lone H carries the old H2 cache", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const atom = (id: string, element: string, x = 100): MoleculeAtom => ({ id, element, x, y: 100, formalCharge: 0 });
  const molecule = (id: string, atoms: MoleculeAtom[], structure: string, formula: string, x = 90): MoleculeObject => ({
    id, type: "molecule", x, y: 90, width: 20, height: 20, rotation: 0, style: {},
    structureFormat: "smiles", structure, superatoms: [], rGroups: [], atoms, bonds: [],
    chemistry: {
      formula, averageMass: 2.016, exactMass: 2.01565, atomCount: atoms.length, bondCount: 0,
      totalCharge: 0, radicalCount: 0, isotopeLabels: [], stereochemistry: [], warnings: []
    }
  });
  /** The payload Copy writes from a document holding `objects`, all selected. */
  function copied(objects: MoleculeObject[]) {
    const base = createEmptyDocument();
    let source: ChemDraftDocument = admitParsedDocument({ ...base, pages: [{ ...base.pages[0]!, objects }] });
    source = applyPatch(source, { op: "setSelection", pageId: source.pages[0]!.id, objectIds: objects.map((object) => object.id) });
    return workflow.createSelectionClipboardPayload(source)!;
  }
  const target = () => admitParsedDocument(createEmptyDocument());
  const pastedMolecules = (document: ChemDraftDocument) =>
    document.pages[0]!.objects.filter((object): object is MoleculeObject => object.type === "molecule");

  it("shows the pasted lone H as H• (formula H, radicalCount 1) in the paste's one undo entry, still selected", () => {
    const stale = molecule("lone", [atom("h", "H")], "[HH]", "H2");
    const payload = copied([stale]);
    const before = target();
    const pasted = workflow.pasteSelectionClipboardPayload(before, payload, { x: payload.bounds.centerX, y: payload.bounds.centerY });
    const [lone] = pastedMolecules(pasted);
    expect(lone!.structure).toBe("[H]");
    expect(lone!.chemistry?.formula).toBe("H");
    expect(lone!.chemistry?.radicalCount).toBe(1);
    expect(lone!.chemistry?.averageMass).toBeCloseTo(1.008, 3);
    // Atoms, bonds and coordinates are exactly as copied; only the cached chemistry is re-derived.
    expect(lone!.atoms).toEqual(stale.atoms);
    expect(lone!.bonds).toEqual(stale.bonds);
    expect([lone!.x, lone!.y, lone!.width, lone!.height]).toEqual([stale.x, stale.y, stale.width, stale.height]);
    // The pasted object stays selected, as every paste leaves it.
    expect(pasted.selection.objectIds).toEqual([lone!.id]);

    // MainWindow's paste commit (`commitClipboardPaste`): place, then ONE commit through commit
    // normalization. That normalization keeps the re-derived values (no second step, no extra entry).
    const placed = workflow.translateInsertedDocumentObjects(pasted, [lone!.id], 40, 0);
    const committed = workflow.normalizeCommittedDocument(placed);
    const committedLone = pastedMolecules(committed)[0]!;
    expect(committedLone.chemistry?.formula).toBe("H");
    expect(committedLone.chemistry?.radicalCount).toBe(1);
    expect(committed.selection.objectIds).toEqual([lone!.id]);
    const history = { ...createDocumentHistory(before), past: [before], present: committed };
    expect(history.past).toHaveLength(1);
    expect(undo(history).present).toBe(before);
  });

  it("pastes a molecule without a lone H byte-identically, its cached chemistry untouched", () => {
    // Deliberately inconsistent caches: a recompute would change them.
    const methane = molecule("methane", [atom("c", "C")], "C-stored", "CH4-stored");
    const typed = molecule("typed", [{ ...atom("t", "H", 140), labelLiteral: true }], "typed-stored", "H-stored", 130);
    const stale = molecule("lone", [atom("h", "H", 180)], "[HH]", "H2", 170);
    const payload = copied([methane, typed, stale]);
    const pasted = workflow.pasteSelectionClipboardPayload(target(), payload, { x: payload.bounds.centerX, y: payload.bounds.centerY });
    const [pastedMethane, pastedTyped, pastedLone] = pastedMolecules(pasted);
    // Pasted at the payload's own centre: everything but the reminted id is the copied object.
    expect({ ...pastedMethane!, id: methane.id }).toEqual(methane);
    expect({ ...pastedTyped!, id: typed.id }).toEqual(typed);
    expect(pastedLone!.chemistry?.formula).toBe("H");
    expect(pasted.selection.objectIds).toEqual([pastedMethane!.id, pastedTyped!.id, pastedLone!.id]);
  });

  it("does not touch the molecules already on the page", () => {
    // A stale lone H already in the target (never re-derived by this paste: only what it brings in).
    const resident = molecule("resident", [atom("r", "H", 300)], "[HH]", "H2", 290);
    const base = createEmptyDocument();
    const before = admitParsedDocument({ ...base, pages: [{ ...base.pages[0]!, objects: [resident] }] });
    const payload = copied([molecule("lone", [atom("h", "H")], "[HH]", "H2")]);
    const pasted = workflow.pasteSelectionClipboardPayload(before, payload, { x: payload.bounds.centerX, y: payload.bounds.centerY });
    expect(pasted.pages[0]!.objects[0]).toBe(before.pages[0]!.objects[0]);
    expect(pastedMolecules(pasted)[1]!.chemistry?.formula).toBe("H");
  });

  it("keeps a molecule whose recompute throws exactly as copied, logs it, and still completes the paste", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const poisoned = molecule("poisoned", [atom("poison-h", "H")], "[HH]-stored", "H2-stored");
    const stale = molecule("stale", [atom("h", "H", 180)], "[HH]", "H2", 170);
    const payload = copied([poisoned, stale]);
    const pasted = workflow.pasteSelectionClipboardPayload(target(), payload, { x: payload.bounds.centerX, y: payload.bounds.centerY });
    const [pastedPoisoned, pastedStale] = pastedMolecules(pasted);
    expect({ ...pastedPoisoned!, id: poisoned.id }).toEqual(poisoned);
    expect(pastedStale!.chemistry?.formula).toBe("H");
    expect(pasted.selection.objectIds).toEqual([pastedPoisoned!.id, pastedStale!.id]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain(pastedPoisoned!.id);
    expect(String(error.mock.calls[0]![0])).toContain("on paste");
  });
});
