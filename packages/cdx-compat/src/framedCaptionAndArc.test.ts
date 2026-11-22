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
