/**
 * Atom maps have no native field yet. Every write that puts a structure with a mapped stored source
 * into an open document says so once: a MOL/RXN paste, a paste of copied ChemDraft objects, and a
 * plugin insert. An unmapped write's status is unchanged.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPatch, applyPatches, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { ProposedDocumentPatchSchema } from "@chemdraft/plugin-api";
import { inspectClipboardPayload } from "@chemdraft/clipboard-adapter";
import { ATOM_MAPS_WRITE_REFUSAL_REASON } from "@chemdraft/document-workflow-core";
import { rebasePluginPatch } from "@chemdraft/plugin-host";
import {
  applyClipboardPastePayload, createPhase4Document, createSelectionClipboardPayload, normalizeCommittedDocument, openNativeDocument,
  pasteSelectionClipboardPayload
} from "./documentWorkflow";
import { applyAcceptedPluginProposal, applyPluginDocumentPatch, rebaseProposedInsertion, refreshPluginPatchChemistry } from "./plugins/applyPluginDocumentPatch";
import { verifyDesktopRequestWrite } from "./plugins/requestWrites/normalizedWrite";

const notice = "atom-map numbers are not kept yet; they will be dropped on export or when the structure is edited";

function mappedDocument(): ChemDraftDocument {
  const opened = openNativeDocument(readFileSync(new URL(
    "../../../packages/fixtures/open-double-bonds/atom-mapped.chemdraft", import.meta.url), "utf8"));
  return opened.document!;
}
const firstMolecule = (document: ChemDraftDocument) =>
  document.pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule")!;
const unmappedCopy = (molecule: MoleculeObject): MoleculeObject => ({ ...molecule,
  structure: molecule.structure.split("\n").map(line =>
    /^\s+-?\d+\.\d{4}\s/.test(line) ? `${line.slice(0, 60)}  0${line.slice(63)}` : line).join("\n") });

describe("pasting copied ChemDraft objects", () => {
  function pasteSelectionOf(source: ChemDraftDocument) {
    const selected = applyPatches(source, [{ op: "setSelection", pageId: source.pages[0]!.id, objectIds: [firstMolecule(source).id] }]);
    const payload = createSelectionClipboardPayload(selected)!;
    expect(payload).toBeDefined();
    const warnings: string[] = [];
    const pasted = pasteSelectionClipboardPayload(createPhase4Document(), payload, { x: 300, y: 300 }, warnings);
    return { pasted, warnings };
  }

  it("says once that a mapped source's atom maps are not kept", () => {
    const { pasted, warnings } = pasteSelectionOf(mappedDocument());
    expect(warnings.filter(warning => warning === notice)).toHaveLength(1);
    // The clone keeps its stored source as it was.
    expect(firstMolecule(pasted).structure).toBe(firstMolecule(mappedDocument()).structure);
  });

  it("adds nothing for an unmapped structure", () => {
    const source = mappedDocument();
    const unmapped = applyPatches(source, [{ op: "updateObject", objectId: firstMolecule(source).id,
      changes: { structure: unmappedCopy(firstMolecule(source)).structure } }]);
    expect(pasteSelectionOf(unmapped).warnings.some(warning => warning.includes("atom-map"))).toBe(false);
  });
});

describe("plugin inserts", () => {
  function insert(object: MoleculeObject) {
    const document = createPhase4Document();
    return applyPluginDocumentPatch(document, ProposedDocumentPatchSchema.parse({ reason: "Insert structure",
      patch: { op: "addObject", pageId: document.pages[0]!.id, object: { ...object, id: "mol_plugin_mapped" } } }));
  }

  it("says once that an inserted structure's atom maps are not kept", () => {
    const result = insert(firstMolecule(mappedDocument()));
    expect(result.warnings).toEqual(["Atom-map numbers are not kept yet; they will be dropped on export or when the structure is edited."]);
  });

  it("adds nothing for an unmapped structure", () => {
    expect(insert(unmappedCopy(firstMolecule(mappedDocument()))).warnings).toEqual([]);
  });
});

describe("RXN paste", () => {
  const atom = (x: string, symbol: string, map: number) =>
    `${x.padStart(10)}    0.0000    0.0000 ${symbol.padEnd(3)} 0  0  0  0  0  0  0  0  0${String(map).padStart(3)}  0  0`;
  const rxn = (maps: readonly [number, number, number, number]) => [
    "$RXN", "", "  ChemDraw", "", "  1  1",
    "$MOL", "", "  ChemDraw", "", "  2  1  0  0  0  0            999 V2000",
    atom("0.0000", "C", maps[0]), atom("1.5600", "O", maps[1]), "  1  2  1  0        0", "M  END",
    "$MOL", "", "  ChemDraw", "", "  2  1  0  0  0  0            999 V2000",
    atom("0.0000", "C", maps[2]), atom("1.5600", "O", maps[3]), "  1  2  1  0        0", "M  END"
  ].join("\n");
  const paste = (text: string) => applyClipboardPastePayload(createPhase4Document(),
    inspectClipboardPayload({ types: ["text/plain"], textItems: [{ type: "text/plain", text }] }), { x: 260, y: 260 });

  it("names a mapped RXN paste in its status", () => {
    const result = paste(rxn([1, 2, 1, 2]));
    expect(result.status).toBe(`Pasted 2 editable RXN molecule blocks; ${notice}`);
  });

  it("leaves an unmapped RXN paste's status unchanged", () => {
    expect(paste(rxn([0, 0, 0, 0])).status).toBe("Pasted 2 editable RXN molecule blocks");
  });
});

// The committed paths run real chemistry verification (RDKit) before anything is written. Drawn atoms
// have no map field, so a stored source with maps never verifies: each route refuses the write and
// says that atom maps are why, instead of a generic mismatch (1.2.3 re-review, finding 4).
describe("verified plugin and assistant writes of a mapped stored source", () => {
  const mapped = () => ({ ...firstMolecule(mappedDocument()), id: "mol_plugin_mapped" });
  const insertPatch = (document: ChemDraftDocument, object: MoleculeObject) => ProposedDocumentPatchSchema.parse({
    reason: "Insert structure", patch: { op: "addObject", pageId: document.pages[0]!.id, object } });

  it.each([false, true])("refuses a plugin insert, naming atom maps (accepted proposal: %s)", async accepted => {
    const before = createPhase4Document();
    const patch = insertPatch(before, mapped());
    const applied = (accepted ? applyAcceptedPluginProposal : applyPluginDocumentPatch)(before, patch);
    const authored = accepted ? rebaseProposedInsertion(before, patch) : rebasePluginPatch(before, patch);
    const commit = refreshPluginPatchChemistry(before, normalizeCommittedDocument(applied.document), authored);
    await expect(commit).rejects.toThrow(`Plugin write refused: ${ATOM_MAPS_WRITE_REFUSAL_REASON}`);
  }, 60_000);

  it("refuses an assistant request insert whose stored source has maps, naming atom maps", async () => {
    const before = createPhase4Document();
    const object = mapped();
    const draft = applyPatch(before, { op: "addObject", pageId: before.pages[0]!.id, object });
    await expect(verifyDesktopRequestWrite(before, draft, new Set([object.id]), new Map([[object.id, "CC=CC"]]), new AbortController().signal))
      .rejects.toThrow(`Plugin write refused: ${ATOM_MAPS_WRITE_REFUSAL_REASON}`);
  }, 60_000);

  // An AAMAP= keyword is also a field the graph writer cannot check; the map refusal still wins (1.2.3 third review, finding 4).
  it("refuses an assistant request insert of a V3000 source with a positional map and AAMAP=0, naming atom maps", async () => {
    const before = createPhase4Document();
    const v3000 = ["", "  ChemDraft", "", "  0  0  0     0  0            999 V3000", "M  V30 BEGIN CTAB", "M  V30 COUNTS 4 3 0 0 0",
      "M  V30 BEGIN ATOM", "M  V30 1 C 113.627 157 0 1 AAMAP=0", "M  V30 2 C 137.875 143 0 2 AAMAP=0",
      "M  V30 3 C 162.125 157 0 3 AAMAP=0", "M  V30 4 C 186.373 143 0 4 AAMAP=0", "M  V30 END ATOM",
      "M  V30 BEGIN BOND", "M  V30 1 1 1 2", "M  V30 2 2 2 3", "M  V30 3 1 3 4", "M  V30 END BOND", "M  V30 END CTAB", "M  END"].join("\n");
    const object = { ...mapped(), structureFormat: "molfile-v3000" as const, structure: v3000 };
    const draft = applyPatch(before, { op: "addObject", pageId: before.pages[0]!.id, object });
    await expect(verifyDesktopRequestWrite(before, draft, new Set([object.id]), new Map([[object.id, "CC=CC"]]), new AbortController().signal))
      .rejects.toThrow(`Plugin write refused: ${ATOM_MAPS_WRITE_REFUSAL_REASON}`);
  }, 60_000);

  it("refuses an assistant request insert declared by a mapped SMILES, naming atom maps", async () => {
    const before = createPhase4Document();
    const object = { ...mapped(), structureFormat: "smiles" as const, structure: "[CH3:1][CH:2]=[CH:3][CH3:4]", compatibility: undefined };
    const draft = applyPatch(before, { op: "addObject", pageId: before.pages[0]!.id, object });
    await expect(verifyDesktopRequestWrite(before, draft, new Set([object.id]), new Map([[object.id, object.structure]]), new AbortController().signal))
      .rejects.toThrow(`Plugin write refused: ${ATOM_MAPS_WRITE_REFUSAL_REASON}`);
  }, 60_000);
});
