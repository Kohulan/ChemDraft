import type { MoleculeObject } from "@chemdraft/chem-core";
import { stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import type {
  perceiveDoubleBondStereoFromMolfile,
  perceiveStereoCentersFromMolfile
} from "@chemdraft/ocl-adapter";

/**
 * Read-only CIP readout for the canvas context menu ("Stereocentre: R", "Double bond: E").
 *
 * The descriptor always comes from the same OpenChemLib perceivers the app and the CLI
 * `stereo` command use (`@chemdraft/ocl-adapter`), run on the same `stereoPerceptionMolfile`
 * the flatten and layout read-back guards use. Nothing here assigns CIP priorities. A label is
 * produced only when the engine reports a defined R/S or E/Z; anything else (not stereogenic,
 * unspecified, an "either" double bond, a drawing the molfile writer refuses, an engine
 * failure) yields no label, so the menu never shows a guess.
 */
export interface StereoEngine {
  perceiveStereoCentersFromMolfile: typeof perceiveStereoCentersFromMolfile;
  perceiveDoubleBondStereoFromMolfile: typeof perceiveDoubleBondStereoFromMolfile;
}

export type StereoReadoutTarget =
  | { molecule: MoleculeObject; atomId: string }
  | { molecule: MoleculeObject; bondId: string };

export type StereoReadoutPart =
  | { kind: "atom"; atomId: string }
  | { kind: "bond"; bondId: string }
  | { kind: string };

/** The readout target for a single right-clicked atom or bond; undefined for anything else. */
export function stereoReadoutTargetFromPart(
  molecule: MoleculeObject | undefined, part: StereoReadoutPart | undefined
): StereoReadoutTarget | undefined {
  if (!molecule || !part) return undefined;
  if (part.kind === "atom" && "atomId" in part) return { molecule, atomId: part.atomId };
  if (part.kind === "bond" && "bondId" in part) return { molecule, bondId: part.bondId };
  return undefined;
}

/** Synchronous readout against an already loaded engine. Never throws. */
export function stereoReadoutLabel(target: StereoReadoutTarget, engine: StereoEngine): string | undefined {
  const { molecule } = target;
  try {
    if ("atomId" in target) {
      const index = molecule.atoms.findIndex(atom => atom.id === target.atomId);
      if (index < 0) return undefined;
      // Index-aligned to molecule.atoms: stereoPerceptionMolfile writes atoms in document order.
      const center = engine.perceiveStereoCentersFromMolfile(stereoPerceptionMolfile(molecule))[index];
      if (!center?.isStereoCenter) return undefined;
      return center.descriptor === "R" || center.descriptor === "S" ? `Stereocentre: ${center.descriptor}` : undefined;
    }
    const bond = molecule.bonds.find(candidate => candidate.id === target.bondId);
    // An "either" (crossed/wavy) double bond is drawn as unspecified; respect it even if the
    // coordinates happen to look E or Z.
    if (!bond || bond.order !== "double" || bond.stereo === "either") return undefined;
    const from = molecule.atoms.findIndex(atom => atom.id === bond.fromAtomId);
    const to = molecule.atoms.findIndex(atom => atom.id === bond.toAtomId);
    if (from < 0 || to < 0) return undefined;
    const perceived = engine.perceiveDoubleBondStereoFromMolfile(stereoPerceptionMolfile(molecule))
      .find(entry => (entry.from === from && entry.to === to) || (entry.from === to && entry.to === from));
    return perceived?.descriptor === "E" || perceived?.descriptor === "Z" ? `Double bond: ${perceived.descriptor}` : undefined;
  } catch {
    // Query bonds (refused by the molfile writer) or an engine failure: show nothing.
    return undefined;
  }
}

type StereoEngineImporter = () => Promise<StereoEngine>;
const defaultImporter: StereoEngineImporter = () => import("@chemdraft/ocl-adapter");
let enginePromise: Promise<StereoEngine> | undefined;

/** Lazily loads the stereo engine once (§13). A failed load is retried on the next request. */
export function loadStereoEngine(importer: StereoEngineImporter = defaultImporter): Promise<StereoEngine> {
  enginePromise ??= importer().catch(error => {
    enginePromise = undefined;
    throw error;
  });
  return enginePromise;
}

/** Test hook: forget the cached engine load. */
export function resetStereoEngineForTests(): void {
  enginePromise = undefined;
}

/** Loads the engine if needed and resolves the label, or undefined when there is none or the
 * engine is unavailable. Never rejects, so a menu can await it without a failure path. */
export async function resolveStereoReadout(
  target: StereoReadoutTarget | undefined, load: () => Promise<StereoEngine> = loadStereoEngine
): Promise<string | undefined> {
  if (!target) return undefined;
  try {
    return stereoReadoutLabel(target, await load());
  } catch {
    return undefined;
  }
}

/** A readout callback for the context menu, or undefined when the target cannot carry one. */
export function stereoReadoutRequest(
  molecule: MoleculeObject | undefined, part: StereoReadoutPart | undefined,
  load?: () => Promise<StereoEngine>
): (() => Promise<string | undefined>) | undefined {
  const target = stereoReadoutTargetFromPart(molecule, part);
  return target ? () => resolveStereoReadout(target, load) : undefined;
}
