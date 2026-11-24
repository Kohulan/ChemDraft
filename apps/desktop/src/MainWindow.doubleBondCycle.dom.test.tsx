// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, type ChemDraftDocument, type MoleculeBond, type MoleculeObject } from "@chemdraft/chem-core";
import { insertSmilesMolecule } from "@chemdraft/document-workflow-core";
import { ringInteriorDoubleBondSides } from "@chemdraft/layout-engine";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, getSelectedMolecule } from "./documentWorkflow";
import { nextDoubleBondCyclePosition, type DoubleBondCyclePosition } from "./doubleBondCycle";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

/** trans-but-2-ene: an acyclic double bond. */
function butene(): ChemDraftDocument {
  return insertSmilesMolecule(createPhase4Document("Cycle"), { x: 300, y: 300 }, {
    atoms: [
      { element: "C", x: 0, y: 0, charge: 0 }, { element: "C", x: 0.866, y: 0.5, charge: 0 },
      { element: "C", x: 1.732, y: 0, charge: 0 }, { element: "C", x: 2.598, y: 0.5, charge: 0 }
    ],
    bonds: [
      { from: 0, to: 1, order: "single", wedge: null }, { from: 1, to: 2, order: "double", wedge: null },
      { from: 2, to: 3, order: "single", wedge: null }
    ]
  }, "C/C=C/C");
}

/** Cyclohexene whose ring is pulled out of shape, so Clean Up really moves the atoms. */
function distortedCyclohexene(): ChemDraftDocument {
  const atoms = Array.from({ length: 6 }, (_, index) => ({
    element: "C", x: Math.cos(index * Math.PI / 3), y: Math.sin(index * Math.PI / 3), charge: 0
  }));
  const bonds = atoms.map((_, index) => ({
    from: index, to: (index + 1) % 6, order: index === 0 ? "double" : "single", wedge: null
  }));
  const seeded = insertSmilesMolecule(createPhase4Document("Ring"), { x: 300, y: 300 }, { atoms, bonds } as never, "C1=CCCCC1");
  const ring = getSelectedMolecule(seeded)!;
  const double = ring.bonds.find(bond => bond.order === "double")!;
  const stretched = new Set(ring.atoms.map(atom => atom.id).filter(id => id !== double.fromAtomId && id !== double.toAtomId));
  const centre = {
    x: ring.atoms.reduce((sum, atom) => sum + atom.x, 0) / ring.atoms.length,
    y: ring.atoms.reduce((sum, atom) => sum + atom.y, 0) / ring.atoms.length
  };
  // Push the four sp3 carbons away from the centre unevenly; the double bond's atoms stay put.
  return applyPatches(seeded, [{ op: "updateObject", objectId: ring.id, changes: {
    atoms: ring.atoms.map((atom, index) => stretched.has(atom.id)
      ? { ...atom, x: atom.x + (atom.x - centre.x) * (0.35 + index * 0.1), y: atom.y + (atom.y - centre.y) * 0.6 }
      : atom)
  } }]);
}

