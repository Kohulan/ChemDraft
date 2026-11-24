// The published plugin-host SDK bundles chem-core and nothing else of the app (scripts/build-sdk.mjs):
// no layout-engine, no label grammar. It must still refuse a hydrogen count stated on an abbreviation
// (OMe, Ph, CF3), because chem-core reads the abbreviation table itself. This file's module graph is
// the SDK's: its first test walks it and fails if anything in it reaches layout-engine, so the refusal
// below cannot pass because some import loaded the grammar.
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch, applyPatchWithHistory, createDocumentHistory, createEmptyDocument,
  type DocumentHistory, type DocumentPatch, type MoleculeObject } from "@chemdraft/chem-core";
import type { PluginSelectionSnapshot } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";
import { HydrogenCountUnrepresentableReason, PluginHost, PluginHostError, type PluginPatchApplicationRequest } from "./index";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** `file` as a repo-relative, forward-slash path. `pathSep` is passed in so Windows forms can be checked on any host. */
function toRepoRelative(file: string, root: string, pathSep: string): string {
  const forward = (value: string): string => {
    let out = value.replace(/^file:\/\/\/?(?=[A-Za-z]:|\/)/i, "");
    if (/^file:\/\//i.test(value) && /^[A-Za-z]:/.test(out) === false && out.startsWith("/") === false) out = `/${out}`;
    if (pathSep === "\\" || /^[A-Za-z]:[\\/]/.test(out)) out = out.split("\\").join("/");
    return out.replace(/\/+$/, "");
  };
  const f = forward(file);
  const r = forward(root);
  const windows = /^[A-Za-z]:/.test(r);
  const lower = (value: string): string => (windows ? value.toLowerCase() : value);
  if (lower(f) === lower(r)) return "";
  if (lower(f).startsWith(`${lower(r)}/`)) return f.slice(r.length + 1);
  return f;
}

/** Every source file reachable from `entry` by any import (type-only included), and every bare specifier. */
function moduleGraph(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const resolveFile = (base: string): string | undefined =>
    [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(candidate => statSync(candidate, { throwIfNoEntry: false })?.isFile() === true);
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      let target: string | undefined;
      if (specifier.startsWith(".")) {
        target = resolveFile(resolve(dirname(file), specifier));
      } else if (specifier.startsWith("@chemdraft/")) {
        bare.add(specifier);
        const [, name, ...subpath] = specifier.split("/");
        target = resolveFile(join(repoRoot, "packages", name!, "src", subpath.length > 0 ? subpath.join("/") : "index"));
        expect(target, `${specifier} (imported by ${toRepoRelative(file, repoRoot, sep)}) resolves to a source file`).toBeDefined();
      } else {
        bare.add(specifier);
      }
      if (target !== undefined && !toRepoRelative(target, repoRoot, sep).split("/").includes("node_modules")) pending.push(target);
    }
  }
  return { files, bare };
}

const now = "2026-11-23T00:00:00.000Z";
const snapshot = (objectIds: string[]): PluginSelectionSnapshot => ({ objectIds, molecules: [] });
const molecule = (element: string): MoleculeObject => ({
  id: "mol_1", type: "molecule", x: 110, y: 120, width: 30, height: 20, rotation: 0, style: {},
  structureFormat: "smiles", structure: "CC",
  atoms: [{ id: "a1", element: "C", x: 110, y: 120, formalCharge: 0 },
    { id: "a2", element: "C", x: 140, y: 120, formalCharge: 0 },
    { id: "g", element, x: 160, y: 120, formalCharge: 0 }],
  bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" },
    { id: "bg", fromAtomId: "a2", toAtomId: "g", order: "single" }],
  superatoms: [], rGroups: []
});

/** A host over a one-molecule document with undo history, and a command writing `hydrogenCount` on atom "g". */
function hostSettingCount(element: string, hydrogenCount: number) {
  const subject = molecule(element);
  let history: DocumentHistory = createDocumentHistory(applyPatch(createEmptyDocument({ now }),
    { op: "addObject", pageId: "page_001", object: subject }, { now }));
  history = { ...history, present: { ...history.present, selection: { pageId: "page_001", objectIds: [subject.id] } } };
  const original = history;
  const applyDocumentPatch = vi.fn((request: PluginPatchApplicationRequest) => {
    history = applyPatchWithHistory(history, request.patch.patch as DocumentPatch);
    return { applied: true as const, objectIds: [] };
  });
  const host = new PluginHost({ getActiveDocument: () => history.present, getSelection: () => snapshot([subject.id]), applyDocumentPatch });
  const atoms = subject.atoms.map(atom => atom.id === "g" ? { ...atom, hydrogenCount } : atom);
  host.registerPlugin({ id: "org.test.standalone", name: "Standalone count", version: "0.0.1", apiVersion: "^0.1.8", entry: "plugin.js",
    permissions: ["document.write"], contributes: { commands: [{ id: "plugin.standalone.run", title: "Run" }] }
  }, { commandHandlers: { "plugin.standalone.run": ctx => ctx.documents.applyPatch!({ reason: "count",
    patch: { op: "updateObject", objectId: subject.id, changes: { atoms } } }) } });
  return { host, applyDocumentPatch, original, history: () => history };
}

