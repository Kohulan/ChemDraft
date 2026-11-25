import type { SaveDialogOptions } from "@tauri-apps/plugin-dialog";

/** Shared by document and spectrum exports in the document window. */
export const lastExportDirectory: { current: string | undefined } = { current: undefined };

export interface ExportDirectoryDependencies {
  directory: { current: string | undefined };
  documentDir: () => Promise<string>;
  join: (...paths: string[]) => Promise<string>;
  dirname: (path: string) => Promise<string>;
  isDirectory: (path: string) => Promise<boolean>;
  save: (options: SaveDialogOptions) => Promise<string | null>;
  /**
   * Maps the panel's path to the path to write (undoing a repeated extension, confirming a
   * replace), or undefined to cancel. Omitted, the panel's path is written unchanged.
   */
  resolveSelected?: (path: string, extensions: readonly string[]) => Promise<string | undefined>;
}

/** A cancelled or failed write must not change the remembered destination. Path operations are
 * injected so both Windows and macOS paths can be exercised on either test host. */
export async function saveInExportDirectory(
  filename: string,
  options: SaveDialogOptions,
  write: (path: string) => Promise<void>,
  dependencies?: ExportDirectoryDependencies
): Promise<"saved" | "cancelled"> {
  if (!dependencies) {
    const { documentDir, join, dirname } = await import("@tauri-apps/api/path");
    const { stat } = await import("@tauri-apps/plugin-fs");
    const { save } = await import("./nativeFileDialog");
    const { resolveNativeSavePanelPath } = await import("./nativeSavePanelPath");
    dependencies = {
      directory: lastExportDirectory, documentDir, join, dirname, save,
      resolveSelected: (path, extensions) => resolveNativeSavePanelPath(path, extensions),
      isDirectory: async (path) => (await stat(path)).isDirectory
    };
  }
  const { directory, documentDir, join, dirname, isDirectory, save, resolveSelected } = dependencies;
  let folder = directory.current;
  if (folder) {
    try {
      if (!await isDirectory(folder)) folder = undefined;
    } catch {
      folder = undefined;
    }
  }
  const defaultPath = await join(folder ?? await documentDir(), filename);
  const selected = await save({ ...options, defaultPath });
  if (!selected) return "cancelled";
  const extensions = (options.filters ?? []).flatMap(filter => filter.extensions);
  const path = resolveSelected ? await resolveSelected(selected, extensions) : selected;
  if (!path) return "cancelled";
  // Resolve the parent before writing, but commit it only after the write succeeds.
  const parent = await dirname(path);
  await write(path);
  directory.current = parent;
  return "saved";
}
