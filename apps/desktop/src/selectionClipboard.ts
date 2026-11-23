import { CSS_PX_PER_INCH, type ChemDraftDocument } from "@chemdraft/chem-core";
import { pngWithChemDraftSelection } from "@chemdraft/clipboard-adapter";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import type { ClipboardWriteItem } from "./clipboard";
import {
  CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, copyAsScopedDocument, exportPhase4Pdf, exportPhase4Svg,
  selectionClipboardPlainText, serializeSelectionClipboardPayload, type ChemDraftSelectionClipboardPayload
} from "./documentWorkflow";
import { detectDesktopShortcutPlatform } from "./keyboardShortcuts";
import { rasterizeSvgNative } from "./nativeRasterExport";

/** Prepare every flavor before the single native write clears the clipboard. */
export async function selectionClipboardImageItems(
  source: ChemDraftDocument,
  payload: ChemDraftSelectionClipboardPayload,
  platform: ShortcutPlatform = detectDesktopShortcutPlatform()
): Promise<{ items: ClipboardWriteItem[]; warnings: string[] }> {
  // Render exactly the copied objects (including fragments and carried marks), never the live
  // selection after an await. Reuse Copy As framing and export-engine's canvas geometry.
  const page = source.pages[0]!;
  const scoped = copyAsScopedDocument({ ...source,
    pages: [{ ...page, objects: payload.objects }],
    selection: { ...source.selection, objectIds: [] }
  });
  const json = serializeSelectionClipboardPayload(payload);
  const svg = await exportPhase4Svg(scoped, { includeWarnings: false });
  const raster = await rasterizeSvgNative(svg.contents, "png", {
    scale: 4, background: "#ffffff", maxDimensionPx: 8192, cssPxPerInch: CSS_PX_PER_INCH
  });
  const items: ClipboardWriteItem[] = [
    { type: CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, text: json, required: true },
    { type: "image/png", bytes: pngWithChemDraftSelection(raster.bytes, json), required: true },
    { type: "image/svg+xml", text: svg.contents, required: false }
  ];
  const warnings = [...svg.warnings, ...raster.warnings].map(warning => warning.message);
  if (platform === "macos") {
    items.push({ type: "public.svg-image", text: svg.contents, required: false });
    try {
      const pdf = await exportPhase4Pdf(scoped);
      items.push({ type: "application/pdf", bytes: pdf.bytes, required: false });
      warnings.push(...pdf.warnings.map(warning => warning.message));
    } catch (error) {
      // Some text cannot be represented by PDF. PNG still carries the exact drawing and data.
      warnings.push(`PDF was not copied: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const plainText = selectionClipboardPlainText(payload);
  if (plainText.length > 0) {
    items.push({ type: "text/plain", text: plainText, required: false });
  }
  return { items, warnings: [...new Set(warnings)] };
}
