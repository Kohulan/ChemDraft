import { admitParsedDocument, applyPatch, applyPatchWithHistory, createDocumentHistory, createEmptyDocument, deserializeDocument, hasObjectIdentity, objectIdentity, parseDocument, readSerializedDocument, redo, serializeDocument, toEngineDocument,
  undo, type ChemDraftDocument, type DocumentObject, type MoleculeObject } from "@chemdraft/chem-core";
import { describe, expect, it, vi } from "vitest";
import { assertLegacyWritePages, assertPluginDocumentWriteScope, assertPluginPatchWriteScope, legacyWriteScopePages, objectInWriteScope, PluginHost,
  resolvePinnedPages, resolveScopedObject, scopedObjectPage, writePatchOps, type PluginPatchApplicationRequest } from "./index";

const now = "2026-11-21T00:00:00.000Z";
const molecule = (id: string, x: number): MoleculeObject => ({
  id, type: "molecule", x, y: 0, width: 30, height: 20, rotation: 0, style: {},
  structureFormat: "smiles", structure: "CC",
  atoms: [{ id: "a1", element: "C", x, y: 0, formalCharge: 0 }, { id: "a2", element: "C", x: x + 30, y: 0, formalCharge: 0 }],
  bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" }], superatoms: [], rGroups: []
});
const text = (id: string): DocumentObject => ({
  id, type: "text", x: 0, y: 0, width: 10, height: 10, rotation: 0, style: {}, text: "Page B", spans: []
});

/** An imported document whose id "X" names a molecule on page A and a text object on page B. */
function twoPageDocument(): ChemDraftDocument {
  const empty = createEmptyDocument({ now });
  const pageA = { ...empty.pages[0]!, id: "page-a", objects: [molecule("X", 0)] };
  const pageB = { ...empty.pages[0]!, id: "page-b", objects: [text("X")] };
  return toEngineDocument({ ...empty, pages: [pageA, pageB], selection: { pageId: "page-b", objectIds: ["X"] } });
}

function legacyHost(document: ChemDraftDocument) {
  let current = document;
  // Mirrors the desktop host: preflight, apply, then the final scope check at the history boundary.
  const applyDocumentPatch = vi.fn((request: PluginPatchApplicationRequest) => {
    const before = current;
    assertPluginPatchWriteScope(before, request.patch, request.writeScopeObjectIds, undefined, undefined, request.writeScopePages);
    const after = applyPatch(before, request.patch.patch, { now });
    assertPluginDocumentWriteScope(before, after, request.patch, request.writeScopeObjectIds, request.writeScopePages);
    current = after;
    return { applied: true as const, objectIds: [] };
  });
  const host = new PluginHost({ getActiveDocument: () => current, applyDocumentPatch });
  host.registerPlugin({ id: "org.test.pages", name: "Pages", version: "0.0.1", apiVersion: "^0.1.8", entry: "plugin.js",
    permissions: ["document.write"], contributes: { commands: [{ id: "plugin.pages.run", title: "Run" }] }
  }, { commandHandlers: { "plugin.pages.run": ctx => ctx.documents.applyPatch!({ reason: "Move the selected object", patch: {
    op: "updateObject", objectId: "X", changes: { x: 500 }
  } }) } });
  return { host, applyDocumentPatch, document: () => current };
}

describe("legacy direct writes are scoped by page and id", () => {
  it("never changes a same-id molecule on another page than the selection", async () => {
    const original = twoPageDocument();
    const f = legacyHost(original);
    await expect(f.host.invokeCommand("plugin.pages.run")).rejects.toThrow(
      `Plugin write refused: the change was not applied. The object you selected on page 2 shares its internal ID with an object on page 1, so ChemDraft can't tell which one to change safely. To edit it, make the change by hand, or copy the object and paste it as a new object, then try again.`
    );
    const refusal = await f.host.invokeCommand("plugin.pages.run").then(() => "", (error: Error) => error.message);
    expect(refusal).toContain("Plugin write refused:");
    expect(refusal).not.toMatch(/delete/i);
    expect(refusal).not.toMatch(/page-[abc]/);
    expect(f.applyDocumentPatch).not.toHaveBeenCalled();
    expect(f.document().pages[0]!.objects[0]).toEqual(original.pages[0]!.objects[0]);
  });

  it("still writes the selected object when its id is unique", async () => {
    const original = twoPageDocument();
    const unique = { ...original, pages: [original.pages[0]!, { ...original.pages[1]!, objects: [] }],
      selection: { pageId: "page-a", objectIds: ["X"] } };
    const f = legacyHost(unique);
    await expect(f.host.invokeCommand("plugin.pages.run")).resolves.toMatchObject({ applied: true });
    expect(f.document().pages[0]!.objects[0]).toMatchObject({ id: "X", x: 500 });
  });

  it("final check refuses a change to a same-id object outside the selected page", () => {
    const before = twoPageDocument();
    const proposed = { reason: "Move", warnings: [], requiresUserApproval: true as const,
      patch: { op: "updateObject" as const, objectId: "X", changes: { x: 500 } } };
    const after = applyPatch(before, proposed.patch, { now });
    expect(() => assertPluginDocumentWriteScope(before, after, proposed, ["X"], legacyWriteScopePages(before, ["X"], "page-b")))
      .toThrow('Plugin write refused: molecule "X" was changed (x), but was not selected when the command started.');
    // Bare-id scope (request-bound and table callers) keeps its existing meaning.
    expect(() => assertPluginDocumentWriteScope(before, after, proposed, ["X"])).not.toThrow();
  });
});

/** A legacy host whose command waits for `release` before writing, so the test can edit the document
 * while the command is pending, exactly as a user can while a plugin works. */
