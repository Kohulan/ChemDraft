// Issue #424: an independent check of the contributor's CDXML reader/writer changes.
//
// Every case goes through the call File > Save As makes for a .chemdraft/.cdxml document
// (apps/desktop createNativeSavePayload -> exportDocumentToCdxml(document), native payload embedded
// by default), then removes the embedded native document so that only the visible CDXML carries
// the drawing, and reopens it the way File > Open does. The fixtures are small, written for this
// test, and are not copied from any vendor sample.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyPatches, createEmptyDocument, moleculeToMolfileV2000,
  type ChemDraftDocument, type ElectronMarkObject, type GraphicObject, type MoleculeObject, type TextObject
} from "@chemdraft/chem-core";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
import { resetRdkitForTesting } from "../../rdkit-adapter/src/conformer";
import { computeStructureIdentifiers } from "../../rdkit-adapter/src/identifiers";
import { installRealRdkitModuleLoader } from "../../rdkit-adapter/src/testing";
import { ChemDraftObjectTags, exportDocumentToCdxml, openChemDraftPayload } from "./index";

beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

const pt = (value: number) => value * 4 / 3; // CDXML points -> document CSS pixels

/** Save As (exactly the desktop call), then reopen with the native payload removed. */
function saveAsWithoutPayload(document: ChemDraftDocument) {
  const saved = exportDocumentToCdxml(document);
  expect(saved.contents).toContain(ChemDraftObjectTags.nativeDocument);
  const plain = saved.contents.replace(/<objecttag\b[^>]*\/>/g, "");
  expect(plain).not.toContain("org.chemdraft/");
  const reopened = openChemDraftPayload(plain);
  expect(reopened.source).toBe("external-cdxml");
  expect(reopened.document).toBeDefined();
  return { saved, plain, reopened: reopened.document!, openWarnings: reopened.warnings };
}

function open(source: string): ChemDraftDocument {
  const opened = openChemDraftPayload(source);
  expect(opened.source).toBe("external-cdxml");
  return opened.document!;
}

const codes = (warnings: readonly { code: string }[]) => warnings.map(w => w.code);
const objectsOf = <T extends { type: string }>(document: ChemDraftDocument, type: T["type"]) =>
  document.pages[0]!.objects.filter(o => o.type === type) as unknown as T[];
const elementWith = (xml: string, name: string, attribute: string) =>
  xml.match(new RegExp(`<${name}\\b[^>]*${attribute}[^>]*>`))?.[0] ?? "";

const fontTable = '<fonttable><font id="3" charset="iso-8859-1" name="Arial"/></fonttable>';

describe("issue #424: arrowhead dimensions", () => {
  const straight = '<CDXML><page><arrow id="5" Head3D="160 50 0" Tail3D="40 50 0" ArrowheadHead="Full" ' +
    'ArrowheadType="Solid" HeadSize="1200" ArrowheadWidth="400" ArrowheadCenterSize="1000"/></page></CDXML>';

  it("keeps HeadSize, ArrowheadWidth and ArrowheadCenterSize on a straight arrow through two plain Save As cycles", () => {
    const document = open(straight);
    const arrow = objectsOf<GraphicObject>(document, "graphic")[0]!;
    expect(arrow.data.markerEnd?.sizePx).toBeCloseTo(pt(12), 6);
    const first = saveAsWithoutPayload(document);
    expect(first.saved.warnings).toEqual([]);
    const written = elementWith(first.plain, "arrow", 'HeadSize="');
    for (const a of ['HeadSize="1200"', 'ArrowheadWidth="400"', 'ArrowheadCenterSize="1000"']) expect(written).toContain(a);
    const again = objectsOf<GraphicObject>(first.reopened, "graphic")[0]!;
    expect(again.data.markerEnd?.sizePx).toBeCloseTo(pt(12), 6);
    const second = saveAsWithoutPayload(first.reopened);
    expect(elementWith(second.plain, "arrow", 'HeadSize="')).toBe(written);
  });

  it("scales all three dimensions together when the head is resized", () => {
    const document = open(straight);
    objectsOf<GraphicObject>(document, "graphic")[0]!.data.markerEnd!.sizePx = pt(6);
    const { plain, reopened } = saveAsWithoutPayload(document);
    const written = elementWith(plain, "arrow", 'HeadSize="');
    for (const a of ['HeadSize="600"', 'ArrowheadWidth="200"', 'ArrowheadCenterSize="500"']) expect(written).toContain(a);
    expect(objectsOf<GraphicObject>(reopened, "graphic")[0]!.data.markerEnd?.sizePx).toBeCloseTo(pt(6), 6);
  });
});

