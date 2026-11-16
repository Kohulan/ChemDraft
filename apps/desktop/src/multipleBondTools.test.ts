import { nativeAtomValidationState } from "@chemdraft/document-workflow-core";
import { describe, expect, it } from "vitest";
import { Molecule } from "openchemlib";
import { exportDocumentToCdxml, openChemDraftPayload } from "@chemdraft/cdx-compat";
import { moleculeToMolfileV2000, type MoleculeObject } from "@chemdraft/chem-core";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { perceiveDoubleBondStereoFromMolfile } from "@chemdraft/ocl-adapter";
import { bondDrawingToolCommandId } from "./commands";
import { applyMoleculeBondStereo, nativeBondStereoForToolCommand } from "./documentWorkflow";
import {
  applyFreeformSingleBondToolAtPoint, applyNativeMoleculeBondOrderTarget, applyNativeMoleculeBondOrderValueTarget, applySingleBondToolAtPoint,
  createPhase4Document, getSelectedMolecule, nativeBondOrderForToolCommand, nativeBondOrderTargetRefusal,
  nativeBondStyleForToolCommand, createNativeSavePayload, openNativeDocument, type NativeBondOrderTarget
} from "./documentWorkflow";

/** A full bond-order target for `bond`, with the endpoints and pointer distance the type requires. */
function bondTarget(
  objectId: string, bond: { id: string; fromAtomId: string; toAtomId: string }
): NativeBondOrderTarget {
  return { objectId, kind: "bond", bondId: bond.id, fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId, distanceToPointer: 0 };
}

describe("either double-bond drawing", () => {
  const id = bondDrawingToolCommandId("double", "either");
  const options = { bondOrder: nativeBondOrderForToolCommand(id), bondStereo: nativeBondStereoForToolCommand(id) };
  const canonical = (molecule: MoleculeObject) => Molecule.fromMolfile(moleculeToMolfileV2000(molecule, { fromDocFrame: true, kekuleBondOrders: new Map() }).contents).toIsomericSmiles();

  it("inserts an explicit either double bond with no E/Z, and reopens it", () => {
    expect(options).toEqual({ bondOrder: "double", bondStereo: "either" });
    expect(nativeBondStyleForToolCommand(id)).toBe("solid");
    const document = applySingleBondToolAtPoint(createPhase4Document(), { x: 300, y: 300 }, options);
    const molecule = getSelectedMolecule(document)!;
    expect(molecule.bonds).toHaveLength(1);
    expect(molecule.bonds[0]).toMatchObject({ order: "double", stereo: "either" });
    expect(molecule.structureFormat).toBe("molfile-v2000");
    expect(parseMolfileGraph(molecule.structure).bonds[0]).toMatchObject({ order: "double", stereo: "either" });
    expect(canonical(molecule)).toBe(Molecule.fromSmiles("C=C").toIsomericSmiles());
    expect(openNativeDocument(createNativeSavePayload(document).contents).document).toEqual(document);
  });

  it.each(["click", "drag"])("grows an either bond by %s and exchanges substituted alkene without E/Z", mode => {
    const seed = applySingleBondToolAtPoint(createPhase4Document(), { x: 300, y: 300 });
    const original = getSelectedMolecule(seed)!;
    const source = original.atoms[1];
    const drawn = mode === "click" ? applySingleBondToolAtPoint(seed, source, options)
      : applyFreeformSingleBondToolAtPoint(seed, original.id, source.id, { x: source.x + 40, y: source.y }, options);
    const grown = getSelectedMolecule(drawn)!;
    expect(grown.bonds[0]).toEqual(original.bonds[0]);
    expect(grown.bonds[1]).toMatchObject({ order: "double", stereo: "either" });
    const tail = grown.atoms.at(-1)!;
    const document = applySingleBondToolAtPoint(drawn, tail);
    const molecule = getSelectedMolecule(document)!;
    expect(molecule.atoms).toHaveLength(4);
    expect(molecule.bonds).toHaveLength(3);
    expect(molecule.chemistry?.formula).toBe("C4H8");
    expect(canonical(molecule)).toBe(Molecule.fromSmiles("CC=CC").toIsomericSmiles());
    expect(canonical(molecule)).not.toMatch(/[\\/]/);
    // Match the representation produced by #229's selected-bond command.
    const geometry = applyNativeMoleculeBondOrderValueTarget(document, bondTarget(molecule.id, molecule.bonds[1]), "double");
    const viaCommand = applyMoleculeBondStereo(geometry, [bondTarget(molecule.id, molecule.bonds[1])], "either", perceiveDoubleBondStereoFromMolfile);
    expect(getSelectedMolecule(viaCommand)!.bonds).toEqual(molecule.bonds);
    expect(openNativeDocument(createNativeSavePayload(document).contents).document).toEqual(document);
    for (const embedNativePayload of [true, false]) {
      const exported = exportDocumentToCdxml(document, { embedNativePayload });
      expect(exported.contents).toContain('Display="Wavy"');
      const reopened = openChemDraftPayload(exported.contents).document!;
      const result = reopened.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
      expect(result.atoms).toHaveLength(4);
      expect(result.bonds).toHaveLength(3);
      expect(result.bonds.filter(bond => bond.stereo === "either")).toHaveLength(1);
      expect(canonical(result)).toBe(canonical(molecule));
    }
  });

  it("applies either to an existing double bond and ordinary Double clears it", () => {
    const seed = applySingleBondToolAtPoint(createPhase4Document(), { x: 300, y: 300 }, { bondOrder: "double" });
    const molecule = getSelectedMolecule(seed)!;
    const target = bondTarget(molecule.id, molecule.bonds[0]);
    const either = applyNativeMoleculeBondOrderValueTarget(seed, target, "double", "either");
    expect(getSelectedMolecule(either)!.bonds[0].stereo).toBe("either");
    expect(applyNativeMoleculeBondOrderValueTarget(either, target, "double", "either")).toBe(either);
    expect(getSelectedMolecule(applyNativeMoleculeBondOrderValueTarget(either, target, "double"))!.bonds[0]).not.toHaveProperty("stereo");
  });
});

