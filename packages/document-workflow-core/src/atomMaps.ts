// Atom-map numbers (reaction mapping classes) have no native atom field yet. Pasted SMILES lose
// them up front (`stripSmilesAtomMaps`), so the drawing and its identity check agree; a molecule
// whose stored source structure still carries them (a file saved by an older build, a pasted
// MOL/RXN block) is reported on open and on every export that drops them.

import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { normalizeClipboardMolfileText, readV2000CountsLine } from "@chemdraft/clipboard-adapter";
import type { ExportWarning } from "@chemdraft/export-engine";

/** A bracket atom's class: `[CH3:1]`. Bracket atoms contain no other colon or whitespace. */
const SMILES_ATOM_CLASS = /\[([^[\]:\s]*):(\d+)\]/g;

/** The SMILES token: a CXSMILES extension or name after whitespace is not touched. */
function smilesHead(smiles: string): { leading: string; head: string; rest: string } {
  const match = /^(\s*)(\S*)([\s\S]*)$/.exec(smiles)!;
  return { leading: match[1]!, head: match[2]!, rest: match[3]! };
}

/**
 * The nonzero atom-map numbers of a SMILES, in input order (class 0 means unmapped).
 * `drawn` is the molecule the SMILES belongs to: ChemDraft writes a drawn R2 as `[*:2]`, so a
 * dummy-atom class is that label, not a map, only when it is the same atom: a drawn atom labelled
 * Rn whose drawn neighbours are the `[*:n]` atom's neighbours in the SMILES, each drawn label
 * standing for one SMILES atom. Anything else (no drawing, another Rn, a different place) is a map.
 */
export function smilesAtomMapNumbers(smiles: string, drawn?: DrawnAtoms): number[] {
  const { head } = smilesHead(smiles);
  const graph = drawn ? smilesGraph(head) : undefined;
  const claimed = new Set<number>();
  return graph === undefined
    ? [...head.matchAll(SMILES_ATOM_CLASS)].flatMap(match => Number(match[2]) > 0 ? [Number(match[2])] : [])
    : graph.atoms.flatMap((token, index) => {
      const match = /^\[([^[\]:\s]*):(\d+)\]$/.exec(token);
      const value = match ? Number(match[2]) : 0;
      if (value <= 0) return [];
      // `[*:n]`, with the charge ChemDraft's writer may add (`[*+:n]`), and nothing else.
      if (/^\*[+-]*\d*$/.test(match![1]!)) {
        const neighbours = graph.neighbours(index).map(smilesAtomSymbol).filter(symbol => symbol !== "H").sort();
        const own = drawn!.findIndex((atom, atomIndex) => !claimed.has(atomIndex) &&
          atom.element.trim() === `R${value}` && sameList(atom.neighbours, neighbours));
        if (own >= 0) { claimed.add(own); return []; }
      }
      return [value];
    });
}

/**
 * Remove each bracket atom's `:n` class and nothing else: isotopes, chirality, H counts, charges,
 * ring closures and bond symbols stay byte for byte. The bracket itself stays, so `[C:2]` keeps
 * its stated zero hydrogens as `[C]`. Input without classes is returned unchanged (same string).
 * `removed` counts the nonzero maps dropped; a class 0 is unmapped and is not counted, but it is
 * still removed, so compare the returned text with the input to learn whether anything changed
 * (a class 0 can still decide whether a centre is stereogenic).
 */
export function stripSmilesAtomMaps(smiles: string): { smiles: string; removed: number } {
  const { leading, head, rest } = smilesHead(smiles);
  let removed = 0;
  const stripped = head.replace(SMILES_ATOM_CLASS, (_match, atom: string, map: string) => {
    if (Number(map) > 0) removed += 1;
    return `[${atom}]`;
  });
  return stripped === head ? { smiles, removed: 0 } : { smiles: `${leading}${stripped}${rest}`, removed };
}

const blankLine = (line: string) => line.trim() === "";

