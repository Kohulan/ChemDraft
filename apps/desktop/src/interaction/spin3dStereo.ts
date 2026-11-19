import { moleculeToMolfileV2000, moleculeToMolfileV3000, type MoleculeObject, type ViewMatrix } from "@chemdraft/chem-core";
import { expandNativeMoleculeLabelGroups, nativeSingleHeavyElementLabelValence } from "@chemdraft/document-workflow-core";
import { nativeBondOrderResolution, nativeElementFromAtomLabel } from "@chemdraft/layout-engine";
import type { RdkitJsMol, RdkitMinimalModule } from "@chemdraft/rdkit-adapter";
import { parity, stereoGraph, stereoNeighbors } from "../chemistry3d/stereo";
import { projectPoint, type Vec3 } from "./rotation3d";

type Sign = -1 | 0 | 1;
type BondStereo = {
  id: string;
  label: string;
  ends: readonly [number, number];
  ligands?: readonly [number, number];
  substituents: readonly [readonly number[], readonly number[]];
  sign: Sign;
  descriptor?: "E" | "Z";
};
type CenterStereo = { index: number; label: string; neighbors: number[]; sign: number };
type StereoSnapshot = { bonds: BondStereo[]; centers: CenterStereo[]; canonicalSmiles: string };

// Reject nearly collinear ligands and collapsed three-ligand stereocenters.
// Confirm all tetrahedral frames and marginal double-bond geometry with RDKit.
const minLigandSine = Math.sin(2 * Math.PI / 180);
const borderlineLigandSine = Math.sin(10 * Math.PI / 180);
const minSignedVolume = 0.06;
const borderlineStereoMagnitude = 0.2;

export type Spin3dStereoIssue = {
  message: string;
  bond?: BondStereo;
  centerIndex?: number;
  kind: "lost" | "changed" | "gained";
};

export function hasSpin3dStereoCandidates(molecule: MoleculeObject): boolean {
  // Let RDKit decide which double bonds are stereogenic, including in small rings.
  return molecule.bonds.some(bond => bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed" ||
    (bond.order === "double" && bond.stereo !== "either"));
}

export function serializeSpin3dMolfile(molecule: MoleculeObject, warnings?: string[], abbreviations?: "rgroup"): string {
  const write = molecule.atoms.length > 999 || molecule.bonds.length > 999
    ? moleculeToMolfileV3000 : moleculeToMolfileV2000;
  return write(molecule, {
    fromDocFrame: true,
    warnings,
    abbreviations,
    kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders
  }).contents;
}

function spin3dExportGraph(source: MoleculeObject) {
  const { molecule, expansions, placeholderAtoms } = expandNativeMoleculeLabelGroups(source);
  const options = {
    fromDocFrame: true,
    spellLabel: nativeSingleHeavyElementLabelValence,
    kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders,
    placeholderAtoms
  };
  const write = molecule.atoms.length > 999 || molecule.bonds.length > 999
    ? moleculeToMolfileV3000 : moleculeToMolfileV2000;
  return { molecule, expansions, options, molfile: write(molecule, options).contents };
}

/** RDKit reads the export graph with the drawn atoms still in their original order. */
export class Spin3dStereoReference {
  private readonly stored: StereoSnapshot;
  private readonly exported: StereoSnapshot;
  private readonly labeled?: StereoSnapshot;
  private readonly geometry: StereoSnapshot;
  private readonly geometryGraph: MoleculeObject;
  private readonly expandedAtoms: { owner: number; offset: Vec3 }[];
  private readonly geometryMolfile: string[];
  private readonly firstAtomLine: number;
  private readonly hasSpecifiedGeometry: boolean;
  readonly specifiedDoubleBondIds: ReadonlySet<string>;

