import { expect, it, vi } from "vitest";
import { createEmptyDocument, type GraphicObject, type TextObject } from "@chemdraft/chem-core";
import { exportDocumentToCdxml, openChemDraftPayload } from "./index";
import {
  cdxmlFontOperationsForTesting, resetCdxmlFontOperationsForTesting,
  startCdxmlFontTableTrackingForTesting, stopCdxmlFontTableTrackingForTesting
} from "./cdxmlFontIndex";
import { withCdxmlLimitsForTesting } from "./testSupport/lowerCdxmlLimits";

// Lowered caps come from a test-local mutable copy of the module; the frozen production object is
// never touched (its real values are pinned in cdxmlLimits.test.ts).
vi.mock("./cdxmlLimits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cdxmlLimits")>();
  return { ...actual, cdxmlLimits: { ...actual.cdxmlLimits } };
});

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
// any return of the quadratic search would cost fonts × runs (4 million at the N = 2,000 used
// here, 500 times the linear bound). Helper calls alone would miss a raw `table.find(...)` per
// run, so the many-run tests also count every element read of the font tables (and per-caption
// copies) built while counting, and stop with an error once a read budget is spent.
//
// Sizes are small on purpose: 40,000-element fixtures ran long synchronous loops that blocked the
// vitest worker (Windows CI: "Timeout calling onTaskUpdate"). A per-element bound proves linear
// work at any N, and tests that must cross a cap lower it (`withCdxmlLimitsForTesting`); the
// production caps are pinned below.
const fontTable = (count: number, name = (id: number) => `Font${id}`) =>
  `<fonttable>${Array.from({ length: count }, (_, i) => `<font id="${i + 1}" charset="iso-8859-1" name="${name(i + 1)}"/>`).join("")}</fonttable>`;
const caption = (id: number, runs: number, font: number, y = 72) =>
  `<t id="${id}" p="30 ${y}" BoundingBox="30 ${y - 12} 54 ${y}" Justification="Left">` +
  `${Array.from({ length: runs }, () => `<s font="${font}" size="10" face="0">x</s>`).join("")}</t>`;
const counted = <T>(run: () => T, tableReadLimit = Number.POSITIVE_INFINITY) => {
  resetCdxmlFontOperationsForTesting();
  startCdxmlFontTableTrackingForTesting(tableReadLimit);
  let result: T, tableReads: number;
  try {
    result = run();
  } finally {
    tableReads = stopCdxmlFontTableTrackingForTesting();
  }
  return { result, operations: cdxmlFontOperationsForTesting(), tableReads };
};
const countedOpen = (source: string, tableReadLimit?: number) => {
  const { result: opened, operations, tableReads } = counted(() => openChemDraftPayload(source), tableReadLimit);
  return { opened, operations, tableReads };
};
const textsOf = (opened: ReturnType<typeof openChemDraftPayload>) =>
  opened.document!.pages[0].objects.filter((object): object is TextObject => object.type === "text");

const N = 2_000;

it("resolves N caption runs against N fonts with linear work", () => {
  const { opened, operations, tableReads } = countedOpen(`<CDXML>${fontTable(N)}<page>${caption(9, N, N)}</page></CDXML>`,
    2 * (N + N));
  expect(operations).toBeLessThanOrEqual(2 * (N + N));
  // Indexing reads each font once; the reads prove the table is tracked at all.
  expect(tableReads).toBeGreaterThanOrEqual(N);
  expect(tableReads).toBeLessThanOrEqual(2 * (N + N));
  const [text] = textsOf(opened);
  expect(text?.spans).toHaveLength(N);
  // A run states its font only where it differs from the caption's own (here, none do).
  expect(text?.spans[N - 1]?.style.fontFamily ?? text?.style.fontFamily).toBe(`Font${N}`);
  expect(text?.style.fontFamily).toBe(`Font${N}`);
  expect(opened.warnings.map((warning) => warning.code)).not.toContain("cdxml.font_table_truncated");
  // Saving it again builds the CDXML font table once and indexes it by name (Codex security finding).
  const saved = counted(() => exportDocumentToCdxml(opened.document!, plain), 4 * (N + N));
  expect(saved.operations).toBeLessThanOrEqual(4 * (N + N));
  expect(saved.tableReads).toBeGreaterThanOrEqual(N);
  expect(saved.tableReads).toBeLessThanOrEqual(4 * (N + N));
  expect(saved.result.contents.match(/<font /g)).toHaveLength(N);
});

