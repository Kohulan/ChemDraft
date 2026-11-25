/**
 * A drop must never make a document ChemDraft refuses to reopen (`MAX_OPEN_DOCUMENT_BYTES`). A
 * picture's base64 sits in the native document JSON, and the saved CDXML envelope stores that JSON
 * base64-encoded again, so each picture costs about 4/3 of its own base64 in the file. The pictures
 * are estimated from their lengths, never by serializing the document they would make; the existing
 * document is measured from its save payload, which autosave has usually built already.
 */
import { MAX_OPEN_DOCUMENT_BYTES } from "../documentText";
import { formatDropBytes } from "./dropFiles";

/** Kept free under the open limit: the estimate's slack, and room for the document to grow. */
export const DROP_DOCUMENT_MARGIN_BYTES = 1024 * 1024;
/** A picture object's own fields in the native JSON beside its base64, generously. */
const PICTURE_OBJECT_JSON_BYTES = 1024;

/** Bytes a picture with `dataBase64Length` characters of data adds to the saved file, rounded up. */
export function savedPictureBytes(dataBase64Length: number): number {
  return Math.ceil((dataBase64Length + PICTURE_OBJECT_JSON_BYTES) * 4 / 3);
}

/** UTF-8 length of `text` without encoding it. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) { bytes += 4; index += 1; }
    else bytes += 3;
  }
  return bytes;
}

/** Saved bytes of a document, from the text of its save payload. */
export function savedDocumentBytes(saveContents: string): number {
  return utf8Length(saveContents);
}

/** What pictures may add to a document of `documentBytes` saved bytes. */
export function pictureBudgetBytes(documentBytes: number): number {
  return Math.max(0, MAX_OPEN_DOCUMENT_BYTES - DROP_DOCUMENT_MARGIN_BYTES - documentBytes);
}

export function documentTooLargeReason(): string {
  return `it would make the document larger than ${formatDropBytes(MAX_OPEN_DOCUMENT_BYTES)}, the most ChemDraft can open.`;
}

/** In drop order, the pictures that fit beside `documentBytes`; every other one by name. */
export function fitPicturesInDocument<T extends { name: string; dataBase64: string }>(
  images: readonly T[],
  documentBytes: number
): { fit: T[]; refused: Array<{ name: string; reason: string }> } {
  let budget = pictureBudgetBytes(documentBytes);
  const fit: T[] = [];
  const refused: Array<{ name: string; reason: string }> = [];
  for (const image of images) {
    const cost = savedPictureBytes(image.dataBase64.length);
    if (cost <= budget) {
      budget -= cost;
      fit.push(image);
    } else {
      refused.push({ name: image.name, reason: documentTooLargeReason() });
    }
  }
  return { fit, refused };
}