function pendingHost(document: ChemDraftDocument) {
  let current = document;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const applyDocumentPatch = vi.fn((request: PluginPatchApplicationRequest) => {
    const before = current;
    assertPluginPatchWriteScope(before, request.patch, request.writeScopeObjectIds, undefined, undefined, request.writeScopePages);
    const after = applyPatch(before, request.patch.patch, { now });
    assertPluginDocumentWriteScope(before, after, request.patch, request.writeScopeObjectIds, request.writeScopePages);
    current = after;
    return { applied: true as const, objectIds: [] };
  });
  const host = new PluginHost({ getActiveDocument: () => current, applyDocumentPatch });
  host.registerPlugin({ id: "org.test.pending", name: "Pending", version: "0.0.1", apiVersion: "^0.1.8", entry: "plugin.js",
    permissions: ["document.write"], contributes: { commands: [{ id: "plugin.pending.run", title: "Run" }] }
  }, { commandHandlers: { "plugin.pending.run": async ctx => {
    await held;
    return ctx.documents.applyPatch!({ reason: "Move the selected object", patch: { op: "updateObject", objectId: "X", changes: { x: 500 } } });
  } } });
  return { host, applyDocumentPatch, release, document: () => current, edit: (next: ChemDraftDocument) => { current = next; } };
}

/** The refusal for a pinned object that is gone from its Send-time page (deleted or moved). */
const reselect = (page: number) =>
  `Plugin write refused: the change was not applied. The object you selected on page ${page} is no longer there; reselect it and try again.`;

describe("legacy page binding follows the Send-time selection", () => {
  // 1.2.3: a pin names the selected object by its host-owned identity, so it follows a genuine move to
  // another page (1.2.2's option A refused one with the reselect message). An unrelated same-id object
  // never holds that identity, so following the object is no longer spoofable (see the Kimi cases below).
  it("writes a selected object that moved to another page while the command was pending", async () => {
    const empty = createEmptyDocument({ now });
    const pageA = { ...empty.pages[0]!, id: "page-a", objects: [] };
    const pageB = { ...empty.pages[0]!, id: "page-b", objects: [molecule("X", 0)] };
    const f = pendingHost(toEngineDocument({ ...empty, pages: [pageA, pageB], selection: { pageId: "page-b", objectIds: ["X"] } }));
    const pending = f.host.invokeCommand("plugin.pending.run");
    await Promise.resolve();
    // The user moves X from page B to page A; X is still the only object with that id.
    const current = f.document();
    f.edit({ ...current, pages: [{ ...current.pages[0]!, objects: [current.pages[1]!.objects[0]!] }, { ...current.pages[1]!, objects: [] }] });
    f.release();
    await expect(pending).resolves.toMatchObject({ applied: true });
    expect(f.applyDocumentPatch).toHaveBeenCalledTimes(1);
    expect(f.document().pages[0]!.objects[0]).toMatchObject({ id: "X", x: 500 });
    expect(f.document().pages[1]!.objects).toEqual([]);
  });

  it("writes the moved object, not a same-id object on a later page", async () => {
    const empty = createEmptyDocument({ now });
    const pageA = { ...empty.pages[0]!, id: "page-a", objects: [] };
    const pageB = { ...empty.pages[0]!, id: "page-b", objects: [molecule("X", 0)] };
    const pageC = { ...empty.pages[0]!, id: "page-c", objects: [text("X")] };
    const f = pendingHost(toEngineDocument({ ...empty, pages: [pageA, pageB, pageC], selection: { pageId: "page-b", objectIds: ["X"] } }));
    const pending = f.host.invokeCommand("plugin.pending.run");
    await Promise.resolve();
    const current = f.document();
    f.edit({ ...current, pages: [{ ...current.pages[0]!, objects: [current.pages[1]!.objects[0]!] }, { ...current.pages[1]!, objects: [] }, current.pages[2]!] });
    f.release();
    await expect(pending).resolves.toMatchObject({ applied: true });
    expect(f.document().pages[0]!.objects[0]).toMatchObject({ id: "X", x: 500 });
    expect(f.document().pages[2]!.objects).toEqual([text("X")]);
  });

  it("refuses a moved object that now sits behind a same-id object chem-core would change instead", async () => {
    // Moved from page B to page C, behind page A's unrelated "X": a bare-id op would reach page A's.
    const empty = createEmptyDocument({ now });
    const pageA = { ...empty.pages[0]!, id: "page-a", objects: [text("X")] };
    const pageB = { ...empty.pages[0]!, id: "page-b", objects: [molecule("X", 0)] };
    const pageC = { ...empty.pages[0]!, id: "page-c", objects: [] };
    const f = pendingHost(toEngineDocument({ ...empty, pages: [pageA, pageB, pageC], selection: { pageId: "page-b", objectIds: ["X"] } }));
    const pending = f.host.invokeCommand("plugin.pending.run");
    await Promise.resolve();
    const current = f.document();
    f.edit({ ...current, pages: [current.pages[0]!, { ...current.pages[1]!, objects: [] }, { ...current.pages[2]!, objects: [current.pages[1]!.objects[0]!] }] });
    const edited = f.document();
    f.release();
    await expect(pending).rejects.toThrow("The object you selected on page 3 shares its internal ID with an object on page 1");
    expect(f.document()).toBe(edited);
  });

  it("binds a Send-time selection override to the override's page, not the live selection's page", async () => {
    // Send selected page B's "X"; the live selection has since moved to page A, which also has an "X".
    const original = { ...twoPageDocument(), selection: { pageId: "page-a", objectIds: ["X"] } };
    const f = legacyHost(original);
    await expect(f.host.invokeCommand("plugin.pages.run", { writeSelection: { objectIds: ["X"], molecules: [], pageId: "page-b" } })).rejects.toThrow(
      `Plugin write refused: the change was not applied. The object you selected on page 2 shares its internal ID with an object on page 1, so ChemDraft can't tell which one to change safely. To edit it, make the change by hand, or copy the object and paste it as a new object, then try again.`
    );
    expect(f.applyDocumentPatch).not.toHaveBeenCalled();
    expect(f.document().pages[0]!.objects[0]).toEqual(original.pages[0]!.objects[0]);
  });

  it("leaves an override id out of write scope when it names objects on several pages and no page was given", async () => {
    const original = { ...twoPageDocument(), selection: { pageId: "page-a", objectIds: ["X"] } };
    const f = legacyHost(original);
    await expect(f.host.invokeCommand("plugin.pages.run", { writeSelection: { objectIds: ["X"], molecules: [] } }))
      .rejects.toThrow("X was not selected when the command started");
    expect(f.document().pages[0]!.objects[0]).toEqual(original.pages[0]!.objects[0]);
  });
});

