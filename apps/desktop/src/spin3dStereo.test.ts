import { invoke } from "@tauri-apps/api/core";
import { applyPatch, moleculeToMolfileV3000, type MoleculeObject, type ViewMatrix } from "@chemdraft/chem-core";
import { expandNativeMoleculeLabelGroups } from "@chemdraft/document-workflow-core";
import { Engine3DProtocolVersion, type Engine3DCoordinate, type Engine3DCoordinateReason, type Engine3DRequest } from "@chemdraft/engine3d-api";
import { depictSmiles2D, perceiveDoubleBondStereoFromMolfile, perceiveStereoCentersFromMolfile } from "@chemdraft/ocl-adapter";
import { ensureRdkit, rdkitConformerGenerator, resetRdkitForTesting } from "@chemdraft/rdkit-adapter";
import { installRealRdkitModuleLoader } from "@chemdraft/rdkit-adapter/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertSpin3dDocumentIdentity, attachSpin3dModelFromConformer, createPhase4Document, flattenSpunMolecule,
  getSelectedMolecule, insertNativeMolfileMolecule, normalizeCommittedDocument
} from "./documentWorkflow";
import {
  beginEngine3dWorkspaceDrag, createEngine3dSessionInputFromMolecule, endEngine3dWorkspaceDrag,
  engine3dCoordsInAtomOrder, engine3dDragStereoBlocked, openEngine3dWorkspaceSession, updateEngine3dWorkspaceDrag
} from "./engine3dSidecar";
import { quatFromAxisAngle, quatToViewMatrix, rotateVectorByQuat, type Vec3 } from "./interaction/rotation3d";
import { hasSpin3dStereoCandidates, serializeSpin3dMolfile, Spin3dStereoReference } from "./interaction/spin3dStereo";
import { modelMolblock } from "./chemistry3d/model";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

const cis = String.raw`C/C=C\C`;
const trans = "C/C=C/C";
const ring = String.raw`C1CCC/C=C\CC1`;

async function drawing(smiles: string) {
  const document = insertNativeMolfileMolecule(createPhase4Document(), { x: 300, y: 300 },
    depictSmiles2D(smiles, { openUnspecifiedDoubleBonds: true }).molfile, "molfile-v2000");
  const molecule = getSelectedMolecule(document)!;
  const ids = molecule.atoms.map(atom => atom.id);
  const rdkit = await ensureRdkit();
  return { document, molecule, ids, stereo: new Spin3dStereoReference(rdkit, molecule) };
}
type Drawing = Awaited<ReturnType<typeof drawing>>;

function positions(ids: readonly string[], coords: ArrayLike<number>): Record<string, Engine3DCoordinate> {
  return Object.fromEntries(ids.map((id, index) => [id, { x: coords[index * 3], y: coords[index * 3 + 1], z: coords[index * 3 + 2] }]));
}

function mockSidecar(
  responses: (request?: Engine3DRequest) => [Engine3DCoordinateReason, Readonly<Record<string, Engine3DCoordinate>>][]
) {
  const requests: Engine3DRequest[] = [];
  let revision = 0;
  vi.mocked(invoke).mockImplementation(async (_name, args) => {
    const line = (args as { lines?: string[] }).lines?.[0];
    const request = line ? JSON.parse(line) as Engine3DRequest : undefined;
    if (request) requests.push(request);
    const envelope = { protocolVersion: Engine3DProtocolVersion, requestId: requests.at(-1)?.requestId ?? "poll", sessionId: "stereo" };
    return {
      processSessionId: "stereo-process", stderr: "", exited: false,
      stdoutLines: [
        { ...envelope, type: "response", ok: true, result: { sessionId: "stereo" } },
        ...responses(request).map(([reason, coords3dByAtomId]) => ({
          ...envelope, type: "event", eventType: "coordinatesChanged", reason, coords3dByAtomId, coordinateRevision: ++revision
        }))
      ].map(line => JSON.stringify(line))
    };
  });
  return requests;
}

function open({ molecule, ids, stereo }: Drawing, coords: ArrayLike<number>) {
  return openEngine3dWorkspaceSession({
    input: createEngine3dSessionInputFromMolecule(molecule, { coords3dByAtomId: positions(ids, coords) }),
    checkStereo: value => {
      const ordered = engine3dCoordsInAtomOrder(ids, value);
      return ordered ? stereo.checkGeometry(ordered) : "missing atom coordinates";
    }
  });
}

function alkene(angle: number) {
  const radians = angle * Math.PI / 180;
  return Float64Array.of(-0.8, 1, 0, 0, 0, 0, 1.3, 0, 0, 2.1, Math.cos(radians), Math.sin(radians));
}

async function canonical(molfile: string) {
  const source = (await ensureRdkit()).get_mol(molfile, JSON.stringify({ removeHs: false }))!;
  try { return source.get_smiles!(); }
  finally { source.delete(); }
}

