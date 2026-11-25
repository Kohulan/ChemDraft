import { describe, expect, it } from "vitest";
import { applyPatch, type GraphicObject } from "@chemdraft/chem-core";
import { inspectClipboardPayload } from "@chemdraft/clipboard-adapter";
import {
  applyClipboardPastePayload, createNativeSavePayload, createPhase4Document,
  insertNativeTemplateMolecule, moveDocumentObjects, openNativeDocument, scaleDocumentObjectsAroundPoint
} from "./documentWorkflow";
import { picturePngBase64, pictureSvg } from "./testSupport/imageFixture";

describe("picture native document round trip", () => {
  it.each([
    ["image/png", picturePngBase64],
    ["image/svg+xml", btoa(pictureSvg)]
  ] as const)("preserves %s bytes, metadata and an edited frame beside real chemistry", (type, bytesBase64) => {
    const original = insertNativeTemplateMolecule(createPhase4Document("Picture Save"), { x: 500, y: 300 }, "benzene");
    const molecule = original.pages[0]!.objects.find(object => object.type === "molecule")!;
    const pasteResult = applyClipboardPastePayload(original, inspectClipboardPayload({
      types: [type], textItems: [], imageItems: [{ type, bytesBase64 }]
    }), { x: 200, y: 200 });
    expect(pasteResult.status).toBe("Pasted picture");
    const pasted = pasteResult.document;
    const image = pasted.pages[0]!.objects.find((object): object is GraphicObject =>
      object.type === "graphic" && object.graphicKind === "image")!;
    expect(image).toBeDefined();
    const id = image.id;
    expect(pasteResult.selectedObjectId).toBe(id);
    expect(pasted.selection.objectIds).toEqual([id]);
    const moved = moveDocumentObjects(pasted, [id], 17, 23);
    // A picture keeps its aspect ratio (owner decision): a 2 × 3 stretch about its centre scales it
    // uniformly by the mean factor, √6, and leaves the centre in place.
    const resized = scaleDocumentObjectsAroundPoint(moved, [id], { x: 217, y: 223 }, 2, 3);
    const rotated = applyPatch(resized, { op: "updateObject", objectId: id, changes: { rotation: 30 } });
    const expectedImage = rotated.pages[0]!.objects.find((object): object is GraphicObject => object.id === id && object.type === "graphic")!;
    const factor = Math.sqrt(6);
    expect(expectedImage).toMatchObject({
      type: "graphic", graphicKind: "image", rotation: 30,
      data: { image: { mimeType: type, dataBase64: bytesBase64, pixelWidth: 144, pixelHeight: 72 } }
    });
    expect(expectedImage.width).toBeCloseTo(image.width * factor, 9);
    expect(expectedImage.height).toBeCloseTo(image.height * factor, 9);
    expect(expectedImage.x).toBeCloseTo(217 - image.width * factor / 2, 9);
    expect(expectedImage.y).toBeCloseTo(223 - image.height * factor / 2, 9);
    const saved = createNativeSavePayload(rotated);
    const reopened = openNativeDocument(saved.contents);

    expect(saved.filename).toBe("Picture-Save.chemdraft");
    expect(reopened.document).toBeDefined();
    expect(reopened.document!.pages[0]!.objects).toHaveLength(2);
    expect(reopened.document!.pages[0]!.objects.find(object =>
      object.id === id && object.type === "graphic" && object.graphicKind === "image")).toEqual(expectedImage);
    expect(reopened.document!.pages[0]!.objects.find(object => object.id === molecule.id)).toEqual(molecule);
  });
});

describe("uniform scaling with a picture in the selection", () => {
  it("scales the picture and the chemistry beside it by the same factor, exactly as before", () => {
    const original = insertNativeTemplateMolecule(createPhase4Document("Picture Scale"), { x: 500, y: 300 }, "benzene");
    const molecule = original.pages[0]!.objects.find(object => object.type === "molecule")!;
    const pasted = applyClipboardPastePayload(original, inspectClipboardPayload({
      types: ["image/png"], textItems: [], imageItems: [{ type: "image/png", bytesBase64: picturePngBase64 }]
    }), { x: 200, y: 200 }).document;
    const image = pasted.pages[0]!.objects.find((object): object is GraphicObject =>
      object.type === "graphic" && object.graphicKind === "image")!;
    const pivot = { x: 300, y: 250 };
    const scaled = scaleDocumentObjectsAroundPoint(pasted, [image.id, molecule.id], pivot, 2, 2);
    const scaledImage = scaled.pages[0]!.objects.find(object => object.id === image.id) as GraphicObject;
    expect(scaledImage).toMatchObject({
      width: image.width * 2, height: image.height * 2,
      x: pivot.x + (image.x - pivot.x) * 2, y: pivot.y + (image.y - pivot.y) * 2
    });
    // The molecule scales as it does alone: the picture changes nothing about the chemistry.
    const moleculeAlone = scaleDocumentObjectsAroundPoint(pasted, [molecule.id], pivot, 2, 2);
    expect(scaled.pages[0]!.objects.find(object => object.id === molecule.id))
      .toEqual(moleculeAlone.pages[0]!.objects.find(object => object.id === molecule.id));
  });
});
