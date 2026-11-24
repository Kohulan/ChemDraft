import type { ShortcutOverrides } from "@chemdraft/shortcut-engine";

/**
 * User setting for which keyboard-shortcut scheme the app uses.
 *
 *   chemdraft — the native ChemDraft bindings (the default before 1.2.3).
 *   chemdraw  — the industry-standard bindings (default for new installs).
 *               Covers tool hotkeys, hovered atom/bond hotkeys, and the menu
 *               chords that differ between the two schemes.
 *
 * Existing installs keep the old default: shortcutDefaultMigration.ts writes
 * LEGACY_DEFAULT_KEYBINDING_SCHEME explicitly on their first launch of 1.2.3,
 * before any window reads DEFAULT_KEYBINDING_SETTINGS.
 */

export type KeybindingScheme = "chemdraft" | "chemdraw";

export const KEYBINDING_SCHEME_LABELS: Record<KeybindingScheme, string> = {
  chemdraft: "ChemDraft",
  chemdraw: "Classic desktop-compatible"
};

export interface KeybindingSettings {
  scheme: KeybindingScheme;
  overrides?: Partial<Record<KeybindingScheme, ShortcutOverrides>>;
}

export const DEFAULT_KEYBINDING_SETTINGS: KeybindingSettings = {
  scheme: "chemdraw"
};

/** The default every install before 1.2.3 ran under when it never chose a scheme. */
export const LEGACY_DEFAULT_KEYBINDING_SCHEME: KeybindingScheme = "chemdraft";

export const KEYBINDING_STORAGE_KEY = "chemdraft.keybindings.v1";

export function isKeybindingScheme(value: unknown): value is KeybindingScheme {
  return value === "chemdraft" || value === "chemdraw";
}

export function isKeybindingSettings(value: unknown): value is KeybindingSettings {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as Partial<KeybindingSettings>;
  return isKeybindingScheme(settings.scheme) && (settings.overrides === undefined || isSchemeOverrides(settings.overrides));
}

let launchScheme: KeybindingScheme | undefined;

/**
 * The scheme this process falls back to when the cache holds none, in place of
 * DEFAULT_KEYBINDING_SETTINGS. shortcutDefaultMigration.ts sets it before the document window
 * mounts, so a launch whose scheme could not be persisted (unreadable preferences, blocked
 * storage) still never renders with the new default on an install not proven new. In memory only.
 */
export function setLaunchKeybindingScheme(scheme: KeybindingScheme | undefined): void {
  launchScheme = scheme;
}

/**
 * The scheme this webview uses when the cache holds none. Every reader goes through it.
 *
 * Only the document window runs shortcutDefaultMigration.ts, so only it may pick the new default,
 * and only for a proven fresh install, which it then writes to the native file and mirrors into
 * the cache. Every other window (palettes, popovers, Preferences, dialogs: the ?window= routes
 * App.tsx and main.tsx tell apart) loads on its own, without the document window's in-memory
 * launch scheme, and must never pick the new default by itself: finding no scheme in the cache
 * (storage unavailable, a write that failed), it uses the old default, the conservative choice.
 */
export function fallbackKeybindingScheme(): KeybindingScheme {
  if (launchScheme) return launchScheme;
  return isDocumentWindow() ? DEFAULT_KEYBINDING_SETTINGS.scheme : LEGACY_DEFAULT_KEYBINDING_SCHEME;
}

function isDocumentWindow(): boolean {
  try {
    return !new URLSearchParams(globalThis.location?.search ?? "").has("window");
  } catch {
    return false;
  }
}

export function loadKeybindingSettings(): KeybindingSettings {
  const fallback = fallbackKeybindingScheme();
  try {
    const raw = globalThis.localStorage?.getItem(KEYBINDING_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<KeybindingSettings> | null) : null;
    if (parsed && typeof parsed === "object") {
      return {
        scheme: isKeybindingScheme(parsed.scheme) ? parsed.scheme : fallback,
        ...(isSchemeOverrides(parsed.overrides) ? { overrides: parsed.overrides } : {})
      };
    }
  } catch {
    // Corrupt/blocked storage — fall back to the default.
  }
  return fallback === DEFAULT_KEYBINDING_SETTINGS.scheme ? DEFAULT_KEYBINDING_SETTINGS : { scheme: fallback };
}

export function saveKeybindingSettings(settings: KeybindingSettings): void {
  try {
    globalThis.localStorage?.setItem(KEYBINDING_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Persistence is best-effort (private mode / disabled storage).
  }
}

export function isSchemeOverrides(value: unknown): value is KeybindingSettings["overrides"] {
  const entries = (object: unknown): [string, unknown][] | undefined =>
    object && typeof object === "object" && !Array.isArray(object) ? Object.entries(object) : undefined;
  return entries(value)?.every(([scheme, scopes]) => isKeybindingScheme(scheme) &&
    entries(scopes)?.every(([scope, rows]) => ["commands", "atom", "bond"].includes(scope) &&
      entries(rows)?.every(([id, keys]) => /^[a-z][\w-]*(?:\.[\w-]+)+$/i.test(id) && Array.isArray(keys) &&
        keys.length <= 8 && keys.every(key => typeof key === "string" && key.length > 0 && key.length <= 80)))) === true;
}
