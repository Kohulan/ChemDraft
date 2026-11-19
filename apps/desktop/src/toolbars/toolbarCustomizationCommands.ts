import { isCompoundLayoutCommandHidden, type CompoundLayoutSettings } from "../compoundLayoutSettings";
import { isCompatOnlyArtVariantCommandId, TRANSITIONAL_STUB_COMMAND_IDS } from "../drawingTools";
import { desktopToolsetRegistry, getToolsetCommandSpecs } from "../toolsets";

// Use the shipped manifest so removing a tool from a customized layout cannot make it
// disappear from the catalog of commands the user can add back.
const shippedCommandIds = new Set(getToolsetCommandSpecs(desktopToolsetRegistry).map((command) => command.id));

/** Filter unavailable features and retired tools. Commands disabled by the current selection
 *  or document state are still eligible for customization. */
export function filterToolbarCustomizationCommands<T extends { id: string }>(
  commands: readonly T[],
  settings: CompoundLayoutSettings
): T[] {
  return commands.filter(({ id }) =>
    !isCompoundLayoutCommandHidden(id, settings) &&
    !TRANSITIONAL_STUB_COMMAND_IDS.has(id) &&
    !isCompatOnlyArtVariantCommandId(id, shippedCommandIds)
  );
}