describe("issue #424: circular arrows", () => {
  // Circle of radius 30 pt around (100, 100), starting at 0 rad and sweeping 270 degrees.
  const arc = '<CDXML><page><arrow id="7" BoundingBox="70 70 130 130" AngularSize="270" Center3D="100 100 0" ' +
    'MajorAxisEnd3D="130 100 0" MinorAxisEnd3D="100 130 0" Tail3D="130 100 0" Head3D="100 70 0" HeadSize="1000" ' +
    'ArrowheadWidth="250" ArrowheadCenterSize="800" ArrowheadHead="Full" ArrowheadTail="None" ArrowheadType="Solid"/></page></CDXML>';

  it("stays an arc with its ellipse, sweep and head dimensions", () => {
    const document = open(arc);
    const graphic = objectsOf<GraphicObject>(document, "graphic")[0]!;
    expect(graphic.data).toMatchObject({ artPathKind: "arc", arcRadiusX: pt(30), arcRadiusY: pt(30) });
    const first = saveAsWithoutPayload(document);
    expect(first.saved.warnings).toEqual([]);
    expect(first.plain).not.toContain("<curve");
    const written = elementWith(first.plain, "arrow", "AngularSize=");
    for (const a of ['AngularSize="270"', 'Center3D="100 100 0"', 'MajorAxisEnd3D="130 100 0"', 'MinorAxisEnd3D="100 130 0"',
      'Tail3D="130 100 0"', 'Head3D="100 70 0"', 'HeadSize="1000"', 'ArrowheadWidth="250"', 'ArrowheadCenterSize="800"',
      'ArrowheadHead="Full"', 'ArrowheadTail="None"']) expect(written).toContain(a);
    const again = objectsOf<GraphicObject>(first.reopened, "graphic")[0]!;
    expect(again.data.artPathKind).toBe("arc");
    expect(again.data.arcCenter!.x).toBeCloseTo(pt(100), 6);
    expect(again.data.arcCenter!.y).toBeCloseTo(pt(100), 6);
    expect(again.data.arcRadiusX).toBeCloseTo(pt(30), 6);
    expect(again.data.arcRadiusY).toBeCloseTo(pt(30), 6);
    expect(again.data.arcSweepRadians).toBeCloseTo(3 * Math.PI / 2, 9);
    expect(again.data.markerEnd).toMatchObject({ kind: "filled-arrow" });
    expect(again.data.markerEnd!.sizePx).toBeCloseTo(pt(10), 6);
    const second = saveAsWithoutPayload(first.reopened);
    expect(second.plain).not.toContain("<curve");
    expect(elementWith(second.plain, "arrow", "AngularSize=")).toBe(written);
  });
});

