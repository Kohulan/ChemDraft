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
 * `ownRGroupNumbers` are the drawn R-group numbers of the molecule the SMILES belongs to: ChemDraft
 * writes a drawn R2 as `[*:2]`, so one dummy-atom class per drawn label is that label, not a map.
 */
export function smilesAtomMapNumbers(smiles: string, ownRGroupNumbers: readonly number[] = []): number[] {
  const unclaimed = [...ownRGroupNumbers];
  return [...smilesHead(smiles).head.matchAll(SMILES_ATOM_CLASS)].flatMap(match => {
    const value = Number(match[2]);
    if (value <= 0) return [];
    // `[*:n]`, with the charge ChemDraft's writer may add (`[*+:n]`), and nothing else.
    const own = /^\*[+-]*\d*$/.test(match[1]!) ? unclaimed.indexOf(value) : -1;
    if (own >= 0) { unclaimed.splice(own, 1); return []; }
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

interface MolfileCounts { index: number; version: "V2000" | "V3000"; atomCount: number; bondCount: number }

/**
 * The counts line of a molfile. The three header lines (title, program, comment) are never read
 * as structure: a title such as "V2000 export" or "[OH:2]" cannot be mistaken for it. Leading
 * blank lines before the header are allowed; a blank title looks the same, so each candidate
 * position is tried and must be followed by a real connection table, which a comment shaped like
 * a counts line (even one declaring no atoms) is not. Every counts-line form the clipboard reader
 * accepts is accepted (`readV2000CountsLine`), a line without a version tag reading as V2000.
 * Only when no standard position holds one are the header lines tried, in order, as the clipboard
 * reader tries them: a ChemDraw for Mac RXN block has a one-line header. They too must be followed
 * by a real connection table.
 */
function molfileCountsLine(lines: readonly string[]): MolfileCounts | undefined {
  let leadingBlank = 0;
  while (leadingBlank < lines.length && blankLine(lines[leadingBlank]!)) leadingBlank += 1;
  const standard = Array.from({ length: leadingBlank + 1 }, (_, offset) => offset + 3);
  const shortHeader = Array.from({ length: leadingBlank + 3 }, (_, index) => index);
  for (const index of [...standard, ...shortHeader]) {
    if (index >= lines.length) continue;
    const line = lines[index]!;
    const counts = readV2000CountsLine(line);
    if (!counts) continue;
    const version = line.trimEnd().match(/\b(V2000|V3000)$/i)?.[1]?.toUpperCase() === "V3000" ? "V3000" : "V2000";
    if (version === "V3000") {
      if (/^M {2}V30 BEGIN CTAB\b/.test(lines[index + 1] ?? "")) return { index, version, ...counts };
      continue;
    }
    const atoms = lines.slice(index + 1, index + 1 + counts.atomCount);
    const bonds = lines.slice(index + 1 + counts.atomCount, index + 1 + counts.atomCount + counts.bondCount);
    const after = lines[index + 1 + counts.atomCount + counts.bondCount];
    if (atoms.length === counts.atomCount && atoms.every(atom => v2000AtomLine(atom) !== undefined) &&
        bonds.length === counts.bondCount && bonds.every(isV2000BondLine) &&
        (after === undefined || blankLine(after) || v2000AfterTable.test(after))) return { index, version, ...counts };
  }
  return undefined;
}

/** Whether the header's program line is ChemDraft's own writer's (`chem-core` molfile.ts). */
const chemDraftProgramLine = (lines: readonly string[], countsIndex: number) =>
  /^ {2}ChemDraft\s*$/.test(lines[countsIndex - 2] ?? "");

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
 * The nonzero atom-atom-mapping numbers of a molfile's atoms (V2000 `mmm` column, V3000 aamap or
 * AAMAP=). The one exception is ChemDraft's own R-group encoding, which puts a drawn R2's number in
 * the map column: only in a molfile whose program line is ChemDraft's, only on an `R#` atom whose
 * `M  RGP` / `RGROUPS=` number is that same number or on a `*` atom with no R-group entry, and only
 * in the positional V3000 field. Any other map, on any atom, is a map.
 */
export function molfileAtomMapNumbers(molfile: string): number[] {
  const lines = normalizeClipboardMolfileText(molfile).split("\n");
  const counts = molfileCountsLine(lines);
  if (!counts) return [];
  const ownWriter = chemDraftProgramLine(lines, counts.index);
  if (counts.version === "V2000") {
    const atomLines = lines.slice(counts.index + 1, counts.index + 1 + counts.atomCount);
    const rgroups = ownWriter ? v2000RGroupNumbers(lines.slice(counts.index + 1 + counts.atomCount)) : new Map<number, number>();
    return atomLines.flatMap((line, index) => {
      const { symbol, map } = v2000AtomLine(line)!;
      if (map <= 0) return [];
      const rgroup = rgroups.get(index + 1);
      if (ownWriter && ((symbol === "R#" && rgroup === map) || (symbol === "*" && rgroup === undefined))) return [];
      return [map];
    });
  }
  const maps: number[] = [];
  let inAtoms = false;
  let pending = "";
  for (const raw of lines.slice(counts.index + 1)) {
    if (!/^M {2}V30(?:\s|$)/.test(raw)) continue;
    const body = raw.replace(/^M {2}V30\s*/, "").trim();
    // A V3000 line ending in "-" continues on the next M  V30 line.
    if (body.endsWith("-")) { pending += body.slice(0, -1); continue; }
    const line = (pending + body).trim();
    pending = "";
    if (/^BEGIN ATOM\b/.test(line)) { inAtoms = true; continue; }
    if (/^END ATOM\b/.test(line)) break;
    if (!inAtoms) continue;
    // index type x y z aamap [key=value ...]
    const fields = line.split(/\s+/);
    const positional = /^\d+$/.test(fields[5] ?? "") ? Number(fields[5]) : 0;
    const keyword = fields.slice(6).map(field => /^AAMAP=(\d+)$/i.exec(field)?.[1]).find(value => value !== undefined);
    const value = keyword !== undefined ? Number(keyword) : positional;
    if (value <= 0) continue;
    const rgroups = /\bRGROUPS=\(1 (\d+)\)/i.exec(line)?.[1];
    const own = ownWriter && keyword === undefined &&
      ((fields[1] === "R#" && rgroups !== undefined && Number(rgroups) === value) || (fields[1] === "*" && rgroups === undefined));
    if (!own) maps.push(value);
  }
  return maps;
}

/** The R-group numbers drawn on a molecule's native atoms (R1-R99 labels), one per atom. */
function nativeRGroupNumbers(atoms: readonly { element: string }[] | undefined): number[] {
  return (atoms ?? []).flatMap(atom => {
    const match = /^R([1-9]\d?)$/.exec(atom.element.trim());
    return match ? [Number(match[1])] : [];
  });
}

type AtomMapSource = Pick<MoleculeObject, "structureFormat" | "structure"> &
  Partial<Pick<MoleculeObject, "atoms" | "compatibility">>;

/**
 * Whether a molecule's stored source carries atom-map numbers ChemDraft does not keep: its source
 * structure, or the SMILES it was made from (`compatibility.unknown.smiles`). A `[*:n]` matched by a
 * drawn Rn label is ChemDraft's own R-group spelling, not a map.
 */
export function moleculeSourceHasAtomMaps(molecule: AtomMapSource): boolean {
  const rgroups = nativeRGroupNumbers(molecule.atoms);
  const mappedSmiles = (text: unknown) => typeof text === "string" && smilesAtomMapNumbers(text, rgroups).length > 0;
  if (typeof molecule.structure === "string" && molecule.structure.length > 0) {
    if (molecule.structureFormat === "smiles" && mappedSmiles(molecule.structure)) return true;
    if ((molecule.structureFormat === "molfile-v2000" || molecule.structureFormat === "molfile-v3000") &&
        molfileAtomMapNumbers(molecule.structure).length > 0) return true;
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

/**
 * Specified stereo elements of a SMILES: tetrahedral tags, and double bonds with a directional
 * bond on each end. Read on engine-canonical output, which writes only stereo the engine perceives.
 */
export function smilesStereoElementCounts(smiles: string): { tetrahedral: number; doubleBonds: number } {
  const { head } = smilesHead(smiles);
  const bonds: { a: number; b: number; symbol: string }[] = [];
  const branches: (number | undefined)[] = [];
  const rings = new Map<string, { atom: number; symbol: string }>();
  let current: number | undefined, atomCount = 0, tetrahedral = 0, symbol = "";
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
      const atom = atomCount++;
      if (token.startsWith("[") && token.includes("@")) tetrahedral += 1;
      if (current !== undefined) bonds.push({ a: current, b: atom, symbol });
      current = atom;
      symbol = "";
    }
  }
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
