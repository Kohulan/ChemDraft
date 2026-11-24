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

  // -------------------------------------------------------------------------------------------
  // 1.2.3 stress run: on a freshly placed (selected) benzene, hovering atom_001 and typing + selected
  // only the new charge, so a plain click on ring bond bond_001 selected that bond part and a drag
  // from bond_002 acted on the one-bond fragment. A placed mark follows its atom, so it now joins a
  // whole-selected molecule's selection: the click and drag behave as on the uncharged ring, and the
  // drag carries the charge. On an unselected ring both behave alike too (a bond click selects it).
  // -------------------------------------------------------------------------------------------
  const ringPoint = (document: ChemDraftDocument, moleculeId: string, atomId: string) => {
    const owner = document.pages[0].objects.find(object => object.id === moleculeId) as ReturnType<typeof dropMolecule>;
    return transformPointForObject(owner, owner.atoms.find(atom => atom.id === atomId)!);
  };
  const bondMidpoint = (document: ChemDraftDocument, moleculeId: string, bondId: string) => {
    const owner = document.pages[0].objects.find(object => object.id === moleculeId) as ReturnType<typeof dropMolecule>;
    const bond = owner.bonds.find(candidate => candidate.id === bondId)!;
    const from = ringPoint(document, moleculeId, bond.fromAtomId), to = ringPoint(document, moleculeId, bond.toAtomId);
    return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  };
  /** Place benzene, optionally type + over atom_001, click bond_001, then drag from bond_002. */
  async function clickBondThenDragNeighbour(charged: boolean, ringSelected: boolean) {
    const inserted = workflow.insertNativeTemplateMolecule(workflow.createPhase4Document("Charged benzene"), { x: 300, y: 300 }, "benzene");
    const moleculeId = inserted.selection.objectIds[0]!;
    await mount(ringSelected ? inserted : workflow.selectDocumentObjects(inserted, inserted.pages[0].id, []));
    let markId: string | undefined;
    if (charged) {
      await move(page(), ringPoint(snapshot(), moleculeId, "atom_001"));
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true, cancelable: true })));
      const marks = snapshot().pages[0].objects.filter(object => object.type === "electron-mark");
      expect(marks).toHaveLength(1);
      markId = marks[0]!.id;
      expect(status()).toBe("Placed positive charge on hovered atom");
      // The mark is selected; a whole-selected ring stays selected with it.
      expect(snapshot().selection.objectIds).toEqual(ringSelected ? [moleculeId, markId] : [markId]);
    }
    const click = bondMidpoint(snapshot(), moleculeId, "bond_001");
    await move(page(), click);
    const target = container.querySelector(`.native-molecule-object[data-object-id="${moleculeId}"]`)!;
    await act(async () => pointer(target, "pointerdown", click));
    await act(async () => pointer(target, "pointerup", click));
    const clicked = window.__CHEMDRAFT_AGENT__!.snapshot();
    const from = bondMidpoint(snapshot(), moleculeId, "bond_002");
    await move(page(), from);
    const before = await drag(moleculeId, from, { x: from.x + 60, y: from.y + 40 }, true);
    const result = { moleculeId, markId, clicked, before, after: snapshot(), status: status() };
    await act(async () => root.unmount());
    root = createRoot(container);
    return result;
  }
  /** Each atom's page-space shift across the drag. */
  const shifts = (before: ChemDraftDocument, after: ChemDraftDocument, moleculeId: string) =>
    dropMolecule(after).atoms.map(atom => {
      const was = ringPoint(before, moleculeId, atom.id), now = ringPoint(after, moleculeId, atom.id);
      return { x: now.x - was.x, y: now.y - was.y };
    });

  it.each([true, false])("a bond click after typing + selects as on the uncharged ring (ring selected first: %s)", async ringSelected => {
    const plain = await clickBondThenDragNeighbour(false, ringSelected);
    const charged = await clickBondThenDragNeighbour(true, ringSelected);
    const moleculeOnly = (ids: readonly string[]) => ids.filter(id => id === charged.moleculeId);
    expect({ objects: moleculeOnly(charged.clicked.selection.objectIds), part: charged.clicked.selectedNativeMoleculePart })
      .toEqual({ objects: plain.clicked.selection.objectIds, part: plain.clicked.selectedNativeMoleculePart });
    // Anything else still selected is the ring's own charge, never a part of the ring.
    expect(charged.clicked.selection.objectIds.filter(id => id !== charged.moleculeId)).toEqual(
      charged.clicked.selection.objectIds.length > 1 ? [charged.markId] : []);
    expect(charged.status).not.toMatch(/Resized/);
    expect(plain.status).not.toMatch(/Resized/);
    if (!ringSelected) {
      expect(charged.clicked.selectedNativeMoleculePart).toMatchObject({ kind: "bond", bondId: "bond_001" });
      return;
    }
    // A whole-selected ring: the click keeps it whole, and the drag moves it rigidly with its charge.
    expect(charged.clicked.selectedNativeMoleculePart).toBeUndefined();
    const moved = shifts(charged.before, charged.after, charged.moleculeId), delta = moved[0]!;
    expect(Math.hypot(delta.x, delta.y)).toBeGreaterThan(10);
    for (const shift of moved) {
      expect(shift.x).toBeCloseTo(delta.x, 6);
      expect(shift.y).toBeCloseTo(delta.y, 6);
    }
    const markBefore = dropMark(charged.before), markAfter = dropMark(charged.after);
    expect(markAfter.anchor).toMatchObject({ kind: "atom", objectId: charged.moleculeId, atomId: "atom_001" });
    expect(workflow.nativeChargeMarkCenter(markAfter).x - workflow.nativeChargeMarkCenter(markBefore).x).toBeCloseTo(delta.x, 6);
    expect(workflow.nativeChargeMarkCenter(markAfter).y - workflow.nativeChargeMarkCenter(markBefore).y).toBeCloseTo(delta.y, 6);
    expect(dropMolecule(charged.after).atoms.find(atom => atom.id === "atom_001")).toMatchObject({ formalCharge: 1 });
    // The control: the same drag moves the uncharged ring rigidly by the same amount.
    const plainMoved = shifts(plain.before, plain.after, plain.moleculeId);
    expect(plainMoved[0]!.x).toBeCloseTo(delta.x, 6);
    expect(plainMoved[0]!.y).toBeCloseTo(delta.y, 6);
  });

  // Review of 6670f1f5e: a charge press that REMOVES a mark (− over an atom whose ⊕ it cancels) ran
  // the placement selection policy on every other selected mark, so it deselected a selected text
  // box and reported an unrelated selected 2+ as "Placed positive charge 2+". A removal leaves the
  // rest of the selection alone and reports what it removed.
  it("typing − over an unselected molecule's ⊕ removes it and leaves a selected text and other mark alone", async () => {
    let drawing = workflow.insertNativeTemplateMolecule(workflow.createPhase4Document("Removal"), { x: 250, y: 250 }, "benzene");
    const cancelledOn = drawing.selection.objectIds[0]!;
    drawing = workflow.insertNativeTemplateMolecule(drawing, { x: 550, y: 400 }, "benzene");
    const otherMolecule = drawing.selection.objectIds[0]!;
    const atom = (objectId: string) => ({ kind: "atom" as const, objectId, atomId: "atom_001", distanceToPointer: 0 });
    drawing = workflow.applyChargeToolAtNativeAtom(drawing, 1, atom(cancelledOn));
    const cancelledMarkId = drawing.selection.objectIds[0]!;
    drawing = workflow.applyChargeToolAtNativeAtom(drawing, 1, atom(otherMolecule));
    drawing = workflow.applyChargeToolAtNativeAtom(drawing, 1, atom(otherMolecule));
    const otherMarkId = drawing.selection.objectIds[0]!;
    const text = workflow.createNativeTextObject(drawing, { x: 100, y: 500 }, "Note");
    drawing = workflow.normalizeCommittedDocument(applyPatch(drawing,
      { op: "addObject", pageId: drawing.pages[0].id, object: text }, { now: phase4Timestamp }));
    expect(drawing.pages[0].objects.find(object => object.id === otherMarkId)).toMatchObject({ charge: 2 });
    await mount(workflow.selectDocumentObjects(drawing, drawing.pages[0].id, [text.id, otherMarkId]));

    await move(page(), ringPoint(snapshot(), cancelledOn, "atom_001"));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "-", bubbles: true, cancelable: true })));

    const after = snapshot();
    expect(after.pages[0].objects.some(object => object.id === cancelledMarkId)).toBe(false);
    const cancelled = after.pages[0].objects.find(object => object.id === cancelledOn) as ReturnType<typeof dropMolecule>;
    expect(cancelled.atoms.find(candidate => candidate.id === "atom_001")!.formalCharge ?? 0).toBe(0);
    expect([...after.selection.objectIds].sort()).toEqual([text.id, otherMarkId].sort());
    expect(status()).toBe("Removed positive charge from hovered atom");
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

  // 1.2.3 stress run: a marquee around a charged molecule selects [molecule, charge], and Spin 3D
  // refused that as "Select a single molecule to spin in 3D". The molecule's own marks fold into it.
  async function mountSpinnable(document: ChemDraftDocument, platform: "macos" | "windows") {
    const { width, height } = document.pages[0];
    const rect = { x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON: () => ({}) };
    await act(async () => root.render(createElement(MainWindow, { initialDocument: document,
      initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden", nativePalette: true,
      initialRulersVisible: false, initialCrosshairsVisible: false, shortcutPlatform: platform })));
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => rect;
    return rect;
  }
  const spinOverlay = () => container.querySelector<SVGSVGElement>("[data-spin3d-overlay]");
  const spinStatus = () => container.querySelector("[data-status-message]")?.textContent;

  it.each(["macos", "windows"] as const)("S2: Spin 3D accepts a marquee of a molecule and its own +, and the + follows N (%s)", async platform => {
    const { document: fixture, nitrogen } = electronMarkDropFixture();
    const drawing = workflow.selectDocumentObjects(fixture, fixture.pages[0].id, []);
    const molecule = dropMolecule(drawing), mark = dropMark(drawing);
    const rect = await mountSpinnable(drawing, platform);
    const captures = new Map<number, Element>();
    const saved = { set: Element.prototype.setPointerCapture, release: Element.prototype.releasePointerCapture,
      has: Element.prototype.hasPointerCapture };
    Element.prototype.setPointerCapture = function (id: number) { captures.set(id, this); };
    Element.prototype.releasePointerCapture = function (id: number) { captures.delete(id); };
    Element.prototype.hasPointerCapture = function (id: number) { return captures.get(id) === this; };
    try {
      const marquee = async (type: string, x: number, y: number) => act(async () => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
          buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y });
        Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
        (captures.get(1) ?? container.querySelector(".page")!).dispatchEvent(event);
        if (type === "pointerup") captures.delete(1);
      });
      // Real drag on empty canvas around the whole drawing: the marquee takes the molecule and its +.
      await marquee("pointerdown", 110, 190);
      await marquee("pointermove", 200, 250);
      await marquee("pointermove", 330, 310);
      await marquee("pointerup", 330, 310);
    } finally {
      Element.prototype.setPointerCapture = saved.set;
      Element.prototype.releasePointerCapture = saved.release;
      Element.prototype.hasPointerCapture = saved.has;
    }
    const selected = window.__CHEMDRAFT_AGENT__!.snapshot();
    expect([...selected.document.selection.objectIds].sort()).toEqual([molecule.id, mark.id].sort());
    expect(selected.selectedNativeMoleculePart).toBeUndefined();
    const before = selected.document;
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "structure.spin3d" } })));
    await vi.waitFor(() => expect(spinOverlay()).toBeTruthy());
    expect(spinStatus()).not.toBe("Select a single molecule to spin in 3D");
    // The + rides with N in the live overlay, and flatten commits it exactly there.
    const live = spinOverlay()!.querySelector(`[data-spin3d-electron-mark="${mark.id}"]`);
    expect(live).not.toBeNull();
    const [dx, dy] = live!.getAttribute("data-spin3d-mark-offset")!.split(" ").map(Number);
    const svg = spinOverlay()!;
    svg.getBoundingClientRect = () => rect;
    await act(async () => {
      const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 20, clientY: 20 });
      Object.defineProperties(down, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
      svg.dispatchEvent(down);
    });
    await vi.waitFor(() => expect(spinOverlay()).toBeNull());
    const after = window.__CHEMDRAFT_AGENT__!.snapshot().document;
    expect(after).not.toEqual(before);
    const flattened = dropMark(after);
    expect(flattened.anchor).toMatchObject({ kind: "atom", objectId: molecule.id, atomId: nitrogen.id });
    expect(flattened.x - mark.x).toBeCloseTo(dx, 6);
    expect(flattened.y - mark.y).toBeCloseTo(dy, 6);
    expect(dropMolecule(after).atoms.find(atom => atom.id === nitrogen.id)).toMatchObject({ formalCharge: 1 });
  });

  it.each(["macos", "windows"] as const)("S3: Spin 3D names a selected mark the molecule cannot carry instead of dropping it (%s)", async platform => {
    const { document: fixture } = electronMarkDropFixture();
    const molecule = dropMolecule(fixture), mark = dropMark(fixture);
    // The + left floating far from every atom (an explicit point drop), selected with the molecule.
    const floating = workflow.normalizeCommittedDocument(applyPatch(fixture, { op: "updateObject", objectId: mark.id,
      changes: { anchor: { kind: "point", point: { x: 600, y: 500 } }, atomAssociation: "explicit",
        x: 600 - mark.width / 2, y: 500 - mark.height / 2 } }, { now: phase4Timestamp }));
    const drawing = workflow.selectDocumentObjects(floating, floating.pages[0].id, [molecule.id, mark.id]);
    await mountSpinnable(drawing, platform);
    const before = window.__CHEMDRAFT_AGENT__!.snapshot().document;
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "structure.spin3d" } })));
    expect(spinStatus()).toBe(workflow.uncarriedMarksRefusal("Spin 3D", 1));
    expect(spinOverlay()).toBeNull();
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().document).toEqual(before);
  });
});