function molfileFrom3d(molecule: MoleculeObject, coords: number[]): string {
  const ids = molecule.atoms.map(atom => atom.id);
  return modelMolblock({
    modelToken: "stereo-fixture",
    atoms: molecule.atoms.map(atom => ({ element: atom.element, charge: atom.formalCharge, component: 0, addedHydrogen: false })),
    bonds: molecule.bonds.map(bond => ({
      a: ids.indexOf(bond.fromAtomId), b: ids.indexOf(bond.toAtomId), order: bond.order === "double" ? 2 : 1
    })),
    components: [],
    coords
  });
}

describe("Spin 3D stereo read-back", () => {
  it.each([["F", "Cl"], ["Br", "F"], ["I", "Br"]])(
    "preserves CMe(%s)=C(%s) stereo through all 36 rigid Z rotations", async (left, right) => {
      const smiles = `C/C(${left})=C/${right}`;
      const { document, molecule: full } = await drawing(smiles);
      expect(full.atoms.map(atom => atom.element)).toEqual(["C", "C", left, "C", right]);
      const [methyl, owner] = full.atoms;
      const compact: MoleculeObject = {
        ...full,
        atoms: full.atoms.slice(1).map(atom => atom.id === owner.id
          ? { ...atom, element: "CMe", labelLiteral: true } : atom),
        bonds: full.bonds.filter(bond => bond.fromAtomId !== methyl.id && bond.toAtomId !== methyl.id)
      };
      compact.structure = serializeSpin3dMolfile(compact);
      const source = normalizeCommittedDocument(applyPatch(document, {
        op: "updateObject", objectId: full.id, changes: compact
      }));
      const molecule = getSelectedMolecule(source)!;
      const expanded = expandNativeMoleculeLabelGroups(molecule).molecule;
      expect(expanded.atoms.map(atom => atom.element)).toEqual(["C", left, "C", right, "C"]);
      const expandedMolfile = (graph: MoleculeObject) => moleculeToMolfileV3000(
        expandNativeMoleculeLabelGroups(graph).molecule, { fromDocFrame: true, kekuleBondOrders: new Map() }
      ).contents;
      const expected = await canonical(smiles);
      expect(await canonical(expandedMolfile(molecule))).toBe(expected);

      const stereoReference = new Spin3dStereoReference(await ensureRdkit(), molecule);
      const options = { stereoReference, perceiveStereo: perceiveStereoCentersFromMolfile,
        perceiveDoubleBondStereo: perceiveDoubleBondStereoFromMolfile };
      const view = quatToViewMatrix(quatFromAxisAngle([0, 0, 1], 0));
      const seed = expanded.atoms.map((atom): Vec3 => [(atom.x - owner.x) / 20, (owner.y - atom.y) / 20, 0]);
      const collinear = seed.slice(0, 4);
      collinear[1] = seed[2];
      expect(stereoReference.checkGeometry(collinear.flat(), true)).toMatch(/double bond would lose its [EZ] geometry/);
      for (let degrees = 5; degrees < 360; degrees += 10) {
        const rotation = quatFromAxisAngle([0, 0, 1], degrees * Math.PI / 180);
        const rigid = seed.flatMap(point => rotateVectorByQuat(rotation, point));
        const drawn = rigid.slice(0, molecule.atoms.length * 3);
        // Check the actual hidden methyl independently of the guard's reconstruction.
        expect(await canonical(molfileFrom3d(expanded, rigid)), `full 3D frame at ${degrees}°`).toBe(expected);
        expect(stereoReference.checkGeometry(drawn, true), `guard at ${degrees}°`).toBeUndefined();
        const outcome = flattenSpunMolecule(source, molecule.id, drawn, view, options);
        expect(outcome.status, `flatten at ${degrees}°`).toBe("committed");
        const flattened = getSelectedMolecule(normalizeCommittedDocument(outcome.document))!;
        expect(await canonical(expandedMolfile(flattened)), `flattened stereo at ${degrees}°`).toBe(expected);
      }
    });

  it("refuses a 91° X view when the explicit ligands of C/C=C(/F)Cl disagree", async () => {
    const { document, molecule, stereo } = await drawing("C/C=C(/F)Cl");
    const polar = (degrees: number) => [2, Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)];
    const coords = [-0.7, 1, 0, 0, 0, 0, 1.3, 0, 0, ...polar(275), ...polar(75)];
    expect(await canonical(molfileFrom3d(molecule, coords))).toBe(String.raw`C/C=C(\F)Cl`);
    expect(stereo.checkGeometry(coords)).toMatch(/double bond would change/);
    const view = quatToViewMatrix(quatFromAxisAngle([1, 0, 0], 91 * Math.PI / 180));
    const outcome = flattenSpunMolecule(document, molecule.id, coords, view, { stereoReference: stereo });
    expect(outcome.status).toBe("refused");
    expect(outcome.document).toBe(document);
  });

  it("rejects E-2-butene with one ligand 0.57° from collinear", async () => {
    const { molecule, stereo } = await drawing(trans);
    const coords = [-1, 0.01, 0, 0, 0, 0, 1.3, 0, 0, 2, -1, 0.05];
    expect(await canonical(molfileFrom3d(molecule, coords))).toBe("CC=CC");
    expect(stereo.checkGeometry(coords)).toBe("the C2=C3 double bond would lose its E geometry");
  });

  it("rejects C[C@H](F)Cl with a ligand 0.05 Å above the other ligands' plane", async () => {
    const { molecule, stereo } = await drawing("C[C@H](F)Cl");
    const coords = [1, 0, 0, 0, 0, 0, -0.5, 0.866, 0, -0.5, -0.866, 0.05];
    expect(await canonical(molfileFrom3d(molecule, coords))).toBe("CC(F)Cl");
    expect(stereo.checkGeometry(coords)).toBe("the stereocenter at C2 would lose its stereo assignment");
  });

  it("verifies marginal alkene and tetrahedral frames with RDKit", async () => {
    const alkeneDrawing = await drawing(cis);
    const chiralDrawing = await drawing("C[C@H](F)Cl");
    for (const [entry, coords] of [
      [alkeneDrawing, alkene(82)],
      [chiralDrawing, [1, 0, 0, 0, 0, 0, -0.5, 0.866, 0, -0.5, -0.866, 0.12]]
    ] as const) {
      const rdkit = await ensureRdkit();
      const reference = new Spin3dStereoReference(rdkit, entry.molecule);
      const read = vi.spyOn(rdkit, "get_mol");
      try {
        reference.checkGeometry(coords);
        expect(read).toHaveBeenCalledWith(expect.stringContaining("ChemDraft         3D"), expect.any(String));
      } finally {
        read.mockRestore();
      }
    }
  });

  it("carries a legacy +1 on nitrogen through a 180° flatten and checks normalized history", async () => {
    const { document, molecule } = await drawing(String.raw`NCCC/C=C\CCCl`);
    const nitrogen = molecule.atoms.find(atom => atom.element === "N")!;
    const source = normalizeCommittedDocument(applyPatch(document, {
      op: "addObject", pageId: document.pages[0].id, object: {
        id: "legacy-charge", type: "electron-mark", markKind: "charge", charge: 1,
        anchor: { kind: "atom", objectId: molecule.id, atomId: nitrogen.id },
        x: nitrogen.x - 4, y: nitrogen.y - 4, width: 8, height: 8, rotation: 0, style: {}
      }
    }));
    const charged = getSelectedMolecule(source)!;
    const stereoReference = new Spin3dStereoReference(await ensureRdkit(), charged);
    const coords3d = Float64Array.from(charged.atoms.flatMap(atom => [atom.x / 20, -atom.y / 20, 0]));
    const orientation = quatFromAxisAngle([0, 0, 1], Math.PI);
    const outcome = flattenSpunMolecule(source, molecule.id, coords3d, quatToViewMatrix(orientation), {
      stereoReference, perceiveStereo: perceiveStereoCentersFromMolfile
    });
    expect(outcome.status).toBe("committed");
    const modeled = attachSpin3dModelFromConformer(outcome.document, molecule.id, { coords3d, orientation });
    const present = normalizeCommittedDocument(modeled);
    expect(() => assertSpin3dDocumentIdentity(source, present, stereoReference)).not.toThrow();
    const next = getSelectedMolecule(present)!;
    expect(next.atoms.filter(atom => atom.formalCharge).map(atom => [atom.id, atom.formalCharge])).toEqual([[nitrogen.id, 1]]);
    expect(present.pages[0].objects.find(object => object.id === "legacy-charge")).toMatchObject({
      anchor: { kind: "atom", atomId: nitrogen.id }, atomAssociation: "explicit"
    });

    // Simulate the old uncarried mark with its original page coordinates.
    const originalMark = source.pages[0].objects.find(object => object.id === "legacy-charge");
    if (originalMark?.type !== "electron-mark") throw new Error("Expected the legacy charge mark");
    const uncarried = normalizeCommittedDocument(applyPatch(modeled, {
      op: "updateObject", objectId: originalMark.id, changes: { ...originalMark, atomAssociation: undefined }
    }));
    expect(() => assertSpin3dDocumentIdentity(source, uncarried, stereoReference)).toThrow(/formal charge/);
  });

  it.each([undefined, "explicit"] as const)("carries a %s lone pair with nitrogen through a 180° flatten", async atomAssociation => {
    const { document, molecule } = await drawing(String.raw`NCCC/C=C\CCCl`);
    const nitrogen = molecule.atoms.find(atom => atom.element === "N")!;
    const source = normalizeCommittedDocument(applyPatch(document, {
      op: "addObject", pageId: document.pages[0].id, object: {
        id: "nitrogen-pair", type: "electron-mark", markKind: "lone-pair",
        anchor: { kind: "atom", objectId: molecule.id, atomId: nitrogen.id }, atomAssociation,
        x: nitrogen.x + 5, y: nitrogen.y - 11, width: 8, height: 8, rotation: 0, style: {}
      }
    }));
    const native = getSelectedMolecule(source)!;
    const stereoReference = new Spin3dStereoReference(await ensureRdkit(), native);
    const coords3d = native.atoms.flatMap(atom => [atom.x / 20, -atom.y / 20, 0]);
    const view = quatToViewMatrix(quatFromAxisAngle([0, 0, 1], Math.PI));
    const outcome = flattenSpunMolecule(source, native.id, coords3d, view, { stereoReference });
    expect(outcome.status).toBe("committed");
    const normalized = normalizeCommittedDocument(outcome.document);
    const next = getSelectedMolecule(normalized)!.atoms.find(atom => atom.id === nitrogen.id)!;
    expect(Math.hypot(next.x - nitrogen.x, next.y - nitrogen.y)).toBeGreaterThan(100);
    expect(normalized.pages[0].objects.find(object => object.id === "nitrogen-pair")).toMatchObject({
      anchor: { kind: "atom", objectId: molecule.id, atomId: nitrogen.id }, atomAssociation: "explicit",
      x: expect.closeTo(next.x + 5, 8), y: expect.closeTo(next.y - 11, 8)
    });
    expect(() => assertSpin3dDocumentIdentity(source, normalized, stereoReference)).not.toThrow();

    const leftBehind = normalizeCommittedDocument(applyPatch(normalized, {
      op: "updateObject", objectId: "nitrogen-pair",
      changes: { x: nitrogen.x + 5, y: nitrogen.y - 11, atomAssociation }
    }));
    expect(() => assertSpin3dDocumentIdentity(source, leftBehind, stereoReference))
      .toThrow(atomAssociation ? /lone-pair mark .* would move away/ : /atom association of the lone-pair mark/);
  });

  it("finds RDKit-verified wedges across the X-axis views of 1,4-cyclohexanediol", async () => {
    const { document, molecule, stereo } = await drawing("O[C@H]1CC[C@@H](O)CC1");
    const molfile = serializeSpin3dMolfile(molecule);
    const identity = await canonical(molfile);
    const coords = (await rdkitConformerGenerator.generate3DConformer({ molfile }, { seed: 42, optimize: "none" }))
      .mapping.coords3dByOriginalAtom;
    expect(stereo.checkGeometry(coords, true)).toBeUndefined();
    const options = { stereoReference: stereo, perceiveStereo: perceiveStereoCentersFromMolfile };
    for (let degrees = 0; degrees <= 180; degrees += 10) {
      const view = quatToViewMatrix(quatFromAxisAngle([1, 0, 0], degrees * Math.PI / 180));
      const outcome = flattenSpunMolecule(document, molecule.id, coords, view, options);
      expect(outcome.refusalReasons, `${degrees}°`).toEqual([]);
      const normalized = normalizeCommittedDocument(outcome.document);
      expect(await canonical(getSelectedMolecule(normalized)!.structure), `${degrees}°`).toBe(identity);
      assertSpin3dDocumentIdentity(document, normalized, stereo);
    }
  });

  it.each(["C1=CCCC1", "C1=CCCCC1", "C1=CCCCCC1"])("commits an embedded edge-on %s using the production candidate gate", async smiles => {
    const { document, molecule, ids, stereo } = await drawing(smiles);
    const coords = (await rdkitConformerGenerator.generate3DConformer(
      { molfile: serializeSpin3dMolfile(molecule) }, { seed: 42, optimize: "none" }
    )).mapping.coords3dByOriginalAtom;
    const double = molecule.bonds.find(bond => bond.order === "double")!;
    const point = (id: string) => Array.from(coords.slice(3 * ids.indexOf(id), 3 * ids.indexOf(id) + 3));
    const minus = (a: number[], b: number[]) => a.map((value, i) => value - b[i]);
    const unit = (a: number[]) => a.map(value => value / Math.hypot(...a));
    const cross = ([x, y, z]: number[], [a, b, c]: number[]) => [y * c - z * b, z * a - x * c, x * b - y * a];
    const ligand = (id: string) => {
      const bond = molecule.bonds.find(bond => bond !== double && (bond.fromAtomId === id || bond.toAtomId === id))!;
      return point(bond.fromAtomId === id ? bond.toAtomId : bond.fromAtomId);
    };
    const { fromAtomId: a, toAtomId: b } = double;
    const axis = unit(minus(point(b), point(a)));
    const left = unit(cross(axis, minus(ligand(a), point(a))));
    const right = unit(cross(axis, minus(ligand(b), point(b))));
    const z = unit(minus(left, right));
    const y = unit(cross(z, axis));
    const view = [...axis, 0, ...y, 0, ...z, 0, 0, 0, 0, 1] as ViewMatrix;
    expect(hasSpin3dStereoCandidates(molecule)).toBe(true);
    expect(stereo.specifiedDoubleBondIds.size).toBe(0);
    const options = {
      perceiveStereo: perceiveStereoCentersFromMolfile, perceiveDoubleBondStereo: perceiveDoubleBondStereoFromMolfile,
      stereoReference: hasSpin3dStereoCandidates(molecule) ? stereo : undefined
    };
    expect(flattenSpunMolecule(document, molecule.id, coords, view, options).status).toBe("committed");
  });

  it.each([cis, trans, ring])(
    "preserves %s in ordinary and Interactive 3D flatten, including a near-edge-on 125° X view", async (smiles) => {
      const entry = await drawing(smiles);
      const { document, molecule, ids, stereo } = entry;
      const before = await canonical(serializeSpin3dMolfile(molecule));
      expect(before).toMatch(/[/\\]/);
      const embedded = (await rdkitConformerGenerator.generate3DConformer(
        { molfile: serializeSpin3dMolfile(molecule) }, { optimize: "none", seed: 42 }
      )).mapping.coords3dByOriginalAtom;
      const double = molecule.bonds.find(bond => bond.order === "double")!;
      const from = molecule.atoms.find(atom => atom.id === double.fromAtomId)!;
      const to = molecule.atoms.find(atom => atom.id === double.toAtomId)!;
      const align = quatFromAxisAngle([0, 0, 1], -Math.atan2(from.y - to.y, to.x - from.x));
      const nearEdge = quatFromAxisAngle([1, 0, 0], (89.8 - 125) * Math.PI / 180);
      // Align the double bond to the X axis and put the ligands 0.2° off edge-on
      // at the requested view, regardless of the depiction's starting orientation.
      const shallow = molecule.atoms.flatMap(atom => rotateVectorByQuat(nearEdge,
        rotateVectorByQuat(align, [atom.x - from.x, -(atom.y - from.y), 0] as Vec3)));
      const views = [[embedded, 0], [embedded, 125], [shallow, 125]] as const;
      for (const [coords, angle] of views) {
        const view = quatToViewMatrix(quatFromAxisAngle([1, 0, 0], angle * Math.PI / 180));
        const options = { perceiveStereo: perceiveStereoCentersFromMolfile, stereoReference: stereo };
        mockSidecar(() => [["embed", positions(ids, coords)]]);
        const session = await open(entry, coords);
        const interactive = engine3dCoordsInAtomOrder(ids, session.coords3dByAtomId!)!;
        expect(interactive).toEqual(Float64Array.from(coords));
        for (const mode of [coords, interactive]) {
          const outcome = flattenSpunMolecule(document, molecule.id, mode, view, options);
          if (outcome.status === "refused") {
            expect(outcome.document).toBe(document);
            expect(outcome.refusalReasons[0]).toMatch(/double bond.*geometry.*Rotate slightly/);
          } else {
            expect(await canonical(getSelectedMolecule(outcome.document)!.structure)).toBe(before);
          }
        }
        if (coords === shallow && smiles !== ring) {
          const unchecked = flattenSpunMolecule(document, molecule.id, coords, view);
          expect(unchecked.status).toBe("committed");
          expect(await canonical(getSelectedMolecule(unchecked.document)!.structure)).toBe("CC=CC");
          const repaired = flattenSpunMolecule(document, molecule.id, coords, view, options);
          expect(repaired.status).toBe("committed");
          expect(await canonical(getSelectedMolecule(repaired.document)!.structure)).toBe(before);
          expect(repaired.depictionCoords3d).toBeDefined();
          expect(stereo.checkGeometry(repaired.depictionCoords3d!)).toBeUndefined();
        }
      }
    });

  it("refuses a genuinely edge-on Z projection with the affected bond and an unchanged document", async () => {
    const { document, molecule, stereo } = await drawing(cis);
    const view = quatToViewMatrix(quatFromAxisAngle([1, 0, 0], Math.PI / 2));
    const outcome = flattenSpunMolecule(document, molecule.id, alkene(0), view, { stereoReference: stereo });
    expect(outcome.document).toBe(document);
    expect(outcome.refusalReasons).toEqual([
      "the C2=C3 double bond would lose its Z geometry from this view. Rotate slightly and try again."
    ]);
  });

  it.each([true, false])("keeps an originally unspecified alkene open (explicit marker: %s)", async (explicit) => {
    const { document, molecule } = await drawing("CC=CC");
    const source = explicit ? molecule : {
      ...molecule, atoms: molecule.atoms.map((atom, i) => ({ ...atom, x: 3 * i, y: 0 })),
      bonds: molecule.bonds.map(({ stereo: _stereo, ...bond }) => bond)
    };
    const stereo = new Spin3dStereoReference(await ensureRdkit(), source);
    const updated = { ...document, pages: document.pages.map(page => ({
      ...page, objects: page.objects.map(object => object.id === source.id ? source : object)
    })) };
    const outcome = flattenSpunMolecule(updated, source.id, alkene(0),
      quatToViewMatrix(quatFromAxisAngle([1, 0, 0], 0)), { stereoReference: stereo });
    expect(outcome.status).toBe("committed");
    expect(await canonical(getSelectedMolecule(outcome.document)!.structure)).toBe("CC=CC");
  });

  it("verifies tetrahedral parity on the flattened block", async () => {
    const { document, molecule, stereo } = await drawing("C[C@H](F)Cl");
    const molfile = serializeSpin3dMolfile(molecule);
    const coords = (await rdkitConformerGenerator.generate3DConformer({ molfile }, { optimize: "none", seed: 42 }))
      .mapping.coords3dByOriginalAtom;
    const view = quatToViewMatrix(quatFromAxisAngle([1, 2, 3], 0.4));
    const options = { stereoReference: stereo, perceiveStereo: perceiveStereoCentersFromMolfile };
    const outcome = flattenSpunMolecule(document, molecule.id, coords, view, options);
    expect(outcome.status).toBe("committed");
    expect(await canonical(getSelectedMolecule(outcome.document)!.structure)).toBe(await canonical(molfile));
    const mirrored = coords.map((value, i) => i % 3 === 0 ? -value : value);
    const refused = flattenSpunMolecule(document, molecule.id, mirrored, view, options);
    expect(refused.document).toBe(document);
    expect(refused.refusalReasons[0]).toContain("the stereocenter at C2 would invert");
  });
});

