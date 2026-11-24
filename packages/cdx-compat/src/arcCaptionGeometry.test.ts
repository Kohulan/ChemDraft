import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEmptyDocument, type GraphicObject, type TextObject } from "@chemdraft/chem-core";
import { cdxmlFixtures } from "@chemdraft/fixtures";
import { exportDocumentToCdxml, openChemDraftPayload } from "./index";

// 1.2.3 bugs (e) and (g): a native arc's stored ellipse in the CDXML Graphic Arc writer, and
// malformed caption geometry on import and export.

const plain = { embedNativePayload: false };
const px = (pt: number) => pt * 4 / 3;

type Ellipse = { center: { x: number; y: number }; rx: number; ry: number; start: number; sweep: number };

/** The ellipse a native arc is drawn on, with the renderer's fallbacks (art-engine circularGraphicArcGeometry). */
function drawnArc(g: GraphicObject): Ellipse {
  const d = g.data;
  return {
    center: d.arcCenter ?? { x: g.x + g.width / 2, y: g.y + g.height / 2 },
    rx: Math.max(d.arcRadiusX ?? g.width / 2 - 4, 1),
    ry: Math.max(d.arcRadiusY ?? g.height / 2 - 4, 1),
    start: d.arcStartRadians!,
    sweep: d.arcSweepRadians!
  };
}

function expectSameArc(actual: Ellipse, expected: Ellipse): void {
  expect(actual.center.x).toBeCloseTo(expected.center.x, 2);
  expect(actual.center.y).toBeCloseTo(expected.center.y, 2);
  expect(actual.rx).toBeCloseTo(expected.rx, 2);
  expect(actual.ry).toBeCloseTo(expected.ry, 2);
  expect(actual.start).toBeCloseTo(expected.start, 3);
  expect(actual.sweep).toBeCloseTo(expected.sweep, 3);
}

function nativeArc(frame: { x: number; y: number; width: number; height: number }, data: GraphicObject["data"]): GraphicObject {
  return { id: "arc", type: "graphic", graphicKind: "path", ...frame, rotation: 0,
    style: { strokeColor: "#000000", strokeWidth: 1.5 }, data: { artPathKind: "arc", ...data } } as GraphicObject;
}

function roundTrip(graphic: GraphicObject) {
  const document = createEmptyDocument();
  document.pages[0].objects = [graphic];
  const exported = exportDocumentToCdxml(document, plain);
  const reopened = openChemDraftPayload(exported.contents).document!.pages[0].objects[0] as GraphicObject;
  return { exported, reopened };
}

describe("native arcs in a CDXML Graphic Arc", () => {
  it("writes the stored center and radii, so Save As and reopen give the same arc", () => {
    const arc = nativeArc({ x: 10, y: 10, width: 200, height: 200 },
      { arcCenter: { x: 120, y: 90 }, arcRadiusX: 50, arcRadiusY: 30, arcStartRadians: 0.3, arcSweepRadians: 2 });
    const { exported, reopened } = roundTrip(arc);
    expect(exported.warnings).toEqual([]);
    expect(exported.contents).toContain('GraphicType="Arc" BoundingBox="49.5 42 130.5 93"');
    expect(reopened.data.artPathKind).toBe("arc");
    expectSameArc(drawnArc(reopened), drawnArc(arc));
  });

  it("keeps the shape of an arc edited with its handles", () => {
    // What the middle handle does (art-engine editSemanticArcGeometry): it stores the ellipse and a
    // new radius, and shrinks the frame to the drawn arc plus padding, off the ellipse's center.
    const original = nativeArc({ x: 30, y: 45, width: 90, height: 60 }, { arcStartRadians: 0.4, arcSweepRadians: Math.PI / 3 });
    const data = { ...original.data, arcCenter: { x: 75, y: 75 }, arcRadiusX: 35, arcRadiusY: 35 };
    const points = Array.from({ length: 33 }, (_, i) => {
      const angle = 0.4 + Math.PI / 3 * i / 32;
      return { x: 75 + 35 * Math.cos(angle), y: 75 + 35 * Math.sin(angle) };
    });
    const left = Math.min(...points.map(p => p.x)) - 6, top = Math.min(...points.map(p => p.y)) - 6;
    const edited = { ...original, x: left, y: top, data,
      width: Math.max(...points.map(p => p.x)) + 6 - left, height: Math.max(...points.map(p => p.y)) + 6 - top };
    // The frame alone describes a different ellipse; writing it would change the arc.
    expect(Math.abs(edited.x + edited.width / 2 - 75)).toBeGreaterThan(5);
    const { exported, reopened } = roundTrip(edited);
    expect(exported.warnings).toEqual([]);
    expectSameArc(drawnArc(reopened), drawnArc(edited));
  });

  it("warns that a rotated arc is written unrotated", () => {
    const arc = nativeArc({ x: 30, y: 45, width: 90, height: 60 }, { arcCenter: { x: 70, y: 70 }, arcRadiusX: 20, arcRadiusY: 20,
      arcStartRadians: 0, arcSweepRadians: 1 });
    arc.rotation = 30;
    expect(roundTrip(arc).exported.warnings.map(w => w.code)).toEqual(["cdxml.arc_rotation_payload_only"]);
  });

  it("writes an arc that was never edited exactly as before", () => {
    const arc = nativeArc({ x: 30, y: 45, width: 90, height: 60 }, { arcStartRadians: 0.4, arcSweepRadians: Math.PI / 3 });
    const { exported } = roundTrip(arc);
    expect(exported.warnings).toEqual([]);
    expect(exported.contents).toContain('<graphic id="1" GraphicType="Arc" BoundingBox="22.5 33.75 90 78.75" ' +
      'Start="84.5726 63.8437" End="60.041 75.6012" AngularSize="60"/>');
  });
});

