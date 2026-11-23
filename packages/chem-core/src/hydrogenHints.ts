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
 * Undefined where the count means something else, or where no typed label could state it:
 * - no count, or a typed literal label (its own text says what hydrogens it has);
 * - an atom on an aromatic bond, where the count settles which ring atom carries the H and the
 *   Kekulé resolution carries it;
 * - a label that is not a plain element symbol (D and T aside);
 * - an H, D or T atom stating any count but 0: no typed label draws a hydrogen atom carrying
 *   hydrogens of its own (the CDXML importer warns and does not keep such a count).
 * No valence model here: the count is passed through as stated, never re-derived.
 */
export function atomStatedHydrogenCount(
  atom: MoleculeAtom,
  bonds: readonly MoleculeBond[]
): number | undefined {
  const stated = atom.hydrogenCount;
  if (stated === undefined || atom.labelLiteral === true) return undefined;
  const hydrogen = atom.element === "H" || atom.element === "D" || atom.element === "T";
  if (hydrogen ? stated !== 0 : atomicNumberForElementSymbol(atom.element) === undefined) return undefined;
  for (const bond of bonds) {
    if (bond.order === "aromatic" && (bond.fromAtomId === atom.id || bond.toAtomId === atom.id)) return undefined;
  }
  return stated;
}

/**
 * An imported H count describes the imported graph, not subsequent chemical edits. A chemical edit
 * of an atom — its element, charge, isotope, radicals or scheme abbreviation, or its label retyped
 * (`sameAtomStatement`), the order or dative meaning of a bond at it, a bond added or removed at it —
 * drops that atom's count; moves, rotations, alignment, bond direction, wedges, styles, label
 * position and edits of other atoms keep it.
 *
 * An atom `previous` does not have (a pasted or sprouted atom, or one merged in from another
 * molecule on a re-minted id) has nothing to be compared with, so it keeps the count it arrives
 * with, even though every bond at it is new here. That is what keeps a merge's absorbed atoms'
 * counts: the merge re-mints them into the host and the joining bond is added afterward, so only
 * the two atoms that bond reaches drop theirs (their own diff sees it as a bond added at them).
 */
export function clearChangedAtomHydrogenHints(
  previous: Pick<MoleculeObject, "atoms" | "bonds">,
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): MoleculeAtom[] {
  const changed = new Set<string>();
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
    }
  }
  for (const bond of oldBonds.values()) {
    changed.add(bond.fromAtomId);
    changed.add(bond.toAtomId);
  }
  const oldAtoms = new Map(previous.atoms.map((atom) => [atom.id, atom]));
  return dropOrphanedHydrogenHints(atoms.map((atom) => {
    const old = oldAtoms.get(atom.id);
    if (atom.hydrogenCount === undefined || !old || (!changed.has(atom.id) && sameAtomStatement(atom, old))) return atom;
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
 * their new ids, and the joining bond drops the counts of the two atoms it reaches.
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
