import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { applyPatch, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { planMoleculeAtomLabels } from "@chemdraft/layout-engine";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles } from "@chemdraft/document-workflow-core";
import { describe, expect, it } from "vitest";

import { MainWindow } from "./MainWindow";
import { applyChargeToolAtNativeAtom, createPhase4Document, normalizeCommittedDocument } from "./documentWorkflow";

function glycine(charged: boolean): ChemDraftDocument {
  const graph = testMoleculeFromSmiles("NCC(=O)O");
  const points = [[200, 200], [222, 200], [241, 211], [241, 233], [263, 200]];
  const atoms = graph.atoms.map((atom, index) => ({ ...atom, x: points[index][0], y: points[index][1] }));
  const molecule: MoleculeObject = {
    id: "glycine", type: "molecule", x: 180, y: 180, width: 100, height: 70, rotation: 0,
    style: { atomLabelHideImplicitHydrogens: false }, atoms, bonds: graph.bonds,
    structureFormat: "smiles", structure: nativeSingleBondGraphSmiles(atoms, graph.bonds),
    chemistry: nativeSingleBondGraphMetadata(atoms, graph.bonds), superatoms: [], rGroups: []
  };
  let drawing = applyPatch(createPhase4Document("Glycine selection halo"), {
    op: "addObject", pageId: "page_001", object: molecule
  });
  if (charged) {
    drawing = applyChargeToolAtNativeAtom(drawing, 1, {
      kind: "atom", objectId: molecule.id, atomId: atoms[0].id, distanceToPointer: 0
    });
    const mark = drawing.pages[0].objects.find(object => object.type === "electron-mark")!;
    drawing = normalizeCommittedDocument(applyPatch(drawing, {
      op: "updateObject", objectId: mark.id,
      changes: { x: 100, y: 100, atomAssociation: "explicit",
        anchor: { kind: "atom", objectId: molecule.id, atomId: atoms[0].id } }
    }));
  }
  return applyPatch(drawing, { op: "setSelection", pageId: "page_001", objectIds: [molecule.id] });
}

function render(drawing: ChemDraftDocument) {
  return new JSDOM(renderToStaticMarkup(createElement(MainWindow, {
    initialDocument: drawing, initialPaletteMode: "hidden", nativePalette: true
  })));
}

describe("selected atom label halos", () => {
  it.each([true, false])("covers the entire left-side nitrogen label (distant attached charge: %s)", charged => {
    const drawing = glycine(charged);
    const before = structuredClone(drawing);
    const molecule = drawing.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    const plans = planMoleculeAtomLabels(molecule);
    const nitrogen = plans.find(plan => plan.atom.element === "N")!;
    expect(nitrogen.label).toBe(charged ? "H3N" : "H2N");
    // Both labels extend left of the old fixed-radius (8.8) atom circle.
    expect(nitrogen.anchor.x + nitrogen.layout.bounds.x).toBeLessThan(nitrogen.atom.x - 8.8);
    expect(nitrogen.atom.formalCharge).toBe(charged ? 1 : 0);
    if (charged) {
      expect(drawing.pages[0].objects.find(object => object.type === "electron-mark")).toMatchObject({
        x: 100, y: 100, atomAssociation: "explicit",
        anchor: { kind: "atom", objectId: molecule.id, atomId: nitrogen.atom.id }
      });
      expect(nitrogen.atom.markCharge).toBe(1);
    }

    const selected = render(drawing);
    const unselected = render(applyPatch(drawing, { op: "setSelection", pageId: "page_001", objectIds: [] }));
    try {
      const dom = selected.window.document;
      const blob = dom.querySelector('[data-selection-blob="true"]')!;
      // Use the renderer's shared layout for every label, including O and OH.
      for (const plan of plans) {
        const halo = blob.querySelector(`rect[data-selected-atom-label-id="${plan.atom.id}"]`);
        expect(halo, `missing halo box for ${plan.label}`).not.toBeNull();
        expect(Number(halo!.getAttribute("x"))).toBeCloseTo(plan.anchor.x + plan.layout.bounds.x - molecule.x);
        expect(Number(halo!.getAttribute("y"))).toBeCloseTo(plan.anchor.y + plan.layout.bounds.y - molecule.y);
        expect(Number(halo!.getAttribute("width"))).toBeCloseTo(plan.layout.bounds.width);
        expect(Number(halo!.getAttribute("height"))).toBeCloseTo(plan.layout.bounds.height);
      }
      expect(blob.querySelectorAll("[data-selected-atom-label-id]")).toHaveLength(plans.length);
      expect(unselected.window.document.querySelector("[data-selected-atom-label-id]")).toBeNull();
      // Selection must leave the painted label text, runs and placement unchanged.
      expect([...dom.querySelectorAll(".native-atom-label")].map(label => label.outerHTML)).toEqual(
        [...unselected.window.document.querySelectorAll(".native-atom-label")].map(label => label.outerHTML)
      );
      expect(drawing).toEqual(before);
    } finally {
      selected.window.close();
      unselected.window.close();
    }
  });
});