/** One fixed-width V2000 coordinate field (10 characters, `xxxxx.xxxx`); neighbours may touch. */
const v2000Coordinate = /^ *[-+]?(?:\d+(?:\.\d*)?|\.\d+) *$/;
const v2000Symbol = /^[A-Za-z*?][A-Za-z0-9#*?]{0,2}$/;
/** An under-padded atom line from a writer that separates fields with whitespace instead. */
const v2000LooseAtomLine = /^\s*[-+]?\d+(?:\.\d+)?\s+[-+]?\d+(?:\.\d+)?\s+[-+]?\d+(?:\.\d+)?\s+[A-Za-z*?][A-Za-z0-9#*?]*(?:\s|$)/;

/**
 * A V2000 atom line, read by its columns (CTfile spec): x, y and z in columns 1-30, the symbol in
 * 32-34, and the atom-atom mapping number `mmm` in 61-63. Columns, not whitespace: coordinates of
 * 10000 or more touch ("12345.6789-1234.5678"). A line that is not fixed-width but separates its
 * fields with whitespace is read by field instead (`mmm` is the fourteenth). Undefined if neither.
 */
function v2000AtomLine(line: string): { symbol: string; map: number } | undefined {
  if (line.length >= 34 && [0, 10, 20].every(start => v2000Coordinate.test(line.slice(start, start + 10))) &&
      v2000Symbol.test(line.slice(31, 34).trim())) {
    const field = line.slice(60, 63);
    return { symbol: line.slice(31, 34).trim(), map: /^ *\d+ *$/.test(field) ? Number(field) : 0 };
  }
  if (!v2000LooseAtomLine.test(line)) return undefined;
  const fields = line.trim().split(/\s+/);
  return { symbol: fields[3]!, map: /^\d+$/.test(fields[13] ?? "") ? Number(fields[13]) : 0 };
}

/** A V2000 bond line: first and second atom in columns 1-6 (touching from 100 on), then the type. */
function isV2000BondLine(line: string): boolean {
  const first = line.slice(0, 3), second = line.slice(3, 6), type = line.slice(6, 9);
  if ([first, second, type].every(field => /^ *\d+$/.test(field)) && Number(first) > 0 && Number(second) > 0) return true;
  return /^\s*[1-9]\d*\s+[1-9]\d*\s+\d+(?:\s|$)/.test(line);
}

/** What may follow a V2000 connection table: a property line, the record end, or nothing. */
const v2000AfterTable = /^(?:M {2}|A {2}|V {2}|G {2}|S {2}SKP|\$\$\$\$|> )/;

interface CountsReading { atomCount: number; bondCount: number }

/**
 * Every reading of a V2000 counts-shaped line: the fixed-width "aaabbb" columns, and separate
 * unpadded fields ("100 100  0  0  0  0" is 100 atoms and 100 bonds unpadded, but 100 and 10 by
 * columns). Each reading must then be confirmed by the connection table after the line. A line
 * tagged V3000 is not a V2000 counts line.
 */
function v2000CountsReadings(line: string): CountsReading[] {
  if (/\bV3000\s*$/i.test(line)) return [];
  if (readV2000CountsLine(line) === undefined && !/^\s*\d+(?:\s+\d+)+(?:\s+V2000)?\s*$/i.test(line)) return [];
  const readings: CountsReading[] = [];
  const atoms = line.slice(0, 3), bonds = line.slice(3, 6);
  if (/^ *\d+$/.test(atoms) && /^ *\d+$/.test(bonds)) readings.push({ atomCount: Number(atoms), bondCount: Number(bonds) });
  const fields = /^\s*(\d{1,3})\s+(\d{1,3})(?=\s|$)/.exec(line);
  if (fields && !readings.some(reading => reading.atomCount === Number(fields[1]) && reading.bondCount === Number(fields[2]))) {
    readings.push({ atomCount: Number(fields[1]), bondCount: Number(fields[2]) });
  }
  return readings;
}

interface V2000Counts extends CountsReading { index: number }

/**
 * The counts line of a V2000 molfile. The three header lines (title, program, comment) are never
 * read as structure: a title such as "V2000 export" or "[OH:2]" cannot be mistaken for it. Leading
 * blank lines before the header are allowed; a blank title looks the same, so each candidate
 * position is tried, each reading of it (`v2000CountsReadings`), and must be followed by a real
 * connection table, which a comment shaped like a counts line (even one declaring no atoms) is not.
 * Only when no standard position holds one are the header lines tried, in order, as the clipboard
 * reader tries them: a ChemDraw for Mac RXN block has a one-line header. They too must be followed
 * by a real connection table. When no candidate passes, maps are still read from the first one
 * whose declared atom lines all read as atoms (a missed map is lost data; an extra notice is noise).
 */
function v2000CountsLine(lines: readonly string[]): V2000Counts | undefined {
  let leadingBlank = 0;
  while (leadingBlank < lines.length && blankLine(lines[leadingBlank]!)) leadingBlank += 1;
  const standard = Array.from({ length: leadingBlank + 1 }, (_, offset) => offset + 3);
  const shortHeader = Array.from({ length: leadingBlank + 3 }, (_, index) => index);
  const candidates = [...standard, ...shortHeader].filter(index => index < lines.length)
    .flatMap(index => v2000CountsReadings(lines[index]!).map(reading => ({ index, ...reading })));
  const atomsOf = (counts: V2000Counts) => lines.slice(counts.index + 1, counts.index + 1 + counts.atomCount);
  const atomsRead = (counts: V2000Counts) => {
    const atoms = atomsOf(counts);
    return atoms.length === counts.atomCount && atoms.every(atom => v2000AtomLine(atom) !== undefined);
  };
  const strict = candidates.find(counts => {
    const start = counts.index + 1 + counts.atomCount;
    const bonds = lines.slice(start, start + counts.bondCount);
    const after = lines[start + counts.bondCount];
    return atomsRead(counts) && bonds.length === counts.bondCount && bonds.every(isV2000BondLine) &&
      (after === undefined || blankLine(after) || v2000AfterTable.test(after));
  });
  return strict ?? candidates.find(counts => counts.atomCount > 0 && atomsRead(counts));
}

/** Whether `line`, the program line of a header, is ChemDraft's own writer's (`chem-core` molfile.ts). */
const chemDraftProgramLine = (line: string | undefined) => /^ {2}ChemDraft\s*$/.test(line ?? "");

/** V2000 `M  RGP` entries: atom number → R-group number. */
function v2000RGroupNumbers(lines: readonly string[]): Map<number, number> {
  const rgroups = new Map<number, number>();
  for (const line of lines) {
    if (!line.startsWith("M  RGP")) continue;
    const fields = line.slice(9).trim().split(/\s+/).map(Number);
    for (let index = 0; index + 1 < fields.length; index += 2) rgroups.set(fields[index]!, fields[index + 1]!);
  }
  return rgroups;
}

/**
 * Whether atom `atomNumber` (1-based) is ChemDraft's own spelling of a drawn R-group, so its map
 * column holds that R number, not a map. Only in a molfile whose program line is ChemDraft's, and
 * only tied to that very atom: an `R#` whose own `M  RGP` / `RGROUPS=` number is the map, or a `*`
 * with no R-group entry whose drawn atom at the same position (`drawn`, the molecule's atoms in the
 * order ChemDraft writes them) is labelled R<map>. A `*` with nothing tying it to a drawn Rn is a map.
 */
function ownRGroupAtom(
  ownWriter: boolean, symbol: string, map: number, rgroup: number | undefined, atomNumber: number, drawn: DrawnAtoms | undefined
): boolean {
  if (!ownWriter) return false;
  if (symbol === "R#") return rgroup === map;
  return symbol === "*" && rgroup === undefined && drawn?.[atomNumber - 1]?.element.trim() === `R${map}`;
}

/**
 * The nonzero atom-atom-mapping numbers of a molfile's atoms (V2000 `mmm` column, V3000 positional
 * aamap or `AAMAP=`). Read as the clipboard reader reads the text: a text with `M  V30` block lines
 * is V3000 whatever its counts line says (short, blank-separated from the block, or absent), and its
 * atom block is read. A V3000 atom keeps the positional map when it is nonzero (as RDKit reads it)
 * and the `AAMAP=` keyword (spaces allowed around "=") otherwise, so neither can hide the other.
 * The one exception is ChemDraft's own R-group encoding (`ownRGroupAtom`), and only in the
 * positional field. `drawn` is the molecule the molfile belongs to, when there is one.
 */
export function molfileAtomMapNumbers(molfile: string, drawn?: DrawnAtoms): number[] {
  const lines = normalizeClipboardMolfileText(molfile).split("\n");
  const firstBlockLine = lines.findIndex(line => /^M {2}V30(?:\s|$)/.test(line));
  if (firstBlockLine >= 0) return v3000AtomMapNumbers(lines, firstBlockLine, drawn);
  const counts = v2000CountsLine(lines);
  if (!counts) return [];
  const ownWriter = chemDraftProgramLine(lines[counts.index - 2]);
  const atomLines = lines.slice(counts.index + 1, counts.index + 1 + counts.atomCount);
  const rgroups = ownWriter ? v2000RGroupNumbers(lines.slice(counts.index + 1 + counts.atomCount)) : new Map<number, number>();
  return atomLines.flatMap((line, index) => {
    const { symbol, map } = v2000AtomLine(line)!;
    if (map <= 0 || ownRGroupAtom(ownWriter, symbol, map, rgroups.get(index + 1), index + 1, drawn)) return [];
    return [map];
  });
}

function v3000AtomMapNumbers(lines: readonly string[], firstBlockLine: number, drawn: DrawnAtoms | undefined): number[] {
  // The counts line is the last non-blank line before the block; the program line two above it.
  let countsIndex = firstBlockLine - 1;
  while (countsIndex >= 0 && blankLine(lines[countsIndex]!)) countsIndex -= 1;
  const ownWriter = countsIndex >= 2 && chemDraftProgramLine(lines[countsIndex - 2]);
  const maps: number[] = [];
  let inAtoms = false;
  let pending = "";
  for (const raw of lines.slice(firstBlockLine)) {
    if (!/^M {2}V30(?:\s|$)/.test(raw)) continue;
    const body = raw.replace(/^M {2}V30\s*/, "").trim();
    // A V3000 line ending in "-" continues on the next M  V30 line.
    if (body.endsWith("-")) { pending += body.slice(0, -1); continue; }
    const line = (pending + body).trim();
    pending = "";
    if (/^BEGIN\s+ATOM\b/.test(line)) { inAtoms = true; continue; }
    if (/^END\s+ATOM\b/.test(line)) { inAtoms = false; continue; }
    if (!inAtoms) continue;
    // index type x y z aamap [key=value ...]
    const fields = line.split(/\s+/);
    const positional = /^\d+$/.test(fields[5] ?? "") ? Number(fields[5]) : 0;
    const keywordText = /(?:^|\s)AAMAP\s*=\s*(\d+)/i.exec(line)?.[1];
    const keyword = keywordText !== undefined ? Number(keywordText) : 0;
    const value = positional > 0 ? positional : keyword;
    if (value <= 0) continue;
    const rgroupText = /\bRGROUPS\s*=\s*\(\s*1\s+(\d+)\s*\)/i.exec(line)?.[1];
    const own = keywordText === undefined && ownRGroupAtom(
      ownWriter, fields[1] ?? "", value, rgroupText !== undefined ? Number(rgroupText) : undefined, Number(fields[0]), drawn);
    if (!own) maps.push(value);
  }
  return maps;
}

/** A drawn atom of the molecule a stored source belongs to: its label and its neighbours' symbols. */
export interface DrawnAtom { element: string; neighbours: string[] }
export type DrawnAtoms = readonly DrawnAtom[];

/** One symbol per drawn label for comparison with SMILES atoms: "*" for R labels, else its leading element. */
function drawnAtomSymbol(label: string): string {
  const trimmed = label.trim();
  if (/^(?:R\d*|R#|\*)$/.test(trimmed)) return "*";
  return /^[A-Z][a-z]?/.exec(trimmed)?.[0] ?? trimmed;
}

/** The molecule's drawn atoms, in order, each with its drawn neighbours' symbols (hydrogens left out). */
export function drawnAtoms(molecule: Partial<Pick<MoleculeObject, "atoms" | "bonds">>): DrawnAtom[] {
  const atoms = molecule.atoms ?? [];
  const byId = new Map(atoms.map(atom => [atom.id, atom]));
  return atoms.map(atom => ({
    element: atom.element,
    neighbours: (molecule.bonds ?? []).flatMap(bond => {
      const other = bond.fromAtomId === atom.id ? bond.toAtomId : bond.toAtomId === atom.id ? bond.fromAtomId : undefined;
      const neighbour = other !== undefined ? byId.get(other) : undefined;
      return neighbour ? [drawnAtomSymbol(neighbour.element)] : [];
    }).filter(symbol => symbol !== "H").sort()
  }));
}

const sameList = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

type AtomMapSource = Pick<MoleculeObject, "structureFormat" | "structure"> &
  Partial<Pick<MoleculeObject, "atoms" | "bonds" | "compatibility">>;

/**
 * Whether a molecule's stored source carries atom-map numbers ChemDraft does not keep: its source
 * structure, or the SMILES it was made from (`compatibility.unknown.smiles`). ChemDraft's own
 * spelling of a drawn Rn label is that label, not a map, only on the very atom that is the label.
 */
export function moleculeSourceHasAtomMaps(molecule: AtomMapSource): boolean {
  const drawn = molecule.atoms ? drawnAtoms(molecule) : undefined;
  const mappedSmiles = (text: unknown) => typeof text === "string" && smilesAtomMapNumbers(text, drawn).length > 0;
  if (typeof molecule.structure === "string" && molecule.structure.length > 0) {
    if (molecule.structureFormat === "smiles" && mappedSmiles(molecule.structure)) return true;
    if ((molecule.structureFormat === "molfile-v2000" || molecule.structureFormat === "molfile-v3000") &&
        molfileAtomMapNumbers(molecule.structure, drawn).length > 0) return true;
  }
  return mappedSmiles(molecule.compatibility?.unknown?.smiles);
}

export const ATOM_MAPS_DROPPED_EXPORT_CODE = "export.atom_maps_dropped";
export const ATOM_MAPS_NOT_KEPT_OPEN_CODE = "document.atom_maps_not_kept";

/** Add one `export.atom_maps_dropped` warning for `molecule` unless it has one already. */
export function pushAtomMapsDroppedWarning(
  warnings: ExportWarning[], molecule: MoleculeObject, format: string
): void {
  if (!moleculeSourceHasAtomMaps(molecule)) return;
  if (warnings.some(warning => warning.code === ATOM_MAPS_DROPPED_EXPORT_CODE && warning.objectId === molecule.id)) return;
  warnings.push({
    code: ATOM_MAPS_DROPPED_EXPORT_CODE,
    message: atomMapsDroppedMessage(format),
    severity: "warning",
    objectId: molecule.id
  });
}

export function atomMapsDroppedMessage(format: string): string {
  return `Atom-map numbers stored with this structure were dropped from the ${format} export; ChemDraft does not keep them yet.`;
}

/** One open warning when any molecule of `document` stores a mapped source structure. */
export function atomMapsNotKeptOpenWarnings(
  document: ChemDraftDocument, source = "ChemDraft document"
): { code: string; message: string }[] {
  const mapped = document.pages.flatMap(page => page.objects)
    .filter((object): object is MoleculeObject => object.type === "molecule" && moleculeSourceHasAtomMaps(object));
  if (!mapped.length) return [];
  return [{
    code: ATOM_MAPS_NOT_KEPT_OPEN_CODE,
    message: `${source}: ${mapped.length === 1 ? "1 structure stores" : `${mapped.length} structures store`} atom-map numbers. ` +
      "ChemDraft does not keep atom maps yet; they will be dropped on export or when the structure is edited."
  }];
}

/** A SMILES token's atoms (their tokens, in order) and bonds (with the bond symbol, "" if none). */
function smilesGraph(head: string) {
  const bonds: { a: number; b: number; symbol: string }[] = [];
  const atoms: string[] = [];
  const branches: (number | undefined)[] = [];
  const rings = new Map<string, { atom: number; symbol: string }>();
  let current: number | undefined, symbol = "";
  const tokens = head.matchAll(/\[[^\]]+\]|Cl|Br|se|as|[BCNOPSFIbcnops*]|%\(\d+\)|%\d{2}|\d|[()./\\=#:~$-]/g);
  for (const [token] of tokens) {
    if (token === "(") branches.push(current);
    else if (token === ")") current = branches.pop();
    else if (token === ".") { current = undefined; symbol = ""; }
    else if (/^[/\\=#:~$-]$/.test(token)) symbol = token;
    else if (/^(?:\d|%)/.test(token)) {
      if (current === undefined) continue;
      const ring = rings.get(token);
      if (ring) {
        bonds.push({ a: ring.atom, b: current, symbol: symbol || ring.symbol });
        rings.delete(token);
      } else rings.set(token, { atom: current, symbol });
      symbol = "";
    } else {
      const atom = atoms.push(token) - 1;
      if (current !== undefined) bonds.push({ a: current, b: atom, symbol });
      current = atom;
      symbol = "";
    }
  }
  const neighbours = (atom: number) => bonds.flatMap(bond => bond.a === atom ? [atoms[bond.b]!] : bond.b === atom ? [atoms[bond.a]!] : []);
  return { atoms, bonds, neighbours };
}

/** A SMILES atom token's element symbol, capitalised ("c" → "C", "[nH]" → "N", "[13CH3:1]" → "C"), or "*". */
function smilesAtomSymbol(token: string): string {
  const symbol = token.startsWith("[") ? /^\[\d*(\*|[A-Za-z][a-z]?)/.exec(token)?.[1] ?? token : token;
  return symbol === "*" ? symbol : symbol[0]!.toUpperCase() + symbol.slice(1);
}

/**
 * Specified stereo elements of a SMILES: tetrahedral tags, and double bonds with a directional
 * bond on each end. Read on engine-canonical output, which writes only stereo the engine perceives.
 */
export function smilesStereoElementCounts(smiles: string): { tetrahedral: number; doubleBonds: number } {
  const { atoms, bonds } = smilesGraph(smilesHead(smiles).head);
  const tetrahedral = atoms.filter(token => token.startsWith("[") && token.includes("@")).length;
  const directed = (atom: number, except: (typeof bonds)[number]) => bonds.some(bond => bond !== except &&
    (bond.a === atom || bond.b === atom) && (bond.symbol === "/" || bond.symbol === "\\"));
  const doubleBonds = bonds.filter(bond => bond.symbol === "=" && directed(bond.a, bond) && directed(bond.b, bond)).length;
  return { tetrahedral, doubleBonds };
}

/**
 * What removing the maps did to the stereo the input specified, given engine-canonical SMILES of
 * the mapped input and of the stripped one. A map can make otherwise equivalent substituents
 * distinct (`[CH3:1][C@:2]([CH3:3])(F)Cl`); without it the centre is not stereogenic, so the
 * drawing (which follows the stripped SMILES) has no stereo there. Undefined when nothing changed.
 */
export function atomMapStereoLossMessage(mappedCanonical: string, strippedCanonical: string): string | undefined {
  const before = smilesStereoElementCounts(mappedCanonical), after = smilesStereoElementCounts(strippedCanonical);
  const centres = Math.max(0, before.tetrahedral - after.tetrahedral);
  const alkenes = Math.max(0, before.doubleBonds - after.doubleBonds);
  if (!centres && !alkenes) return undefined;
  const parts = [
    centres ? `${centres} stereocenter${centres === 1 ? "" : "s"}` : undefined,
    alkenes ? `${alkenes} double-bond E/Z assignment${alkenes === 1 ? "" : "s"}` : undefined
  ].filter(Boolean).join(" and ");
  return `Without atom-map numbers, ${parts} in the pasted SMILES ${centres + alkenes === 1 ? "is" : "are"} no longer stereogenic and ${centres + alkenes === 1 ? "was" : "were"} drawn without stereo`;
}

export const ATOM_MAPS_REMOVED_STATUS = "Atom-map numbers removed; ChemDraft does not keep them yet.";

/**
 * Said once when a write puts a structure with a mapped stored source into a document (a MOL/RXN
 * paste, a paste of copied ChemDraft objects, a plugin insert): the source keeps its maps, but no
 * native atom does.
 */
export const ATOM_MAPS_NOT_KEPT_NOTICE =
  "atom-map numbers are not kept yet; they will be dropped on export or when the structure is edited";

/**
 * Why a verified write (plugin insert or edit, assistant request) is refused when the structure it
 * would store carries atom-map numbers: verification compares the stored source with the drawn
 * atoms, which have no map field, so the two can never agree. Said instead of a generic mismatch.
 */
export const ATOM_MAPS_WRITE_REFUSAL_REASON = "the structure carries atom-map numbers, which ChemDraft does not keep yet";