describe("Interactive 3D sidecar stereo rollback", () => {
  it("rejects inverted F[C@](Cl)(Br)I frames when only the center crosses a ligand face", async () => {
    const entry = await drawing("F[C@](Cl)(Br)I");
    const { molecule, ids, stereo } = entry;
    const elementCoords: Record<string, number[]> = {
      C: [0, 0, 0], F: [1, 1, 1], Cl: [1, -1, -1], Br: [-1, 1, -1], I: [-1, -1, 1]
    };
    const identity = await canonical(serializeSpin3dMolfile(molecule));
    let valid = molecule.atoms.flatMap(atom => elementCoords[atom.element]);
    const reflection = await canonical(molfileFrom3d(molecule, valid)) === identity ? 1 : -1;
    valid = valid.map((value, i) => i % 3 === 0 ? value * reflection : value);
    expect(stereo.checkGeometry(valid)).toBeUndefined();
    const center = molecule.atoms.findIndex(atom => atom.element === "C") * 3;
    const inverted: number[][] = [];
    for (const ligand of ["F", "Cl", "Br", "I"]) {
      const [x, y, z] = elementCoords[ligand];
      for (const distance of [0.45, 0.7, 1.2, 1.6]) {
        const moved = valid.slice();
        moved.splice(center, 3, -distance * x * reflection + 0.04, -distance * y - 0.02, -distance * z);
        const actual = await canonical(molfileFrom3d(molecule, moved));
        if (actual.includes("@") && actual !== identity) {
          expect(stereo.checkGeometry(moved)).toMatch(/stereocenter.*invert/);
          inverted.push(moved);
        }
      }
    }
    expect(inverted.length).toBeGreaterThan(1);
    mockSidecar(request => {
      if (request?.type === "createSession") return [["embed", positions(ids, valid)]];
      if (request?.type === "updateDrag") return [["drag", positions(ids, inverted[0])]];
      if (request?.type === "endDrag") return [["settle", positions(ids, inverted[1])]];
      return [];
    });
    let session = await open(entry, valid);
    session = await beginEngine3dWorkspaceDrag(session, ids[center / 3]);
    session = await updateEngine3dWorkspaceDrag(session, ids[center / 3], { x: 0, y: 0, z: 0 });
    expect(session.stereo?.needsReseed).toBe(true);
    expect(session.coords3dByAtomId).toEqual(positions(ids, valid));
    session = await endEngine3dWorkspaceDrag(session, ids[center / 3]);
    expect(session.stereo?.warning?.reason).toMatch(/stereocenter.*invert/);
    expect(session.coords3dByAtomId).toEqual(positions(ids, valid));
  });

  it.each(["unavailable", "works", "fails"])("bounds reseeding from the same 80.1° UFF seed (fallback %s)", async fallback => {
    const entry = await drawing(cis);
    const { ids, stereo } = entry;
    const radians = 80.10590858410458 * Math.PI / 180;
    const seed = [-1.0958333261668738, 1.1455119767597788, 0, 0, 0, 0, 1.4668317457451856, 0, 0,
      1.4668317457451856 + 0.8460737396179355, 0.89446939430637 * Math.cos(radians), 0.89446939430637 * Math.sin(radians)];
    const initial = positions(ids, seed);
    const prior = positions(ids, alkene(60));
    const flipped = positions(ids, alkene(100));
    const requests = mockSidecar(request => {
      if (request?.type !== "createSession") return [];
      const requested = request.input.coords3dByAtomId!;
      if (request.requestId === "engine3d-1" && fallback !== "unavailable") {
        return [["embed", prior], ["embed", initial], ["initial-relax", flipped]];
      }
      const valid = fallback === "works" && requested[ids[0]].x === prior[ids[0]].x;
      return [["embed", requested], ["initial-relax", valid ? prior : flipped]];
    });
    expect(stereo.checkGeometry(seed)).toBeUndefined();
    let session = await open(entry, seed);
    const attempts = fallback === "works" ? 1 : 3;
    for (let i = 0; i < attempts; i++) {
      session = await beginEngine3dWorkspaceDrag(session, ids[0]);
      session = await updateEngine3dWorkspaceDrag(session, ids[0], { ...initial[ids[0]], y: 1.25 });
    }
    if (fallback === "works") {
      expect(session.coords3dByAtomId).toEqual(prior);
      expect(requests.map(request => request.type)).toEqual(["createSession", "createSession", "createSession", "beginDrag", "updateDrag"]);
      expect(requests[2]).toMatchObject({ input: { coords3dByAtomId: prior } });
    } else {
      expect(session.coords3dByAtomId).toEqual(initial);
      expect(engine3dDragStereoBlocked(session)).toBe(true);
      expect(session.stereo?.warning?.reason).toContain("could not restart the tug without changing stereochemistry");
      expect(requests.map(request => request.type)).toEqual(Array(fallback === "fails" ? 3 : 2).fill("createSession"));
    }
  });

  it("rolls back a plain release across 90° and seeds the next gesture from the last valid frame", async () => {
    const entry = await drawing(cis);
    const { ids } = entry;
    const frames = [0, 20, 40, 60, 80, 100].map(angle => positions(ids, alkene(angle)));
    let release = 0;
    const requests = mockSidecar(request => {
      if (request?.type === "createSession") return [["embed", request.input.coords3dByAtomId!]];
      if (request?.type === "endDrag") return [["settle", frames[release++]]];
      return [];
    });
    let session = await open(entry, alkene(0));
    for (const [i, frame] of frames.entries()) {
      session = await beginEngine3dWorkspaceDrag(session, ids[0]);
      session = await endEngine3dWorkspaceDrag(session, ids[0]);
      expect(session.coords3dByAtomId).toEqual(i < 5 ? frame : frames[4]);
    }
    expect(session.stereo?.warning?.reason).toBe("the C2=C3 double bond would change its Z geometry");
    await beginEngine3dWorkspaceDrag(session, ids[0]);
    expect(requests.at(-2)).toMatchObject({ type: "createSession", input: { coords3dByAtomId: frames[4] } });
  });

  it("rejects a 0.35 Å tug, stops accepting repeated flips in one gesture, and reports once", async () => {
    const entry = await drawing(cis);
    const { ids } = entry;
    const initial = positions(ids, alkene(82));
    const flipped = positions(ids, alkene(102));
    const target = flipped[ids[3]];
    expect(Math.hypot(target.y - initial[ids[3]].y, target.z - initial[ids[3]].z)).toBeCloseTo(0.35, 2);
    const requests = mockSidecar(request => {
      if (request?.type === "createSession") return [["embed", request.input.coords3dByAtomId!]];
      if (request?.type === "updateDrag") return [["drag", flipped], ["drag", flipped], ["drag", initial]];
      return [];
    });
    let session = await open(entry, alkene(82));
    session = await beginEngine3dWorkspaceDrag(session, ids[3]);
    session = await updateEngine3dWorkspaceDrag(session, ids[3], target);
    expect(session.coords3dByAtomId).toEqual(initial);
    expect(engine3dDragStereoBlocked(session)).toBe(true);
    const warning = session.stereo?.warning;
    expect(warning?.reason).toContain("would change its Z geometry");
    session = await endEngine3dWorkspaceDrag(session, ids[3]);
    expect(session.stereo?.warning).toBe(warning);
    expect(requests.map(request => request.type)).toEqual(["createSession", "beginDrag", "updateDrag"]);
  });

  it("resumes the same gesture from the last valid frame after a single rejected tug", async () => {
    const entry = await drawing(cis);
    const { ids } = entry;
    const initial = positions(ids, alkene(70));
    const flipped = positions(ids, alkene(100));
    const recovered = positions(ids, alkene(60));
    let updates = 0;
    const requests = mockSidecar(request => {
      if (request?.type === "createSession") return [["embed", request.input.coords3dByAtomId!]];
      if (request?.type === "updateDrag") return [["drag", updates++ === 0 ? flipped : recovered]];
      return [];
    });
    let session = await open(entry, alkene(70));
    session = await beginEngine3dWorkspaceDrag(session, ids[3]);
    session = await updateEngine3dWorkspaceDrag(session, ids[3], flipped[ids[3]]);
    expect(session.coords3dByAtomId).toEqual(initial);
    session = await updateEngine3dWorkspaceDrag(session, ids[3], recovered[ids[3]]);
    expect(requests.slice(3).map(request => request.type)).toEqual(["createSession", "beginDrag", "updateDrag"]);
    expect(requests[3]).toMatchObject({ input: { coords3dByAtomId: initial } });
    expect(session.coords3dByAtomId).toEqual(recovered);
    expect(session.stereo?.warning).toBeUndefined();
  });

  it("preserves valid E frames and rolls back an invalid initial relaxation", async () => {
    const entry = await drawing(trans);
    const { ids } = entry;
    const initial = positions(ids, alkene(180));
    const flipped = positions(ids, alkene(80));
    const settled = positions(ids, alkene(150));
    mockSidecar(request => {
      if (request?.type === "createSession") return request.requestId === "engine3d-1"
        ? [["embed", initial], ["initial-relax", flipped]] : [["embed", request.input.coords3dByAtomId!]];
      if (request?.type === "endDrag") return [["settle", settled]];
      return [];
    });
    let session = await open(entry, alkene(180));
    expect(session.coords3dByAtomId).toEqual(initial);
    expect(session.stereo?.warning?.reason).toContain("would change its E geometry");
    session = await beginEngine3dWorkspaceDrag(session, ids[0]);
    session = await endEngine3dWorkspaceDrag(session, ids[0]);
    expect(session.coords3dByAtomId).toEqual(settled);
    expect(session.stereo?.warning).toBeUndefined();
  });

  it("guards a late settle even when the release response has already returned", async () => {
    const entry = await drawing(cis);
    const { ids } = entry;
    const initial = positions(ids, alkene(70));
    const flipped = positions(ids, alkene(100));
    mockSidecar(request => request?.type === "createSession" ? [["embed", initial]]
      : request === undefined ? [["settle", flipped]] : []);
    let session = await open(entry, alkene(70));
    session = await beginEngine3dWorkspaceDrag(session, ids[0]);
    session = await endEngine3dWorkspaceDrag(session, ids[0]);
    expect(session.coords3dByAtomId).toEqual(initial);
    expect(session.stereo?.warning?.reason).toContain("would change its Z geometry");
  });

  it.each(["C[C@H](F)Cl", "F[C@@](Cl)(Br)I", "[H][C@](F)(Cl)Br"])(
    "rolls back a mirrored tetrahedral center for %s", async smiles => {
      const entry = await drawing(smiles);
      const { ids, molecule, stereo } = entry;
      const coords = (await rdkitConformerGenerator.generate3DConformer(
        { molfile: serializeSpin3dMolfile(molecule) }, { optimize: "none", seed: 42 }
      )).mapping.coords3dByOriginalAtom;
      expect(stereo.checkGeometry(coords)).toBeUndefined();
      const original = positions(ids, coords);
      const mirrored = positions(ids, coords.map((value, i) => i % 3 === 0 ? -value : value));
      mockSidecar(request => request?.type === "createSession" ? [["embed", original]]
        : request?.type === "endDrag" ? [["settle", mirrored]] : []);
      let session = await open(entry, coords);
      session = await beginEngine3dWorkspaceDrag(session, ids[1]);
      session = await endEngine3dWorkspaceDrag(session, ids[1]);
      expect(session.coords3dByAtomId).toEqual(original);
      expect(session.stereo?.warning?.reason).toBe("the stereocenter at C2 would invert");
    });

  it("keeps stereocenters guarded when two different abbreviated ligands both serialize as dummies", async () => {
    const { molecule } = await drawing("F[C@](Cl)(Br)I");
    const coords = (await rdkitConformerGenerator.generate3DConformer(
      { molfile: serializeSpin3dMolfile(molecule) }, { optimize: "none", seed: 42 }
    )).mapping.coords3dByOriginalAtom;
    const labeled = { ...molecule, atoms: molecule.atoms.map((atom, i) => i === 0 ? { ...atom, element: "OMe" }
      : i === 4 ? { ...atom, element: "Ph" } : atom) };
    expect(await canonical(serializeSpin3dMolfile(labeled))).not.toContain("@");
    const stereo = new Spin3dStereoReference(await ensureRdkit(), labeled);
    expect(stereo.checkGeometry(coords)).toBeUndefined();
    expect(stereo.checkGeometry(coords.map((value, i) => i % 3 === 0 ? -value : value)))
      .toBe("the stereocenter at C2 would invert");
  });
});