/** A bond whose second atom takes three more single substituents, so it ends with four bonds (full carbon). */
function branchedSeed() {
  let document = applySingleBondToolAtPoint(createPhase4Document("Branched"), { x: 300, y: 300 });
  const first = getSelectedMolecule(document)!;
  const center = first.atoms[1];
  for (const degrees of [-60, 60, 180]) {
    const radians = degrees * Math.PI / 180;
    document = applyFreeformSingleBondToolAtPoint(document, first.id, center.id, {
      x: center.x + Math.cos(radians) * 40, y: center.y + Math.sin(radians) * 40
    });
  }
  return { document, objectId: first.id, centerId: center.id };
}

/** A bond whose second atom (a typed, literal carbon) takes `extra` more single substituents. */
function literalCenterSeed(extra: number) {
  let document = applySingleBondToolAtPoint(createPhase4Document("Literal"), { x: 300, y: 300 });
  const first = getSelectedMolecule(document)!;
  const center = first.atoms[1];
  for (const degrees of [-60, 60].slice(0, extra)) {
    const radians = degrees * Math.PI / 180;
    document = applyFreeformSingleBondToolAtPoint(document, first.id, center.id, {
      x: center.x + Math.cos(radians) * 40, y: center.y + Math.sin(radians) * 40
    });
  }
  return {
    document: {
      ...document,
      pages: document.pages.map(page => ({
        ...page,
        objects: page.objects.map(object => object.id === first.id && object.type === "molecule"
          ? { ...object, atoms: object.atoms.map(atom => atom.id === center.id ? { ...atom, labelLiteral: true as const } : atom) }
          : object)
      }))
    },
    objectId: first.id,
    centerId: center.id
  };
}

