/**
 * JPEG, GIF and WebP are decoded by the webview and re-encoded as PNG through a canvas, so the
 * document keeps its one raster type. Only the first frame of an animation is kept, and EXIF
 * orientation is applied by the decoder. Callers check the header size first: nothing over the pixel
 * caps reaches the decoder.
 */

export interface RasterPngResult {
  png: Uint8Array;
  width: number;
  height: number;
  /** The decoded size before any downscaling, after EXIF orientation. */
  sourceWidth: number;
  sourceHeight: number;
  downscaled: boolean;
}

/** Injected so tests (and hosts without a canvas) can supply their own decoder. */
export type RasterToPng = (bytes: Uint8Array, mimeType: string, maxPngBytes: number) => Promise<RasterPngResult>;

const DOWNSCALE_STEP = 0.75;
const MIN_DOWNSCALED_SIDE = 16;

/**
 * Encode at full size, then smaller in fixed steps until the PNG fits `maxBytes`. An encoder that
 * returns nothing (a canvas over the engine's own limit) counts as too large.
 */
export async function encodeWithDownscale(
  source: { width: number; height: number },
  maxBytes: number,
  encodeAt: (width: number, height: number) => Promise<Uint8Array | undefined>
): Promise<RasterPngResult> {
  let width = source.width;
  let height = source.height;
  for (let step = 0; ; step += 1) {
    const png = await encodeAt(width, height);
    if (png && png.length <= maxBytes) {
      return { png, width, height, sourceWidth: source.width, sourceHeight: source.height, downscaled: step > 0 };
    }
    width = Math.max(1, Math.floor(width * DOWNSCALE_STEP));
    height = Math.max(1, Math.floor(height * DOWNSCALE_STEP));
    if (Math.max(width, height) < MIN_DOWNSCALED_SIDE) {
      throw new Error("it is still too large as PNG after scaling it down.");
    }
  }
}

interface DecodedSource {
  width: number;
  height: number;
  source: CanvasImageSource;
  release: () => void;
}

async function decodeBlob(blob: Blob): Promise<DecodedSource> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      return { width: bitmap.width, height: bitmap.height, source: bitmap, release: () => bitmap.close() };
    } catch {
      // Older engines reject the options bag or the type; the image element below decodes it.
    }
  }
  const url = URL.createObjectURL(blob);
  const image = new Image();
  const release = () => { image.removeAttribute("src"); URL.revokeObjectURL(url); };
  image.decoding = "async";
  image.src = url;
  try {
    await image.decode();
  } catch {
    release();
    throw new Error("the webview could not decode it.");
  }
  return { width: image.naturalWidth, height: image.naturalHeight, source: image, release };
}

async function drawToPng(source: CanvasImageSource, width: number, height: number): Promise<Uint8Array | undefined> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, width, height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
  } catch {
    return undefined;
  } finally {
    // Release the backing store now rather than at garbage collection.
    canvas.width = 0;
    canvas.height = 0;
  }
}

export const browserRasterToPng: RasterToPng = async (bytes, mimeType, maxPngBytes) => {
  const decoded = await decodeBlob(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }));
  try {
    if (!(decoded.width > 0 && decoded.height > 0)) throw new Error("the webview could not decode it.");
    return await encodeWithDownscale(decoded, maxPngBytes, (width, height) => drawToPng(decoded.source, width, height));
  } finally {
    decoded.release();
  }
};