/** Fixture F2's shape: two pages, each holding its own molecule with the same id. Page 1's is selected. */
function sharedIdDocument(): ChemDraftDocument {
  const empty = createEmptyDocument({ now });
  const page1 = { ...empty.pages[0]!, id: "page-1", objects: [molecule("X", 0)] };
  const page2 = { ...empty.pages[0]!, id: "page-2", objects: [molecule("X", 300)] };
  return toEngineDocument({ ...empty, pages: [page1, page2], selection: { pageId: "page-1", objectIds: ["X"] } });
}
const withoutPage1Object = (document: ChemDraftDocument): ChemDraftDocument =>
  ({ ...document, pages: [{ ...document.pages[0]!, objects: [] }, document.pages[1]!] });

describe("CodeRabbit PR #422: a pinned id missing from its page never reaches a same-id object elsewhere", () => {
  it("cr4656567628/cr4656567661: resolution and scope do not rebind page 1's deleted pin to page 2's object", () => {
    const sent = sharedIdDocument();
    const pins = legacyWriteScopePages(sent, ["X"], "page-1");
    const document = withoutPage1Object(sent);
    // Assistant tools resolve every id through resolveScopedObject (writeBuilder.findObject).
    expect(scopedObjectPage(document, "X", pins)).toBeUndefined();
    expect(() => resolveScopedObject(document, "X", pins)).toThrow(/no longer there/);
    // Plugin and assistant write scope both check the Send-time pin, resolved against the written document.
    expect(objectInWriteScope(new Set(["X"]), resolvePinnedPages(document, pins), "page-2", "X")).toBe(false);
  });

  it("cr4656567661: a pending command whose selected duplicate was deleted cannot write the surviving one", async () => {
    const f = pendingHost(sharedIdDocument());
    const pending = f.host.invokeCommand("plugin.pending.run");
    await Promise.resolve();
    // While the command waits, the user deletes the selected X on page 1. Page 2's X was never selected.
    f.edit(withoutPage1Object(f.document()));
    const edited = f.document();
    f.release();
    await expect(pending).rejects.toThrow(/Plugin write refused/);
    expect(f.document()).toBe(edited);
    expect(f.document().pages[1]!.objects[0]).toMatchObject({ id: "X", x: 300 });
  });
});

/** Kimi's spoof: X was the only "X" at Send. After Send, X is deleted and an unrelated "X" is inserted
 * on page 2. Under the old "follow an id unique at Send" rule the pin followed the newcomer. */
function spoofedDocument(): { sent: ChemDraftDocument; spoofed: ChemDraftDocument } {
  const empty = createEmptyDocument({ now });
  const page1 = { ...empty.pages[0]!, id: "page-1", objects: [molecule("X", 0)] };
  const page2 = { ...empty.pages[0]!, id: "page-2", objects: [] };
  const sent = toEngineDocument({ ...empty, pages: [page1, page2], selection: { pageId: "page-1", objectIds: ["X"] } });
  const spoofed = { ...sent, pages: [{ ...sent.pages[0]!, objects: [] }, { ...sent.pages[1]!, objects: [molecule("X", 300)] }] };
  return { sent, spoofed };
}

describe("Kimi security review: a pin unique at Send never follows its id to an unrelated object on another page", () => {
  it("resolution, scope, preflight and the final check all refuse page 2's newcomer", () => {
    const { sent, spoofed } = spoofedDocument();
    const pins = legacyWriteScopePages(sent, ["X"], "page-1");
    expect(scopedObjectPage(spoofed, "X", pins)).toBeUndefined();
    expect(() => resolveScopedObject(spoofed, "X", pins)).toThrow(
      "The object you selected on page 1 is no longer there; reselect it and try again.");
    expect(objectInWriteScope(new Set(["X"]), resolvePinnedPages(spoofed, pins), "page-2", "X")).toBe(false);
    const proposed = { reason: "Move", warnings: [], requiresUserApproval: true as const,
      patch: { op: "updateObject" as const, objectId: "X", changes: { x: 500 } } };
    expect(() => assertLegacyWritePages(spoofed, proposed.patch, pins)).toThrow(reselect(1));
    expect(() => assertPluginPatchWriteScope(spoofed, proposed, ["X"], undefined, undefined, pins)).toThrow(reselect(1));
    const after = applyPatch(spoofed, proposed.patch, { now });
    expect(() => assertPluginDocumentWriteScope(spoofed, after, proposed, ["X"], pins))
      .toThrow('Plugin write refused: molecule "X" was changed (x), but was not selected when the command started.');
  });

  it("a pending command refuses the write and leaves page 2's newcomer unchanged", async () => {
    const { sent, spoofed } = spoofedDocument();
    const f = pendingHost(sent);
    const pending = f.host.invokeCommand("plugin.pending.run");
    await Promise.resolve();
    f.edit(spoofed);
    f.release();
    await expect(pending).rejects.toThrow(reselect(1));
    expect(f.document()).toBe(spoofed);
    expect(f.document().pages[1]!.objects).toEqual([molecule("X", 300)]);
  });
});

