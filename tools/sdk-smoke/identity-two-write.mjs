#!/usr/bin/env node
// Built-SDK smoke check: object identity across chem-core copies (ChemDraft 1.2.3).
//
// The published `@chemdraft/plugin-host` bundle (scripts/build-sdk.mjs → packages/plugin-host/dist/index.js)
// inlines its own chem-core. Since ad47aff7d every chem-core copy in a realm shares one object-identity
// runtime on globalThis under Symbol.for("chemdraft.chem-core.objectIdentity"), so an embedder that
// commits plugin writes through ITS OWN chem-core keeps the pins the SDK took at Send. The unit tests
// prove that between two module instances of chem-core source; this script proves it on the BUILT
// artifact, the way an embedder would use it:
//
//   1. load the built SDK (dist), with `@chemdraft/plugin-api` resolved to its built dist too, exactly as
//      a consumer of the published packages gets them;
//   2. load chem-core separately, from source (a different module instance from the copy inlined in the
//      SDK bundle) — this is the embedder's chem-core;
//   3. build a document with a selected molecule X through the embedder's chem-core;
//   4. register a plugin on a `PluginHost` whose `applyDocumentPatch` commits through the embedder's
//      chem-core (preflight scope check, apply, final scope check, `onCommitted`), and invoke its command
//      with a Send-time `writeSelection` of X, so the SDK pins X;
//   5. the command writes X twice: both writes must be allowed;
//   6. the embedder then replaces X by a same-id, same-content impostor (remove + insert, as a paste or
//      undo can), and the command's third write to X must be refused and change nothing.
//
// Exit codes: 0 = pass; 1 = an expectation failed (message says which); 2 = prerequisites missing
// (run `pnpm build:sdk` first, or install dependencies). Needs no network.
//
// Usage (repo root, after `pnpm build:sdk`):  pnpm smoke:sdk-identity
//                                       or:  node tools/sdk-smoke/identity-two-write.mjs
import { existsSync, readFileSync } from "node:fs";
import module from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hostDistDir = join(root, "packages/plugin-host/dist");
const hostDist = join(hostDistDir, "index.js");
const apiDist = join(root, "packages/plugin-api/dist/index.js");
const chemCoreSource = join(root, "packages/chem-core/src/index.ts");
const RUNTIME_KEY = Symbol.for("chemdraft.chem-core.objectIdentity");
const now = "2026-11-22T00:00:00.000Z";

function prerequisite(message) {
  console.error(`sdk-identity smoke: ${message}`);
  process.exit(2);
}

class SmokeFailure extends Error {}
function check(condition, message) {
  if (!condition) throw new SmokeFailure(message);
}

// --- Prerequisites ---------------------------------------------------------------------------------
for (const file of [hostDist, apiDist]) {
  if (!existsSync(file)) prerequisite(`missing ${file.slice(root.length + 1)}; run pnpm build:sdk first`);
}
if (!existsSync(chemCoreSource)) prerequisite(`missing ${chemCoreSource.slice(root.length + 1)}`);
const hostBundle = readFileSync(hostDist, "utf8");
if (!hostBundle.includes("chemdraft.chem-core.objectIdentity")) {
  // A bundle built before ad47aff7d keeps identity in a module-private map; this smoke would then fail on
  // the second write, which is the bug it exists to catch. Say why up front.
  console.warn("sdk-identity smoke: warning: the built SDK does not mention the shared identity runtime key; " +
    "it may predate ad47aff7d (rebuild with pnpm build:sdk).");
}

