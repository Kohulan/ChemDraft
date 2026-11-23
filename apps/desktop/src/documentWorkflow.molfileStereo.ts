import type { ComputeStructureIdentifiers, MolfileExportIdentifiers, MolfileStereo, MolfileStereoFallback } from "@chemdraft/document-workflow-core";
import type { RdkitJsMol } from "@chemdraft/rdkit-adapter";

async function readMolfileStereo(molfile: string): Promise<MolfileStereo | undefined> {
  try {
    // Identifier loading registers this same RDKit instance. Retain explicit H so its stereo
    // atom indices still refer to the original CTAB. Query records can report stereo here.
    const { ensureRdkit } = await import("@chemdraft/rdkit-adapter");
    const rdkit = await ensureRdkit();
    const mol = rdkit.get_mol(molfile, JSON.stringify({ removeHs: false })) as
      (RdkitJsMol & { get_stereo_tags?(): string }) | null;
    if (!mol) return undefined;
    try {
      const encoded = mol.get_stereo_tags?.();
      if (!encoded) return undefined;
      const tags = JSON.parse(encoded) as {
        CIP_atoms: [number, string][];
        CIP_bonds: [number, number, string][];
      };
      const stereo = new Map<string, string>();
      for (const [atom, configuration] of tags.CIP_atoms) {
        if (configuration !== "(?)") stereo.set(`tetrahedral stereo at atom ${atom + 1}`, configuration);
      }
      for (const [from, to, configuration] of tags.CIP_bonds) {
        if (/^\([EZez]\)$/.test(configuration)) {
          stereo.set(`E/Z stereo at bond ${Math.min(from, to) + 1}–${Math.max(from, to) + 1}`, configuration);
        }
      }
      return stereo;
    } finally {
      mol.delete();
    }
  } catch {
    return undefined;
  }
}

export function identifiersWithMolfileStereo(
  identifiers: ComputeStructureIdentifiers | undefined,
  keepSourceCoordinates: (sourceMolfile: string, reason: MolfileStereoFallback) => void
): MolfileExportIdentifiers {
  return Object.assign(async (...args: Parameters<ComputeStructureIdentifiers>) => identifiers?.(...args), {
    molfileStereo: { read: readMolfileStereo, keepSourceCoordinates }
  });
}

export const sourceCoordinateWarnings = {
  unreadable: {
    code: "export.mol_stereo_unverified",
    message: "MOL export kept the drawing coordinates because the structure engine could not verify stereochemistry."
  },
  added: {
    code: "export.mol_stereo_added",
    message: "MOL export kept the drawing coordinates because scaling would introduce stereochemistry."
  }
};
