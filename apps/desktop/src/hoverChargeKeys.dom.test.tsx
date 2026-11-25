// @vitest-environment jsdom
// RC 1.2.3 hands-on report (macOS): hovering an atom and pressing + (Shift+= on a US keyboard) picked
// the Positive Charge tool instead of charging the atom, while - charged it. Real key events through
// MainWindow, dispatched from the focused canvas with the Shift keydown first and no pointer move after
// it. Cause: some macOS input paths report Shift+= as key "=" (not "+"), which the hover table (literal
// "+") missed while the window shortcut registry folds +/= into the Positive Charge tool's chord.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChemDraftDocument } from "@chemdraft/chem-core";
import { transformPointForObject } from "@chemdraft/layout-engine";
import { ensureOclResources } from "@chemdraft/ocl-adapter";
import { MainWindow } from "./MainWindow";
import * as workflow from "./documentWorkflow";
import { KEYBINDING_STORAGE_KEY } from "./keybindingSettings";
import { dropMolecule } from "./testSupport/electronMarkDropFixture";
import { MemoryStorage } from "./testSupport/memoryStorage";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

type Point = { x: number; y: number };
const PLUS = { key: "+", code: "Equal", shiftKey: true };
// What some macOS input paths (and automation) report for Shift+=: the unshifted legend, Shift held.
const SHIFTED_EQUAL = { key: "=", code: "Equal", shiftKey: true };
const BARE_EQUAL = { key: "=", code: "Equal" };
const NUMPAD_PLUS = { key: "+", code: "NumpadAdd" };
// A layout where + needs no Shift (German, Nordic): the key is labelled + on its own.
const UNSHIFTED_PLUS = { key: "+", code: "BracketRight" };
const MINUS = { key: "-", code: "Minus" };

beforeAll(async () => { await ensureOclResources(); });

