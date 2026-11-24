/**
 * One-time move of the shortcut-scheme default (ChemDraft 1.2.3).
 *
 * New installs now default to the industry-standard scheme. An install that never chose a scheme
 * has nothing stored, so flipping DEFAULT_KEYBINDING_SETTINGS alone would silently switch it. On
 * launch, before the document window mounts, this writes a scheme explicitly:
 *
 *   - a scheme already in the native preferences file is an explicit choice: nothing is written to
 *     it, and it is mirrored into the webview cache;
 *   - a scheme only in the webview cache (older versions kept it there) is kept and copied over;
 *   - an existing install with no scheme gets LEGACY_DEFAULT_KEYBINDING_SCHEME;
 *   - a fresh install gets DEFAULT_KEYBINDING_SETTINGS.scheme.
 *
 * The written scheme is itself the "done" marker (preferences.json has no room for a separate flag:
 * lib.rs parses it with deny_unknown_fields), so every later launch takes the first branch.
 *
 * Every path ends with the resolved scheme in the webview cache (KEYBINDING_STORAGE_KEY) or, where
 * it must not be persisted, in setLaunchKeybindingScheme, so the document window's first render,
 * its first native-menu push, and every window it opens already use it. None of them waits for a
 * second read of the native file.
 *
 * When the native preferences cannot be read, the install can never be proven new, so it never gets
 * the new default:
 *   - a scheme in the webview cache (the mirror of the native file) is used for this launch;
 *   - otherwise LEGACY_DEFAULT_KEYBINDING_SCHEME is used for this launch. It goes into the webview
 *     cache only when other evidence shows an existing install (a preferences file that exists but
 *     cannot be parsed is such evidence); with no evidence at all it is kept in memory only, so a
 *     later launch that can read the file classifies the install from scratch. That launch still
 *     runs the app, which writes toolbar-state.json and other settings that would otherwise read as
 *     existing-install evidence, so it also leaves PENDING_FRESH_INSTALL_KEY in the webview cache:
 *     while that marker is present, no existing-install evidence counts (only an explicit scheme in
 *     the native file or the cache does), and the first launch that can read the file classifies
 *     the install as new and removes the marker. The marker is written only when nothing showed an
 *     existing install, so everything found after it was written by such fallback launches.
 *   Nothing is written to the native file: lib.rs reads it before applying a patch, so the write
 *   would fail the same way, and it must never replace a file whose other settings it cannot see.
 *
 * Existing-install evidence, in order:
 *   1. toolbar-state.json (TOOLSET_LAYOUT_STATE_FILENAME in lib.rs) in the app data folder. Every
 *      desktop launch writes it at startup (MainWindow's startup layout save), on macOS and Windows
 *      alike, and has since before 1.1.1. Updates never remove it. A file that exists but cannot be
 *      read still counts.
 *   2. Any key in the native preferences file (tour seen, custom shortcuts; 1.2.2 and later), or a
 *      preferences file that exists but cannot be parsed.
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
  setLaunchKeybindingScheme,
  type KeybindingScheme,
  type KeybindingSettings
} from "./keybindingSettings";

/**
 * Left in the webview cache by a launch that could not read the native preferences and found no
 * existing-install evidence (see the header). Not itself existing-install evidence.
 */
export const PENDING_FRESH_INSTALL_KEY = "chemdraft.shortcutDefault.pendingFresh";

export interface ShortcutDefaultMigrationHost {
  /** The webview's localStorage, or undefined where it is unavailable. */
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length"> | undefined;
  /** The desktop runtime's native stores; undefined in the browser build. */
  native?: {
    /**
     * Reads preferences.json. Rejects with lib.rs's error string: serde_json's message (which ends
     * in "at line L column C") when the file exists but cannot be parsed, an I/O error otherwise.
     */
    readPreferences(): Promise<DesktopPreferences>;
    writeScheme(scheme: KeybindingScheme): Promise<unknown>;
    /** Whether toolbar-state.json exists. Rejects when it exists but cannot be read. */
    hasToolbarLayout(): Promise<boolean>;
  };
}

export type ShortcutDefaultMigrationOutcome = {
  kind: "already-set" | "kept-stored-choice" | "existing-install" | "fresh-install" | "preferences-unreadable";
  scheme: KeybindingScheme;
};

export async function migrateShortcutDefault(host: ShortcutDefaultMigrationHost): Promise<ShortcutDefaultMigrationOutcome> {
  const outcome = await resolveShortcutDefault(host);
  // Whatever the cache holds (or fails to hold), this launch's windows fall back to the resolved
  // scheme rather than to the new default.
  setLaunchKeybindingScheme(outcome.scheme);
  return outcome;
}

async function resolveShortcutDefault(host: ShortcutDefaultMigrationHost): Promise<ShortcutDefaultMigrationOutcome> {
  let preferences: DesktopPreferences = {};
  if (host.native) {
    try {
      preferences = (await host.native.readPreferences()) ?? {};
    } catch (error) {
      console.error("Could not read preferences to migrate the shortcut default", error);
      return unreadablePreferences(host, error);
    }
    if (isKeybindingScheme(preferences.shortcutScheme)) {
      mirrorCache(host.storage, preferences.shortcutScheme, preferences);
      clearPendingFreshInstall(host.storage);
      return { kind: "already-set", scheme: preferences.shortcutScheme };
    }
  }

  const cached = readCache(host.storage);
  if (cached.scheme) {
    clearPendingFreshInstall(host.storage);
    if (!host.native) return { kind: "already-set", scheme: cached.scheme };
    await writeNative(host, cached.scheme);
    return { kind: "kept-stored-choice", scheme: cached.scheme };
  }

  // Only fallback launches have run since nothing showed an existing install: what they wrote
  // (toolbar layout, other settings) is not evidence of one.
  const existing = !hasPendingFreshInstall(host.storage) && (cached.present || hasChemDraftStorage(host.storage)
    || Object.keys(preferences).length > 0 || await hasToolbarLayout(host));
  const scheme = existing ? LEGACY_DEFAULT_KEYBINDING_SCHEME : DEFAULT_KEYBINDING_SETTINGS.scheme;
  const written = host.native ? await writeNative(host, scheme) : false;
  // Mirror into the webview cache the way updateShortcutPreference does, so every window's first
  // render agrees, and so a failed native write is finished from the cache on the next launch.
  mirrorCache(host.storage, scheme, preferences, cached);
  // The marker goes once the scheme is stored somewhere a later launch reads first.
  if (written || readCache(host.storage).scheme === scheme) clearPendingFreshInstall(host.storage);
  return { kind: existing ? "existing-install" : "fresh-install", scheme };
}

