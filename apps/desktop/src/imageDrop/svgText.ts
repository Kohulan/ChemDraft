/**
 * SVG bytes to text: UTF-8 (with or without a BOM) and UTF-16 with a BOM. Invalid UTF-8 is refused
 * rather than repaired with U+FFFD, which would silently change text in the picture.
 */
export function decodeSvgBytes(bytes: Uint8Array): { text: string } | { error: string } {
  try {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      if ((bytes.length - 2) % 2) return { error: "the UTF-16 SVG text is truncated." };
      return { text: new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2)) };
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      if ((bytes.length - 2) % 2) return { error: "the UTF-16 SVG text is truncated." };
      return { text: new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2)) };
    }
    const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start)) };
  } catch {
    return { error: "the SVG is not valid UTF-8 or UTF-16 text." };
  }
}

/** Embedded pictures are always stored as UTF-8 without a BOM. */
export function encodeSvgText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
