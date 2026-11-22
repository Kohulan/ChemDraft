import { expect, it } from "vitest";
import { createEmptyDocument, type GraphicObject, type TextObject } from "@chemdraft/chem-core";
import { exportDocumentToCdxml, openChemDraftPayload } from "./index";

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

// Codex 4658948336: resolving each caption run's font by a linear search of the font table made
// a crafted file O(fonts × runs). Fonts are looked up by id from a map built once per document,
// and the font table and a caption's runs are capped at CDX's 16-bit limit (65,535).
// Before the map, 40,000 runs against 40,000 fonts took about 9 s; with it the whole import takes
// about 0.7 s on a laptop, all of it the linear cost of parsing 80,000 elements (40,000 fonts
// alone take ~0.26 s, 40,000 runs alone ~0.48 s). The bound leaves room for a loaded test runner
// while still failing on any return of the quadratic search.
const NO_HANG_MS = 2000;
const fontTable = (count: number, name = (id: number) => `Font${id}`) =>
  `<fonttable>${Array.from({ length: count }, (_, i) => `<font id="${i + 1}" charset="iso-8859-1" name="${name(i + 1)}"/>`).join("")}</fonttable>`;
const caption = (id: number, runs: number, font: number, y = 72) =>
  `<t id="${id}" p="30 ${y}" BoundingBox="30 ${y - 12} 54 ${y}" Justification="Left">` +
  `${Array.from({ length: runs }, () => `<s font="${font}" size="10" face="0">x</s>`).join("")}</t>`;
const timedOpen = (source: string) => {
  const started = performance.now();
  const opened = openChemDraftPayload(source);
  return { opened, ms: performance.now() - started };
};
const textsOf = (opened: ReturnType<typeof openChemDraftPayload>) =>
  opened.document!.pages[0].objects.filter((object): object is TextObject => object.type === "text");

it("resolves 40,000 caption runs against 40,000 fonts in linear time", () => {
  const { opened, ms } = timedOpen(`<CDXML>${fontTable(40_000)}<page>${caption(9, 40_000, 40_000)}</page></CDXML>`);
  expect(ms).toBeLessThan(NO_HANG_MS);
  const [text] = textsOf(opened);
  expect(text?.spans).toHaveLength(40_000);
  expect(text?.spans[39_999]?.style.fontFamily).toBe("Font40000");
  expect(text?.style.fontFamily).toBe("Font40000");
  expect(opened.warnings.map((warning) => warning.code)).not.toContain("cdxml.font_table_truncated");
});

it("resolves a duplicated font id to its first entry, as before", () => {
  const source = '<CDXML><fonttable><font id="3" charset="iso-8859-1" name="Arial"/><font id="3" charset="iso-8859-1" name="Times"/></fonttable>' +
    `<page>${caption(9, 1, 3)}</page></CDXML>`;
  expect(textsOf(openChemDraftPayload(source))[0]?.style.fontFamily).toBe("Arial");
});

it("keeps the first 65,535 fonts of an oversized font table, warns, and does not hang", () => {
  const source = `<CDXML>${fontTable(70_000)}<page>${caption(9, 1, 3)}${caption(10, 1, 70_000, 120)}</page></CDXML>`;
  const { opened, ms } = timedOpen(source);
  expect(ms).toBeLessThan(NO_HANG_MS);
  const truncated = opened.warnings.filter((warning) => warning.code === "cdxml.font_table_truncated");
  expect(truncated.map((warning) => warning.message)).toEqual([
    "CDXML import: the font table lists 70000 fonts, more than the 65535 supported; only the first 65535 were imported, and text set in a later font keeps the default font."
  ]);
  const [kept, dropped] = textsOf(opened);
  expect(kept?.style.fontFamily).toBe("Font3");
  expect(dropped?.text).toBe("x");
  expect(dropped?.style.fontFamily).toBeUndefined();
});

it("imports a caption with more than 65,535 runs as plain text with a warning, without hanging", () => {
  const { opened, ms } = timedOpen(`<CDXML>${fontTable(3)}<page>${caption(9, 70_000, 3)}</page></CDXML>`);
  expect(ms).toBeLessThan(NO_HANG_MS);
  const [text] = textsOf(opened);
  expect(text?.text).toBe("x".repeat(70_000));
  expect(text?.style.fontFamily).toBeUndefined();
  expect(text?.compatibility?.unknown.sourceCdxmlAttributes).toBeUndefined();
  expect(opened.warnings.filter((warning) => warning.code === "cdxml.text_runs_truncated").map((warning) => warning.message)).toEqual([
    "CDXML import: text 9 has 70000 styled runs, more than the 65535 supported; its caption frame and run fonts were not restored, and it was imported as plain styled text."
  ]);
});
