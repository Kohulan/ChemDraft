import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_KEYBINDING_SETTINGS,
  LEGACY_DEFAULT_KEYBINDING_SCHEME,
  isKeybindingScheme,
  isKeybindingSettings,
  loadKeybindingSettings,
  saveKeybindingSettings,
  setLaunchKeybindingScheme
} from "./keybindingSettings";
// jsdom in this project doesn't expose localStorage, and the module reads
// globalThis.localStorage — so stub a minimal in-memory store for these tests.
import { MemoryStorage } from "./testSupport/memoryStorage";

const STORAGE_KEY = "chemdraft.keybindings.v1";

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  setLaunchKeybindingScheme(undefined);
  vi.unstubAllGlobals();
});

describe("keybindingSettings", () => {
  // New installs get the industry-standard scheme; existing installs are pinned to the old default
  // by shortcutDefaultMigration.ts before anything reads this fallback.
  it("defaults new installs to the industry-standard scheme and keeps the old default named", () => {
    expect(DEFAULT_KEYBINDING_SETTINGS).toEqual({ scheme: "chemdraw" });
    expect(LEGACY_DEFAULT_KEYBINDING_SCHEME).toBe("chemdraft");
    expect(loadKeybindingSettings()).toEqual(DEFAULT_KEYBINDING_SETTINGS);
  });

  it("persists and reloads the chosen scheme", () => {
    saveKeybindingSettings({ scheme: "chemdraw" });
    expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraw" });
    saveKeybindingSettings({ scheme: "chemdraft" });
    expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraft" });
  });

  it("falls back to the default on unknown schemes and corrupt JSON", () => {
    storage.setItem(STORAGE_KEY, JSON.stringify({ scheme: "vim" }));
    expect(loadKeybindingSettings()).toEqual(DEFAULT_KEYBINDING_SETTINGS);
    storage.setItem(STORAGE_KEY, "{not json");
    expect(loadKeybindingSettings()).toEqual(DEFAULT_KEYBINDING_SETTINGS);
  });

  // shortcutDefaultMigration.ts sets the launch scheme when it could not persist one, so the first
  // render of an install not proven new never falls to the new default.
  it("falls back to the launch scheme, not the new default, when the cache holds none", () => {
    setLaunchKeybindingScheme("chemdraft");
    expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraft" });
    storage.setItem(STORAGE_KEY, JSON.stringify({ scheme: "vim" }));
    expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraft" });
    storage.setItem(STORAGE_KEY, "{not json");
    expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraft" });
    // A stored scheme still wins.
    saveKeybindingSettings({ scheme: "chemdraw" });
    expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraw" });
  });

  // Palettes, popovers, Preferences and other ?window= webviews load on their own: the document
  // window's migration and its launch scheme never run there. Finding no scheme in the cache
  // (nothing stored, storage unavailable, a write that failed), they must not pick the new default
  // on their own; only the document window's migration may, and it mirrors what it picks.
  describe.each([
    ["a palette", "?window=toolset&toolsetId=core.main&resizable=false"],
    ["the Preferences window", "?window=preferences"]
  ])("in %s", (_label, search) => {
    beforeEach(() => {
      vi.stubGlobal("location", { search });
    });

    it("falls back to ChemDraft's scheme when the cache holds none", () => {
      expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraft" });
      storage.setItem(STORAGE_KEY, JSON.stringify({ scheme: "vim" }));
      expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraft" });
      storage.setItem(STORAGE_KEY, "{not json");
      expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraft" });
    });

    it("falls back to ChemDraft's scheme when storage is unavailable or its write failed", () => {
      vi.stubGlobal("localStorage", undefined);
      expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraft" });
      vi.stubGlobal("localStorage", { getItem: () => { throw new Error("SecurityError"); } });
      expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraft" });
      const failing = new MemoryStorage();
      failing.setItem = () => { throw new Error("QuotaExceededError"); };
      vi.stubGlobal("localStorage", failing);
      saveKeybindingSettings({ scheme: "chemdraw" });
      expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraft" });
    });

    it("uses the scheme the document window mirrored, either one", () => {
      saveKeybindingSettings({ scheme: "chemdraw" });
      expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraw" });
      saveKeybindingSettings({ scheme: "chemdraft" });
      expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraft" });
    });
  });

  it("type-guards schemes and settings payloads", () => {
    expect(isKeybindingScheme("chemdraw")).toBe(true);
    expect(isKeybindingScheme("chemdraft")).toBe(true);
    expect(isKeybindingScheme("vim")).toBe(false);
    expect(isKeybindingSettings({ scheme: "chemdraw" })).toBe(true);
    expect(isKeybindingSettings({ scheme: "vim" })).toBe(false);
    expect(isKeybindingSettings(undefined)).toBe(false);
    expect(isKeybindingSettings(null)).toBe(false);
  });
});
