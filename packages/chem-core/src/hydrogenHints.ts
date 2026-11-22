import { bridgeBondIndices } from "./bondGraph";
import { isDativeBond } from "./molfile";
import type { MoleculeAtom, MoleculeBond, MoleculeObject } from "./schemas";

/**
 * An imported H count describes the imported graph, not subsequent chemical edits. A chemical edit
 * of an atom — its element or charge, the order or dative meaning of a bond at it, a bond added or
 * removed at it — drops that atom's count; moves, rotations, alignment, bond direction, wedges,
 * styles and edits of other atoms keep it.
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
    if (atom.hydrogenCount === undefined || !old ||
      (!changed.has(atom.id) && atom.element === old.element && atom.formalCharge === old.formalCharge)) return atom;
    return withoutHydrogenHint(atom);
  }), bonds);
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
 * with no aromatic bond keeps its count: nothing here can tell that it changed, and the callers that
 * cut a molecule (a fragment copy, a merge) rebuild it through `clearChangedAtomHydrogenHints`
 * against the source molecule, which drops the count of every atom whose bonds were cut.
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
