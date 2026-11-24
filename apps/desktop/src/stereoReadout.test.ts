import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { createSmilesMolecule } from "@chemdraft/document-workflow-core";
import * as ocl from "@chemdraft/ocl-adapter";
import { buildObjectCanvasMenu } from "./canvasContextMenuModel";
import { popupNativeCanvasMenu } from "./nativeCanvasContextMenu";
import {
  loadStereoEngine, resetStereoEngineForTests, resolveStereoReadout, stereoReadoutLabel, stereoReadoutRequest,
  stereoReadoutTargetFromPart, type StereoEngine
} from "./stereoReadout";

const tauriInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriInvoke }));

const engine: StereoEngine = ocl;

function molecule(smiles: string): MoleculeObject {
  return createSmilesMolecule(createEmptyDocument(), { x: 300, y: 250 }, ocl.depictSmiles2D(smiles), smiles);
}
const mirrored = (source: MoleculeObject): MoleculeObject =>
  ({ ...source, atoms: source.atoms.map(atom => ({ ...atom, x: 600 - atom.x })) });
const doubleBond = (source: MoleculeObject) => source.bonds.find(bond => bond.order === "double")!;

// Expected descriptors were checked with `pnpm -s chemdraft stereo --smiles ...` (2026-11-24):
// [C@H] ibuprofen → atom 10 S, [C@@H] → R, unwedged → unspecified; C/C=C/C → E, C/C=C\C → Z.
const S_IBUPROFEN = "CC(C)Cc1ccc(cc1)[C@H](C)C(=O)O";
const R_IBUPROFEN = "CC(C)Cc1ccc(cc1)[C@@H](C)C(=O)O";
const STEREOCENTRE_INDEX = 10;

