import { droppedFileBaseName, droppedImageSizeError, formatDropBytes } from "./dropFiles";
import type { DroppedImageSource } from "./dropHandler";

function tooLarge(size: number, maxBytes: number): Error {
  return new Error(droppedImageSizeError(size, maxBytes) ?? "it is too large.");
}

/** The file outgrew its metadata while it was read. */
function grewTooLarge(maxBytes: number): Error {
  return new Error(`it is larger than the ${formatDropBytes(maxBytes)} limit for a dropped picture.`);
}

/** A browser `File`: size from its metadata, then a read bounded to one byte past the limit. */
export function browserDroppedImageSource(file: Pick<File, "name" | "size" | "arrayBuffer"> & Partial<Pick<File, "slice">>): DroppedImageSource {
  return {
    name: file.name,
    size: async () => file.size,
    read: async (maxBytes) => {
      if (file.size > maxBytes) throw tooLarge(file.size, maxBytes);
      const blob = typeof file.slice === "function" ? file.slice(0, maxBytes + 1) : file;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length > maxBytes) throw grewTooLarge(maxBytes);
      return bytes;
    }
  };
}

/**
 * A dropped native path. Tauri's fs plugin adds dropped paths to its scope. The read is chunked and
 * stops one chunk past the limit, so a file that grows after `stat` is still refused.
 */
export function nativeDroppedImageSource(path: string): DroppedImageSource {
  return {
    name: droppedFileBaseName(path),
    size: async () => {
      const { stat } = await import("@tauri-apps/plugin-fs");
      return (await stat(path)).size;
    },
    read: async (maxBytes) => {
      const { open } = await import("@tauri-apps/plugin-fs");
      const file = await open(path, { read: true });
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = new Uint8Array(Math.min(256 * 1024, maxBytes + 1 - length));
          const count = await file.read(chunk);
          if (count === null || count === 0) break;
          length += count;
          if (length > maxBytes) throw grewTooLarge(maxBytes);
          chunks.push(chunk.subarray(0, count));
        }
      } finally {
        await file.close();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    }
  };
}