/** Send selects page 1's molecule "X"; page 1 also holds a caption, page 2 is empty. */
function identitySent(): ChemDraftDocument {
  const empty = createEmptyDocument({ now });
  const page1 = { ...empty.pages[0]!, id: "page-1", objects: [molecule("X", 0), text("T")] };
  const page2 = { ...empty.pages[0]!, id: "page-2", objects: [] };
  return toEngineDocument({ ...empty, pages: [page1, page2], selection: { pageId: "page-1", objectIds: ["X"] } });
}
const objectX = (document: ChemDraftDocument) => document.pages.flatMap(page => page.objects).find(object => object.id === "X")!;
/** The user deletes X and pastes an exact copy that gets the freed id back, on `pageId`. */
function deleteAndPaste(document: ChemDraftDocument, pageId = "page-1"): ChemDraftDocument {
  const copy = structuredClone(objectX(document));
  return applyPatch(applyPatch(document, { op: "removeObject", objectId: "X" }, { now }),
    { op: "addObject", pageId, object: copy }, { now });
}

describe("1.2.3 host-owned identity: a pin binds the selected object, never a same-id newcomer", () => {
  it("refuses a same-page id reuse after delete and paste, even of an exact copy", async () => {
    const f = pendingHost(identitySent());
    const pending = f.host.invokeCommand("plugin.pending.run");
    await Promise.resolve();
    const pasted = deleteAndPaste(f.document());
    expect(pasted.pages[0]!.objects.map(object => object.id)).toEqual(["T", "X"]);
    f.edit(pasted);
    f.release();
    await expect(pending).rejects.toThrow(reselect(1));
    expect(f.applyDocumentPatch).not.toHaveBeenCalled();
    expect(f.document()).toBe(pasted);
  });

  it("refuses a same-page id reuse by another command's plugin insert", async () => {
    const f = pendingHost(identitySent());
    const pending = f.host.invokeCommand("plugin.pending.run");
    await Promise.resolve();
    const removed = applyPatch(f.document(), { op: "removeObject", objectId: "X" }, { now });
    const inserted = applyPatch(removed, { op: "addObject", pageId: "page-1", object: molecule("X", 120) }, { now });
    f.edit(inserted);
    f.release();
    await expect(pending).rejects.toThrow(reselect(1));
    expect(f.document()).toBe(inserted);
  });

  it("refuses an insert that hands back the pinned object value itself: an insertion is always a new object", () => {
    const sent = identitySent();
    const pins = legacyWriteScopePages(sent, ["X"], "page-1");
    const reinserted = applyPatch(applyPatch(sent, { op: "removeObject", objectId: "X" }, { now }),
      { op: "addObject", pageId: "page-1", object: objectX(sent) }, { now });
    expect(scopedObjectPage(reinserted, "X", pins)).toBeUndefined();
    expect(() => assertLegacyWritePages(reinserted, { op: "updateObject", objectId: "X", changes: { x: 5 } }, pins)).toThrow(reselect(1));
  });

  it("a pasted copy of the pinned object on another page is not the pinned object", async () => {
    const f = pendingHost(identitySent());
    const pending = f.host.invokeCommand("plugin.pending.run");
    await Promise.resolve();
    const pasted = deleteAndPaste(f.document(), "page-2");
    f.edit(pasted);
    f.release();
    await expect(pending).rejects.toThrow(reselect(1));
    expect(f.document()).toBe(pasted);
  });

  it("a pinned object moved to another page stays writable after an edit and a restyle", async () => {
    const f = pendingHost(identitySent());
    const pending = f.host.invokeCommand("plugin.pending.run");
    await Promise.resolve();
    // The user nudges and restyles X (patch edits), then moves it to page 2.
    const edited = applyPatch(applyPatch(f.document(), { op: "updateObject", objectId: "X", changes: { y: 40 } }, { now }),
      { op: "updateObject", objectId: "X", changes: { style: { color: "#112233" } } }, { now });
    const [page1, page2] = edited.pages;
    f.edit({ ...edited, pages: [{ ...page1!, objects: page1!.objects.filter(object => object.id !== "X") },
      { ...page2!, objects: [objectX(edited)] }] });
    f.release();
    await expect(pending).resolves.toMatchObject({ applied: true });
    expect(f.document().pages[1]!.objects[0]).toMatchObject({ id: "X", x: 500, y: 40, style: { color: "#112233" } });
    expect(f.document().pages[0]!.objects).toEqual([text("T")]);
  });

  it("undo and redo of an edit or a deletion keep the pinned object's identity", () => {
    let history = createDocumentHistory(identitySent());
    history = applyPatchWithHistory(history, { op: "updateObject", objectId: "X", changes: { y: 40 } }, { now });
    // Send happens on the edited document.
    const pins = legacyWriteScopePages(history.present, ["X"], "page-1");
    const write = { op: "updateObject" as const, objectId: "X", changes: { x: 500 } };
    history = undo(history);
    expect(objectX(history.present)).toMatchObject({ y: 0 });
    expect(() => assertLegacyWritePages(history.present, write, pins)).not.toThrow();
    history = redo(history);
    expect(() => assertLegacyWritePages(history.present, write, pins)).not.toThrow();
    history = applyPatchWithHistory(history, { op: "removeObject", objectId: "X" }, { now });
    expect(() => assertLegacyWritePages(history.present, write, pins)).toThrow(reselect(1));
    history = undo(history);
    expect(() => assertLegacyWritePages(history.present, write, pins)).not.toThrow();
  });

  it("undo back to the object a pasted newcomer replaced does not rebind the newcomer's pin, and redo restores it", () => {
    let history = createDocumentHistory(identitySent());
    history = applyPatchWithHistory(history, { op: "removeObject", objectId: "X" }, { now });
    history = applyPatchWithHistory(history, { op: "addObject", pageId: "page-1", object: molecule("X", 300) }, { now });
    // Send selects the pasted newcomer.
    const pins = legacyWriteScopePages(history.present, ["X"], "page-1");
    const write = { op: "updateObject" as const, objectId: "X", changes: { x: 500 } };
    history = undo(undo(history));
    // The original X is back on page 1 under the same id; it is not the object that was selected.
    expect(objectX(history.present)).toMatchObject({ x: 0 });
    expect(() => assertLegacyWritePages(history.present, write, pins)).toThrow(reselect(1));
    history = redo(redo(history));
    expect(() => assertLegacyWritePages(history.present, write, pins)).not.toThrow();
  });

  it("the final check refuses a write that reached a same-page newcomer", () => {
    const sent = identitySent();
    const pins = legacyWriteScopePages(sent, ["X"], "page-1");
    const pasted = deleteAndPaste(sent);
    const proposed = { reason: "Move", warnings: [], requiresUserApproval: true as const,
      patch: { op: "updateObject" as const, objectId: "X", changes: { x: 500 } } };
    expect(() => assertPluginPatchWriteScope(pasted, proposed, ["X"], undefined, undefined, pins)).toThrow(reselect(1));
    const after = applyPatch(pasted, proposed.patch, { now });
    expect(() => assertPluginDocumentWriteScope(pasted, after, proposed, ["X"], pins))
      .toThrow('Plugin write refused: molecule "X" was changed (x), but was not selected when the command started.');
  });

  it("an object the command inserts under its own deleted pin's id stays writable as its insertion", async () => {
    let current = identitySent();
    const applyDocumentPatch = vi.fn((request: PluginPatchApplicationRequest) => {
      const before = current;
      assertPluginPatchWriteScope(before, request.patch, request.writeScopeObjectIds, undefined, undefined, request.writeScopePages);
      const after = applyPatch(before, request.patch.patch, { now });
      assertPluginDocumentWriteScope(before, after, request.patch, request.writeScopeObjectIds, request.writeScopePages);
      current = after;
      return { applied: true as const, objectIds: writePatchOps(request.patch.patch).flatMap(op =>
        op.op === "addObject" ? [op.object.id] : "objectId" in op ? [op.objectId] : []) };
    });
    const host = new PluginHost({ getActiveDocument: () => current, applyDocumentPatch });
    host.registerPlugin({ id: "org.test.replace", name: "Replace", version: "0.0.1", apiVersion: "^0.1.8", entry: "plugin.js",
      permissions: ["document.write"], contributes: { commands: [{ id: "plugin.replace.run", title: "Replace" }] }
    }, { commandHandlers: { "plugin.replace.run": async ctx => {
      await ctx.documents.applyPatch!({ reason: "Remove", patch: { op: "removeObject", objectId: "X" } });
      await ctx.documents.applyPatch!({ reason: "Insert", patch: { op: "addObject", pageId: "page-1", object: molecule("X", 200) } });
      return ctx.documents.applyPatch!({ reason: "Edit the insertion", patch: { op: "updateObject", objectId: "X", changes: { x: 300 } } });
    } } });
    await expect(host.invokeCommand("plugin.replace.run")).resolves.toMatchObject({ applied: true });
    expect(applyDocumentPatch).toHaveBeenCalledTimes(3);
    expect(objectX(current)).toMatchObject({ x: 300 });
  });

  it("an id selected at Send that names no object pins nothing a later object could take", () => {
    const sent = identitySent();
    const pins = legacyWriteScopePages(sent, ["Y"], "page-1");
    const later = applyPatch(sent, { op: "addObject", pageId: "page-1", object: molecule("Y", 200) }, { now });
    expect(() => assertLegacyWritePages(later, { op: "updateObject", objectId: "Y", changes: { x: 5 } }, pins)).toThrow(reselect(1));
  });

  it("the identity is host memory only: never in the document's data, its file, or a structured clone", () => {
    const sent = identitySent();
    const before = JSON.stringify(sent);
    const file = serializeDocument(sent);
    const pins = legacyWriteScopePages(sent, ["X"], "page-1")!;
    expect(JSON.stringify(sent)).toBe(before);
    expect(serializeDocument(sent)).toBe(file);
    expect(Object.getOwnPropertySymbols(objectX(sent))).toEqual([]);
    expect(scopedObjectPage(sent, "X", pins)).toBe("page-1");
    // The same data read back from its file or cloned is a different object: the pin does not match it.
    expect(scopedObjectPage(deserializeDocument(file), "X", pins)).toBeUndefined();
    expect(scopedObjectPage(structuredClone(sent), "X", pins)).toBeUndefined();
    // A pin cannot be posted to a worker or written out as data.
    expect(() => structuredClone(pins.get("X"))).toThrow();
    expect(JSON.stringify(pins.get("X"))).not.toContain("chemdraft");
  });
});

