import { hydrogenAtomIgnoresStatedCount, type ChemDraftDocument } from "@chemdraft/chem-core";
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
  return document.pages.flatMap((page) => page.objects.flatMap((object) => {
    if (object.type !== "molecule") return [];
    const atoms = object.atoms.filter(hydrogenAtomIgnoresStatedCount);
    return atoms.length ? [{ code: NativeHydrogenCountNotCountedCode, message: `ChemDraft document: ${hydrogenCountNotCountedText(atoms)}`,
      sourceObjectId: object.id, atomIds: atoms.map((atom) => atom.id) }] : [];
  }));
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
