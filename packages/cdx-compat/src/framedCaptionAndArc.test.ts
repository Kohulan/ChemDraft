import { expect, it } from "vitest";
import { createEmptyDocument, type GraphicObject, type TextObject } from "@chemdraft/chem-core";
import { exportDocumentToCdxml, openChemDraftPayload } from "./index";
import { cdxmlFontOperationsForTesting, resetCdxmlFontOperationsForTesting } from "./cdxmlFontIndex";

const plain = { embedNativePayload: false };

it("saves restored caption baselines and styled runs, including moves and edits after plain import", () => {
  const base = { fontFamily: "Helvetica", fontSizePx: 16, color: "#000000", textAlign: "center", lineHeight: 1.2 };
  const t: TextObject = {
    type: "text", id: "caption", x: 36, y: 80, width: 40, height: 22, rotation: 0, text: "H+",
    style: base, spans: [{ text: "H", script: "normal", style: {} }, { text: "+", script: "superscript",
      style: { fontFamily: "Times", fontSizePx: 12, fontWeight: 700, fontStyle: "italic", textDecoration: "underline", color: "#008800" } }],
    compatibility: { warnings: [], unknown: { sourceCdxmlAttributes: {
      p: "30 72", BoundingBox: "30 60 54 72", Justification: "Center" } } }
  };
  const document = createEmptyDocument();
  document.pages[0].objects = [t];
  t.x += 8; t.y += 4;
  const exported = exportDocumentToCdxml(document, plain);
  expect(exported.warnings).toEqual([]);
  expect(exported.contents).toContain('p="36 75" BoundingBox="36 63 60 75" Justification="Center"');
  expect(exported.contents).toContain('size="9" face="71"');
  const reopened = openChemDraftPayload(exported.contents).document!;
  const caption = reopened.pages[0].objects[0] as TextObject;
  expect(caption.spans[1]).toMatchObject({ text: "+", script: "superscript", style: { fontFamily: "Times", fontSizePx: 12, color: "#008800" } });
  expect(caption.style.textAlign).toBe("center");
  caption.x += 4; caption.y -= 8;
  expect(exportDocumentToCdxml(reopened, plain).contents).toContain('p="39 69"');
  caption.spans[1].text = "2"; caption.text = "H2"; caption.spans[1].script = "subscript"; caption.width += 8;
  const edited = exportDocumentToCdxml(reopened, plain);
  expect(edited.warnings).toEqual([]);
  expect(edited.contents).toContain('p="39 69" BoundingBox="39 57 69 69"');
  expect(edited.contents).toContain('size="9" face="39"');
  caption.style.letterSpacingPx = 4;
  expect(exportDocumentToCdxml(reopened, plain).warnings.some(w => w.code === "cdxml.text_format_native_only")).toBe(true);
});

it("writes the live ellipse, signed sweep and directed, proportional head dimensions", () => {
  const source = '<CDXML><page><arrow id="8" AngularSize="-90" Center3D="60 60 0" MajorAxisEnd3D="90 60 0" MinorAxisEnd3D="60 80 0" Tail3D="90 60 0" Head3D="60 40 0" BoundingBox="30 40 90 80" HeadSize="900" ArrowheadWidth="225" ArrowheadCenterSize="450" ArrowheadHead="None" ArrowheadTail="Full" ArrowheadType="Solid"/></page></CDXML>';
  const document = openChemDraftPayload(source).document!;
  const g = document.pages[0].objects[0] as GraphicObject;
  expect(g.data.arcRadiusX).toBe(40);
  expect(g.data.markerStart?.sizePx).toBe(12);
  g.data.arcCenter = { x: 88, y: 92 }; g.data.arcRadiusY = 16;
  g.data.arcSweepRadians = Math.PI / 2; g.data.markerStart!.sizePx = 24;
  const output = exportDocumentToCdxml(document, plain);
  expect(output.warnings).toEqual([]);
  expect(output.contents).not.toContain("<curve ");
  for (const attr of ['Center3D="66 69 0"', 'Head3D="66 81 0"', 'Tail3D="96 69 0"', 'AngularSize="90"',
    'HeadSize="1800"', 'ArrowheadWidth="450"', 'ArrowheadCenterSize="900"', 'ArrowheadTail="Full"']) expect(output.contents).toContain(attr);
  const reopened = openChemDraftPayload(output.contents).document!;
  const again = reopened.pages[0].objects[0] as GraphicObject;
  expect(again.data).toMatchObject({ artPathKind: "arc", arcCenter: { x: 88, y: 92 }, arcRadiusX: 40, arcRadiusY: 16,
    arcSweepRadians: Math.PI / 2, markerStart: { kind: "filled-arrow", sizePx: 24 } });
  expect(exportDocumentToCdxml(reopened, plain).warnings).toEqual([]);
});

