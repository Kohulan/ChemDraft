// @vitest-environment jsdom
// CodeRabbit review of the 1.2.2 PR (#422), the gesture items: real DOM pointer events through MainWindow.
// A claim that reproduces is `it.fails` (the fix removes `.fails`).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, applyPatches, type ChemDraftDocument, type ElectronMarkObject } from "@chemdraft/chem-core";
import { transformPointForObject } from "@chemdraft/layout-engine";
import { phase4Timestamp } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import * as workflow from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { dropMark, dropMolecule, electronMarkDropFixture } from "./testSupport/electronMarkDropFixture";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { ensureRdkit, rdkitConformerGenerator, resetRdkitForTesting, setRdkitModuleLoader } from "@chemdraft/rdkit-adapter";
import { installDomRdkitLoader } from "./testSupport/rdkitIdentity";
import { quatFromAxisAngle } from "./interaction/rotation3d";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe.each(["macos", "windows"] as const)("CodeRabbit #422 gesture items on %s", platform => {
  let container: HTMLDivElement, root: Root;
  let frames: Map<number, FrameRequestCallback>, frameId: number;
  const captureMethods = { set: Element.prototype.setPointerCapture,
    release: Element.prototype.releasePointerCapture, has: Element.prototype.hasPointerCapture };
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    frames = new Map(); frameId = 0;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => false;
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
    Element.prototype.setPointerCapture = captureMethods.set;
    Element.prototype.releasePointerCapture = captureMethods.release;
    Element.prototype.hasPointerCapture = captureMethods.has;
  });
  async function mount(document: ChemDraftDocument) {
    await act(async () => root.render(createElement(MainWindow, { initialDocument: document,
      initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden", nativePalette: false,
      initialRulersVisible: false, initialCrosshairsVisible: false, shortcutPlatform: platform })));
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
      right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) });
  }
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const status = () => container.querySelector("[data-status-message]")?.textContent;
  const page = () => container.querySelector(".page")!;
  function pointer(target: EventTarget, type: string, point: { x: number; y: number }) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    target.dispatchEvent(event);
  }
  async function move(target: EventTarget, point: { x: number; y: number }) {
    await act(async () => {
      pointer(target, "pointermove", point);
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback(performance.now()));
    });
  }
  async function drag(objectId: string, from: { x: number; y: number }, to: { x: number; y: number }, onTarget = false) {
    const target = container.querySelector(`.native-molecule-object[data-object-id="${objectId}"]`)!;
    expect(target).not.toBeNull();
    await act(async () => pointer(target, "pointerdown", from));
    const before = snapshot();
    // Two moves: past the drag threshold, then to the release point.
    const receiver = onTarget ? target : page();
    await move(receiver, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
    await move(receiver, to);
    await act(async () => pointer(receiver, "pointerup", to));
    return before;
  }
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }

  // -------------------------------------------------------------------------------------------
  // E: documentWorkflow.ts:8500 — whole-molecule drag leaves a bond/object-anchored + behind
  // -------------------------------------------------------------------------------------------
  it.each(["bond", "object"] as const)(
    "E: dragging the whole selected molecule keeps its %s-anchored + on N (or refuses the move)", async kind => {
      const { document, nitrogen, saturatedCarbon } = electronMarkDropFixture();
      const molecule = dropMolecule(document), mark = dropMark(document);
      const bond = molecule.bonds.find(candidate => candidate.fromAtomId === nitrogen.id || candidate.toAtomId === nitrogen.id)!;
      const anchor: ElectronMarkObject["anchor"] = kind === "bond"
        ? { kind, objectId: molecule.id, bondId: bond.id } : { kind, objectId: molecule.id };
      // A legacy-anchored + on N, as 1.2.2 commit normalization keeps it (and saves and reopens it).
      const drawing = workflow.normalizeCommittedDocument(applyPatch(document, { op: "updateObject", objectId: mark.id, changes: {
        anchor, atomAssociation: undefined, x: nitrogen.x - mark.width / 2, y: nitrogen.y - mark.height / 2 } }, { now: phase4Timestamp }));
      expect(dropMolecule(drawing).atoms.find(atom => atom.id === nitrogen.id)).toMatchObject({ formalCharge: 1, markCharge: 1 });
      await mount(workflow.selectDocumentObjects(drawing, drawing.pages[0].id, [molecule.id]));
      const before = await drag(molecule.id, saturatedCarbon, { x: saturatedCarbon.x + 150, y: saturatedCarbon.y + 200 }, true);
      const after = snapshot();
      const refused = after === before || JSON.stringify(after) === JSON.stringify(before);
      // The gesture must have been the whole-molecule move: every atom shifted by the same delta.
      if (!refused) {
        const moved = dropMolecule(after);
        expect(moved.atoms.find(atom => atom.id === saturatedCarbon.id)!.x).not.toBe(saturatedCarbon.x);
        expect(moved.atoms.find(atom => atom.id === nitrogen.id)!.x - nitrogen.x)
          .toBeCloseTo(moved.atoms.find(atom => atom.id === saturatedCarbon.id)!.x - saturatedCarbon.x);
      }
      if (refused) return;
      // Silent loss is the bug: the move committed and N lost its +.
      expect({ charge: dropMolecule(after).atoms.find(atom => atom.id === nitrogen.id)!.formalCharge, status: status() })
        .toMatchObject({ charge: 1 });
      await command("edit.undo");
    });

  // -------------------------------------------------------------------------------------------
  // I: electronMarkDrop.dom.test.ts:886 — a part drag on a rotated molecule does not follow the pointer
  // -------------------------------------------------------------------------------------------
  // Several rotations, sub-pixel tolerance. The dragged O must be drawn where the (snapped) drop
  // puts it, and every stationary atom must stay exactly where it was drawn. (Molecule objects have
  // no mirror transform: scaleX/scaleY are positive-only, and a flip rewrites atom coordinates.)
  it.each([30, 90, 135, 250])("I: an atom dragged on a %d°-rotated molecule is drawn at the release point", async rotation => {
    const { document, hydroxylOxygen } = electronMarkDropFixture();
    const molecule = dropMolecule(document);
    const rotated = applyPatches(document, [
      { op: "removeObject", objectId: dropMark(document).id },
      { op: "updateObject", objectId: molecule.id, changes: { rotation } }
    ], { now: phase4Timestamp });
    const startMolecule = dropMolecule(rotated);
    await mount(workflow.selectDocumentObjects(rotated, rotated.pages[0].id, []));
    const start = transformPointForObject(startMolecule, hydroxylOxygen);
    const end = { x: start.x + 40, y: start.y + 25 };
    await drag(molecule.id, start, end);
    const moved = dropMolecule(snapshot());
    expect(moved.rotation).toBe(rotation);
    // The drop the app intends: the release delta, snapped in the molecule's own frame, back on the page.
    const frameDelta = workflow.moleculeFrameDelta(startMolecule, { x: end.x - start.x, y: end.y - start.y });
    const snapped = workflow.snapNativeMoleculePartDragDelta(startMolecule,
      { kind: "atom", objectId: molecule.id, atomId: hydroxylOxygen.id }, frameDelta);
    const pageDelta = workflow.moleculeFrameDelta(startMolecule, snapped, true);
    const intended = { x: start.x + pageDelta.x, y: start.y + pageDelta.y };
    const oxygen = moved.atoms.find(atom => atom.id === hydroxylOxygen.id)!;
    const drawn = transformPointForObject(moved, oxygen);
    expect(Math.hypot(drawn.x - start.x, drawn.y - start.y)).toBeGreaterThan(10);
    expect(Math.hypot(drawn.x - intended.x, drawn.y - intended.y)).toBeLessThan(0.5);
    // Without a snap adjustment, the intended drop is the release point itself.
    if (Math.hypot(snapped.x - frameDelta.x, snapped.y - frameDelta.y) < 1e-9) {
      expect(Math.hypot(drawn.x - end.x, drawn.y - end.y)).toBeLessThan(0.5);
    }
    // Stationary atoms are drawn exactly where they were.
    for (const atom of startMolecule.atoms) {
      if (atom.id === hydroxylOxygen.id) continue;
      const was = transformPointForObject(startMolecule, atom);
      const now = transformPointForObject(moved, moved.atoms.find(candidate => candidate.id === atom.id)!);
      expect(Math.hypot(now.x - was.x, now.y - was.y)).toBeLessThan(0.5);
    }
  });
});

