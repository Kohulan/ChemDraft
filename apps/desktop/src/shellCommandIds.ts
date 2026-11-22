import { allShellCommands } from "./commands";
import { createPhase4Document } from "./documentWorkflow";

/**
 * Persistent core command IDs, generated without a live document or customized layout. The toolset registry treats these as
 * valid override/addition targets (via `applyToolsetLayoutState`'s `additionalCommandIds`), otherwise
 * an in-place addition of a non-manifest command (e.g. `edit.undo`) is pruned as "unknown" on render.
 * Command ids are static (only their enabled state depends on the document), so this is computed once.
 */
export const SHELL_COMMAND_IDS: ReadonlySet<string> = new Set(
  allShellCommands(createPhase4Document(), undefined, { structureSearchEnabled: true }).map((command) => command.id)
);
