// Whether a stored atom label is a table abbreviation, read straight from the one abbreviation table.
//
// The table is template-library's (AGENTS.md §6: it owns the abbreviations). chem-core declares
// `@chemdraft/template-library` as a dependency and imports ONLY the `./abbreviations` subpath, never
// the package root (the root re-exports structure templates, which could import chem-core and make a
// cycle); that module imports nothing. Every bundle that carries chem-core (the app, the CLI, the
// published plugin-host SDK) aliases the subpath to source, so a standalone plugin-host reads OMe
// exactly as the app does and the SDK inlines the table.
import { abbreviationForLabel } from "@chemdraft/template-library/abbreviations";
import { atomicNumberForElementSymbol } from "./elements";

/**
 * True for a label that reads as a table abbreviation (OMe, Ph, Bu, Me, CF3, TMS and their aliases):
 * not an element symbol, and spelled exactly (case-sensitively) as an entry of the abbreviation
 * table. This is the label grammar's own reading of a label with no bond context
 * (layout-engine `nativeAtomLabelReading`: elements first, so a stored "Ac" stays actinium, then
 * `abbreviationForLabel`); the grammar's tests pin the two to the same answer for every spelling.
 * A composite ("NMe2", "NHMe") and an element spelling its hydrogens ("NH2", "CH3") are not table
 * abbreviations: their own text says what hydrogens the head carries.
 */
export function isTableAbbreviationLabel(label: string): boolean {
  const trimmed = label.trim();
  return atomicNumberForElementSymbol(trimmed) === undefined && abbreviationForLabel(trimmed) !== undefined;
}