it("retains point-only and multiline caption runs through an edit and a second plain save", () => {
  for (const box of ["", ' BoundingBox="20 20 60 45"']) {
    const source = '<CDXML><fonttable><font id="2" name="Helvetica"/></fonttable><page><t id="9" p="20 30"' + box +
      ' Justification="Left"><s font="2" size="10" face="1">first\nsecond\n</s></t></page></CDXML>';
    const doc = openChemDraftPayload(source).document!;
    const text = doc.pages[0].objects[0] as TextObject;
    text.x += 8; text.text = "a\nb\n"; text.spans[0].text = text.text;
    const out = exportDocumentToCdxml(doc, plain);
    expect(out.warnings).toEqual([]);
    expect(out.contents).toContain('p="26 30"');
    expect(out.contents).toContain('size="10" face="1"');
    const reopened = openChemDraftPayload(out.contents).document!;
    expect((reopened.pages[0].objects[0] as TextObject).text).toBe(text.text);
    expect(exportDocumentToCdxml(reopened, plain).contents).toContain('p="26 30"');
  }
});

it("retains and resizes explicit straight arrowhead dimensions on plain CDXML round trips", () => {
  const source = '<CDXML><page><arrow id="8" Head3D="60 60 0" Tail3D="20 60 0" ArrowheadHead="Full" ArrowheadType="Solid" HeadSize="900" ArrowheadWidth="300" ArrowheadCenterSize="700"/></page></CDXML>';
  const doc = openChemDraftPayload(source).document!;
  const graphic = doc.pages[0].objects[0] as GraphicObject;
  expect(graphic.data.markerEnd?.sizePx).toBe(12);
  graphic.data.markerEnd!.sizePx = 18;
  const out = exportDocumentToCdxml(doc, plain);
  expect(out.warnings).toEqual([]);
  for (const a of ['HeadSize="1350"', 'ArrowheadWidth="450"', 'ArrowheadCenterSize="1050"']) expect(out.contents).toContain(a);
  const again = openChemDraftPayload(out.contents).document!;
  expect((again.pages[0].objects[0] as GraphicObject).data.markerEnd?.sizePx).toBe(18);
});

// CodeRabbit 4658591585: once its heads are removed, a stored arc still saves its own sweep.
it.each([["0.5", 0.5], ["360", 360], ["-90", -90]])("keeps a stored arc's %s degree sweep after its head is removed", (angular, degrees) => {
  const end = (d: number) => { const r = d * Math.PI / 180; return `${60 + 30 * Math.cos(r)} ${60 + 20 * Math.sin(r)} 0`; };
  const source = `<CDXML><page><arrow id="8" AngularSize="${angular}" Center3D="60 60 0" MajorAxisEnd3D="90 60 0" MinorAxisEnd3D="60 80 0" Tail3D="90 60 0" Head3D="${end(degrees)}" BoundingBox="30 40 90 80" HeadSize="900" ArrowheadHead="Full" ArrowheadType="Solid"/></page></CDXML>`;
  const document = openChemDraftPayload(source).document!;
  const g = document.pages[0].objects[0] as GraphicObject;
  expect(g.data.arcSweepRadians).toBeCloseTo(degrees * Math.PI / 180, 10);
  g.data.markerEnd = undefined; g.data.markerStart = undefined;
  const output = exportDocumentToCdxml(document, plain);
  expect(output.contents).toContain(`AngularSize="${angular}"`);
  const again = openChemDraftPayload(output.contents).document!.pages[0].objects[0] as GraphicObject;
  expect(again.data.arcSweepRadians).toBeCloseTo(degrees * Math.PI / 180, 6);
});