describe("issue #424: caption layout", () => {
  it("keeps a framed two-run caption's fonts, baseline inset and centring after a move and an edit", () => {
    const source = `<CDXML>${fontTable}<page><t id="10" p="52 210" BoundingBox="40 200 100 214" Justification="Center">` +
      '<s font="3" size="12" face="1">Yield </s><s font="3" size="9" face="32">2</s></t></page></CDXML>';
    const document = open(source);
    const caption = objectsOf<TextObject>(document, "text")[0]!;
    caption.x += pt(6); caption.y += pt(3);
    caption.spans[0]!.text = "Yields "; caption.text = caption.spans.map(s => s.text).join("");
    const first = saveAsWithoutPayload(document);
    expect(codes(first.saved.warnings)).not.toContain("cdxml.text_source_formatting_not_kept");
    const t = elementWith(first.plain, "t", 'Justification="');
    expect(t).toContain('p="58 213"');
    expect(t).toContain('BoundingBox="46 203 106 217"');
    expect(t).toContain('Justification="Center"');
    const arialId = first.plain.match(/<font [^>]*id="(\d+)"[^>]*name="Arial"/)?.[1];
    expect(arialId).toBeTruthy();
    expect(first.plain).toContain(`<s font="${arialId}" size="12" face="1">Yields </s><s font="${arialId}" size="9" face="32">2</s>`);
    const reopened = objectsOf<TextObject>(first.reopened, "text")[0]!;
    expect(reopened.text).toBe("Yields 2");
    expect(reopened.style.textAlign).toBe("center");
    expect(reopened.spans[0]).toMatchObject({ style: { fontFamily: "Arial", fontSizePx: pt(12), fontWeight: 700 } });
    expect(reopened.spans[1]).toMatchObject({ text: "2", script: "subscript", style: { fontFamily: "Arial", fontSizePx: pt(9) } });
    const second = saveAsWithoutPayload(first.reopened);
    expect(elementWith(second.plain, "t", 'Justification="')).toBe(t);
  });

  it.each([
    ["point-anchored", ""],
    ["framed", ' BoundingBox="40 250 110 274"']
  ])("keeps a %s multiline caption's run format and baseline after a move and an edit", (_kind, box) => {
    const source = `<CDXML>${fontTable}<page><t id="11" p="40 260"${box} Justification="Left">` +
      '<s font="3" size="10" face="2">first line\nsecond line</s></t></page></CDXML>';
    const document = open(source);
    const caption = objectsOf<TextObject>(document, "text")[0]!;
    caption.x += pt(6);
    caption.text = "line A\nline B"; caption.spans[0]!.text = caption.text;
    const first = saveAsWithoutPayload(document);
    expect(codes(first.saved.warnings)).not.toContain("cdxml.text_source_formatting_not_kept");
    const t = elementWith(first.plain, "t", 'Justification="');
    expect(t).toContain('p="46 260"');
    expect(t).toContain('Justification="Left"');
    expect(first.plain).toMatch(/<s font="\d+" size="10" face="2">line A\nline B<\/s>/);
    const reopened = objectsOf<TextObject>(first.reopened, "text")[0]!;
    expect(reopened.text).toBe("line A\nline B");
    expect(reopened.spans[0]).toMatchObject({ style: { fontFamily: "Arial", fontSizePx: pt(10), fontStyle: "italic" } });
    expect(elementWith(saveAsWithoutPayload(first.reopened).plain, "t", 'Justification="')).toContain('p="46 260"');
  });
});

// Dimethyl ether with both oxygen lone pairs attached (one written before the fragment, one
// after) and one free lone pair.
const etherWithLonePairs = '<CDXML><page>' +
  '<graphic id="30" GraphicType="Symbol" SymbolType="LonePair" BoundingBox="100 93 103 93"><represent object="12" attribute="Radical"/></graphic>' +
  '<fragment id="10"><n id="11" p="80 100"/><n id="12" p="100 100" Element="8"/><n id="13" p="120 100"/>' +
  '<b id="14" B="11" E="12"/><b id="15" B="12" E="13"/></fragment>' +
  '<graphic id="31" GraphicType="Symbol" SymbolType="LonePair" BoundingBox="100 107 103 107"><represent object="12" attribute="Radical"/></graphic>' +
  '<graphic id="32" GraphicType="Symbol" SymbolType="LonePair" BoundingBox="200 60 200 57"/>' +
  '</page></CDXML>';

