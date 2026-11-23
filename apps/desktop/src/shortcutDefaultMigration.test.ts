import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { describe, expect, it, vi } from "vitest";
import { keyboardShortcutActions } from "./customKeyboardShortcuts";
import type { DesktopPreferences } from "./desktopPreferences";
import { KEYBINDING_STORAGE_KEY, type KeybindingScheme } from "./keybindingSettings";
import {
  migrateShortcutDefault,
  type ShortcutDefaultMigrationHost
} from "./shortcutDefaultMigration";
import { MemoryStorage } from "./testSupport/memoryStorage";

/**
 * A fake install: the webview's localStorage plus, on the desktop runtime, the native
 * preferences.json (patched the way lib.rs `apply_patch` does) and the toolbar layout file that
 * every desktop launch writes to the app data folder.
 */
function install(options: {
  desktop?: boolean;
  preferences?: DesktopPreferences;
  toolbarLayout?: boolean | "unreadable";
  local?: Record<string, string>;
  failNativeWrite?: boolean;
} = {}) {
  const storage = new MemoryStorage();
  for (const [key, value] of Object.entries(options.local ?? {})) storage.setItem(key, value);
  let preferences: DesktopPreferences = { ...options.preferences };
  const writeScheme = vi.fn(async (scheme: KeybindingScheme) => {
    if (options.failNativeWrite) throw new Error("disk full");
    preferences = { ...preferences, shortcutScheme: scheme };
    return { ...preferences };
  });
  const host: ShortcutDefaultMigrationHost = {
    storage,
    native: options.desktop === false ? undefined : {
      readPreferences: async () => ({ ...preferences }),
      writeScheme,
      hasToolbarLayout: async () => {
        if (options.toolbarLayout === "unreadable") throw new Error("Toolbar layout is invalid");
        return options.toolbarLayout === true;
      }
    }
  };
  return {
    host,
    storage,
    writeScheme,
    preferences: () => preferences,
    cachedScheme: () => {
      const raw = storage.getItem(KEYBINDING_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as { scheme?: unknown }).scheme : undefined;
    }
  };
}

/** The key the bond tool answers to under a scheme, as the Keyboard preferences list shows it. */
function bondToolKey(scheme: KeybindingScheme, platform: ShortcutPlatform): string | undefined {
  return keyboardShortcutActions(scheme, platform).find(action => action.id === "tool.bond")?.defaults[0];
}

describe.each(["macos", "windows"] as const)("shortcut default migration (%s)", platform => {
  it("gives a fresh install the industry-standard scheme and writes it", async () => {
    const fake = install();
    const outcome = await migrateShortcutDefault(fake.host);
    expect(outcome).toEqual({ kind: "fresh-install", scheme: "chemdraw" });
    expect(fake.preferences().shortcutScheme).toBe("chemdraw");
    expect(fake.cachedScheme()).toBe("chemdraw");
    expect(bondToolKey(outcome.scheme!, platform)).toBe("X");
  });

  it("keeps ChemDraft's scheme for an upgrade that never chose one, and writes it explicitly", async () => {
    const fake = install({ toolbarLayout: true });
    const outcome = await migrateShortcutDefault(fake.host);
    expect(outcome).toEqual({ kind: "existing-install", scheme: "chemdraft" });
    expect(fake.preferences().shortcutScheme).toBe("chemdraft");
    expect(fake.cachedScheme()).toBe("chemdraft");
    expect(bondToolKey(outcome.scheme!, platform)).not.toBe("X");
  });

  it.each([
    ["an unreadable toolbar layout", { toolbarLayout: "unreadable" as const }],
    ["native preferences without a scheme", { preferences: { guidedTourSeen: true as const } }],
    ["custom shortcuts without a scheme", { preferences: { shortcutOverrides: { chemdraft: { commands: { "file.save": ["Mod+F9"] } } } } }],
    ["other ChemDraft settings in the webview", { local: { "chemdraft.drawing-settings.v1": "{}" } }]
  ])("treats %s as an existing install", async (_label, options) => {
    const fake = install(options);
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "existing-install", scheme: "chemdraft" });
    expect(fake.preferences().shortcutScheme).toBe("chemdraft");
  });

  it.each(["chemdraft", "chemdraw"] as const)("never overwrites an explicit %s choice", async scheme => {
    const fake = install({ toolbarLayout: true, preferences: { shortcutScheme: scheme } });
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "already-set", scheme });
    expect(fake.writeScheme).not.toHaveBeenCalled();
    expect(fake.preferences().shortcutScheme).toBe(scheme);
    expect(fake.storage.length).toBe(0);
  });

  it.each(["chemdraft", "chemdraw"] as const)("keeps a %s choice stored only in the webview by an older version", async scheme => {
    const overrides = { [scheme]: { commands: { "file.save": ["Mod+F9"] } } };
    const fake = install({ toolbarLayout: true, local: { [KEYBINDING_STORAGE_KEY]: JSON.stringify({ scheme, overrides }) } });
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "kept-stored-choice", scheme });
    expect(fake.preferences().shortcutScheme).toBe(scheme);
    expect(JSON.parse(fake.storage.getItem(KEYBINDING_STORAGE_KEY)!)).toEqual({ scheme, overrides });
  });

  it.each([
    ["fresh install", {}, "chemdraw"],
    ["upgrade", { toolbarLayout: true }, "chemdraft"]
  ] as const)("changes nothing when run twice (%s)", async (_label, options, scheme) => {
    const fake = install(options);
    await migrateShortcutDefault(fake.host);
    const preferences = fake.preferences();
    const cache = fake.storage.getItem(KEYBINDING_STORAGE_KEY);
    fake.writeScheme.mockClear();
    // The second launch: the layout file now exists even on the fresh install.
    const again = install({ ...options, toolbarLayout: true, preferences, local: { [KEYBINDING_STORAGE_KEY]: cache! } });
    expect(await migrateShortcutDefault(again.host)).toEqual({ kind: "already-set", scheme });
    expect(again.writeScheme).not.toHaveBeenCalled();
    expect(again.preferences()).toEqual(preferences);
    expect(again.storage.getItem(KEYBINDING_STORAGE_KEY)).toBe(cache);
  });

  it("keeps the chosen scheme in the webview when the native write fails, so the next launch finishes the job", async () => {
    const fake = install({ toolbarLayout: true, failNativeWrite: true });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "existing-install", scheme: "chemdraft" });
    expect(fake.cachedScheme()).toBe("chemdraft");
    vi.restoreAllMocks();
  });

  it("does nothing when the native preferences cannot be read", async () => {
    const fake = install({ toolbarLayout: true });
    fake.host.native!.readPreferences = async () => { throw new Error("Preferences are invalid"); };
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "skipped", scheme: undefined });
    expect(fake.writeScheme).not.toHaveBeenCalled();
    expect(fake.storage.length).toBe(0);
  });
});

describe("shortcut default migration in the browser build", () => {
  it("gives a new visitor the industry-standard scheme", async () => {
    const fake = install({ desktop: false });
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "fresh-install", scheme: "chemdraw" });
    expect(fake.cachedScheme()).toBe("chemdraw");
  });

  it("keeps ChemDraft's scheme for a returning visitor, once", async () => {
    const fake = install({ desktop: false, local: { "chemdraft.quit.ask-to-save.v1": "true" } });
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "existing-install", scheme: "chemdraft" });
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "already-set", scheme: "chemdraft" });
    expect(fake.cachedScheme()).toBe("chemdraft");
  });
});