/**
 * The native file could not be read, so an explicit choice cannot be told from none and a new
 * install cannot be proven. Never the new default; never a native write.
 */
async function unreadablePreferences(host: ShortcutDefaultMigrationHost, error: unknown): Promise<ShortcutDefaultMigrationOutcome> {
  const cached = readCache(host.storage);
  // The cache mirrors the native file (or holds an older version's choice): the best evidence left.
  if (cached.scheme) return { kind: "preferences-unreadable", scheme: cached.scheme };
  const scheme = LEGACY_DEFAULT_KEYBINDING_SCHEME;
  // An earlier fallback launch found no evidence; whatever exists now, it wrote.
  const pendingFresh = hasPendingFreshInstall(host.storage);
  const existing = !pendingFresh && (isUnparsablePreferences(error) || cached.present || hasChemDraftStorage(host.storage)
    || await hasToolbarLayout(host));
  // Proven existing: keep the legacy scheme in the cache, where the next launch that can read the
  // file copies it over (as for an older version's choice). Not proven either way: this launch
  // only, and the marker tells the next launch that what this one writes is no evidence.
  if (existing) mirrorCache(host.storage, scheme, {}, cached);
  else if (!pendingFresh) markPendingFreshInstall(host.storage);
  return { kind: "preferences-unreadable", scheme };
}

function hasPendingFreshInstall(storage: ShortcutDefaultMigrationHost["storage"]): boolean {
  try {
    return storage?.getItem(PENDING_FRESH_INSTALL_KEY) != null;
  } catch {
    return false;
  }
}

function markPendingFreshInstall(storage: ShortcutDefaultMigrationHost["storage"]): void {
  try {
    storage?.setItem(PENDING_FRESH_INSTALL_KEY, "1");
  } catch {
    // Without the marker the next launch counts this one's writes as an existing install: the
    // old scheme, the safe side.
  }
}

function clearPendingFreshInstall(storage: ShortcutDefaultMigrationHost["storage"]): void {
  try {
    if (storage?.getItem(PENDING_FRESH_INSTALL_KEY) != null) storage?.removeItem(PENDING_FRESH_INSTALL_KEY);
  } catch {
    // A marker left behind only matters while no scheme is stored; one is stored by now.
  }
}

/** serde_json's Display for a parse error ends in "at line L column C"; I/O errors never do. */
function isUnparsablePreferences(error: unknown): boolean {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return / at line \d+ column \d+$/.test(message);
}

async function hasToolbarLayout(host: ShortcutDefaultMigrationHost): Promise<boolean> {
  return host.native ? host.native.hasToolbarLayout().catch(() => true) : false;
}

let started: Promise<void> | undefined;

/**
 * Run the migration once per process against the real stores. Never rejects: the document window
 * waits on it before mounting.
 */
export function runShortcutDefaultMigration(): Promise<void> {
  started ??= defaultHost()
    .then(migrateShortcutDefault)
    .then(() => undefined, error => {
      // Nothing proved a new install: keep the old default for this launch only.
      setLaunchKeybindingScheme(LEGACY_DEFAULT_KEYBINDING_SCHEME);
      console.error("Could not migrate the shortcut default", error);
    });
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

async function writeNative(host: ShortcutDefaultMigrationHost, scheme: KeybindingScheme): Promise<boolean> {
  try {
    await host.native?.writeScheme(scheme);
    return true;
  } catch (error) {
    console.error("Could not save the shortcut scheme", error);
    return false;
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

/**
 * Write the resolved scheme into the webview cache the way updateShortcutPreference does: native
 * overrides win, else the cache's own. Leaves an identical cache untouched.
 */
function mirrorCache(
  storage: ShortcutDefaultMigrationHost["storage"],
  scheme: KeybindingScheme,
  preferences: DesktopPreferences,
  cached: ReturnType<typeof readCache> = readCache(storage)
): void {
  const overrides = isSchemeOverrides(preferences.shortcutOverrides) ? preferences.shortcutOverrides : cached.overrides;
  const settings: KeybindingSettings = { scheme, ...(overrides ? { overrides } : {}) };
  try {
    const value = JSON.stringify(settings);
    if (storage?.getItem(KEYBINDING_STORAGE_KEY) !== value) storage?.setItem(KEYBINDING_STORAGE_KEY, value);
  } catch {
    // Best-effort, as in saveKeybindingSettings; setLaunchKeybindingScheme still covers this launch.
  }
}

function hasChemDraftStorage(storage: ShortcutDefaultMigrationHost["storage"]): boolean {
  try {
    for (let index = 0; index < (storage?.length ?? 0); index += 1) {
      const key = storage?.key(index);
      if (key?.startsWith("chemdraft.") && key !== PENDING_FRESH_INSTALL_KEY) return true;
    }
  } catch {
    // Unreadable storage is no evidence either way.
  }
  return false;
}
