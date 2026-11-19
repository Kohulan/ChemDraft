import { describe, expect, it, vi } from "vitest";
import { applyToolsetLayoutState, parseToolsetLayoutState, type ToolsetLayoutState } from "@chemdraft/toolset-registry";
import { MAIN_TOOLBAR_DEFAULTS_REVISION, mergeVisibilityIntoLayoutState, withCurrentMainToolbarDefaults } from "./toolbarLayoutState";
import { createToolbarCatalog } from "./toolbarCatalog";
import { createDesktopToolsetRegistry, desktopToolsets, getToolsetItemGroups, migrateMainToolbarDefaultsLayoutState } from "../toolsets";
import { addToolsetItemAddition, emptyLayoutState, removeToolsetItem, resetAllLayouts, resetToolsetLayout, setItemHidden } from "./CustomizeToolbars/layoutStateEdits";

describe("mergeVisibilityIntoLayoutState", () => {
  it("records visibility for every known toolset and stays schema-valid", () => {
    const state = mergeVisibilityIntoLayoutState(undefined, ["core.main", "core.art"], new Set(["core.main"]));
    expect(state.toolsetOverrides).toEqual([
      { toolsetId: "core.main", visible: true },
      { toolsetId: "core.art", visible: false }
    ]);
    // Round-trips through the loader's schema (what Rust reads back).
    expect(() => parseToolsetLayoutState(state)).not.toThrow();
    expect(parseToolsetLayoutState(state).mainToolbarDefaultsRevision).toBe(MAIN_TOOLBAR_DEFAULTS_REVISION);
  });

  it("updates visibility without clobbering other customization on the same override", () => {
    const existing: ToolsetLayoutState = {
      version: 1,
      toolsetOverrides: [{ toolsetId: "core.main", visible: false, title: "Renamed", hiddenCommandIds: ["tool.bond"] }],
      userToolsets: []
    };
    const merged = mergeVisibilityIntoLayoutState(existing, ["core.main"], new Set(["core.main"]));
    expect(merged.toolsetOverrides[0]).toEqual({
      toolsetId: "core.main",
      visible: true,
      title: "Renamed",
      hiddenCommandIds: ["tool.bond"]
    });
  });

  it("preserves the top-level toolset order while saving visibility", () => {
    const existing: ToolsetLayoutState = {
      version: 1,
      toolsetOrder: ["core.art", "core.main"],
      toolsetOverrides: [],
      userToolsets: []
    };

    const merged = mergeVisibilityIntoLayoutState(existing, ["core.main", "core.art"], new Set(["core.main"]));

    expect(merged.toolsetOrder).toEqual(["core.art", "core.main"]);
    expect(merged.toolsetOrder).not.toBe(existing.toolsetOrder);
  });

  it("hides a customized toolset while preserving its other customization", () => {
    const existing: ToolsetLayoutState = {
      version: 1,
      toolsetOverrides: [{ toolsetId: "core.main", visible: true, title: "Renamed", hiddenCommandIds: ["tool.bond"] }],
      userToolsets: []
    };
    const merged = mergeVisibilityIntoLayoutState(existing, ["core.main"], new Set());
    expect(merged.toolsetOverrides[0]).toEqual({
      toolsetId: "core.main",
      visible: false,
      title: "Renamed",
      hiddenCommandIds: ["tool.bond"]
    });
  });

  it("preserves overrides for toolsets that aren't in the passed id list (unloaded or unresolved plugins)", () => {
    // This is the mechanism the MainWindow visibility save relies on to avoid clobbering a
    // just-appeared plugin toolset's saved visible:true: exclude it from the id list and its
    // override is carried through untouched.
    const existing: ToolsetLayoutState = {
      version: 1,
      toolsetOverrides: [{ toolsetId: "plugin.absent", visible: true }],
      userToolsets: []
    };
    const merged = mergeVisibilityIntoLayoutState(existing, ["core.main"], new Set());
    expect(merged.toolsetOverrides).toContainEqual({ toolsetId: "plugin.absent", visible: true });
    expect(merged.toolsetOverrides).toContainEqual({ toolsetId: "core.main", visible: false });
  });
});

