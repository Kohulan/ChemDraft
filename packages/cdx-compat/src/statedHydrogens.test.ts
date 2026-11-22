import { describe, expect, it } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles } from "../../document-workflow-core/src/index";
import { openChemDraftPayload } from "./index";

/**
 * An ordinary atom's NumHydrogens is dropped at import and ChemDraft derives the count from valence.
 * Where the file's count and the derived one differ, the file's chemistry changes on open, so the
 * import must say so (AGENTS.md §7) without changing what it imports.
 */
function ethanolCdxml(attributes: { c1?: string; c2?: string; o?: string } = {}): string {
  return `<CDXML><page id="1"><fragment id="2">
    <n id="10" p="0 0" ${attributes.c1 ?? ""}/>
    <n id="11" p="14 8" ${attributes.c2 ?? ""}/>
    <n id="12" p="28 0" Element="8" ${attributes.o ?? ""}/>
    <b id="20" B="10" E="11"/>
    <b id="21" B="11" E="12"/>
  </fragment></page></CDXML>`;
}

function open(cdxml: string) {
  const result = openChemDraftPayload(cdxml);
  const molecule = result.document?.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
  if (!molecule) throw new Error("no molecule imported");
  return { result, molecule };
}

const hydrogenWarnings = (result: ReturnType<typeof openChemDraftPayload>) =>
  result.warnings.filter((warning) => warning.code === "cdxml.atom_hydrogen_count_derived");

function expectEthanol(molecule: MoleculeObject): void {
  expect(molecule.atoms).toHaveLength(3);
  expect(molecule.bonds).toHaveLength(2);
  expect(molecule.atoms.map((atom) => atom.element)).toEqual(["C", "C", "O"]);
  expect(molecule.atoms.every((atom) => atom.hydrogenCount === undefined)).toBe(true);
  expect(nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds)).toBe("CCO");
  expect(nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds).formula).toBe("C2H6O");
}

describe("CDXML NumHydrogens that disagrees with the derived count", () => {
  it("warns about the O stated with 0 hydrogens and still imports ethanol", () => {
    const { result, molecule } = open(ethanolCdxml({ o: 'NumHydrogens="0"' }));
    expectEthanol(molecule);
    const warnings = hydrogenWarnings(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toBe("CDXML import: atom 12 (O) states 0 hydrogens; ChemDraft derives 1. The derived count is used.");
    expect(warnings[0].sourceObjectId).toBe(molecule.id);
    expect(warnings[0].atomIds).toEqual([molecule.atoms[2].id]);
  });

  it("gives no warning where the stated counts agree with the derived ones", () => {
    const { result, molecule } = open(ethanolCdxml({ c1: 'NumHydrogens="3"', c2: 'NumHydrogens="2"', o: 'NumHydrogens="1"' }));
    expectEthanol(molecule);
    expect(hydrogenWarnings(result)).toEqual([]);
  });

  it("gives no warning and imports the same ethanol when the file states no counts", () => {
    const stated = open(ethanolCdxml({ o: 'NumHydrogens="0"' }));
    const { result, molecule } = open(ethanolCdxml());
    expectEthanol(molecule);
    expect(hydrogenWarnings(result)).toEqual([]);
    expect(molecule.atoms).toEqual(stated.molecule.atoms);
    expect(molecule.bonds).toEqual(stated.molecule.bonds);
    expect(result.warnings).toEqual(stated.result.warnings.filter((warning) => warning.code !== "cdxml.atom_hydrogen_count_derived"));
  });

  it("names every disagreeing atom of a fragment in one warning", () => {
    const { result, molecule } = open(ethanolCdxml({ c1: 'NumHydrogens="2"', o: 'NumHydrogens="0"' }));
    expectEthanol(molecule);
    const warnings = hydrogenWarnings(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toBe(
      "CDXML import: 2 atoms state hydrogen counts ChemDraft derives differently: atom 10 (C) states 2, derives 3; " +
      "atom 12 (O) states 0, derives 1. The derived counts are used."
    );
    expect(warnings[0].atomIds).toEqual([molecule.atoms[0].id, molecule.atoms[2].id]);
  });
});
