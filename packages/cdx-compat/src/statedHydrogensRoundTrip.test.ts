import { describe, expect, it } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload } from "./index";

/**
 * 1.2.3 item (j): an explicit NumHydrogens="0" (the O of C-C-O, singly bonded) must survive plain
 * CDXML export and a second round trip, and a count that agrees with the derived one (or none)
 * must export exactly as before, with no new attribute.
 */
const ethanol = (o: string) => `<CDXML><page id="1"><fragment id="2">
  <n id="10" p="0 0"/><n id="11" p="14 8"/><n id="12" p="28 0" Element="8" ${o}/>
  <b id="20" B="10" E="11"/><b id="21" B="11" E="12"/>
</fragment></page></CDXML>`;

const moleculeOf = (result: { document?: { pages: { objects: unknown[] }[] } }): MoleculeObject =>
  result.document!.pages[0]!.objects.find((o): o is MoleculeObject => (o as MoleculeObject).type === "molecule")!;
const counts = (m: MoleculeObject) => m.atoms.map((a) => a.hydrogenCount);
const plain = (doc: NonNullable<ReturnType<typeof openChemDraftPayload>["document"]>) =>
  exportDocumentToCdxml(doc, { embedNativePayload: false }).contents;
const oNode = (xml: string) => /<n [^>]*Element="8"[^>]*\/?>/.exec(xml)?.[0] ?? "";

describe("explicit NumHydrogens=0 round-trips", () => {
  it("keeps 0 H on import and through two plain CDXML round trips, byte-stable", () => {
    const first = openChemDraftPayload(ethanol('NumHydrogens="0"'));
    expect(counts(moleculeOf(first))).toEqual([undefined, undefined, 0]);
    const out1 = plain(first.document!);
    expect(oNode(out1)).toContain('NumHydrogens="0"');
    const second = openChemDraftPayload(out1);
    expect(counts(moleculeOf(second))).toEqual([undefined, undefined, 0]);
    const out2 = plain(second.document!);
    expect(oNode(out2)).toContain('NumHydrogens="0"');
    const third = openChemDraftPayload(out2);
    expect(counts(moleculeOf(third))).toEqual([undefined, undefined, 0]);
    expect(oNode(out2)).toBe(oNode(out1));
    expect(out2.match(/NumHydrogens=/g)).toHaveLength(1);
  });

  it("agreeing or absent counts export with no NumHydrogens, and stay so on a second trip", () => {
    for (const o of ["", 'NumHydrogens="1"']) {
      const doc = openChemDraftPayload(ethanol(o)).document!;
      const out1 = plain(doc);
      expect(out1).not.toContain("NumHydrogens");
      expect(plain(openChemDraftPayload(out1).document!)).not.toContain("NumHydrogens");
    }
  });

  it("binary CDX carries NumHydrogens (tag 0x042B): 0 survives two round trips; agreeing writes none", () => {
    const doc = openChemDraftPayload(ethanol('NumHydrogens="0"')).document!;
    const bytes1 = exportDocumentToCdx(doc).bytes;
    const once = importCdx(bytes1);
    expect(counts(moleculeOf(once))).toEqual([undefined, undefined, 0]);
    const twice = importCdx(exportDocumentToCdx(once.document!).bytes);
    expect(counts(moleculeOf(twice))).toEqual([undefined, undefined, 0]);
    const agreeing = exportDocumentToCdx(openChemDraftPayload(ethanol('NumHydrogens="1"')).document!).bytes;
    const hasTag = (b: Uint8Array) => b.some((v, i) => v === 0x2b && b[i + 1] === 0x04);
    expect(hasTag(bytes1)).toBe(true);
    expect(hasTag(agreeing)).toBe(false);
  });
});
