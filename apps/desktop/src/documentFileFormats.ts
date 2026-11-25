import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { exportDocumentToCdx } from "@chemdraft/cdx-compat";
import type { BinaryExportResult, ExportResult } from "@chemdraft/export-engine";
import { createNativeSavePayload, withoutEmbeddedPictureWarnings } from "./documentWorkflow";

/** Both destinations share the codec; only a document save includes native state. */
export function exportDocumentCdx(document: ChemDraftDocument, embedNativePayload: boolean): BinaryExportResult {
  return {
    ...exportDocumentToCdx(document, { embedNativePayload }),
    format: "cdx",
    kind: "binary",
    mimeType: "chemical/x-cdx",
    extension: "cdx"
  };
}

/**
 * A document save. Without a path (the web build's download, the payload made before the save
 * panel) the destination is a `.chemdraft` file. Picture notes are dropped only for a `.chemdraft`
 * destination, which keeps the picture; a `.cdxml` or `.cdx` save keeps them, as another program
 * opening that file will not show the picture.
 */
export function createDocumentFileSave(document: ChemDraftDocument, path?: string): ExportResult & { filename: string } {
  if (path && /\.cdx$/i.test(path)) {
    return { ...exportDocumentCdx(document, true), filename: path.split(/[\\/]/).pop()! };
  }
  const payload = createNativeSavePayload(document);
  const native = path === undefined || /\.chemdraft$/i.test(path);
  return { ...payload, warnings: native ? withoutEmbeddedPictureWarnings(document, payload.warnings) : payload.warnings,
    format: "cdxml", kind: "text", extension: "chemdraft" };
}
