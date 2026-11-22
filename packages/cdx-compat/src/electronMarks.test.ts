import { describe, expect, it } from "vitest";
import { createEmptyDocument, type ElectronMarkObject, type MoleculeObject } from "@chemdraft/chem-core";
import { moveDocumentObject, moveNativeMoleculeParts, normalizeCommittedDocument } from "../../../apps/desktop/src/documentWorkflow";
import { exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload } from "./index";

describe("electron-mark CDXML appearance warnings", () => {
  it("keeps lone-pair geometry, color and a forward atom reference through plain CDXML and CDX", () => {
    const source = '<CDXML><colortable><color r="1" g="0" b="1"/></colortable><page>' +
      '<graphic id="3" GraphicType="Symbol" SymbolType="LonePair" color="2" BoundingBox="70 72 67 68">' +
      '<represent object="21" attribute="Radical"/></graphic><fragment id="8"><n id="20" Element="6" p="48 64"/>' +
      '<n id="21" Element="8" p="70 64"/><b id="22" B="20" E="21" Order="1"/></fragment></page></CDXML>';
    const document = openChemDraftPayload(source).document!;
    const mark = document.pages[0].objects[0] as ElectronMarkObject;
    expect(mark.markKind).toBe("lone-pair");
    mark.x += 4; mark.y += 8; mark.rotation = 90;
    for (const embedNativePayload of [false, true]) {
      const xml = exportDocumentToCdxml(document, { embedNativePayload });
      const binary = exportDocumentToCdx(document, { embedNativePayload });
      for (const result of [xml, binary]) expect(result.warnings).toEqual([]);
      expect(xml.contents).toContain('BoundingBox="73 78 73 73"');
      expect(xml.contents.match(/SymbolType="LonePair"/g)).toHaveLength(1);
      const reference = xml.contents.match(/<represent object="(\d+)" attribute="Radical"/)?.[1];
      expect(reference).toBeTruthy();
      expect(xml.contents).toMatch(new RegExp(`<n (?=[^>]*id="${reference}")(?=[^>]*Element="8")`));
      expect(xml.contents).not.toContain(' Radical="Doublet"');
      for (const read of [openChemDraftPayload(xml.contents), importCdx(binary.bytes)]) {
        const objects = read.document!.pages[0].objects;
        const pair = objects.find(o => o.type === "electron-mark") as ElectronMarkObject;
        const molecule = objects.find(o => o.type === "molecule") as MoleculeObject;
        expect(pair.anchor).toMatchObject({ kind: "atom", objectId: molecule.id, atomId: molecule.atoms[1].id });
        expect(pair.style.color).toBe("#ff00ff");
        expect(pair.x).toBeCloseTo(mark.x, 3);
        expect(pair.y).toBeCloseTo(mark.y, 3);
        expect(pair.width).toBeCloseTo(mark.width, 3);
        expect(pair.rotation).toBe(90);
        expect(molecule.atoms[1].markRadicals ?? 0).toBe(0);
      }
    }
    const orphan = openChemDraftPayload(source.replace('object="21"', 'object="99"'));
    expect(orphan.warnings.some(w => w.code === "cdxml.lone_pair_anchor_unresolved")).toBe(true);
    expect(orphan.document!.pages[0].objects[0]).toMatchObject({ anchor: { kind: "point" } });
  });

  // CodeRabbit 4658591582: a retained source atom id on one page must not be reissued on another.
  it("keeps every CDXML id unique when a lone pair retains source atom ids on another page", () => {
    const source = '<CDXML><page><graphic id="3" GraphicType="Symbol" SymbolType="LonePair" BoundingBox="70 72 67 68">' +
      '<represent object="10002" attribute="Radical"/></graphic><fragment id="8"><n id="10001" Element="6" p="48 64"/>' +
      '<n id="10002" Element="8" p="70 64"/><b id="22" B="10001" E="10002" Order="1"/></fragment></page>' +
      '<page><fragment id="1"><n id="2" Element="6" p="20 20"/><n id="3" Element="7" p="40 20"/>' +
      '<b id="4" B="2" E="3" Order="1"/></fragment></page></CDXML>';
    const document = openChemDraftPayload(source).document!;
    expect(document.pages).toHaveLength(2);
    const xml = exportDocumentToCdxml(document, { embedNativePayload: false }).contents;
    const ids = [...xml.matchAll(/<(?:fragment|n|b|graphic) [^>]*?\bid="([^"]+)"/g)].map(match => match[1]);
    expect(ids.length).toBeGreaterThanOrEqual(8);
    expect(new Set(ids).size).toBe(ids.length);
    const reference = xml.match(/<represent object="(\d+)" attribute="Radical"/)?.[1];
    expect(xml).toMatch(new RegExp(`<n (?=[^>]*id="${reference}")(?=[^>]*Element="8")`));
  });

  // CodeRabbit 4658591589: two nodes sharing one source id leave the reference ambiguous.
  it("does not attach a lone pair to one of two atoms that share its referenced source id", () => {
    const source = '<CDXML><page><graphic id="3" GraphicType="Symbol" SymbolType="LonePair" BoundingBox="70 72 67 68">' +
      '<represent object="21" attribute="Radical"/></graphic><fragment id="8"><n id="21" Element="6" p="48 64"/>' +
      '<n id="21" Element="8" p="70 64"/></fragment></page></CDXML>';
    const read = openChemDraftPayload(source);
    expect(read.warnings.some(w => w.code === "cdxml.lone_pair_anchor_unresolved")).toBe(true);
    const pair = read.document!.pages[0].objects.find(o => o.type === "electron-mark") as ElectronMarkObject;
    expect(pair.anchor).toMatchObject({ kind: "point" });
  });

  // CodeRabbit 4658691387: an expanded abbreviation node (10) aliases its nested attachment atom (12).
  // Both ids name the same oxygen, so a lone pair may reference either; neither is a duplicate.
  it.each(["12", "10"])("attaches a lone pair referencing %s to the attachment atom of an expanded OMe", reference => {
    const source = '<CDXML><page><graphic id="3" GraphicType="Symbol" SymbolType="LonePair" BoundingBox="92 72 89 68">' +
      `<represent object="${reference}" attribute="Radical"/></graphic><fragment id="1"><n id="2" Element="6" p="48 64"/>` +
      '<n id="10" NodeType="Fragment" p="70 64"><fragment id="11"><n id="12" Element="8" p="70 64"/>' +
      '<n id="13" Element="6" p="92 64"/><n id="14" NodeType="ExternalConnectionPoint" p="48 64"/>' +
      '<b id="15" B="14" E="12" Order="1"/><b id="16" B="12" E="13" Order="1"/></fragment>' +
      '<t p="66 68"><s font="3" size="10" face="96">OMe</s></t></n><b id="5" B="2" E="10" Order="1"/></fragment></page></CDXML>';
    const read = openChemDraftPayload(source);
    expect(read.warnings.filter(w => w.code === "cdxml.lone_pair_anchor_unresolved")).toEqual([]);
    const objects = read.document!.pages[0].objects;
    const molecule = objects.find(o => o.type === "molecule") as MoleculeObject;
    const oxygen = molecule.atoms.find(atom => atom.element === "O")!;
    const pair = objects.find(o => o.type === "electron-mark") as ElectronMarkObject;
    expect(pair.anchor).toMatchObject({ kind: "atom", objectId: molecule.id, atomId: oxygen.id });
    // Plain Save As keeps the attachment: the written reference resolves to the same oxygen.
    const reread = openChemDraftPayload(exportDocumentToCdxml(read.document!, { embedNativePayload: false }).contents);
    expect(reread.warnings.filter(w => w.code === "cdxml.lone_pair_anchor_unresolved")).toEqual([]);
    const rereadObjects = reread.document!.pages[0].objects;
    const rereadMolecule = rereadObjects.find(o => o.type === "molecule") as MoleculeObject;
    const rereadPair = rereadObjects.find(o => o.type === "electron-mark") as ElectronMarkObject;
    expect(rereadPair.anchor).toMatchObject({ kind: "atom", objectId: rereadMolecule.id,
      atomId: rereadMolecule.atoms.find(atom => atom.element === "O")!.id });
  });

  // Kimi run-20261122-093358-18979d: an abbreviation alias id is an occurrence of that id too. When it
  // collides with another node's id (here a nitrogen), the reference names two atoms and must not
  // resolve to the alias target, whether the colliding node sits in the same fragment or another one.
  const lonePairOn = (reference: string) => '<graphic id="3" GraphicType="Symbol" SymbolType="LonePair" BoundingBox="92 72 89 68">' +
    `<represent object="${reference}" attribute="Radical"/></graphic>`;
  const ome = '<n id="10" NodeType="Fragment" p="70 64"><fragment id="11"><n id="12" Element="8" p="70 64"/>' +
    '<n id="13" Element="6" p="92 64"/><n id="14" NodeType="ExternalConnectionPoint" p="48 64"/>' +
    '<b id="15" B="14" E="12" Order="1"/><b id="16" B="12" E="13" Order="1"/></fragment>' +
    '<t p="66 68"><s font="3" size="10" face="96">OMe</s></t></n>';
  const expectUnresolved = (source: string) => {
    const read = openChemDraftPayload(source);
    expect(read.warnings.filter(w => w.code === "cdxml.lone_pair_anchor_unresolved")).toHaveLength(1);
    const pair = read.document!.pages[0].objects.find(o => o.type === "electron-mark") as ElectronMarkObject;
    expect(pair.anchor).toMatchObject({ kind: "point" });
  };
  it.each([
    ["the same fragment", '<fragment id="1"><n id="2" Element="6" p="48 64"/>' + ome +
      '<b id="5" B="2" E="12" Order="1"/><n id="10" Element="7" p="20 120"/></fragment>'],
    ["another fragment, after it", '<fragment id="1"><n id="2" Element="6" p="48 64"/>' + ome +
      '<b id="5" B="2" E="12" Order="1"/></fragment><fragment id="30"><n id="10" Element="7" p="20 120"/></fragment>'],
    ["another fragment, before it", '<fragment id="30"><n id="10" Element="7" p="20 120"/></fragment>' +
      '<fragment id="1"><n id="2" Element="6" p="48 64"/>' + ome + '<b id="5" B="2" E="12" Order="1"/></fragment>']
  ])("does not attach a lone pair through an abbreviation alias that collides with a node in %s", (_where, fragments) => {
    expectUnresolved(`<CDXML><page>${lonePairOn("10")}${fragments}</page></CDXML>`);
  });

  // Kimi run-20261122-093358-18979d: ambiguity is decided over the whole page, so an id duplicated in
  // a later (or earlier) fragment never leaves another fragment's atom as the resolved anchor.
  it.each([
    ["the duplicate fragment comes later", '<fragment id="1"><n id="21" Element="8" p="70 64"/></fragment>' +
      '<fragment id="30"><n id="21" Element="6" p="20 120"/><n id="21" Element="7" p="40 120"/></fragment>'],
    ["the duplicate fragment comes first", '<fragment id="30"><n id="21" Element="6" p="20 120"/><n id="21" Element="7" p="40 120"/></fragment>' +
      '<fragment id="1"><n id="21" Element="8" p="70 64"/></fragment>'],
    ["each fragment holds the id once", '<fragment id="1"><n id="21" Element="8" p="70 64"/></fragment>' +
      '<fragment id="30"><n id="21" Element="7" p="20 120"/></fragment>']
  ])("does not attach a lone pair to a source id duplicated across fragments when %s", (_order, fragments) => {
    expectUnresolved(`<CDXML><page>${lonePairOn("21")}${fragments}</page></CDXML>`);
  });

  // A nested abbreviation (NH-OMe holding OMe) has two connection points, each aliased by its node id.
  // A lone pair on each attachment atom resolves through either the atom id or the alias, and survives
  // a plain Save As re-import.
  it.each([["12", "22"], ["10", "20"]])("attaches lone pairs referencing %s and %s through a nested abbreviation", (onNitrogen, onOxygen) => {
    const pair = (id: string, reference: string, x: number) => `<graphic id="${id}" GraphicType="Symbol" SymbolType="LonePair" ` +
      `BoundingBox="${x + 3} 72 ${x} 68"><represent object="${reference}" attribute="Radical"/></graphic>`;
    const source = '<CDXML><page>' + pair("3", onNitrogen, 70) + pair("4", onOxygen, 92) +
      '<fragment id="1"><n id="2" Element="6" p="48 64"/>' +
      '<n id="10" NodeType="Fragment" p="70 64"><fragment id="11"><n id="12" Element="7" p="70 64"/>' +
      '<n id="20" NodeType="Fragment" p="92 64"><fragment id="21"><n id="22" Element="8" p="92 64"/>' +
      '<n id="23" Element="6" p="114 64"/><n id="24" NodeType="ExternalConnectionPoint" p="70 64"/>' +
      '<b id="25" B="24" E="22" Order="1"/><b id="26" B="22" E="23" Order="1"/></fragment>' +
      '<t p="88 68"><s font="3" size="10" face="96">OMe</s></t></n>' +
      '<n id="14" NodeType="ExternalConnectionPoint" p="48 64"/>' +
      '<b id="15" B="14" E="12" Order="1"/><b id="16" B="12" E="20" Order="1"/></fragment>' +
      '<t p="66 68"><s font="3" size="10" face="96">NHOMe</s></t></n><b id="5" B="2" E="10" Order="1"/></fragment></page></CDXML>';
    const expectAttached = (read: ReturnType<typeof openChemDraftPayload>) => {
      expect(read.warnings.filter(w => w.code === "cdxml.lone_pair_anchor_unresolved")).toEqual([]);
      const objects = read.document!.pages[0].objects;
      const molecule = objects.find(o => o.type === "molecule") as MoleculeObject;
      const marks = objects.filter((o): o is ElectronMarkObject => o.type === "electron-mark");
      expect(marks).toHaveLength(2);
      const atomOf = (element: string) => molecule.atoms.filter(atom => atom.element === element);
      expect(atomOf("N")).toHaveLength(1);
      expect(atomOf("O")).toHaveLength(1);
      const byX = [...marks].sort((a, b) => a.x - b.x);
      expect(byX[0].anchor).toMatchObject({ kind: "atom", objectId: molecule.id, atomId: atomOf("N")[0].id });
      expect(byX[1].anchor).toMatchObject({ kind: "atom", objectId: molecule.id, atomId: atomOf("O")[0].id });
    };
    const read = openChemDraftPayload(source);
    expectAttached(read);
    expectAttached(openChemDraftPayload(exportDocumentToCdxml(read.document!, { embedNativePayload: false }).contents));
  });

  it.each([false, true])("warns when moving an imported doublet atom leaves its dot behind (legacy=%s)", legacy => {
    const imported = openChemDraftPayload('<CDXML><page><fragment id="1"><n id="2" p="100 100" Element="6" Radical="Doublet"/></fragment></page></CDXML>').document!;
    const molecule = imported.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    const mark = imported.pages[0].objects.find((object): object is ElectronMarkObject => object.type === "electron-mark")!;
    if (legacy) {
      const placement = mark.compatibility!.unknown.cdxmlRadicalMarkPlacement as Record<string, unknown>;
      delete placement.offsetX;
      delete placement.offsetY;
    }
    const moved = normalizeCommittedDocument(moveNativeMoleculeParts(imported, {
      kind: "atom", objectId: molecule.id, atomId: molecule.atoms[0].id
    }, { x: 100, y: 0 }));
    const movedMolecule = moved.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    expect(movedMolecule.atoms[0].x).toBeCloseTo(molecule.atoms[0].x + 100);
    expect(movedMolecule.atoms[0].markRadicals).toBe(1);
    expect(moved.pages[0].objects.find(object => object.id === mark.id)).toMatchObject({ x: mark.x, y: mark.y });
    for (const embedNativePayload of [false, true]) {
      const together = normalizeCommittedDocument(moveDocumentObject(imported, molecule.id, { x: molecule.x + 100, y: molecule.y }));
      for (const unchanged of [imported, together]) {
        for (const exported of [exportDocumentToCdxml(unchanged, { embedNativePayload }), exportDocumentToCdx(unchanged, { embedNativePayload })]) {
          expect(exported.warnings.filter(warning => warning.code === "cdxml.electron_mark_appearance_payload_only")).toEqual([]);
        }
      }
      for (const exported of [exportDocumentToCdxml(moved, { embedNativePayload }), exportDocumentToCdx(moved, { embedNativePayload })]) {
        expect(exported.warnings).toContainEqual(expect.objectContaining({
          code: "cdxml.electron_mark_appearance_payload_only", sourceObjectId: mark.id
        }));
      }
    }
  });

  it("keeps untouched legacy triplet placement metadata warning-free", () => {
    const imported = openChemDraftPayload('<CDXML><page><fragment id="1"><n id="2" p="100 100" Element="6" Radical="Triplet"/></fragment></page></CDXML>').document!;
    const marks = imported.pages[0].objects.filter((object): object is ElectronMarkObject => object.type === "electron-mark");
    // HEAD saved overlapping triplet frames and only absolute placement coordinates.
    for (const mark of marks) {
      mark.x = marks[0].x;
      mark.y = marks[0].y;
      mark.compatibility!.unknown.cdxmlRadicalMarkPlacement = {
        x: mark.x, y: mark.y, objectId: mark.anchor.objectId, atomId: mark.anchor.atomId
      };
    }
    for (const exported of [exportDocumentToCdxml(imported), exportDocumentToCdx(imported)]) {
      expect(exported.warnings).toEqual([]);
    }
  });

  it.each(["Doublet", "Triplet"])("exports imported %s dots without loss warnings until their appearance changes", radical => {
    const source = `<CDXML><page><fragment id="1"><n id="2" p="100 100" Element="6" Radical="${radical}"/></fragment></page></CDXML>`;
    const imported = openChemDraftPayload(source).document!;
    const binaryImported = importCdx(exportDocumentToCdx(imported, { embedNativePayload: false }).bytes).document!;
    for (const document of [imported, binaryImported]) {
      for (const embedNativePayload of [false, true]) {
        for (const format of ["CDXML", "CDX"] as const) {
          const exportDocument = (value: typeof document) => format === "CDXML"
            ? exportDocumentToCdxml(value, { embedNativePayload }) : exportDocumentToCdx(value, { embedNativePayload });
          // Synthesized dots carry Radical, while edited appearance still needs loss diagnostics.
          expect(exportDocument(document).warnings).toEqual([]);
          const edits: ((mark: ElectronMarkObject) => void)[] = [
            mark => { mark.x += 5; },
            mark => { mark.y += 5; },
            mark => { mark.width += 5; },
            mark => { mark.height += 5; },
            mark => { mark.rotation = 15; },
            mark => { mark.style.strokeWidth = 3; },
            mark => { mark.style.color = "#ff0000"; }
          ];
          for (const edit of edits) {
            const edited = structuredClone(document);
            const mark = edited.pages[0].objects.find((object): object is ElectronMarkObject => object.type === "electron-mark")!;
            edit(mark);
            const warnings = exportDocument(edited).warnings;
            expect(warnings).toContainEqual(expect.objectContaining({
              code: "cdxml.electron_mark_appearance_payload_only", sourceObjectId: mark.id
            }));
            expect(warnings.some(warning => warning.code === "cdxml.unknown_objects_not_saved")).toBe(!embedNativePayload);
          }
        }
      }
    }
  });

  it.each(["charge", "radical-dot", "lone-pair"] as const)("names a moved/resized/styled/rotated %s and preserves its exact native data", markKind => {
    const mark: ElectronMarkObject = { id: "authored-mark", type: "electron-mark", markKind,
      x: 260, y: 280, width: 72, height: 36, rotation: 37, style: { strokeWidth: 4.5 },
      ...(markKind === "charge" ? { charge: -2, radical: true } : {}),
      anchor: { kind: "point", point: { x: 296, y: 298 } } };
    const document = createEmptyDocument({ title: "Styled electron marks" });
    document.pages[0].objects.push(mark);
    const result = exportDocumentToCdxml(document);
    expect(result.warnings).toContainEqual({
      code: "cdxml.electron_mark_appearance_payload_only", sourceObjectId: mark.id,
      message: "CDXML export: electron mark authored-mark, including its position, size (72 × 36), thickness (4.5) and rotation (37°), is preserved only in the embedded ChemDraft payload; no visible CDXML symbol is written."
    });
    expect(openChemDraftPayload(result.contents).document?.pages[0].objects[0]).toEqual(mark);
  });
});
