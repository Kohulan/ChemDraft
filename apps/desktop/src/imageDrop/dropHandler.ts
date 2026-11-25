import {
  MAX_DROPPED_IMAGES, MAX_DROPPED_IMAGE_BYTES, MAX_DROPPED_IMAGE_TOTAL_BYTES, classifyDroppedFile,
  droppedFileBaseName, droppedImageSizeError, dropRefusal, formatDropBytes
} from "./dropFiles";
import { prepareDroppedImage, type PreparedDroppedImage } from "./prepareDroppedImage";
import type { RasterToPng } from "./rasterDecode";

/** One dropped file as either route sees it: a Tauri path or a browser `File`. */
export interface DroppedImageSource {
  name: string;
  /** Size from metadata (native stat, `File.size`), before anything is read. */
  size(): Promise<number>;
  /** Read the whole file, failing as soon as it is longer than `maxBytes`. */
  read(maxBytes: number): Promise<Uint8Array>;
}

export interface DropRefusalEntry { name: string; reason: string }

export interface SplitDrop<T> {
  images: T[];
  documents: T[];
  refusals: DropRefusalEntry[];
}

/** Pictures by extension; picture types that cannot be dropped are refused by name; the rest open. */
export function splitDrop<T>(files: readonly T[], nameOf: (file: T) => string): SplitDrop<T> {
  const split: SplitDrop<T> = { images: [], documents: [], refusals: [] };
  for (const file of files) {
    const role = classifyDroppedFile(nameOf(file));
    if (role.kind === "image") split.images.push(file);
    else if (role.kind === "refused") split.refusals.push({ name: nameOf(file), reason: role.reason });
    else split.documents.push(file);
  }
  return split;
}

export interface PreparedDrop {
  images: PreparedDroppedImage[];
  refusals: DropRefusalEntry[];
}

/**
 * Check the count and size caps from metadata, then read and prepare each picture in turn (one in
 * memory at a time). One failure never stops the others.
 */
export async function prepareDroppedImages(
  sources: readonly DroppedImageSource[],
  rasterToPng: RasterToPng
): Promise<PreparedDrop> {
  const result: PreparedDrop = { images: [], refusals: [] };
  const refuse = (name: string, reason: string) => result.refusals.push({ name, reason });
  let totalBytes = 0;
  const admitted: DroppedImageSource[] = [];
  for (const [index, source] of sources.entries()) {
    if (index >= MAX_DROPPED_IMAGES) {
      refuse(source.name, `only ${MAX_DROPPED_IMAGES} pictures can be dropped at once.`);
      continue;
    }
    let size: number;
    try {
      size = await source.size();
    } catch (error) {
      refuse(source.name, `its size could not be read (${error instanceof Error ? error.message : String(error)}).`);
      continue;
    }
    const sizeError = droppedImageSizeError(size);
    if (sizeError) { refuse(source.name, sizeError); continue; }
    if (totalBytes + size > MAX_DROPPED_IMAGE_TOTAL_BYTES) {
      refuse(source.name, `the pictures in one drop can total at most ${formatDropBytes(MAX_DROPPED_IMAGE_TOTAL_BYTES)}.`);
      continue;
    }
    totalBytes += size;
    admitted.push(source);
  }
  for (const source of admitted) {
    let bytes: Uint8Array;
    try {
      bytes = await source.read(MAX_DROPPED_IMAGE_BYTES);
    } catch (error) {
      refuse(source.name, error instanceof Error ? error.message : String(error));
      continue;
    }
    const prepared = await prepareDroppedImage(droppedFileBaseName(source.name), bytes, rasterToPng);
    if (prepared.ok) result.images.push(prepared.image);
    else refuse(source.name, prepared.reason);
  }
  return result;
}

const LISTED = 5;

function listNames(names: readonly string[]): string {
  const shown = names.slice(0, LISTED).join(", ");
  return names.length > LISTED ? `${shown} and ${names.length - LISTED} more` : shown;
}

/** What was inserted, how it was adjusted, and every refusal with its file and reason. */
export function formatImageDropStatus(outcome: {
  inserted: readonly PreparedDroppedImage[];
  scaledToPage?: readonly string[];
  refusals: readonly DropRefusalEntry[];
  notInserted?: string;
}): string {
  const parts: string[] = [];
  const count = outcome.inserted.length;
  if (outcome.notInserted) parts.push(outcome.notInserted);
  else if (count === 1) parts.push(`Inserted picture ${outcome.inserted[0]!.name}`);
  else if (count > 1) parts.push(`Inserted ${count} pictures (${listNames(outcome.inserted.map(image => image.name))})`);
  else if (outcome.refusals.length) parts.push("No pictures were inserted");
  if (!outcome.notInserted) {
    for (const image of outcome.inserted) {
      for (const note of image.notes) parts.push(`${image.name}: ${note}`);
    }
    if (outcome.scaledToPage?.length) parts.push(`scaled to fit the page: ${listNames(outcome.scaledToPage)}`);
  }
  for (const refusal of outcome.refusals.slice(0, LISTED)) parts.push(dropRefusal(refusal.name, refusal.reason));
  if (outcome.refusals.length > LISTED) parts.push(`${outcome.refusals.length - LISTED} more files were refused`);
  return parts.join("; ");
}

export type DroppedImageInsertion =
  | { ok: true; scaledToPage: readonly string[] }
  | { ok: false; reason: string };

export interface DroppedFilesHandler<T> {
  nameOf(file: T): string;
  imageSource(file: T): DroppedImageSource;
  /** The existing document-open path, unchanged; resolves to its own summary status, if any. */
  openDocuments(files: T[]): Promise<string | undefined>;
  /** Checks the drop's target tab and edit guards, then commits all pictures as one undo entry. */
  insertImages(images: PreparedDroppedImage[]): DroppedImageInsertion;
  rasterToPng: RasterToPng;
  setStatus(status: string): void;
  /** Runs the picture work after any earlier drop's, so two drops never interleave their commits. */
  serialize?: <R>(task: () => Promise<R>) => Promise<R>;
}

/**
 * One handler for both drop routes. A drop with no pictures goes to the document-open path exactly
 * as before. Otherwise pictures are prepared and inserted first, into the tab under the drop, and any
 * documents open afterwards (opening one switches tabs).
 */
export async function handleDroppedFiles<T>(files: readonly T[], handler: DroppedFilesHandler<T>): Promise<void> {
  const split = splitDrop(files, handler.nameOf);
  if (!split.images.length && !split.refusals.length) {
    if (split.documents.length) await handler.openDocuments(split.documents);
    return;
  }
  const pictures = async () => {
    if (split.images.length) {
      handler.setStatus(`Reading ${split.images.length === 1 ? "the dropped picture" : `${split.images.length} dropped pictures`}…`);
    }
    const prepared = await prepareDroppedImages(split.images.map(handler.imageSource), handler.rasterToPng);
    const refusals = [...split.refusals, ...prepared.refusals];
    if (!prepared.images.length) return formatImageDropStatus({ inserted: [], refusals });
    const insertion = handler.insertImages(prepared.images);
    return insertion.ok
      ? formatImageDropStatus({ inserted: prepared.images, scaledToPage: insertion.scaledToPage, refusals })
      : formatImageDropStatus({ inserted: prepared.images, refusals,
        notInserted: `The dropped pictures were not inserted: ${insertion.reason}` });
  };
  const status = await (handler.serialize ? handler.serialize(pictures) : pictures());
  const documentStatus = split.documents.length ? await handler.openDocuments(split.documents) : undefined;
  handler.setStatus([status, documentStatus].filter(Boolean).join("; "));
}
