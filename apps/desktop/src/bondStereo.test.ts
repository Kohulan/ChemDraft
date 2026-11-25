import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Molecule } from "openchemlib";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { applyPatches, moleculeToMolfileV3000, type ElectronMarkObject } from "@chemdraft/chem-core";
import { depictSmiles2D, perceiveDoubleBondStereoFromMolfile } from "@chemdraft/ocl-adapter";
import {
  applyMoleculeBondStereo, applyMoleculeDoubleBondPosition, applyNativeMoleculeBondOrderTarget,
  applyNativeMoleculeBondOrderValueTarget, createPhase4Document, getSelectedMolecule,
  insertNativeMolfileMolecule, insertSmilesMolecule, moveNativeMoleculeParts, nativeBondStereoAvailability,
  pastedStructureDepictionFromMolfile,
  rotateDocumentObject, nativeBondStereoFlipDisabledReason, openNativeDocument, type NativeBondOrderTarget
} from "./documentWorkflow";
import { createBondStereoActions, moleculeBondStereoCommandId, moleculeBondStereoForCommand } from "./commands";
import { createMoleculeInspectorModel } from "./moleculeInspectorModel";
import { atomMapsNotKeptOpenWarnings } from "@chemdraft/document-workflow-core";

function drawing(smiles: string) {
  const document = insertNativeMolfileMolecule(createPhase4Document(), { x: 220, y: 220 }, depictSmiles2D(smiles).molfile, "molfile-v2000");
  const molecule = getSelectedMolecule(document)!;
  const bond = molecule.bonds.find(b => b.order === "double")!;
  const target: NativeBondOrderTarget = { objectId: molecule.id, kind: "bond", bondId: bond.id,
    fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId, distanceToPointer: 0 };
  return { document, molecule, bond, target };
}

