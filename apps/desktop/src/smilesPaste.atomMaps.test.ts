/**
 * Mapped SMILES paste: atom maps have no native field yet, so the paste strips them before drawing
 * and verifies the drawing against the stripped input. That check is still a real identity check.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import {
  ATOM_MAPS_REMOVED_STATUS, inspectHydrogenNormalizedIdentity, stripSmilesAtomMaps, type InspectChemicalIdentity
} from "@chemdraft/document-workflow-core";
import { ensureRdkit, generateSmiles2DMolfile, resetRdkitForTesting } from "@chemdraft/rdkit-adapter";
import { installRealRdkitModuleLoader } from "@chemdraft/rdkit-adapter/testing";
import { pastedStructureDepictionFromMolfile, SMILES_PASTE_OPTIONS } from "./documentWorkflow";
import { atomMapStereoLossStatus, checkedSmilesPaste, SmilesPasteIdentityError } from "./smilesPasteIdentity";
import { smilesListAtomMapNotes } from "./smilesListPaste";

beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

const inspect: InspectChemicalIdentity = async (_format, value, stereoReference) =>
  inspectHydrogenNormalizedIdentity(await ensureRdkit(), value, stereoReference);

async function depiction(smiles: string) {
  return pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(smiles, SMILES_PASTE_OPTIONS));
}

async function paste(smiles: string, drawn = smiles) {
  const document = await checkedSmilesPaste(createEmptyDocument(), { x: 200, y: 200 }, await depiction(drawn), smiles, inspect);
  return document.pages[0]!.objects.find((object): object is MoleculeObject =>
    object.type === "molecule" && document.selection.objectIds.includes(object.id))!;
}

describe("mapped SMILES paste", () => {
  it.each([
    ["[CH3:1]/[CH:2]=[CH:3]/[CH3:4]", "[CH3]/[CH]=[CH]/[CH3]"],
    ["[CH3:1][C:2](=[O:3])[OH:4]", "[CH3][C](=[O])[OH]"]
  ])("accepts %s once its maps are stripped, storing no maps", async (mapped, stripped) => {
    // The bug: the mapped input never matches a drawing of native atoms, which have no map field.
    await expect(paste(mapped, stripped)).rejects.toThrow(SmilesPasteIdentityError);
    const result = stripSmilesAtomMaps(mapped);
    expect(result).toEqual({ smiles: stripped, removed: 4 });
    const molecule = await paste(result.smiles);
    expect(molecule.structureFormat).toBe("molfile-v2000");
    expect(molecule.structure).not.toMatch(/:\d+\]/);
    expect(molecule.structure.split("\n").slice(4, 8).map(line => Number(line.slice(60, 63)))).toEqual([0, 0, 0, 0]);
    expect(molecule.compatibility?.unknown).toEqual({ smiles: stripped });
    expect(await atomMapStereoLossStatus(mapped, result.smiles, inspect)).toBeUndefined();
  });

  it("keeps E geometry from the stripped input", async () => {
    const molecule = await paste(stripSmilesAtomMaps("[CH3:1]/[CH:2]=[CH:3]/[CH3:4]").smiles);
    expect(molecule.bonds.find(bond => bond.order === "double")?.stereo).toBeUndefined();
    await expect(paste("[CH3]/[CH]=[CH]/[CH3]", "C/C=C\\C")).rejects.toThrow(/stereochemistry/);
  });

  it.each([
    ["[13CH3:1]c1ccccc1", "Cc1ccccc1", /isotope labels/],
    ["[CH3:1][NH3+:2]", "CN", /charges|chemical identity/],
    ["[CH3:1][CH2:2][OH:3]", "CCN", /chemical identity/],
    ["[CH3:1][C@H:2](O)F", "C[C@@H](O)F", /stereochemistry/],
    ["[CH3:1][CH:2]", "CC", /chemical identity/]
  ])("still refuses a real identity change after stripping %s", async (mapped, drawn, difference) => {
    const { smiles } = stripSmilesAtomMaps(mapped);
    await expect(paste(smiles, drawn)).rejects.toThrow(difference);
  });

  it("says so when a map was what made a centre stereogenic", async () => {
    const mapped = "[CH3:1][C@:2]([CH3:3])(F)Cl";
    const { smiles } = stripSmilesAtomMaps(mapped);
    expect(smiles).toBe("[CH3][C@]([CH3])(F)Cl");
    // The drawing follows the stripped SMILES, in which the centre is not stereogenic.
    const molecule = await paste(smiles);
    expect(molecule.bonds.some(bond => bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed")).toBe(false);
    expect(await atomMapStereoLossStatus(mapped, smiles, inspect)).toBe(
      "Without atom-map numbers, 1 stereocenter in the pasted SMILES is no longer stereogenic and was drawn without stereo");
    expect(await atomMapStereoLossStatus("[CH3:1][C@H:2](O)F", "[CH3][C@H](O)F", inspect)).toBeUndefined();
  });

  it.each([
    ["[CH3:0][C@](C)(F)Cl", "1 stereocenter"],
    ["[CH3:0]/C(C)=C/F", "1 double-bond E/Z assignment"]
  ])("says so when a class 0, which is not a map, was what made %s stereogenic", async (input, lost) => {
    const { smiles, removed } = stripSmilesAtomMaps(input);
    expect(removed).toBe(0);
    expect(smiles).not.toBe(input);
    expect(await atomMapStereoLossStatus(input, smiles, inspect)).toBe(
      `Without atom-map numbers, ${lost} in the pasted SMILES is no longer stereogenic and was drawn without stereo`);
  });

  it("builds list-paste notes from the entries given, which are the accepted ones", () => {
    const mapped = { atomMaps: { input: "[CH3:1]O", mapsRemoved: true } };
    const lost = { atomMaps: { input: "[CH3:0][C@](C)(F)Cl", mapsRemoved: false, stereoLoss: "lost" } };
    expect(smilesListAtomMapNotes([{}, {}])).toEqual([]);
    expect(smilesListAtomMapNotes([mapped, {}])).toEqual([ATOM_MAPS_REMOVED_STATUS]);
    expect(smilesListAtomMapNotes([lost])).toEqual(["[CH3:0][C@](C)(F)Cl: lost"]);
    expect(smilesListAtomMapNotes([lost, mapped])).toEqual(["[CH3:0][C@](C)(F)Cl: lost", ATOM_MAPS_REMOVED_STATUS]);
  });

  it("reports a failed stereo check instead of staying silent", async () => {
    const failing: InspectChemicalIdentity = async () => { throw new Error("engine crashed"); };
    expect(await atomMapStereoLossStatus("[CH3:1][C@H:2](O)F", "[CH3][C@H](O)F", failing)).toBe(
      "Stereo after removing atom-map numbers could not be checked: engine crashed");
  });

  it("has the agreed status wording", () => {
    expect(ATOM_MAPS_REMOVED_STATUS).toBe("Atom-map numbers removed; ChemDraft does not keep them yet.");
  });
});
