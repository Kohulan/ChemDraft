import { editShortcut, normalizeShortcut, parseShortcutDisplay, resolveHoverKey } from "@chemdraft/shortcut-engine";
import { describe, expect, it } from "vitest";
import { buildAppMenuModel, flattenAppMenuCommands } from "./appMenu";
import { createLayerActions, createQuickActions } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { withStandaloneDrawingToolCommands } from "./drawingTools";
import { capturedShortcut, keyboardShortcutActions, nativeMenuShortcutOverrides } from "./customKeyboardShortcuts";
import { applyKeybindingSchemeToCommands, createHoverShortcutTables } from "./keybindingScheme";
import { DEFAULT_KEYBINDING_SETTINGS, LEGACY_DEFAULT_KEYBINDING_SCHEME } from "./keybindingSettings";
import {
  createDesktopShortcutRegistry,
  createMainWindowShortcutCommands,
  enableLastDocumentCloseAction,
  isBrowserReloadChord
} from "./keyboardShortcuts";
import { desktopToolsetRegistry, getToolsetCommandSpecs } from "./toolsets";

describe("document window shortcuts", () => {
  // Every accelerator the menu advertises must reach its command through the document window's own
  // registry. On macOS an unclaimed key still reaches the native menu's accelerator, so a gap here was
  // invisible; WebView2 on Windows never forwards it, so the same gap is a dead shortcut there.
  it.each([
    ["windows", "chemdraft"],
    ["windows", "chemdraw"],
    ["macos", "chemdraft"],
    ["macos", "chemdraw"]
  ] as const)("binds every menu accelerator to its command (%s, %s scheme)", (platform, scheme) => {
    const document = createPhase4Document("Shortcuts");
    const toolCommandSpecs = applyKeybindingSchemeToCommands(
      withStandaloneDrawingToolCommands(getToolsetCommandSpecs(desktopToolsetRegistry)),
      scheme
    );
    const commands = createMainWindowShortcutCommands(
      {
        quickActions: createQuickActions(document, undefined, { canUndo: true, canRedo: true }),
        layerActions: createLayerActions(document),
        toolCommandSpecs
      },
      scheme
    );
    // Enabled-ness is state, not binding: Group is disabled until two objects are selected, and the
    // question here is whether its chord would reach it at all.
    const registry = createDesktopShortcutRegistry(commands, { platform, includeDisabled: true });
    // Enter commits atom labels and paths, but has no global text-reopening binding.
    // T activates the registered Text tool; existing text is edited by a canvas click.
    expect(registry.resolve({ key: "Enter" })).toBeUndefined();
    const menu = buildAppMenuModel({
      rulersVisible: true,
      crosshairsVisible: true,
      canUndo: true,
      canRedo: true,
      hasSelection: true,
      hasSelectedMolecule: true,
      toolbars: [],
      platform,
      keybindingScheme: scheme
    });

    const accelerated = flattenAppMenuCommands(menu).filter((item) => item.accelerator);
    expect(accelerated.length).toBeGreaterThan(10);
    const unbound = accelerated.flatMap((item) => {
      const chord = normalizeShortcut({ commandId: item.commandId, keys: parseShortcutDisplay(item.accelerator!) }, platform);
      const resolved = registry.resolve({
        key: chord.key,
        ctrlKey: chord.modifiers.includes("Ctrl"),
        altKey: chord.modifiers.includes("Alt"),
        shiftKey: chord.modifiers.includes("Shift"),
        metaKey: chord.modifiers.includes("Meta")
      });
      return resolved === item.commandId ? [] : [`${item.accelerator} → ${resolved ?? "nothing"} (menu: ${item.commandId})`];
    });
    expect(unbound).toEqual([]);
    expect(registry.resolve({ key: ",", ...(platform === "macos" ? { metaKey: true } : { ctrlKey: true }) }))
      .toBe("view.togglePreferences");
  });
});

