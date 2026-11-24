import { describe, expect, it } from "vitest";
import type { DocumentObject, DocumentPage, ElectronMarkObject, MoleculeObject } from "@chemdraft/chem-core";
import { nativeChargeMarkSizePx, nativeRadicalPlacementPointForAtom, transformPointForObject } from "@chemdraft/layout-engine";
import { openChemDraftPayload } from "./index";
import { addImportedRadicalMarks } from "./importedRadicalMarks";

/** One single-atom fragment per entry; a lone pair attached to the atom when `lonePair` is set. */
function cdxml(atoms: readonly { radical?: "Doublet" | "Triplet"; lonePair?: boolean }[]): string {
  const parts = atoms.map((atom, index) => {
    const x = 40 + (index % 20) * 30, y = 40 + Math.floor(index / 20) * 30, node = 1000 + index;
    const fragment = `<fragment id="${5000 + index}"><n id="${node}" Element="8" p="${x} ${y}"` +
      `${atom.radical ? ` Radical="${atom.radical}"` : ""}/></fragment>`;
    return fragment + (atom.lonePair ? `<graphic id="${9000 + index}" GraphicType="Symbol" SymbolType="LonePair" ` +
      `BoundingBox="${x} ${y - 7} ${x + 3} ${y - 7}"><represent object="${node}" attribute="Radical"/></graphic>` : "");
  });
  return `<CDXML><page>${parts.join("")}</page></CDXML>`;
}

/** The imported page with the radical dots import generated taken out again, so a test can re-run the pass. */
function pageWithoutGeneratedDots(source: string): DocumentPage {
  const page = openChemDraftPayload(source).document!.pages[0];
  return { ...page, objects: page.objects.filter(object => !(object.type === "electron-mark" && object.compatibility?.unknown.cdxmlRadicalMarkPlacement)) };
}

/** The pass as it was before the mark index: every atom filtered the whole mark list, and placement saw the whole page. */
function referenceAddImportedRadicalMarks(page: DocumentPage): void {
  const marks = page.objects.filter((object): object is ElectronMarkObject => object.type === "electron-mark");
  const ids = new Set(page.objects.map(object => object.id));
  for (const molecule of page.objects.filter((object): object is MoleculeObject => object.type === "molecule")) {
    for (const atom of molecule.atoms) {
      const carried = marks.filter(mark => mark.anchor.kind === "atom" && mark.anchor.objectId === molecule.id && mark.anchor.atomId === atom.id)
        .reduce((sum, mark) => sum + (mark.markKind === "radical-dot" || mark.markKind === "charge" && mark.radical ? 1 : 0), 0);
      const missing = (atom.markRadicals ?? 0) - carried;
      for (let index = 0; index < missing; index++) {
        const point = nativeRadicalPlacementPointForAtom(molecule, atom.id, page.objects, page.width, page.height)!;
        const size = nativeChargeMarkSizePx;
        let id = `${molecule.id}_${atom.id}_radical_${index + 1}`;
        while (ids.has(id)) id += "_";
        ids.add(id);
        const mark: ElectronMarkObject = {
          id, type: "electron-mark", markKind: "radical-dot",
          x: Math.max(0, Math.min(point.x - size / 2, page.width - size)),
          y: Math.max(0, Math.min(point.y - size / 2, page.height - size)),
          width: size, height: size, rotation: 0, style: { source: "chemdraft-native-charge" },
          anchor: { kind: "atom", objectId: molecule.id, atomId: atom.id }, atomAssociation: "explicit"
        };
        const atomPoint = transformPointForObject(molecule, atom);
        mark.compatibility = { warnings: [], unknown: { cdxmlRadicalMarkPlacement: {
          x: mark.x, y: mark.y, offsetX: mark.x - atomPoint.x, offsetY: mark.y - atomPoint.y, objectId: molecule.id, atomId: atom.id
        } } };
        page.objects.push(mark);
        marks.push(mark);
      }
    }
  }
}