describe("bond stereo commands", () => {
  it("preserves atom maps on opening a native document and refuses E/Z edits", () => {
    const opened = openNativeDocument(readFileSync(new URL(
      "../../../packages/fixtures/open-double-bonds/atom-mapped.chemdraft", import.meta.url), "utf8"));
    // The maps stay in the stored source, but no native atom keeps them: the open report says so.
    expect(opened.warnings).toEqual([{
      code: "document.atom_maps_not_kept",
      message: "ChemDraft document: 1 structure stores atom-map numbers. ChemDraft does not keep atom maps yet; " +
        "they will be dropped on export or when the structure is edited."
    }]);
    expect(opened.document).toBeDefined();
    const document = opened.document!;
    const molecule = document.pages[0].objects[0];
    expect(molecule.type).toBe("molecule");
    if (molecule.type !== "molecule") throw new Error("Expected molecule fixture");
    const lines = molecule.structure.split("\n");
    const start = lines.findIndex(line => line.includes("V2000")) + 1;
    expect(lines.slice(start, start + 4).map(line => Number(line.slice(60, 63)))).toEqual([1, 2, 3, 4]);
    const bond = molecule.bonds.find(b => b.order === "double")!;
    expect(bond.stereo).toBe("either");
    const target: NativeBondOrderTarget = { objectId: molecule.id, kind: "bond", bondId: bond.id,
      fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId, distanceToPointer: 0 };
    const reason = "Atom mapping must be removed before changing E/Z";
    expect(nativeBondStereoAvailability(document, [target], perceiveDoubleBondStereoFromMolfile))
      .toEqual({ eitherDisabledReason: reason, geometryDisabledReason: reason });
    expect(nativeBondStereoFlipDisabledReason(document, [target], perceiveDoubleBondStereoFromMolfile)).toBe(reason);
    const before = structuredClone(document);
    for (const value of ["either", "geometry", "flipped"] as const) {
      expect(applyMoleculeBondStereo(document, [target], value, perceiveDoubleBondStereoFromMolfile)).toBe(document);
    }
    expect(document).toEqual(before);
  });
  it("has value-encoded factories and specific reasons for every disabled command", () => {
    for (const value of ["either", "geometry", "flipped"] as const) {
      expect(moleculeBondStereoForCommand(moleculeBondStereoCommandId(value))).toEqual({ value });
    }
    expect(moleculeBondStereoForCommand("molecule.bondStereo:set")).toBeUndefined();
    expect(createBondStereoActions(nativeBondStereoAvailability(createPhase4Document(), [])))
      .toEqual(expect.arrayContaining([expect.objectContaining({ enabled: false, disabledReason: "Select one double bond" })]));
    const { document, target } = drawing("C/C=C/C");
    expect(nativeBondStereoAvailability(document, [target]).eitherDisabledReason).toBe("E/Z perception is still loading");
    expect(nativeBondStereoAvailability(document, [target, target], perceiveDoubleBondStereoFromMolfile).eitherDisabledReason).toBe("Select one double bond");
  });

  it.each(["C/C=C/C", "C/C=C\\C", "F/C(Cl)=C(Br)/I"])("uses injected CIP labels for %s, including an open bond", smiles => {
    const { document, target } = drawing(smiles);
    const expected = perceiveDoubleBondStereoFromMolfile(depictSmiles2D(smiles).molfile)[0].descriptor;
    expect(["E", "Z"]).toContain(expected);
    const state = nativeBondStereoAvailability(document, [target], perceiveDoubleBondStereoFromMolfile);
    expect(state.eitherDisabledReason).toBeUndefined();
    expect(createBondStereoActions(state)[1].title).toBe(`Use drawn geometry (${expected})`);
    const open = applyMoleculeBondStereo(document, [target], "either", perceiveDoubleBondStereoFromMolfile);
    expect(nativeBondStereoAvailability(open, [target], perceiveDoubleBondStereoFromMolfile)).toEqual({
      value: "either", eitherDisabledReason: "E/Z is already unspecified", descriptor: expected
    });
    const model = createMoleculeInspectorModel(open, { selectedObjectIds: [], selectedPart: target }, perceiveDoubleBondStereoFromMolfile);
    expect(model.structure.bondStereo?.descriptor).toBe(expected);
  });

  it.each(["CC=O", "CC=C(C)C", "C1=CCCCC1"])("refuses unspecified E/Z on non-stereogenic %s", smiles => {
    const { document, target } = drawing(smiles);
    const state = nativeBondStereoAvailability(document, [target], perceiveDoubleBondStereoFromMolfile);
    expect(state.eitherDisabledReason).toMatch(/carbon–carbon|not stereogenic/);
    expect(applyMoleculeBondStereo(document, [target], "either", perceiveDoubleBondStereoFromMolfile)).toBe(document);
  });

  it("recognizes a methyl label and drawn methyl as equivalent substituents", () => {
    const { document, molecule, target } = drawing("CC(C)=CF");
    const labelled = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes: {
      atoms: molecule.atoms.map((atom, i) => i === 0 ? { ...atom, element: "Me" } : atom)
    } }]);
    expect(nativeBondStereoAvailability(labelled, [target], perceiveDoubleBondStereoFromMolfile).eitherDisabledReason).toContain("not stereogenic");
    expect(applyMoleculeBondStereo(labelled, [target], "either", perceiveDoubleBondStereoFromMolfile)).toBe(labelled);
  });

  it("keeps native flags, stored V2000 markers and selection in agreement", () => {
    const { document, target } = drawing("C/C=C/C");
    const open = applyMoleculeBondStereo(document, [target], "either", perceiveDoubleBondStereoFromMolfile);
    const molecule = getSelectedMolecule(open)!;
    expect(open.selection).toEqual(document.selection);
    expect(molecule.bonds.find(b => b.id === target.bondId)?.stereo).toBe("either");
    expect(parseMolfileGraph(molecule.structure).bonds.filter(b => b.stereo === "either")).toHaveLength(1);
    expect(molecule.structure).toMatch(/  2  3  2  3/);
    expect(applyMoleculeBondStereo(open, [target], "either", perceiveDoubleBondStereoFromMolfile)).toBe(open);
    const geometry = applyMoleculeBondStereo(open, [target], "geometry", perceiveDoubleBondStereoFromMolfile);
    const next = getSelectedMolecule(geometry)!;
    expect(geometry.selection).toEqual(document.selection);
    expect(next.bonds.every(b => b.stereo === undefined)).toBe(true);
    expect(parseMolfileGraph(next.structure).bonds.every(b => b.stereo === undefined)).toBe(true);
    expect(perceiveDoubleBondStereoFromMolfile(next.structure)[0].descriptor).toBe("E");
  });

  it.each(["smiles", "v2000", "v3000-aamap", "v3000-positional"] as const)("refuses E/Z changes on atom-mapped %s sources", format => {
    const { document, molecule, target } = drawing("C/C=C/C");
    let structureFormat = molecule.structureFormat;
    let structure = molecule.structure;
    if (format === "smiles") {
      structureFormat = "smiles";
      structure = "[CH3:1]/C=C/C";
    } else if (format === "v2000") {
      const lines = structure.split("\n");
      const atomLine = lines.findIndex(line => line.includes("V2000")) + 1;
      // Only the atom-map column changes: no isotope/radical properties trigger preservation.
      lines[atomLine] = lines[atomLine].slice(0, 60) + "  1" + lines[atomLine].slice(63);
      structure = lines.join("\n");
    } else {
      structureFormat = "molfile-v3000";
      const lines = moleculeToMolfileV3000(molecule, { fromDocFrame: true, kekuleBondOrders: new Map() }).contents.split("\n");
      const atomLine = lines.indexOf("M  V30 BEGIN ATOM") + 1;
      lines[atomLine] = format === "v3000-aamap" ? `${lines[atomLine]} AAMAP=1`
        : lines[atomLine].replace(/ 0$/, " 1");
      structure = lines.join("\n");
    }
    // Include existing unspecified stereo so restoring geometry really would rebuild the source.
    for (const unspecified of [false, true]) {
      const mapped = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes: {
        structureFormat, structure,
        bonds: molecule.bonds.map(bond => bond.id === target.bondId && unspecified ? { ...bond, stereo: "either" as const } : bond)
      } }]);
      const before = structuredClone(mapped);
      const reason = "Atom mapping must be removed before changing E/Z";
      const state = nativeBondStereoAvailability(mapped, [target], perceiveDoubleBondStereoFromMolfile);
      expect(state).toEqual({ eitherDisabledReason: reason, geometryDisabledReason: reason });
      expect(createBondStereoActions(state)).toEqual([
        expect.objectContaining({ enabled: false, disabledReason: reason }),
        expect.objectContaining({ enabled: false, disabledReason: reason })
      ]);
      expect(nativeBondStereoFlipDisabledReason(mapped, [target], perceiveDoubleBondStereoFromMolfile)).toBe(reason);
      for (const value of ["either", "geometry", "flipped"] as const) {
        expect(applyMoleculeBondStereo(mapped, [target], value, perceiveDoubleBondStereoFromMolfile)).toBe(mapped);
      }
      expect(mapped).toEqual(before);
    }
  });

  it.each([
    ["versionless V2000", true],
    ["V3000 map split over a continuation line", true],
    ["source SMILES kept beside a molfile", true],
    ["SMILES class 0", false],
    ["SMILES R-group label ChemDraft spells [*:1]", false],
    ["V3000 AAMAP = 7 with spaces", true],
    ["V3000 AAMAP=0 beside a positional map", true],
    ["V3000 short counts line and a blank line before the block", true],
    ["SMILES [*:1] on another atom than the drawn R1", true],
    ["V2000 whose header lines spell a V3000 atom block", false],
    ["V3000 map continued on a line that starts with its separator", true]
  ] as const)("locks E/Z exactly when the open report warns of atom maps: %s", (format, locked) => {
    const { document, molecule, target } = drawing("C/C=C/C");
    let changes: Partial<typeof molecule>;
    if (format === "versionless V2000") {
      const lines = molecule.structure.split("\n");
      const counts = lines.findIndex(line => line.includes("V2000"));
      lines[counts] = lines[counts]!.replace(/\s*V2000\s*$/, "");
      lines[counts + 1] = lines[counts + 1]!.slice(0, 60) + "  1" + lines[counts + 1]!.slice(63);
      changes = { structure: lines.join("\n") };
    } else if (format === "V3000 map split over a continuation line") {
      const lines = moleculeToMolfileV3000(molecule, { fromDocFrame: true, kekuleBondOrders: new Map() }).contents.split("\n");
      const atomLine = lines.indexOf("M  V30 BEGIN ATOM") + 1;
      expect(lines[atomLine]).toMatch(/ 0$/);
      lines.splice(atomLine, 1, lines[atomLine]!.replace(/ 0$/, " -"), "M  V30 1");
      changes = { structureFormat: "molfile-v3000", structure: lines.join("\n") };
    } else if (format === "V2000 whose header lines spell a V3000 atom block") {
      // RDKit reads this as CC=CC, unmapped: header lines are never structure.
      const lines = molecule.structure.split("\n");
      expect(lines[3]).toMatch(/V2000\s*$/);
      lines.splice(0, 3, "M  V30 BEGIN ATOM", "M  V30 1 C 0 0 0 +5", "M  V30 END ATOM");
      changes = { structure: lines.join("\n") };
    } else if (format === "V3000 map continued on a line that starts with its separator") {
      const lines = moleculeToMolfileV3000(molecule, { fromDocFrame: true, kekuleBondOrders: new Map() }).contents.split("\n");
      const atomLine = lines.indexOf("M  V30 BEGIN ATOM") + 1;
      expect(lines[atomLine]).toMatch(/ 0$/);
      // The aamap field moves to the next line: "x y 0-" then " +1" joins as "x y 0 +1", map 1.
      lines.splice(atomLine, 1, lines[atomLine]!.replace(/ 0$/, "-"), "M  V30  +1");
      changes = { structureFormat: "molfile-v3000", structure: lines.join("\n") };
    } else if (format.startsWith("V3000 ")) {
      const lines = moleculeToMolfileV3000(molecule, { fromDocFrame: true, kekuleBondOrders: new Map() }).contents.split("\n");
      const atomLine = lines.indexOf("M  V30 BEGIN ATOM") + 1;
      expect(lines[atomLine]).toMatch(/ 0$/);
      if (format === "V3000 AAMAP = 7 with spaces") lines[atomLine] = `${lines[atomLine]} AAMAP = 7`;
      else if (format === "V3000 AAMAP=0 beside a positional map") lines[atomLine] = `${lines[atomLine]!.replace(/ 0$/, " 5")} AAMAP=0`;
      else {
        lines[atomLine] = lines[atomLine]!.replace(/ 0$/, " 3");
        const counts = lines.findIndex(line => line.includes("V3000"));
        lines.splice(counts, 1, "0 0 V3000", "");
      }
      changes = { structureFormat: "molfile-v3000", structure: lines.join("\n") };
    } else if (format === "SMILES [*:1] on another atom than the drawn R1") {
      // The drawn R1 replaces a terminal carbon (bonded to C); the [*:1] is bonded to nothing drawn as R1's neighbours.
      changes = { structureFormat: "smiles", structure: "C/C=C/C.[*:1]",
        atoms: molecule.atoms.map((atom, index) => index === 0 ? { ...atom, element: "R1" } : atom) };
    } else if (format === "source SMILES kept beside a molfile") {
      changes = { compatibility: { sourceFormat: "smiles", warnings: [], unknown: { smiles: "[CH3:1]/C=C/C" } } };
    } else if (format === "SMILES class 0") {
      changes = { structureFormat: "smiles", structure: "[CH3:0]/C=C/C" };
    } else {
      changes = { structureFormat: "smiles", structure: "[*:1]/C=C/C",
        atoms: molecule.atoms.map((atom, index) => index === 0 ? { ...atom, element: "R1" } : atom) };
    }
    const mapped = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes }]);
    const reason = "Atom mapping must be removed before changing E/Z";
    const state = nativeBondStereoAvailability(mapped, [target], perceiveDoubleBondStereoFromMolfile);
    expect(atomMapsNotKeptOpenWarnings(mapped)).toHaveLength(locked ? 1 : 0);
    if (locked) {
      expect(state).toEqual({ eitherDisabledReason: reason, geometryDisabledReason: reason });
      expect(nativeBondStereoFlipDisabledReason(mapped, [target], perceiveDoubleBondStereoFromMolfile)).toBe(reason);
      for (const value of ["either", "geometry", "flipped"] as const) {
        expect(applyMoleculeBondStereo(mapped, [target], value, perceiveDoubleBondStereoFromMolfile)).toBe(mapped);
      }
    } else {
      expect(state.eitherDisabledReason).not.toBe(reason);
      expect(state.geometryDisabledReason).not.toBe(reason);
      expect(nativeBondStereoFlipDisabledReason(mapped, [target], perceiveDoubleBondStereoFromMolfile)).not.toBe(reason);
    }
  });

  it.each([undefined, false, true])("retains pasted SMILES atom maps and disables every E/Z action (open: %s)", openUnspecifiedDoubleBonds => {
    const smiles = "[CH3:1]/[CH:2]=[CH:3]/[CH3:4]";
    const depiction = pastedStructureDepictionFromMolfile(depictSmiles2D(smiles, { openUnspecifiedDoubleBonds: true }).molfile);
    const base = createPhase4Document();
    const document = insertSmilesMolecule(base, { x: 220, y: 220 }, depiction, smiles, { openUnspecifiedDoubleBonds });
    const molecule = getSelectedMolecule(document)!;
    expect(molecule.structureFormat).toBe("smiles");
    expect(molecule.structure).toBe(smiles);
    expect([...molecule.structure.matchAll(/:(\d+)\]/g)].map(match => Number(match[1]))).toEqual([1, 2, 3, 4]);
    // Keeping the source must not alter the depiction, placed coordinates or native chemistry.
    const unmapped = getSelectedMolecule(insertSmilesMolecule(base, { x: 220, y: 220 }, depiction,
      smiles.replace(/:\d+/g, ""), { openUnspecifiedDoubleBonds }))!;
    expect(molecule.atoms).toEqual(unmapped.atoms);
    expect(molecule.bonds).toEqual(unmapped.bonds);
    expect(molecule.chemistry).toEqual(unmapped.chemistry);
    const bond = molecule.bonds.find(b => b.order === "double")!;
    const target: NativeBondOrderTarget = { objectId: molecule.id, kind: "bond", bondId: bond.id,
      fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId, distanceToPointer: 0 };
    const reason = "Atom mapping must be removed before changing E/Z";
    const state = nativeBondStereoAvailability(document, [target], perceiveDoubleBondStereoFromMolfile);
    expect(state).toEqual({ eitherDisabledReason: reason, geometryDisabledReason: reason });
    expect(nativeBondStereoFlipDisabledReason(document, [target], perceiveDoubleBondStereoFromMolfile)).toBe(reason);
    const inspector = createMoleculeInspectorModel(document, { selectedObjectIds: [], selectedPart: target }, perceiveDoubleBondStereoFromMolfile);
    expect(inspector.structure.bondStereo).toEqual(state);
    expect(createBondStereoActions(inspector.structure.bondStereo!)).toEqual([
      expect.objectContaining({ enabled: false, disabledReason: reason }),
      expect.objectContaining({ enabled: false, disabledReason: reason })
    ]);
    for (const value of ["either", "geometry", "flipped"] as const) {
      expect(applyMoleculeBondStereo(document, [target], value, perceiveDoubleBondStereoFromMolfile)).toBe(document);
    }
  });

  it("redraw and reapplying double order clear the flag; move, rotation and restyling keep it", () => {
    const { document, molecule, target } = drawing("C/C=C/C");
    const open = applyMoleculeBondStereo(document, [target], "either", perceiveDoubleBondStereoFromMolfile);
    const redrawn = getSelectedMolecule(applyNativeMoleculeBondOrderValueTarget(open, target, "double"))!;
    expect(redrawn.bonds.find(b => b.id === target.bondId)).toMatchObject({ order: "double" });
    expect(redrawn.bonds.find(b => b.id === target.bondId)?.stereo).toBeUndefined();
    expect(parseMolfileGraph(redrawn.structure).bonds.every(b => b.stereo === undefined)).toBe(true);
    const cycled = getSelectedMolecule(applyNativeMoleculeBondOrderTarget(open, target))!;
    expect(cycled.bonds.find(b => b.id === target.bondId)).toMatchObject({ order: "triple" });
    expect(cycled.bonds.find(b => b.id === target.bondId)?.stereo).toBeUndefined();
    expect(parseMolfileGraph(cycled.structure).bonds.every(b => b.stereo === undefined)).toBe(true);
    for (const changed of [
      moveNativeMoleculeParts(open, { objectId: molecule.id, kind: "atom", atomId: molecule.atoms[0].id }, { x: 10, y: 15 }),
      rotateDocumentObject(open, molecule.id, 30),
      applyMoleculeDoubleBondPosition(open, [target], "center")
    ]) expect(getSelectedMolecule(changed)!.bonds.find(b => b.id === target.bondId)?.stereo).toBe("either");
    expect(getSelectedMolecule(applyNativeMoleculeBondOrderValueTarget(open, target, "single"))!.bonds.find(b => b.id === target.bondId)?.stereo).toBeUndefined();
  });
});