describe("toRepoRelative", () => {
  it.each([
    ["D:\\a\\repo\\packages\\layout-engine\\src\\index.ts", "D:\\a\\repo", "\\"],
    ["d:\\a\\repo\\packages\\layout-engine\\src\\index.ts", "D:\\a\\repo\\", "\\"],
    ["file:///D:/a/repo/packages/layout-engine/src/index.ts", "D:\\a\\repo", "\\"],
    ["/home/r/repo/packages/layout-engine/src/index.ts", "/home/r/repo", "/"]
  ])("turns %s into a repo-relative forward-slash path", (file, root, pathSep) => {
    expect(toRepoRelative(file, root, pathSep)).toBe("packages/layout-engine/src/index.ts");
  });
});

describe("the plugin host without layout-engine (the published SDK)", () => {
  it("loads no layout-engine anywhere in this test's module graph, and does reach the abbreviation table", () => {
    const { files, bare } = moduleGraph(fileURLToPath(import.meta.url));
    const reached = [...files].map(file => toRepoRelative(file, repoRoot, sep));
    expect(reached.filter(file => file.startsWith("packages/layout-engine/"))).toEqual([]);
    expect([...bare].filter(specifier => specifier.startsWith("@chemdraft/layout-engine"))).toEqual([]);
    expect(reached).toContain("packages/plugin-host/src/index.ts");
    expect(reached).toContain("packages/chem-core/src/abbreviationLabels.ts");
    expect(reached).toContain("packages/template-library/src/abbreviations.ts");
  });

  it("refuses hydrogenCount 1 on OMe with hydrogen_count_unrepresentable, leaving the document and its undo history as they were", async () => {
    const { host, applyDocumentPatch, original, history } = hostSettingCount("OMe", 1);
    const refused = await host.invokeCommand("plugin.standalone.run").then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(PluginHostError);
    expect(refused).toMatchObject({
      message: 'Plugin write refused: atom "g" of molecule "mol_1" is OMe with hydrogenCount 1, which nothing would count: an abbreviation\'s ' +
        "hydrogens come from what it stands for. Only 0 is allowed on an abbreviation (OMe); omit hydrogenCount or set it to 0. Nothing was changed.",
      reason: HydrogenCountUnrepresentableReason,
      details: { moleculeId: "mol_1", atomId: "g", element: "OMe", hydrogenCount: 1 }
    });
    expect(applyDocumentPatch).not.toHaveBeenCalled();
    expect(history()).toBe(original);
    expect(history().past).toHaveLength(0);
    expect(history().future).toHaveLength(0);
  });

  it.each([["Ph", 2], ["CF3", 1], ["Me", 3], ["MeO", 1]] as const)("refuses %s stating %i as an abbreviation", async (element, hydrogenCount) => {
    const { host, applyDocumentPatch, original, history } = hostSettingCount(element, hydrogenCount);
    await expect(host.invokeCommand("plugin.standalone.run")).rejects.toMatchObject({
      reason: HydrogenCountUnrepresentableReason, details: { element, hydrogenCount },
      message: expect.stringContaining(`Only 0 is allowed on an abbreviation (${element})`)
    });
    expect(applyDocumentPatch).not.toHaveBeenCalled();
    expect(history()).toBe(original);
  });

  it.each([["OMe", 0], ["NHMe", 1], ["CH3", 3], ["O", 1]] as const)("accepts %s stating %i", async (element, hydrogenCount) => {
    const { host, applyDocumentPatch, history } = hostSettingCount(element, hydrogenCount);
    await expect(host.invokeCommand("plugin.standalone.run")).resolves.toMatchObject({ applied: true });
    expect(applyDocumentPatch).toHaveBeenCalledTimes(1);
    const written = history().present.pages[0]!.objects.find(object => object.id === "mol_1");
    expect(written?.type === "molecule" && written.atoms.find(atom => atom.id === "g")?.hydrogenCount).toBe(hydrogenCount);
  });
});
