/**
 * The stereochemistry labels stored in a molecule's chemistry record, and how to read them back.
 * Imports nothing, so `@chemdraft/rdkit-adapter/constants` can re-export it without loading the engine.
 */

/** The note for centres the drawing left unassigned: "1 unspecified stereocenter", "2 unspecified stereocenters". */
function unspecifiedStereocenterNote(count: number): string {
  return `${count} unspecified stereocenter${count === 1 ? "" : "s"}`;
}

/** CIP descriptors as RDKit perceived them, plus a note for centres the drawing left unassigned. */
export function stereochemistryLabels(stereoTagsJson: string, unspecifiedCentres: number): string[] {
  let tags: { CIP_atoms?: [number, string][]; CIP_bonds?: [number, number, string][] } = {};
  try {
    tags = JSON.parse(stereoTagsJson) as typeof tags;
  } catch {
    return [];
  }
  // RDKit tags an unassigned centre "(?)". The unspecified count below already says how many there
  // are, so emitting both would report the same gap twice in two different vocabularies.
  const assigned = (descriptor: string): boolean => descriptor !== "(?)";
  const labels = [
    ...(tags.CIP_atoms ?? [])
      .filter(([, descriptor]) => assigned(descriptor))
      .map(([atom, descriptor]) => `atom ${atom} ${descriptor}`),
    // A CIP_bonds entry is a FLAT triple — `[16, 17, "(E)"]` — not `[atoms[], descriptor]` the way a
    // CIP_atoms entry is `[atom, descriptor]`. Read as a pair it took atom 17 for the descriptor,
    // which is never "(?)" so it always passed the filter, and then called `.join` on a number.
    // Every molecule with an assigned double-bond stereocentre threw out of the whole analysis run;
    // `C/C=C/C` was enough. Found by the SAMPL6 end-to-end benchmark, which is the first thing here
    // that fed the pipeline arbitrary drug-like structures instead of chosen ones.
    ...(tags.CIP_bonds ?? [])
      .filter(([, , descriptor]) => assigned(descriptor))
      .map(([begin, end, descriptor]) => `bond ${begin}-${end} ${descriptor}`)
  ];
  if (unspecifiedCentres > 0) {
    labels.push(unspecifiedStereocenterNote(unspecifiedCentres));
  }
  return labels;
}

/**
 * True when a stored stereochemistry label records stereo that was actually assigned (a CIP
 * descriptor), false for the unassigned-centre note `stereochemistryLabels` appends. A format that
 * cannot write stereo loses nothing by dropping that note: the unassigned centre stays unassigned.
 * Any label this module did not write counts as assigned, so an unfamiliar record still warns.
 */
export function isAssignedStereochemistryLabel(label: string): boolean {
  const count = /^[1-9]\d*(?= )/.exec(label)?.[0];
  return count === undefined || label !== unspecifiedStereocenterNote(Number(count));
}