// The SDK bundle keeps `@chemdraft/plugin-api` external. In this workspace that package's manifest points
// at TypeScript source (its dist entry is only used once published, via publishConfig), so resolve the
// SDK bundle's import of it to the built plugin-api, as a published consumer would get it.
const hostDistURL = pathToFileURL(hostDistDir + "/").href;
const apiDistURL = pathToFileURL(apiDist).href;
if (typeof module.registerHooks === "function") {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@chemdraft/plugin-api" && context.parentURL?.startsWith(hostDistURL)) {
        return { url: apiDistURL, format: "module", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
  });
} else if (typeof module.register === "function") {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@chemdraft/plugin-api" && context.parentURL?.startsWith(${JSON.stringify(hostDistURL)})) {
      return { url: ${JSON.stringify(apiDistURL)}, format: "module", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }`;
  module.register(`data:text/javascript,${encodeURIComponent(hook)}`);
} else {
  prerequisite(`Node ${process.version} has no module resolution hooks; use Node 20.6 or newer`);
}

async function load() {
  let sdk;
  try {
    sdk = await import(pathToFileURL(hostDist).href);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      prerequisite(`cannot load the built SDK (${error.message}); install dependencies (zod) and run pnpm build:sdk first`);
    }
    throw error;
  }
  // chem-core has no build of its own (it is private, TypeScript source with extensionless imports), so the
  // embedder's copy is loaded from source through tsx's scoped loader: a module instance unrelated to
  // the copy esbuild inlined into the SDK bundle.
  let tsImport;
  try {
    ({ tsImport } = await import("tsx/esm/api"));
  } catch (error) {
    prerequisite(`cannot load tsx (a root devDependency) to read chem-core source: ${error.message}`);
  }
  const chemCore = await tsImport(pathToFileURL(chemCoreSource).href, import.meta.url);
  return { sdk, chemCore };
}

const molecule = (id, x) => ({
  id, type: "molecule", x, y: 0, width: 30, height: 20, rotation: 0, style: {},
  structureFormat: "smiles", structure: "CC",
  atoms: [{ id: "a1", element: "C", x, y: 0, formalCharge: 0 }, { id: "a2", element: "C", x: x + 30, y: 0, formalCharge: 0 }],
  bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" }], superatoms: [], rGroups: []
});

async function run() {
  const { sdk, chemCore } = await load();
  const { PluginHost, assertPluginPatchWriteScope, assertPluginDocumentWriteScope } = sdk;
  for (const [name, value] of Object.entries({ PluginHost, assertPluginPatchWriteScope, assertPluginDocumentWriteScope })) {
    check(typeof value === "function", `the built SDK does not export ${name}`);
  }
  for (const name of ["createEmptyDocument", "toEngineDocument", "applyPatch", "applyPatches", "objectIdentity"]) {
    check(typeof chemCore[name] === "function", `chem-core source does not export ${name}`);
  }

  // The embedder's document, built through the embedder's chem-core: X selected on page-1, plus a bystander.
  const empty = chemCore.createEmptyDocument({ now });
  const pageId = "page-1";
  let current = chemCore.toEngineDocument({ ...empty,
    pages: [{ ...empty.pages[0], id: pageId, objects: [molecule("X", 0), molecule("Y", 200)] }],
    selection: { pageId, objectIds: ["X"] } });
  const findX = document => document.pages.flatMap(page => page.objects).find(object => object.id === "X");

  // The embedder's write path, as the desktop host does it, committing through the EMBEDDER'S chem-core.
  let commits = 0;
  const applyDocumentPatch = request => {
    const before = current;
    assertPluginPatchWriteScope(before, request.patch, request.writeScopeObjectIds, undefined, undefined, request.writeScopePages);
    const after = chemCore.applyPatch(before, request.patch.patch, { now });
    assertPluginDocumentWriteScope(before, after, request.patch, request.writeScopeObjectIds, request.writeScopePages);
    current = after;
    commits += 1;
    request.onCommitted?.(after);
    return { applied: true, objectIds: [] };
  };

  // Between the command's second and third write, the user replaces X with a same-id copy (a paste or an
  // undo reusing the freed id): a different object, which the Send-time pin must not grant.
  let impostor;
  const replaceXWithImpostor = () => {
    const original = findX(current);
    current = chemCore.applyPatches(current, [{ op: "removeObject", objectId: "X" },
      { op: "addObject", pageId, object: structuredClone(original) }], { now });
    impostor = findX(current);
    check(impostor && impostor !== original && impostor.id === "X", "setup: the impostor X was not inserted");
  };

  const host = new PluginHost({ getActiveDocument: () => current, applyDocumentPatch });
  host.registerPlugin({ id: "org.chemdraft.smoke.identity", name: "Identity smoke", version: "0.0.1", apiVersion: "^0.1.8",
    entry: "plugin.js", permissions: ["document.write"],
    contributes: { commands: [{ id: "plugin.identitysmoke.run", title: "Move X twice" }] }
  }, { commandHandlers: { "plugin.identitysmoke.run": async ctx => {
    const write = x => ctx.documents.applyPatch({ reason: "Move the selected object", patch: { op: "updateObject", objectId: "X", changes: { x } } });
    const outcome = {};
    for (const [step, x] of [["first", 10], ["second", 20]]) {
      try {
        await write(x);
        outcome[step] = { allowed: true };
      } catch (error) {
        outcome[step] = { allowed: false, message: error?.message ?? String(error) };
        return outcome;
      }
    }
    replaceXWithImpostor();
    try {
      await write(30);
      outcome.impostor = { allowed: true };
    } catch (error) {
      outcome.impostor = { allowed: false, message: error?.message ?? String(error) };
    }
    return outcome;
  } } });

  // Send: the host-supplied selection captured at Send pins X (through the SDK's inlined chem-core).
  const outcome = await host.invokeCommand("plugin.identitysmoke.run", { writeSelection: { objectIds: ["X"], molecules: [], pageId } });

  check(outcome.first?.allowed, `first write to the selected X was refused: ${outcome.first?.message}`);
  check(outcome.second?.allowed, "second write to the selected X was refused (the SDK's pin no longer resolves after a " +
    `write committed through another chem-core copy): ${outcome.second?.message}`);
  check(outcome.impostor, "the command never reached the impostor write");
  check(!outcome.impostor.allowed, "a write to a same-id impostor of the selected X was allowed (pins matched by id, not identity)");
  check(commits === 2, `expected exactly 2 committed writes, saw ${commits}`);
  check(findX(current) === impostor, "the refused impostor write still changed the document");
  check(impostor.x === 20, `the impostor should carry the second write's x (20), found ${impostor.x}`);

  // Both copies use the one runtime published on globalThis.
  const runtime = globalThis[RUNTIME_KEY];
  check(runtime && Object.isFrozen(runtime) && typeof runtime.holds === "function",
    "no frozen identity runtime is published on globalThis");
  const probe = findX(current);
  check(runtime.holds(probe, chemCore.objectIdentity(probe)), "the embedder's chem-core does not use the published runtime");

  console.log("sdk-identity smoke: PASS — two writes through another chem-core copy kept the SDK's Send-time pin; " +
    `the same-id impostor was refused (${outcome.impostor.message}).`);
}

try {
  await run();
  process.exit(0);
} catch (error) {
  if (error instanceof SmokeFailure) {
    console.error(`sdk-identity smoke: FAIL — ${error.message}`);
  } else {
    console.error("sdk-identity smoke: FAIL — unexpected error:");
    console.error(error);
  }
  process.exit(1);
}