// -------------------------------------------------------------------------------------------
// S (hands-on follow-up): during the live Spin 3D overlay a + stayed at its old screen position and
// only jumped to its N on flatten. The overlay must draw it at its atom's projected position, offset
// exactly as flatten commits it (the shared ScreenPlacement contract).
// -------------------------------------------------------------------------------------------
describe("S: Spin 3D live overlay carries a charge mark with its atom", () => {
  let container: HTMLDivElement, root: Root;
  beforeAll(async () => {
    installDomRdkitLoader();
    installDomRdkitLoader(setRdkitModuleLoader);
    await ensureRdkit();
  });
  afterAll(() => resetRdkitForTesting());
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
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

  it("S: the + on N is painted at N's projected position while spinning, where flatten then commits it", async () => {
    const { document: drawing, nitrogen } = electronMarkDropFixture();
    const molecule = dropMolecule(drawing), mark = dropMark(drawing);
    const coords3d = (await rdkitConformerGenerator.generate3DConformer(
      { molfile: workflow.analysisFacingStructure(molecule).structure }, { seed: 42, optimize: "none" }
    )).mapping.coords3dByOriginalAtom.slice(0, molecule.atoms.length * 3);
    const modeled = workflow.selectDocumentObjects(workflow.attachSpin3dModelFromConformer(drawing, molecule.id,
      { coords3d, orientation: quatFromAxisAngle([1, 0, 0], 0) }), drawing.pages[0].id, [molecule.id]);
    const { width, height } = modeled.pages[0];
    const rect = { x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON: () => ({}) };
    await act(async () => root.render(createElement(MainWindow, { initialDocument: modeled,
      initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden", nativePalette: true,
      initialRulersVisible: false, initialCrosshairsVisible: false })));
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => rect;
    const before = window.__CHEMDRAFT_AGENT__!.snapshot().document;
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "structure.spin3d" } })));
    const overlay = () => container.querySelector<SVGSVGElement>("[data-spin3d-overlay]");
    await vi.waitFor(() => expect(overlay()).toBeTruthy());
    // The live overlay paints the + translated with N; the stationary page copy is hidden.
    const live = overlay()!.querySelector(`[data-spin3d-electron-mark="${mark.id}"]`);
    expect(live).not.toBeNull();
    const [dx, dy] = live!.getAttribute("data-spin3d-mark-offset")!.split(" ").map(Number);
    expect(Math.hypot(dx, dy)).toBeGreaterThan(1);
    expect(live!.getAttribute("transform")).toBe(`translate(${dx} ${dy})`);
    expect(container.querySelector(`[data-page-svg-object-visual="${mark.id}"]`)?.getAttribute("visibility")).toBe("hidden");
    // Flatten (click outside): the committed + sits exactly where the overlay drew it.
    const svg = overlay()!;
    svg.getBoundingClientRect = () => rect;
    await act(async () => {
      const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 20, clientY: 20 });
      Object.defineProperties(down, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
      svg.dispatchEvent(down);
    });
    await vi.waitFor(() => expect(overlay()).toBeNull());
    const after = window.__CHEMDRAFT_AGENT__!.snapshot().document;
    expect(after).not.toEqual(before);
    const flattened = dropMark(after);
    expect(flattened.x - mark.x).toBeCloseTo(dx, 6);
    expect(flattened.y - mark.y).toBeCloseTo(dy, 6);
    // A spin never changes chemistry.
    expect(dropMolecule(after).atoms.find(atom => atom.id === nitrogen.id)).toMatchObject({ formalCharge: 1 });
    expect(container.querySelector(`[data-page-svg-object-visual="${mark.id}"]`)?.getAttribute("visibility")).not.toBe("hidden");
  });
});