describe("reflecting one double-bond end", () => {
  it.each([0, 35, 90, -40])("mirrors anchored lone-pair centres and rotations about a %s° bond axis", axisDegrees => {
    const drawingState = drawing("C/C=C/C");
    const initialFrom = drawingState.molecule.atoms.find(atom => atom.id === drawingState.bond.fromAtomId)!;
    const initialTo = drawingState.molecule.atoms.find(atom => atom.id === drawingState.bond.toAtomId)!;
    const initialAngle = Math.atan2(initialTo.y - initialFrom.y, initialTo.x - initialFrom.x) * 180 / Math.PI;
    const document = rotateDocumentObject(drawingState.document, drawingState.molecule.id, axisDegrees - initialAngle);
    const molecule = getSelectedMolecule(document)!;
    const { bond, target } = drawingState;
    const from = molecule.atoms.find(atom => atom.id === bond.fromAtomId)!;
    const to = molecule.atoms.find(atom => atom.id === bond.toAtomId)!;
    const reflectedAtomId = molecule.bonds.find(edge => edge.id !== bond.id &&
      (edge.fromAtomId === to.id || edge.toAtomId === to.id))!;
    const reflectedAtom = molecule.atoms.find(atom => atom.id === (reflectedAtomId.fromAtomId === to.id
      ? reflectedAtomId.toAtomId : reflectedAtomId.fromAtomId))!;
    const moving: ElectronMarkObject = {
      id: "moving-pair", type: "electron-mark", markKind: "lone-pair",
      x: reflectedAtom.x + 5, y: reflectedAtom.y - 12, width: 8, height: 8, rotation: 77, style: {},
      anchor: { kind: "atom", objectId: molecule.id, atomId: reflectedAtom.id }
    };
    const fixed: ElectronMarkObject = {
      ...moving, id: "fixed-pair", x: from.x + 5, y: from.y - 12, rotation: 23,
      anchor: { kind: "atom", objectId: molecule.id, atomId: from.id }
    };
    const marked = applyPatches(document, [moving, fixed].map(object => ({
      op: "addObject" as const, pageId: document.pages[0].id, object
    })));
    const flipped = applyMoleculeBondStereo(marked, [target], "flipped", perceiveDoubleBondStereoFromMolfile);
    const next = flipped.pages[0].objects.find(object => object.id === moving.id)!;
    const axisRadians = axisDegrees * Math.PI / 180;
    const normal = { x: -Math.sin(axisRadians), y: Math.cos(axisRadians) };
    const center = { x: moving.x + moving.width / 2, y: moving.y + moving.height / 2 };
    const distance = (center.x - from.x) * normal.x + (center.y - from.y) * normal.y;
    expect(next.x + next.width / 2).toBeCloseTo(center.x - 2 * distance * normal.x, 5);
    expect(next.y + next.height / 2).toBeCloseTo(center.y - 2 * distance * normal.y, 5);
    expect(next.rotation).toBeCloseTo(((2 * axisDegrees - moving.rotation) % 360 + 360) % 360, 3);
    expect(next).toMatchObject({ anchor: moving.anchor, width: moving.width, height: moving.height });
    expect(flipped.pages[0].objects.find(object => object.id === fixed.id)).toEqual(fixed);
  });

  it.each([
    ["C/C=C/C", "C/C=C\\C"],
    ["[CH2]/C=C/C", "[CH2]/C=C\\C"],
    ["F/C(Cl)=C(Br)/I", "F/C(Cl)=C(Br)\\I"],
    ["CCC/C=C/[C@H](F)Cl", "CCC/C=C\\[C@H](F)Cl"],
    ["CCCC/C=C/C=C/C", "CCCC/C=C\\C=C\\C"],
    ["[13CH3]/C=C/[C@@H]([NH3+])Cl", "[13CH3]/C=C\\[C@@H]([NH3+])Cl"]
  ])("changes only the target E/Z for %s", (smiles, opposite) => {
    const { document, molecule, target } = drawing(smiles);
    const open = applyMoleculeBondStereo(document, [target], "either", perceiveDoubleBondStereoFromMolfile);
    expect(nativeBondStereoFlipDisabledReason(open, [target], perceiveDoubleBondStereoFromMolfile)).toBeUndefined();
    const flipped = applyMoleculeBondStereo(open, [target], "flipped", perceiveDoubleBondStereoFromMolfile);
    const next = getSelectedMolecule(flipped)!;
    const canonical = (molfile: string) => Molecule.fromMolfile(molfile).toIsomericSmiles();
    expect(canonical(next.structure)).toBe(Molecule.fromSmiles(opposite).toIsomericSmiles());
    expect(canonical(next.structure)).not.toBe(canonical(molecule.structure));
    expect(next.atoms.map(({ x, y, ...atom }) => atom)).toEqual(molecule.atoms.map(({ x, y, ...atom }) => atom));
    expect(next.bonds.map(({ display, ...bond }) => bond)).toEqual(molecule.bonds.map(({ display, ...bond }) => bond));
    expect(flipped.selection).toEqual(open.selection);
    for (const bond of next.bonds) {
      const length = (mol: typeof molecule) => {
        const from = mol.atoms.find(a => a.id === bond.fromAtomId)!;
        const to = mol.atoms.find(a => a.id === bond.toAtomId)!;
        return Math.hypot(to.x - from.x, to.y - from.y);
      };
      expect(length(next)).toBeCloseTo(length(molecule), 8);
    }
  });

  it("refuses non-stereogenic and cyclic double bonds without changing the document", () => {
    for (const smiles of ["CC=O", "CC=C(C)C", "C1=CCCCCCCC1"]) {
      const { document, target } = drawing(smiles);
      expect(nativeBondStereoFlipDisabledReason(document, [target], perceiveDoubleBondStereoFromMolfile)).toBeTruthy();
      expect(applyMoleculeBondStereo(document, [target], "flipped", perceiveDoubleBondStereoFromMolfile)).toBe(document);
    }
  });

  it("retains source radicals beside a native radical annotation", () => {
    const { document, molecule, target } = drawing("[CH2]/C=C/CC");
    const annotated = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes: {
      atoms: molecule.atoms.map((atom, i) => i === molecule.atoms.length - 1 ? { ...atom, markRadicals: 1 } : atom)
    } }]);
    const flipped = getSelectedMolecule(applyMoleculeBondStereo(annotated, [target], "flipped", perceiveDoubleBondStereoFromMolfile))!;
    const parsed = Molecule.fromMolfile(flipped.structure);
    expect([...Array(parsed.getAllAtoms()).keys()].filter(i => parsed.getAtomRadical(i) !== 0)).toHaveLength(2);
  });

  it("refuses both choices if label expansion cannot retain the isotope atom mapping", () => {
    const { document, molecule, target } = drawing("[13CH3]/C=C/C");
    const labelled = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes: {
      atoms: molecule.atoms.map((atom, i) => i === molecule.atoms.length - 1 ? { ...atom, element: "Ph" } : atom)
    } }]);
    const state = nativeBondStereoAvailability(labelled, [target], perceiveDoubleBondStereoFromMolfile);
    expect(state.geometryDisabledReason).toBe("Cannot preserve all stored properties while changing E/Z");
    for (const choice of ["geometry", "either", "flipped"] as const) {
      expect(applyMoleculeBondStereo(labelled, [target], choice, perceiveDoubleBondStereoFromMolfile)).toBe(labelled);
    }
  });

  it("refuses geometry edits that would flatten a coordination bond in V2000", () => {
    const { document, molecule, target } = drawing("C/C=C/C");
    const dative = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes: {
      bonds: molecule.bonds.map(bond => bond.order === "single" ? { ...bond, display: { bondStyle: "dashed" } } : bond)
    } }]);
    expect(nativeBondStereoAvailability(dative, [target], perceiveDoubleBondStereoFromMolfile).geometryDisabledReason)
      .toBe("Cannot preserve all stored properties while changing E/Z");
    expect(applyMoleculeBondStereo(dative, [target], "flipped", perceiveDoubleBondStereoFromMolfile)).toBe(dative);
  });
});