// Codex: Save As wrote an edited caption by scanning the font table for every run (the
// 40,000-font, 40,000-run file took ~68 s); fonts are looked up by name, so saving is linear too.
it("saves an edited N-run caption against N fonts with linear work", () => {
  // Opened while counting, so the caption's copy of the font table is tracked on save as well.
  const { opened } = countedOpen(`<CDXML>${fontTable(N)}<page>${caption(9, N, N)}</page></CDXML>`,
    2 * (N + N));
  const [text] = textsOf(opened);
  text.spans[0].text = "y";
  text.text = `y${text.text.slice(1)}`;
  const saved = counted(() => exportDocumentToCdxml(opened.document!, plain), 4 * (N + N));
  expect(saved.operations).toBeLessThanOrEqual(4 * (N + N));
  expect(saved.tableReads).toBeGreaterThanOrEqual(N);
  expect(saved.tableReads).toBeLessThanOrEqual(4 * (N + N));
  expect(saved.result.warnings).toEqual([]);
  expect(saved.result.contents.match(new RegExp(`<s font="${N}" size="10" face="0">`, "g"))).toHaveLength(N);
  expect(saved.result.contents).toContain(`<s font="${N}" size="10" face="0">y</s>`);
  const [again] = textsOf(openChemDraftPayload(saved.result.contents));
  expect(again?.text).toBe(text.text);
  expect(again?.spans[0]?.style.fontFamily ?? again?.style.fontFamily).toBe(`Font${N}`);
});

it("resolves a duplicated font id to its first entry, as before", () => {
  const source = '<CDXML><fonttable><font id="3" charset="iso-8859-1" name="Arial"/><font id="3" charset="iso-8859-1" name="Times"/></fonttable>' +
    `<page>${caption(9, 1, 3)}</page></CDXML>`;
  expect(textsOf(openChemDraftPayload(source))[0]?.style.fontFamily).toBe("Arial");
});

// At the production cap (65,535 fonts) this took a 70,000-font fixture; the cap is lowered to 100.
it("keeps the first fonts of an oversized font table up to the cap, warns, and does linear work", () => {
  const source = `<CDXML>${fontTable(110)}<page>${caption(9, 1, 3)}${caption(10, 1, 110, 120)}</page></CDXML>`;
  const { opened, operations } = withCdxmlLimitsForTesting({ fontTable: 100 }, () => countedOpen(source));
  expect(operations).toBeLessThanOrEqual(2 * (110 + 2));
  const truncated = opened.warnings.filter((warning) => warning.code === "cdxml.font_table_truncated");
  expect(truncated.map((warning) => warning.message)).toEqual([
    "CDXML import: the font table lists 110 fonts, more than the 100 supported; only the first 100 were imported, and text set in a later font keeps the default font."
  ]);
  const [kept, dropped] = textsOf(opened);
  expect(kept?.style.fontFamily).toBe("Font3");
  expect(dropped?.text).toBe("x");
  expect(dropped?.style.fontFamily).toBeUndefined();
});

// The production cap is 65,535 runs per caption; lowered to 100 so the fixture stays small.
it("imports a caption with more runs than the cap as plain text with a warning, resolving none of its fonts", () => {
  const { opened, operations } = withCdxmlLimitsForTesting({ captionRuns: 100 },
    () => countedOpen(`<CDXML>${fontTable(3)}<page>${caption(9, 110, 3)}</page></CDXML>`));
  expect(operations).toBeLessThanOrEqual(3);
  const [text] = textsOf(opened);
  expect(text?.text).toBe("x".repeat(110));
  expect(text?.style.fontFamily).toBeUndefined();
  expect(text?.compatibility?.unknown.sourceCdxmlAttributes).toBeUndefined();
  expect(opened.warnings.filter((warning) => warning.code === "cdxml.text_runs_truncated").map((warning) => warning.message)).toEqual([
    "CDXML import: text 9 has 110 styled runs, more than the 100 supported; its caption frame and run fonts were not restored, and it was imported as plain styled text."
  ]);
});

