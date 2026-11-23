/**
 * One-time move of the shortcut-scheme default (ChemDraft 1.2.3).
 *
 * New installs now default to the industry-standard scheme. An install that never chose a scheme
 * has nothing stored, so flipping DEFAULT_KEYBINDING_SETTINGS alone would silently switch it. On
 * launch, before the document window mounts, this writes a scheme explicitly:
 *
 *   - a scheme already in the native preferences file is an explicit choice: nothing is written;
 *   - a scheme only in the webview cache (older versions kept it there) is kept and copied over;
 *   - an existing install with no scheme gets LEGACY_DEFAULT_KEYBINDING_SCHEME;
 *   - a fresh install gets DEFAULT_KEYBINDING_SETTINGS.scheme.
 *
 * The written scheme is itself the "done" marker (preferences.json has no room for a separate flag:
 * lib.rs parses it with deny_unknown_fields), so every later launch takes the first branch.
 *
 * Existing-install evidence, in order:
 *   1. toolbar-state.json (TOOLSET_LAYOUT_STATE_FILENAME in lib.rs) in the app data folder. Every
 *      desktop launch writes it at startup (MainWindow's startup layout save), on macOS and Windows
 *      alike, and has since before 1.1.1. Updates never remove it. A file that exists but cannot be
 *      read still counts.
 *   2. Any key in the native preferences file (tour seen, custom shortcuts; 1.2.2 and later).
 *   3. Any `chemdraft.` key in the webview's localStorage (the browser build's only store).
 * Behavior is the same on every platform; only the stores differ, and they come in through the host.
 */
import type { DesktopPreferences } from "./desktopPreferences";
import {
  DEFAULT_KEYBINDING_SETTINGS,
  isKeybindingScheme,
  isSchemeOverrides,
  KEYBINDING_STORAGE_KEY,
  LEGACY_DEFAULT_KEYBINDING_SCHEME,
  type KeybindingScheme,
  type KeybindingSettings
} from "./keybindingSettings";

export interface ShortcutDefaultMigrationHost {
  /** The webview's localStorage, or undefined where it is unavailable. */
  storage: Pick<Storage, "getItem" | "setItem" | "key" | "length"> | undefined;
  /** The desktop runtime's native stores; undefined in the browser build. */
  native?: {
    readPreferences(): Promise<DesktopPreferences>;
    writeScheme(scheme: KeybindingScheme): Promise<unknown>;
    /** Whether toolbar-state.json exists. Rejects when it exists but cannot be read. */
    hasToolbarLayout(): Promise<boolean>;
  };
}

export type ShortcutDefaultMigrationOutcome =
  | { kind: "already-set" | "kept-stored-choice" | "existing-install" | "fresh-install"; scheme: KeybindingScheme }
  | { kind: "skipped"; scheme: undefined };

export async function migrateShortcutDefault(host: ShortcutDefaultMigrationHost): Promise<ShortcutDefaultMigrationOutcome> {
  let preferences: DesktopPreferences = {};
  if (host.native) {
    try {
      preferences = (await host.native.readPreferences()) ?? {};
    } catch (error) {
      // Without the native file we cannot tell an explicit choice from none. Write nothing; the
      // next launch tries again.
      console.error("Could not read preferences to migrate the shortcut default", error);
      return { kind: "skipped", scheme: undefined };
    }
    if (isKeybindingScheme(preferences.shortcutScheme)) return { kind: "already-set", scheme: preferences.shortcutScheme };
  }

  const cached = readCache(host.storage);
  if (cached.scheme) {
    if (!host.native) return { kind: "already-set", scheme: cached.scheme };
    await writeNative(host, cached.scheme);
    return { kind: "kept-stored-choice", scheme: cached.scheme };
  }

  const existing = cached.present || hasChemDraftStorage(host.storage) || Object.keys(preferences).length > 0
    || (host.native ? await host.native.hasToolbarLayout().catch(() => true) : false);
  const scheme = existing ? LEGACY_DEFAULT_KEYBINDING_SCHEME : DEFAULT_KEYBINDING_SETTINGS.scheme;
  if (host.native) await writeNative(host, scheme);
  // Mirror into the webview cache the way updateShortcutPreference does, so every window's first
  // render agrees, and so a failed native write is finished from the cache on the next launch.
  const overrides = isSchemeOverrides(preferences.shortcutOverrides) ? preferences.shortcutOverrides : cached.overrides;
  writeCache(host.storage, { scheme, ...(overrides ? { overrides } : {}) });
  return { kind: existing ? "existing-install" : "fresh-install", scheme };
}

let started: Promise<void> | undefined;

/**
 * Run the migration once per process against the real stores. Never rejects: the document window
 * waits on it before mounting.
 */
export function runShortcutDefaultMigration(): Promise<void> {
  started ??= defaultHost()
    .then(migrateShortcutDefault)
    .then(() => undefined, error => console.error("Could not migrate the shortcut default", error));
  return started;
}

async function defaultHost(): Promise<ShortcutDefaultMigrationHost> {
  const [{ desktopPreferences }, { isDesktopRuntime, loadToolsetLayoutState }] = await Promise.all([
    import("./desktopPreferences"),
    import("./window-manager")
  ]);
  let storage: Storage | undefined;
  try {
    storage = globalThis.localStorage ?? undefined;
  } catch {
    storage = undefined;
  }
  return {
    storage,
    native: isDesktopRuntime() ? {
      readPreferences: () => desktopPreferences(),
      writeScheme: shortcutScheme => desktopPreferences({ shortcutScheme }),
      hasToolbarLayout: async () => (await loadToolsetLayoutState()) !== undefined
    } : undefined
  };
}

async function writeNative(host: ShortcutDefaultMigrationHost, scheme: KeybindingScheme): Promise<void> {
  try {
    await host.native?.writeScheme(scheme);
  } catch (error) {
    console.error("Could not save the shortcut scheme", error);
  }
}

function readCache(storage: ShortcutDefaultMigrationHost["storage"]): {
  present: boolean;
  scheme?: KeybindingScheme;
  overrides?: KeybindingSettings["overrides"];
} {
  try {
    const raw = storage?.getItem(KEYBINDING_STORAGE_KEY);
    if (raw === null || raw === undefined) return { present: false };
    try {
      const parsed = JSON.parse(raw) as Partial<KeybindingSettings> | null;
      const scheme = parsed?.scheme;
      const overrides = parsed?.overrides;
      return {
        present: true,
        scheme: isKeybindingScheme(scheme) ? scheme : undefined,
        overrides: isSchemeOverrides(overrides) ? overrides : undefined
      };
    } catch {
      return { present: true };
    }
  } catch {
    return { present: false };
  }
}

function writeCache(storage: ShortcutDefaultMigrationHost["storage"], settings: KeybindingSettings): void {
  try {
    storage?.setItem(KEYBINDING_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Best-effort, as in saveKeybindingSettings.
  }
}

function hasChemDraftStorage(storage: ShortcutDefaultMigrationHost["storage"]): boolean {
  try {
    for (let index = 0; index < (storage?.length ?? 0); index += 1) {
      if (storage?.key(index)?.startsWith("chemdraft.")) return true;
    }
  } catch {
    // Unreadable storage is no evidence either way.
  }
  return false;
}