  constructor(private readonly rdkit: RdkitMinimalModule, readonly source: MoleculeObject) {
    const storedMolfile = serializeSpin3dMolfile(source);
    const { molecule, expansions, options, molfile } = spin3dExportGraph(source);
    this.stored = this.read(storedMolfile);
    this.exported = molfile === storedMolfile ? this.stored : this.read(molfile, molecule);
    // Remaining placeholders can be distinguished by the existing perception spelling.
    if (molecule.atoms.some(atom => nativeElementFromAtomLabel(atom.element) === undefined &&
        !nativeSingleHeavyElementLabelValence(atom.element))) {
      this.labeled = this.read(moleculeToMolfileV3000(molecule, { ...options, abbreviations: "rgroup" }).contents, molecule);
    }
    this.geometry = this.labeled ?? this.exported;
    this.geometryGraph = molecule;
    const indices = new Map(molecule.atoms.map((atom, i) => [atom.id, i]));
    this.expandedAtoms = [];
    for (const { atomId, atomIds } of expansions) {
      const owner = indices.get(atomId)!;
      const anchor = molecule.atoms[owner];
      for (const id of atomIds.slice(1)) {
        const index = indices.get(id)!;
        const atom = molecule.atoms[index];
        this.expandedAtoms[index - source.atoms.length] = {
          owner, offset: [(atom.x - anchor.x) / 20, (anchor.y - atom.y) / 20, 0]
        };
      }
    }
    this.specifiedDoubleBondIds = new Set(this.geometry.bonds.filter(bond => bond.sign !== 0).map(bond => bond.id));
    this.hasSpecifiedGeometry = this.specifiedDoubleBondIds.size > 0 || this.geometry.centers.some(center => center.sign !== 0);
    // Keep the native writer's atom types, valences, isotopes, radicals and bond
    // orders. Remove drawn wedges so the read-back uses only the 3D coordinates.
    const graph = { ...molecule, bonds: molecule.bonds.map(bond =>
      bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed"
        ? { ...bond, display: { ...bond.display, bondStyle: undefined } }
        : bond) };
    this.geometryMolfile = moleculeToMolfileV3000(graph, {
      ...options, fromDocFrame: false, abbreviations: this.labeled ? "rgroup" : undefined
    }).contents.split("\n");
    this.geometryMolfile[1] = "  ChemDraft         3D";
    this.firstAtomLine = this.geometryMolfile.indexOf("M  V30 BEGIN ATOM") + 1;
  }

  private read(molfile: string, molecule = this.source): StereoSnapshot {
    const mol = this.rdkit.get_mol(molfile, JSON.stringify({ removeHs: false }));
    if (!mol) throw new Error("RDKit couldn't verify the drawing's stereochemistry.");
    try {
      const graph = stereoGraph(mol);
      if (graph.atoms.length !== molecule.atoms.length) {
        throw new Error("RDKit returned a different atom count during stereo verification.");
      }
      const atomIndex = new Map(molecule.atoms.map((atom, i) => [atom.id, i]));
      const atomLabel = (i: number) => `${this.source.atoms[i]?.element ?? molecule.atoms[i].element}${i + 1}`;
      const key = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
      const graphBonds = new Map(graph.bonds.map(bond => [key(...bond.atoms), bond]));
      const neighbors = graph.atoms.map((): number[] => []);
      for (const { atoms: [a, b] } of graph.bonds) {
        neighbors[a].push(b);
        neighbors[b].push(a);
      }
      const tags = JSON.parse((mol as RdkitJsMol & { get_stereo_tags(): string }).get_stereo_tags()) as {
        CIP_bonds?: [number, number, string][];
      };
      const cip = new Map(tags.CIP_bonds?.map(([a, b, label]) => [key(a, b), label]));
      const bonds = molecule.bonds.flatMap((bond): BondStereo[] => {
        if (bond.order !== "double") return [];
        const a = atomIndex.get(bond.fromAtomId)!;
        const b = atomIndex.get(bond.toAtomId)!;
        const found = graphBonds.get(key(a, b));
        if (!found) throw new Error(`RDKit couldn't map double bond ${atomLabel(a)}=${atomLabel(b)}.`);
        const [from, to] = found.atoms;
        const sign = found.stereo === "cis" ? 1 : found.stereo === "trans" ? -1 : 0;
        const [left, right] = found.stereoAtoms ?? [];
        const tag = cip.get(key(from, to));
        return [{
          id: bond.id, label: `${atomLabel(a)}=${atomLabel(b)}`, ends: found.atoms, sign,
          substituents: [neighbors[from].filter(i => i !== to), neighbors[to].filter(i => i !== from)],
          ligands: left === undefined || right === undefined ? undefined : [left, right],
          descriptor: tag === "(E)" ? "E" : tag === "(Z)" ? "Z" : undefined
        }];
      });
      const centers = graph.atoms.map((atom, index): CenterStereo => {
        const neighbors = atom.stereo === "cw" || atom.stereo === "ccw" ? stereoNeighbors(graph, index) : [];
        return { index, label: atomLabel(index), neighbors: neighbors.slice().sort((a, b) => a - b),
          sign: neighbors.length ? parity(graph, index, neighbors) : 0 };
      });
      return { bonds, centers, canonicalSmiles: mol.get_smiles!() };
    } finally {
      mol.delete();
    }
  }

