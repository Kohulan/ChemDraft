import { hydrogenAtomIgnoresStatedCount, type ChemDraftDocument, type MoleculeAtom } from "@chemdraft/chem-core";
import { hydrogenCountNotCountedText, withNativeDocumentLabelBondSides } from "./atoms";

/** An open warning, shaped like the CDXML importer's (`sourceObjectId` and `atomIds` let Show select it). */
export interface NativeDocumentOpenWarning {
  code: string;
  message: string;
  sourceObjectId?: string;
  atomIds?: string[];
}

interface NativeDocumentPayload {
  document?: ChemDraftDocument;
  conflict?: { embeddedDocument: ChemDraftDocument; visibleDocument?: ChemDraftDocument };
  warnings?: NativeDocumentOpenWarning[];
}

/** The native twin of `cdxml.atom_hydrogen_count_not_kept`: an H, D or T atom whose stored count is not counted. */
export const NativeHydrogenCountNotCountedCode = "document.atom_hydrogen_count_not_counted";

/**
 * One warning per molecule holding an H, D or T atom that stores a hydrogen count other than 0. The
 * document opens with the count as stored (it round-trips unchanged); the atom validator flags the
 * atom, and this names it in the open report, as the CDXML importer names a count it did not keep.
 */
export function nativeHydrogenCountNotCountedWarnings(document: ChemDraftDocument): NativeDocumentOpenWarning[] {
  return document.pages.flatMap((page) => page.objects.flatMap((object) =>
    object.type === "molecule" ? moleculeHydrogenCountNotCountedWarnings(object.id, object.atoms, "ChemDraft document") : []));
}

/**
 * The same warning for a plugin proposal the user reviews (`proposePatch`): one per molecule the
 * proposed patch adds or updates whose atoms include an H, D or T atom stating a count other than
 * 0. Accepting stays allowed (proposals are exempt from the plugin-boundary refusal), so the review
 * and the accept say what the document will hold. `source` heads the message ("Proposed change",
 * "Accepted change"). The patch is read defensively: a queued proposal's patch is only validated
 * when it is applied, and anything that is not a molecule's atom list is skipped.
 */
export function proposedHydrogenCountNotCountedWarnings(patch: unknown, source = "Proposed change"): NativeDocumentOpenWarning[] {
  return proposedMoleculeAtoms(patch).flatMap(({ id, atoms }) => moleculeHydrogenCountNotCountedWarnings(id, atoms, source));
}

function moleculeHydrogenCountNotCountedWarnings(
  moleculeId: string, atoms: readonly MoleculeAtom[], source: string
): NativeDocumentOpenWarning[] {
  const notCounted = atoms.filter(hydrogenAtomIgnoresStatedCount);
  return notCounted.length ? [{ code: NativeHydrogenCountNotCountedCode, message: `${source}: ${hydrogenCountNotCountedText(notCounted)}`,
    sourceObjectId: moleculeId, atomIds: notCounted.map((atom) => atom.id) }] : [];
}

function proposedMoleculeAtoms(patch: unknown): { id: string; atoms: MoleculeAtom[] }[] {
  if (!isRecord(patch)) return [];
  if (patch.op === "batch") return Array.isArray(patch.patches) ? patch.patches.flatMap(proposedMoleculeAtoms) : [];
  const [id, written] = patch.op === "addObject" && isRecord(patch.object) && patch.object.type === "molecule"
    ? [patch.object.id, patch.object.atoms]
    : patch.op === "updateObject" && isRecord(patch.changes) ? [patch.objectId, patch.changes.atoms] : [undefined, undefined];
  if (typeof id !== "string" || !Array.isArray(written)) return [];
  const atoms = written.filter((atom): atom is MoleculeAtom =>
    isRecord(atom) && typeof atom.id === "string" && typeof atom.element === "string");
  return atoms.length ? [{ id, atoms }] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shared app/agent open path. The caller injects the container decoder (native JSON or CDXML
 * envelope), which uses chem-core's tolerant reader and retains its warnings/version envelope.
 * Keeping decoding injected avoids coupling pure document workflows to a file-format package. */
export function readNativeDocumentContents<T extends NativeDocumentPayload>(
  contents: string,
  readPayload: (contents: string) => T
): T {
  const result = readPayload(contents);
  const { conflict } = result;
  const notCounted = result.document && result.warnings ? nativeHydrogenCountNotCountedWarnings(result.document) : [];
  return {
    ...result,
    ...(notCounted.length ? { warnings: [...result.warnings!, ...notCounted] } : {}),
    ...(result.document ? { document: withNativeDocumentLabelBondSides(result.document) } : {}),
    ...(conflict ? { conflict: {
      ...conflict,
      embeddedDocument: withNativeDocumentLabelBondSides(conflict.embeddedDocument),
      ...(conflict.visibleDocument ? { visibleDocument: withNativeDocumentLabelBondSides(conflict.visibleDocument) } : {})
    } } : {})
  };
}
