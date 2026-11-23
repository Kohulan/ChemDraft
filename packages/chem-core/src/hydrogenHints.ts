import { bridgeBondIndices, isDativeBond } from "./bondGraph";
import { atomicNumberForElementSymbol } from "./elements";
import type { MoleculeAtom, MoleculeBond, MoleculeObject } from "./schemas";

/**
 * The hydrogen count an atom states for itself — a CDXML NumHydrogens kept because it disagrees with
 * the derived count (owner ruling 1.2.3) — or undefined. Where it is defined it replaces the derived
 * count everywhere the atom is read: the drawn label (layout-engine), the formula and SMILES
 * (document-workflow-core) and the molfile every engine reads (`moleculeToMolfileV2000`/`V3000`),
 * where it takes the same explicit-valence field as a typed literal label's hydrogens. So an O stated
 * with 0 H and a typed literal "O" are the same atom to the label, the formula, the mass and RDKit.
 *
 * The same holds where the drawn atom shows no count of its own: a carbon bonded only datively (its
 * label draws no H) states its count as a typed "C", "CH" … "CH4" spells it, and an H, D or T atom
 * states 0 as a typed literal "H", "D" or "T" means it.
 *
 * Undefined where the count means something else, or where nothing counts it
 * (`statedHydrogenCountUse` decides both, and is the one place that does):
 * - no count;
 * - a typed literal label, or a label that is not an element symbol but names one ("NH2", "NHMe"):
 *   its own text says what hydrogens it has (a stored count on a typed literal is a source
 *   constraint the Kekulé check reads);
 * - an atom on an aromatic bond, where the count settles which ring atom carries the H and the
 *   Kekulé resolution carries it;
 * - a count nothing counts (`atomIgnoresStatedHydrogenCount`): an H, D or T atom stating any count
 *   but 0 (no typed label draws a hydrogen atom carrying hydrogens of its own), or a label naming no
 *   element — the unknown atom "*", a generic label such as A, Q, M, X or R1 — stating any count but
 *   0 (the molfile writes it as a placeholder with no valence, and RDKit gives a placeholder no
 *   hydrogens), or an abbreviation (OMe, Ph, CF3: its hydrogens come from what it stands for)
 *   stating any count but 0. A stated 0 on such a label is what it counts anyway, so nothing is
 *   lost. The CDXML importer does not keep such a count on an ordinary hydrogen atom and warns; a
 *   plugin or assistant write that would store one is refused at the plugin host
 *   (`atomWithIgnoredHydrogenCount`); a document that already holds one (an older file, a session,
 *   a paste, a kept count on a generic label) keeps it as stored, and the atom is flagged.
 * No valence model here: the count is passed through as stated, never re-derived.
 */
export function atomStatedHydrogenCount(
  atom: MoleculeAtom,
  bonds: readonly MoleculeBond[]
): number | undefined {
  return statedHydrogenCountUse(atom, bonds) === "counted" ? atom.hydrogenCount : undefined;
}

/**
 * Unpaired electrons an atom has that no radical mark draws: one on a lone hydrogen atom, else none.
 * A lone hydrogen atom is ONE hydrogen atom, a radical (owner decision 2026-11-23): an H, D or T with
 * no bonds at all, neutral, carrying no radical mark, not a typed literal and stating no count of
 * its own (`atomStatedHydrogenCount`; a count nothing counts reads as none) is H•, D• or T•. The
 * molfile writes it with the zero-valence sentinel, so RDKit reads exactly that bare atom with one
 * radical electron (AGENTS.md §8); the label draws no hydrogen on it, layout-engine draws the
 * radical with the dot a radical mark draws, and the SMILES checks count it as drawn. It is derived
 * from the atom, never stored: bonding, charging or marking the atom removes it.
 *
 * A bonded hydrogen atom (a dative bond included, which V2000 writes as a plain single bond), a
 * charged one (H+, H-) or one with a radical mark has none. A stated 0 or a typed literal H keeps
 * its stated reading: the bare atom, with no drawn radical.
 */