  checkIdentity(molecule: MoleculeObject): string | undefined {
    const actual = this.read(molecule.structure);
    const issue = this.compare(molecule, actual)[0];
    if (issue) return issue.message;
    const exported = spin3dExportGraph(molecule);
    if (this.read(exported.molfile, exported.molecule).canonicalSmiles !== this.exported.canonicalSmiles) {
      return "the expanded export's canonical SMILES would change";
    }
    const serialized = serializeSpin3dMolfile(molecule);
    if (serialized !== molecule.structure) {
      const native = this.read(serialized);
      const nativeIssue = this.compareSnapshots(this.stored, native)[0];
      if (nativeIssue) return nativeIssue.message;
      if (native.canonicalSmiles !== this.stored.canonicalSmiles) return "the canonical SMILES would change";
    }
    return actual.canonicalSmiles !== this.stored.canonicalSmiles ? "the canonical SMILES would change" : undefined;
  }

  compare(molecule: MoleculeObject, actual = this.read(molecule.structure)): Spin3dStereoIssue[] {
    const exported = spin3dExportGraph(molecule);
    if (exported.molecule.atoms.length !== this.geometryGraph.atoms.length ||
        exported.molecule.atoms.some((atom, i) => atom.id !== this.geometryGraph.atoms[i].id ||
          atom.element !== this.geometryGraph.atoms[i].element) ||
        exported.molecule.bonds.length !== this.geometryGraph.bonds.length ||
        exported.molecule.bonds.some((bond, i) => bond.id !== this.geometryGraph.bonds[i].id ||
          bond.order !== this.geometryGraph.bonds[i].order)) {
      throw new Error("the atom-label expansion would change during stereo verification");
    }
    const stored = this.compareSnapshots(this.stored, actual);
    const expanded = this.compareSnapshots(this.exported, exported.molfile === molecule.structure
      ? actual : this.read(exported.molfile, exported.molecule));
    const labeled = this.labeled ? this.compareSnapshots(this.labeled, this.read(
      moleculeToMolfileV3000(exported.molecule, { ...exported.options, abbreviations: "rgroup" }).contents, exported.molecule
    )) : [];
    return [...expanded, ...labeled, ...stored].filter((issue, index, issues) => !issues.slice(0, index).some(other =>
      issue.kind === other.kind && issue.centerIndex === other.centerIndex && issue.bond?.id === other.bond?.id));
  }

  private compareSnapshots(reference: StereoSnapshot, actual: StereoSnapshot): Spin3dStereoIssue[] {
    const issues: Spin3dStereoIssue[] = [];
    for (const [i, expected] of reference.bonds.entries()) {
      const found = actual.bonds[i];
      let sign = found.sign;
      // RDKit can select a different reference ligand or reverse the bond traversal.
      if (expected.ligands && found.ligands) {
        for (const [end, atom] of expected.ends.entries()) {
          if (expected.ligands[end] !== found.ligands[found.ends.indexOf(atom)]) sign = -sign as Sign;
        }
      }
      if (sign === expected.sign) continue;
      if (!expected.sign) {
        issues.push({ kind: "gained", bond: expected, message: `the ${expected.label} double bond would gain an E/Z assignment` });
      } else {
        const kind = sign === 0 ? "lost" : "changed";
        issues.push({ kind, bond: expected, message: this.doubleBondChange(expected, kind) });
      }
    }
    for (const center of reference.centers) {
      const sign = actual.centers[center.index].sign;
      if (sign === center.sign) continue;
      const kind = !center.sign ? "gained" : !sign ? "lost" : "changed";
      const change = kind === "gained" ? "gain a stereo assignment" : kind === "lost" ? "lose its stereo assignment" : "invert";
      issues.push({ kind, centerIndex: center.index, message: `the stereocenter at ${center.label} would ${change}` });
    }
    return issues;
  }