describe("issue #424: lone pairs", () => {
  it("keeps attached lone pairs on their atom and a free one at its point", () => {
    const document = open(etherWithLonePairs);
    const first = saveAsWithoutPayload(document);
    expect(codes(first.saved.warnings)).not.toContain("cdxml.electron_mark_appearance_payload_only");
    expect(first.plain.match(/SymbolType="LonePair"/g)).toHaveLength(3);
    const references = [...first.plain.matchAll(/<represent object="(\d+)" attribute="Radical"\/>/g)].map(m => m[1]);
    expect(references).toHaveLength(2);
    expect(new Set(references).size).toBe(1);
    expect(first.plain).toMatch(new RegExp(`<n (?=[^>]*id="${references[0]}")(?=[^>]*Element="8")`));
    expect(first.plain).not.toContain("Radical=");
    for (const reopened of [first.reopened, saveAsWithoutPayload(first.reopened).reopened]) {
      const molecule = objectsOf<MoleculeObject>(reopened, "molecule")[0]!;
      const oxygen = molecule.atoms.find(a => a.element === "O")!;
      const pairs = objectsOf<ElectronMarkObject>(reopened, "electron-mark");
      expect(pairs).toHaveLength(3);
      expect(pairs.every(p => p.markKind === "lone-pair")).toBe(true);
      const attached = pairs.filter(p => p.anchor.kind === "atom");
      expect(attached).toHaveLength(2);
      for (const p of attached) expect(p.anchor).toMatchObject({ kind: "atom", objectId: molecule.id, atomId: oxygen.id });
      const free = pairs.find(p => p.anchor.kind === "point")!;
      expect(free.x + free.width / 2).toBeCloseTo(pt(200), 6);
      expect(free.y + free.height / 2).toBeCloseTo(pt(60), 6);
      expect(free.width).toBeCloseTo(pt(6), 6);
      expect(oxygen.markRadicals ?? 0).toBe(0);
      expect(molecule.atoms.every(a => (a.markRadicals ?? 0) === 0)).toBe(true);
    }
  });

  it("does not attach a lone pair to an atom that is not the referenced one", () => {
    const opened = openChemDraftPayload(etherWithLonePairs.replaceAll('object="12"', 'object="404"'));
    expect(codes(opened.warnings)).toContain("cdxml.lone_pair_anchor_unresolved");
    expect(objectsOf<ElectronMarkObject>(opened.document!, "electron-mark").every(p => p.anchor.kind === "point")).toBe(true);
  });
});

describe("issue #424 follow-up: atomic number versus generic nickname", () => {
  // No reader in this tree records sourceAtomAttributesByAtomId, so the retained source attributes
  // are supplied here the way the contributor's own test does.
  function chargedHydrogen(source: Record<string, string>) {
    const base = createEmptyDocument({ title: "issue 424" });
    const molecule: MoleculeObject = {
      id: "mol_h", type: "molecule", x: 0, y: 0, width: 20, height: 20, rotation: 0, style: {},
      structureFormat: "smiles", structure: "", superatoms: [], rGroups: [], bonds: [],
      atoms: [{ id: "h", element: "H", x: 20, y: 30, formalCharge: 1, hydrogenCount: 0, labelLiteral: true }],
      compatibility: { warnings: [], unknown: { sourceAtomAttributesByAtomId: { h: source } } }
    };
    const document = structuredClone(applyPatches(base, [{ op: "addObject", pageId: base.pages[0]!.id, object: molecule }]));
    const live = objectsOf<MoleculeObject>(document, "molecule")[0]!;
    live.atoms[0]!.hydrogenCount = 0;
    return { document, atom: live.atoms[0]! };
  }
  const node = (xml: string) => xml.match(/<n\b[^>]*>/)?.[0] ?? "";

  it("writes an explicit element (not a nickname) when the retained atomic number and zero H agree", () => {
    const { document } = chargedHydrogen({ Element: "1", NumHydrogens: "0" });
    const { plain, reopened } = saveAsWithoutPayload(document);
    expect(node(plain)).toContain('Element="1"');
    expect(node(plain)).toContain('NumHydrogens="0"');
    expect(plain).not.toContain("GenericNickname");
    expect(objectsOf<MoleculeObject>(reopened, "molecule")[0]!.atoms[0]).toMatchObject({ element: "H", formalCharge: 1 });
  });

  it.each([
    ["the element was edited", { element: "Li" }, "Li"],
    ["a hydrogen was added", { hydrogenCount: 1 }, "H"]
  ])("never keeps a stale atomic number when %s", (_case, edit, element) => {
    const { document, atom } = chargedHydrogen({ Element: "1", NumHydrogens: "0" });
    Object.assign(atom, edit);
    const { plain, reopened } = saveAsWithoutPayload(document);
    expect(node(plain)).toContain('NodeType="GenericNickname"');
    expect(node(plain)).toContain(`GenericNickname="${element}"`);
    if (element !== "H") expect(node(plain)).not.toContain('Element="1"');
    const reopenedAtom = objectsOf<MoleculeObject>(reopened, "molecule")[0]!.atoms[0]!;
    expect(reopenedAtom.element).toBe(element);
    expect(reopenedAtom.formalCharge).toBe(1);
  });

  it("does not take the identity from a disagreeing retained atomic number", () => {
    const { document } = chargedHydrogen({ Element: "3", NumHydrogens: "0" });
    const { plain, reopened } = saveAsWithoutPayload(document);
    expect(node(plain)).toContain('GenericNickname="H"');
    expect(node(plain)).not.toContain('Element="3"');
    expect(objectsOf<MoleculeObject>(reopened, "molecule")[0]!.atoms[0]!.element).toBe("H");
  });
});