/** One page holding two molecules that share the id "X" (an imported file can); the first is selected. */
function samePageDuplicates(): ChemDraftDocument {
  const empty = createEmptyDocument({ now });
  const page1 = { ...empty.pages[0]!, id: "page-1", objects: [molecule("X", 0), molecule("X", 100)] };
  return toEngineDocument({ ...empty, pages: [page1], selection: { pageId: "page-1", objectIds: ["X"] } });
}
const batch = (...patches: ReturnType<typeof writePatchOps>) => ({ reason: "Batch", warnings: [], requiresUserApproval: true as const,
  patch: { op: "batch" as const, patches } });

describe("Kimi 1.2.3 finding 2: each batch operation is authorized against the object it actually reaches", () => {
  const unselectedX = (document: ChemDraftDocument) => document.pages[0]!.objects.filter(object => object.id === "X");

  it.each([
    ["removeObject X; updateObject X", batch({ op: "removeObject", objectId: "X" }, { op: "updateObject", objectId: "X", changes: { x: 500 } })],
    ["reorderObject X to front; updateObject X", batch({ op: "reorderObject", objectId: "X", placement: "front" },
      { op: "updateObject", objectId: "X", changes: { x: 500 } })]
  ])("refuses %s, which reaches the unselected same-page X second", (_name, proposed) => {
    const before = samePageDuplicates();
    const pins = legacyWriteScopePages(before, ["X"], "page-1");
    // chem-core applies the batch in order: the update lands on the second, unselected X.
    const after = applyPatch(before, proposed.patch, { now });
    expect(unselectedX(after).some(object => object.x === 500 && object !== before.pages[0]!.objects[0])).toBe(true);
    expect(() => assertPluginPatchWriteScope(before, proposed, ["X"], undefined, undefined, pins)).toThrow(/Plugin write refused/);
    expect(() => assertLegacyWritePages(before, proposed.patch, pins)).toThrow(/Plugin write refused/);
    expect(() => assertPluginDocumentWriteScope(before, after, proposed, ["X"], pins)).toThrow(/Plugin write refused/);
  });

  it("still writes the selected X when the batch only reaches it", () => {
    const before = samePageDuplicates();
    const pins = legacyWriteScopePages(before, ["X"], "page-1");
    const proposed = batch({ op: "updateObject", objectId: "X", changes: { y: 5 } }, { op: "updateObject", objectId: "X", changes: { x: 7 } });
    expect(() => assertPluginPatchWriteScope(before, proposed, ["X"], undefined, undefined, pins)).not.toThrow();
    expect(() => assertLegacyWritePages(before, proposed.patch, pins)).not.toThrow();
    const after = applyPatch(before, proposed.patch, { now });
    expect(after.pages[0]!.objects.map(object => object.x)).toEqual([7, 100]);
    expect(() => assertPluginDocumentWriteScope(before, after, proposed, ["X"], pins)).not.toThrow();
  });

  it("a host command's batch never reaches the unselected X, and the document is unchanged", async () => {
    let current = samePageDuplicates();
    const applyDocumentPatch = vi.fn((request: PluginPatchApplicationRequest) => {
      assertPluginPatchWriteScope(current, request.patch, request.writeScopeObjectIds, undefined, undefined, request.writeScopePages);
      const after = applyPatch(current, request.patch.patch, { now });
      assertPluginDocumentWriteScope(current, after, request.patch, request.writeScopeObjectIds, request.writeScopePages);
      current = after;
      return { applied: true as const, objectIds: [] };
    });
    const host = new PluginHost({ getActiveDocument: () => current, applyDocumentPatch });
    host.registerPlugin({ id: "org.test.batch", name: "Batch", version: "0.0.1", apiVersion: "^0.1.8", entry: "plugin.js",
      permissions: ["document.write"], contributes: { commands: [{ id: "plugin.batch.run", title: "Batch" }] }
    }, { commandHandlers: { "plugin.batch.run": ctx => ctx.documents.applyPatch!({ reason: "Batch", patch: { op: "batch", patches: [
      { op: "removeObject", objectId: "X" }, { op: "updateObject", objectId: "X", changes: { x: 500 } }] } }) } });
    const original = current;
    await expect(host.invokeCommand("plugin.batch.run")).rejects.toThrow(/Plugin write refused/);
    expect(applyDocumentPatch).not.toHaveBeenCalled();
    expect(current).toBe(original);
  });
});

