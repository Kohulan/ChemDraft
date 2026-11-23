// Whether a stored atom label is a table abbreviation, read straight from the one abbreviation table.
//
// The table is template-library's (AGENTS.md §6: it owns the abbreviations), and its lookup module
// imports nothing, so chem-core reads it by source path rather than through the package name:
// declaring `@chemdraft/template-library` as a chem-core dependency would need a lockfile change,
// and every bundle that carries chem-core (the app, the CLI, the published plugin-host SDK, whose
// esbuild build aliases chem-core to its source) follows a relative import on its own. Nothing is
// installed at load time and nothing depends on which other package a process happened to load, so
// a standalone plugin-host reads OMe exactly as the app does.
import { abbreviationForLabel } from "../../template-library/src/abbreviations";
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