const fonts = '<fonttable><font id="2" name="Helvetica"/></fonttable>';
const page = (body: string) => `<CDXML>${fonts}<page>${body}</page></CDXML>`;
const caption = (attributes: string) => `<t id="9" ${attributes} Justification="Left"><s font="2" size="10" face="1">Me</s></t>`;

function captionGeometry(contents: string): { p: number[]; box?: number[] } {
  const element = contents.match(/<t [^>]*>/)![0];
  const numbers = (name: string) => element.match(new RegExp(` ${name}="([^"]*)"`))?.[1].split(" ").map(Number);
  return { p: numbers("p")!, box: numbers("BoundingBox") };
}

function expectFiniteCaption(contents: string): void {
  expect(contents).not.toMatch(/NaN|Infinity/);
  const { p, box } = captionGeometry(contents);
  expect(p.every(Number.isFinite)).toBe(true);
  if (box) expect(box.every(Number.isFinite)).toBe(true);
}

describe("captions with malformed geometry", () => {
  it("ignores a NaN BoundingBox with a warning and exports finite numbers", () => {
    const opened = openChemDraftPayload(page(caption('p="40 50" BoundingBox="40 NaN 80 60"')));
    expect(opened.warnings.filter(w => w.code === "cdxml.text_position_invalid")).toHaveLength(1);
    expect(opened.warnings.find(w => w.code === "cdxml.text_position_invalid")!.message).toContain('BoundingBox="40 NaN 80 60"');
    const text = opened.document!.pages[0].objects[0] as TextObject;
    expect(text).toMatchObject({ x: px(40), y: px(50) });
    const unchanged = exportDocumentToCdxml(opened.document!, plain);
    expectFiniteCaption(unchanged.contents);
    expect(captionGeometry(unchanged.contents).p).toEqual([40, 50]);
    text.x += px(6);
    const moved = exportDocumentToCdxml(opened.document!, plain);
    expectFiniteCaption(moved.contents);
    expect(captionGeometry(moved.contents).p).toEqual([46, 50]);
    const reopened = openChemDraftPayload(moved.contents);
    expect(reopened.warnings.map(w => w.code)).not.toContain("cdxml.text_position_invalid");
  });

  it("derives a NaN p from the valid coordinate and the BoundingBox, and keeps p and BoundingBox together after a move", () => {
    const opened = openChemDraftPayload(page(caption('p="40 NaN" BoundingBox="40 38 80 52"')));
    expect(opened.warnings.filter(w => w.code === "cdxml.text_position_invalid")).toHaveLength(1);
    const text = opened.document!.pages[0].objects[0] as TextObject;
    expect(text.x).toBeCloseTo(px(40), 6);
    expect(text.y).toBeCloseTo(px(38), 6);
    const before = captionGeometry(exportDocumentToCdxml(opened.document!, plain).contents);
    expect(before.p[0]).toBe(40);
    expect(before.p[1]).toBeGreaterThan(38);
    expect(before.p[1]).toBeLessThanOrEqual(52);
    expect(before.box).toEqual([40, 38, 80, 52]);
    const offset = (g: { p: number[]; box?: number[] }) => [g.p[0] - g.box![0], g.p[1] - g.box![1]];
    text.x += px(6); text.y += px(3);
    const moved = exportDocumentToCdxml(opened.document!, plain).contents;
    expectFiniteCaption(moved);
    const after = captionGeometry(moved);
    expect(after.box).toEqual([46, 41, 86, 55]);
    expect(offset(after)).toEqual(offset(before));
    // An edited caption is written from its runs; p and BoundingBox still move together.
    text.text = "Et"; text.spans[0].text = "Et";
    const edited = captionGeometry(exportDocumentToCdxml(opened.document!, plain).contents);
    expect(edited.box!.slice(0, 2)).toEqual([46, 41]);
    expect(offset(edited)).toEqual(offset(before));
  });

  it("places a caption without p from its BoundingBox, not at the origin", () => {
    const opened = openChemDraftPayload(page(caption('BoundingBox="100 80 140 94"')));
    expect(opened.warnings.map(w => w.code)).not.toContain("cdxml.text_position_invalid");
    const text = opened.document!.pages[0].objects[0] as TextObject;
    expect(text.x).toBeCloseTo(px(100), 6);
    expect(text.y).toBeCloseTo(px(80), 6);
    const { p } = captionGeometry(exportDocumentToCdxml(opened.document!, plain).contents);
    expect(p[0]).toBe(100);
    expect(p[1]).toBeGreaterThan(80);
  });

  it("places a fragment's caption with neither p nor BoundingBox below the fragment, with a warning", () => {
    const opened = openChemDraftPayload(page('<fragment id="1" BoundingBox="100 100 140 120"><n id="2" p="100 110"/><n id="3" p="140 110"/>' +
      '<b id="4" B="2" E="3"/><t id="9" BoundingBox="x"><s font="2" size="10">cap</s></t></fragment>'));
    const warning = opened.warnings.find(w => w.code === "cdxml.text_position_invalid");
    expect(warning?.message).toContain("below the fragment");
    const text = opened.document!.pages[0].objects.find(o => o.type === "text") as TextObject;
    expect(text.x).toBeCloseTo(px(100), 6);
    expect(text.y).toBeGreaterThan(px(120));
    expectFiniteCaption(exportDocumentToCdxml(opened.document!, plain).contents);
  });

  it("warns when a caption has no position at all", () => {
    const opened = openChemDraftPayload(page(caption('p="NaN Infinity"')));
    expect(opened.warnings.find(w => w.code === "cdxml.text_position_invalid")?.message).toContain("page origin");
    expectFiniteCaption(exportDocumentToCdxml(opened.document!, plain).contents);
  });

  it("never copies a malformed p kept by an older import", () => {
    const opened = openChemDraftPayload(page(caption('p="40 50"')));
    const text = opened.document!.pages[0].objects[0] as TextObject;
    // Older imports kept the source element verbatim, NaN included.
    text.compatibility!.unknown.cdxmlTextElement = String(text.compatibility!.unknown.cdxmlTextElement).replace('p="40 50"', 'p="40 NaN"');
    const exported = exportDocumentToCdxml(opened.document!, plain);
    expectFiniteCaption(exported.contents);
    expect(captionGeometry(exported.contents).p).toEqual([40, 50]);
  });

  it("exports files without these problems byte-identically to before", () => {
    // Digests of the plain export at f589e206b, before this change.
    const pinned: Record<string, string> = {
      "text-plus-molecule.cdxml": "e00a852d3fd8b2035af8146d4ea1b805ce34ff2d63f6ee0249c37e337eaee13d",
      "bactvue-visible-subset.cdxml": "9c614b078e7872737e638052eb9f52fd78195555ff1ca4e13269c9090a8312ef"
    };
    for (const [name, digest] of Object.entries(pinned)) {
      const opened = openChemDraftPayload(cdxmlFixtures[name]);
      expect(opened.warnings.map(w => w.code)).not.toContain("cdxml.text_position_invalid");
      const contents = exportDocumentToCdxml(opened.document!, plain).contents;
      expect(createHash("sha256").update(contents).digest("hex"), name).toBe(digest);
    }
  });
});