describe("Kimi 1.2.3 finding 3: a command's insertions are granted by identity, never by bare id", () => {
  /** A command that writes `first`, waits for `release`, then writes `second`. Receipts name every op's id. */
  function twoStepHost(document: ChemDraftDocument, first: PluginPatchApplicationRequest["patch"]["patch"][],
    second: PluginPatchApplicationRequest["patch"]["patch"]) {
    let current = document;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const applyDocumentPatch = vi.fn((request: PluginPatchApplicationRequest) => {
      const before = current;
      assertPluginPatchWriteScope(before, request.patch, request.writeScopeObjectIds, undefined, undefined, request.writeScopePages);
      const after = applyPatch(before, request.patch.patch, { now });
      assertPluginDocumentWriteScope(before, after, request.patch, request.writeScopeObjectIds, request.writeScopePages);
      current = after;
      return { applied: true as const, objectIds: writePatchOps(request.patch.patch).flatMap(op =>
        op.op === "addObject" ? [op.object.id] : "objectId" in op ? [op.objectId] : []) };
    });
    const host = new PluginHost({ getActiveDocument: () => current, applyDocumentPatch });
    host.registerPlugin({ id: "org.test.insert", name: "Insert", version: "0.0.1", apiVersion: "^0.1.8", entry: "plugin.js",
      permissions: ["document.write"], contributes: { commands: [{ id: "plugin.insert.run", title: "Insert" }] }
    }, { commandHandlers: { "plugin.insert.run": async ctx => {
      for (const patch of first) await ctx.documents.applyPatch!({ reason: "First", patch });
      await held;
      return ctx.documents.applyPatch!({ reason: "Second", patch: second });
    } } });
    const pending = host.invokeCommand("plugin.insert.run");
    return { pending, release, applyDocumentPatch, document: () => current, edit: (next: ChemDraftDocument) => { current = next; } };
  }
  const edit = { op: "updateObject" as const, objectId: "N", changes: { x: 999 } };
  /** The user deletes the command's insertion "N" and pastes an exact copy back under its id. */
  const replaceN = (document: ChemDraftDocument) => {
    const copy = structuredClone(document.pages.flatMap(page => page.objects).find(object => object.id === "N")!);
    return applyPatch(applyPatch(document, { op: "removeObject", objectId: "N" }, { now }), { op: "addObject", pageId: "page-1", object: copy }, { now });
  };

  it("refuses a later write to a pasted replacement of the command's own insertion", async () => {
    const f = twoStepHost(identitySent(), [{ op: "addObject", pageId: "page-1", object: molecule("N", 200) }], edit);
    await vi.waitFor(() => expect(f.applyDocumentPatch).toHaveBeenCalledTimes(1));
    const replaced = replaceN(f.document());
    f.edit(replaced);
    f.release();
    await expect(f.pending).rejects.toThrow(/Plugin write refused/);
    expect(f.document()).toBe(replaced);
  });

  it("refuses it too when the insertion reused the id of the command's own deleted selection", async () => {
    // Send selects X; the command deletes X, inserts a new X, and the user then replaces that insertion.
    const f = twoStepHost(identitySent(), [{ op: "removeObject", objectId: "X" },
      { op: "addObject", pageId: "page-1", object: molecule("X", 200) }], { op: "updateObject", objectId: "X", changes: { x: 999 } });
    await vi.waitFor(() => expect(f.applyDocumentPatch).toHaveBeenCalledTimes(2));
    const copy = structuredClone(objectX(f.document()));
    const replaced = applyPatch(applyPatch(f.document(), { op: "removeObject", objectId: "X" }, { now }),
      { op: "addObject", pageId: "page-1", object: copy }, { now });
    f.edit(replaced);
    f.release();
    await expect(f.pending).rejects.toThrow(/Plugin write refused/);
    expect(f.document()).toBe(replaced);
  });

  it("still writes the command's own insertion after the user edits it", async () => {
    const f = twoStepHost(identitySent(), [{ op: "addObject", pageId: "page-1", object: molecule("N", 200) }], edit);
    await vi.waitFor(() => expect(f.applyDocumentPatch).toHaveBeenCalledTimes(1));
    f.edit(applyPatch(f.document(), { op: "updateObject", objectId: "N", changes: { y: 40 } }, { now }));
    f.release();
    await expect(f.pending).resolves.toMatchObject({ applied: true });
    expect(f.document().pages[0]!.objects.find(object => object.id === "N")).toMatchObject({ x: 999, y: 40 });
  });
});

