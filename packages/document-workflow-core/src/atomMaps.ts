// Atom-map numbers (reaction mapping classes) have no native atom field yet. Pasted SMILES lose
// them up front (`stripSmilesAtomMaps`), so the drawing and its identity check agree; a molecule
// whose stored source structure still carries them (a file saved by an older build, a pasted
// MOL/RXN block) is reported on open and on every export that drops them.

import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import type { ExportWarning } from "@chemdraft/export-engine";

/** A bracket atom's class: `[CH3:1]`. Bracket atoms contain no other colon or whitespace. */
const SMILES_ATOM_CLASS = /\[([^[\]:\s]*):(\d+)\]/g;

/** The SMILES token: a CXSMILES extension or name after whitespace is not touched. */
function smilesHead(smiles: string): { leading: string; head: string; rest: string } {
  const match = /^(\s*)(\S*)([\s\S]*)$/.exec(smiles)!;
  return { leading: match[1]!, head: match[2]!, rest: match[3]! };
}

/** The nonzero atom-map numbers of a SMILES, in input order (class 0 means unmapped). */
export function smilesAtomMapNumbers(smiles: string): number[] {
  return [...smilesHead(smiles).head.matchAll(SMILES_ATOM_CLASS)]
    .map(match => Number(match[2])).filter(value => value > 0);
}

/**
 * Remove each bracket atom's `:n` class and nothing else: isotopes, chirality, H counts, charges,
 * ring closures and bond symbols stay byte for byte. The bracket itself stays, so `[C:2]` keeps
 * its stated zero hydrogens as `[C]`. Input without classes is returned unchanged (same string).
 * `removed` counts the nonzero maps dropped; a class 0 is unmapped and is removed silently.
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
const molfileAtomLine = /^\s*-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+\S/;

/** An R-group pseudo-atom: ChemDraft's own writer stores the R number in its map column. */
const rGroupSymbol = (symbol: string) => /^R(?:#|\d*)$/.test(symbol);

/**
 * The counts line of a molfile. The three header lines (title, program, comment) are never read:
 * a title such as "V2000 export" or "[OH:2]" cannot be mistaken for structure. Leading blank lines
 * before the header are allowed (a blank title looks the same, so each candidate is validated by
 * the atom lines after it), and so is a counts line without a version tag (V2000 by default).
 */
function molfileCountsLine(lines: readonly string[]): { index: number; version: "V2000" | "V3000"; atomCount: number } | undefined {
  let leadingBlank = 0;
  while (leadingBlank < lines.length && blankLine(lines[leadingBlank]!)) leadingBlank += 1;
  for (let index = 3; index <= leadingBlank + 3 && index < lines.length; index += 1) {
    const line = lines[index]!;
    const aaa = line.slice(0, 3), bbb = line.slice(3, 6);
    if (!/^ *\d+$/.test(aaa) || !/^ *\d+$/.test(bbb)) continue;
    const tag = line.trimEnd().match(/\b(V2000|V3000)$/i)?.[1]?.toUpperCase() as "V2000" | "V3000" | undefined;
    // A versionless line must otherwise be numeric fields only.
    if (!tag && !/^[\d ]+$/.test(line.trimEnd())) continue;
    const version = tag ?? "V2000";
    const atomCount = Number(aaa);
    if (version === "V3000") {
      if (lines.slice(index + 1).some(next => /^M {2}V30 BEGIN CTAB\b/.test(next))) return { index, version, atomCount };
      continue;
    }
    const atoms = lines.slice(index + 1, index + 1 + atomCount);
    if (atoms.length === atomCount && atoms.every(atom => molfileAtomLine.test(atom))) return { index, version, atomCount };
  }
  return undefined;
}

/** The nonzero atom-atom-mapping numbers of a molfile's atoms (V2000 `mmm` column, V3000 aamap / AAMAP=). */
export function molfileAtomMapNumbers(molfile: string): number[] {
  const lines = molfile.split(/\r\n|\r|\n/);
  const counts = molfileCountsLine(lines);
  if (!counts) return [];
  if (counts.version === "V2000") {
    return lines.slice(counts.index + 1, counts.index + 1 + counts.atomCount).flatMap(line => {
      if (rGroupSymbol(line.slice(31, 34).trim())) return [];
      const field = line.slice(60, 63);
      const value = /^ *\d+$/.test(field) ? Number(field) : 0;
      return value > 0 ? [value] : [];
    });
  }
  const maps: number[] = [];
  let inAtoms = false;
  let pending = "";
  for (const raw of lines.slice(counts.index + 1)) {
    if (!raw.startsWith("M  V30 ")) continue;
    const body = raw.slice(7);
    // A V3000 line ending in "-" continues on the next M  V30 line.
    if (body.trimEnd().endsWith("-")) { pending += body.trimEnd().slice(0, -1); continue; }
    const line = (pending + body).trim();
    pending = "";
    if (/^BEGIN ATOM\b/.test(line)) { inAtoms = true; continue; }
    if (/^END ATOM\b/.test(line)) break;
    if (!inAtoms) continue;
    // index type x y z aamap [key=value ...]
    const fields = line.split(/\s+/);
    if (rGroupSymbol(fields[1] ?? "")) continue;
    const positional = /^\d+$/.test(fields[5] ?? "") ? Number(fields[5]) : 0;
    const keyword = fields.slice(6).map(field => /^AAMAP=(\d+)$/i.exec(field)?.[1]).find(Boolean);
    const value = keyword !== undefined ? Number(keyword) : positional;
    if (value > 0) maps.push(value);
  }
  return maps;
}

/** Whether a molecule's stored source structure carries atom-map numbers ChemDraft does not keep. */
export function moleculeSourceHasAtomMaps(molecule: Pick<MoleculeObject, "structureFormat" | "structure">): boolean {
  if (typeof molecule.structure !== "string" || molecule.structure.length === 0) return false;
  if (molecule.structureFormat === "smiles") return smilesAtomMapNumbers(molecule.structure).length > 0;
  if (molecule.structureFormat === "molfile-v2000" || molecule.structureFormat === "molfile-v3000") {
    return molfileAtomMapNumbers(molecule.structure).length > 0;
  }
  return false;
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