export function atomImpliedRadicalCount(atom: MoleculeAtom, bonds: readonly MoleculeBond[]): number {
  if (atom.element !== "H" && atom.element !== "D" && atom.element !== "T") return 0;
  if (atom.labelLiteral === true || atom.formalCharge !== 0 || (atom.markRadicals ?? 0) !== 0) return 0;
  if (atomStatedHydrogenCount(atom, bonds) !== undefined) return 0;
  return bonds.some((bond) => bond.fromAtomId === atom.id || bond.toAtomId === atom.id) ? 0 : 1;
}

/**
 * Unpaired electrons a molecule's atoms carry: every radical mark plus every lone hydrogen atom's
 * implied radical (`atomImpliedRadicalCount`, the one rule). A mark suppresses the implied radical,
 * so no electron is counted twice. This is the cached `chemistry.radicalCount`, so the stored count
 * agrees with the H• the canvas draws, the SMILES exports and RDKit reads. Each atom is judged
 * against its own bonds only, read from one adjacency pass, so the count stays linear.
 */
export function moleculeRadicalCount(atoms: readonly MoleculeAtom[], bonds: readonly MoleculeBond[]): number {
  const bondsByAtom = new Map<string, MoleculeBond[]>();
  for (const bond of bonds) {
    for (const id of new Set([bond.fromAtomId, bond.toAtomId])) {
      const list = bondsByAtom.get(id);
      if (list) list.push(bond); else bondsByAtom.set(id, [bond]);
    }
  }
  return atoms.reduce((sum, atom) =>
    sum + (atom.markRadicals ?? 0) + atomImpliedRadicalCount(atom, bondsByAtom.get(atom.id) ?? []), 0);
}

/**
 * What a stored hydrogen count is to everything that reads the atom; `atomStatedHydrogenCount` and
 * `atomIgnoresStatedHydrogenCount` are both read from here, so they cannot disagree:
 * - "none": no count is stored;
 * - "counted": `atomStatedHydrogenCount` uses it as the atom's count;
 * - "label": a typed literal label, or a label that is not an element symbol but names one ("NH2",
 *   "NHMe"), whose own text says its hydrogens (on a typed literal, the count is a source
 *   constraint the Kekulé check reads);
 * - "aromatic": the count settles the Kekulé resolution of an aromatic bond;
 * - "agrees": 0 on a label naming no element or an abbreviation, which is exactly what it counts;
 * - "ignored": stored, and nothing counts it — an H, D or T atom, a label naming no element, or an
 *   abbreviation, stating a count other than 0. Decided before the label's literalness and its bonds, so it is a
 *   property of the atom alone.
 * "Naming no element" is read from chem-core's own element table (`statedCountCarrier`), not from a
 * list of placeholder labels; "an abbreviation" from layout-engine's label grammar
 * (`abbreviationLabelReader`), not from a second list.
 */
function statedHydrogenCountUse(
  atom: MoleculeAtom,
  bonds: readonly MoleculeBond[]
): "none" | "counted" | "label" | "aromatic" | "agrees" | "ignored" {
  const stated = atom.hydrogenCount;
  if (stated === undefined) return "none";
  const carrier = statedCountCarrier(atom);
  if (carrier !== undefined) {
    if (stated !== 0) return "ignored";
    if (carrier !== "hydrogen") return "agrees";
  }
  if (atom.labelLiteral === true || (carrier === undefined && atomicNumberForElementSymbol(atom.element) === undefined)) return "label";
  for (const bond of bonds) {
    if (bond.order === "aromatic" && (bond.fromAtomId === atom.id || bond.toAtomId === atom.id)) return "aromatic";
  }
  return "counted";
}

