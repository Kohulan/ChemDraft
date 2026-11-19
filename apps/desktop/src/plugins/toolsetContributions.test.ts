import { describe, expect, it } from "vitest";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { createPluginRuntime } from "./createPluginRuntime";
import { createToolbarCatalog } from "../toolbars/toolbarCatalog";
import {
  FIXTURE_PLUGIN_ID,
  FIXTURE_PLUGIN_PING_COMMAND_ID,
  FIXTURE_PLUGIN_TOOLSET_ID,
  createFixturePluginOptions,
  fixturePluginManifest
} from "./fixturePlugin";

// Main's original desktop-runtime suite (pluginRuntime.test.ts on the pre-union trunk), repointed at
// the union runtime: the toolset-contribution stage now lives in createPluginRuntime, and these six
// tests pin its contract — registration + routing, catalog composition, ui.toolbar enforcement with
// whole-plugin rollback, persisted-layout pruning, selection/panel context wiring, change notification.
const makeRuntime = () =>
  createPluginRuntime({ commandRegistry: new CommandRegistry(), getActiveDocument: () => undefined });

describe("desktop plugin runtime + toolbar catalog", () => {
  it("registers the fixture plugin's toolset and routes its command via the host", async () => {
    const runtime = makeRuntime();
    let pinged = false;
    runtime.registerPlugin(fixturePluginManifest, createFixturePluginOptions(() => {
      pinged = true;
    }));

    expect(runtime.listPluginToolsets().map((toolset) => toolset.id)).toContain(FIXTURE_PLUGIN_TOOLSET_ID);
    expect(runtime.pluginIdForToolset(FIXTURE_PLUGIN_TOOLSET_ID)).toBe(FIXTURE_PLUGIN_ID);

    await runtime.host.invokeCommand(FIXTURE_PLUGIN_PING_COMMAND_ID);
    expect(pinged).toBe(true);
  });

  it("composes plugin toolsets alongside core toolsets in the catalog", () => {
    const runtime = makeRuntime();
    runtime.registerPlugin(fixturePluginManifest, createFixturePluginOptions());

    const catalog = createToolbarCatalog();
    expect(catalog.registry().get(FIXTURE_PLUGIN_TOOLSET_ID)).toBeUndefined();

    catalog.setPluginToolsets(runtime.listPluginToolsets());
    expect(catalog.registry().get(FIXTURE_PLUGIN_TOOLSET_ID)).toBeDefined();
    // Core toolsets are still present.
    expect(catalog.registry().get("core.main")).toBeDefined();
  });

  it("offers only plugin commands with handlers, including disabled commands with handlers", () => {
    const registry = new CommandRegistry();
    const runtime = createPluginRuntime({ commandRegistry: registry, getActiveDocument: () => undefined });
    const enabledId = "plugin.gallery.run";
    const disabledId = "plugin.gallery.disabled";
    const unhandledId = "plugin.gallery.unhandled";
    runtime.registerPlugin({
      id: "org.chemdraft.gallery",
      name: "Gallery Test",
      version: "0.0.0",
      apiVersion: "^0.1.0",
      entry: "dev",
      permissions: [],
      contributes: { commands: [
        { id: enabledId, title: "Run" },
        { id: disabledId, title: "Disabled", enabled: false },
        { id: unhandledId, title: "Unhandled" }
      ] }
    }, { commandHandlers: { [enabledId]: () => undefined, [disabledId]: () => undefined } });

    const catalog = createToolbarCatalog();
    catalog.setPluginToolsets(runtime.listPluginToolsets(), runtime.listPluginCommandsWithHandlers());
    expect(registry.get(unhandledId)?.enabled).toBe(false);
    expect(catalog.baseCommands().filter(command => command.id.startsWith("plugin.gallery."))
      .map(({ id, enabled }) => ({ id, enabled }))).toEqual([
      { id: enabledId, enabled: true },
      { id: disabledId, enabled: false }
    ]);
  });

  it("enforces ui.toolbar and rolls the plugin back when a toolset is contributed without it", () => {
    const runtime = makeRuntime();
    const withoutPermission = { ...fixturePluginManifest, id: "org.chemdraft.fixture.bad", permissions: [] };

    expect(() => runtime.registerPlugin(withoutPermission, createFixturePluginOptions())).toThrow(/ui\.toolbar/);
    expect(runtime.host.getPlugin("org.chemdraft.fixture.bad")).toBeUndefined();
    expect(runtime.listPluginToolsets()).toHaveLength(0);
  });

  it("prunes unknown commands from persisted layout state instead of throwing", () => {
    const catalog = createToolbarCatalog();
    catalog.setLayoutState({
      version: 1,
      toolsetOverrides: [{ toolsetId: "core.main", hiddenCommandIds: ["command.that.was.removed"] }],
      userToolsets: []
    });

    // Startup survives; core.main is still there.
    expect(catalog.registry().get("core.main")).toBeDefined();
  });

  it("replays saved additions when a plugin and its commands return", () => {
    const runtime = makeRuntime();
    const catalog = createToolbarCatalog();
    const register = () => {
      runtime.registerPlugin(fixturePluginManifest, createFixturePluginOptions());
      catalog.setPluginToolsets(runtime.listPluginToolsets());
    };
    register();
    const pluginGroupId = catalog.registry().require(FIXTURE_PLUGIN_TOOLSET_ID).groups[0]!.id;
    expect(pluginGroupId).toBeTruthy();
    const mainGroupId = catalog.registry().require("core.main").groups[0]!.id;
    catalog.setLayoutState({
      version: 1,
      userToolsets: [],
      toolsetOverrides: [
        {
          toolsetId: FIXTURE_PLUGIN_TOOLSET_ID,
          itemAdditions: [{ groupId: pluginGroupId, item: { commandId: "edit.undo" } }]
        },
        {
          toolsetId: "core.main",
          itemAdditions: [{ groupId: mainGroupId, item: { commandId: FIXTURE_PLUGIN_PING_COMMAND_ID } }]
        }
      ]
    });
    const commandIds = (toolsetId: string) => catalog.registry().require(toolsetId).groups
      .flatMap((group) => group.items.map((item) => item.commandId));
    expect(commandIds(FIXTURE_PLUGIN_TOOLSET_ID)).toContain("edit.undo");
    expect(commandIds("core.main")).toContain(FIXTURE_PLUGIN_PING_COMMAND_ID);

    runtime.unregisterPlugin(FIXTURE_PLUGIN_ID);
    catalog.setPluginToolsets(runtime.listPluginToolsets());
    expect(catalog.registry().get(FIXTURE_PLUGIN_TOOLSET_ID)).toBeUndefined();
    expect(commandIds("core.main")).not.toContain(FIXTURE_PLUGIN_PING_COMMAND_ID);

    register();
    expect(catalog.registry().require(FIXTURE_PLUGIN_TOOLSET_ID).groups[0]!.id).toBe(pluginGroupId);
    expect(commandIds(FIXTURE_PLUGIN_TOOLSET_ID)).toContain("edit.undo");
    expect(commandIds("core.main")).toContain(FIXTURE_PLUGIN_PING_COMMAND_ID);
  });

  it.each(["stable", "legacy"] as const)("keeps additions addressed by %s group IDs across plugin group changes", idKind => {
    const runtime = makeRuntime();
    const catalog = createToolbarCatalog();
    const toolset = fixturePluginManifest.contributes.toolsets[0];
    const original = { ...toolset.groups[0], id: undefined };
    const named = { ...original, id: "plugin.fixture.named" };
    const unnamed = { ...original, title: "Another group" };
    const manifestWithGroups = (groups: (typeof original | typeof named)[]) => ({
      ...fixturePluginManifest,
      contributes: { ...fixturePluginManifest.contributes, toolsets: [{ ...toolset, groups }] }
    });
    const options = createFixturePluginOptions();
    runtime.registerPlugin(manifestWithGroups([original]), options);
    catalog.setPluginToolsets(runtime.listPluginToolsets(), runtime.listPluginCommandsWithHandlers());
    const toolsetId = FIXTURE_PLUGIN_TOOLSET_ID;
    const stableId = catalog.registry().require(toolsetId).groups[0].id!;
    const groupId = idKind === "stable" ? stableId : `${toolsetId}.group.0`;
    const saved = { version: 1, toolsetOverrides: [{
      toolsetId, groupOrder: [groupId],
      itemOrder: { [groupId]: ["edit.undo", FIXTURE_PLUGIN_PING_COMMAND_ID] },
      itemAdditions: [{ groupId, item: { commandId: "edit.undo" } }]
    }] };
    const assertCustomizedGroup = () => {
      const groups = catalog.registry().require(toolsetId).groups;
      expect(groups[0].id).toBe(stableId);
      expect(groups[0].items.map(item => item.commandId)).toEqual(["edit.undo", ...original.items.map(item => item.commandId)]);
    };
    catalog.setLayoutState(saved);
    assertCustomizedGroup();
    for (const groups of [[named, original, unnamed], [unnamed, named, original], [unnamed, original]]) {
      runtime.replacePlugin(FIXTURE_PLUGIN_ID, manifestWithGroups(groups), options);
      catalog.setPluginToolsets(runtime.listPluginToolsets(), runtime.listPluginCommandsWithHandlers());
      assertCustomizedGroup();
    }
    expect(saved.toolsetOverrides[0].itemAdditions[0].groupId).toBe(groupId);
  });

  it("forwards selection and panel wiring to plugin command handlers", async () => {
    const runtime = createPluginRuntime({
      commandRegistry: new CommandRegistry(),
      getActiveDocument: () => undefined,
      getSelection: () => ({
        objectIds: ["m1"],
        // sourceFingerprint is required on the union's extended PluginSelectedMolecule (M4/D-09);
        // main's original fake omitted it.
        molecules: [{ objectId: "m1", structureFormat: "smiles", structure: "c1ccccc1", sourceFingerprint: "fp-m1" }]
      })
    });

    const manifest = {
      id: "org.chemdraft.surfaces",
      name: "Surfaces",
      version: "0.0.0",
      apiVersion: "^0.1.0",
      entry: "dev",
      permissions: ["selection.read", "ui.panel"],
      contributes: {
        commands: [
          {
            id: "plugin.surfaces.run",
            title: "Run",
            requiredPermissions: ["selection.read", "ui.panel"],
            enabled: true
          }
        ],
        panels: [{ id: "panel.surfaces.result", title: "Result" }]
      }
    };

    let seenStructure = "";
    runtime.registerPlugin(manifest, {
      commandHandlers: {
        "plugin.surfaces.run": async (context) => {
          const selection = await context.selection?.getSelection();
          seenStructure = selection?.molecules[0]?.structure ?? "";
          await context.panels?.showReport("panel.surfaces.result", {
            title: "Result",
            sections: [{ kind: "text", body: "ok" }]
          });
          return { ok: true };
        }
      }
    });

    await runtime.host.invokeCommand("plugin.surfaces.run");
    expect(seenStructure).toBe("c1ccccc1");
    // The union runtime routes reports through the panel controller rather than a bare callback
    // (main's original asserted a showPanelReport spy); the report surfaces as the open panel.
    expect(runtime.panels.getOpenPanel()?.panelId).toBe("panel.surfaces.result");
  });

  it("restores the previous registration when a same-id replacement fails", async () => {
    const runtime = makeRuntime();
    let originalRuns = 0;
    runtime.registerPlugin(
      fixturePluginManifest,
      createFixturePluginOptions(() => {
        originalRuns += 1;
      })
    );
    const invalidReplacement = { ...fixturePluginManifest, permissions: [] };

    expect(() => runtime.replacePlugin(FIXTURE_PLUGIN_ID, invalidReplacement, createFixturePluginOptions())).toThrow(
      /ui\.toolbar/
    );

    expect(runtime.host.getPlugin(FIXTURE_PLUGIN_ID)).toBeDefined();
    expect(runtime.listPluginToolsets().map((toolset) => toolset.id)).toContain(FIXTURE_PLUGIN_TOOLSET_ID);
    await runtime.host.invokeCommand(FIXTURE_PLUGIN_PING_COMMAND_ID);
    expect(originalRuns).toBe(1);
  });

  it("notifies listeners when plugin toolsets change", () => {
    const runtime = makeRuntime();
    const catalog = createToolbarCatalog();
    let changes = 0;
    catalog.onDidChange(() => {
      changes++;
    });

    runtime.registerPlugin(fixturePluginManifest, createFixturePluginOptions());
    catalog.setPluginToolsets(runtime.listPluginToolsets());
    expect(changes).toBe(1);
  });
});