describe.each(["double", "triple"] as const)("%s bond drawing", order => {
  it("maps the tool and inserts the requested chemistry", () => {
    expect(nativeBondOrderForToolCommand(`tool.${order}Bond`)).toBe(order);
    expect(nativeBondStyleForToolCommand(`tool.${order}Bond`)).toBe("solid");
    const document = applySingleBondToolAtPoint(createPhase4Document("Multiple bond"), { x: 300, y: 300 }, { bondOrder: order });
    const molecule = getSelectedMolecule(document)!;
    expect(molecule.bonds).toHaveLength(1);
    expect(molecule.bonds[0].order).toBe(order);
    expect(molecule.structure).toBe(order === "double" ? "C=C" : "C#C");
    expect(openNativeDocument(createNativeSavePayload(document).contents).document).toEqual(document);
  });
  it("grows the requested order from an atom without changing the old bond", () => {
    const document = applySingleBondToolAtPoint(createPhase4Document("Growth"), { x: 300, y: 300 });
    const before = getSelectedMolecule(document)!;
    const atom = before.atoms[1];
    const next = applyFreeformSingleBondToolAtPoint(document, before.id, atom.id, { x: atom.x + 40, y: atom.y }, { bondOrder: order });
    const after = getSelectedMolecule(next)!;
    expect(after.bonds[0]).toEqual(before.bonds[0]);
    expect(after.atoms.slice(0, 2)).toEqual(before.atoms);
    expect(after.bonds[1].order).toBe(order);
  });
  it("allows growth past carbon valence and diagnoses the edited atom", () => {
    const document = applySingleBondToolAtPoint(createPhase4Document("Valence"), { x: 300, y: 300 }, { bondOrder: "triple" });
    const molecule = getSelectedMolecule(document)!;
    const atom = molecule.atoms[1];
    const results = [
      applyFreeformSingleBondToolAtPoint(document, molecule.id, atom.id, { x: atom.x + 40, y: atom.y }, { bondOrder: order }),
      applySingleBondToolAtPoint(document, atom, { bondOrder: order })
    ];
    for (const next of results) {
      expect(next).not.toBe(document);
      const after = getSelectedMolecule(next)!;
      expect(after.atoms).toHaveLength(3);
      expect(after.bonds.map(bond => bond.order)).toEqual(["triple", order]);
      expect(nativeAtomValidationState(after.atoms.find(candidate => candidate.id === atom.id)!, after.bonds, 0, after.atoms))
        .toMatchObject({ valid: false, valenceUsed: order === "double" ? 5 : 6 });
    }
  });
});