// Codex security finding: every caption shared the whole font table, and saving wrote a copy per
// caption, so a crafted file of many captions over many fonts saved a payload quadratic in its size.
it("shares the whole font table only within a budget, so many captions over many fonts save linearly", () => {
  // 200 captions over 200 fonts: the 16,384-entry budget holds 81 whole copies, so the rest store their own font.
  const count = 200;
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
// (262,144 runs, `cdxmlLimits.documentCaptionRuns`) bounds the total, and keeps every caption's text.
// These tests lower it to 40 runs (six captions of 10 runs: four fit, as 4 x 55,000 did under the
// production cap) rather than build 330,000 runs.
const runCap = { documentCaptionRuns: 40 };
const RUNS = 10;
it("restores captions up to the document-wide run cap and imports the rest as plain styled text, with one warning", () => {
  const source = `<CDXML>${fontTable(3)}<page>${Array.from({ length: 6 }, (_, i) => caption(i + 10, RUNS, 2, 72 + 20 * i)).join("")}</page></CDXML>`;
  const { opened, operations } = withCdxmlLimitsForTesting(runCap, () => countedOpen(source));
  expect(operations).toBeLessThanOrEqual(2 * (3 + 6 * RUNS));
  const texts = textsOf(opened);
  expect(texts.map(text => text.text.length)).toEqual(Array(6).fill(RUNS));
  expect(texts.map(text => text.style.fontFamily)).toEqual(["Font2", "Font2", "Font2", "Font2", undefined, undefined]);
  expect(texts.map(text => text.compatibility?.unknown.sourceCdxmlAttributes !== undefined)).toEqual([true, true, true, true, false, false]);
  expect(opened.warnings.filter(warning => warning.code === "cdxml.document_caption_runs_limited").map(warning => warning.message)).toEqual([
    "CDXML import: the captions in this document have more than 40 styled runs in total; from text 14 on, captions past that total were imported as plain styled text, without their caption frame and run fonts."
  ]);
});

it("writes restored captions past the document-wide run cap as plain styled text, with one warning", () => {
  const document = createEmptyDocument();
  document.pages[0].objects = Array.from({ length: 6 }, (_, i): TextObject => ({
    type: "text", id: `caption${i}`, x: 36, y: 80 + 30 * i, width: 40, height: 22, rotation: 0, text: "x".repeat(RUNS),
    style: { fontFamily: `Face${i}`, fontSizePx: 16 },
    spans: Array.from({ length: RUNS }, () => ({ text: "x", script: "normal" as const, style: {} })),
    compatibility: { warnings: [], unknown: { sourceCdxmlAttributes: { p: `30 ${72 + 30 * i}`, Justification: "Left" } } }
  }));
  const saved = withCdxmlLimitsForTesting(runCap, () => counted(() => exportDocumentToCdxml(document, plain)));
  expect(saved.operations).toBeLessThanOrEqual(4 * 6 * RUNS);
  // Only the captions within the cap register (and are written with) their fonts.
  expect([...saved.result.contents.matchAll(/<font [^>]*name="([^"]+)"/g)].map(match => match[1])).toEqual(["Face0", "Face1", "Face2", "Face3"]);
  expect(saved.result.contents.match(/<t /g)).toHaveLength(6);
  expect(saved.result.contents.match(/>x</g)?.length ?? 0).toBeGreaterThanOrEqual(4 * RUNS);
  expect(saved.result.warnings.filter(warning => warning.code === "cdxml.document_caption_runs_limited").map(warning => warning.message)).toEqual([
    "CDXML export: the captions in this document have more than 40 styled runs in total; from text caption4 on, captions past that total were written as plain styled text, without their caption frame and run fonts."
  ]);
  const again = openChemDraftPayload(saved.result.contents);
  expect(textsOf(again).map(text => text.text)).toEqual(document.pages[0].objects.map(object => (object as TextObject).text));
});

// Codex (1.2.3): a caption capped on import kept its source XML, so saving the unchanged file
// copied that caption's frame and run fonts back out and bypassed the cap on Save As.
it("saves an opened file past the document-wide run cap with its capped captions as plain styled text, with one warning", () => {
  const source = `<CDXML>${fontTable(3)}<page>${Array.from({ length: 6 }, (_, i) => caption(i + 10, RUNS, 2, 72 + 20 * i)).join("")}</page></CDXML>`;
  withCdxmlLimitsForTesting(runCap, () => {
    const opened = openChemDraftPayload(source);
    const texts = textsOf(opened);
    const saved = counted(() => exportDocumentToCdxml(opened.document!, plain));
    expect(saved.operations).toBeLessThanOrEqual(4 * (3 + 6 * RUNS));
    expect(saved.result.warnings.map(warning => [warning.code, warning.message])).toEqual([["cdxml.document_caption_runs_limited",
      `CDXML export: the captions in this document have more than 40 styled runs in total; from text ${texts[4].id} on, captions past that total were written as plain styled text, without their caption frame and run fonts.`]]);
    const written = saved.result.contents.match(/<t [^>]*>/g) ?? [];
    expect(written).toHaveLength(6);
    // The first four keep their source frames; the capped two are written without a frame or run fonts.
    expect(written.map(tag => tag.includes("BoundingBox="))).toEqual([true, true, true, true, false, false]);
    const runs = saved.result.contents.split("<t ").slice(1).map(t => t.match(/<s font=/g)?.length ?? 0);
    expect(runs).toEqual([RUNS, RUNS, RUNS, RUNS, 0, 0]);
    const again = openChemDraftPayload(saved.result.contents);
    expect(textsOf(again).map(text => text.text)).toEqual(texts.map(text => text.text));
    expect(textsOf(again).map(text => text.style.fontFamily)).toEqual(["Font2", "Font2", "Font2", "Font2", undefined, undefined]);
  });
});

// Codex security finding (#442): import capped the number of fonts and caption runs but not a font
// name's length, and every caption stored its font's name again (its style, its source state and
// its copy of the font table), so a small crafted file of many captions over one long name saved
// tens of megabytes of native JSON right after opening (autosave). A font name over 256 characters
// (or an entry over 512) is not used, with one warning naming the font id; shared whole-table
// copies are budgeted in characters as well as entries. Sizes are measured, not timed.
const manyCaptions = (count: number, name: string) =>
  `<CDXML><fonttable><font id="7" charset="iso-8859-1" name="${name}"/></fonttable><page>` +
  `${Array.from({ length: count }, (_, i) => caption(i + 10, 1, 7, 72 + i)).join("")}</page></CDXML>`;
const nativeJsonChars = (source: string) => {
  const opened = openChemDraftPayload(source);
  return { opened, chars: JSON.stringify(opened.document).length };
};

it("does not use a font whose name is too long, with one warning naming its id, and saves linearly", () => {
  const name = "N".repeat(10_000);
  const small = nativeJsonChars(manyCaptions(250, name));
  const large = nativeJsonChars(manyCaptions(1_000, name));
  for (const { opened } of [small, large]) {
    const warnings = opened.warnings.filter(w => w.code === "cdxml.font_entry_too_long");
    expect(warnings.map(w => w.message)).toEqual([
      "CDXML import: font 7 has a name longer than 256 characters, or more than 512 characters of font attributes, far beyond any real font; it was not used, and text set in it keeps the default font."
    ]);
    expect(warnings[0].message).not.toContain(name);
    const texts = textsOf(opened);
    // The caption falls back to plain styled text in the default font; its text is kept.
    expect(texts.every(text => text.text === "x" && text.style.fontFamily === undefined)).toBe(true);
    expect(JSON.stringify(opened.document)).not.toContain("N".repeat(257));
  }
  // Before the cap the name was stored about three times per caption (~30 MB for 1,000 captions).
  expect(large.chars).toBeLessThan(1_000 * 2_000);
  // Linear: four times the captions cost about four times the bytes, never sixteen.
  expect(large.chars / small.chars).toBeLessThan(4.5);
});

// Kimi (#442): import left out the over-long font and declined the caption frame, but kept the
// text's source XML and native-state snapshot, so saving the unchanged file copied runs naming the
// left-out font id: the saved file named a font its table did not list, with no warning. Such a
// text is now written as plain styled text, and the save says why.
const fontIdsOf = (contents: string) => ({
  listed: new Set([...contents.matchAll(/<font id="(\d+)"/g)].map(match => match[1])),
  named: [...contents.matchAll(/<s [^>]*font="(\d+)"/g)].map(match => match[1])
});

it("saves an unchanged caption whose font was left out as plain styled text, naming no missing font, with a warning", () => {
  const source = `<CDXML><fonttable><font id="3" charset="iso-8859-1" name="Arial"/><font id="7" charset="iso-8859-1" name="${"N".repeat(10_000)}"/></fonttable>` +
    `<page>${caption(9, 2, 7)}${caption(10, 1, 3, 120)}</page></CDXML>`;
  const opened = openChemDraftPayload(source);
  const [omitted, kept] = textsOf(opened);
  expect(omitted.compatibility?.unknown.cdxmlTextFontOmitted).toBe(true);
  expect(kept.compatibility?.unknown.cdxmlTextFontOmitted).toBeUndefined();
  const saved = exportDocumentToCdxml(opened.document!, plain);
  const { listed, named } = fontIdsOf(saved.contents);
  expect(named.every(id => listed.has(id))).toBe(true);
  expect(named).toEqual(["3"]);
  expect(saved.warnings.filter(w => w.code === "cdxml.font_entry_too_long").map(w => w.message)).toEqual([
    `CDXML export: the source font of text ${omitted.id} has a name longer than 256 characters, or more than 512 characters of font attributes, far beyond any real font; ` +
    "it was not written, and text set in it was written without its caption frame and run fonts, or in the default font."
  ]);
  // The text itself is kept, and the other caption keeps its unchanged source form.
  expect(saved.warnings.map(w => w.code)).not.toContain("cdxml.text_source_formatting_not_kept");
  const again = textsOf(openChemDraftPayload(saved.contents));
  expect(again.map(text => text.text)).toEqual(["xx", "x"]);
  expect(again[1].style.fontFamily).toBe("Arial");
  // Saved again, nothing refers to the left-out font, so there is nothing left to warn about.
  expect(again[0].compatibility?.unknown.cdxmlTextFontOmitted).toBeUndefined();
});

it("does not copy an unchanged source text naming a stored font that is too long to write", () => {
  const opened = openChemDraftPayload(`<CDXML><fonttable><font id="3" charset="iso-8859-1" name="Arial"/><font id="7" charset="iso-8859-1" name="Times"/></fonttable>` +
    `<page>${caption(9, 1, 7)}${caption(10, 1, 3, 120)}</page></CDXML>`);
  // A crafted native document: the stored entry for font 7 is over the caps (opening native JSON drops it; a document built in memory still has it).
  for (const text of textsOf(opened)) {
    text.compatibility!.unknown.cdxmlTextFontTable = (text.compatibility!.unknown.cdxmlTextFontTable as { id: string }[])
      .map(font => font.id === "7" ? { ...font, name: "N".repeat(1_000) } : font);
  }
  const saved = exportDocumentToCdxml(opened.document!, plain);
  const { listed, named } = fontIdsOf(saved.contents);
  expect(named.every(id => listed.has(id))).toBe(true);
  expect(saved.warnings.filter(w => w.code === "cdxml.font_entry_too_long")).toHaveLength(1);
  expect(textsOf(openChemDraftPayload(saved.contents)).map(text => text.text)).toEqual(["x", "x"]);
});

it("keeps a 256-character font name and saves many captions in it linearly", () => {
  const name = "N".repeat(256);
  const sizes = [250, 500, 1_000].map(count => {
    const source = manyCaptions(count, name);
    const { opened, chars } = nativeJsonChars(source);
    expect(opened.warnings.map(w => w.code)).not.toContain("cdxml.font_entry_too_long");
    const texts = textsOf(opened);
    expect(texts).toHaveLength(count);
    expect(texts.every(text => text.style.fontFamily === name)).toBe(true);
    // Each caption stores its name a bounded number of times: under 25 characters per source character.
    expect(chars).toBeLessThan(25 * source.length);
    return chars;
  });
  // Equal steps in captions add (about) equal bytes once shared copies are spent: linear growth.
  const [a, b, c] = sizes;
  expect((c - b) / (b - a)).toBeGreaterThan(1.9);
  expect((c - b) / (b - a)).toBeLessThan(2.1);
  // And the saved font table still names the font once, under its id.
  const opened = openChemDraftPayload(manyCaptions(250, name));
  const saved = exportDocumentToCdxml(opened.document!, plain);
  expect([...saved.contents.matchAll(/<font [^>]*\/>/g)].map(match => match[0])).toEqual([
    `<font id="7" charset="iso-8859-1" name="${name}"/>`
  ]);
});

// CodeRabbit (#442): export gave new fonts ids past CDX's 16-bit limit (65535, 65536, ...), with no
// warning; on reopen the table was cut to 65,535 entries and a caption in the last font lost its
// font and frame. Ids stop below 65535; a font that does not fit is not registered, with one warning,
// and its caption is written as plain styled text.
// The id limit is lowered from 65,535 to 10 (ids below 10; the table holds at most 10 entries), so
// 8 retained fonts stand in for 65,533: the first new font takes the last id (9), the rest do not fit.
it("never gives a font an id past the CDX limit, and writes captions whose font does not fit as plain text", () => {
  withCdxmlLimitsForTesting({ fontId: 10, fontTable: 10 }, () => {
    const document = createEmptyDocument();
    const retained = Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), charset: "iso-8859-1", name: `Font${i + 1}` }));
    const holder: TextObject = { type: "text", id: "holder", x: 10, y: 10, width: 40, height: 22, rotation: 0, text: "h", spans: [],
      style: {}, compatibility: { warnings: [], unknown: { cdxmlTextFontTable: retained } } };
    const captions = ["NewA", "NewB", "NewC"].map((font, i): TextObject => ({
      type: "text", id: `caption${i}`, x: 36, y: 80 + 30 * i, width: 40, height: 22, rotation: 0, text: font,
      style: { fontFamily: font, fontSizePx: 16 }, spans: [{ text: font, script: "normal", style: {} }],
      compatibility: { warnings: [], unknown: { sourceCdxmlAttributes: { p: `30 ${72 + 30 * i}`, Justification: "Left" } } }
    }));
    document.pages[0].objects = [holder, ...captions];
    const saved = exportDocumentToCdxml(document, plain);
    const ids = [...saved.contents.matchAll(/<font id="(\d+)"[^>]*name="([^"]+)"/g)].map(match => [Number(match[1]), match[2]] as const);
    expect(ids).toHaveLength(9);
    expect(Math.max(...ids.map(([id]) => id))).toBe(9);
    expect(ids.at(-1)).toEqual([9, "NewA"]);
    expect(saved.warnings.filter(w => w.code === "cdxml.font_table_full").map(w => w.message)).toEqual([
      "CDXML export: the font table is full (font ids below 10); from text caption1 on, fonts not already in it were not written, and text set in them was written without its caption frame and run fonts, or in the default font."
    ]);
    // The captions that did not fit are written as plain styled text through the existing fallback, which warns too.
    expect(saved.warnings.filter(w => w.code === "cdxml.text_format_native_only").map(w => w.sourceObjectId)).toEqual(["caption1", "caption2"]);
    expect(saved.contents).toContain('<s font="9" ');
    const again = openChemDraftPayload(saved.contents);
    expect(again.warnings.map(w => w.code)).not.toContain("cdxml.font_table_truncated");
    const texts = textsOf(again);
    expect(texts.map(text => text.text)).toEqual(["h", "NewA", "NewB", "NewC"]);
    expect(texts.map(text => text.style.fontFamily)).toEqual([undefined, "NewA", undefined, undefined]);
  });
});