describe.each(["windows", "macos"] as const)("default scheme for new installs (%s)", platform => {
  // The default only reaches new installs: shortcutDefaultMigration.ts pins existing ones to
  // LEGACY_DEFAULT_KEYBINDING_SCHEME first. What the default resolves to must hold on both platforms.
  it("binds the industry-standard keys in the document window", () => {
    const document = createPhase4Document("Default scheme");
    const scheme = DEFAULT_KEYBINDING_SETTINGS.scheme;
    const commands = createMainWindowShortcutCommands({
      quickActions: createQuickActions(document, undefined, { canUndo: true, canRedo: true }),
      layerActions: createLayerActions(document),
      toolCommandSpecs: applyKeybindingSchemeToCommands(
        withStandaloneDrawingToolCommands(getToolsetCommandSpecs(desktopToolsetRegistry)), scheme)
    }, scheme, undefined, platform);
    const registry = createDesktopShortcutRegistry(commands, { platform, includeDisabled: true });
    expect(registry.resolve({ key: "x" })).toBe("tool.bond");
    expect(registry.resolve({ key: " " })).toBe("tool.select");
    expect(registry.resolve({ key: ";", ...(platform === "macos" ? { metaKey: true } : { ctrlKey: true }) }))
      .toBe("view.toggleRulers");
    expect(createHoverShortcutTables(scheme).atom.get("b")).toBe("atom.setHoveredElement.Br");
  });

  it("leaves the old default on ChemDraft's own keys", () => {
    const legacy = keyboardShortcutActions(LEGACY_DEFAULT_KEYBINDING_SCHEME, platform);
    expect(legacy.find(action => action.id === "tool.bond")?.defaults).not.toContain("X");
    expect(createHoverShortcutTables(LEGACY_DEFAULT_KEYBINDING_SCHEME).atom.get("b")).toBe("atom.setHoveredElement.B");
  });
});

describe("isBrowserReloadChord", () => {
  it("recognises WebView2's reload accelerators off macOS", () => {
    for (const platform of ["windows", "linux"] as const) {
      expect(isBrowserReloadChord({ key: "F5" }, platform)).toBe(true);
      expect(isBrowserReloadChord({ key: "F5", ctrlKey: true }, platform)).toBe(true);
      expect(isBrowserReloadChord({ key: "BrowserRefresh" }, platform)).toBe(true);
      expect(isBrowserReloadChord({ key: "r", ctrlKey: true }, platform)).toBe(true);
      // Ctrl+Shift+R is a hard reload; Shift turns the key upper-case.
      expect(isBrowserReloadChord({ key: "R", ctrlKey: true }, platform)).toBe(true);
    }
  });

  it("leaves ordinary typing and other chords alone", () => {
    expect(isBrowserReloadChord({ key: "r" }, "windows")).toBe(false);
    expect(isBrowserReloadChord({ key: "R" }, "windows")).toBe(false);
    expect(isBrowserReloadChord({ key: "s", ctrlKey: true }, "windows")).toBe(false);
    // AltGr arrives as Ctrl+Alt on Windows; AltGr+R types a character on some layouts.
    expect(isBrowserReloadChord({ key: "r", ctrlKey: true, altKey: true }, "windows")).toBe(false);
    expect(isBrowserReloadChord({ key: "r", ctrlKey: true, metaKey: true }, "windows")).toBe(false);
  });

  it("never fires on macOS, where WKWebView has no reload accelerator", () => {
    expect(isBrowserReloadChord({ key: "F5" }, "macos")).toBe(false);
    expect(isBrowserReloadChord({ key: "r", ctrlKey: true }, "macos")).toBe(false);
  });
});

describe("last document close command", () => {
  it("enables Close Document Tab on Windows and Linux, not on macOS", () => {
    const document = createPhase4Document();
    const actions = createQuickActions(document, undefined, { hasMultipleTabs: false });
    const closeKey = { key: "w", ctrlKey: true };

    for (const platform of ["windows", "linux"] as const) {
      const enabled = enableLastDocumentCloseAction(actions, platform);
      expect(createDesktopShortcutRegistry(enabled, platform).resolve(closeKey)).toBe("document.closeTab");
      expect(enabled.find((action) => action.id === "document.closeTab")).toMatchObject({ enabled: true });
    }

    const macos = enableLastDocumentCloseAction(actions, "macos");
    expect(createDesktopShortcutRegistry(macos, "macos").resolve({ key: "w", metaKey: true })).toBeUndefined();
    expect(macos.find((action) => action.id === "document.closeTab")).toMatchObject({ enabled: false });
  });
});