// The ChemDraft scheme binds + and - to the charge tools as well as to the hovered atom; the
// classic (ChemDraw) scheme binds them to the hovered atom only.
describe.each([
  { platform: "macos", scheme: "chemdraft" }, { platform: "windows", scheme: "chemdraft" },
  { platform: "macos", scheme: "chemdraw" }, { platform: "windows", scheme: "chemdraw" }
] as const)("hover charge keys on $platform, $scheme scheme", ({ platform, scheme }) => {
  let container: HTMLDivElement, root: Root;
  let frames: Map<number, FrameRequestCallback>, frameId: number;
  beforeEach(() => {
    const storage = new MemoryStorage();
    storage.setItem(KEYBINDING_STORAGE_KEY, JSON.stringify({ scheme }));
    vi.stubGlobal("localStorage", storage);
    frames = new Map(); frameId = 0;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  async function mount(document: ChemDraftDocument) {
    await act(async () => root.render(createElement(MainWindow, { initialDocument: document,
      initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden", nativePalette: true,
      initialRulersVisible: false, initialCrosshairsVisible: false, shortcutPlatform: platform })));
    // The canvas region too, so the pointer counts as inside it and a key edit re-hits the hover.
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
  }
  const agent = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const snapshot = () => agent().document;
  const status = () => container.querySelector("[data-status-message]")?.textContent;
  async function move(point: Point) {
    await act(async () => {
      const event = new MouseEvent("pointermove", { bubbles: true, cancelable: true, button: 0, buttons: 0,
        clientX: point.x, clientY: point.y });
      Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
      (container.querySelector(".native-molecule-object") ?? container.querySelector(".page")!).dispatchEvent(event);
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback(performance.now()));
    });
  }
  const canvas = () => container.querySelector<HTMLElement>(".canvas-region")!;
  const key = (type: string, options: KeyboardEventInit) =>
    canvas().dispatchEvent(new KeyboardEvent(type, { ...options, bubbles: true, cancelable: true }));
  /**
   * What a real keyboard sends to the focused canvas: Shift first when the character needs it, then
   * the character, with no pointer move in between. `afterShift` runs while Shift is held.
   */
  async function press(init: KeyboardEventInit, afterShift?: () => Promise<void>) {
    canvas().focus();
    if (init.shiftKey) {
      await act(async () => key("keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true }));
      await afterShift?.();
    }
    await act(async () => { key("keydown", init); key("keyup", init); });
    if (init.shiftKey) await act(async () => key("keyup", { key: "Shift", code: "ShiftLeft" }));
  }
  /** A benzene ring, whole-selected as it is right after placement (the hands-on state). */
  async function benzene(selected = true) {
    const inserted = workflow.insertNativeTemplateMolecule(workflow.createPhase4Document("Hover charge"), { x: 300, y: 300 }, "benzene");
    const moleculeId = inserted.selection.objectIds[0]!;
    await mount(selected ? inserted : workflow.selectDocumentObjects(inserted, inserted.pages[0].id, []));
    return moleculeId;
  }
  async function hoverAtom(moleculeId: string) {
    const owner = snapshot().pages[0].objects.find(object => object.id === moleculeId) as ReturnType<typeof dropMolecule>;
    await move(transformPointForObject(owner, owner.atoms.find(atom => atom.id === "atom_001")!));
    expect(agent().hoveredNativeTarget).toMatchObject({ kind: "atom", atomId: "atom_001" });
  }
  const marks = () => snapshot().pages[0].objects.filter(object => object.type === "electron-mark");
  const charge = () => dropMolecule(snapshot()).atoms.find(atom => atom.id === "atom_001")!.formalCharge;

  it.each([
    { name: "+ (Shift+=)", init: PLUS, value: 1, sign: "positive" },
    { name: "numpad +", init: NUMPAD_PLUS, value: 1, sign: "positive" },
    { name: "+ on a layout with an unshifted + key", init: UNSHIFTED_PLUS, value: 1, sign: "positive" },
    { name: "-", init: MINUS, value: -1, sign: "negative" }
  ])("hovering an atom of a selected ring and pressing $name charges that atom", async ({ init, value, sign }) => {
    const moleculeId = await benzene();
    await hoverAtom(moleculeId);
    await press(init);
    expect(marks()).toHaveLength(1);
    expect(charge()).toBe(value);
    expect(status()).toBe(`Placed ${sign} charge on hovered atom`);
    expect(agent().activeToolCommandId).toBe("tool.select");
    // Same selection result for + and -: the ring plus its new mark.
    expect([...snapshot().selection.objectIds].sort()).toEqual([moleculeId, marks()[0]!.id].sort());
  });

  it.runIf(scheme === "chemdraft").each([
    { name: "+ (Shift+=)", init: PLUS, tool: "tool.plus" },
    { name: "Shift+= reported as \"=\"", init: SHIFTED_EQUAL, tool: "tool.plus" },
    { name: "numpad +", init: NUMPAD_PLUS, tool: "tool.plus" },
    { name: "-", init: MINUS, tool: "tool.minus" }
  ])("with nothing hovered, $name picks $tool", async ({ init, tool }) => {
    await benzene(false);
    await move({ x: 700, y: 550 });
    expect(agent().hoveredNativeTarget).toBeUndefined();
    await press(init);
    expect(agent().activeToolCommandId).toBe(tool);
    expect(marks()).toHaveLength(0);
  });

  it.each([
    { name: "Shift+= reported as \"=\"", init: SHIFTED_EQUAL, selected: true },
    { name: "Shift+= reported as \"=\"", init: SHIFTED_EQUAL, selected: false },
    { name: "a literal + (control)", init: PLUS, selected: true },
    { name: "a literal + (control)", init: PLUS, selected: false }
  ])("$name over an atom of a ring (selected: $selected) charges that atom once", async ({ init, selected }) => {
    const moleculeId = await benzene(selected);
    await hoverAtom(moleculeId);
    await press(init, async () => {
      expect(agent().hoveredNativeTarget).toMatchObject({ kind: "atom", atomId: "atom_001" });
    });
    expect(marks()).toHaveLength(1);
    expect(charge()).toBe(1);
    expect(status()).toBe("Placed positive charge on hovered atom");
    expect(agent().activeToolCommandId).toBe("tool.select");
  });

  it("a bare = with nothing hovered keeps its existing meaning", async () => {
    await benzene(false);
    await move({ x: 700, y: 550 });
    expect(agent().hoveredNativeTarget).toBeUndefined();
    await press(BARE_EQUAL);
    expect(marks()).toHaveLength(0);
    expect(agent().activeToolCommandId).toBe(scheme === "chemdraft" ? "tool.plus" : "tool.select");
  });

  it("a bare = (no Shift) over an atom is not the hover + key", async () => {
    const moleculeId = await benzene();
    await hoverAtom(moleculeId);
    await press(BARE_EQUAL);
    expect(marks()).toHaveLength(0);
    expect(charge()).toBe(0);
  });
});
