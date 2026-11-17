import { describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { createEmptyDocument, type ArrowObject, type ChemDraftDocument, type GraphicObject, type Point } from "@chemdraft/chem-core";
import { graphicPathEditPoints } from "@chemdraft/art-engine";
import { createNativeReactionArrow } from "../../document-workflow-core/src/reactionArrows";
import { CDX_NATIVE_ENVELOPE_ATTRIBUTE, cdxElementFromOrderedTree, readCdx, writeCdx, type CdxElement } from "./cdxBinary";
import { exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload } from "./index";

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false });
const tree = (xml: string) => cdxElementFromOrderedTree(parser.parse(xml));
const all = (node: CdxElement, name: string): CdxElement[] => [
  ...(node.name === name ? [node] : []), ...node.kids.flatMap(child => all(child, name))
];

// Independently scan record boundaries and numeric tags, without the codec's object/property tables.
function binaryObjects(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 22;
  const objects: { tag: number; props: Map<number, Uint8Array> }[] = [];
  const u16 = () => { const value = view.getUint16(offset, true); offset += 2; return value; };
  const visit = (tag: number) => {
    offset += 4; // object id
    const object = { tag, props: new Map<number, Uint8Array>() };
    objects.push(object);
    for (let next = u16(); next !== 0; next = u16()) {
      if (next & 0x8000) visit(next);
      else {
        let length = u16();
        if (length === 0xffff) { length = view.getUint32(offset, true); offset += 4; }
        object.props.set(next, bytes.slice(offset, offset + length));
        offset += length;
      }
    }
  };
  visit(u16());
  return objects;
}

const kinds = [
  ["forward", "reactionArrow", "Full", undefined, "Solid", undefined],
  ["resonance", "resonanceArrow", "Full", "Full", "Solid", undefined],
  ["equilibrium", "equilibriumArrow", "HalfLeft", "HalfLeft", "Solid", "300"],
  ["retrosynthesis", "retroArrow", "Full", undefined, "Angle", "600"]
] as const;

function artArrow(start: Point, end: Point, kind: ArrowObject["arrowKind"] | "fishhook"): GraphicObject {
  const equilibrium = kind === "equilibrium";
  const retro = kind === "retrosynthesis";
  const marker = { kind: equilibrium || kind === "fishhook" ? "half-arrow" as const : "filled-arrow" as const, sizePx: equilibrium || kind === "fishhook" ? 14 : 16 };
  return {
    id: "native_art_arrow", type: "graphic", graphicKind: "path", rotation: 0,
    x: Math.min(start.x, end.x), y: Math.min(start.y, end.y) - 12,
    width: Math.max(Math.abs(start.x - end.x), 24), height: Math.max(Math.abs(start.y - end.y), 24),
    style: { strokeColor: "#336699", strokeWidth: 2, strokeDasharray: "6 6" },
    data: {
      artPathKind: "line", lineStart: start, lineEnd: end,
      artToolId: kind === "fishhook" ? "fishhookArrow" : kinds.find(row => row[0] === kind)![1],
      ...(retro ? {} : { markerEnd: marker }),
      ...(kind === "resonance" || equilibrium ? { markerStart: marker } : {}),
      ...(equilibrium ? { dualShaft: true, dualShaftGapPx: 7 } : {}),
      ...(retro ? { dualShaft: true, dualShaftParallel: true, dualShaftGapPx: 5 } : {})
    }
  };
}

function visibleExport(document: ChemDraftDocument, binary: boolean) {
  if (binary) {
    const exported = exportDocumentToCdx(document, { embedNativePayload: true });
    const root = readCdx(exported.bytes);
    expect(root.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE]).toBeDefined();
    delete root.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE];
    const opened = importCdx(writeCdx(root));
    expect(opened.source).not.toBe("native-payload");
    return { root, opened, bytes: exported.bytes };
  }
  const exported = exportDocumentToCdxml(document);
  expect(exported.contents).toContain("<objecttag ");
  const xml = exported.contents.replace(/<objecttag\b[^>]*\/>/g, "");
  const opened = openChemDraftPayload(xml);
  expect(opened.source).not.toBe("native-payload");
  return { root: tree(xml), opened, bytes: undefined };
}