describe("multiple bond tool warnings and format guards", () => {
  it("stores the substituent-facing double bond side on a drawn chain, as order cycling does", () => {
    const single = applySingleBondToolAtPoint(createPhase4Document("Side"), { x: 300, y: 300 });
    const base = getSelectedMolecule(single)!;
    const atom = base.atoms[1];
    const point = { x: atom.x + 30, y: atom.y + 20 };
    const drawn = getSelectedMolecule(applyFreeformSingleBondToolAtPoint(single, base.id, atom.id, point, { bondOrder: "double" }))!;
    const asSingle = applyFreeformSingleBondToolAtPoint(single, base.id, atom.id, point);
    const singleMolecule = getSelectedMolecule(asSingle)!;
    const cycled = getSelectedMolecule(applyNativeMoleculeBondOrderValueTarget(
      asSingle, bondTarget(base.id, singleMolecule.bonds[1]), "double"))!;
    expect(drawn.structure).toBe("CC=C");
    expect(drawn.bonds[1].display?.doubleBondSide).toBeDefined();
    expect(drawn.bonds[1].display?.doubleBondSide).toBe(cycled.bonds[1].display?.doubleBondSide);
  });

  it("grows a multiple bond from a full-valence atom with a warning and no refusal", () => {
    const { document, objectId, centerId } = branchedSeed();
    const molecule = getSelectedMolecule(document)!;
    const center = molecule.atoms.find(atom => atom.id === centerId)!;
    const reasons: string[] = [];
    const next = applyFreeformSingleBondToolAtPoint(document, objectId, centerId, { x: center.x - 40, y: center.y + 5 }, {
      bondOrder: "double", onRefusal: reason => reasons.push(reason)
    });
    expect(next).not.toBe(document);
    const after = getSelectedMolecule(next)!;
    expect(after.atoms).toHaveLength(molecule.atoms.length + 1);
    expect(after.bonds.at(-1)?.order).toBe("double");
    expect(nativeAtomValidationState(center, after.bonds, 0, after.atoms)).toMatchObject({ valid: false, valenceUsed: 6 });
    expect(reasons).toEqual([]);
  });

  it("connects two existing atoms past valence with a warning and no refusal", () => {
    const { document, objectId, centerId } = branchedSeed();
    const molecule = getSelectedMolecule(document)!;
    const center = molecule.atoms.find(atom => atom.id === centerId)!;
    // A tail hangs off the first atom; closing it onto the full centre lands and warns.
    const origin = molecule.atoms[0];
    const withTail = applyFreeformSingleBondToolAtPoint(document, objectId, origin.id, { x: origin.x - 40, y: origin.y });
    const tail = getSelectedMolecule(withTail)!.atoms.at(-1)!;
    const reasons: string[] = [];
    const next = applyFreeformSingleBondToolAtPoint(withTail, objectId, tail.id, { x: center.x, y: center.y }, {
      bondOrder: "double", onRefusal: reason => reasons.push(reason)
    });
    expect(next).not.toBe(withTail);
    const after = getSelectedMolecule(next)!;
    expect(after.atoms).toEqual(getSelectedMolecule(withTail)!.atoms);
    expect(after.bonds.at(-1)).toMatchObject({ fromAtomId: tail.id, toAtomId: centerId, order: "double" });
    expect(nativeAtomValidationState(center, after.bonds, 0, after.atoms)).toMatchObject({ valid: false, valenceUsed: 6 });
    expect(reasons).toEqual([]);
  });

  it("raises a bond at a full-valence atom and diagnoses the result", () => {
    const { document, objectId, centerId } = branchedSeed();
    const molecule = getSelectedMolecule(document)!;
    const bond = molecule.bonds.find(candidate => candidate.fromAtomId === centerId || candidate.toAtomId === centerId)!;
    const target = bondTarget(objectId, bond);
    const next = applyNativeMoleculeBondOrderValueTarget(document, target, "double");
    expect(next).not.toBe(document);
    const after = getSelectedMolecule(next)!;
    expect(after.bonds.find(candidate => candidate.id === bond.id)?.order).toBe("double");
    expect(nativeAtomValidationState(after.atoms.find(atom => atom.id === centerId)!, after.bonds, 0, after.atoms))
      .toMatchObject({ valid: false, valenceUsed: 5 });
    expect(nativeBondOrderTargetRefusal(document, target, "double")).toBeUndefined();
  });

  it("tells an unchanged bond from a refused one, and refuses a dashed (dative) bond like order cycling", () => {
    const single = applySingleBondToolAtPoint(createPhase4Document("Same"), { x: 300, y: 300 });
    const molecule = getSelectedMolecule(single)!;
    const target = bondTarget(molecule.id, molecule.bonds[0]);
    expect(nativeBondOrderTargetRefusal(single, target, "single")).toBe("Bond is already single");
    expect(nativeBondOrderTargetRefusal(single, target, "double")).toBeUndefined();

    const dashed = applySingleBondToolAtPoint(createPhase4Document("Dative"), { x: 300, y: 300 }, { bondStyle: "dashed" });
    const dative = getSelectedMolecule(dashed)!;
    const dashedTarget = bondTarget(dative.id, dative.bonds[0]);
    expect(applyNativeMoleculeBondOrderValueTarget(dashed, dashedTarget, "double")).toBe(dashed);
    expect(nativeBondOrderTargetRefusal(dashed, dashedTarget, "double")).toMatch(/dashed \(dative\) bond stays single/);
  });

  it("grows multiple bonds past valence at a hypovalent literal atom and keeps its warning", () => {
    // A typed C with three single bonds is already flagged (3 of 4), but a double bond would make it five.
    const { document, objectId, centerId } = literalCenterSeed(2);
    const molecule = getSelectedMolecule(document)!;
    const center = molecule.atoms.find(atom => atom.id === centerId)!;
    expect(molecule.bonds).toHaveLength(3);
    expect(nativeAtomValidationState(center, molecule.bonds, 0, molecule.atoms).valid).toBe(false);
    for (const bondOrder of ["double", "triple"] as const) {
      const reasons: string[] = [];
      const next = applyFreeformSingleBondToolAtPoint(document, objectId, centerId, { x: center.x - 40, y: center.y + 5 }, {
        bondOrder, onRefusal: reason => reasons.push(reason)
      });
      expect(next).not.toBe(document);
      const after = getSelectedMolecule(next)!;
      expect(after.bonds).toHaveLength(4);
      expect(after.bonds.at(-1)?.order).toBe(bondOrder);
      expect(nativeAtomValidationState(center, after.bonds, 0, after.atoms))
        .toMatchObject({ valid: false, valenceUsed: bondOrder === "double" ? 5 : 6 });
      expect(reasons).toEqual([]);
    }
  });

  it("still lets a hypovalent literal atom take a double bond that fills its valence", () => {
    const { document, objectId, centerId } = literalCenterSeed(1);
    const center = getSelectedMolecule(document)!.atoms.find(atom => atom.id === centerId)!;
    const reasons: string[] = [];
    const next = applyFreeformSingleBondToolAtPoint(document, objectId, centerId, { x: center.x - 40, y: center.y + 5 }, {
      bondOrder: "double", onRefusal: reason => reasons.push(reason)
    });
    const after = getSelectedMolecule(next)!;
    const afterCenter = after.atoms.find(atom => atom.id === centerId)!;
    expect(reasons).toEqual([]);
    expect(after.bonds).toHaveLength(3);
    expect(after.bonds[2].order).toBe("double");
    expect(nativeAtomValidationState(afterCenter, after.bonds, 0, after.atoms)).toMatchObject({ valid: true, valenceUsed: 4 });
  });
  describe("changing the order of an existing bond", () => {
    /** The seed with the given bond orders written straight into the molecule (the bonds' order in the list). */
    function withBondOrders(seed: ReturnType<typeof literalCenterSeed>, orders: Array<"single" | "double" | "triple">) {
      return {
        ...seed,
        document: {
          ...seed.document,
          pages: seed.document.pages.map(page => ({
            ...page,
            objects: page.objects.map(object => object.id === seed.objectId && object.type === "molecule"
              ? { ...object, bonds: object.bonds.map((bond, index) => ({ ...bond, order: orders[index] ?? bond.order })) }
              : object)
          }))
        }
      };
    }

    it("raises a bond at a hypovalent literal atom past its valence and warns", () => {
      const { document, objectId, centerId } = literalCenterSeed(2);
      const molecule = getSelectedMolecule(document)!;
      const target = bondTarget(objectId, molecule.bonds[1]);
      const next = applyNativeMoleculeBondOrderValueTarget(document, target, "triple");
      const after = getSelectedMolecule(next)!;
      expect(after.bonds[1].order).toBe("triple");
      expect(nativeAtomValidationState(after.atoms.find(atom => atom.id === centerId)!, after.bonds, 0, after.atoms))
        .toMatchObject({ valid: false, valenceUsed: 5 });
      expect(nativeBondOrderTargetRefusal(document, target, "triple")).toBeUndefined();
      // A double bond fills the valence exactly, so it is still offered.
      expect(nativeBondOrderTargetRefusal(document, target, "double")).toBeUndefined();
    });

    it("cycles bond order on an already over-valent atom and keeps its warning", () => {
      const { document, objectId, centerId } = withBondOrders(literalCenterSeed(2), ["single", "double", "double"]);
      const molecule = getSelectedMolecule(document)!;
      expect(molecule.bonds.map(bond => bond.order)).toEqual(["single", "double", "double"]);
      const target = bondTarget(objectId, molecule.bonds[1]);
      const next = applyNativeMoleculeBondOrderTarget(document, target);
      const after = getSelectedMolecule(next)!;
      expect(after.bonds.map(bond => bond.order)).toEqual(["single", "triple", "double"]);
      expect(nativeAtomValidationState(after.atoms.find(atom => atom.id === centerId)!, after.bonds, 0, after.atoms))
        .toMatchObject({ valid: false, valenceUsed: 6 });
      expect(nativeBondOrderTargetRefusal(document, target, "triple")).toBeUndefined();
    });

    it("still lets an over-valent atom have a bond lowered", () => {
      const { document, objectId } = withBondOrders(literalCenterSeed(2), ["single", "double", "double"]);
      const molecule = getSelectedMolecule(document)!;
      const target = bondTarget(objectId, molecule.bonds[1]);
      expect(nativeBondOrderTargetRefusal(document, target, "single")).toBeUndefined();
      const next = applyNativeMoleculeBondOrderValueTarget(document, target, "single");
      expect(next).not.toBe(document);
      expect(getSelectedMolecule(next)!.bonds[1].order).toBe("single");
    });

    it("allows lowering that leaves a typed atom short and diagnoses the shortfall", () => {
      const { document, objectId, centerId } = withBondOrders(literalCenterSeed(1), ["single", "triple"]);
      const molecule = getSelectedMolecule(document)!;
      const target = bondTarget(objectId, molecule.bonds[1]);
      expect(nativeBondOrderTargetRefusal(document, target, "double")).toBeUndefined();
      const after = getSelectedMolecule(applyNativeMoleculeBondOrderValueTarget(document, target, "double"))!;
      expect(after.bonds[1].order).toBe("double");
      expect(nativeAtomValidationState(after.atoms.find(atom => atom.id === centerId)!, after.bonds, 0, after.atoms))
        .toMatchObject({ valid: false, valenceUsed: 3, invalidReason: "C has 3 of 4 bonds." });
    });

    it("still raises a double bond to triple on valid atoms", () => {
      const single = applySingleBondToolAtPoint(createPhase4Document("Raise"), { x: 300, y: 300 });
      const molecule = getSelectedMolecule(single)!;
      const target = bondTarget(molecule.id, molecule.bonds[0]);
      const double = applyNativeMoleculeBondOrderValueTarget(single, target, "double");
      expect(getSelectedMolecule(double)!.bonds[0].order).toBe("double");
      const triple = applyNativeMoleculeBondOrderValueTarget(double, target, "triple");
      expect(getSelectedMolecule(triple)!.bonds[0].order).toBe("triple");
    });
  });
});
