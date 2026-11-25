import {
  applyPatches, createImageGraphicObject, nextObjectId, type ChemDraftDocument, type DocumentPatch, type GraphicObject
} from "@chemdraft/chem-core";
import { firstPage, phase4Timestamp } from "@chemdraft/document-workflow-core";
import type { PreparedDroppedImage } from "./prepareDroppedImage";

/** Each further picture of one drop moves down and right by this much, in page units. */
export const DROP_CASCADE_OFFSET = 24;

export interface PagePointLike { x: number; y: number }
export interface DropFrame { x: number; y: number; width: number; height: number; scaled: boolean }

/**
 * Centres along one axis for a cascade of `extents` (each no longer than `pageExtent`). Picture `i`
 * sits `i` steps from `point`, towards whichever side of the page has room (down/right by
 * preference). Each picture is sized against its own room, not the batch's: its step shrinks only
 * when its own whole cascade could not fit, and that cascade is shifted as a unit onto the page. So
 * a picture that fills the page does not pin the small pictures beside it to one spot; every picture
 * keeps a position of its own whenever it has room on the page.
 */
function cascadeCentres(point: number, extents: readonly number[], pageExtent: number, cascade: number): number[] {
  const count = extents.length;
  const layout = (direction: 1 | -1) => extents.map((extent, index) => {
    const room = Math.max(0, pageExtent - extent);
    const step = count > 1 ? Math.min(cascade, room / (count - 1)) : 0;
    const last = point + direction * (count - 1) * step;
    const low = Math.min(point, last) - extent / 2;
    const high = Math.max(point, last) + extent / 2;
    const shift = low < 0 ? -low : high > pageExtent ? pageExtent - high : 0;
    return { centre: point + direction * index * step + shift, shift: Math.abs(shift) };
  });
  const moved = (centres: ReturnType<typeof layout>) => centres.reduce((total, entry) => total + entry.shift, 0);
  const forward = layout(1);
  const backward = layout(-1);
  return (moved(backward) < moved(forward) ? backward : forward).map(entry => entry.centre);
}

/**
 * Frames for the pictures of one drop. The first is centred on `point`, the rest cascade from it
 * (see `cascadeCentres`). Each keeps its natural size unless larger than the page, when it shrinks
 * uniformly to fit (never grows), and lies wholly on the page.
 */
export function placeDroppedImages(
  page: { width: number; height: number },
  point: PagePointLike,
  sizes: readonly { width: number; height: number }[],
  cascade = DROP_CASCADE_OFFSET
): DropFrame[] {
  const fitted = sizes.map(size => {
    const fit = Math.min(1, page.width / size.width, page.height / size.height);
    return { width: size.width * fit, height: size.height * fit, scaled: fit < 1 };
  });
  const xs = cascadeCentres(point.x, fitted.map(size => size.width), page.width, cascade);
  const ys = cascadeCentres(point.y, fitted.map(size => size.height), page.height, cascade);
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), Math.max(0, max));
  return fitted.map(({ width, height, scaled }, index) => ({
    x: clamp(xs[index]! - width / 2, page.width - width),
    y: clamp(ys[index]! - height / 2, page.height - height),
    width, height, scaled
  }));
}

export interface InsertDroppedImagesResult {
  document: ChemDraftDocument;
  objectIds: string[];
  /** Names of pictures shrunk to fit the page. */
  scaledToPage: string[];
}

/**
 * Add every picture of one drop and select them, in a single patch batch: the caller commits it as
 * one undo entry. Object ids are allocated against the document being committed.
 */
export function insertDroppedImages(
  document: ChemDraftDocument,
  images: readonly PreparedDroppedImage[],
  point: PagePointLike
): InsertDroppedImagesResult {
  const page = firstPage(document);
  const reserved = new Set<string>();
  const objects: GraphicObject[] = images.map(image => {
    const id = nextObjectId(document, "image", reserved);
    reserved.add(id);
    const object = createImageGraphicObject({ mimeType: image.mimeType, dataBase64: image.dataBase64, center: { x: 0, y: 0 }, id });
    return image.naturalSize ? { ...object, width: image.naturalSize.width, height: image.naturalSize.height } : object;
  });
  const frames = placeDroppedImages(page, point, objects);
  const placed = objects.map((object, index) => {
    const { x, y, width, height } = frames[index]!;
    return { ...object, x, y, width, height };
  });
  const patches: DocumentPatch[] = [
    ...placed.map(object => ({ op: "addObject" as const, pageId: page.id, object })),
    { op: "setSelection", pageId: page.id, objectIds: placed.map(object => object.id) }
  ];
  return {
    document: placed.length ? applyPatches(document, patches, { now: phase4Timestamp }) : document,
    objectIds: placed.map(object => object.id),
    scaledToPage: images.filter((_, index) => frames[index]!.scaled).map(image => image.name)
  };
}
