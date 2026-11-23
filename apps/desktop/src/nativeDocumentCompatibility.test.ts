import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPatch, applyPatches, createEmptyDocument, readSerializedDocument, serializeDocument } from "@chemdraft/chem-core";
import { createNativeSavePayload, normalizeCommittedDocument, openNativeDocument } from "./documentWorkflow";
import { notifyNativeDocumentCompatibility } from "./nativeDocumentNotice";
import { nativePromptButtons, setNativePromptProvider, type NativePromptOptions } from "./nativePrompt";

function futureFile() {
  return JSON.stringify({ ...createEmptyDocument(), formatVersion: "1.10.0", minAppVersion: "1.10.2",
    conditionsLabel: { text: "future conditions" }, styles: { drawing: { stylePresetId: "future-preset" } } });
}

afterEach(() => vi.restoreAllMocks());

describe("native document compatibility notice", () => {
  it.each(["macos", "windows"] as const)("shows one document-owned notice with the file minimum on %s", async platform => {
    const prompt = vi.fn(async (_options: NativePromptOptions) => "ok");
    const restore = setNativePromptProvider(prompt);
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const opened = openNativeDocument(futureFile());
      expect(opened.warnings).toHaveLength(2);
      await notifyNativeDocumentCompatibility(opened, opened.document!, platform);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(prompt.mock.calls[0]![0]).toMatchObject({ owner: "document", kind: "warning",
        message: "This file was made with a newer ChemDraft (1.10.2). Some features may not show. Update to keep them." });
      expect(nativePromptButtons(prompt.mock.calls[0]![0], platform)).toEqual({ ok: "OK" });
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls.map(call => call[1])).toEqual(opened.warnings);
    } finally { restore(); }
  });

  it.each([undefined, "1.1.1", "1.2.0"])("does not notify for minimum %s", async minAppVersion => {
    const prompt = vi.fn(async () => "ok");
    const restore = setNativePromptProvider(prompt);
    try {
      const opened = openNativeDocument(JSON.stringify({ ...createEmptyDocument(), ...(minAppVersion ? { minAppVersion } : {}) }));
      await notifyNativeDocumentCompatibility(opened, opened.document!);
      expect(prompt).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it("reopens its own staged SRU deletion without a notice and lowers the minimum when only 1.2.0 metadata remains", async () => {
    const imported = openNativeDocument(`<CDXML><page id="1">
      <fragment id="10"><n id="11" Element="6" p="100 140"/><n id="12" Element="6" p="130 140"/>
        <b id="13" B="11" E="12" Order="1"/></fragment>
      <graphic id="20" GraphicType="Bracket" BracketType="Round" BoundingBox="85 120 90 160"/>
      <graphic id="21" GraphicType="Bracket" BracketType="Round" BoundingBox="145 120 150 160"/>
      <bracketedgroup id="30" BracketedObjectIDs="11 12" BracketUsage="SRU">
        <bracketattachment id="31" GraphicID="20"/><bracketattachment id="33" GraphicID="21"/>
      </bracketedgroup></page></CDXML>`).document!;
    const molecule = imported.pages[0].objects.find(object => object.type === "molecule")!;
    const staged = applyPatch(imported, { op: "updateObject", objectId: molecule.id, changes: { atoms: molecule.atoms.slice(1), bonds: [] } });
    const reopened = openNativeDocument(createNativeSavePayload(staged).contents);
    const document = reopened.document!;
    expect(document.minAppVersion).toBe("1.2.1");
    const glyphs = document.pages[0].objects.filter(object => object.type === "bracket");
    expect(glyphs).toHaveLength(2);
    for (const glyph of glyphs) expect(glyph.compatibility?.unknown.cdxmlBracketDeletedAtoms).toEqual([["11", molecule.atoms[0].id]]);
    const present = vi.fn(async () => "ok");
    await notifyNativeDocumentCompatibility(reopened, document, "macos", present);
    expect(present).not.toHaveBeenCalled();

    const withoutDeletionProof = applyPatches(document, glyphs.map(glyph => {
      const { cdxmlBracketDeletedAtoms: _proof, ...unknown } = glyph.compatibility!.unknown;
      return { op: "updateObject", objectId: glyph.id, changes: { compatibility: { ...glyph.compatibility!, unknown } } };
    }));
    expect(openNativeDocument(createNativeSavePayload(withoutDeletionProof).contents).document?.minAppVersion).toBe("1.2.0");
  });

  it("notifies for a newer minimum even without any fallback warnings", async () => {
    const prompt = vi.fn(async () => "ok");
    const restore = setNativePromptProvider(prompt);
    try {
      const opened = openNativeDocument(JSON.stringify({ ...createEmptyDocument(), minAppVersion: "1.3.0" }));
      expect(opened.warnings).toEqual([]);
      await notifyNativeDocumentCompatibility(opened, opened.document!);
      expect(prompt).toHaveBeenCalledTimes(1);
    } finally { restore(); }
  });

  it.each(["macos", "windows"] as const)("notifies for a format-only newer file on %s", async platform => {
    const prompt = vi.fn(async (_options: NativePromptOptions) => "ok");
    const restore = setNativePromptProvider(prompt);
    try {
      const opened = openNativeDocument(JSON.stringify({ ...createEmptyDocument(), formatVersion: "1.3.0" }));
      expect(opened.warnings).toEqual([]);
      await notifyNativeDocumentCompatibility(opened, opened.document!, platform);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(prompt.mock.calls[0]![0]).toMatchObject({ owner: "document",
        message: "This file was made with a newer ChemDraft (1.3.0). Some features may not show. Update to keep them." });
    } finally { restore(); }
  });

  it.each(["macos", "windows"] as const)("opens a self-described 1.3 atom display field, notifies and saves it on %s", async platform => {
    const prompt = vi.fn(async (_options: NativePromptOptions) => "ok");
    const restore = setNativePromptProvider(prompt);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const raw = JSON.parse(serializeDocument(createEmptyDocument()));
      Object.assign(raw, { formatVersion: "1.3.0", minAppVersion: "1.3.0",
        ignorableFields: ["pages.*.objects.*[type=molecule].atoms.*.labelHalo"] });
      raw.pages[0].objects.push({ id: "m", type: "molecule", x: 0, y: 0, width: 30, height: 30,
        rotation: 0, style: {}, structureFormat: "smiles", structure: "C", superatoms: [], rGroups: [], bonds: [],
        atoms: [{ id: "c", element: "C", x: 0, y: 0, formalCharge: 0, labelHalo: { color: "blue" } }] });
      const opened = openNativeDocument(JSON.stringify(raw));
      expect(opened.document).toBeDefined();
      expect(opened.warnings).toEqual([expect.objectContaining({ code: "NATIVE_UNKNOWN_FIELD_PRESERVED" })]);
      await notifyNativeDocumentCompatibility(opened, opened.document!, platform);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(prompt.mock.calls[0]![0]).toMatchObject({ owner: "document",
        message: "This file was made with a newer ChemDraft (1.3.0). Some features may not show. Update to keep them." });
      const reopened = openNativeDocument(createNativeSavePayload(opened.document!).contents);
      const saved = JSON.parse(serializeDocument(reopened.document!));
      expect(saved.ignorableFields).toEqual(raw.ignorableFields);
      expect(saved.pages[0].objects[0].atoms[0].labelHalo).toEqual({ color: "blue" });
    } finally { restore(); }
  });

  // (1.1.1) -> (1.3.0): the newer format triggered this notice, so a compatible minimum is misleading.
  it.each(["1.1.1", "1.2.0"])("names the triggering format when minimum %s is compatible", async minAppVersion => {
    const prompt = vi.fn(async (_options: NativePromptOptions) => "ok");
    const restore = setNativePromptProvider(prompt);
    try {
      const opened = openNativeDocument(JSON.stringify({ ...createEmptyDocument(), formatVersion: "1.3.0", minAppVersion }));
      await notifyNativeDocumentCompatibility(opened, opened.document!);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(prompt.mock.calls[0]![0].message).toContain("(1.3.0)");
    } finally { restore(); }
  });

  it.each([
    ["1.2.0", "1.3.1", "1.3.1"], // minimum only
    ["1.4.0", "1.3.1", "1.3.1"]  // both newer: retain the required app version
  ])("names a newer minimum with format %s and minimum %s", async (formatVersion, minAppVersion, version) => {
    const opened = openNativeDocument(JSON.stringify({ ...createEmptyDocument(), formatVersion, minAppVersion }));
    const present = vi.fn(async (_notice: NativePromptOptions) => "ok");
    await notifyNativeDocumentCompatibility(opened, opened.document!, "macos", present);
    expect(present).toHaveBeenCalledTimes(1);
    expect(present.mock.calls[0]![0].message).toBe(
      `This file was made with a newer ChemDraft (${version}). Some features may not show. Update to keep them.`);
  });

  it("logs legacy visual fallback warnings without adding a newer-file notice", async () => {
    const prompt = vi.fn(async () => "ok");
    const restore = setNativePromptProvider(prompt);
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const raw = JSON.parse(serializeDocument(createEmptyDocument()));
      raw.pages[0].objects.push({ id: "bracket", type: "bracket", x: 0, y: 0, width: 30, height: 30,
        rotation: 0, style: {}, bracketKind: "future", containedObjectIds: [] });
      const opened = openNativeDocument(JSON.stringify(raw));
      await notifyNativeDocumentCompatibility(opened, opened.document!);
      expect(log).toHaveBeenCalledWith("Native document compatibility", expect.objectContaining({ code: "NATIVE_VISUAL_ENUM_FALLBACK" }));
      expect(prompt).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it("does not notify for edited visible CDXML when its future embedded document was not chosen", async () => {
    const prompt = vi.fn(async () => "ok");
    const restore = setNativePromptProvider(prompt);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await notifyNativeDocumentCompatibility(openNativeDocument(futureFile()), createEmptyDocument());
      expect(prompt).not.toHaveBeenCalled();
    } finally { restore(); }
  });
});

it("retains future content and its minimum through app normalization, edits, Save and session serialization", () => {
  const future = JSON.parse(futureFile());
  future.pages[0].objects.push({
    id: "m", type: "molecule", x: 0, y: 0, width: 30, height: 30, rotation: 0,
    style: {}, structureFormat: "smiles", structure: "CO", superatoms: [], rGroups: [],
    atoms: [{ id: "c", element: "C", x: 0, y: 0, formalCharge: 0 },
      { id: "o", element: "O", x: 22, y: 0, formalCharge: 0 }],
    bonds: [{ id: "b", fromAtomId: "c", toAtomId: "o", order: "single", display: { bondStyle: "future-wavy" } }]
  });
  const opened = openNativeDocument(JSON.stringify(future)).document!;
  const normalized = normalizeCommittedDocument(opened);
  const edited = applyPatch(normalized, { op: "setSelection", objectIds: [] });
  const session = readSerializedDocument(serializeDocument(edited)).document;
  const saved = createNativeSavePayload(session);
  const reopened = openNativeDocument(saved.contents);
  expect(reopened.nativeDocumentVersions?.minAppVersion).toBe("1.10.2");
  const raw = JSON.parse(serializeDocument(reopened.document!));
  expect(raw.conditionsLabel).toEqual({ text: "future conditions" });
  expect(raw.styles.drawing.stylePresetId).toBe("future-preset");
  expect(raw.pages[0].objects[0].bonds[0].display.bondStyle).toBe("future-wavy");
  expect(raw.pages[0].objects[0].atoms.map((atom: { element: string }) => atom.element)).toEqual(["C", "O"]);
  expect(raw.minAppVersion).toBe("1.10.2");
  expect(raw.compatibility.nativeExtensions).toBeUndefined();
});