  checkGeometry(coords: ArrayLike<number>, confirm = false): string | undefined {
    if (coords.length !== this.source.atoms.length * 3) return "the atom coordinates don't match the drawing";
    if (!this.hasSpecifiedGeometry) return undefined;
    const drawnCount = this.source.atoms.length;
    const hiddenPoints = this.expandedAtoms.map(({ owner, offset }) => {
      const [x, y, z] = pointAt(coords, owner);
      return [x + offset[0], y + offset[1], z + offset[2]] as Vec3;
    });
    const point = (index: number) => index < drawnCount ? pointAt(coords, index) : hiddenPoints[index - drawnCount];
    if (hiddenPoints.length) {
      for (const bond of this.geometry.bonds) {
        if (!bond.sign) continue;
        if (bond.ends.some(index => index >= drawnCount)) return this.doubleBondChange(bond, "lost");
        for (const [end, indices] of bond.substituents.entries()) {
          const hidden = indices.find(index => index >= drawnCount);
          if (hidden === undefined) continue;
          const visible = indices.find(index => index < drawnCount);
          if (indices.length !== 2 || visible === undefined) return this.doubleBondChange(bond, "lost");
          const origin = point(bond.ends[end]);
          const axis = unit(subtract(point(bond.ends[1 - end]), origin));
          const ligand = unit(subtract(point(visible), origin));
          // Complete the trigonal center from the two drawn 3D rays. This puts the
          // hidden ligand on the opposite side of the axis in the same local plane.
          // The geometry check below still rejects collinear or twisted frames.
          hiddenPoints[hidden - drawnCount] = [
            origin[0] - axis[0] - ligand[0], origin[1] - axis[1] - ligand[1], origin[2] - axis[2] - ligand[2]
          ];
        }
      }
    }
    let borderline = false;
    const doubleBondIssue = this.checkDoubleBondGeometry(point, minLigandSine, () => { borderline = true; });
    if (doubleBondIssue) return doubleBondIssue;
    for (const center of this.geometry.centers) {
      if (!center.sign) continue;
      const hidden = center.neighbors.filter(index => index >= drawnCount);
      if (center.neighbors.length < 3 || center.neighbors.length > 4) {
        return `the stereocenter at ${center.label} has unsupported 3D coordination`;
      }
      if (center.index >= drawnCount || (hidden.length && (hidden.length !== 1 || center.neighbors.length !== 4))) {
        return `the stereocenter at ${center.label} has label ligands whose 3D positions cannot be verified`;
      }
      if (hidden.length === 1) {
        // A single undrawn ligand occupies the missing tetrahedral direction, as
        // an implicit H would. The three drawn rays determine its handedness.
        const origin = point(center.index);
        const [a, b, c] = center.neighbors.filter(index => index < drawnCount)
          .map(index => unit(subtract(point(index), origin)));
        hiddenPoints[hidden[0] - drawnCount] = [
          origin[0] - a[0] - b[0] - c[0], origin[1] - a[1] - b[1] - c[1], origin[2] - a[2] - b[2] - c[2]
        ];
      }
      const ligands = center.neighbors.map(index => unit(subtract(point(index), point(center.index))));
      for (const [i, ligand] of ligands.entries()) {
        for (const other of ligands.slice(i + 1)) {
          const sine = Math.hypot(...cross(ligand, other));
          if (sine < minLigandSine) return `the stereocenter at ${center.label} would lose its stereo assignment`;
        }
      }
      const [a, b, c, d] = ligands;
      const volume = -dot(cross(a, b), c);
      if (!d) {
        const actual = Math.abs(volume) < minSignedVolume ? 0 : signOf(volume);
        if (actual !== center.sign) {
          return `the stereocenter at ${center.label} would ${actual ? "invert" : "lose its stereo assignment"}`;
        }
      } else {
        // All four ligand faces agree when the center lies within the tetrahedron.
        // If a face crosses the center, let RDKit decide what the distorted frame encodes.
        const faces = [volume, dot(cross(a, b), d), -dot(cross(a, c), d), dot(cross(b, c), d)];
        if (faces.every(face => face * center.sign < -minSignedVolume)) {
          return `the stereocenter at ${center.label} would invert`;
        }
      }
      confirm = true;
    }
    if (!borderline && !confirm) return undefined;
    const lines = this.geometryMolfile.slice();
    for (let i = 0; i < this.geometryGraph.atoms.length; i++) {
      const line = this.firstAtomLine + i;
      lines[line] = lines[line].replace(/^(M  V30 \d+ \S+) \S+ \S+ \S+/, `$1 ${point(i).join(" ")}`);
    }
    try {
      return this.compareSnapshots(this.geometry, this.read(lines.join("\n"), this.geometryGraph))
        .find(issue => issue.kind !== "gained")?.message;
    } catch {
      return "RDKit couldn't verify the 3D stereochemistry";
    }
  }

  checkProjectedDoubleBonds(coords: ArrayLike<number>, view: ViewMatrix): string | undefined {
    return this.checkDoubleBondGeometry(projectedPoints(coords, view), undefined, undefined, this.source.atoms.length);
  }