/**
 * True for an atom that stores a hydrogen count nothing counts (`statedHydrogenCountUse`: stored,
 * but `atomStatedHydrogenCount` does not use it and nothing else reads it), while 0 is exactly what
 * the atom already counts:
 * - an H, D or T atom: no typed label draws a hydrogen atom carrying hydrogens of its own;
 * - a label naming no element: the unknown atom "*" (an unknown or unlabeled CDXML node, a pasted
 *   dummy atom, a typed "*") or a generic label (A, Q, M, X, an R-group …). Its label draws no
 *   stated hydrogens, the formula counts none, the molfile writes a placeholder with no valence
 *   field and RDKit gives a placeholder no hydrogens;
 * - an abbreviation (OMe, Ph, Bu, CF3 …, as the label grammar reads it): its label, formula and
 *   SMILES read the hydrogens of what it stands for, never a count stated on the atom.
 * Patches store it as written (chem-core never refuses it, so opening, restoring, pasting or undoing
 * a document that holds one always works); the atom validator flags it and an open reports it
 * (`statedHydrogenCountNotCountedText`). The CDXML importer does not keep such a count on an
 * ordinary hydrogen atom (`cdxml.atom_hydrogen_count_not_kept`); on any other atom it keeps it for
 * the file's round trip and reports it as not counted (`cdxml.atom_hydrogen_count_not_counted`).
 */
export function atomIgnoresStatedHydrogenCount(atom: MoleculeAtom): boolean {
  return statedHydrogenCountUse(atom, []) === "ignored";
}

/**
 * Whether a label reads as an abbreviation (a superatom such as OMe, Ph, Bu, Me, CF3, TMS) rather
 * than an element or an element spelling its hydrogens. That reading belongs to layout-engine's
 * atom-label grammar (`nativeAtomLabelReading`, AGENTS.md §6), which chem-core cannot import:
 * layout-engine depends on chem-core. So the grammar installs it here when it loads
 * (`installAbbreviationLabelReader`), and every process holding the grammar (the app, the CDXML
 * importer, document-workflow-core, the CLI) reads abbreviations by that one decision. chem-core alone
 * (its own tests; the runtime bundled into the published plugin-host SDK) has no reader: there an
 * abbreviation falls back to the element-table rule below, as before.
 */
export type AbbreviationLabelReader = (label: string) => boolean;

let abbreviationLabelReader: AbbreviationLabelReader | undefined;

/**
 * Install (or, with undefined, remove) the reader `statedCountCarrier` asks whether a label is an
 * abbreviation. layout-engine's label grammar installs it at load; nothing else should.
 */
export function installAbbreviationLabelReader(reader: AbbreviationLabelReader | undefined): void {
  abbreviationLabelReader = reader;
}

/**
 * Which kind of atom counts no stated hydrogens of its own: hydrogen atoms, the unknown atom "*",
 * an abbreviation (its hydrogens come from what it stands for: `abbreviationLabelReader`), and any
 * other label naming no element — no element symbol of chem-core's table starts it (A, Q, M, X,
 * R1). A label an element symbol starts that is no abbreviation ("NH2", "CH3", "NHMe") names that
 * element, and its own text says what hydrogens it has, as a typed label does; it is no carrier.
 */
function statedCountCarrier(atom: MoleculeAtom): "hydrogen" | "unknown" | "abbreviation" | "generic" | undefined {
  if (atom.element === "H" || atom.element === "D" || atom.element === "T") return "hydrogen";
  if (atom.element === "*") return "unknown";
  const label = atom.element.trim();
  if (atomicNumberForElementSymbol(label) === undefined && abbreviationLabelReader?.(label) === true) return "abbreviation";
  const namesElement = atomicNumberForElementSymbol(label.slice(0, 2)) !== undefined ||
    atomicNumberForElementSymbol(label.slice(0, 1)) !== undefined;
  return namesElement ? undefined : "generic";
}

/**
 * "a hydrogen atom", "an unknown atom", "an abbreviation" or "a label naming no element": the atom
 * kind a refusal or warning names.
 */
export function ignoredHydrogenCountAtomKind(atom: MoleculeAtom): string {
  const carrier = statedCountCarrier(atom);
  return carrier === "unknown" ? "an unknown atom" : carrier === "generic" ? "a label naming no element"
    : carrier === "abbreviation" ? "an abbreviation" : "a hydrogen atom";
}

/** Why an abbreviation's stated count is not counted, the clause every wording below shares. */
const abbreviationHydrogensClause = "an abbreviation's hydrogens come from what it stands for";

/**
 * The atom badge's short reason for a stored count nothing counts (`atomIgnoresStatedHydrogenCount`),
 * in the same words as `statedHydrogenCountNotCountedText`: "A states 2 H, which a label naming no
 * element cannot carry; only 0 counts.", or for an abbreviation "OMe states 2 H, which is not
 * counted: an abbreviation's hydrogens come from what it stands for."
 */
