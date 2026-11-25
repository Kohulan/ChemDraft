import { describe, expect, it } from "vitest";
import {
  actionShortcutKeys, createHoverShortcutRegistry, editShortcut, recordedHoverKeyFromEvent, resolveHoverKey,
  shiftedHoverKeyAlternate, type ShortcutAction
} from "./index";

const save: ShortcutAction = { id: "document.save", scope: "commands", title: "Save", defaults: ["Mod+S"] };
const tool: ShortcutAction = { id: "tool.bond", scope: "commands", title: "Bond", defaults: ["M"] };
const bromine: ShortcutAction = { id: "atom.bromine", scope: "atom", title: "Bromine", defaults: ["b"] };
const boron: ShortcutAction = { id: "atom.boron", scope: "atom", title: "Boron", defaults: ["B"] };
const actions = [save, tool, bromine, boron];

describe.each(["macos", "windows"] as const)("shortcut edits on %s", platform => {
  it("checks a chord once, and moves it only after replacement", () => {
    const edit = { kind: "assign", key: "Mod+S" } as const;
    expect(editShortcut(actions, {}, tool, edit, platform)).toEqual({ kind: "conflict", actions: [save] });
    const reassigned = editShortcut(actions, {}, tool, edit, platform, true);
    expect(reassigned).toEqual({ kind: "updated", overrides: { commands: { [save.id]: [], [tool.id]: ["Mod+S"] } } });
    if (reassigned.kind !== "updated") throw new Error("Expected updated shortcuts");
    expect(editShortcut(actions, reassigned.overrides, save, { kind: "reset" }, platform)).toEqual({
      kind: "conflict", actions: [tool]
    });
    const cleared = editShortcut(actions, reassigned.overrides, tool, { kind: "clear" }, platform);
    if (cleared.kind !== "updated") throw new Error("Expected cleared shortcut");
    const reset = editShortcut(actions, cleared.overrides, save, { kind: "reset" }, platform);
    if (reset.kind !== "updated") throw new Error("Expected reset shortcut");
    expect(actionShortcutKeys(save, reset.overrides)).toEqual(["Mod+S"]);
    expect(actionShortcutKeys(tool, reset.overrides)).toEqual([]);
  });

  it("reports uppercase and lowercase hover conflicts independently", () => {
    expect(editShortcut(actions, {}, tool, { kind: "assign", key: "B" }, platform)).toEqual({ kind: "conflict", actions: [bromine] });
    expect(editShortcut(actions, {}, tool, { kind: "assign", key: "Shift+B" }, platform)).toEqual({ kind: "conflict", actions: [boron] });
  });

  it.each(["F5", "Mod+R", "Ctrl+R", "Mod+Q", "Mod+W"])("refuses %s", key => {
    expect(editShortcut(actions, {}, save, { kind: "assign", key }, platform)).toMatchObject({ kind: "refused" });
  });

  it("reserves system shortcuts for the active platform", () => {
    const key = platform === "macos" ? "Mod+Space" : "Alt+F4";
    expect(editShortcut(actions, {}, save, { kind: "assign", key }, platform)).toEqual({
      kind: "refused", reason: "Reserved by the operating system."
    });
  });
});

// Some macOS input paths (and automation) report Shift+= as key "=" with Shift held. The window chord
// engine folds +/= and drops Shift, but hover tables keep literal characters, so the hover lookup and
// the hover recorder must read that press as "+".
describe("shifted +/= on the hover path", () => {
  const shiftedEqual = { key: "=", code: "Equal", shiftKey: true };
  const charges = createHoverShortcutRegistry({ "+": "atom.plus", "-": "atom.minus" });

  it("reads Shift+= reported as \"=\" as +, and nothing else", () => {
    expect(shiftedHoverKeyAlternate(shiftedEqual)).toBe("+");
    expect(shiftedHoverKeyAlternate({ key: "=", code: "Equal" })).toBeUndefined();
    expect(shiftedHoverKeyAlternate({ key: "+", code: "Equal", shiftKey: true })).toBeUndefined();
    expect(shiftedHoverKeyAlternate({ key: "+", code: "NumpadAdd" })).toBeUndefined();
    expect(shiftedHoverKeyAlternate({ key: "=", code: "Digit0", shiftKey: true })).toBeUndefined();
    for (const modifier of ["ctrlKey", "altKey", "metaKey"] as const) {
      expect(shiftedHoverKeyAlternate({ ...shiftedEqual, [modifier]: true })).toBeUndefined();
    }
  });

  it("tries the literal binding first, then + in the same table", () => {
    const lookup = (table: ReadonlyMap<string, string>) => (key: string) => table.get(key);
    expect(resolveHoverKey(shiftedEqual, lookup(charges))).toEqual({ key: "+", match: "atom.plus" });
    expect(resolveHoverKey({ key: "+", code: "Equal", shiftKey: true }, lookup(charges))).toEqual({ key: "+", match: "atom.plus" });
    expect(resolveHoverKey({ key: "+", code: "NumpadAdd" }, lookup(charges))).toEqual({ key: "+", match: "atom.plus" });
    // A bare = is not +, and a literal = binding wins over the alternate.
    expect(resolveHoverKey({ key: "=", code: "Equal" }, lookup(charges))).toEqual({ key: "=", match: undefined });
    const both = createHoverShortcutRegistry({ "+": "atom.plus", "=": "atom.equals" });
    expect(resolveHoverKey(shiftedEqual, lookup(both))).toEqual({ key: "=", match: "atom.equals" });
    // Remapped or cleared bindings are respected: no hidden + fallback survives them.
    const cleared = createHoverShortcutRegistry({ "+": "atom.plus" }, { "atom.plus": [] });
    expect(resolveHoverKey(shiftedEqual, lookup(cleared))).toEqual({ key: "=", match: undefined });
    const remapped = createHoverShortcutRegistry({ "+": "atom.plus" }, { "atom.plus": ["p"] });
    expect(resolveHoverKey(shiftedEqual, lookup(remapped))).toEqual({ key: "=", match: undefined });
    expect(resolveHoverKey({ key: "p", code: "KeyP" }, lookup(remapped))).toEqual({ key: "p", match: "atom.plus" });
  });

  it("records Shift+= as +", () => {
    expect(recordedHoverKeyFromEvent(shiftedEqual)).toBe("+");
    expect(recordedHoverKeyFromEvent({ key: "+", code: "Equal", shiftKey: true })).toBe("+");
    expect(recordedHoverKeyFromEvent({ key: "=", code: "Equal" })).toBe("=");
    expect(recordedHoverKeyFromEvent({ key: "a", code: "KeyA", shiftKey: true })).toBe("A");
  });
});