describe("stereo readout from the existing OCL perceiver", () => {
  it("reads R/S from a drawn wedge, and the opposite from its mirror image", () => {
    const s = molecule(S_IBUPROFEN);
    const centre = s.atoms[STEREOCENTRE_INDEX]!;
    expect(centre.element).toBe("C");
    expect(s.bonds.some(bond => (bond.fromAtomId === centre.id || bond.toAtomId === centre.id) &&
      (bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed"))).toBe(true);
    expect(stereoReadoutLabel({ molecule: s, atomId: centre.id }, engine)).toBe("Stereocentre: S");
    expect(stereoReadoutLabel({ molecule: mirrored(s), atomId: centre.id }, engine)).toBe("Stereocentre: R");
    const r = molecule(R_IBUPROFEN);
    expect(stereoReadoutLabel({ molecule: r, atomId: r.atoms[STEREOCENTRE_INDEX]!.id }, engine)).toBe("Stereocentre: R");
  });

  it("shows nothing for a non-stereogenic atom or an undrawn stereocentre", () => {
    const s = molecule(S_IBUPROFEN);
    expect(stereoReadoutLabel({ molecule: s, atomId: s.atoms[0]!.id }, engine)).toBeUndefined();
    const racemic = molecule("CC(C)Cc1ccc(cc1)C(C)C(=O)O");
    expect(engine.perceiveStereoCentersFromMolfile).toBeDefined();
    expect(stereoReadoutLabel({ molecule: racemic, atomId: racemic.atoms[STEREOCENTRE_INDEX]!.id }, engine)).toBeUndefined();
    expect(stereoReadoutLabel({ molecule: s, atomId: "missing" }, engine)).toBeUndefined();
  });

  it("reads E/Z on a defined double bond and nothing on an unspecified or non-double bond", () => {
    const e = molecule("C/C=C/C"), z = molecule("C/C=C\\C");
    expect(stereoReadoutLabel({ molecule: e, bondId: doubleBond(e).id }, engine)).toBe("Double bond: E");
    expect(stereoReadoutLabel({ molecule: z, bondId: doubleBond(z).id }, engine)).toBe("Double bond: Z");
    const either = { ...e, bonds: e.bonds.map(bond => bond.order === "double" ? { ...bond, stereo: "either" as const } : bond) };
    expect(stereoReadoutLabel({ molecule: either, bondId: doubleBond(either).id }, engine)).toBeUndefined();
    const terminal = molecule("C=CC");
    expect(stereoReadoutLabel({ molecule: terminal, bondId: doubleBond(terminal).id }, engine)).toBeUndefined();
    expect(stereoReadoutLabel({ molecule: e, bondId: e.bonds.find(bond => bond.order === "single")!.id }, engine)).toBeUndefined();
  });

  it("shows nothing when the engine throws, and never recomputes CIP itself", () => {
    const s = molecule(S_IBUPROFEN);
    const failing: StereoEngine = {
      perceiveStereoCentersFromMolfile: () => { throw new Error("engine down"); },
      perceiveDoubleBondStereoFromMolfile: () => { throw new Error("engine down"); }
    };
    expect(stereoReadoutLabel({ molecule: s, atomId: s.atoms[STEREOCENTRE_INDEX]!.id }, failing)).toBeUndefined();
    const fixed: StereoEngine = {
      perceiveStereoCentersFromMolfile: vi.fn(() => s.atoms.map(() => ({ isStereoCenter: true, descriptor: "R" as const }))),
      perceiveDoubleBondStereoFromMolfile: vi.fn(() => [])
    };
    // Whatever the engine says is what the row says: the label is the engine's descriptor.
    expect(stereoReadoutLabel({ molecule: s, atomId: s.atoms[STEREOCENTRE_INDEX]!.id }, fixed)).toBe("Stereocentre: R");
    expect(fixed.perceiveStereoCentersFromMolfile).toHaveBeenCalledOnce();
  });
});

describe("lazy engine loading", () => {
  afterEach(() => resetStereoEngineForTests());

  it("loads the engine once and resolves the label", async () => {
    const s = molecule(S_IBUPROFEN);
    const importer = vi.fn(async () => engine);
    const load = () => loadStereoEngine(importer);
    const request = stereoReadoutRequest(s, { kind: "atom", atomId: s.atoms[STEREOCENTRE_INDEX]!.id }, load)!;
    expect(await request()).toBe("Stereocentre: S");
    expect(await request()).toBe("Stereocentre: S");
    expect(importer).toHaveBeenCalledOnce();
  });

  it("resolves undefined when the engine is unavailable, and retries the load next time", async () => {
    const s = molecule(S_IBUPROFEN);
    const target = { molecule: s, atomId: s.atoms[STEREOCENTRE_INDEX]!.id };
    const importer = vi.fn().mockRejectedValueOnce(new Error("chunk failed")).mockResolvedValue(engine);
    await expect(resolveStereoReadout(target, () => loadStereoEngine(importer))).resolves.toBeUndefined();
    await expect(resolveStereoReadout(target, () => loadStereoEngine(importer))).resolves.toBe("Stereocentre: S");
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("the default loader imports the real adapter", async () => {
    const loaded = await loadStereoEngine();
    expect(loaded.perceiveStereoCentersFromMolfile).toBe(ocl.perceiveStereoCentersFromMolfile);
  });

  it("only atoms and bonds carry a readout target", () => {
    const s = molecule(S_IBUPROFEN);
    expect(stereoReadoutTargetFromPart(s, { kind: "ring" })).toBeUndefined();
    expect(stereoReadoutTargetFromPart(undefined, { kind: "atom", atomId: "a" })).toBeUndefined();
    expect(stereoReadoutRequest(s, { kind: "parts" })).toBeUndefined();
    expect(stereoReadoutTargetFromPart(s, { kind: "bond", bondId: "b" })).toEqual({ molecule: s, bondId: "b" });
  });
});

// One Tauri command serves both macOS and Windows (canvas_context_menu.rs has no platform branch).
describe("native canvas menu path (macOS and Windows)", () => {
  afterEach(() => { tauriInvoke.mockReset(); vi.useRealTimers(); });
  const items = buildObjectCanvasMenu({ objectIndex: 0, objectCount: 1, targetKind: "atom" });

  it("puts the readout first as a disabled, unroutable item", async () => {
    tauriInvoke.mockResolvedValue("canvas-context:any:0");
    const result = await popupNativeCanvasMenu(items, { x: 1, y: 2 }, { loadStereoReadout: async () => "Stereocentre: R" });
    const [, args] = tauriInvoke.mock.calls[0]!;
    const sent = (args as { items: Array<Record<string, unknown>> }).items;
    expect(sent[0]).toMatchObject({ kind: "item", label: "Stereocentre: R", enabled: false });
    expect(sent[1]).toEqual({ kind: "separator" });
    expect(sent[2]).toMatchObject({ label: "Cut" });
    // Selecting the readout row (were the OS to report it) invokes nothing.
    const invoke = vi.fn();
    expect(result!.select(invoke)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("omits the row when the readout is undefined or rejects", async () => {
    tauriInvoke.mockResolvedValue(null);
    await popupNativeCanvasMenu(items, { x: 1, y: 2 }, { loadStereoReadout: async () => undefined });
    await popupNativeCanvasMenu(items, { x: 1, y: 2 }, { loadStereoReadout: () => Promise.reject(new Error("x")) });
    for (const [, args] of tauriInvoke.mock.calls) {
      expect((args as { items: Array<{ label?: string }> }).items[0]!.label).toBe("Cut");
    }
  });

  it("opens without the row rather than waiting on a slow engine load", async () => {
    vi.useFakeTimers();
    tauriInvoke.mockResolvedValue(null);
    const pending = popupNativeCanvasMenu(items, { x: 1, y: 2 }, {
      loadStereoReadout: () => new Promise(() => {}), stereoReadoutBudgetMs: 50
    });
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    expect((tauriInvoke.mock.calls[0]![1] as { items: Array<{ label?: string }> }).items[0]!.label).toBe("Cut");
  });
});
