import { atomIgnoresStatedHydrogenCount, type ChemDraftDocument } from "@chemdraft/chem-core";
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

/** The native twin of `cdxml.atom_hydrogen_count_not_kept` and `cdxml.atom_hydrogen_count_not_counted`:
 * an H, D or T atom, or an unknown atom "*", whose stored count is not counted. */
export const NativeHydrogenCountNotCountedCode = "document.atom_hydrogen_count_not_counted";

/** The CDXML importer's report of a count it kept but does not count, on an unknown atom or other label naming no element (cdx-compat). */
const CdxmlHydrogenCountNotCountedCode = "cdxml.atom_hydrogen_count_not_counted";

/**
 * One warning per molecule holding an atom that stores a hydrogen count nothing counts (chem-core
 * `atomIgnoresStatedHydrogenCount`: an H, D or T atom, or a label naming no element — an unknown
 * atom "*", a generic label such as A or R1 — stating a count other than 0). The document opens with the count as stored (it round-trips unchanged); the atom
 * validator flags the atom, and this names it in the open report, as the CDXML importer names a
 * count it did not keep or does not count. `source` heads the message; `objectIds`, when given,
 * limits the report to those molecules.
 */
export function nativeHydrogenCountNotCountedWarnings(
  document: ChemDraftDocument, source = "ChemDraft document", objectIds?: ReadonlySet<string>
): NativeDocumentOpenWarning[] {
  return document.pages.flatMap((page) => page.objects.flatMap((object) => {
    if (object.type !== "molecule" || (objectIds && !objectIds.has(object.id))) return [];
    const notCounted = object.atoms.filter(atomIgnoresStatedHydrogenCount);
    return notCounted.length ? [{ code: NativeHydrogenCountNotCountedCode, message: `${source}: ${hydrogenCountNotCountedText(notCounted)}`,
      sourceObjectId: object.id, atomIds: notCounted.map((atom) => atom.id) }] : [];
  }));
}

/**
 * The same warning for a plugin proposal the user reviews (`proposePatch`). Accepting stays allowed
 * (proposals are exempt from the plugin-boundary refusal), so the review and the accept say what
 * the document will hold. That is read from `after`, the document the proposal produces from
 * `before` through the accept path's own patch pipeline (a dry run at review, the committed
 * document at accept), never from the raw patch: applying an update clears a count whose atom,
 * element, charge or incident bonds changed (`clearChangedAtomHydrogenHints`), and a count that is
 * gone must not be reported as kept. `after` is undefined when the dry run failed; the accept then
 * reports that failure itself, so there is no warning here.
 *
 * Only molecules the proposal writes atoms into are reported: an object `after` holds that `before`
 * did not (an insertion, under whatever id it was given), and an existing molecule an `updateObject`
 * in `patch` (batch included, read defensively) writes an atom list to. A count already stored
 * elsewhere in the document is the open report's, not the proposal's. `source` heads the message
 * ("Proposed change", "Accepted change").
 */
export function proposedHydrogenCountNotCountedWarnings(
  before: ChemDraftDocument, after: ChemDraftDocument | undefined, patch: unknown, source = "Proposed change"
): NativeDocumentOpenWarning[] {
  if (!after) return [];
  const existing = new Set(before.pages.flatMap((page) => page.objects.map((object) => object.id)));
  const written = new Set(after.pages.flatMap((page) => page.objects.flatMap((object) => existing.has(object.id) ? [] : [object.id])));
  for (const id of atomWritingUpdateTargets(patch)) written.add(id);
  return written.size ? nativeHydrogenCountNotCountedWarnings(after, source, written) : [];
}

function atomWritingUpdateTargets(patch: unknown): string[] {
  if (!isRecord(patch)) return [];
  if (patch.op === "batch") return Array.isArray(patch.patches) ? patch.patches.flatMap(atomWritingUpdateTargets) : [];
  return patch.op === "updateObject" && typeof patch.objectId === "string" && isRecord(patch.changes) &&
    Array.isArray(patch.changes.atoms) ? [patch.objectId] : [];
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
  // A molecule the CDXML importer already reported (an unknown atom's count it kept for the file) is
  // not reported twice: the importer's warning names the same atoms by the file's node ids.
  const reported = new Set(result.warnings?.flatMap((warning) =>
    warning.code === CdxmlHydrogenCountNotCountedCode && warning.sourceObjectId ? [warning.sourceObjectId] : []));
  const notCounted = result.document && result.warnings
    ? nativeHydrogenCountNotCountedWarnings(result.document).filter((warning) => !reported.has(warning.sourceObjectId!))
    : [];
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
