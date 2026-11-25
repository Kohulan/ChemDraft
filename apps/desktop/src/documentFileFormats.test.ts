// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyPatch, createImageGraphicObject } from "@chemdraft/chem-core";
import { exportDocumentToCdx, importCdx } from "@chemdraft/cdx-compat";
import { createDialogExportResult } from "./MainWindow";
import { applyNativeChainTool, createNativeSavePayload, createPhase4Document } from "./documentWorkflow";
import { createDocumentFileSave } from "./documentFileFormats";
import { desktopExportFormatDescriptors, getDesktopExportFormatDescriptor } from "./desktopExportFormats";
import { updateExportDialogFormat } from "./dialogs/ExportForm";
import { exportFixture } from "./dialogs/exportTestFixtures";
import { picturePngBase64 } from "./testSupport/imageFixture";

describe("desktop CDX save and export", () => {
  const document = applyNativeChainTool(createPhase4Document("Binary saving"), { x: 100, y: 100 }, { x: 180, y: 100 });

  it.each(["/drawings/new.cdx", "C:\\drawings\\existing.CDX"])("saves %s with the exact native payload and codec warnings", path => {
    const result = createDocumentFileSave(document, path);
    expect(result.kind).toBe("binary");
    if (result.kind !== "binary") throw new Error("Expected CDX bytes");
    expect(result.bytes).toEqual(exportDocumentToCdx(document, { embedNativePayload: true }).bytes);
    expect(result.warnings).toEqual(exportDocumentToCdx(document, { embedNativePayload: true }).warnings);
    expect(importCdx(result.bytes).source).toBe("native-payload");
    expect(result.filename).toBe(path.split(/[\\/]/).pop());
  });

  it("keeps default, .chemdraft and .cdxml saves on the existing text path", () => {
    for (const path of [undefined, "drawing.chemdraft", "drawing.cdxml"]) {
      const result = createDocumentFileSave(document, path);
      expect(result.kind === "text" && result.contents).toBe(createNativeSavePayload(document).contents);
    }
  });

  it("offers CDX in Export and writes visible binary bytes without the native payload", async () => {
    const state = updateExportDialogFormat({ ...exportFixture(), busy: false }, "cdx");
    expect(state.filename.endsWith(".cdx")).toBe(true);
    expect(desktopExportFormatDescriptors.find(format => format.id === "cdx")).toBe(getDesktopExportFormatDescriptor("cdx"));
    expect(getDesktopExportFormatDescriptor("cdx").status).toBe("implemented");
    const result = await createDialogExportResult(document, state);
    expect(result.kind).toBe("binary");
    if (result.kind !== "binary") throw new Error("Expected CDX bytes");
    const expected = exportDocumentToCdx(document, { embedNativePayload: false });
    expect(result.bytes).toEqual(expected.bytes);
    expect(result.warnings).toEqual(expected.warnings);
    const reopened = importCdx(result.bytes);
    expect(reopened.source).toBe("external-cdxml");
    expect(reopened.document?.pages[0].objects.filter(object => object.type === "molecule")).toHaveLength(1);
  });
});

describe("picture notes on Save, Save As and Export", () => {
  const base = createPhase4Document("Picture notes");
  const picture = createImageGraphicObject({ mimeType: "image/png", dataBase64: picturePngBase64, center: { x: 200, y: 200 }, id: "image-1" });
  const document = applyPatch(base, { op: "addObject", pageId: base.pages[0]!.id, object: picture });
  const pictureNotes = (warnings: readonly { code: string }[]) => warnings.filter(warning => warning.code === "cdxml.picture_not_saved");

  it("drops the note only when the destination is a .chemdraft file, which keeps the picture", () => {
    // Save without a path (the web build's download) and Save to a .chemdraft file.
    for (const path of [undefined, "/drawings/picture.chemdraft", "C:\\drawings\\Picture.CHEMDRAFT"]) {
      expect(pictureNotes(createDocumentFileSave(document, path).warnings), String(path)).toEqual([]);
    }
  });

  it("keeps the note for Save As .cdxml or .cdx, where other programs will not show the picture", () => {
    for (const path of ["/drawings/picture.cdxml", "C:\\drawings\\Picture.CDXML", "/drawings/picture.cdx"]) {
      expect(pictureNotes(createDocumentFileSave(document, path).warnings).map(warning => (warning as { sourceObjectId?: string }).sourceObjectId), path)
        .toEqual(["image-1"]);
    }
  });

  it("keeps the note for Export CDXML and CDX", async () => {
    for (const format of ["cdxml", "cdx"] as const) {
      const state = updateExportDialogFormat({ ...exportFixture(), busy: false }, format);
      const result = await createDialogExportResult(document, state);
      expect(pictureNotes(result.warnings), format).toHaveLength(1);
    }
  });
});