// Codex (1.2.3): AngularSize was written with four decimals, so a valid sweep under 0.00005 degrees
// was saved as 0 and reopened at the old 1 degree minimum.
const tinyArc = (angular: string, degrees: number) => {
  const end = (d: number) => { const r = d * Math.PI / 180; return `${60 + 30 * Math.cos(r)} ${60 + 20 * Math.sin(r)} 0`; };
  return `<CDXML><page><arrow id="8" AngularSize="${angular}" Center3D="60 60 0" MajorAxisEnd3D="90 60 0" MinorAxisEnd3D="60 80 0" Tail3D="90 60 0" Head3D="${end(degrees)}" BoundingBox="30 40 90 80" HeadSize="900" ArrowheadHead="Full" ArrowheadType="Solid"/></page></CDXML>`;
};
it.each([["0.00001", 0.00001], ["-0.00002", -0.00002], ["0.0000000123", 0.0000000123]])(
  "keeps a stored arc's tiny %s degree sweep through a save, with and without its head", (angular, degrees) => {
    const radians = degrees * Math.PI / 180;
    for (const withoutHead of [false, true]) {
      const document = openChemDraftPayload(tinyArc(angular, degrees)).document!;
      const g = document.pages[0].objects[0] as GraphicObject;
      expect(g.data.arcSweepRadians! / radians).toBeCloseTo(1, 9);
      g.data.arcCenter = { x: g.data.arcCenter!.x + 4, y: g.data.arcCenter!.y };
      if (withoutHead) { g.data.markerEnd = undefined; g.data.markerStart = undefined; }
      const output = exportDocumentToCdxml(document, plain);
      expect(output.warnings).toEqual([]);
      expect(output.contents).toContain(`AngularSize="${angular}"`);
      const again = openChemDraftPayload(output.contents).document!.pages[0].objects[0] as GraphicObject;
      expect(again.data.artPathKind).toBe("arc");
      expect(again.data.arcSweepRadians! / radians).toBeCloseTo(1, 6);
    }
  });

it("writes a sweep too small for CDXML as the smallest sweep it holds, with a warning", () => {
  const document = openChemDraftPayload(tinyArc("1e-118", 1e-118)).document!;
  const g = document.pages[0].objects[0] as GraphicObject;
  g.data.markerEnd = undefined;
  const output = exportDocumentToCdxml(document, plain);
  expect(output.contents).toContain(`AngularSize="0.${"0".repeat(99)}1"`);
  expect(output.warnings.map(warning => warning.code)).toEqual(["cdxml.arc_sweep_rounded"]);
  const again = openChemDraftPayload(output.contents).document!.pages[0].objects[0] as GraphicObject;
  expect(again.data.arcSweepRadians).toBeGreaterThan(0);
  expect(again.data.arcSweepRadians).toBeLessThan(1e-90);
});

