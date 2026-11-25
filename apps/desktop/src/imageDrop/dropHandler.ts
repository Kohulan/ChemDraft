import { documentTooLargeReason, fitPicturesInDocument, pictureBudgetBytes, savedPictureBytes } from "./dropDocumentBudget";
import {
  MAX_DROPPED_IMAGES, MAX_DROPPED_IMAGE_BYTES, MAX_DROPPED_IMAGE_TOTAL_BYTES, classifyDroppedFile,
  droppedFileBaseName, droppedImageSizeError, dropRefusal, formatDropBytes
} from "./dropFiles";
import { prepareDroppedImage, type PrepareDroppedImageResult, type PreparedDroppedImage } from "./prepareDroppedImage";
import { untilAborted, type DroppedImageDecoders } from "./rasterDecode";

/**
 * How long one file may take to read back through the webview (decode, and for JPEG, GIF and WebP
 * the PNG encode). A decoder that never settles would otherwise hold every later drop.
 */
export const DROPPED_IMAGE_DEADLINE_MS = 30_000;

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

export interface PrepareDropOptions {
  /** Per file; `DROPPED_IMAGE_DEADLINE_MS` by default. */
  deadlineMs?: number;
  /**
   * Saved bytes the pictures may add to the document (`pictureBudgetBytes`). A picture past it is
   * refused by name as soon as it is prepared, so the base64 held for one drop stays within what
   * the document could take; unlimited by default.
   */
  budgetBytes?: number;
}

/** One file under its deadline: the decoders see the signal, and a result after it is dropped. */
async function prepareWithDeadline(name: string, bytes: Uint8Array, decoders: DroppedImageDecoders, deadlineMs: number): Promise<PrepareDroppedImageResult> {
  const controller = new AbortController();
  const seconds = Math.round(deadlineMs / 100) / 10;
  const timer = setTimeout(() => controller.abort(new Error(`reading it took longer than ${seconds} seconds.`)), deadlineMs);
  try {
    return await untilAborted(prepareDroppedImage(name, bytes, decoders, { signal: controller.signal }), controller.signal);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check the count and size caps from metadata, then read and prepare each picture in turn (one in
 * memory at a time, each under its deadline). One failure never stops the others.
 */
export async function prepareDroppedImages(
  sources: readonly DroppedImageSource[],
  decoders: DroppedImageDecoders,
  options: PrepareDropOptions = {}
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
  let budget = options.budgetBytes ?? Number.POSITIVE_INFINITY;
  for (const source of admitted) {
    let bytes: Uint8Array;
    try {
      bytes = await source.read(MAX_DROPPED_IMAGE_BYTES);
    } catch (error) {
      refuse(source.name, error instanceof Error ? error.message : String(error));
      continue;
    }
    const prepared = await prepareWithDeadline(droppedFileBaseName(source.name), bytes, decoders, options.deadlineMs ?? DROPPED_IMAGE_DEADLINE_MS);
    if (!prepared.ok) { refuse(source.name, prepared.reason); continue; }
    const cost = savedPictureBytes(prepared.image.dataBase64.length);
    if (cost > budget) { refuse(source.name, documentTooLargeReason()); continue; }
    budget -= cost;
    result.images.push(prepared.image);
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
  /** Why the drop's target cannot take pictures now (the edit guards), asked at drop time. */
  insertRefusal?(): string | undefined;
  /** Saved bytes of the drop's target document, asked at drop time and again at commit. */
  documentBytes(): number;
  /** Checks the drop's target tab and edit guards, then commits all pictures as one undo entry. */
  insertImages(images: PreparedDroppedImage[]): DroppedImageInsertion;
  /**
   * Runs the commit once no canvas gesture is live (a gesture rebuilds the document from its own
   * start when it ends, which would wipe the pictures). Rejects, with the reason as its message, when
   * the canvas stays busy too long.
   */
  whenIdle?<R>(commit: () => R): Promise<R>;
  decoders: DroppedImageDecoders;
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
  // Told at once, before anything is read; asked again at commit, after the read.
  const refusedNow = split.images.length ? handler.insertRefusal?.() : undefined;
  const pictures = async () => {
    if (split.images.length) {
      handler.setStatus(`Reading ${split.images.length === 1 ? "the dropped picture" : `${split.images.length} dropped pictures`}…`);
    }
    const prepared = await prepareDroppedImages(split.images.map(handler.imageSource), handler.decoders,
      { budgetBytes: pictureBudgetBytes(handler.documentBytes()) });
    const prepareRefusals = [...split.refusals, ...prepared.refusals];
    if (!prepared.images.length) return formatImageDropStatus({ inserted: [], refusals: prepareRefusals });
    const commit = () => {
      // The document may have grown while the pictures were read: measure it again.
      const { fit, refused } = fitPicturesInDocument(prepared.images, handler.documentBytes());
      const refusals = [...prepareRefusals, ...refused];
      if (!fit.length) return formatImageDropStatus({ inserted: [], refusals });
      const insertion = handler.insertImages(fit);
      return insertion.ok
        ? formatImageDropStatus({ inserted: fit, scaledToPage: insertion.scaledToPage, refusals })
        : formatImageDropStatus({ inserted: fit, refusals, notInserted: `The dropped pictures were not inserted: ${insertion.reason}` });
    };
    try {
      return handler.whenIdle ? await handler.whenIdle(commit) : commit();
    } catch (error) {
      return formatImageDropStatus({ inserted: prepared.images, refusals: prepareRefusals,
        notInserted: `The dropped pictures were not inserted: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  const status = refusedNow
    // Not queued behind an earlier drop still being read: the refusal shows now.
    ? formatImageDropStatus({ inserted: [], refusals: split.refusals, notInserted: `The dropped pictures were not inserted: ${refusedNow}` })
    : await (handler.serialize ? handler.serialize(pictures) : pictures());
  const documentStatus = split.documents.length ? await handler.openDocuments(split.documents) : undefined;
  handler.setStatus([status, documentStatus].filter(Boolean).join("; "));
}
