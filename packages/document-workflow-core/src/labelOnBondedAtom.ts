import { bridgeBondIndices, isDativeBond, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import {
  nativeAtomBondOrderUsage, nativeAtomChargeSupportsValence, nativeAtomLabelFreeValence,
  nativeAtomLabelContextInMolecule, nativeAtomLabelHeadElement, nativeAtomLabelReading,
  nativeAtomValidationState, nativeAtomValence, type NativeAtomLabelReading
} from "./atoms";

/** The validation/ring-template admission measure, including Kekulé orders and radicals. */
export function nativeAtomExternalValence(molecule: MoleculeObject, atom: MoleculeAtom): number {
  return nativeAtomBondOrderUsage(atom.id, molecule.bonds, molecule.atoms) + (atom.markRadicals ?? 0);
}

export interface LabelOnBondedAtomDecision {
  /** unchanged means the existing zero/one-bond label path needs no special handling. */
  kind: "unchanged" | "relabel" | "substituent";
  bondCount: number;
  external: number;
  reading: NativeAtomLabelReading["kind"];
  freeValence?: number;
  reason?: "one-bond" | "generic" | "heavy-hydrogen" | "source-valence";
}

/** Decide using the atom and molecule BEFORE typing, never an intermediate draft atom. */
export function labelOnBondedAtom(
  label: string, atom: MoleculeAtom, molecule: MoleculeObject, replaceElement = false
): LabelOnBondedAtomDecision {
  const bondCount = molecule.bonds.filter(b => b.fromAtomId === atom.id || b.toAtomId === atom.id).length;
  const external = nativeAtomExternalValence(molecule, atom);
  // The typed reading: the label as written, bond on its left. A substituent keeps it whichever
  // side it lands on (its side is recorded so), so a cyano label's free valence is the cyano group's.
  const context = { bonded: bondCount > 0, bondSide: "left" as const };
  const typed = nativeAtomLabelReading(label, context);
  const reading = typed.kind;
  // An attached label is a new neutral atom; the source retains its own charge.
  // Element labels normally leave room for implicit hydrogens, so FreeValence is undefined.
  const freeValence = nativeAtomLabelFreeValence(label, 0, context);
  const base = { bondCount, external, reading, freeValence };
  if (bondCount < 2) return { ...base, kind: "unchanged" };
  const sourceContext = nativeAtomLabelContextInMolecule(atom, molecule, true);
  const source = nativeAtomLabelReading(atom.element, sourceContext);
  const monovalentElement = typed.kind === "element" && nativeAtomValence[typed.element] === 1;
  // Explicit monovalent element edits can replace ring carbons. Acyclic carbons and hover
  // shortcuts retain the usual substituent decision.
  if (replaceElement && monovalentElement &&
      (source.kind === "element" || source.kind === "spelled") && source.element === "C" &&
      isCovalentRingVertex(molecule, atom.id)) return { ...base, kind: "relabel" };
  const monovalentElementSubstituent = atom.element === "C" && monovalentElement;
  const sourceHead = nativeAtomLabelHeadElement(atom.element, sourceContext);
  const sameHead = sourceHead !== undefined && sourceHead === nativeAtomLabelHeadElement(label, context);
  // A spelled H count can complete a higher valence than its minimum free valence (SH at S(IV)).
  // An explicit same-head heteroatom composite edits that head even when invalid (PPh2 with two
  // solid bonds); ordinary validation still flags it, without adding P or changing the charge.
  if (sameHead && ((typed.kind === "spelled" && nativeAtomValidationState(
    { ...atom, element: label, labelLiteral: true }, molecule.bonds, atom.formalCharge, molecule.atoms
  ).valid) || (typed.kind === "group" && typed.group.kind === "composite" && typed.group.head !== "C"))) {
    return { ...base, kind: "relabel" };
  }
  if (freeValence !== undefined && freeValence === external) return { ...base, kind: "relabel" };
  const reason = reading === "generic" ? "generic" : reading === "heavy-hydrogen" ? "heavy-hydrogen"
    : freeValence === 1 || monovalentElementSubstituent ? "one-bond" : undefined;
  if (!reason) return { ...base, kind: "relabel" };

  // #83 distinguishes an imported element (Ac/Pr/Ts/Ar) from the typed group spelling,
  // and a cyano label's recorded bond side from the side its current geometry suggests.
  const sourceFree = nativeAtomLabelFreeValence(atom.element, atom.formalCharge, sourceContext);
  const supports = source.kind === "element"
    ? nativeAtomChargeSupportsValence(source.element, external + 1, atom.formalCharge)
    : source.kind === "heavy-hydrogen" ? external + 1 <= 1
    : sourceFree === undefined || external + 1 <= sourceFree;
  return supports ? { ...base, kind: "substituent", reason }
    : { ...base, kind: "relabel", reason: "source-valence" };
}

function isCovalentRingVertex({ bonds }: MoleculeObject, atomId: string): boolean {
  const otherEnd = (index: number, id: string) =>
    bonds[index]!.fromAtomId === id ? bonds[index]!.toAtomId : bonds[index]!.fromAtomId;
  const bridges = bridgeBondIndices(bonds, otherEnd, bond => !isDativeBond(bond));
  return bonds.some((bond, index) => bond.fromAtomId !== bond.toAtomId &&
    (bond.fromAtomId === atomId || bond.toAtomId === atomId) && !isDativeBond(bond) && !bridges.has(index));
}
