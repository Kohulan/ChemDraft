import { findV2000CountsLineIndex, parseMolfileGraph, type ParsedMolfileGraph } from "@chemdraft/clipboard-adapter";
import type { ComputeStructureIdentifiers } from "./moleculeSmiles";

export type MolfileStereo = ReadonlyMap<string, string>;
export type MolfileStereoFallback = "unreadable" | "added";

export type MolfileExportIdentifiers = ComputeStructureIdentifiers & {
  molfileStereo?: {
    read: (molfile: string) => Promise<MolfileStereo | undefined>;
    keepSourceCoordinates: (sourceMolfile: string, reason: MolfileStereoFallback) => void;
  };
};

/** Compare the raw source with the exact final CTAB, using the caller's identifier engine.
 * When canonical identities are unavailable, compare the CTAB graph and the reader's
 * assignments on the original and rounded coordinates.
 */
export async function assertMolfileExportIdentity(
  sourceMolfile: string,
  exportedMolfile: string,
  computeStructureIdentifiers: MolfileExportIdentifiers | undefined,
  label: string
): Promise<void> {
  const canonicalSmiles = async (molfile: string): Promise<string | undefined> => {
    try {
      return (await computeStructureIdentifiers?.(molfile))?.smiles || undefined;
    } catch {
      return undefined;
    }
  };
  const source = await canonicalSmiles(sourceMolfile);
  const exported = await canonicalSmiles(exportedMolfile);
  if (source !== undefined && exported !== undefined) {
    if (source !== exported) {
      throw new Error(`${label} refused: exported coordinates would change the structure (${source} became ${exported}).`);
    }
    return;
  }
  if (source !== undefined || exported !== undefined) {
    throw new Error(`${label} refused: the exported structure could not be verified (canonical SMILES available for only one side).`);
  }
  const structure = (molfile: string, side: "source" | "exported") => {
    try {
      const graph = parseMolfileGraph(molfile);
      return { graph, identity: coordinateFreeStructure(molfile, graph) };
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error))
        .replace(/^Clipboard text/, "MOL data").replace(/\.+$/, "");
      throw new Error(`${label} refused: the ${side} MOL could not be read back (${reason}).`);
    }
  };
  const sourceStructure = structure(sourceMolfile, "source");
  const exportedStructure = structure(exportedMolfile, "exported");
  if (sourceMolfile === exportedMolfile) return;
  if (sourceStructure.identity !== exportedStructure.identity) {
    throw new Error(`${label} refused: the exported structure differs from the drawing (coordinate-free MOL atom or bond data differ).`);
  }
  if (!couldEncodeStereo(sourceStructure.graph)) return;
  const stereo = computeStructureIdentifiers?.molfileStereo;
  if (!stereo) {
    throw new Error(`${label} refused: the exported stereochemistry could not be verified (no molfile stereo reader is available).`);
  }

  const sourceStereo = await stereo.read(sourceMolfile);
  const exportedStereo = sourceStereo && await stereo.read(exportedMolfile);
  if (!sourceStereo || !exportedStereo) {
    stereo.keepSourceCoordinates(sourceMolfile, "unreadable");
    return;
  }
  for (const [site, configuration] of sourceStereo) {
    if (exportedStereo.get(site) !== configuration) {
      throw new Error(`${label} refused: exported coordinates would lose or change ${site}.`);
    }
  }
  if (exportedStereo.size > sourceStereo.size) {
    stereo.keepSourceCoordinates(sourceMolfile, "added");
  }
}

function coordinateFreeStructure(molfile: string, graph: ParsedMolfileGraph): string {
  const lines = molfile.replace(/\r\n?/g, "\n").split("\n");
  const radicals = graph.atoms.map(() => 0);
  const bondEncoding: { type: number; stereo: number }[] = [];
  // The clipboard parser owns element/charge/isotope and directed connectivity. Supplement
  // fields it does not expose: MDL radical codes, exact query bond types, and raw stereo flags.
  if (graph.format === "molfile-v2000") {
    const counts = findV2000CountsLineIndex(lines);
    const atomStart = counts + 1;
    for (const [index] of graph.atoms.entries()) {
      // Atom-block charge code 4 denotes a doublet radical.
      radicals[index] = Number(lines[atomStart + index]!.slice(36, 39)) === 4 ? 2 : 0;
    }
    const bondStart = atomStart + graph.atoms.length;
    for (const line of lines.slice(bondStart, bondStart + graph.bonds.length)) {
      bondEncoding.push({ type: Number(line.slice(6, 9)), stereo: Number(line.slice(9, 12)) });
    }
    for (const line of lines.slice(bondStart + graph.bonds.length)) {
      if (line.trim() === "M  END") break;
      const fields = line.trim().split(/\s+/);
      if (fields[0] !== "M" || fields[1] !== "RAD") continue;
      for (let index = 0; index < Number(fields[2]); index++) {
        const atomIndex = Number(fields[3 + index * 2]) - 1;
        if (!graph.atoms[atomIndex]) throw new Error("MOL radical has an invalid atom reference.");
        radicals[atomIndex] = Number(fields[4 + index * 2]);
      }
    }
  } else {
    // Join V3000 continuations before reading attributes; the graph parser does the same.
    let block = lines.filter(line => /^M  V30\s/.test(line)).map(line => line.slice(7)).join("\n");
    block = block.replace(/-\n/g, "");
    let section: "ATOM" | "BOND" | undefined;
    let atomIndex = 0;
    for (const line of block.split("\n")) {
      if (line === "BEGIN ATOM") { section = "ATOM"; continue; }
      if (line === "BEGIN BOND") { section = "BOND"; continue; }
      if (line.startsWith("END ")) { section = undefined; continue; }
      if (section === "ATOM") radicals[atomIndex++] = Number(line.match(/\bRAD=(\d+)\b/)?.[1] ?? 0);
      if (section === "BOND") bondEncoding.push({
        type: Number(line.split(/\s+/)[1]), stereo: Number(line.match(/\bCFG=(\d+)\b/)?.[1] ?? 0)
      });
    }
  }
  const atomIndices = new Map(graph.atoms.map((atom, index) => [atom.id, index]));
  return JSON.stringify({
    atoms: graph.atoms.map((atom, index) => [atom.element, atom.formalCharge, atom.isotope ?? 0, radicals[index]]),
    bonds: graph.bonds.map((bond, index) => {
      const from = atomIndices.get(bond.fromAtomId);
      const to = atomIndices.get(bond.toAtomId);
      if (from === undefined || to === undefined) throw new Error("MOL bond has an invalid atom reference.");
      return [from, to, bond.order, bond.bondStyle ?? null, bond.stereo ?? null, bondEncoding[index]];
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  });
}

function couldEncodeStereo(graph: ParsedMolfileGraph): boolean {
  // Skip reader work if there is no relevant V2000/V3000 encoding in the generated 2D CTAB.
  const degree = new Map<string, number>();
  for (const { fromAtomId, toAtomId } of graph.bonds) {
    degree.set(fromAtomId, (degree.get(fromAtomId) ?? 0) + 1);
    degree.set(toAtomId, (degree.get(toAtomId) ?? 0) + 1);
  }
  return graph.bonds.some(({ fromAtomId, toAtomId, order, bondStyle, stereo }) =>
    (degree.get(fromAtomId) ?? 0) > 1 && (
      bondStyle === "wedge" || bondStyle === "hashed" ||
      (order === "double" && stereo !== "either" && (degree.get(toAtomId) ?? 0) > 1)
    )
  );
}