/**
 * Probe run-20261122-074045-5fa6da (1.2.2): a native .chemdraft file holding two same-page objects with
 * the id "X" opens unchanged (the schema has no uniqueness rule; chem-core resolves a bare id to its first
 * remaining occurrence). With the first X selected, "removeObject X; updateObject X", "reorderObject X;
 * updateObject X" and two separate writes under the same pin all moved the SECOND, unselected X, and both
 * the preflight and the final check passed. These cases open the document through chem-core's native file
 * reader (readSerializedDocument: the reader openNativeDocument -> openChemDraftPayload uses for .chemdraft
 * JSON) and drive the real PluginHost command path, which pins the selection at invocation.
 */
describe("1.2.2 probe: a native file with two same-page objects sharing an id", () => {
  function duplicateFile(): string {
    const empty = createEmptyDocument({ now });
    return serializeDocument({ ...empty, pages: [{ ...empty.pages[0]!, id: "page-1", objects: [molecule("X", 0), molecule("X", 100)] }],
      selection: { pageId: "page-1", objectIds: ["X"] } });
  }
  /**
   * The probe's document, admitted as File > Open admits a parsed document (MainWindow resetDocumentHistory).
   * Since 1.2.3 the native reader renumbers the second X on open (see the last case), so these defense-in-depth
   * cases build the document with the strict in-memory validator, which still accepts a duplicate id: the
   * write paths must stay safe for a duplicate that reaches the engine some other way.
   */
  function openedDuplicates(): ChemDraftDocument {
    const opened = admitParsedDocument(parseDocument(JSON.parse(duplicateFile())));
    expect(opened.pages[0]!.objects.map(object => [object.id, object.x])).toEqual([["X", 0], ["X", 100]]);
    expect(opened.selection).toMatchObject({ pageId: "page-1", objectIds: ["X"] });
    return opened;
  }
  type Patch = PluginPatchApplicationRequest["patch"]["patch"];
  const moveX: Patch = { op: "updateObject", objectId: "X", changes: { x: 500 } };

  /** A command that applies each of `writes` in turn, through the host preflight and the desktop's final check. */
  function commandHost(document: ChemDraftDocument, writes: Patch[]) {
    let current = document;
    const applied: Patch[] = [];
    const applyDocumentPatch = vi.fn((request: PluginPatchApplicationRequest) => {
      const before = current;
      assertPluginPatchWriteScope(before, request.patch, request.writeScopeObjectIds, undefined, undefined, request.writeScopePages);
      const after = applyPatch(before, request.patch.patch, { now });
      assertPluginDocumentWriteScope(before, after, request.patch, request.writeScopeObjectIds, request.writeScopePages);
      current = after;
      applied.push(request.patch.patch);
      return { applied: true as const, objectIds: [] };
    });
    const host = new PluginHost({ getActiveDocument: () => current, applyDocumentPatch });
    host.registerPlugin({ id: "org.test.dupid", name: "Duplicate ids", version: "0.0.1", apiVersion: "^0.1.8", entry: "plugin.js",
      permissions: ["document.write"], contributes: { commands: [{ id: "plugin.dupid.run", title: "Run" }] }
    }, { commandHandlers: { "plugin.dupid.run": async ctx => {
      for (const patch of writes) await ctx.documents.applyPatch!({ reason: "Write", patch });
    } } });
    return { run: () => host.invokeCommand("plugin.dupid.run"), applied, document: () => current };
  }
  /** The second X, the copy that was not selected. */
  const secondX = (document: ChemDraftDocument) => document.pages[0]!.objects.filter(object => object.id === "X")[1];
  /** `object` is still `unselected` as opened: the same value, and the same host-owned identity. */
  const expectUntouched = (object: DocumentObject | undefined, unselected: DocumentObject) => {
    expect(object).toEqual(unselected);
    expect(hasObjectIdentity(object!, objectIdentity(unselected))).toBe(true);
  };
  const removeThenMove: Patch = { op: "batch", patches: [{ op: "removeObject", objectId: "X" }, moveX] };
  const reorderThenMove: Patch = { op: "batch", patches: [{ op: "reorderObject", objectId: "X", placement: "front" }, moveX] };

  it("refuses the batch removeObject X; updateObject X, and the unselected X never moves", async () => {
    const opened = openedDuplicates();
    const unselected = secondX(opened)!;
    const f = commandHost(opened, [removeThenMove]);
    await expect(f.run()).rejects.toThrow(/Plugin write refused/);
    expect(f.applied).toEqual([]);
    expect(f.document()).toBe(opened);
    expectUntouched(secondX(f.document()), unselected);
  });

  it("refuses the batch reorderObject X; updateObject X: the command path rejects the op, and the scope checks refuse it too", async () => {
    const opened = openedDuplicates();
    const unselected = secondX(opened)!;
    // documents.applyPatch does not accept reorderObject from a plugin command at all (DirectWritePatchOps).
    const f = commandHost(opened, [reorderThenMove]);
    await expect(f.run()).rejects.toThrow(`Plugin "org.test.dupid" passed an unsupported "reorderObject" patch to documents.applyPatch.`);
    expect(f.applied).toEqual([]);
    expect(f.document()).toBe(opened);
    // Should that ever change, the identity-based preflight and final check still refuse this batch on the
    // opened document: chem-core applies it in order and the update reaches the unselected X.
    const pins = legacyWriteScopePages(opened, ["X"]);
    const proposed = { reason: "Batch", warnings: [], requiresUserApproval: true as const, patch: reorderThenMove };
    const after = applyPatch(opened, reorderThenMove, { now });
    expect(after.pages[0]!.objects.map(object => object.x)).toEqual([500, 0]);
    expect(() => assertPluginPatchWriteScope(opened, proposed, ["X"], undefined, undefined, pins)).toThrow(/Plugin write refused/);
    expect(() => assertLegacyWritePages(opened, reorderThenMove, pins)).toThrow(/Plugin write refused/);
    expect(() => assertPluginDocumentWriteScope(opened, after, proposed, ["X"], pins)).toThrow(/Plugin write refused/);
    expectUntouched(secondX(opened), unselected);
  });

  it("refuses the second of two separate writes under the same pin: the first removed the selected X", async () => {
    const opened = openedDuplicates();
    const unselected = secondX(opened)!;
    const f = commandHost(opened, [{ op: "removeObject", objectId: "X" }, moveX]);
    // The preflight refuses the update before it reaches the desktop: the pinned X is gone, and the only X
    // left is the unselected copy, which never held the pin.
    await expect(f.run()).rejects.toThrow(reselect(1));
    expect(f.applied).toEqual([{ op: "removeObject", objectId: "X" }]);
    expect(f.document().pages[0]!.objects).toHaveLength(1);
    expectUntouched(f.document().pages[0]!.objects[0], unselected);
    // The final check, on its own, refuses the same update too.
    const removed = f.document();
    const proposed = { reason: "Move", warnings: [], requiresUserApproval: true as const, patch: moveX };
    expect(() => assertPluginDocumentWriteScope(removed, applyPatch(removed, moveX, { now }), proposed, ["X"],
      legacyWriteScopePages(opened, ["X"]))).toThrow(/Plugin write refused/);
  });

  it("writes a single update to the selected X: the command path pins the first X on the Send page", async () => {
    // Documented behavior: the legacy command pin is the first object with the id on the selection's page
    // (pinSelectionPages), which is also the object chem-core's bare-id update reaches, so the write lands
    // on the selected copy and only there.
    const opened = openedDuplicates();
    const unselected = secondX(opened)!;
    const f = commandHost(opened, [moveX]);
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.document().pages[0]!.objects.map(object => object.x)).toEqual([500, 100]);
    expectUntouched(secondX(f.document()), unselected);
  });

  it("1.2.3: File > Open renumbers the second X, so a single update reaches the selected X and the other copy keeps its new id", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const read = readSerializedDocument(duplicateFile());
      expect(read.warnings.map(warning => warning.code)).toEqual(["NATIVE_DUPLICATE_OBJECT_IDS_RENUMBERED"]);
      const opened = admitParsedDocument(read.document);
      expect(opened.pages[0]!.objects.map(object => [object.id, object.x])).toEqual([["X", 0], ["X_002", 100]]);
      const other = opened.pages[0]!.objects[1]!;
      const f = commandHost(opened, [moveX]);
      await expect(f.run()).resolves.toBeUndefined();
      expect(f.document().pages[0]!.objects.map(object => [object.id, object.x])).toEqual([["X", 500], ["X_002", 100]]);
      expectUntouched(f.document().pages[0]!.objects[1], other);
      // The batch that was refused on the duplicate now has one X to name: it removes the selected X, then the
      // update finds nothing, and the renamed copy is out of the command's scope either way.
      const g = commandHost(opened, [removeThenMove]);
      await expect(g.run()).rejects.toThrow();
      expectUntouched(g.document().pages[0]!.objects.find(object => object.id === "X_002"), other);
    } finally { vi.restoreAllMocks(); }
  });
});