// CodeRabbit (#442): when the exact writer declines a stored arc (here, its only head was removed),
// the fallback clamped every radius to at least 1, so a valid 0.5 radius was saved doubled.
it("keeps a stored arc's sub-1 radius when it saves without its head", () => {
  const source = '<CDXML><page><arrow id="8" AngularSize="-90" Center3D="60 60 0" MajorAxisEnd3D="90 60 0" MinorAxisEnd3D="60 60.375 0" ' +
    'Tail3D="90 60 0" Head3D="60 59.625 0" BoundingBox="30 59.625 90 60.375" HeadSize="900" ArrowheadHead="Full" ArrowheadType="Solid"/></page></CDXML>';
  const document = openChemDraftPayload(source).document!;
  const g = document.pages[0].objects[0] as GraphicObject;
  expect(g.data.arcRadiusX).toBeCloseTo(40, 9);
  expect(g.data.arcRadiusY).toBeCloseTo(0.5, 9);
  g.data.markerEnd = undefined; g.data.markerStart = undefined;
  const output = exportDocumentToCdxml(document, plain);
  expect(output.contents).toContain('MinorAxisEnd3D="60 60.375 0"');
  const again = openChemDraftPayload(output.contents).document!.pages[0].objects[0] as GraphicObject;
  expect(again.data.artPathKind).toBe("arc");
  expect(again.data.arcRadiusX).toBeCloseTo(40, 6);
  expect(again.data.arcRadiusY).toBeCloseTo(0.5, 6);
  expect(again.data.arcSweepRadians).toBeCloseTo(-Math.PI / 2, 6);
});