describe("MainWindow double-bond position cycle", () => {
  let container: HTMLDivElement, root: Root;
  let platformDescriptor: PropertyDescriptor | undefined;
  const captureMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  let captures: (PropertyDescriptor | undefined)[];
  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(navigator, "platform");
    captures = captureMethods.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    for (const name of captureMethods) Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true, value: name === "hasPointerCapture" ? () => false : () => {}
    });
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("localStorage", new MemoryStorage());
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    captures.forEach((descriptor, i) => {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, captureMethods[i]!, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, captureMethods[i]!);
    });
    if (platformDescriptor) Object.defineProperty(navigator, "platform", platformDescriptor);
    else Reflect.deleteProperty(navigator, "platform");
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const molecule = () => snapshot().document.pages[0]!.objects.find((o): o is MoleculeObject => o.type === "molecule")!;
  const doubleBond = (graph: MoleculeObject = molecule()) => graph.bonds.find(bond => bond.order === "double")!;
  const status = () => container.querySelector('[role="status"]')?.textContent;
  const canUndo = () => container.querySelector("[data-can-undo]")?.getAttribute("data-can-undo");
  /** The side the canvas actually drew, read from the rendered SVG. */
  const renderedSide = (bondId = doubleBond().id) => container
    .querySelector(`.native-bond-line[data-bond-id="${bondId}"][data-bond-segment="primary"]`)?.getAttribute("data-double-bond-side");
  /** Order, atoms and stereo: everything but the display block. */
  const chemistry = (graph: MoleculeObject) => ({
    atoms: graph.atoms.map(({ id, element, formalCharge }) => ({ id, element, formalCharge })),
    bonds: graph.bonds.map(({ display: _display, ...bond }: MoleculeBond) => bond)
  });

  async function render(initialDocument: ChemDraftDocument, platform: ShortcutPlatform, tool = "tool.select") {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform === "macos" ? "MacIntel" : "Win32" });
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument, initialActiveToolCommandId: tool, shortcutPlatform: platform,
      initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
  }
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  function bondMidpoint(bond = doubleBond()) {
    const graph = molecule();
    const from = graph.atoms.find(atom => atom.id === bond.fromAtomId)!, to = graph.atoms.find(atom => atom.id === bond.toAtomId)!;
    return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  }
  function pointer(type: string, x: number, y: number, buttons: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 77 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    return event;
  }
  async function hoverDoubleBond() {
    const { x, y } = bondMidpoint();
    await act(async () => { container.querySelector(".page")!.dispatchEvent(pointer("pointermove", x, y, 0)); });
    expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: doubleBond().id });
  }
  async function press2() {
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "2", code: "Digit2", bubbles: true, cancelable: true }));
    });
  }
  async function clickDoubleBond() {
    const { x, y } = bondMidpoint();
    const target = container.querySelector(`[data-object-id="${molecule().id}"]`)!;
    await act(async () => {
      target.dispatchEvent(pointer("pointerdown", x, y, 1));
      target.dispatchEvent(pointer("pointerup", x, y, 0));
    });
  }
  function expectSide(side: DoubleBondCyclePosition) {
    expect(doubleBond().display?.doubleBondSide).toBe(side);
    expect(renderedSide()).toBe(side);
    expect(status()).toBe(`Double-bond position: ${side}`);
  }

  for (const platform of ["macos", "windows"] as const) {
    it(`hover 2 twice and a Double Bond tool click cycle the stroke, one undo entry each (${platform})`, async () => {
      await render(butene(), platform);
      const original = molecule();
      const start = renderedSide() as DoubleBondCyclePosition;
      expect(["left", "center", "right"]).toContain(start);
      const first = nextDoubleBondCyclePosition(start), second = nextDoubleBondCyclePosition(first);

      await hoverDoubleBond();
      await press2();
      expectSide(first);
      const afterFirst = molecule();
      // The hover survives the commit, so 2 can be pressed again without moving the pointer.
      await press2();
      expectSide(second);
      expect(chemistry(molecule())).toEqual(chemistry(original));

      // Each press is its own labelled entry on the real undo stack.
      await command("edit.undo");
      expect(molecule()).toEqual(afterFirst);
      expect(renderedSide()).toBe(first);
      expect(status()).toBe(`Undid Double-bond position: ${second}`);
      await command("edit.undo");
      expect(molecule()).toEqual(original);
      expect(renderedSide()).toBe(start);
      expect(status()).toBe(`Undid Double-bond position: ${first}`);
      expect(canUndo()).toBe("false");
      await command("edit.redo");
      expect(molecule()).toEqual(afterFirst);
      expect(status()).toBe(`Redid Double-bond position: ${first}`);
      await command("edit.undo");

      // The Double Bond tool click goes through the same cycle.
      await command("tool.doubleBond");
      await clickDoubleBond();
      expectSide(first);
      expect(chemistry(molecule())).toEqual(chemistry(original));
      await clickDoubleBond();
      expectSide(second);
      await command("edit.undo");
      expect(molecule().bonds).toEqual(afterFirst.bonds);
      expect(renderedSide()).toBe(first);
      await command("edit.undo");
      expect(molecule().bonds).toEqual(original.bonds);
      expect(renderedSide()).toBe(start);
    }, 20_000);

    it(`with the Bond tool, each hover 2 redraws the bond on its committed side without a pointer move (${platform})`, async () => {
      await render(butene(), platform, "tool.bond");
      const stored = renderedSide();
      await hoverDoubleBond();
      // The Bond tool's hover preview draws over the stored side.
      const previewed = renderedSide();
      expect(previewed).not.toBe(stored);

      const drawn = [previewed];
      for (let press = 0; press < 3; press += 1) {
        await press2();
        const committed = doubleBond().display?.doubleBondSide;
        expect(status()).toBe(`Double-bond position: ${committed}`);
        // The canvas shows the side just committed: never the pre-press preview or side.
        expect(renderedSide()).toBe(committed);
        expect(renderedSide()).not.toBe(drawn.at(-1));
        drawn.push(renderedSide());
      }
      expect(new Set(drawn.slice(1))).toEqual(new Set(["left", "center", "right"]));
      expect(snapshot().hoveredNativeTarget).toMatchObject({ kind: "bond", bondId: doubleBond().id });

      // A keyboard undo re-hits the hover too: it must not keep drawing the undone side.
      await press2();
      const undone = renderedSide();
      await act(async () => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", {
          key: "z", code: "KeyZ", metaKey: platform === "macos", ctrlKey: platform === "windows", bubbles: true, cancelable: true
        }));
      });
      expect(status()).toBe(`Undid Double-bond position: ${undone}`);
      expect(doubleBond().display?.doubleBondSide).toBe(drawn.at(-1));
      expect(renderedSide()).not.toBe(undone);
    }, 20_000);

    it(`keeps a ring double bond's user side outside the ring through Clean Up (${platform})`, async () => {
      await render(distortedCyclohexene(), platform);
      const bondId = doubleBond().id;
      const inside = ringInteriorDoubleBondSides(molecule()).get(bondId)!;
      expect(renderedSide()).toBe(inside);
      // Step until the stroke sits outside the ring: an authored choice the default would undo.
      for (let step = 0; step < 3 && (renderedSide() === inside || renderedSide() === "center"); step += 1) {
        await hoverDoubleBond();
        await press2();
      }
      const outside = renderedSide();
      expect(outside).not.toBe(inside);
      expect(outside).not.toBe("center");
      expect(doubleBond().display).toMatchObject({ doubleBondSide: outside, doubleBondSideSource: "user" });
      const before = molecule();

      await command("structure.cleanup2d");
      const cleaned = molecule();
      // Clean Up really redrew the ring, so the side reconciliation ran.
      const moved = cleaned.atoms.some(atom => {
        const old = before.atoms.find(candidate => candidate.id === atom.id)!;
        return Math.hypot(atom.x - old.x, atom.y - old.y) > 1;
      });
      expect(moved).toBe(true);
      expect(chemistry(cleaned)).toEqual(chemistry(before));
      const cleanedBond = doubleBond(cleaned);
      expect(cleanedBond.display?.doubleBondSideSource).toBe("user");
      const insideAfter = ringInteriorDoubleBondSides(cleaned).get(bondId);
      expect(insideAfter).toBeDefined();
      expect(renderedSide(bondId)).not.toBe(insideAfter);
      expect(renderedSide(bondId)).not.toBe("center");

      await command("edit.undo");
      expect(molecule()).toEqual(before);
      expect(renderedSide(bondId)).toBe(outside);
    }, 20_000);
  }
});