// Codex 4658948336: resolving each caption run's font by a linear search of the font table made
// a crafted file O(fonts × runs). Fonts are looked up by id from a map built once per document,
// and the font table and a caption's runs are capped at CDX's 16-bit limit (65,535).
// Before the map, 40,000 runs against 40,000 fonts took about 9 s. These tests count font-table
// work (entries indexed or merged, plus lookups; `cdxmlFontIndex.ts`) instead of timing it, so
// they cannot flake on a loaded runner: linear work is a small multiple of fonts + runs, while
// any return of the quadratic search would cost fonts × runs (1.6 billion here).
const fontTable = (count: number, name = (id: number) => `Font${id}`) =>
  `<fonttable>${Array.from({ length: count }, (_, i) => `<font id="${i + 1}" charset="iso-8859-1" name="${name(i + 1)}"/>`).join("")}</fonttable>`;
const caption = (id: number, runs: number, font: number, y = 72) =>
  `<t id="${id}" p="30 ${y}" BoundingBox="30 ${y - 12} 54 ${y}" Justification="Left">` +
  `${Array.from({ length: runs }, () => `<s font="${font}" size="10" face="0">x</s>`).join("")}</t>`;
const counted = <T>(run: () => T) => {
  resetCdxmlFontOperationsForTesting();
  const result = run();
  return { result, operations: cdxmlFontOperationsForTesting() };
};
const countedOpen = (source: string) => {
  const { result: opened, operations } = counted(() => openChemDraftPayload(source));
  return { opened, operations };
};
const textsOf = (opened: ReturnType<typeof openChemDraftPayload>) =>
  opened.document!.pages[0].objects.filter((object): object is TextObject => object.type === "text");

it("resolves 40,000 caption runs against 40,000 fonts with linear work", () => {
  const { opened, operations } = countedOpen(`<CDXML>${fontTable(40_000)}<page>${caption(9, 40_000, 40_000)}</page></CDXML>`);
  expect(operations).toBeLessThanOrEqual(2 * (40_000 + 40_000));
  const [text] = textsOf(opened);
  expect(text?.spans).toHaveLength(40_000);
  // A run states its font only where it differs from the caption's own (here, none do).
  expect(text?.spans[39_999]?.style.fontFamily ?? text?.style.fontFamily).toBe("Font40000");
  expect(text?.style.fontFamily).toBe("Font40000");
  expect(opened.warnings.map((warning) => warning.code)).not.toContain("cdxml.font_table_truncated");
  // Saving it again builds the CDXML font table once and indexes it by name (Codex security finding).
  const saved = counted(() => exportDocumentToCdxml(opened.document!, plain));
  expect(saved.operations).toBeLessThanOrEqual(4 * (40_000 + 40_000));
  expect(saved.result.contents.match(/<font /g)).toHaveLength(40_000);
});

// Codex: Save As wrote an edited caption by scanning the font table for every run (the
// 40,000-font, 40,000-run file took ~68 s); fonts are looked up by name, so saving is linear too.
it("saves an edited 40,000-run caption against 40,000 fonts with linear work", () => {
  const opened = openChemDraftPayload(`<CDXML>${fontTable(40_000)}<page>${caption(9, 40_000, 40_000)}</page></CDXML>`);
  const [text] = textsOf(opened);
  text.spans[0].text = "y";
  text.text = `y${text.text.slice(1)}`;
  const saved = counted(() => exportDocumentToCdxml(opened.document!, plain));
  expect(saved.operations).toBeLessThanOrEqual(4 * (40_000 + 40_000));
  expect(saved.result.warnings).toEqual([]);
  expect(saved.result.contents.match(/<s font="40000" size="10" face="0">/g)).toHaveLength(40_000);
  expect(saved.result.contents).toContain('<s font="40000" size="10" face="0">y</s>');
  const [again] = textsOf(openChemDraftPayload(saved.result.contents));
  expect(again?.text).toBe(text.text);
  expect(again?.spans[0]?.style.fontFamily ?? again?.style.fontFamily).toBe("Font40000");
});

it("resolves a duplicated font id to its first entry, as before", () => {
  const source = '<CDXML><fonttable><font id="3" charset="iso-8859-1" name="Arial"/><font id="3" charset="iso-8859-1" name="Times"/></fonttable>' +
    `<page>${caption(9, 1, 3)}</page></CDXML>`;
  expect(textsOf(openChemDraftPayload(source))[0]?.style.fontFamily).toBe("Arial");
});

