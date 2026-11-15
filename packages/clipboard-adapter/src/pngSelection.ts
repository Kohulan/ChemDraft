import { MAX_IMAGE_OBJECT_BYTES, validatePngImage } from "@chemdraft/chem-core";

/** Uncompressed UTF-8 iTXt: the same versioned JSON as the private clipboard flavor. */
export const CHEMDRAFT_PNG_SELECTION_KEYWORD = "application/x-chemdraft-selection+json";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Keep pixels/density untouched; replace only ChemDraft's own metadata before IEND. */
export function pngWithChemDraftSelection(png: Uint8Array, selectionJson: string): Uint8Array {
  const validation = validatePngImage(png);
  if (validation.error) throw new Error(`Clipboard PNG failed validation: ${validation.error}`);
  const encoder = new TextEncoder();
  const keyword = encoder.encode(CHEMDRAFT_PNG_SELECTION_KEYWORD);
  // Keyword terminator, compression flag/method, empty language and translated keyword.
  const prefix = encoder.encode(`${CHEMDRAFT_PNG_SELECTION_KEYWORD}\0\0\0\0\0`);
  const text = encoder.encode(selectionJson);
  const chunkLength = 12 + prefix.length + text.length;
  if (chunkLength + png.length > MAX_IMAGE_OBJECT_BYTES) {
    throw new Error("Clipboard PNG with editable selection data exceeds the 25 MB picture limit.");
  }
  const chunk = new Uint8Array(chunkLength);
  const chunkView = new DataView(chunk.buffer);
  chunkView.setUint32(0, prefix.length + text.length);
  chunk.set(encoder.encode("iTXt"), 4);
  chunk.set(prefix, 8);
  chunk.set(text, 8 + prefix.length);
  chunkView.setUint32(chunk.length - 4, crc32(chunk.subarray(4, -4)));

  const parts = [png.subarray(0, 8)];
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const ownMetadata = ["iTXt", "tEXt", "zTXt"].includes(type)
      && length > keyword.length && png[offset + 8 + keyword.length] === 0
      && keyword.every((byte, index) => byte === png[offset + 8 + index]);
    if (type === "IEND") parts.push(chunk);
    if (!ownMetadata) parts.push(png.subarray(offset, end));
    if (type === "IEND") break;
    offset = end;
  }
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