export function statedHydrogenCountNotCountedReason(atom: MoleculeAtom): string {
  const head = `${atom.element} states ${atom.hydrogenCount} H`;
  return statedCountCarrier(atom) === "abbreviation"
    ? `${head}, which is not counted: ${abbreviationHydrogensClause}.`
    : `${head}, which ${ignoredHydrogenCountAtomKind(atom)} cannot carry; only 0 counts.`;
}

/** "x", "x or y", "x, y or z". */
function alternatives(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

/**
 * The one wording for atoms whose stored hydrogen count is kept but not counted
 * (`atomIgnoresStatedHydrogenCount`), shared by the native open report, the atom badge's detail and
 * the CDXML importer, so they cannot drift apart. `name` gives each atom's id as the reader knows it
 * (the CDXML importer names the file's node id). The text for hydrogen atoms and unknown atoms is
 * the wording these warnings already used for them; a label naming no element is named by its own
 * text ("as a typed A label means"); an abbreviation says its hydrogens come from what it stands
 * for (`abbreviationHydrogensClause`), since a stated 0 is not what it counts either.
 */
export function statedHydrogenCountNotCountedText(
  atoms: readonly MoleculeAtom[],
  name: (atom: MoleculeAtom) => string = (atom) => atom.id
): string {
  const hydrogens = (count: number) => `${count} hydrogen${count === 1 ? "" : "s"}`;
  const carriers = atoms.map(statedCountCarrier);
  const placeholders = atoms.filter((_atom, index) => carriers[index] !== "abbreviation");
  const abbreviations = placeholders.length < atoms.length;
  const kinds = new Set(placeholders.map(statedCountCarrier));
  const uniform = kinds.size === 1 ? [...kinds][0] : undefined;
  const typed = alternatives([
    ...(kinds.has("hydrogen") ? ["H", "D", "T"] : []),
    ...(kinds.has("unknown") ? ["*"] : []),
    ...new Set(atoms.filter((_atom, index) => carriers[index] === "generic").map((atom) => atom.element))
  ]);
  const [only] = atoms;
  if (atoms.length === 1) {
    return abbreviations
      ? `atom ${name(only!)} (${only!.element}) states ${hydrogens(only!.hydrogenCount!)}, but ${abbreviationHydrogensClause}, ` +
        "so the stated count is kept as stored but not counted, and the atom is flagged."
      : `atom ${name(only!)} (${only!.element}) states ${hydrogens(only!.hydrogenCount!)}, which ${ignoredHydrogenCountAtomKind(only!)} cannot carry: ` +
        `only 0 counts, as a typed ${typed} label means. The stated count is kept as stored but not counted, and the atom is flagged.`;
  }
  const listed = atoms.map((atom) => `atom ${name(atom)} (${atom.element}) states ${atom.hydrogenCount}`).join("; ");
  const tail = "The stated counts are kept as stored but not counted, and the atoms are flagged.";
  if (placeholders.length === 0) {
    return `${atoms.length} abbreviations state hydrogen counts: ${listed}. ${abbreviationHydrogensClause[0]!.toUpperCase()}${abbreviationHydrogensClause.slice(1)}. ${tail}`;
  }
  let head: string;
  if (abbreviations) {
    head = `${atoms.length} atoms state hydrogen counts that are not counted: ${listed}. Only 0 counts on ${placeholderKinds(kinds)}`;
  } else if (uniform === undefined) {
    head = `${atoms.length} atoms state hydrogen counts they cannot carry: ${listed}. Only 0 counts on ${placeholderKinds(kinds)}`;
  } else {
    const plural = uniform === "generic" ? "atoms with labels naming no element" : `${uniform} atoms`;
    const singular = uniform === "generic" ? "a label naming no element" : uniform === "unknown" ? "an unknown atom" : "a hydrogen atom";
    head = `${atoms.length} ${plural} state hydrogen counts ${singular} cannot carry: ${listed}. Only 0 counts`;
  }
  return `${head}, as a typed ${typed} label means${abbreviations ? `, and ${abbreviationHydrogensClause}` : ""}. ${tail}`;
}

/** The placeholder kinds "Only 0 counts on …" names: "a hydrogen or unknown atom", or each kind listed. */
function placeholderKinds(kinds: ReadonlySet<string | undefined>): string {
  if (!kinds.has("generic") && kinds.has("hydrogen") && kinds.has("unknown")) return "a hydrogen or unknown atom";
  return alternatives([
    ...(kinds.has("hydrogen") ? ["a hydrogen atom"] : []),
    ...(kinds.has("unknown") ? ["an unknown atom"] : []),
    ...(kinds.has("generic") ? ["a label naming no element"] : [])
  ]);
}

/**
 * The first atom of `atoms` that would store a hydrogen count `atomIgnoresStatedHydrogenCount`
 * flags and that this write sets, not one `previous` already held unchanged (an older document's
 * atom is not refused for edits elsewhere). The plugin host refuses a plugin or assistant write that
 * sets one, so its writer is told rather than having a count stored that nothing reads (AGENTS.md
 * §7). chem-core's patches do not refuse it: they also replay paste, duplicate, undo and session
 * restore, which must never refuse a user's own document.
 */
export function atomWithIgnoredHydrogenCount(
  atoms: readonly MoleculeAtom[],
  previous?: readonly MoleculeAtom[]
): MoleculeAtom | undefined {
  const before = new Map(previous?.map((atom) => [atom.id, atom]));
  return atoms.find((atom) => {
    if (!atomIgnoresStatedHydrogenCount(atom)) return false;
    const old = before.get(atom.id);
    return !old || old.element !== atom.element || old.hydrogenCount !== atom.hydrogenCount;
  });
}

/**
 * An imported H count describes the imported graph, not subsequent chemical edits. A chemical edit
 * of an atom — its element, charge, isotope, radicals or scheme abbreviation, or its label retyped
 * (`sameAtomStatement`), the order or dative meaning of a bond at it, a bond added or removed at it —
 * drops that atom's count; moves, rotations, alignment, bond direction, wedges, styles, label
 * position and edits of other atoms keep it.
 *
 * An atom `previous` does not have (a pasted or sprouted atom, or one merged in from another
 * molecule on a re-minted id) has nothing of its own to be compared with, so it keeps the count it
 * arrives with while its bonds reach only other new atoms: a merge's absorbed atoms keep their
 * counts on their new ids. A new bond that joins it to an atom `previous` has is a bond added at
 * it, so it drops its count, as that atom does. So a merge drops exactly the counts of the two atoms
 * the joining bond reaches, whether it comes as one update (absorbed atoms and joining bond
 * together, as a plugin writes it) or as two (the bond tool absorbs, then joins).
 */
export function clearChangedAtomHydrogenHints(
  previous: Pick<MoleculeObject, "atoms" | "bonds">,
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): MoleculeAtom[] {
  const changed = new Set<string>();
  // New atoms reached by a new bond from an atom `previous` has: joined onto the old graph.
  const joined = new Set<string>();
  const oldAtoms = new Map(previous.atoms.map((atom) => [atom.id, atom]));
  const oldBonds = new Map(previous.bonds.map((bond) => [bond.id, bond]));
  for (const bond of bonds) {
    const old = oldBonds.get(bond.id);
    oldBonds.delete(bond.id);
    const sameEndpoints = old && (
      (old.fromAtomId === bond.fromAtomId && old.toAtomId === bond.toAtomId) ||
      (old.fromAtomId === bond.toAtomId && old.toAtomId === bond.fromAtomId)
    );
    if (!old || !sameEndpoints ||
      old.order !== bond.order || isDativeBond(old) !== isDativeBond(bond)) {
      changed.add(bond.fromAtomId);
      changed.add(bond.toAtomId);
      if (old) { changed.add(old.fromAtomId); changed.add(old.toAtomId); }
      if (!sameEndpoints) {
        if (oldAtoms.has(bond.fromAtomId)) joined.add(bond.toAtomId);
        if (oldAtoms.has(bond.toAtomId)) joined.add(bond.fromAtomId);
      }
    }
  }
  for (const bond of oldBonds.values()) {
    changed.add(bond.fromAtomId);
    changed.add(bond.toAtomId);
  }
  return dropOrphanedHydrogenHints(atoms.map((atom) => {
    const old = oldAtoms.get(atom.id);
    if (atom.hydrogenCount === undefined) return atom;
    if (!old ? !joined.has(atom.id) : !changed.has(atom.id) && sameAtomStatement(atom, old)) return atom;
    return withoutHydrogenHint(atom);
  }), bonds);
}

/**
 * Whether an atom still says what it said when its count was stated: every per-atom field that
 * changes its identity or the hydrogens it has room for. `formalCharge` already includes a charge
 * mark's share (`markCharge` only records which part came from a mark), and `markRadicals` is each
 * radical mark's unpaired electron, which costs the atom one hydrogen. A retyped label counts too,
 * even as the same element (`labelLiteral` set or cleared, as typing "O" over an O drawn "OH"
 * sets it): retyping is an explicit statement by the user, so the typed label wins and the chemistry
 * follows it (master decision 2026-11-22). A typed label that equals the label already drawn for
 * the atom never reaches here: the label commit treats it as no edit at all, so the count stays
 * (`commitNativeAtomLabelTarget` in the desktop app). Label position, color, visibility, a dismissed
 * warning and the recorded label bond side are not chemistry.
 */
function sameAtomStatement(atom: MoleculeAtom, old: MoleculeAtom): boolean {
  return atom.element === old.element &&
    (atom.labelLiteral === true) === (old.labelLiteral === true) &&
    atom.formalCharge === old.formalCharge &&
    atom.isotope === old.isotope &&
    (atom.markRadicals ?? 0) === (old.markRadicals ?? 0) &&
    atom.schemeAbbreviation === old.schemeAbbreviation;
}

/**
 * A stated count is one of two things. On an atom of an aromatic ring it settles which ring atom
 * carries the H; on an atom with no aromatic bond it is the count the source gave the atom itself
 * (a CDXML NumHydrogens kept because it disagrees with the derived count, owner ruling 1.2.3), and
 * validation badges it until the user settles it.
 *
 * A molecule built from part of another has no previous graph to diff against, so this is the rule
 * that applies there: an atom that still has an aromatic bond, but none of them in a ring (its ring
 * was cut), drops its hint instead of being badged for a count that described the old ring. An atom
 * with no aromatic bond keeps its count: nothing here can tell that it changed. A fragment copy is
 * rebuilt through `clearChangedAtomHydrogenHints` against its source molecule, which drops the count
 * of every atom whose bonds were cut. A merge cuts nothing: the absorbed atoms keep their counts on
 * their new ids, and the joining bond drops the counts of the two atoms it reaches, in one update
 * or two.
 * Returns `atoms` itself when nothing changes.
 */
export function dropOrphanedHydrogenHints(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): MoleculeAtom[] {
  if (!atoms.some((atom) => atom.hydrogenCount !== undefined)) return atoms as MoleculeAtom[];
  const otherEnd = (index: number, atomId: string) => {
    const bond = bonds[index]!;
    return bond.fromAtomId === atomId ? bond.toAtomId : bond.fromAtomId;
  };
  const bridges = bridgeBondIndices(bonds, otherEnd, () => true);
  const inRing = new Set<string>();
  const aromatic = new Set<string>();
  bonds.forEach((bond, index) => {
    if (bond.order !== "aromatic") return;
    aromatic.add(bond.fromAtomId);
    aromatic.add(bond.toAtomId);
    if (bridges.has(index) || bond.fromAtomId === bond.toAtomId) return;
    inRing.add(bond.fromAtomId);
    inRing.add(bond.toAtomId);
  });
  let changed = false;
  const next = atoms.map((atom) => {
    if (atom.hydrogenCount === undefined || !aromatic.has(atom.id) || inRing.has(atom.id)) return atom;
    changed = true;
    return withoutHydrogenHint(atom);
  });
  return changed ? next : atoms as MoleculeAtom[];
}

function withoutHydrogenHint(atom: MoleculeAtom): MoleculeAtom {
  const { hydrogenCount: _importedCount, ...unhinted } = atom;
  return unhinted;
}