it("keeps the first 65,535 fonts of an oversized font table, warns, and does linear work", () => {
  const source = `<CDXML>${fontTable(70_000)}<page>${caption(9, 1, 3)}${caption(10, 1, 70_000, 120)}</page></CDXML>`;
  const { opened, operations } = countedOpen(source);
  expect(operations).toBeLessThanOrEqual(2 * (70_000 + 2));
  const truncated = opened.warnings.filter((warning) => warning.code === "cdxml.font_table_truncated");
  expect(truncated.map((warning) => warning.message)).toEqual([
    "CDXML import: the font table lists 70000 fonts, more than the 65535 supported; only the first 65535 were imported, and text set in a later font keeps the default font."
  ]);
  const [kept, dropped] = textsOf(opened);
  expect(kept?.style.fontFamily).toBe("Font3");
  expect(dropped?.text).toBe("x");
  expect(dropped?.style.fontFamily).toBeUndefined();
});

it("imports a caption with more than 65,535 runs as plain text with a warning, resolving none of its fonts", () => {
  const { opened, operations } = countedOpen(`<CDXML>${fontTable(3)}<page>${caption(9, 70_000, 3)}</page></CDXML>`);
  expect(operations).toBeLessThanOrEqual(3);
  const [text] = textsOf(opened);
  expect(text?.text).toBe("x".repeat(70_000));
  expect(text?.style.fontFamily).toBeUndefined();
  expect(text?.compatibility?.unknown.sourceCdxmlAttributes).toBeUndefined();
  expect(opened.warnings.filter((warning) => warning.code === "cdxml.text_runs_truncated").map((warning) => warning.message)).toEqual([
    "CDXML import: text 9 has 70000 styled runs, more than the 65535 supported; its caption frame and run fonts were not restored, and it was imported as plain styled text."
  ]);
});

// Codex security finding: every caption shared the whole font table, and saving wrote a copy per
// caption, so a crafted file of many captions over many fonts saved a payload quadratic in its size.
it("shares the whole font table only within a budget, so many captions over many fonts save linearly", () => {
  const count = 1_000;
  const source = `<CDXML>${fontTable(count)}<page>${Array.from({ length: count }, (_, i) => caption(i + 10, 1, i + 1, 72 + i)).join("")}</page></CDXML>`;
  const { opened, operations } = countedOpen(source);
  expect(operations).toBeLessThanOrEqual(2 * (count + count));
  const texts = textsOf(opened);
  expect(texts).toHaveLength(count);
  expect(texts.map(text => text.style.fontFamily)).toEqual(Array.from({ length: count }, (_, i) => `Font${i + 1}`));
  const tables = texts.map(text => text.compatibility?.unknown.cdxmlTextFontTable as unknown[]);
  expect(tables[0]).toHaveLength(count);
  // 16,384 entries (`CDXML_TEXT_FONT_TABLE_COPY_LIMIT`) at most beyond the first whole table, plus one per run.
  expect(tables.reduce((total, table) => total + table.length, 0)).toBeLessThanOrEqual(count + 16_384 + count);
  expect(tables.at(-1)).toEqual([{ id: String(count), charset: "iso-8859-1", name: `Font${count}` }]);
  const saved = counted(() => exportDocumentToCdxml(opened.document!, plain));
  expect(saved.operations).toBeLessThanOrEqual(4 * (count + 16_384 + count));
  // The saved font table still lists every source font, in source order.
  expect([...saved.result.contents.matchAll(/<font id="(\d+)"/g)].map(match => Number(match[1])))
    .toEqual(Array.from({ length: count }, (_, i) => i + 1));
  const again = openChemDraftPayload(saved.result.contents);
  expect(textsOf(again).map(text => text.style.fontFamily)).toEqual(texts.map(text => text.style.fontFamily));
});