describe.each(["windows", "macos"] as const)("custom keyboard shortcuts (%s)", platform => {
  it("applies overrides to the window registry, menus, and hovered targets", () => {
    const scheme = "chemdraw";
    const actions = keyboardShortcutActions(scheme, platform);
    const save = actions.find(action => action.id === "document.save")!;
    const bond = actions.find(action => action.id === "tool.bond")!;
    const bromine = actions.find(action => action.id === "atom.setHoveredElement.Br")!;
    const boron = actions.find(action => action.id === "atom.setHoveredElement.B")!;
    expect(bromine.defaults).toEqual(["b"]);
    expect(boron.defaults).toEqual(["B"]);
    expect(actions.every(action => !action.title.startsWith("atom.") && !action.title.startsWith("bond."))).toBe(true);
    const overrides = { commands: { [save.id]: ["Mod+F9"], [bond.id]: ["F10"] }, atom: { [bromine.id]: ["D"] } };
    const document = createPhase4Document("Custom shortcuts");
    const commands = createMainWindowShortcutCommands({
      quickActions: createQuickActions(document, undefined),
      layerActions: createLayerActions(document),
      toolCommandSpecs: withStandaloneDrawingToolCommands(getToolsetCommandSpecs())
    }, scheme, overrides, platform);
    const registry = createDesktopShortcutRegistry(commands, { platform, overrides });
    const mod = platform === "macos" ? { metaKey: true } : { ctrlKey: true };
    expect(registry.resolve({ key: "F9", ...mod })).toBe(save.id);
    expect(registry.resolve({ key: "s", ...mod })).toBeUndefined();
    expect(registry.resolve({ key: "F10" })).toBe(bond.id);
    expect(registry.resolve({ key: "x" })).not.toBe(bond.id);
    const menu = buildAppMenuModel({
      rulersVisible: true, crosshairsVisible: true, canUndo: true, canRedo: true,
      hasSelection: true, hasSelectedMolecule: true, toolbars: [], platform,
      keybindingScheme: scheme, keybindingOverrides: overrides
    });
    expect(flattenAppMenuCommands(menu).find(item => item.commandId === save.id)).toMatchObject({
      accelerator: "Mod+F9", shortcut: platform === "macos" ? "⌘F9" : "Ctrl+F9"
    });
    expect(nativeMenuShortcutOverrides(overrides, platform)).toEqual({
      [save.id]: platform === "macos" ? "Cmd+f9" : "Ctrl+f9"
    });
    const hover = createHoverShortcutTables(scheme, overrides);
    expect(hover.atom.get("D")).toBe(bromine.id);
    expect(hover.atom.get("b")).toBeUndefined();
    expect(hover.atom.get("B")).toBe(boron.id);
    const cleared = editShortcut(actions, overrides, save, { kind: "clear" }, platform);
    expect(cleared.kind === "updated" && nativeMenuShortcutOverrides(cleared.overrides, platform)).toEqual({ [save.id]: null });
  });

  // + and - each name a hover charge command and, in the ChemDraft scheme, a charge tool. The
  // pairs are intended (hover acts on the atom; no hover picks the tool), so the Preferences conflict
  // check must treat + exactly as it treats -: the shipped defaults overlap silently, and binding
  // either key again reports the same one-row conflict. Shift on + must not make it a different chord.
  it("treats the hover +/- charge keys and the charge tools as the same intended pairs", () => {
    const actions = keyboardShortcutActions("chemdraft", platform);
    const pairs = [
      { hover: "atom.addPositiveChargeToHoveredAtom", tool: "tool.plus", key: "+" },
      { hover: "atom.addNegativeChargeToHoveredAtom", tool: "tool.minus", key: "-" }
    ];
    const outcome = (id: string, scope: "atom" | "commands", edit: Parameters<typeof editShortcut>[3]) => {
      const action = actions.find(candidate => candidate.id === id && candidate.scope === scope)!;
      const result = editShortcut(actions, {}, action, edit, platform);
      return result.kind === "conflict" ? { kind: result.kind, with: result.actions.map(other => other.id) } : { kind: result.kind };
    };
    const results = pairs.map(({ hover, tool, key }) => {
      expect(actions.find(action => action.id === hover)).toMatchObject({ scope: "atom", defaults: [key] });
      expect(actions.find(action => action.id === tool)).toMatchObject({ scope: "commands", defaults: [key] });
      return {
        resetHover: outcome(hover, "atom", { kind: "reset" }),
        resetTool: outcome(tool, "commands", { kind: "reset" }),
        assignHover: outcome(hover, "atom", { kind: "assign", key }),
        assignTool: outcome(tool, "commands", { kind: "assign", key })
      };
    });
    expect(results[0]).toEqual({
      resetHover: { kind: "updated" }, resetTool: { kind: "updated" },
      assignHover: { kind: "conflict", with: ["tool.plus"] },
      assignTool: { kind: "conflict", with: ["atom.addPositiveChargeToHoveredAtom"] }
    });
    expect(results[1]).toEqual({
      resetHover: { kind: "updated" }, resetTool: { kind: "updated" },
      assignHover: { kind: "conflict", with: ["tool.minus"] },
      assignTool: { kind: "conflict", with: ["atom.addNegativeChargeToHoveredAtom"] }
    });
    // Both live tables still hold both keys: the hover table literally, the window registry by chord.
    const hover = createHoverShortcutTables("chemdraft");
    expect(hover.atom.get("+")).toBe("atom.addPositiveChargeToHoveredAtom");
    expect(hover.atom.get("-")).toBe("atom.addNegativeChargeToHoveredAtom");
    const document = createPhase4Document("Charge keys");
    const registry = createDesktopShortcutRegistry(createMainWindowShortcutCommands({
      quickActions: createQuickActions(document, undefined),
      layerActions: createLayerActions(document),
      toolCommandSpecs: withStandaloneDrawingToolCommands(getToolsetCommandSpecs())
    }, "chemdraft", undefined, platform), { platform });
    expect(registry.resolve({ key: "+", code: "Equal", shiftKey: true })).toBe("tool.plus");
    expect(registry.resolve({ key: "+", code: "NumpadAdd" })).toBe("tool.plus");
    expect(registry.resolve({ key: "-", code: "Minus" })).toBe("tool.minus");
    // Shift+= reported as "=" (some macOS input paths): the window registry folds it into the tool's
    // + chord, so with nothing hovered it picks the tool; the hover lookup reads the same press as
    // the hover table's literal "+", so over an atom the hover action wins.
    const shiftedEqual = { key: "=", code: "Equal", shiftKey: true };
    expect(registry.resolve(shiftedEqual)).toBe("tool.plus");
    expect(resolveHoverKey(shiftedEqual, key => hover.atom.get(key)))
      .toEqual({ key: "+", match: "atom.addPositiveChargeToHoveredAtom" });
    expect(resolveHoverKey({ key: "=", code: "Equal" }, key => hover.atom.get(key)).match).toBeUndefined();
  });

  it("records Shift+= as + for a hover action, however the press reports it", () => {
    const press = (init: { key: string; code: string; shiftKey?: boolean }) =>
      ({ ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...init }) as KeyboardEvent;
    expect(capturedShortcut("Shift+=", press({ key: "=", code: "Equal", shiftKey: true }), "atom", platform)).toEqual({ key: "+" });
    expect(capturedShortcut("Shift+=", press({ key: "+", code: "Equal", shiftKey: true }), "atom", platform)).toEqual({ key: "+" });
    expect(capturedShortcut("=", press({ key: "=", code: "Equal" }), "atom", platform)).toEqual({ key: "=" });
  });

  it("includes and clears the Windows redo alternate with its action", () => {
    const redo = keyboardShortcutActions("chemdraft", platform).find(action => action.id === "edit.redo");
    expect(redo?.defaults.includes("Ctrl+Y")).toBe(platform === "windows");
    const overrides = { commands: { "edit.redo": [] } };
    const commands = applyKeybindingSchemeToCommands([
      { id: "edit.redo", title: "Redo", icon: "redo", source: "core", shortcut: "Mod+Shift+Z" }
    ], "chemdraft", overrides, platform);
    expect(createDesktopShortcutRegistry(commands, { platform, overrides }).resolve({ key: "y", ctrlKey: true })).toBeUndefined();
  });
});
