import { MAX_IMAGE_DECODED_BYTES, MAX_IMAGE_SIDE } from "@chemdraft/chem-core";

/** The paste caps, worded for a drop. */
export function dropPixelLimitError(width: number, height: number): string | undefined {
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
    return `it is ${width} × ${height} pixels; the limit is ${MAX_IMAGE_SIDE} pixels on a side.`;
  }
  if (width * height * 4 > MAX_IMAGE_DECODED_BYTES) {
    return `it is ${width} × ${height} pixels; the decoded limit is ${MAX_IMAGE_DECODED_BYTES / (1024 * 1024)} MiB.`;
  }
  return undefined;
}
