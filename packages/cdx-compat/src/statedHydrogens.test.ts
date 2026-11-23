import { describe, expect, it } from "vitest";
import { DefaultNativeDrawingStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { atomDisplayLabel } from "@chemdraft/layout-engine";
import {
  nativeAtomValidationState,
  nativeMoleculeExportWarnings,
  nativeSingleBondGraphMetadata,
  nativeSingleBondGraphSmiles
} from "../../document-workflow-core/src/index";
import { exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload } from "./index";

/**
 * Owner ruling (1.2.3): a NumHydrogens on an ordinary atom that disagrees with the count ChemDraft
 * derives is kept exactly as written, and the atom is badged like any under- or over-filled atom.
 * The import says so (AGENTS.md §7: never a silent chemistry change). A count that agrees is not
 * stored (the atom already counts it), and a file without NumHydrogens opens exactly as before.
 *
 * What the model does with a kept count on an atom with no aromatic bond: the atom carries it
 * (`hydrogenCount`), validation badges it, CDXML and CDX write it back, and an export warns. The
 * drawn label, the formula, the mass and SMILES count the STATED hydrogens, exactly as for the same
 * atom made under-filled by hand (a typed literal "O"): chem-core's `atomStatedHydrogenCount`, which
 * the molfile writer carries to RDKit in the typed label's own explicit-valence field. The badge
 * compares it with the derived count (layout-engine's `atomImplicitHydrogenCount`).
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
  return { result, molecule: moleculeOf(result) };
}

function moleculeOf(result: { document?: { pages: { objects: unknown[] }[] } }): MoleculeObject {
  const molecule = result.document?.pages[0]!.objects.find((object): object is MoleculeObject =>
    (object as MoleculeObject).type === "molecule");
  if (!molecule) throw new Error("no molecule imported");
  return molecule;
}

const hydrogenWarnings = (result: ReturnType<typeof openChemDraftPayload>) =>
  result.warnings.filter((warning) => warning.code === "cdxml.atom_hydrogen_count_kept");

const hydrogenCounts = (molecule: MoleculeObject) => molecule.atoms.map((atom) => atom.hydrogenCount);

const labels = (molecule: MoleculeObject) => molecule.atoms.map((atom) =>
  atomDisplayLabel(atom, molecule.bonds, DefaultNativeDrawingStyle, molecule.atoms));

const badges = (molecule: MoleculeObject) => molecule.atoms.flatMap((atom) => {
  const state = nativeAtomValidationState(atom, molecule.bonds, atom.formalCharge, molecule.atoms);
  return state.valid ? [] : [[atom.id, state.invalidReason]];
});

function expectEthanolGraph(molecule: MoleculeObject): void {
  expect(molecule.atoms).toHaveLength(3);
  expect(molecule.bonds).toHaveLength(2);
  expect(molecule.atoms.map((atom) => atom.element)).toEqual(["C", "C", "O"]);
}

describe("CDXML NumHydrogens that disagrees with the derived count", () => {
  it("keeps the O stated with 0 hydrogens, badges it and says so", () => {
    const { result, molecule } = open(ethanolCdxml({ o: 'NumHydrogens="0"' }));
    expectEthanolGraph(molecule);
    expect(hydrogenCounts(molecule)).toEqual([undefined, undefined, 0]);
    expect(badges(molecule)).toEqual([[molecule.atoms[2]!.id, "O states 0 H, but its bonds and charge give 1."]]);
    const warnings = hydrogenWarnings(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toBe(
      "CDXML import: atom 12 (O) states 0 hydrogens; ChemDraft derives 1. The stated count is kept, and the atom is flagged."
    );
    expect(warnings[0]!.sourceObjectId).toBe(molecule.id);
    expect(warnings[0]!.atomIds).toEqual([molecule.atoms[2]!.id]);
  });

  it("draws, counts and writes the stated 0 H, exactly as an O made under-filled by hand, with the badge", () => {
    const { molecule } = open(ethanolCdxml({ o: 'NumHydrogens="0"' }));
    const metadata = nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds);
    expect(metadata.formula).toBe("C2H5O");
    expect(metadata.warnings.map((warning) => warning.code)).toEqual(["chemistry.invalid_valence"]);
    expect(labels(molecule)).toEqual([undefined, undefined, "O"]);
    expect(nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds)).toBe("CC[O]");
    expect(nativeMoleculeExportWarnings(molecule).map((warning) => warning.message))
      .toEqual(["O3 states 0 H, but its bonds and charge give 1."]);
    // The same O typed by hand (a literal label): the same label, formula, mass and SMILES.
    const typed = { ...molecule, atoms: molecule.atoms.map((atom) => {
      if (atom.element !== "O") return atom;
      const { hydrogenCount: _stated, ...rest } = atom;
      return { ...rest, labelLiteral: true };
    }) };
    const typedMetadata = nativeSingleBondGraphMetadata(typed.atoms, typed.bonds);
    expect(labels(typed)).toEqual(labels(molecule));
    expect([typedMetadata.formula, typedMetadata.averageMass, typedMetadata.exactMass])
      .toEqual([metadata.formula, metadata.averageMass, metadata.exactMass]);
    expect(nativeSingleBondGraphSmiles(typed.atoms, typed.bonds)).toBe(nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds));
    expect(badges(typed).map(([id]) => id)).toEqual(badges(molecule).map(([id]) => id));
  });

  it("draws a methyl stated with 2 H as its label, and counts 2", () => {
    const { molecule } = open(ethanolCdxml({ c1: 'NumHydrogens="2"' }));
    // Its bond leaves to the right, so the hydrogens are drawn first, as for H3C.
    expect(labels(molecule)[0]).toBe("H2C");
    expect(nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds).formula).toBe("C2H5O");
    expect(nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds)).toBe("[CH2]CO");
  });

  it("stores nothing and gives no warning where the stated counts agree with the derived ones", () => {
    const { result, molecule } = open(ethanolCdxml({ c1: 'NumHydrogens="3"', c2: 'NumHydrogens="2"', o: 'NumHydrogens="1"' }));
    expectEthanolGraph(molecule);
    expect(hydrogenCounts(molecule)).toEqual([undefined, undefined, undefined]);
    expect(hydrogenWarnings(result)).toEqual([]);
    expect(badges(molecule)).toEqual([]);
  });

  it("opens a file that states no counts exactly as the one whose counts agree", () => {
    const agreeing = open(ethanolCdxml({ c1: 'NumHydrogens="3"', c2: 'NumHydrogens="2"', o: 'NumHydrogens="1"' }));
    const { result, molecule } = open(ethanolCdxml());
    expectEthanolGraph(molecule);
    expect(hydrogenCounts(molecule)).toEqual([undefined, undefined, undefined]);
    expect(hydrogenWarnings(result)).toEqual([]);
    expect(molecule.atoms).toEqual(agreeing.molecule.atoms);
    expect(molecule.bonds).toEqual(agreeing.molecule.bonds);
    expect(result.warnings).toEqual(agreeing.result.warnings);
    expect(nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds).formula).toBe("C2H6O");
    expect(labels(molecule)).toEqual([undefined, undefined, "OH"]);
    expect(nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds)).toBe("CCO");
  });

  it("names every disagreeing atom of a fragment in one warning", () => {
    const { result, molecule } = open(ethanolCdxml({ c1: 'NumHydrogens="2"', o: 'NumHydrogens="0"' }));
    expect(hydrogenCounts(molecule)).toEqual([2, undefined, 0]);
    const warnings = hydrogenWarnings(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toBe(
      "CDXML import: 2 atoms state hydrogen counts ChemDraft derives differently: atom 10 (C) states 2, derives 3; " +
      "atom 12 (O) states 0, derives 1. The stated counts are kept, and the atoms are flagged."
    );
    expect(warnings[0]!.atomIds).toEqual([molecule.atoms[0]!.id, molecule.atoms[2]!.id]);
    expect(badges(molecule).map(([id]) => id)).toEqual([molecule.atoms[0]!.id, molecule.atoms[2]!.id]);
  });
});

describe("a kept count survives Save As and plain export", () => {
  const stated = () => open(ethanolCdxml({ o: 'NumHydrogens="0"' })).result.document!;
  const oxygenNode = (contents: string) => /<n [^>]*Element="8"[^>]*\/?>/.exec(contents)?.[0] ?? "";

  it("writes NumHydrogens=\"0\" on the O with the embedded document, and reopens with it", () => {
    const saved = exportDocumentToCdxml(stated(), { embedNativePayload: true });
    expect(oxygenNode(saved.contents)).toContain('NumHydrogens="0"');
    const reopened = moleculeOf(openChemDraftPayload(saved.contents));
    expect(hydrogenCounts(reopened)).toEqual([undefined, undefined, 0]);
    // Only the visible layer, as another program reads the file: the same count comes back.
    const visibleOnly = saved.contents.replace(/<objecttag Name="org\.chemdraft\/[^>]*\/>/g, "");
    const external = openChemDraftPayload(visibleOnly);
    expect(external.source).toBe("external-cdxml");
    expect(hydrogenCounts(moleculeOf(external))).toEqual([undefined, undefined, 0]);
  });

  it("writes it on plain export, so a reopened O gets no implicit H (the 1.2.2 loss)", () => {
    const plain = exportDocumentToCdxml(stated(), { embedNativePayload: false });
    expect(plain.contents).not.toContain("org.chemdraft/");
    expect(oxygenNode(plain.contents)).toContain('NumHydrogens="0"');
    const reopened = open(plain.contents);
    expect(hydrogenCounts(reopened.molecule)).toEqual([undefined, undefined, 0]);
    expect(hydrogenWarnings(reopened.result)).toHaveLength(1);
  });

  it("round-trips through binary CDX", () => {
    const reopened = moleculeOf(importCdx(exportDocumentToCdx(stated()).bytes));
    expect(reopened.atoms.map((atom) => atom.element)).toEqual(["C", "C", "O"]);
    expect(hydrogenCounts(reopened)).toEqual([undefined, undefined, 0]);
  });

  it("writes no NumHydrogens for a file that stated none, or only agreeing ones", () => {
    for (const cdxml of [ethanolCdxml(), ethanolCdxml({ c1: 'NumHydrogens="3"', o: 'NumHydrogens="1"' })]) {
      const plain = exportDocumentToCdxml(open(cdxml).result.document!, { embedNativePayload: false });
      expect(plain.contents).not.toContain("NumHydrogens");
    }
  });
});

describe("the NumHydrogens check uses layout-engine's own count (AGENTS.md §9)", () => {
  it("counts a charged atom by its full charge: NH4+ stated 4 is not stored, stated 3 is kept and flagged", () => {
    const ammonium = (stated: number) =>
      `<CDXML><page id="1"><fragment id="2"><n id="10" p="0 0" Element="7" Charge="1" NumHydrogens="${stated}"/></fragment></page></CDXML>`;
    const agreeing = open(ammonium(4));
    expect(hydrogenWarnings(agreeing.result)).toEqual([]);
    expect(hydrogenCounts(agreeing.molecule)).toEqual([undefined]);
    const disagreeing = open(ammonium(3));
    expect(hydrogenCounts(disagreeing.molecule)).toEqual([3]);
    expect(hydrogenWarnings(disagreeing.result).map((warning) => warning.message)).toEqual([
      "CDXML import: atom 10 (N) states 3 hydrogens; ChemDraft derives 4. The stated count is kept, and the atom is flagged."
    ]);
  });

  it("Kekulé benzene: a ring CH stated 1 agrees, stated 0 is kept and flagged; an Order=1.5 ring keeps it as a ring constraint", () => {
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
    const kekule = open(benzene(0, ["1", "2"]));
    expect(kekule.molecule.atoms[0]?.hydrogenCount).toBe(0);
    expect(hydrogenWarnings(kekule.result).map((warning) => warning.message)).toEqual([
      "CDXML import: atom 10 (C) states 0 hydrogens; ChemDraft derives 1. The stated count is kept, and the atom is flagged."
    ]);
    const aromatic = open(benzene(0, ["1.5"]));
    expect(hydrogenWarnings(aromatic.result)).toEqual([]);
    expect(aromatic.molecule.atoms[0]?.hydrogenCount).toBe(0);
  });

  it("counts a radical's unpaired electron: a doublet CH2 stated 3 is kept and flagged", () => {
    const methyl = (stated: number) => `<CDXML><page id="1"><fragment id="2">
      <n id="10" p="0 0" Radical="Doublet" NumHydrogens="${stated}"/><n id="11" p="14 0"/>
      <b id="20" B="10" E="11"/>
    </fragment></page></CDXML>`;
    expect(hydrogenWarnings(open(methyl(2)).result)).toEqual([]);
    const disagreeing = open(methyl(3));
    expect(hydrogenCounts(disagreeing.molecule)).toEqual([3, undefined]);
    expect(hydrogenWarnings(disagreeing.result).map((warning) => warning.message)).toEqual([
      "CDXML import: atom 10 (C) states 3 hydrogens; ChemDraft derives 2. The stated count is kept, and the atom is flagged."
    ]);
  });

  it("keeps no copy of the hydrogen-count calculation in cdx-compat", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/\batomDerivedHydrogenCount\b/);
    expect(source).not.toMatch(/\bnativeAtomValenceForCharge\b/);
    expect(source).not.toMatch(/\bdativeDeprotonationCount\b/);
  });
});

describe("atoms whose label draws no count of its own: a dative-only carbon, H, D and T", () => {
  const formula = (molecule: MoleculeObject) => nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds).formula;
  const carbonyl = (numHydrogens: string) => `<CDXML><page id="1"><fragment id="2">
      <n id="10" p="14 0" ${numHydrogens}/><n id="11" p="0 0" Element="26"/>
      <b id="20" B="10" E="11" Order="dative"/>
    </fragment></page></CDXML>`;

  it("a carbon bonded only datively keeps a count its formula does not have, flagged, drawn as a typed C … CH4", () => {
    // Bare, the carbon draws no H, but its formula counts 4: a dative bond costs its donor nothing.
    expect(formula(open(carbonyl("")).molecule)).toBe("CH4Fe");
    const { result, molecule } = open(carbonyl('NumHydrogens="0"'));
    expect(hydrogenCounts(molecule)).toEqual([0, undefined]);
    expect(hydrogenWarnings(result).map((warning) => warning.message)).toEqual([
      "CDXML import: atom 10 (C) states 0 hydrogens; ChemDraft derives 4. The stated count is kept, and the atom is flagged."
    ]);
    expect(badges(molecule)).toEqual([[molecule.atoms[0]!.id, "C states 0 H, but its bonds and charge give 4."]]);
    expect(labels(molecule)).toEqual(["C", "Fe"]);
    expect(formula(molecule)).toBe("CFe");
    const plain = exportDocumentToCdxml(result.document!, { embedNativePayload: false }).contents;
    expect(/<n [^>]*id="\d+"[^>]*NumHydrogens="0"/.test(plain)).toBe(true);
    const methyl = open(carbonyl('NumHydrogens="3"')).molecule;
    expect([hydrogenCounts(methyl), labels(methyl), formula(methyl)]).toEqual([[3, undefined], ["CH3", "Fe"], "CH3Fe"]);
    // Four agrees with the formula: nothing to keep, nothing to flag.
    const { result: agreeing, molecule: methane } = open(carbonyl('NumHydrogens="4"'));
    expect([hydrogenCounts(methane), hydrogenWarnings(agreeing), badges(methane), formula(methane)]).toEqual([[undefined, undefined], [], [], "CH4Fe"]);
  });

  it("a hydrogen atom keeps a stated 0, agreeing or not, drawn as a typed H, and is flagged where it disagrees", () => {
    // A stated 0 is what a typed H label means. An agreeing one is kept as before: the formula counts
    // no H on a hydrogen atom while a lone H's label does, so there was no single count to drop it against.
    const hydrogens = `<CDXML><page id="1"><fragment id="2">
      <n id="10" p="0 0" Element="1" NumHydrogens="0"/><n id="11" p="14 0"/>
      <b id="20" B="10" E="11"/>
      <n id="12" p="40 0" Element="1" NumHydrogens="0"/>
    </fragment></page></CDXML>`;
    const { result, molecule } = open(hydrogens);
    expect(molecule.atoms.map((atom) => atom.element)).toEqual(["H", "C", "H"]);
    expect(hydrogenCounts(molecule)).toEqual([0, undefined, 0]);
    // The lone H's label counts one more H than the file states; the bonded H agrees.
    expect(hydrogenWarnings(result).map((warning) => warning.message)).toEqual([
      "CDXML import: atom 12 (H) states 0 hydrogens; ChemDraft derives 1. The stated count is kept, and the atom is flagged."
    ]);
    expect(badges(molecule).map(([id]) => id)).toEqual([molecule.atoms[2]!.id]);
    expect(labels(molecule)).toEqual(["H", undefined, "H"]);
  });

  it("does not keep a count a hydrogen atom cannot carry, and says so", () => {
    // An H bonded to C stating 1, a lone H stating 2 and a lone D stating 1: no typed H, D or T label
    // carries hydrogens of its own. A lone H stating 1 (H2) agrees with what it already counts.
    const { result, molecule } = open(`<CDXML><page id="1"><fragment id="2">
      <n id="10" p="0 0" Element="1" NumHydrogens="1"/><n id="11" p="14 0"/><b id="20" B="10" E="11"/>
      <n id="12" p="40 0" Element="1" NumHydrogens="2"/>
      <n id="13" p="60 0" Element="1" Isotope="2" NumHydrogens="1"/>
      <n id="14" p="80 0" Element="1" NumHydrogens="1"/>
    </fragment></page></CDXML>`);
    expect(molecule.atoms.map((atom) => atom.element)).toEqual(["H", "C", "H", "D", "H"]);
    expect(hydrogenCounts(molecule)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(hydrogenWarnings(result)).toEqual([]);
    expect(result.warnings.filter((warning) => warning.code === "cdxml.atom_hydrogen_count_not_kept")).toEqual([{
      code: "cdxml.atom_hydrogen_count_not_kept",
      message: "CDXML import: 3 hydrogen atoms state hydrogen counts a hydrogen atom cannot carry: " +
        "atom 10 (H) states 1; atom 12 (H) states 2; atom 13 (D) states 1. " +
        "Only 0 can be kept, as a typed H, D or T label means. The stated counts were not kept.",
      sourceObjectId: molecule.id,
      atomIds: [molecule.atoms[0]!.id, molecule.atoms[2]!.id, molecule.atoms[3]!.id]
    }]);
    const plain = exportDocumentToCdxml(result.document!, { embedNativePayload: false }).contents;
    expect(plain).not.toContain("NumHydrogens");
    const single = open(`<CDXML><page id="1"><fragment id="2">
      <n id="10" p="0 0" Element="1" NumHydrogens="1"/><n id="11" p="14 0"/><b id="20" B="10" E="11"/>
    </fragment></page></CDXML>`).result;
    expect(single.warnings.filter((warning) => warning.code === "cdxml.atom_hydrogen_count_not_kept").map((warning) => warning.message)).toEqual([
      "CDXML import: atom 10 (H) states 1 hydrogen, which a hydrogen atom cannot carry: only 0 can be kept, as a typed H, D or T label means. The stated count was not kept."
    ]);
  });
});

/**
 * The unknown atom "*" (an Element naming nothing, an unlabeled nickname node, a "*" generic label).
 * Nothing counts hydrogens on it: its label draws none, the formula counts none, the molfile writes
 * the dummy atom "*" with no valence and RDKit gives a dummy atom none, so its SMILES is "*" whether
 * the file states 2, 0 or nothing. A stated count other than 0 is therefore kept for the file's round
 * trip, reported as not counted on import and badged (chem-core `atomIgnoresStatedHydrogenCount`,
 * the rule the native open report and the plugin host share); a stated 0 is what it counts anyway.
 */
describe("an unknown atom (*) keeps what the file states, and a count it cannot carry is flagged", () => {
  const starCdxml = (star: string) => `<CDXML><page id="1"><fragment id="2">
      <n id="10" p="0 0" ${star}/><n id="11" p="14 0"/><n id="12" p="28 0" Element="8"/>
      <b id="20" B="10" E="11"/><b id="21" B="11" E="12"/>
    </fragment></page></CDXML>`;
  const notCountedWarnings = (result: ReturnType<typeof openChemDraftPayload>) =>
    result.warnings.filter((warning) => warning.code === "cdxml.atom_hydrogen_count_not_counted");
  const reading = (molecule: MoleculeObject) => {
    const metadata = nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds);
    return { labels: labels(molecule), formula: metadata.formula, exactMass: metadata.exactMass,
      smiles: nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds) };
  };
  const starNodes = {
    "Element naming nothing": 'Element="250"',
    "unlabeled nickname node": 'NodeType="Nickname"',
    "\"*\" generic label": 'NodeType="GenericNickname" GenericNickname="*"'
  } as const;

  it.each(Object.entries(starNodes))("a * (%s) stating 2 keeps the count, warns that it is not counted, and is badged", (_name, star) => {
    const { result, molecule } = open(starCdxml(`${star} NumHydrogens="2"`));
    expect(molecule.atoms[0]).toMatchObject({ element: "*", hydrogenCount: 2 });
    expect(hydrogenWarnings(result)).toEqual([]);
    expect(notCountedWarnings(result)).toEqual([{
      code: "cdxml.atom_hydrogen_count_not_counted",
      message: "CDXML import: atom 10 (*) states 2 hydrogens, which an unknown atom cannot carry: only 0 counts, as a typed * label means. " +
        "The stated count is kept as stored but not counted, and the atom is flagged.",
      sourceObjectId: molecule.id,
      atomIds: [molecule.atoms[0]!.id]
    }]);
    expect(badges(molecule)).toEqual([[molecule.atoms[0]!.id, "* states 2 H, which an unknown atom cannot carry; only 0 counts."]]);
    expect(nativeMoleculeExportWarnings(molecule).map((warning) => warning.message))
      .toEqual(["*1 states 2 H, which an unknown atom cannot carry; only 0 counts."]);
    // What it is not counted as: the label, formula, mass and SMILES of the same * stating nothing.
    expect(reading(molecule)).toEqual(reading(open(starCdxml(star)).molecule));
    expect(reading(molecule)).toMatchObject({ labels: ["*", undefined, "OH"], formula: "CH3O", smiles: "[*]CO" });
  });

  it("names every such atom of a fragment in one warning", () => {
    const { result, molecule } = open(`<CDXML><page id="1"><fragment id="2">
      <n id="10" p="0 0" Element="250" NumHydrogens="2"/><n id="11" p="14 0"/><n id="12" p="28 0" NodeType="Nickname" NumHydrogens="1"/>
      <b id="20" B="10" E="11"/><b id="21" B="11" E="12"/>
    </fragment></page></CDXML>`);
    expect(notCountedWarnings(result).map((warning) => [warning.message, warning.atomIds])).toEqual([[
      "CDXML import: 2 unknown atoms state hydrogen counts an unknown atom cannot carry: atom 10 (*) states 2; atom 12 (*) states 1. " +
        "Only 0 counts, as a typed * label means. The stated counts are kept as stored but not counted, and the atoms are flagged.",
      [molecule.atoms[0]!.id, molecule.atoms[2]!.id]
    ]]);
  });

  it("round-trips the stated count through Save As, the visible layer, plain export and binary CDX", () => {
    const document = open(starCdxml('Element="250" NumHydrogens="2"')).result.document!;
    const saved = exportDocumentToCdxml(document, { embedNativePayload: true });
    expect(saved.contents).toMatch(/<n [^>]*Element="\*"[^>]*NumHydrogens="2"/);
    expect(moleculeOf(openChemDraftPayload(saved.contents)).atoms[0]).toMatchObject({ element: "*", hydrogenCount: 2 });
    const visibleOnly = openChemDraftPayload(saved.contents.replace(/<objecttag Name="org\.chemdraft\/[^>]*\/>/g, ""));
    expect(visibleOnly.source).toBe("external-cdxml");
    expect(moleculeOf(visibleOnly).atoms[0]).toMatchObject({ element: "*", hydrogenCount: 2 });
    expect(notCountedWarnings(visibleOnly)).toHaveLength(1);
    const plain = exportDocumentToCdxml(document, { embedNativePayload: false }).contents;
    expect(plain).toContain('NumHydrogens="2"');
    const reopened = open(plain);
    expect(reopened.molecule.atoms[0]).toMatchObject({ element: "*", hydrogenCount: 2 });
    expect(notCountedWarnings(reopened.result)).toHaveLength(1);
    expect(moleculeOf(importCdx(exportDocumentToCdx(document).bytes)).atoms[0]).toMatchObject({ element: "*", hydrogenCount: 2 });
  });

  it("a * stating 0 keeps it unflagged: 0 is what a * counts", () => {
    const { result, molecule } = open(starCdxml('Element="250" NumHydrogens="0"'));
    expect(molecule.atoms[0]).toMatchObject({ element: "*", hydrogenCount: 0 });
    expect(notCountedWarnings(result)).toEqual([]);
    expect(badges(molecule)).toEqual([]);
    expect(exportDocumentToCdxml(result.document!, { embedNativePayload: false }).contents).toContain('NumHydrogens="0"');
  });

  it("a * with no NumHydrogens opens as before: nothing stored, no warning, no badge", () => {
    for (const star of Object.values(starNodes)) {
      const { result, molecule } = open(starCdxml(star));
      expect(molecule.atoms[0]!.element).toBe("*");
      expect(molecule.atoms[0]!.hydrogenCount).toBeUndefined();
      expect(notCountedWarnings(result)).toEqual([]);
      expect(badges(molecule)).toEqual([]);
      expect(exportDocumentToCdxml(result.document!, { embedNativePayload: false }).contents).not.toContain("NumHydrogens");
    }
  });
});

/**
 * Generic placeholder labels (A, Q, M, X, R-groups) and any other label naming no element are
 * read by the same rule as "*": chem-core `atomIgnoresStatedHydrogenCount` is exactly "stored, but
 * not used by `atomStatedHydrogenCount`", so no list of labels decides it. Nothing counts a
 * NumHydrogens on such a node: it is kept for the round trip, reported as not counted and badged.
 */
describe("a generic label (A, R1) keeps what the file states, and a count it cannot carry is flagged", () => {
  const genericCdxml = (numHydrogens = ' NumHydrogens="2"') => `<CDXML><page id="1"><fragment id="2">
      <n id="10" p="0 0" NodeType="GenericNickname" GenericNickname="A"${numHydrogens}/><n id="11" p="14 0"/>
      <n id="12" p="28 0" NodeType="GenericNickname" GenericNickname="R1"${numHydrogens}/>
      <b id="20" B="10" E="11"/><b id="21" B="11" E="12"/>
    </fragment></page></CDXML>`;
  const notCountedWarnings = (result: ReturnType<typeof openChemDraftPayload>) =>
    result.warnings.filter((warning) => warning.code === "cdxml.atom_hydrogen_count_not_counted");

  it("an A and an R1 stating 2 keep the count, warn that it is not counted, and are badged", () => {
    const { result, molecule } = open(genericCdxml());
    const [a, , r1] = molecule.atoms;
    expect([a, r1]).toMatchObject([{ element: "A", hydrogenCount: 2 }, { element: "R1", hydrogenCount: 2 }]);
    expect(hydrogenWarnings(result)).toEqual([]);
    expect(notCountedWarnings(result)).toEqual([{
      code: "cdxml.atom_hydrogen_count_not_counted",
      message: "CDXML import: 2 atoms with labels naming no element state hydrogen counts a label naming no element cannot carry: atom 10 (A) states 2; " +
        "atom 12 (R1) states 2. Only 0 counts, as a typed A or R1 label means. The stated counts are kept as stored but not counted, and the atoms are flagged.",
      sourceObjectId: molecule.id,
      atomIds: [a!.id, r1!.id]
    }]);
    expect(badges(molecule)).toEqual([
      [a!.id, "A states 2 H, which a label naming no element cannot carry; only 0 counts."],
      [r1!.id, "R1 states 2 H, which a label naming no element cannot carry; only 0 counts."]
    ]);
    // The export warning names each atom as label + drawn index ("A1", and "R1" + 3), then the badge's reason.
    expect(nativeMoleculeExportWarnings(molecule).map((warning) => warning.message)).toEqual([
      "A1 states 2 H, which a label naming no element cannot carry; only 0 counts.",
      "R13 states 2 H, which a label naming no element cannot carry; only 0 counts."
    ]);
    // What it is not counted as: the formula and SMILES of the same labels stating nothing.
    const plain = open(genericCdxml("")).molecule;
    expect(nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds).formula).toBe(nativeSingleBondGraphMetadata(plain.atoms, plain.bonds).formula);
    expect(nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds)).toBe(nativeSingleBondGraphSmiles(plain.atoms, plain.bonds));
  });

  it("one generic label alone is named with its own label text", () => {
    const { result } = open(`<CDXML><page id="1"><fragment id="2">
      <n id="10" p="0 0" NodeType="GenericNickname" GenericNickname="A" NumHydrogens="2"/><n id="11" p="14 0"/><b id="20" B="10" E="11"/>
    </fragment></page></CDXML>`);
    expect(notCountedWarnings(result).map((warning) => warning.message)).toEqual([
      "CDXML import: atom 10 (A) states 2 hydrogens, which a label naming no element cannot carry: only 0 counts, as a typed A label means. " +
        "The stated count is kept as stored but not counted, and the atom is flagged."
    ]);
  });

  it("round-trips the stated counts through Save As, the visible layer, plain export and binary CDX", () => {
    const document = open(genericCdxml()).result.document!;
    const stated = (molecule: MoleculeObject) => [molecule.atoms[0], molecule.atoms[2]].map((atom) => [atom!.element, atom!.hydrogenCount]);
    const expected = [["A", 2], ["R1", 2]];
    const saved = exportDocumentToCdxml(document, { embedNativePayload: true });
    expect(stated(moleculeOf(openChemDraftPayload(saved.contents)))).toEqual(expected);
    const visibleOnly = openChemDraftPayload(saved.contents.replace(/<objecttag Name="org\.chemdraft\/[^>]*\/>/g, ""));
    expect(visibleOnly.source).toBe("external-cdxml");
    expect(stated(moleculeOf(visibleOnly))).toEqual(expected);
    expect(notCountedWarnings(visibleOnly)).toHaveLength(1);
    const plain = exportDocumentToCdxml(document, { embedNativePayload: false }).contents;
    expect(plain.match(/NumHydrogens="2"/g)).toHaveLength(2);
    const reopened = open(plain);
    expect(stated(reopened.molecule)).toEqual(expected);
    expect(notCountedWarnings(reopened.result)).toHaveLength(1);
    expect(stated(moleculeOf(importCdx(exportDocumentToCdx(document).bytes)))).toEqual(expected);
  });

  it("stating 0, or nothing, is not flagged: 0 is what such a label counts", () => {
    for (const numHydrogens of [' NumHydrogens="0"', ""]) {
      const { result, molecule } = open(genericCdxml(numHydrogens));
      expect(notCountedWarnings(result)).toEqual([]);
      expect(badges(molecule)).toEqual([]);
    }
  });

  it("an ordinary C stating a count it disagrees with is still honored, not reported as not counted", () => {
    const { result, molecule } = open(ethanolCdxml({ c1: 'NumHydrogens="2"' }));
    expect(molecule.atoms[0]!.hydrogenCount).toBe(2);
    expect(notCountedWarnings(result)).toEqual([]);
    expect(hydrogenWarnings(result)).toHaveLength(1);
    expect(labels(molecule)[0]).toBe("H2C");
    expect(nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds).formula).toBe("C2H5O");
  });
});

describe("a NumHydrogens that is not a count", () => {
  it("warns, rather than dropping it silently, when NumHydrogens is not a hydrogen count", () => {
    for (const [value, element] of [["-1", ""], ["1.5", ' Element="8"'], ["two", ""]] as const) {
      const { result, molecule } = open(`<CDXML><page id="1"><fragment id="2">
        <n id="10" p="0 0"${element} NumHydrogens="${value}"/><n id="11" p="14 0"/><b id="20" B="10" E="11"/>
      </fragment></page></CDXML>`);
      expect(hydrogenCounts(molecule)).toEqual([undefined, undefined]);
      expect(result.warnings.filter((warning) => warning.code === "cdxml.atom_hydrogen_count_invalid")).toEqual([{
        code: "cdxml.atom_hydrogen_count_invalid",
        message: `CDXML atom 10 has NumHydrogens="${value}", which is not a hydrogen count; it was not imported.`,
        sourceObjectId: molecule.id,
        atomIds: [molecule.atoms[0]!.id]
      }]);
    }
  });
});