describe("imported radical marks (Codex security finding on #442)", () => {
  it("places every radical dot exactly where the whole-page pass did, with lone pairs, charges and triplets", () => {
    const page = pageWithoutGeneratedDots(cdxml([
      { radical: "Doublet" }, { radical: "Triplet" }, { radical: "Doublet", lonePair: true }, { lonePair: true },
      { radical: "Triplet", lonePair: true }, {}, { radical: "Doublet" }
    ]));
    const molecules = page.objects.filter((object): object is MoleculeObject => object.type === "molecule");
    expect(molecules).toHaveLength(7);
    expect(molecules.map(molecule => molecule.atoms[0].markRadicals ?? 0)).toEqual([1, 2, 1, 0, 2, 0, 1]);
    // Charges change the score of every placement (one on an atom with a radical, one free-standing).
    const charge = (id: string, molecule: MoleculeObject): ElectronMarkObject => ({
      id, type: "electron-mark", markKind: "charge", charge: 1, x: molecule.x + 12, y: molecule.y - 14,
      width: nativeChargeMarkSizePx, height: nativeChargeMarkSizePx, rotation: 0, style: { source: "chemdraft-native-charge" },
      anchor: { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[0].id }, atomAssociation: "explicit"
    });
    page.objects.push(charge("charge_a", molecules[6]), charge("charge_b", molecules[5]));
    const actual = structuredClone(page);
    const expected = structuredClone(page);
    addImportedRadicalMarks(actual);
    referenceAddImportedRadicalMarks(expected);
    expect(actual.objects.filter(object => object.type === "electron-mark" && object.markKind === "radical-dot")).toHaveLength(7);
    expect(actual.objects).toEqual(expected.objects);
  });

  it("reads the page's objects a number of times linear in atoms plus lone pairs", () => {
    // Half the atoms carry a radical (no other mark), half an attached lone pair: before the index,
    // every atom filtered every lone pair, and every placement scanned the whole page.
    const reads = (count: number) => {
      const page = pageWithoutGeneratedDots(cdxml(Array.from({ length: count }, (_, index) =>
        index % 2 ? { lonePair: true } : { radical: "Doublet" as const })));
      let gets = 0;
      page.objects = page.objects.map(object => new Proxy(object, {
        get(target, key, receiver) { gets++; return Reflect.get(target, key, receiver) as unknown; }
      }) as DocumentObject);
      addImportedRadicalMarks(page);
      const total = gets;
      expect(page.objects.filter(object => object.type === "electron-mark" && object.markKind === "radical-dot")).toHaveLength(count / 2);
      return total;
    };
    const small = reads(40), large = reads(80);
    expect(small).toBeGreaterThan(0);
    // Linear: doubling the input roughly doubles the reads (a quadratic pass would quadruple them).
    expect(large / small).toBeLessThan(2.5);
  });

  it("warns once when more than 256 marks crowd one atom, and not on a normal page", () => {
    const normal = pageWithoutGeneratedDots(cdxml([{ radical: "Doublet" }, { radical: "Triplet" }, {}]));
    const normalWarnings: { code: string; message: string }[] = [];
    addImportedRadicalMarks(normal, normalWarnings);
    expect(normalWarnings).toEqual([]);

    const crowded = pageWithoutGeneratedDots(cdxml([{ radical: "Doublet" }]));
    const molecule = crowded.objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    const near = transformPointForObject(molecule, molecule.atoms[0]);
    // Charges on the atom itself make its free slot occupied, so placement scores candidates against the crowd.
    for (let index = 0; index < 300; index++) crowded.objects.push({
      id: `stack${index}`, type: "electron-mark", markKind: "charge", charge: 1, x: near.x + 20, y: near.y,
      width: nativeChargeMarkSizePx, height: nativeChargeMarkSizePx, rotation: 0, style: { source: "chemdraft-native-charge" },
      anchor: { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[0].id }, atomAssociation: "explicit"
    } as ElectronMarkObject);
    const warnings: { code: string; message: string }[] = [];
    addImportedRadicalMarks(crowded, warnings);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("more than 256 marks crowd one atom");
  });
});