describe("issue #424 follow-up: spatial coordinates", () => {
  const withDepth = '<CDXML><page><fragment id="1">' +
    '<n id="2" p="100 100" xyz="100 100 -12" Element="8"/><n id="3" p="120 100" xyz="120 100 4.5"/>' +
    '<n id="4" xyz="140 90 7"/><n id="5" p="160 100"/><b id="6" B="2" E="3"/><b id="7" B="3" E="4"/><b id="8" B="4" E="5"/>' +
    '</fragment></page></CDXML>';

  it("keeps the xyz triple (depth included) through Save As, also after a move", () => {
    const document = open(withDepth);
    const molecule = objectsOf<MoleculeObject>(document, "molecule")[0]!;
    expect(molecule.atoms.map(a => a.z)).toEqual([pt(-12), pt(4.5), pt(7), undefined]);
    expect(molecule.atoms[2]).toMatchObject({ x: pt(140), y: pt(90) });
    for (const atom of molecule.atoms) atom.x += pt(10);
    const first = saveAsWithoutPayload(document);
    for (const xyz of ['xyz="110 100 -12"', 'xyz="130 100 4.5"', 'xyz="150 90 7"']) expect(first.plain).toContain(xyz);
    expect(first.plain.match(/ xyz="/g)).toHaveLength(3);
    for (const reopened of [first.reopened, saveAsWithoutPayload(first.reopened).reopened]) {
      const atoms = objectsOf<MoleculeObject>(reopened, "molecule")[0]!.atoms;
      expect(atoms.map(a => a.z)).toEqual([pt(-12), pt(4.5), pt(7), undefined]);
      for (const [i, atom] of atoms.entries()) {
        expect(atom.x).toBeCloseTo(molecule.atoms[i]!.x, 6);
        expect(atom.y).toBeCloseTo(molecule.atoms[i]!.y, 6);
      }
    }
  });

  it("does not invent a depth when the page and spatial projections disagree", () => {
    const atoms = objectsOf<MoleculeObject>(open(withDepth.replace('xyz="120 100 4.5"', 'xyz="125 100 4.5"')), "molecule")[0]!.atoms;
    expect(atoms[1]).toMatchObject({ x: pt(120), y: pt(100) });
    expect(atoms[1]!.z).toBeUndefined();
  });
});

describe("issue #424: chemistry invariants through a plain Save As of a whole scheme", () => {
  // (S)-alaninate zwitterion with a wedge, an attached lone pair, depths on two atoms, a captioned
  // straight arrow and a circular arrow, all on one page.
  const scheme = `<CDXML>${fontTable}<page>` +
    '<graphic id="40" GraphicType="Symbol" SymbolType="LonePair" BoundingBox="126 84 129 84"><represent object="26" attribute="Radical"/></graphic>' +
    '<fragment id="20">' +
    '<n id="21" p="60 100" xyz="60 100 3"/><n id="22" p="80 90" xyz="80 90 -2"/><n id="23" p="80 70" Element="7" Charge="1"/>' +
    '<n id="24" p="100 100"/><n id="25" p="100 120" Element="8"/><n id="26" p="120 90" Element="8" Charge="-1"/>' +
    '<b id="31" B="22" E="21" Display="WedgeBegin"/><b id="32" B="22" E="23"/><b id="33" B="22" E="24"/>' +
    '<b id="34" B="24" E="25" Order="2"/><b id="35" B="24" E="26"/></fragment>' +
    '<arrow id="50" Head3D="260 100 0" Tail3D="160 100 0" ArrowheadHead="Full" ArrowheadType="Solid" HeadSize="1200" ArrowheadWidth="400" ArrowheadCenterSize="1000"/>' +
    '<t id="51" p="190 92" BoundingBox="180 82 240 94" Justification="Center"><s font="3" size="10" face="0">heat</s></t>' +
    '<arrow id="52" BoundingBox="270 70 330 130" AngularSize="270" Center3D="300 100 0" MajorAxisEnd3D="330 100 0" ' +
    'MinorAxisEnd3D="300 130 0" Tail3D="330 100 0" Head3D="300 70 0" HeadSize="1000" ArrowheadHead="Full" ArrowheadTail="None" ArrowheadType="Solid"/>' +
    '</page></CDXML>';

  async function canonical(molecule: MoleculeObject): Promise<string> {
    const molfile = moleculeToMolfileV2000(molecule, {
      fromDocFrame: true, kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders
    }).contents;
    const result = await computeStructureIdentifiers(molfile);
    if (!result?.smiles) throw new Error("RDKit could not canonicalize the molecule");
    return result.smiles;
  }
  const chemistry = (m: MoleculeObject) => ({
    atoms: m.atoms.map(a => ({ element: a.element, charge: a.formalCharge ?? 0, isotope: a.isotope, radicals: a.markRadicals ?? 0,
      hydrogens: a.hydrogenCount, x: a.x, y: a.y, z: a.z })),
    bonds: m.bonds.map(b => ({ order: b.order, stereo: b.stereo, bondStyle: b.display?.bondStyle,
      from: m.atoms.findIndex(a => a.id === b.fromAtomId), to: m.atoms.findIndex(a => a.id === b.toAtomId) }))
  });

  it("keeps canonical SMILES, charges, stereo, counts, coordinates and every #424 feature", async () => {
    const document = open(scheme);
    const source = objectsOf<MoleculeObject>(document, "molecule")[0]!;
    const smiles = await canonical(source);
    expect(smiles).toContain("@");
    expect(source.bonds.some(b => b.display?.bondStyle)).toBe(true);
    let current = document;
    for (let cycle = 0; cycle < 2; cycle++) {
      const { plain, reopened } = saveAsWithoutPayload(current);
      const molecules = objectsOf<MoleculeObject>(reopened, "molecule");
      expect(molecules).toHaveLength(1);
      const molecule = molecules[0]!;
      expect(molecule.atoms).toHaveLength(6);
      expect(molecule.bonds).toHaveLength(5);
      expect(await canonical(molecule)).toBe(smiles);
      const now = chemistry(molecule), was = chemistry(source);
      expect(now.bonds).toEqual(was.bonds);
      for (const [i, atom] of now.atoms.entries()) {
        expect(atom).toMatchObject({ element: was.atoms[i]!.element, charge: was.atoms[i]!.charge, isotope: was.atoms[i]!.isotope,
          radicals: was.atoms[i]!.radicals, hydrogens: was.atoms[i]!.hydrogens, z: was.atoms[i]!.z });
        expect(atom.x).toBeCloseTo(was.atoms[i]!.x, 6);
        expect(atom.y).toBeCloseTo(was.atoms[i]!.y, 6);
      }
      expect(molecule.atoms.map(a => a.formalCharge ?? 0).reduce((s, c) => s + c, 0)).toBe(0);
      const pair = objectsOf<ElectronMarkObject>(reopened, "electron-mark")[0]!;
      expect(pair.anchor).toMatchObject({ kind: "atom", objectId: molecule.id, atomId: molecule.atoms[5]!.id });
      const graphics = objectsOf<GraphicObject>(reopened, "graphic");
      expect(graphics.map(g => g.data.artPathKind).sort()).toEqual(["arc", "line"]);
      expect(plain).toContain('HeadSize="1200" ArrowheadWidth="400" ArrowheadCenterSize="1000"');
      expect(elementWith(plain, "t", 'Justification="')).toContain('p="190 92" BoundingBox="180 82 240 94" Justification="Center"');
      current = reopened;
    }
  });
});