  private checkDoubleBondGeometry(
    point: (index: number) => Vec3, minSine = 1e-6, markBorderline?: () => void, atomCount = Infinity
  ): string | undefined {
    for (const bond of this.geometry.bonds) {
      if (!bond.sign) continue;
      if ([...bond.ends, ...bond.substituents.flat()].some(index => index >= atomCount)) continue;
      if (!bond.ligands) return this.doubleBondChange(bond, "lost");
      const [a, b] = bond.ends;
      const axis = unit(subtract(point(b), point(a)));
      const normals = bond.substituents.map((indices, end) => indices.map(index => {
        const normal = cross(axis, unit(subtract(point(index), point(bond.ends[end]))));
        const sine = Math.hypot(...normal);
        if (sine < borderlineLigandSine) markBorderline?.();
        return { index, normal: sine < minSine ? undefined : unit(normal) };
      }));
      if (!normals[0].length || !normals[1].length) return this.doubleBondChange(bond, "lost");
      for (const left of normals[0]) {
        for (const right of normals[1]) {
          const cosine = left.normal && right.normal ? dot(left.normal, right.normal) : 0;
          const expected = bond.sign * (left.index === bond.ligands[0] ? 1 : -1) *
            (right.index === bond.ligands[1] ? 1 : -1);
          const sign = signOf(cosine);
          if (sign !== expected) return this.doubleBondChange(bond, sign === 0 ? "lost" : "changed");
          if (Math.abs(cosine) < borderlineStereoMagnitude) markBorderline?.();
        }
      }
    }
    return undefined;
  }

  private doubleBondChange(bond: BondStereo, kind: "lost" | "changed"): string {
    return `the ${bond.label} double bond would ${kind === "lost" ? "lose" : "change"} its ${bond.descriptor ?? "E/Z"} geometry`;
  }
}

function pointAt(coords: ArrayLike<number>, index: number): Vec3 {
  return [coords[index * 3], coords[index * 3 + 1], coords[index * 3 + 2]];
}
function projectedPoints(coords: ArrayLike<number>, view: ViewMatrix): (index: number) => Vec3 {
  return index => {
    const [x, y] = projectPoint(view, pointAt(coords, index));
    return [x, y, 0];
  };
}
function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function unit(v: Vec3): Vec3 {
  const length = Math.hypot(...v);
  return length > 1e-10 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 0];
}
function signOf(v: number): Sign {
  return v > 1e-8 ? 1 : v < -1e-8 ? -1 : 0;
}
function doubleBondSign([a, b]: readonly [number, number], [left, right]: readonly [number, number],
  point: (index: number) => Vec3): Sign {
  const axis = unit(subtract(point(b), point(a)));
  const lhs = unit(cross(axis, unit(subtract(point(left), point(a)))));
  const rhs = unit(cross(axis, unit(subtract(point(right), point(b)))));
  // Cosine of the signed dihedral. Its sign changes at ±90°, separating cis and trans.
  return signOf(dot(lhs, rhs));
}

/** E/Z is geometry-encoded in the native graph. If RDKit lost it solely because a
 * projected ligand was nearly collinear, move that ligand a small distance on its
 * existing side. The caller reruns the full flatten (including wedges and crossings)
 * and verifies the resulting molfile before accepting this depiction. */
export function separateProjectedStereoLigands(
  coords: ArrayLike<number>, view: ViewMatrix, issues: readonly Spin3dStereoIssue[], degrees: number
): Float64Array | undefined {
  const next = Float64Array.from(coords);
  const point = projectedPoints(coords, view);
  const minSide = Math.sin(degrees * Math.PI / 180);
  let changed = false;
  for (const issue of issues) {
    const bond = issue.bond;
    if (issue.kind !== "lost" || !bond?.ligands || doubleBondSign(bond.ends, bond.ligands, point) !== bond.sign) {
      return undefined;
    }
    const axis = unit(subtract(point(bond.ends[1]), point(bond.ends[0])));
    const normal: Vec3 = [-axis[1], axis[0], 0];
    for (const [end, index] of bond.ligands.entries()) {
      const ligand = subtract(point(index), point(bond.ends[end]));
      const side = dot(ligand, normal);
      const delta = Math.max(0, Math.hypot(...ligand) * minSide - Math.abs(side)) * Math.sign(side);
      if (!delta) continue;
      for (let component = 0; component < 3; component++) {
        next[index * 3 + component] += delta * (normal[0] * view[component] + normal[1] * view[4 + component]);
      }
      changed = true;
    }
  }
  return changed ? next : undefined;
}
