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

describe("the NumHydrogens warning uses layout-engine's own count (AGENTS.md §9)", () => {
  it("counts a charged atom by its full charge: NH4+ stated 3 warns, stated 4 does not", () => {
    const ammonium = (stated: number) =>
      `<CDXML><page id="1"><fragment id="2"><n id="10" p="0 0" Element="7" Charge="1" NumHydrogens="${stated}"/></fragment></page></CDXML>`;
    expect(hydrogenWarnings(open(ammonium(4)).result)).toEqual([]);
    const [warning] = hydrogenWarnings(open(ammonium(3)).result);
    expect(warning?.message).toBe("CDXML import: atom 10 (N) states 3 hydrogens; ChemDraft derives 4. The derived count is used.");
  });

  it("Kekulé benzene: a ring CH stated 1 agrees, stated 0 warns; an Order=1.5 ring keeps the stated count unwarned", () => {
    const benzene = (stated: number, orders: string[]) => {
      const nodes = [0, 1, 2, 3, 4, 5].map((index) => {
        const angle = (Math.PI * index) / 3;
        const numH = index === 0 ? ` NumHydrogens="${stated}"` : "";
        return `<n id="${10 + index}" p="${(14 * Math.cos(angle)).toFixed(2)} ${(14 * Math.sin(angle)).toFixed(2)}"${numH}/>`;
      }).join("");
      const bonds = [0, 1, 2, 3, 4, 5].map((index) =>
        `<b id="${20 + index}" B="${10 + index}" E="${10 + ((index + 1) % 6)}" Order="${orders[index % orders.length]}"/>`).join("");
      return `<CDXML><page id="1"><fragment id="2">${nodes}${bonds}</fragment></page></CDXML>`;
    };
    expect(hydrogenWarnings(open(benzene(1, ["1", "2"])).result)).toEqual([]);
    expect(hydrogenWarnings(open(benzene(0, ["1", "2"])).result).map((warning) => warning.message)).toEqual([
      "CDXML import: atom 10 (C) states 0 hydrogens; ChemDraft derives 1. The derived count is used."
    ]);
    const aromatic = open(benzene(0, ["1.5"]));
    expect(hydrogenWarnings(aromatic.result)).toEqual([]);
    expect(aromatic.molecule.atoms[0]?.hydrogenCount).toBe(0);
  });

  it("counts a radical's unpaired electron: a doublet CH2 stated 3 warns", () => {
    const methyl = (stated: number) => `<CDXML><page id="1"><fragment id="2">
      <n id="10" p="0 0" Radical="Doublet" NumHydrogens="${stated}"/><n id="11" p="14 0"/>
      <b id="20" B="10" E="11"/>
    </fragment></page></CDXML>`;
    expect(hydrogenWarnings(open(methyl(2)).result)).toEqual([]);
    expect(hydrogenWarnings(open(methyl(3)).result).map((warning) => warning.message)).toEqual([
      "CDXML import: atom 10 (C) states 3 hydrogens; ChemDraft derives 2. The derived count is used."
    ]);
  });

  it("leaves a carbon bonded only datively alone, whatever it states", () => {
    const carbonyl = `<CDXML><page id="1"><fragment id="2">
      <n id="10" p="0 0" NumHydrogens="0"/><n id="11" p="14 0" Element="26"/>
      <b id="20" B="10" E="11" Order="dative"/>
    </fragment></page></CDXML>`;
    expect(hydrogenWarnings(open(carbonyl).result)).toEqual([]);
  });

  it("keeps no copy of the hydrogen-count calculation in cdx-compat", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/\batomImplicitHydrogenCount\b/);
    expect(source).not.toMatch(/\bnativeAtomValenceForCharge\b/);
    expect(source).not.toMatch(/\bdativeDeprotonationCount\b/);
  });
});
