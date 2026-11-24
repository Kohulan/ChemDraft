// Small pure helpers shared by the document-building modules: ids, page access, numeric utilities.
// Moved verbatim from apps/desktop/src/documentWorkflow.ts; see this package's README.

import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { LayoutPoint } from "@chemdraft/layout-engine";

export const phase4Timestamp = "2026-05-29T00:00:00.000Z";

export type PagePoint = LayoutPoint;

// The object-id allocator lives in chem-core, which the native file reader also uses to renumber
// duplicate same-page ids on open; re-exported here so every builder keeps importing it from this module.
export { nextObjectId } from "@chemdraft/chem-core";

export function firstPage(document: ChemDraftDocument): ChemDraftDocument["pages"][number] {
  const page = document.pages[0];
  if (!page) {
    throw new Error("Cannot update page layout: document has no pages.");
  }

  return page;
}

// The same numeric helpers layout-engine uses, re-exported rather than copied (AGENTS.md §5.26).
export { clamp, distance } from "@chemdraft/layout-engine";
