import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, MoleculeBond, MoleculeObject } from "@chemdraft/chem-core";
import { insertSmilesMolecule, moleculeSmiles } from "@chemdraft/document-workflow-core";
import { renderedDoubleBondSide, ringInteriorDoubleBondSides } from "@chemdraft/layout-engine";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import {
  applyNativeMoleculeBondOrderValueTarget, cleanUpSelectedNativeMolecule2d, createPhase4Document,
  getSelectedMolecule, type NativeBondOrderTarget
} from "./documentWorkflow";
import {
  cycleNativeDoubleBondPosition, doubleBondCycleOrder, doubleBondGestureCycle, isDoubleBondCycleTarget,
  nextDoubleBondCyclePosition
} from "./doubleBondCycle";
import { MemoryStorage } from "./testSupport/memoryStorage";

beforeAll(() => installNodeRdkitModuleLoader());
beforeEach(() => vi.stubGlobal("localStorage", new MemoryStorage()));
afterEach(() => vi.unstubAllGlobals());

const molecule = (document: ChemDraftDocument): MoleculeObject => getSelectedMolecule(document)!;
const bondTarget = (graph: MoleculeObject, bond: MoleculeBond): NativeBondOrderTarget => ({
  objectId: graph.id, kind: "bond", bondId: bond.id,
  fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId, distanceToPointer: 0
});
const doubleBond = (graph: MoleculeObject) => graph.bonds.find(bond => bond.order === "double")!;
const canonical = (graph: MoleculeObject) => moleculeSmiles(graph, 0, [], computeStructureIdentifiers);
const shown = (document: ChemDraftDocument) => {
  const graph = molecule(document);
  return renderedDoubleBondSide(graph, doubleBond(graph));
};

/** trans-but-2-ene: an acyclic double bond with an offset default. */
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

/** Cyclohexene: a ring double bond whose default stroke sits inside the ring. */
function cyclohexene(): ChemDraftDocument {
  const atoms = Array.from({ length: 6 }, (_, index) => ({
    element: "C", x: Math.cos(index * Math.PI / 3), y: Math.sin(index * Math.PI / 3), charge: 0
  }));
  const bonds = atoms.map((_, index) => ({
    from: index, to: (index + 1) % 6, order: index === 0 ? "double" : "single", wedge: null
  }));
  return insertSmilesMolecule(createPhase4Document("Ring"), { x: 300, y: 300 }, { atoms, bonds } as never, "C1=CCCCC1");
}

/** Press 2 on the hovered double bond (or click it with the Double Bond tool) once. */
function press(document: ChemDraftDocument, order: MoleculeBond["order"] = "double", stereo?: "either") {
  const graph = molecule(document);
  return doubleBondGestureCycle(document, bondTarget(graph, doubleBond(graph)), order, stereo);
}

async function expectSameChemistry(before: ChemDraftDocument, after: ChemDraftDocument) {
  const a = molecule(before), b = molecule(after);
  expect(b.atoms).toEqual(a.atoms);
  expect(b.bonds.map(({ display: _display, ...bond }) => bond)).toEqual(a.bonds.map(({ display: _display, ...bond }) => bond));
  expect(b.structure).toBe(a.structure);
  expect(await canonical(b)).toBe(await canonical(a));
}