function assertEndpoints(arrow: GraphicObject, start: Point, end: Point) {
  const endpoints = graphicPathEditPoints(arrow)!;
  expect(endpoints).toBeDefined();
  for (const [key, expected] of [["start", start], ["end", end]] as const) {
    expect(endpoints[key].x).toBeCloseTo(expected.x, 3);
    expect(endpoints[key].y).toBeCloseTo(expected.y, 3);
  }
}

describe.each([false, true])("directed Arrow objects (binary=%s)", binary => {
  for (const [direction, start, end] of [
    ["leftward", { x: 400, y: 200 }, { x: 200, y: 200 }],
    ["upward", { x: 300, y: 400 }, { x: 300, y: 200 }]
  ] as const) {
    it.each(kinds)(`${direction} %s preserves kind, heads, style and endpoints without its envelope`, (kind, tool, head, tail, type, spacing) => {
      for (const nativeObject of [false, true]) {
        const document = createEmptyDocument();
        const arrow = nativeObject ? createNativeReactionArrow(document, start, end, kind) : artArrow(start, end, kind);
        arrow.style = { strokeColor: "#336699", strokeWidth: 2, strokeDasharray: "6 6" };
        document.pages[0].objects.push(arrow);
        const result = visibleExport(document, binary);
        const arrows = all(result.root, "arrow");
        expect(arrows).toHaveLength(1);
        expect(all(result.root, "graphic").filter(node => node.attrs.GraphicType === "Line" && node.attrs.ArrowType)).toEqual([]);
        expect(arrows[0].attrs).toMatchObject({
          Head3D: `${end.x * 0.75} ${end.y * 0.75} 0`, Tail3D: `${start.x * 0.75} ${start.y * 0.75} 0`,
          ArrowheadHead: head, ArrowheadType: type, FillType: "None", LineWidth: "1.5", LineType: "Dashed"
        });
        expect(arrows[0].attrs.ArrowheadTail).toBe(tail);
        expect(arrows[0].attrs.ArrowShaftSpacing).toBe(spacing);
        const reopened = result.opened.document!.pages[0].objects[0] as GraphicObject;
        expect(reopened.data.artToolId).toBe(tool);
        expect(reopened.data.markerStart?.kind).toBe(!tail ? undefined : kind === "equilibrium" ? "half-arrow" : "filled-arrow");
        expect(reopened.data.markerEnd?.kind).toBe(kind === "retrosynthesis" ? undefined : kind === "equilibrium" ? "half-arrow" : "filled-arrow");
        expect(reopened.data.dualShaft).toBe(kind === "equilibrium" || kind === "retrosynthesis" ? true : undefined);
        expect(reopened.data.dualShaftParallel).toBe(kind === "retrosynthesis" ? true : undefined);
        expect(reopened.style).toMatchObject({ strokeColor: "#336699", strokeWidth: 2, strokeDasharray: expect.any(String) });
        assertEndpoints(reopened, start, end);
        if (result.bytes) {
          const records = binaryObjects(result.bytes);
          const record = records.filter(object => object.tag === 0x8021);
          expect(record).toHaveLength(1);
          expect(records.filter(object => object.tag === 0x8007 && object.props.has(0x0a02))).toEqual([]);
          for (const [tag, point] of [[0x0207, end], [0x0208, start]] as const) {
            const data = record[0].props.get(tag)!;
            expect(data).toHaveLength(12);
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            expect([0, 4, 8].map(offset => view.getInt32(offset, true) / 65536)).toEqual([point.x * 0.75, point.y * 0.75, 0]);
          }
        }
      }
    });
  }

  it("preserves a native fishhook's half head and direction", () => {
    const start = { x: 400, y: 200 }, end = { x: 200, y: 200 };
    const document = createEmptyDocument();
    document.pages[0].objects.push(artArrow(start, end, "fishhook"));
    const result = visibleExport(document, binary);
    expect(all(result.root, "arrow")[0].attrs).toMatchObject({ ArrowheadHead: "HalfLeft", ArrowheadType: "Solid" });
    const arrow = result.opened.document!.pages[0].objects[0] as GraphicObject;
    expect(arrow.data).toMatchObject({ artToolId: "fishhookArrow", markerEnd: { kind: "half-arrow" } });
    expect(arrow.data.markerStart).toBeUndefined();
    expect(all(result.root, "arrow")[0].attrs.ArrowShaftSpacing).toBeUndefined();
    expect(arrow.data.dualShaft).toBeUndefined();
    assertEndpoints(arrow, start, end);
  });

  it.each(["head", "tail", "both"] as const)("preserves equilibrium's dual shafts with %s removed", removed => {
    const start = { x: 400, y: 200 }, end = { x: 200, y: 200 };
    const document = createEmptyDocument();
    const arrow = artArrow(start, end, "equilibrium");
    if (removed !== "tail") delete arrow.data.markerEnd;
    if (removed !== "head") delete arrow.data.markerStart;
    document.pages[0].objects.push(arrow);
    const result = visibleExport(document, binary);
    const attributes = all(result.root, "arrow")[0].attrs;
    expect(attributes.ArrowShaftSpacing).toBe("300");
    expect(attributes.ArrowheadHead).toBe(removed === "tail" ? "HalfLeft" : undefined);
    expect(attributes.ArrowheadTail).toBe(removed === "head" ? "HalfLeft" : undefined);
    const reopened = result.opened.document!.pages[0].objects[0] as GraphicObject;
    expect(reopened.data).toMatchObject({ artToolId: "equilibriumArrow", dualShaft: true });
    expect(reopened.data.dualShaftParallel).toBeUndefined();
    expect(reopened.data.markerStart?.kind).toBe(removed === "head" ? "half-arrow" : undefined);
    expect(reopened.data.markerEnd?.kind).toBe(removed === "tail" ? "half-arrow" : undefined);
    assertEndpoints(reopened, start, end);
  });

  it("writes the actual edited head side instead of the semantic tool's defaults", () => {
    const start = { x: 400, y: 200 }, end = { x: 200, y: 200 };
    const document = createEmptyDocument();
    const arrow = artArrow(start, end, "forward");
    delete arrow.data.markerEnd;
    arrow.data.markerStart = { kind: "filled-arrow", sizePx: 16 };
    document.pages[0].objects.push(arrow);
    const result = visibleExport(document, binary);
    const attributes = all(result.root, "arrow")[0].attrs;
    expect(attributes.ArrowheadHead).toBeUndefined();
    expect(attributes).toMatchObject({ ArrowheadTail: "Full", ArrowheadType: "Solid" });
    const reopened = result.opened.document!.pages[0].objects[0] as GraphicObject;
    expect(reopened.data.markerEnd).toBeUndefined();
    expect(reopened.data.markerStart).toMatchObject({ kind: "filled-arrow" });
    assertEndpoints(reopened, start, end);
  });

  it("preserves Hollow through plain records, and regenerates it after a native head edit", () => {
    const xml = '<CDXML><page id="1"><arrow id="2" Tail3D="300 150 0" Head3D="150 150 0" ArrowheadHead="Full" ArrowheadType="Hollow"/></page></CDXML>';
    const opened = binary ? importCdx(writeCdx(tree(xml))) : openChemDraftPayload(xml);
    expect(opened.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.arrow_hollow_head_approximation" }));
    const result = visibleExport(opened.document!, binary);
    expect(all(result.root, "arrow")[0].attrs).toMatchObject({ ArrowheadHead: "Full", ArrowheadType: "Hollow" });
    const arrow = result.opened.document!.pages[0].objects[0] as GraphicObject;
    expect(arrow.data).toMatchObject({ artToolId: "reactionArrow", markerEnd: { kind: "open-arrow" } });
    assertEndpoints(arrow, { x: 400, y: 200 }, { x: 200, y: 200 });
    arrow.data.markerEnd = { kind: "filled-arrow", sizePx: 16 };
    expect(all(visibleExport(result.opened.document!, binary).root, "arrow")[0].attrs.ArrowheadType).toBe("Solid");
  });

  it("imports a leftward legacy Hollow arrow and re-exports its hollow head on the left", () => {
    const xml = '<CDXML><page id="1"><graphic id="2" GraphicType="Line" ArrowType="Hollow" BoundingBox="150 150 300 150" Tail3D="300 150 0" Head3D="150 150 0"/></page></CDXML>';
    const opened = binary ? importCdx(writeCdx(tree(xml))) : openChemDraftPayload(xml);
    expect(opened.source).not.toBe("native-payload");
    expect(opened.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.arrow_hollow_head_approximation" }));
    const arrow = opened.document!.pages[0].objects[0] as GraphicObject;
    expect(arrow.data).toMatchObject({ artToolId: "reactionArrow", markerEnd: { kind: "open-arrow" } });
    expect(arrow.data.markerStart).toBeUndefined();
    assertEndpoints(arrow, { x: 400, y: 200 }, { x: 200, y: 200 });
    const result = visibleExport(opened.document!, binary);
    expect(all(result.root, "graphic")).toEqual([]);
    expect(all(result.root, "arrow")).toHaveLength(1);
    expect(all(result.root, "arrow")[0].attrs).toMatchObject({
      Tail3D: "300 150 0", Head3D: "150 150 0", ArrowheadHead: "Full", ArrowheadType: "Hollow"
    });
    const reopened = result.opened.document!.pages[0].objects[0] as GraphicObject;
    expect(reopened.data).toMatchObject({ artToolId: "reactionArrow", markerEnd: { kind: "open-arrow" } });
    assertEndpoints(reopened, { x: 400, y: 200 }, { x: 200, y: 200 });
  });

  it.each(["FullHead", "HalfHead", "Resonance", "Equilibrium", "RetroSynthetic"])("still imports legacy Graphic Line + ArrowType=%s", type => {
    const xml = `<CDXML><page id="1"><graphic id="2" GraphicType="Line" ArrowType="${type}" BoundingBox="150 150 300 150" Tail3D="300 150 0" Head3D="150 150 0"/></page></CDXML>`;
    const opened = binary ? importCdx(writeCdx(tree(xml))) : openChemDraftPayload(xml);
    const arrow = opened.document!.pages[0].objects[0] as GraphicObject;
    const legacyKinds: Record<string, string> = { FullHead: "forward", Resonance: "resonance", Equilibrium: "equilibrium", RetroSynthetic: "retrosynthesis" };
    const tool = type === "HalfHead" ? "fishhookArrow" : kinds.find(row => legacyKinds[type] === row[0])![1];
    expect(arrow.data.artToolId).toBe(tool);
    assertEndpoints(arrow, { x: 400, y: 200 }, { x: 200, y: 200 });
    const result = visibleExport(opened.document!, binary);
    expect(all(result.root, "arrow")).toHaveLength(1);
    expect((result.opened.document!.pages[0].objects[0] as GraphicObject).data.artToolId).toBe(tool);
  });
});

describe("legacy unknown arrow endpoints", () => {
  it.each([
    ["3D endpoints before 2D aliases", 'Tail3D="300 225 0" Head3D="150 150 0" Start="150 150" End="300 225"', { x: 400, y: 300 }, { x: 200, y: 200 }],
    ["2D aliases before bounding box", 'Start="300 225" End="150 150"', { x: 400, y: 300 }, { x: 200, y: 200 }],
    ["bounding box when endpoints are absent", "", { x: 200, y: 200 }, { x: 400, y: 300 }]
  ] as const)("prefers %s", (_name, attributes, start, end) => {
    const opened = openChemDraftPayload(`<CDXML><page id="1"><graphic id="2" GraphicType="Line" ArrowType="Unmapped" BoundingBox="150 150 300 225" ${attributes}/></page></CDXML>`);
    expect(opened.source).not.toBe("native-payload");
    const arrow = opened.document!.pages[0].objects[0] as ArrowObject;
    expect(arrow.type).toBe("reaction-arrow");
    expect(arrow.arrowKind).toBe("unknown");
    expect(arrow.start).toEqual({ kind: "point", point: start });
    expect(arrow.end).toEqual({ kind: "point", point: end });
  });
});
