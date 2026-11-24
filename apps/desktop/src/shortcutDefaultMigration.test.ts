import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keyboardShortcutActions } from "./customKeyboardShortcuts";
import type { DesktopPreferences } from "./desktopPreferences";
import {
  KEYBINDING_STORAGE_KEY,
  loadKeybindingSettings,
  setLaunchKeybindingScheme,
  type KeybindingScheme
} from "./keybindingSettings";
import {
  migrateShortcutDefault,
  PENDING_FRESH_INSTALL_KEY,
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
  let toolbarLayout = options.toolbarLayout;
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
        if (toolbarLayout === "unreadable") throw new Error("Toolbar layout is invalid");
        return toolbarLayout === true;
      }
    }
  };
  return {
    host,
    storage,
    writeScheme,
    preferences: () => preferences,
    /**
     * What a launch writes once the document window has mounted: MainWindow's startup layout save
     * (toolbar-state.json), and settings the user changes along the way (the tour's "seen" flag in
     * the native file, a webview setting). Shortcut settings are left alone.
     */
    runLaunch: () => {
      toolbarLayout = true;
      preferences = { ...preferences, guidedTourSeen: true };
      storage.setItem("chemdraft.quit.ask-to-save.v1", "false");
    },
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

/** The scheme the document window's first render reads (useShortcutPreference's initial state). */
function firstRenderScheme(storage: MemoryStorage): KeybindingScheme {
  vi.stubGlobal("localStorage", storage);
  try {
    return loadKeybindingSettings().scheme;
  } finally {
    vi.unstubAllGlobals();
  }
}

/** preferences.json read failures as lib.rs reports them (the rejection is its error string). */
const IO_ERROR = "Permission denied (os error 13)";
const PARSE_ERROR = "expected value at line 1 column 1";

afterEach(() => {
  setLaunchKeybindingScheme(undefined);
  vi.restoreAllMocks();
});

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
    // The native choice is mirrored into the webview cache, so the first render already uses it.
    expect(fake.storage.length).toBe(1);
    expect(fake.cachedScheme()).toBe(scheme);
  });

  it.each(["chemdraft", "chemdraw"] as const)("mirrors an explicit native %s choice over a stale or cleared cache before the first render", async scheme => {
    const other: KeybindingScheme = scheme === "chemdraft" ? "chemdraw" : "chemdraft";
    const overrides = { [scheme]: { commands: { "file.save": ["Mod+F9"] } } };
    const caches: Record<string, string>[] = [{}, { [KEYBINDING_STORAGE_KEY]: JSON.stringify({ scheme: other }) }];
    for (const local of caches) {
      const fake = install({ toolbarLayout: true, preferences: { shortcutScheme: scheme, shortcutOverrides: overrides }, local });
      expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "already-set", scheme });
      expect(fake.writeScheme).not.toHaveBeenCalled();
      expect(JSON.parse(fake.storage.getItem(KEYBINDING_STORAGE_KEY)!)).toEqual({ scheme, overrides });
      expect(firstRenderScheme(fake.storage)).toBe(scheme);
    }
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

  // An unreadable preferences file can never prove a new install, so it never gets the new default.
  // Nothing is written to the native file: lib.rs reads it before patching, and a write must never
  // replace a file whose other settings could not be read.
  it.each([
    ["the toolbar layout", { toolbarLayout: true }],
    ["an unreadable toolbar layout", { toolbarLayout: "unreadable" as const }],
    ["other ChemDraft settings in the webview", { local: { "chemdraft.drawing-settings.v1": "{}" } }]
  ])("keeps an existing install (%s) on ChemDraft's scheme when the preferences read fails", async (_label, options) => {
    const fake = install(options);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fake.host.native!.readPreferences = async () => { throw IO_ERROR; };
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "preferences-unreadable", scheme: "chemdraft" });
    expect(fake.writeScheme).not.toHaveBeenCalled();
    expect(fake.cachedScheme()).toBe("chemdraft");
    expect(firstRenderScheme(fake.storage)).toBe("chemdraft");
    expect(bondToolKey(firstRenderScheme(fake.storage), platform)).not.toBe("X");
  });

  it("treats a preferences file that exists but cannot be parsed as an existing install, on every launch", async () => {
    const fake = install();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fake.host.native!.readPreferences = async () => { throw PARSE_ERROR; };
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "preferences-unreadable", scheme: "chemdraft" });
    expect(fake.writeScheme).not.toHaveBeenCalled();
    expect(fake.cachedScheme()).toBe("chemdraft");
    expect(firstRenderScheme(fake.storage)).toBe("chemdraft");
    // The file stays corrupt: the next launch keeps the same scheme.
    setLaunchKeybindingScheme(undefined);
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "preferences-unreadable", scheme: "chemdraft" });
    expect(firstRenderScheme(fake.storage)).toBe("chemdraft");
  });

  it("uses the scheme mirrored in the webview cache when the preferences read fails", async () => {
    const fake = install({ toolbarLayout: true, local: { [KEYBINDING_STORAGE_KEY]: JSON.stringify({ scheme: "chemdraw" }) } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fake.host.native!.readPreferences = async () => { throw IO_ERROR; };
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "preferences-unreadable", scheme: "chemdraw" });
    expect(fake.writeScheme).not.toHaveBeenCalled();
    expect(fake.cachedScheme()).toBe("chemdraw");
  });

  // Decision: a read failure with no other evidence cannot prove a new install, so this launch runs
  // the legacy scheme, in memory only (no native write, no scheme in the webview cache). The launch
  // still runs the app, which writes toolbar-state.json at startup and whatever settings the user
  // changes; a marker in the webview cache keeps those from reading as an existing install, so the
  // next launch that can read the file classifies the install as the new one it is.
  it("gives a seemingly fresh install ChemDraft's scheme for this launch only when the preferences read fails", async () => {
    const fake = install();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const read = fake.host.native!.readPreferences;
    fake.host.native!.readPreferences = async () => { throw new Error(IO_ERROR); };
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "preferences-unreadable", scheme: "chemdraft" });
    expect(fake.writeScheme).not.toHaveBeenCalled();
    expect(fake.cachedScheme()).toBeUndefined();
    expect(fake.storage.getItem(PENDING_FRESH_INSTALL_KEY)).not.toBeNull();
    expect(firstRenderScheme(fake.storage)).toBe("chemdraft");
    // The document window mounts and the launch runs, writing what every launch writes.
    fake.runLaunch();
    // A later launch (a new process) reads the file: what the fallback launch wrote is no evidence.
    setLaunchKeybindingScheme(undefined);
    fake.host.native!.readPreferences = read;
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "fresh-install", scheme: "chemdraw" });
    expect(fake.preferences()).toEqual({ guidedTourSeen: true, shortcutScheme: "chemdraw" });
    expect(fake.cachedScheme()).toBe("chemdraw");
    expect(fake.storage.getItem(PENDING_FRESH_INSTALL_KEY)).toBeNull();
    expect(firstRenderScheme(fake.storage)).toBe("chemdraw");
    // From then on the written scheme decides.
    setLaunchKeybindingScheme(undefined);
    fake.runLaunch();
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "already-set", scheme: "chemdraw" });
  });

  it("keeps a fresh install pending across several launches that cannot read the preferences", async () => {
    const fake = install();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const read = fake.host.native!.readPreferences;
    fake.host.native!.readPreferences = async () => { throw new Error(IO_ERROR); };
    for (let launch = 0; launch < 2; launch += 1) {
      setLaunchKeybindingScheme(undefined);
      expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "preferences-unreadable", scheme: "chemdraft" });
      expect(fake.cachedScheme()).toBeUndefined();
      expect(firstRenderScheme(fake.storage)).toBe("chemdraft");
      fake.runLaunch();
    }
    expect(fake.writeScheme).not.toHaveBeenCalled();
    setLaunchKeybindingScheme(undefined);
    fake.host.native!.readPreferences = read;
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "fresh-install", scheme: "chemdraw" });
    expect(fake.preferences().shortcutScheme).toBe("chemdraw");
  });

  it("keeps a scheme chosen during a fallback launch", async () => {
    const fake = install();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const read = fake.host.native!.readPreferences;
    fake.host.native!.readPreferences = async () => { throw new Error(IO_ERROR); };
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "preferences-unreadable", scheme: "chemdraft" });
    fake.runLaunch();
    // updateShortcutPreference: the native write fails with the read, the webview cache keeps it.
    fake.storage.setItem(KEYBINDING_STORAGE_KEY, JSON.stringify({ scheme: "chemdraft" }));
    setLaunchKeybindingScheme(undefined);
    fake.host.native!.readPreferences = read;
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "kept-stored-choice", scheme: "chemdraft" });
    expect(fake.preferences().shortcutScheme).toBe("chemdraft");
    expect(fake.storage.getItem(PENDING_FRESH_INSTALL_KEY)).toBeNull();
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