it("keeps sharing the whole font table across an ordinary document's captions", () => {
  const source = `<CDXML>${fontTable(3)}<page>${caption(9, 2, 1)}${caption(10, 1, 3, 120)}${caption(11, 3, 2, 160)}</page></CDXML>`;
  const texts = textsOf(openChemDraftPayload(source));
  for (const text of texts) expect(text.compatibility?.unknown.cdxmlTextFontTable).toHaveLength(3);
});

// The per-caption cap still let a crafted file stack many capped captions; the document-wide cap
// (262,144 runs, `CDXML_DOCUMENT_CAPTION_RUN_LIMIT`) bounds the total, and keeps every caption's text.
it("restores captions up to the document-wide run cap and imports the rest as plain styled text, with one warning", { timeout: 60_000 }, () => {
  const source = `<CDXML>${fontTable(3)}<page>${Array.from({ length: 6 }, (_, i) => caption(i + 10, 55_000, 2, 72 + 20 * i)).join("")}</page></CDXML>`;
  const { opened, operations } = countedOpen(source);
  expect(operations).toBeLessThanOrEqual(2 * (3 + 6 * 55_000));
  const texts = textsOf(opened);
  expect(texts.map(text => text.text.length)).toEqual(Array(6).fill(55_000));
  expect(texts.map(text => text.style.fontFamily)).toEqual(["Font2", "Font2", "Font2", "Font2", undefined, undefined]);
  expect(texts.map(text => text.compatibility?.unknown.sourceCdxmlAttributes !== undefined)).toEqual([true, true, true, true, false, false]);
  expect(opened.warnings.filter(warning => warning.code === "cdxml.document_caption_runs_limited").map(warning => warning.message)).toEqual([
    "CDXML import: the captions in this document have more than 262144 styled runs in total; from text 14 on, captions past that total were imported as plain styled text, without their caption frame and run fonts."
  ]);
});

it("writes restored captions past the document-wide run cap as plain styled text, with one warning", { timeout: 60_000 }, () => {
  const document = createEmptyDocument();
  document.pages[0].objects = Array.from({ length: 6 }, (_, i): TextObject => ({
    type: "text", id: `caption${i}`, x: 36, y: 80 + 30 * i, width: 40, height: 22, rotation: 0, text: "x".repeat(55_000),
    style: { fontFamily: `Face${i}`, fontSizePx: 16 },
    spans: Array.from({ length: 55_000 }, () => ({ text: "x", script: "normal" as const, style: {} })),
    compatibility: { warnings: [], unknown: { sourceCdxmlAttributes: { p: `30 ${72 + 30 * i}`, Justification: "Left" } } }
  }));
  const saved = counted(() => exportDocumentToCdxml(document, plain));
  expect(saved.operations).toBeLessThanOrEqual(4 * 6 * 55_000);
  // Only the captions within the cap register (and are written with) their fonts.
  expect([...saved.result.contents.matchAll(/<font [^>]*name="([^"]+)"/g)].map(match => match[1])).toEqual(["Face0", "Face1", "Face2", "Face3"]);
  expect(saved.result.contents.match(/<t /g)).toHaveLength(6);
  expect(saved.result.contents.match(/>x</g)?.length ?? 0).toBeGreaterThanOrEqual(4 * 55_000);
  expect(saved.result.warnings.filter(warning => warning.code === "cdxml.document_caption_runs_limited").map(warning => warning.message)).toEqual([
    "CDXML export: the captions in this document have more than 262144 styled runs in total; from text caption4 on, captions past that total were written as plain styled text, without their caption frame and run fonts."
  ]);
  const again = openChemDraftPayload(saved.result.contents);
  expect(textsOf(again).map(text => text.text)).toEqual(document.pages[0].objects.map(object => (object as TextObject).text));
});