describe("double-bond position cycle", () => {
  it("steps left -> center -> right -> left", () => {
    expect(doubleBondCycleOrder).toEqual(["left", "center", "right"]);
    expect(nextDoubleBondCyclePosition("left")).toBe("center");
    expect(nextDoubleBondCyclePosition("center")).toBe("right");
    expect(nextDoubleBondCyclePosition("right")).toBe("left");
  });

  it("hover 2 on an acyclic double cycles from the drawn side, one labelled step each, chemistry intact", async () => {
    let document = butene();
    const start = shown(document)!;
    expect(["left", "center", "right"]).toContain(start);
    const seen: string[] = [];
    for (let step = 0; step < 4; step += 1) {
      const before = document;
      const result = press(before)!;
      expect(result).toBeDefined();
      expect(result.undoLabel).toBe(`Double-bond position: ${result.position}`);
      expect(doubleBond(molecule(result.document)).display?.doubleBondSide).toBe(result.position);
      expect(shown(result.document)).toBe(result.position);
      await expectSameChemistry(before, result.document);
      seen.push(result.position);
      document = result.document;
    }
    let expected = start as "left" | "center" | "right";
    expect(seen).toEqual(seen.map(() => (expected = nextDoubleBondCyclePosition(expected))));
    expect(seen[3]).toBe(seen[0]);
  });

  it("a Double Bond tool click cycles the same way, and the E/Z-unspecified tool keeps its own behaviour", () => {
    const document = butene();
    const graph = molecule(document);
    const target = bondTarget(graph, doubleBond(graph));
    const click = doubleBondGestureCycle(document, target, "double")!;
    expect(click.document).toEqual(press(document)!.document);
    expect(doubleBondGestureCycle(document, target, "double", "either")).toBeUndefined();
    expect(doubleBondGestureCycle(document, target, "triple")).toBeUndefined();
  });

  it("undo restores the previous side: each step leaves its input document untouched", () => {
    const document = butene();
    const original = JSON.stringify(document);
    const first = press(document)!;
    const second = press(first.document)!;
    expect(JSON.stringify(document)).toBe(original);
    expect(doubleBond(molecule(first.document)).display?.doubleBondSide).toBe(first.position);
    expect(shown(document)).not.toBe(first.position);
    expect(second.position).toBe(nextDoubleBondCyclePosition(first.position));
  });

  it("keeps a ring bond valid: offsets are user choices that survive Clean Up, center stays center", async () => {
    let document = cyclohexene();
    const ring = molecule(document);
    const bondId = doubleBond(ring).id;
    const inside = ringInteriorDoubleBondSides(ring).get(bondId)!;
    expect(shown(document)).toBe(inside);
    for (let step = 0; step < 3; step += 1) {
      const result = press(document)!;
      const bond = doubleBond(molecule(result.document));
      await expectSameChemistry(document, result.document);
      expect(bond.display?.doubleBondSideSource).toBe(result.position === "center" ? undefined : "user");
      const insideNow = ringInteriorDoubleBondSides(molecule(result.document)).get(bondId);
      const cleaned = cleanUpSelectedNativeMolecule2d(result.document);
      const cleanedGraph = molecule(cleaned);
      const cleanedBond = cleanedGraph.bonds.find(candidate => candidate.id === bondId)!;
      expect(cleanedBond.order).toBe("double");
      const cleanedShown = renderedDoubleBondSide(cleanedGraph, cleanedBond);
      if (result.position === "center") expect(cleanedShown).toBe("center");
      else {
        // Inside stays inside; an authored outside offset stays outside after the redraw.
        const wasInside = result.position === insideNow;
        expect(cleanedShown === ringInteriorDoubleBondSides(cleanedGraph).get(bondId)).toBe(wasInside);
      }
      document = result.document;
    }
    expect(shown(document)).toBe(inside);
  });

  it("2 on a single bond still makes it double, and leaves crossed doubles to the existing path", () => {
    const document = butene();
    const graph = molecule(document);
    const single = graph.bonds.find(bond => bond.order === "single")!;
    expect(isDoubleBondCycleTarget(document, bondTarget(graph, single))).toBe(false);
    expect(doubleBondGestureCycle(document, bondTarget(graph, single), "double")).toBeUndefined();
    const doubled = applyNativeMoleculeBondOrderValueTarget(document, bondTarget(graph, single), "double");
    expect(molecule(doubled).bonds.find(bond => bond.id === single.id)?.order).toBe("double");

    const target = bondTarget(graph, doubleBond(graph));
    const crossed = applyNativeMoleculeBondOrderValueTarget(document, target, "double", "either");
    expect(doubleBond(molecule(crossed)).stereo).toBe("either");
    expect(cycleNativeDoubleBondPosition(crossed, target)).toBeUndefined();
  });
});