describe("live toolbar layout rebuild", () => {
  it.each([undefined, MAIN_TOOLBAR_DEFAULTS_REVISION])("skips invalid saved additions only in the registry (revision %s)", revision => {
    const catalog = createToolbarCatalog();
    const toolsetId = "core.main";
    const groupId = catalog.registry().require(toolsetId).groups[0].id!;
    const malformedId = "atom.problem.open.mol%2E1.a0";
    const unknownId = "plugin.uninstalled.run";
    const saved = {
      version: 1, mainToolbarDefaultsRevision: revision, toolsetOverrides: [{
        toolsetId,
        itemOrder: { [groupId]: ["edit.undo", malformedId, "edit.redo"] },
        itemAdditions: [
          { groupId, item: { commandId: "edit.undo" } },
          { groupId, item: { id: malformedId, primary: { type: "command", commandId: malformedId } } },
          { groupId, item: { commandId: "edit.redo" } },
          { groupId, item: { commandId: unknownId } }
        ]
      }]
    };
    const before = structuredClone(saved);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => parseToolsetLayoutState(saved)).toThrow();
      expect(() => catalog.setLayoutState(saved)).not.toThrow();
      expect(() => catalog.setPluginToolsets([])).not.toThrow();
      const ids = getToolsetItemGroups(toolsetId, catalog.registry()).flat().map(item => item.id);
      expect(ids.slice(0, 2)).toEqual(["edit.undo", "edit.redo"]);
      expect(ids).toContain("tool.bond");
      expect(ids).not.toContain(malformedId);
      expect(ids).not.toContain(unknownId);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(malformedId));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(unknownId));
      expect(saved).toEqual(before);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("Main toolbar defaults migration", () => {
  it.each([undefined, 1, 2])("preserves a saved standalone Wavy button without duplicates (revision %s)", revision => {
    const state = { version: 1, mainToolbarDefaultsRevision: revision, userToolsets: [], toolsetOverrides: [{
      toolsetId: "core.main",
      itemOrder: { "core.main.items": ["tool.wavyBond", "tool.bond"] },
      itemAdditions: [{ groupId: "core.main.items", index: 0, item: {
        id: "tool.wavyBond", commandId: "tool.wavyBond", title: "Wavy bond", icon: "wavyBond"
      } }]
    }] };
    const migrated = migrateMainToolbarDefaultsLayoutState(state);
    const items = getToolsetItemGroups("core.main", createDesktopToolsetRegistry(migrated)).flat();
    expect(items.filter(item => item.id === "tool.wavyBond")).toHaveLength(1);
    expect(items[0].id).toBe("tool.wavyBond");
    const loaded = migrateMainToolbarDefaultsLayoutState(JSON.parse(JSON.stringify(migrated)));
    expect(getToolsetItemGroups("core.main", createDesktopToolsetRegistry(loaded)).flat()).toEqual(items);
  });
  const migrate = (state: unknown): ToolsetLayoutState => parseToolsetLayoutState(migrateMainToolbarDefaultsLayoutState(state));
  const ids = (state: ToolsetLayoutState) => getToolsetItemGroups("core.main", createDesktopToolsetRegistry(state)).flat().map(item => item.id);
  const defaults = getToolsetItemGroups("core.main").flat().map(item => item.id);
  const oldDefaults = defaults.filter(id => id !== "tool.doubleBond" && id !== "tool.tripleBond");
  oldDefaults.splice(oldDefaults.indexOf("tool.benzene"), 0, "tool.chain");

  it("uses new defaults without a Main override, including customization of another toolset", () => {
    for (const state of [emptyLayoutState(), setItemHidden(emptyLayoutState(), "core.art", "tool.art.pen", true)]) {
      const migrated = migrate(state);
      expect(ids(migrated)).toEqual(defaults);
      expect(migrated.mainToolbarDefaultsRevision).toBe(MAIN_TOOLBAR_DEFAULTS_REVISION);
      expect(migrated.toolsetOverrides).toEqual(state.toolsetOverrides);
    }
  });

  it.each([
    { toolsetId: "core.main", visible: true },
    { toolsetId: "core.main", title: "My toolbar", mode: "floating", preferredWindowSize: { width: 500, height: 80 } }
  ])("uses new defaults for a non-layout override: %j", override => {
    const migrated = migrate({ ...emptyLayoutState(), toolsetOverrides: [override] });
    expect(ids(migrated)).toEqual(defaults);
    expect(migrated.toolsetOverrides).toEqual([override]);
  });

  it.each([
    { toolsetId: "core.main", hiddenCommandIds: ["tool.eraser"] },
    { toolsetId: "core.main", itemOrder: { "core.main.items": ["tool.chain", "tool.select"] } },
    { toolsetId: "core.main", itemOverrides: [{ commandId: "tool.eraser", hidden: true }] },
    { toolsetId: "core.main", itemAdditions: [{ groupId: "core.main.items", index: 6, item: { id: "user.space.1", kind: "spacer", primary: { type: "none" } } }] }
  ])("preserves the previous toolbar exactly for a layout override: %j", override => {
    const state = { ...emptyLayoutState(), toolsetOverrides: [override] };
    const snapshot = structuredClone(state);
    // Apply the same saved override to an independent pre-change manifest as the reference.
    const main = desktopToolsets.find(toolset => toolset.id === "core.main")!;
    const chain = desktopToolsets.flatMap(toolset => toolset.groups.flatMap(group => group.items))
      .find(item => item.commandId === "tool.chain")!;
    const oldItems = main.groups[0].items.filter(item => !["tool.doubleBond", "tool.tripleBond"].includes(item.commandId ?? ""));
    oldItems.splice(oldItems.findIndex(item => item.commandId === "tool.benzene"), 0, chain);
    const previous = applyToolsetLayoutState([{ ...main, groups: [{ ...main.groups[0], items: oldItems }] }], state);
    const migrated = migrate(state);
    expect(createDesktopToolsetRegistry(migrated).get("core.main")).toEqual(previous[0]);
    expect(ids(migrated)).toContain("tool.chain");
    expect(ids(migrated)).not.toContain("tool.doubleBond");
    expect(ids(migrated)).not.toContain("tool.tripleBond");
    expect(state).toEqual(snapshot);
  });

  it("preserves the previous toolbar for legacy group order", () => {
    const state = { ...emptyLayoutState(), toolsetOverrides: [{ toolsetId: "core.main", groupOrder: ["core.main.structure", "core.main.selection"] }] };
    const result = ids(migrate(state));
    expect(result).toContain("tool.chain");
    expect(result).not.toContain("tool.doubleBond");
    expect(result).not.toContain("tool.tripleBond");
    expect(result.indexOf("tool.chain")).toBeLessThan(result.indexOf("tool.select"));
  });

  it("preserves addition indices and partial orders, including structural additions", () => {
    const state = addToolsetItemAddition(emptyLayoutState(), "core.main", {
      groupId: "core.main.items", index: 6,
      item: { id: "user.space.1", kind: "spacer", primary: { type: "none" } }
    });
    const expected = [...oldDefaults];
    expected.splice(6, 0, "user.space.1");
    expect(ids(migrate(state))).toEqual(expected);
  });

  it("keeps an already hidden Chain hidden and preserves manually added multiple bonds", () => {
    let state = setItemHidden(emptyLayoutState(), "core.main", "tool.chain", true);
    state = addToolsetItemAddition(state, "core.main", {
      groupId: "core.main.items", index: 6,
      item: { commandId: "tool.doubleBond", title: "Double Bond", primary: { type: "command", commandId: "tool.doubleBond" } }
    });
    const migrated = migrate(state);
    expect(ids(migrated)).not.toContain("tool.chain");
    expect(ids(migrated).indexOf("tool.doubleBond")).toBe(6);
    expect(ids(migrated)).not.toContain("tool.tripleBond");
  });

  it("preserves both manually added multiple bonds in a customized layout", () => {
    let state = emptyLayoutState();
    for (const commandId of ["tool.doubleBond", "tool.tripleBond"]) {
      state = addToolsetItemAddition(state, "core.main", {
        groupId: "core.main.items", index: 6,
        item: { commandId, title: commandId, primary: { type: "command", commandId } }
      });
    }
    const result = ids(migrate(state));
    expect(result).toContain("tool.chain");
    expect(result).toContain("tool.doubleBond");
    expect(result).toContain("tool.tripleBond");
  });

  it("is idempotent across serialization and never undoes later removal of Chain or addition of Double Bond", () => {
    const first = migrate(setItemHidden(emptyLayoutState(), "core.main", "tool.eraser", true));
    expect(migrateMainToolbarDefaultsLayoutState(first)).toBe(first);
    expect(migrate(JSON.parse(JSON.stringify(first)))).toEqual(first);
    const edited = setItemHidden(removeToolsetItem(first, "core.main", "tool.chain"), "core.main", "tool.doubleBond", false);
    const reloaded = migrate(JSON.parse(JSON.stringify(edited)));
    expect(ids(reloaded)).not.toContain("tool.chain");
    expect(ids(reloaded)).toContain("tool.doubleBond");
  });

  it("marks newly saved customization and visibility so they are never treated as historical", () => {
    const fresh = withCurrentMainToolbarDefaults(setItemHidden(emptyLayoutState(), "core.main", "tool.eraser", true));
    expect(ids(migrate(fresh))).toEqual(defaults.filter(id => id !== "tool.eraser"));
    const visibility = mergeVisibilityIntoLayoutState(undefined, ["core.main"], new Set(["core.main"]));
    expect(ids(migrate(visibility))).toEqual(defaults);
    expect(mergeVisibilityIntoLayoutState(fresh, ["core.main"], new Set()).mainToolbarDefaultsRevision).toBe(MAIN_TOOLBAR_DEFAULTS_REVISION);
  });

  it("reset-to-default yields the new defaults after relaunch and subsequent visibility saves", () => {
    const migrated = migrate(setItemHidden(emptyLayoutState(), "core.main", "tool.eraser", true));
    for (const reset of [resetToolsetLayout(migrated, "core.main"), withCurrentMainToolbarDefaults(resetAllLayouts())]) {
      expect(ids(migrate(reset))).toEqual(defaults);
      const saved = mergeVisibilityIntoLayoutState(reset, ["core.main"], new Set(["core.main"]));
      expect(ids(migrate(JSON.parse(JSON.stringify(saved))))).toEqual(defaults);
    }
  });

  it.each([false, true])("preserves a revision-1 standalone Triple button and custom order (hidden: %s)", hidden => {
    const previousDefaults = defaults.filter(id => id !== "tool.doubleBond");
    previousDefaults.splice(previousDefaults.indexOf("tool.bond") + 1, 0, "tool.doubleBond", "tool.tripleBond");
    const previousOrder = ["tool.tripleBond", ...previousDefaults.filter(id => id !== "tool.tripleBond")];
    const state = {
      ...emptyLayoutState(), mainToolbarDefaultsRevision: 1,
      toolsetOverrides: [{ toolsetId: "core.main", itemOrder: { "core.main.items": previousOrder },
        hiddenCommandIds: hidden ? ["tool.tripleBond"] : [],
        itemAdditions: [{ groupId: "core.main.items", index: 7,
          item: { id: "user.space.1", kind: "spacer", primary: { type: "none" } } }] }]
    };
    const snapshot = structuredClone(state);
    const migrated = migrate(state);
    expect(ids(migrated)).toEqual([...previousOrder.filter(id => !hidden || id !== "tool.tripleBond"), "user.space.1"]);
    const saved = mergeVisibilityIntoLayoutState(migrated, ["core.main"], new Set(["core.main"]));
    expect(ids(migrate(JSON.parse(JSON.stringify(saved))))).toEqual(ids(migrated));
    expect(ids(migrated).filter(id => id === "tool.tripleBond")).toHaveLength(hidden ? 0 : 1);
    expect(state).toEqual(snapshot);
    expect(migrateMainToolbarDefaultsLayoutState(migrated)).toBe(migrated);
  });

  it("preserves revision-1 addition indices without an explicit saved order", () => {
    const previousDefaults = defaults.filter(id => id !== "tool.doubleBond");
    previousDefaults.splice(previousDefaults.indexOf("tool.bond") + 1, 0, "tool.doubleBond", "tool.tripleBond");
    previousDefaults.splice(7, 0, "user.space.1");
    const state = { ...emptyLayoutState(), mainToolbarDefaultsRevision: 1, toolsetOverrides: [{ toolsetId: "core.main",
      itemAdditions: [{ groupId: "core.main.items", index: 7, item: { id: "user.space.1", kind: "spacer", primary: { type: "none" } } }] }] };
    expect(ids(migrate(state))).toEqual(previousDefaults);
  });

  it("uses the current defaults for revision-1 visibility-only saves and after resetting customization", () => {
    const visibility = { ...emptyLayoutState(), mainToolbarDefaultsRevision: 1, toolsetOverrides: [{ toolsetId: "core.main", visible: true }] };
    expect(ids(migrate(visibility))).toEqual(defaults);
    const customized = migrate({ ...visibility, toolsetOverrides: [{ toolsetId: "core.main", hiddenCommandIds: ["tool.eraser"] }] });
    expect(ids(customized)).toContain("tool.tripleBond");
    expect(ids(migrate(resetToolsetLayout(customized, "core.main")))).toEqual(defaults);
  });
});
