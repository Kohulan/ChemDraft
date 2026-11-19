import { ToolsetRegistry, applyToolsetLayoutState, isValidToolsetCommandId } from "@chemdraft/toolset-registry";
import type { CommandDefinition } from "@chemdraft/plugin-host";
import { allPaletteCommands, type CommandSpec } from "../commands";
import { desktopToolsets, desktopToolsetRegistry, migrateBracketToolbarOrder, type DesktopToolsetDefinition, type DesktopToolsetRegistry } from "../toolsets";
import { SHELL_COMMAND_IDS } from "../shellCommandIds";
import type { IconName } from "../icons";
import type { ToolbarAssetName } from "../toolbarAssets";

/**
 * The data brain for toolbars: it composes the effective toolset set from three inputs —
 * the core manifest, live plugin contributions, and the user's saved layout state — into
 * immutable ToolsetRegistry snapshots. Consumers (MainWindow's toolsetRegistry state, the
 * palettes, the menu model) follow `onDidChange` and read the latest `registry()`.
 *
 * Unknown commands in persisted layout state are pruned rather than thrown, so a layout
 * that references a since-removed plugin command degrades with a warning instead of
 * crashing startup.
 */
export interface ToolbarCatalog {
  registry(): DesktopToolsetRegistry;
  /** Core ∪ plugin toolsets BEFORE the user's layout state — what the Customize editor re-applies its
   *  draft on top of. */
  baseToolsets(): readonly DesktopToolsetDefinition[];
  baseCommands(): readonly CommandSpec[];
  setPluginToolsets(toolsets: readonly DesktopToolsetDefinition[], commandsWithHandlers?: readonly CommandDefinition[]): void;
  setLayoutState(state: unknown): void;
  warnings(): readonly string[];
  onDidChange(listener: () => void): () => void;
}

export function createToolbarCatalog(): ToolbarCatalog {
  let pluginToolsets: readonly DesktopToolsetDefinition[] = [];
  let baseCommands = allPaletteCommands(desktopToolsetRegistry);
  let additionalCommandIds = SHELL_COMMAND_IDS;
  let layoutState: unknown;
  let warningList: readonly string[] = [];
  const listeners = new Set<() => void>();

  const build = (): DesktopToolsetRegistry => {
    const combined = [...desktopToolsets, ...pluginToolsets];
    if (layoutState === undefined || layoutState === null) {
      warningList = [];
      return new ToolsetRegistry<IconName, ToolbarAssetName>(combined);
    }

    const warnings: string[] = [];
    const applied = applyToolsetLayoutState<IconName, ToolbarAssetName>(combined, migrateBracketToolbarOrder(layoutState), {
      // In-place customize can add any shell command, not just manifest ones — treat the whole
      // catalog as valid so those additions aren't pruned as "unknown" on render.
      additionalCommandIds,
      onUnknownCommand: "prune",
      onWarning: (warning) => warnings.push(warning)
    });
    warningList = warnings;
    return new ToolsetRegistry<IconName, ToolbarAssetName>(applied);
  };

  let snapshot = build();

  const rebuild = () => {
    snapshot = build();
    listeners.forEach((listener) => listener());
  };

  return {
    registry: () => snapshot,
    baseToolsets: () => [...desktopToolsets, ...pluginToolsets],
    baseCommands: () => baseCommands,
    setPluginToolsets(toolsets, commandsWithHandlers = []) {
      pluginToolsets = [...toolsets];
      const paletteCommands = allPaletteCommands(new ToolsetRegistry([...desktopToolsets, ...pluginToolsets]));
      const commandsById = new Map(paletteCommands.map(command => [command.id, command]));
      const pluginCommands = commandsWithHandlers.filter(command => command.source === "plugin" && isValidToolsetCommandId(command.id));
      const pluginCommandIds = new Set(pluginCommands.map(command => command.id));
      for (const command of paletteCommands) {
        if (command.source === "plugin" && !pluginCommandIds.has(command.id)) commandsById.delete(command.id);
      }
      for (const command of pluginCommands) {
        const presentation = commandsById.get(command.id);
        commandsById.set(command.id, {
          ...command,
          ...presentation,
          icon: presentation?.icon ?? "plugin",
          enabled: command.enabled,
          disabledReason: command.enabled === false ? presentation?.disabledReason ?? "Plugin command unavailable" : undefined
        });
      }
      baseCommands = [...commandsById.values()];
      additionalCommandIds = new Set([...SHELL_COMMAND_IDS, ...pluginCommandIds]);
      rebuild();
    },
    setLayoutState(state) {
      layoutState = state;
      rebuild();
    },
    warnings: () => warningList,
    onDidChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
