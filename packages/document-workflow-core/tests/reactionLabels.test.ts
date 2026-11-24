import { describe, expect, it } from "vitest";
import {
  createEmptyDocument, nativeTextStyleFromObjectStyle, type TextObject, type TextSpan
} from "@chemdraft/chem-core";
import {
  planPageSvgRender, planReactionArrowGeometry, reactionArrowHeadDepthPx, reactionArrowHeadLengthPx, reactionArrowVerticalExtent,
  scalePageGeometry,
  type PageSvgElementFragment, type PageSvgFragment
} from "@chemdraft/layout-engine";
import {
  estimateNativeTextLineWidth, estimateNativeTextSpanLineWidth,
  layoutReactionLabels, layoutReactionScheme, planReactionLabels, reactionLabelWrapWidthInBonds,
  type ReactionLabelsOptions
} from "../src/index";
import { wrapPiecesWorkForTesting } from "../src/testing";

const above = ["Ti(OiPr)4 (5 mol%)", "(+)-DET (6 mol%)", "t-BuOOH"];
const below = ["CH2Cl2, −20 °C, 4 h"];
const caption = "DET enantiomer chosen for the drawn product.";
const defaults: ReactionLabelsOptions = {
  above, below, caption, bondLength: 22, textStyle: { fontSizePx: 15 }, arrowKind: "forward"
};

it("subscripts every formula in solvent mixtures while keeping temperatures and durations plain", () => {
  const text = "toluene/H2O, CH2Cl2/Et2O,K2CO3, Pd(PPh3)4, H2SO4; 90 °C, 2 h, 15 min";
  const { above } = labels({ above: [text], below: [], textStyle: { fontSizePx: 8 }, bondLength: 100 });
  expect(above!.text).toBe(text);
  expect(scripts(above!).map(span => span.text)).toEqual(["2", "2", "2", "2", "2", "3", "3", "4", "2", "4"]);
  for (const match of text.matchAll(/90|2 h|15/g)) {
    expect(scripts(above!).some(span => span.offset <= match.index && span.offset + span.text.length > match.index)).toBe(false);
  }
});

function labels(options: Partial<ReactionLabelsOptions> = {}) {
  const plan = planReactionLabels({ ...defaults, ...options });
  return {
    plan,
    ...layoutReactionLabels(plan, {
      arrowMidpoint: { x: 200, y: 120 },
      schemeBounds: { minX: 20, minY: 90, maxX: 380, maxY: 150 }, idPrefix: "label"
    })
  };
}

function scripts(object: TextObject): Array<{ text: string; script: TextSpan["script"]; offset: number }> {
  let offset = 0;
  return object.spans.map((span) => {
    const result = { text: span.text, script: span.script, offset };
    offset += span.text.length;
    return result;
  }).filter((span) => span.script !== "normal");
}

function elements(fragment: PageSvgFragment): PageSvgElementFragment[] {
  return fragment.kind === "text" ? [] : [fragment, ...fragment.children.flatMap(elements)];
}

function content(fragment: PageSvgFragment): string {
  return fragment.kind === "text" ? fragment.text : fragment.children.map(content).join("");
}

function renderedLines(object: TextObject) {
  const rendered = planPageSvgRender({ ...createEmptyDocument().pages[0]!, objects: [object] })
    .fragments.flatMap(elements).find(fragment => fragment.key === `object-${object.id}`)!;
  let baseline = Number(rendered.attrs.y);
  const lines: Array<{ x: number; baseline: number; runs: PageSvgElementFragment[]; baselines: number[] }> = [];
  for (const run of rendered.children) {
    if (run.kind !== "element") continue;
    if (run.attrs.y !== undefined) baseline = Number(run.attrs.y);
    baseline += Number(run.attrs.dy ?? 0);
    if (run.attrs.x !== undefined) {
      lines.push({ x: Number(run.attrs.x), baseline, runs: [], baselines: [] });
    }
    lines.at(-1)!.runs.push(run);
    lines.at(-1)!.baselines.push(baseline);
  }
  return { rendered, lines };
}

function renderedInkEnvelope(line: ReturnType<typeof renderedLines>["lines"][number], fontSize: number) {
  const bounds = line.runs.map((run, index) => {
    const size = parseFloat(String(run.attrs["font-size"] ?? fontSize));
    // Read actual SVG coordinates and absolute sizes, with independent Arial ink estimates.
    const baseline = line.baselines[index]!;
    // Formula-generated subscript runs contain only digits, which end at their baseline.
    return { top: baseline - 0.716 * size,
      bottom: baseline + (size < fontSize && baseline > line.baseline ? 0 : 0.21 * size) };
  });
  return { top: Math.min(...bounds.map(bound => bound.top)), bottom: Math.max(...bounds.map(bound => bound.bottom)) };
}

describe("reaction label policy", () => {
  it("sizes chemistry symbols and unknown first families without flat over-reservation", () => {
    const chemistry = labels({ above: ["⇌≡≈′⁺⁻₂"], below: [], caption: undefined, textStyle: { fontSizePx: 14 } });
    expect(chemistry.above!.text).toBe("⇌≡≈′⁺⁻₂");
    expect(chemistry.plan.above!.size.contentWidth).toBeCloseTo(65.086);
    expect(chemistry.above!.width).toBe(71.09);
    expect(chemistry.plan.arrowLength).toBeCloseTo(90.086);
    const unknown = labels({ above: ["HiAW"], below: [], caption: undefined,
      textStyle: { fontSizePx: 18, fontFamily: "Installed face, Arial" } });
    expect(unknown.plan.above!.size.contentWidth).toBeCloseTo(56.07);
    expect(unknown.above!.width).toBe(62.07);
  });
  it("places Sharpless ink against the shaft and reserves both arrowheads at 14 px", () => {
    const result = labels({ textStyle: { fontSizePx: 14 }, bondLength: 28 });
    const lastAbove = renderedLines(result.above!).lines.at(-1)!.baseline;
    const firstBelow = renderedLines(result.below!).lines[0]!.baseline;
    expect(Math.abs((120 - lastAbove) - (0.75 + 0.3 * 14 + 0.21 * 14))).toBeLessThanOrEqual(0.5);
    expect(Math.abs((firstBelow - 0.716 * 14 - 120) - (0.75 + 0.3 * 14))).toBeLessThanOrEqual(0.5);
    expect(result.plan.arrowLength).toBeCloseTo(Math.max(70,
      Math.max(result.plan.above!.size.contentWidth, result.plan.below!.size.contentWidth) + 2 * (9 + 0.25 * 14)));
  });

  it.each(["2. H3O+", "2. heat"])("centres numbered script content and clears the next line %s", (next) => {
    const result = labels({ above: ["1. NaBH4, MeOH", next], below: [], textStyle: { fontSizePx: 14 } });
    const plain = labels({ above: ["1. heat", "2. stir"], below: [], textStyle: { fontSizePx: 14 } });
    const { lines } = renderedLines(result.above!);
    expect(Math.abs(lines[0]!.x + result.plan.above!.size.contentWidth / 2 - 200)).toBeLessThanOrEqual(0.5);
    if (next === "2. H3O+") {
      expect(result.above!.style.lineHeight).toBeGreaterThan(plain.above!.style.lineHeight as number);
      expect(result.above!.style.lineHeight).toBeCloseTo(1.43552, 8);
    } else {
      expect(result.above!.style.lineHeight).toBeCloseTo(1.236, 8);
    }
    const firstInk = renderedInkEnvelope(lines[0]!, 14);
    const nextInk = renderedInkEnvelope(lines[1]!, 14);
    expect(nextInk.top - firstInk.bottom).toBeGreaterThanOrEqual(0.12 * 14 - 0.001);
    if (next === "2. H3O+") {
      // The required clearance determines the minimum advance, with no unused envelope.
      expect((nextInk.top - firstInk.bottom) / 14).toBeCloseTo(0.12, 8);
      expect(lines[1]!.baseline - lines[0]!.baseline).toBeCloseTo(20.09728, 8);
    }
    const style = nativeTextStyleFromObjectStyle(result.above!.style);
    expect(result.plan.above!.size.lineBoxHeight).toBeCloseTo(2 * 14 * style.lineHeight);
    expect(result.above!.height).toBeCloseTo(Math.round((2 * 14 * style.lineHeight + 4) * 100) / 100);
  });

  it("sizes Sharpless for the subscript-to-cap pair with clearance between every rendered pair", () => {
    const result = labels({ textStyle: { fontSizePx: 14 } });
    expect(result.plan.above!.style.lineHeight).toBeCloseTo(1.236, 8);
    const { lines } = renderedLines(result.above!);
    expect(lines[1]!.baseline - lines[0]!.baseline).toBeCloseTo(17.304, 8);
    for (let index = 1; index < lines.length; index++) {
      const previous = renderedInkEnvelope(lines[index - 1]!, 14);
      const current = renderedInkEnvelope(lines[index]!, 14);
      expect(current.top - previous.bottom).toBeCloseTo(index === 1 ? 1.68 : 4.34, 8);
    }
  });

  it("keeps a superscript above a subscript at the default advance", () => {
    const result = labels({ above: ["Ca2+", "NaBH4"], below: [], textStyle: { fontSizePx: 14 } });
    expect(scripts(result.above!).map(span => span.script)).toEqual(["superscript", "subscript"]);
    expect(result.plan.above!.style.lineHeight).toBe(1.2);
    const { lines } = renderedLines(result.above!);
    expect(lines[1]!.baseline - lines[0]!.baseline).toBeCloseTo(16.8, 8);
    expect(renderedInkEnvelope(lines[1]!, 14).top - renderedInkEnvelope(lines[0]!, 14).bottom)
      .toBeCloseTo(3.836, 8);
  });

  it("considers only adjacent rendered lines, including after wrapping", () => {
    const separated = labels({ above: ["NaBH4", "heat", "Ca2+"], below: [] });
    expect(separated.plan.above!.style.lineHeight).toBeCloseTo(1.24552, 8);
    const wrapped = labels({ above: ["NaBH4 then stir", "H3O+"], below: [], bondLength: 4 });
    expect(wrapped.above!.text.split("\n")).toEqual(["NaBH4", "then", "stir", "H3O+"]);
    expect(wrapped.plan.above!.style.lineHeight).toBeCloseTo(1.24552, 8);
    const tightLastPair = labels({ above: ["heat", "NaBH4", "H3O+"], below: [] });
    expect(tightLastPair.plan.above!.style.lineHeight).toBeGreaterThan(1.2);
  });

  it.each([0.28, 3, 6])("counts %s px of authored paragraph spacing toward ink clearance", (paragraphSpacingPx) => {
    const result = labels({ above: ["1. NaBH4, MeOH", "2. H3O+"], below: [],
      textStyle: { fontSizePx: 14, lineHeight: 1, paragraphSpacingPx } });
    const { lines } = renderedLines(result.above!);
    const gapEm = (renderedInkEnvelope(lines[1]!, 14).top - renderedInkEnvelope(lines[0]!, 14).bottom) / 14;
    expect(gapEm).toBeGreaterThanOrEqual(0.12 - 0.000001);
    const style = result.plan.above!.style;
    if (paragraphSpacingPx < 6) {
      expect(style.lineHeight).toBeGreaterThan(1.2);
      expect(gapEm).toBeCloseTo(0.12, 8);
    } else {
      expect(style.lineHeight).toBe(1.2);
    }
    expect(result.plan.above!.size.lineBoxHeight).toBeCloseTo(2 * 14 * style.lineHeight + paragraphSpacingPx);
    expect(result.above!.height).toBeCloseTo(Math.round((result.plan.above!.size.lineBoxHeight + 4) * 100) / 100);
  });

  it.each([
    { above: ["NaBH4"], lineHeight: 1.2 },
    { above: ["heat", "stir"], lineHeight: 1.2 },
    { above: ["NaBH4"], lineHeight: 1.8 },
    { above: ["heat", "stir"], lineHeight: 1.8 },
    { above: ["1. NaBH4, MeOH", "2. H3O+"], lineHeight: 1.8 }
  ])("preserves authored spacing for $above at $lineHeight", ({ above, lineHeight }) => {
    const result = labels({ above, below: [], textStyle: { lineHeight } });
    expect(result.plan.above!.style.lineHeight).toBe(lineHeight);
  });

  it("floors plain authored line heights at 1.2", () => {
    const result = labels({ above: ["heat", "stir"], below: [], textStyle: { lineHeight: 0.8 } });
    expect(result.plan.above!.style.lineHeight).toBe(1.2);
  });

  it("merges adjacent runs without changing formula scripts or authored spaces", () => {
    const result = labels();
    expect(result.below!.spans).toEqual([
      { text: "CH", script: "normal", style: {} },
      { text: "2", script: "subscript", style: {} },
      { text: "Cl", script: "normal", style: {} },
      { text: "2", script: "subscript", style: {} },
      { text: ", −20 °C, 4 h", script: "normal", style: {} }
    ]);
    expect(result.below!.spans.map(span => span.text).join("")).toBe(below[0]);
    expect(labels({ above: ["1. NaBH4", "2. H3O+"], below: [] }).above!.spans).toEqual([
      { text: "1. NaBH", script: "normal", style: {} },
      { text: "4", script: "subscript", style: {} },
      { text: "\n", script: "normal", style: {} },
      { text: "2. H", script: "normal", style: {} },
      { text: "3", script: "subscript", style: {} },
      { text: "O", script: "normal", style: {} },
      { text: "+", script: "superscript", style: {} }
    ]);
  });
  it("keeps captions plain while formatting above-arrow formulas", () => {
    const captionText = "SN2 pathway; H2 uptake; C2-symmetric ligand; CH2Cl2 used";
    const result = labels({ above: ["CH2Cl2"], below: [], caption: captionText, bondLength: 100 });
    expect(result.caption!.text).toBe(captionText);
    expect(result.caption!.spans.map(span => span.text).join("")).toBe(captionText);
    expect(result.caption!.spans.every(span => span.script === "normal")).toBe(true);
    expect(scripts(result.above!).map(span => span.text)).toEqual(["2", "2"]);
  });
  it("subscripts counts in agent formulas while retaining Unicode charges", () => {
    const result = labels({ above: ["HSO4⁻, NH4⁺, SO4²⁻"], below: [], caption: undefined });
    expect(result.above!.text).toBe("HSO4⁻, NH4⁺, SO4²⁻");
    expect(scripts(result.above!).map(span => span.text)).toEqual(["4", "4", "4"]);
  });
  it("stacks the Sharpless lines with exactly the formula subscripts and a text-sized arrow", () => {
    const result = labels();
    expect(result.above!.text.split("\n")).toEqual(above);
    expect(result.below!.text.split("\n")).toEqual(below);
    expect(result.caption!.text).toBe(caption);
    expect(scripts(result.above!)).toEqual([{ text: "4", script: "subscript", offset: 8 }]);
    expect(scripts(result.below!)).toEqual([
      { text: "2", script: "subscript", offset: 2 }, { text: "2", script: "subscript", offset: 5 }
    ]);
    for (const object of [result.above!, result.below!, result.caption!]) {
      expect(object.spans.map((span) => span.text).join("")).toBe(object.text);
      expect(nativeTextStyleFromObjectStyle(object.style).textAlign).toBe("center");
      expect(object.x + object.width / 2).toBeCloseTo(200);
    }
    expect(result.plan.arrowLength).toBeCloseTo(Math.max(55,
      Math.max(result.plan.above!.size.contentWidth, result.plan.below!.size.contentWidth)
        + 2 * (reactionArrowHeadLengthPx + 0.25 * 15)));
    expect(renderedLines(result.above!).lines.at(-1)!.baseline).toBeCloseTo(120 - 0.75 - (0.3 + 0.21) * 15);
    expect(renderedLines(result.below!).lines[0]!.baseline - 0.716 * 15).toBeCloseTo(120 + 0.75 + 0.3 * 15);
    expect(result.caption!.y).toBeCloseTo(Math.max(150, result.below!.y + result.below!.height) + 0.8 * 15);
  });

  it.each([{ lines: [], length: 66 }, { lines: ["heat"], length: 66 }])("uses the minimum or head-padded arrow for $lines", ({ lines, length }) => {
    const result = labels({ above: lines, below: [], caption: undefined });
    expect(result.plan.arrowLength).toBeCloseTo(length);
    expect(result.below).toBeUndefined();
    expect(result.caption).toBeUndefined();
    if (!lines.length) expect(result.above).toBeUndefined();
  });

  it("preserves numbered steps and centres the left-aligned visible block", () => {
    const result = labels({ above: ["1. NaBH4, MeOH", "2. H3O+"], below: [] });
    expect(result.above!.text).toBe("1. NaBH4, MeOH\n2. H3O+");
    expect(nativeTextStyleFromObjectStyle(result.above!.style).textAlign).toBe("left");
    expect(result.above!.x + result.plan.above!.size.contentWidth / 2).toBeCloseTo(200);
    expect(scripts(result.above!)).toEqual([
      { text: "4", script: "subscript", offset: 7 },
      { text: "3", script: "subscript", offset: 19 },
      { text: "+", script: "superscript", offset: 21 }
    ]);
    expect(labels({ above: ["1. heat", "then stir"], below: [] }).above!.style.textAlign).toBe("center");
  });

  it("keeps numbered authored steps left-aligned after wrapping", () => {
    const result = labels({ above: ["1. NaBH4, MeOH, then a long enough instruction to wrap", "2. H3O+"], below: [] });
    expect(result.above!.text.split("\n").length).toBeGreaterThan(2);
    expect(result.above!.style.textAlign).toBe("left");
    expect(labels({ above: ["1. heat\n2. stir"], below: [] }).above!.style.textAlign).toBe("left");
    expect(labels({ above: ["1. heat\nthen stir"], below: [] }).above!.style.textAlign).toBe("center");
  });

  it.each(["\u00a0", "\u202f"])("never wraps at the non-breaking space %j", (space) => {
    const temperature = `−20${space}°C`;
    // The token is wider than the wrapping width; a break inside it would be tempting.
    const result = labels({ above: [`heat\t${temperature} stir`], below: [], bondLength: 2 });
    expect(result.above!.text.split("\n")).toEqual(["heat", temperature, "stir"]);
  });

  it.each([
    ["1. NaBH4, MeOH", "2. H3O+"], ["1. I"], ["NaBH4, MeOH", "H3O+"], ["I"]
  ])("centres the visible block using the renderer's text x: %j", (...above) => {
    const result = labels({ above, below: [], caption: undefined });
    const object = result.above!;
    const fragments = planPageSvgRender({ ...createEmptyDocument().pages[0]!, objects: [object] }).fragments.flatMap(elements);
    const rendered = fragments.find((fragment) => fragment.key === `object-${object.id}`)!;
    const x = Number(rendered.attrs.x);
    const style = nativeTextStyleFromObjectStyle(object.style);
    const widest = result.plan.above!.size.contentWidth;
    expect(rendered.attrs["text-anchor"]).toBe(style.textAlign === "left" ? "start" : "middle");
    const visibleCenter = style.textAlign === "left" ? x + widest / 2 : x;
    expect(Math.abs(visibleCenter - 200)).toBeLessThanOrEqual(0.5);
  });

  it("splits explicit newlines, drops blanks, and supports a below-only scheme", () => {
    const result = labels({ above: ["", " \n\t"], below: ["CH2Cl2\n−78 °C", "", "2 h\r\n "] });
    expect(result.above).toBeUndefined();
    expect(result.below!.text).toBe("CH2Cl2\n−78 °C\n2 h");
    expect(result.below!.spans.map((span) => span.text).join("")).toBe(result.below!.text);
    expect(scripts(result.below!).map((span) => span.text)).toEqual(["2", "2"]);
  });

  it("wraps at whitespace using span widths and leaves an oversized formula token whole", () => {
    const token = "CH2".repeat(40);
    const result = labels({ above: [`CH2Cl2 CH2Cl2 CH2Cl2 CH2Cl2 CH2Cl2 CH2Cl2 ${token} heat`], below: [] });
    const lines = result.above!.text.split("\n");
    expect(lines).toEqual(["CH2Cl2 CH2Cl2 CH2Cl2", "CH2Cl2 CH2Cl2 CH2Cl2", token, "heat"]);
    const style = nativeTextStyleFromObjectStyle(result.above!.style);
    for (const line of lines.filter((line) => line !== token)) {
      const spans = planReactionLabels({ ...defaults, above: [line], below: [] }).above!.spans;
      expect(estimateNativeTextSpanLineWidth(spans, style)).toBeLessThanOrEqual(reactionLabelWrapWidthInBonds * 22);
    }
    expect(result.above!.width).toBeGreaterThan(240);
    expect(result.plan.arrowLength).toBeCloseTo(result.plan.above!.size.contentWidth + 2 * (reactionArrowHeadLengthPx + 0.25 * 15));
  });

  describe("wrap width and unit grouping", () => {
    // Width of one unwrapped line at the defaults' 15 px text, in bond lengths of 22 px.
    const bonds = (line: string) => planReactionLabels({ ...defaults, above: [line], below: [], bondLength: 1000 })
      .above!.size.contentWidth / 22;

    it("wraps at 8.5 bond lengths a line that fit within the former 10", () => {
      expect(reactionLabelWrapWidthInBonds).toBe(8.5);
      const line = "NaBH4, MeOH, then aqueous";
      expect(bonds(line)).toBeGreaterThan(8.5);
      expect(bonds(line)).toBeLessThan(10);
      const result = labels({ above: [line], below: [] });
      // Changed: the break now falls after the last fitting comma, not after "then".
      expect(result.above!.text.split("\n")).toEqual(["NaBH4, MeOH,", "then aqueous"]);
      // The arrow still follows the widest wrapped line, not the wrap width.
      expect(result.plan.arrowLength).toBeCloseTo(result.plan.above!.size.contentWidth
        + 2 * (reactionArrowHeadLengthPx + 0.25 * 15));
    });

    it.each([
      // A break by width alone would fall between the quantity and its unit.
      // Changed: "then" now follows the comma break to the second line.
      { line: "LiAlH4 in THF, then 0.25 M", fits: "LiAlH4 in THF, then 0.25",
        expected: ["LiAlH4 in THF,", "then 0.25 M"] },
      { line: "Pd(OAc)2, K3PO4, THF, 5 mol %", fits: "Pd(OAc)2, K3PO4, THF, 5",
        expected: ["Pd(OAc)2, K3PO4, THF,", "5 mol %"] },
      // ...or inside the multi-word unit "mol %".
      { line: "Pd/C, H2, MeOH, rt, 5 mol %", fits: "Pd/C, H2, MeOH, rt, 5 mol",
        expected: ["Pd/C, H2, MeOH, rt,", "5 mol %"] }
    ])("keeps $expected.1 on one line in $line", ({ line, fits, expected }) => {
      // The prefix ending at the quantity (or at "mol") fits; adding the next word does not.
      expect(bonds(fits)).toBeLessThanOrEqual(8.5);
      expect(bonds(`${fits} ${line.slice(fits.length + 1).split(" ")[0]}`)).toBeGreaterThan(8.5);
      const result = labels({ above: [line], below: [line] });
      expect(result.above!.text.split("\n")).toEqual(expected);
      expect(result.below!.text.split("\n")).toEqual(expected);
      // Only the break itself changes the authored text; the unit keeps its plain space.
      expect(result.above!.text.replace("\n", " ")).toBe(line);
      expect(result.above!.spans.map((span) => span.text).join("")).toBe(result.above!.text);
    });

    it("keeps each quantity whole and the authored spacing verbatim when every word overflows", () => {
      const line = "K2CO3 (2.0 equiv), 80 °C, 12 h, 10 mol%, 5 mol %, 0.25 M, −78\t°C";
      const result = labels({ above: [line], below: [], bondLength: 1 });
      // Changed: "K2CO3 (2.0 equiv)," is now one piece, a reagent with its parenthesised amount.
      expect(result.above!.text.split("\n")).toEqual([
        "K2CO3 (2.0 equiv),", "80 °C,", "12 h,", "10 mol%,", "5 mol %,", "0.25 M,", "−78\t°C"
      ]);
    });
  });

  describe("comma breaks and parenthesised amounts", () => {
    const bonds = (line: string) => planReactionLabels({ ...defaults, above: [line], below: [], bondLength: 1000 })
      .above!.size.contentWidth / 22;

    it.each([22, 24])("breaks after the comma, never inside a reagent's amount, at bond length %s", (bondLength) => {
      const line = "Pd(PPh3)4 (5 mol %), K2CO3 (2.0 equiv)";
      expect(bonds(line)).toBeGreaterThan(8.5 * bondLength / 22);
      const result = labels({ above: [line], below: [line], bondLength });
      expect(result.above!.text.split("\n")).toEqual(["Pd(PPh3)4 (5 mol %),", "K2CO3 (2.0 equiv)"]);
      expect(result.below!.text).toBe(result.above!.text);
      expect(result.above!.text.replace("\n", " ")).toBe(line);
    });

    it("splits two reagents with amounts only at the comma between them", () => {
      const line = "HATU (1.2 equiv), DIPEA (3.0 equiv)";
      // A break by width alone would leave "DIPEA" on the first line and "(3.0 equiv)" alone.
      expect(bonds("HATU (1.2 equiv), DIPEA")).toBeLessThanOrEqual(8.5);
      expect(bonds(line)).toBeGreaterThan(8.5);
      const expected = ["HATU (1.2 equiv),", "DIPEA (3.0 equiv)"];
      expect(labels({ above: [line], below: [] }).above!.text.split("\n")).toEqual(expected);
      // Even when each piece overflows, neither amount leaves its reagent.
      expect(labels({ above: [line], below: [], bondLength: 1 }).above!.text.split("\n")).toEqual(expected);
    });

    it("puts a reagent and amount wider than the limit on its own line and lets it overflow", () => {
      const piece = "toluene/H2O (4:1, 0.25 M)";
      expect(bonds(piece)).toBeGreaterThan(8.5);
      const result = labels({ above: [`Pd2(dba)3, XPhos, ${piece}, 80 °C`], below: [] });
      expect(result.above!.text.split("\n")).toEqual(["Pd2(dba)3, XPhos,", `${piece},`, "80 °C"]);
      expect(result.plan.above!.size.contentWidth).toBeGreaterThan(reactionLabelWrapWidthInBonds * 22);
    });

    it("does not break at a comma inside parentheses", () => {
      const line = "XPhos, toluene/H2O (4:1, 0.25 M)";
      // At bond length 23 the parenthesised comma fits and the whole group fits on its own.
      const limit = 8.5 * 23 / 22;
      expect(bonds("XPhos, toluene/H2O (4:1,")).toBeLessThanOrEqual(limit);
      expect(bonds("toluene/H2O (4:1, 0.25 M)")).toBeLessThanOrEqual(limit);
      expect(bonds(line)).toBeGreaterThan(limit);
      const result = labels({ above: [line], below: [], bondLength: 23 });
      expect(result.above!.text.split("\n")).toEqual(["XPhos,", "toluene/H2O (4:1, 0.25 M)"]);
    });

    it("keeps an unclosed parenthesis as ordinary words", () => {
      const result = labels({ above: ["K2CO3 (2.0 equiv, MeOH, then aqueous workup and filtration"], below: [] });
      expect(result.above!.text.replace(/\n/g, " ")).toBe("K2CO3 (2.0 equiv, MeOH, then aqueous workup and filtration");
      expect(result.above!.text.split("\n").length).toBeGreaterThan(1);
    });

    it("keeps a weight or volume percentage and a leading-decimal quantity whole", () => {
      const line = "5 wt %, 10 vol %, .5 M, −.25 M, 5 vol";
      // Every piece overflows, so each line is exactly one unbreakable piece.
      const result = labels({ above: [line], below: [], bondLength: 1 });
      expect(result.above!.text.split("\n")).toEqual(["5 wt %,", "10 vol %,", ".5 M,", "−.25 M,", "5 vol"]);
    });

    it.each([
      { line: "Pd(OAc)2, THF/H2O(4:1, 0.25 M), 80 °C", expected: ["Pd(OAc)2,", "THF/H2O(4:1, 0.25 M),", "80 °C"] },
      // A nested group opened mid-word, and one opened mid-word inside a word-initial group.
      { line: "K2CO3(aq(sat., 2 M)), MeOH", expected: ["K2CO3(aq(sat., 2 M)),", "MeOH"] },
      { line: "NaOH (aq(1 M, 2 equiv)), MeOH", expected: ["NaOH (aq(1 M, 2 equiv)),", "MeOH"] }
    ])("never splits a parenthesised group opened mid-word at its inner comma: $line", ({ line, expected }) => {
      expect(labels({ above: [line], below: [], bondLength: 1 }).above!.text.split("\n")).toEqual(expected);
    });

    it("does not prefer a comma inside a group opened mid-word, or after an unclosed parenthesis", () => {
      // "THF/H2O(4:1, 0.25 M) at" fits 8.5 bonds; a comma break would leave "(4:1," split from its group.
      expect(bonds("THF/H2O(4:1, 0.25 M) at")).toBeLessThanOrEqual(8.5);
      expect(labels({ above: ["THF/H2O(4:1, 0.25 M) at reflux"], below: [] }).above!.text.split("\n"))
        .toEqual(["THF/H2O(4:1, 0.25 M) at", "reflux"]);
      // An unclosed group stays breakable by width, but its commas are not preferred breaks.
      const unclosed = "K2CO3 (aq, MeOH then aqueous workup";
      expect(bonds("K2CO3 (aq, MeOH then")).toBeLessThanOrEqual(8.5);
      expect(labels({ above: [unclosed], below: [] }).above!.text.split("\n"))
        .toEqual(["K2CO3 (aq, MeOH then", "aqueous workup"]);
    });

    it.each([
      { line: "add (R)-BINAP (5 mol %)", expected: ["add", "(R)-BINAP (5 mol %)"] },
      { line: "with (+)-DET (6 mol%).", expected: ["with", "(+)-DET (6 mol%)."] },
      { line: "then (S)-proline", expected: ["then", "(S)-proline"] },
      // An amount followed by punctuation ending the piece still attaches.
      { line: "NaBH4 (2 equiv); MeOH", expected: ["NaBH4 (2 equiv);", "MeOH"] }
    ])("attaches a parenthesised group only when it is an amount, not a name prefix: $line", ({ line, expected }) => {
      expect(labels({ above: [line], below: [], bondLength: 1 }).above!.text.split("\n")).toEqual(expected);
    });

    it("groups a line of many unclosed parentheses in one linear pass", () => {
      const words = 12000;
      const line = Array.from({ length: words }, () => "(a").join(" ");
      const result = labels({ above: [line], below: [], bondLength: 1 });
      // Deterministic linear bound: the scan takes at most 4 steps per character; rescanning per "(" would be quadratic.
      expect(wrapPiecesWorkForTesting(line, true).steps).toBeLessThanOrEqual(4 * line.length);
      expect(result.above!.text.split("\n")).toHaveLength(words);
    });

    it("groups deeply nested parentheses in linear work", () => {
      const depth = 6000;
      const line = "(x ".repeat(depth) + ")".repeat(depth);
      const { pieces, steps } = wrapPiecesWorkForTesting(line, true);
      // Each closing parenthesis checks a once-per-word trailing boundary; none rescans the closers behind it.
      expect(steps).toBeLessThanOrEqual(4 * line.length);
      expect(pieces).toHaveLength(1);
      expect(labels({ above: [line], below: [], bondLength: 1 }).above!.text.split("\n")).toHaveLength(1);
    });

    it.each([
      { above: ["N".repeat(120)], expected: ["N".repeat(120)] },
      { above: [`heat ${"N".repeat(120)} 0.25 M`], expected: ["heat", "N".repeat(120), "0.25 M"] },
      { above: [`${"N".repeat(120)}  \t `], expected: ["N".repeat(120)] }
    ])("places an oversized single token on its own line without empty lines: $#", ({ above, expected }) => {
      const result = labels({ above, below: [] });
      const lines = result.above!.text.split("\n");
      expect(lines).toEqual(expected);
      expect(lines.every((line) => line.length > 0)).toBe(true);
      expect(result.plan.above!.size.contentWidth).toBeGreaterThan(reactionLabelWrapWidthInBonds * 22);
    });
  });

  it.each(["forward", "equilibrium", "resonance", "retrosynthesis", "unknown"] as const)("clears the visible %s arrow geometry", (arrowKind) => {
    const result = labels({ arrowKind });
    const geometry = planReactionArrowGeometry(arrowKind, { x: 0, y: 0 }, { x: result.plan.arrowLength, y: 0 });
    const ys = [...geometry.lines.flatMap((line) => [line.start.y, line.end.y]),
      ...geometry.heads.flatMap((head) => head.points.map((point) => point.y))];
    const extent = reactionArrowVerticalExtent(arrowKind, result.plan.arrowLength);
    expect(extent.top).toBeLessThanOrEqual(Math.min(...ys));
    expect(extent.bottom).toBeGreaterThanOrEqual(Math.max(...ys));
    const shaftYs = geometry.lines.filter(line => line.start.y === line.end.y)
      .flatMap(line => [line.start.y, line.end.y]);
    const lastBaseline = renderedLines(result.above!).lines.at(-1)!.baseline;
    const firstCapTop = renderedLines(result.below!).lines[0]!.baseline - 0.716 * 15;
    expect(lastBaseline + 0.21 * 15).toBeCloseTo(120 + Math.min(...shaftYs) - 0.75 - 0.3 * 15);
    expect(firstCapTop).toBeCloseTo(120 + Math.max(...shaftYs) + 0.75 + 0.3 * 15);
    // All text lies inside the head-free horizontal interval, even for the retro chevron.
    const headXs = [...geometry.heads.flatMap(head => head.points.map(point => point.x)),
      ...geometry.lines.filter(line => line.start.y !== line.end.y).flatMap(line => [line.start.x, line.end.x])];
    const widest = Math.max(result.plan.above!.size.contentWidth, result.plan.below!.size.contentWidth);
    const left = (result.plan.arrowLength - widest) / 2;
    expect(left).toBeGreaterThanOrEqual((arrowKind === "retrosynthesis" ? 10.75
      : arrowKind === "unknown" ? 0 : 9) + 0.25 * 15);
    expect(headXs.every(x => x < left || x > left + widest)).toBe(true);
  });

  it.each(["forward", "equilibrium", "resonance", "retrosynthesis", "unknown"] as const)(
    "keeps text ink clear of %s shafts and heads at 8/10/14 px", (arrowKind) => {
      expect(reactionArrowHeadDepthPx(arrowKind)).toBe(arrowKind === "retrosynthesis" ? 10.75
        : arrowKind === "unknown" ? 0 : 9);
      for (const fontSizePx of [8, 10, 14]) {
        for (const [scripted, lineCount] of [[false, 1], [true, 1], [false, 2], [true, 2]] as const) {
          const result = labels({ arrowKind, textStyle: { fontSizePx },
            above: (scripted ? ["1. NaBH4, MeOH", "2. H3O+"] : ["heat", "stir"]).slice(-lineCount),
            below: (scripted ? ["H3O+", "NaBH4"] : ["cool", "wait"]).slice(0, lineCount) });
          const startX = 200 - result.plan.arrowLength / 2;
          const geometry = planReactionArrowGeometry(arrowKind, { x: startX, y: 120 },
            { x: startX + result.plan.arrowLength, y: 120 });
          const shaftYs = geometry.lines.filter(line => line.start.y === line.end.y).map(line => line.start.y);
          const shaftTop = Math.min(...shaftYs) - 0.75;
          const shaftBottom = Math.max(...shaftYs) + 0.75;
          const lastAbove = renderedLines(result.above!).lines.at(-1)!;
          const firstBelow = renderedLines(result.below!).lines[0]!;
          expect(shaftTop - renderedInkEnvelope(lastAbove, fontSizePx).bottom).toBeCloseTo(0.3 * fontSizePx, 8);
          expect(renderedInkEnvelope(firstBelow, fontSizePx).top - shaftBottom).toBeCloseTo(0.3 * fontSizePx, 8);
          // Text placement uses independent parent-em literals.
          expect(lastAbove.baseline).toBeCloseTo(shaftTop - fontSizePx * (0.3 +
            (scripted ? 0.4 : 0.21)), 8);
          expect(firstBelow.baseline).toBeCloseTo(shaftBottom + fontSizePx * (0.3 +
            (scripted ? 0.4 + 0.72 * 0.716 : 0.716)), 8);
          const headRegions = [
            ...geometry.heads.map(head => ({ min: Math.min(...head.points.map(p => p.x)),
              max: Math.max(...head.points.map(p => p.x)) })),
            ...geometry.lines.filter(line => line.start.y !== line.end.y).map(line => ({
              min: Math.min(line.start.x, line.end.x) - 0.75,
              max: Math.max(line.start.x, line.end.x) + 0.75
            }))
          ];
          for (const [object, block] of [[result.above!, result.plan.above!], [result.below!, result.plan.below!]] as const) {
            expect(object.width).toBe(block.size.width);
            expect(object.height).toBe(block.size.height);
            expect(Number(renderedLines(object).rendered.attrs.y)).toBeCloseTo(object.y + fontSizePx, 8);
            const style = nativeTextStyleFromObjectStyle(object.style);
            for (const line of renderedLines(object).lines) {
              const width = estimateNativeTextSpanLineWidth(line.runs.map((run): TextSpan => ({ text: content(run),
                script: "normal", style: { fontSizePx: parseFloat(String(run.attrs["font-size"] ?? fontSizePx)) }
              })), style);
              const left = style.textAlign === "left" ? line.x : line.x - width / 2;
              for (const head of headRegions) expect(left + width <= head.min || left >= head.max).toBe(true);
              const ink = renderedInkEnvelope(line, fontSizePx);
              expect(ink.top).toBeGreaterThanOrEqual(object.y - 1e-8);
              expect(ink.bottom).toBeLessThanOrEqual(object.y + object.height + 1e-8);
            }
          }
        }
      }
    }
  );

  it("scales frames and rendered ink together with the reaction page", () => {
    const result = labels({ above: ["heat"], below: ["CH2Cl2"], textStyle: { fontSizePx: 8 } });
    const page = { ...createEmptyDocument().pages[0]!, objects: [result.above!, result.below!] };
    const scaled = scalePageGeometry(page, 2);
    for (const [index, object] of page.objects.entries()) {
      const originalLine = renderedLines(object).lines[0]!;
      const scaledObject = scaled.objects[index]! as TextObject;
      const scaledLine = renderedLines(scaledObject).lines[0]!;
      expect(scaledObject.y).toBeCloseTo(object.y * 2);
      expect(scaledObject.height).toBeCloseTo(object.height * 2);
      expect(scaledLine.baselines).toEqual(originalLine.baselines.map(y => y * 2));
    }
  });

  it("uses 72% script sizes with continuous letter spacing and explicit-line height", () => {
    const style = nativeTextStyleFromObjectStyle({ fontSizePx: 15, letterSpacingPx: 2 });
    const spans: TextSpan[] = [
      { text: "H", script: "normal", style: {} },
      { text: "2", script: "subscript", style: {} },
      { text: "O", script: "normal", style: {} }
    ];
    expect(estimateNativeTextSpanLineWidth(spans, style)).toBeCloseTo(15 * (0.723 + 0.778) + 15 * 0.72 * 0.557 + 6);
    expect(estimateNativeTextSpanLineWidth(spans, style)).toBeLessThan(estimateNativeTextLineWidth("H2O", style));
    const result = labels({ above: ["H2O\nCH2Cl2"], textStyle: { fontSizePx: 15, lineHeight: 1.5, paragraphSpacingPx: 3 } });
    expect(result.above!.height).toBe(2 * 15 * 1.5 + 3 + 4);
    expect(renderedLines(result.above!).lines.at(-1)!.baseline).toBeCloseTo(120 - 0.75 - (0.3 + 0.4) * 15);
  });

  it("wraps a caption to at least eight bonds even under a narrow scheme", () => {
    const plan = planReactionLabels({ ...defaults, above: [], below: [], caption: "CH2Cl2 ".repeat(8) });
    const result = layoutReactionLabels(plan, {
      arrowMidpoint: { x: 100, y: 120 },
      schemeBounds: { minX: 70, minY: 110, maxX: 130, maxY: 130 }, idPrefix: "narrow"
    });
    expect(result.caption!.text.split("\n")).toEqual([
      "CH2Cl2 CH2Cl2 CH2Cl2", "CH2Cl2 CH2Cl2 CH2Cl2", "CH2Cl2 CH2Cl2"
    ]);
    expect(result.caption!.x + result.caption!.width / 2).toBe(100);
    expect(scripts(result.caption!)).toEqual([]);
  });

  it.each([1, 100, 150, 200])("wraps a caption exactly as release 1.2.2 did, by width alone, at %s px", (width) => {
    // No quantity grouping, no comma preference, no parenthesis grouping: break at any space or tab.
    const text = "Pd (5 mol %), then 0.25 M LiAlH4 (2.0 equiv), THF/H2O(4:1, 5 wt %) at 80 °C, 12 h";
    const plan = planReactionLabels({ ...defaults, above: [], below: [], caption: text, bondLength: 1 });
    const result = layoutReactionLabels(plan, {
      arrowMidpoint: { x: 0, y: 0 }, schemeBounds: { minX: 0, minY: 0, maxX: width, maxY: 10 }, idPrefix: "caption"
    });
    // The release 1.2.2 algorithm, on plain caption spans.
    const fits = (line: string) => estimateNativeTextSpanLineWidth([{ text: line, script: "normal", style: {} }],
      plan.textStyle) <= width;
    const base: string[] = [];
    let current = "";
    for (const [word] of text.matchAll(/[^ \t]+[ \t]*/g)) {
      if (current && !fits((current + word).replace(/[ \t]+$/, ""))) {
        base.push(current.replace(/[ \t]+$/, ""));
        current = word;
      } else current += word;
    }
    base.push(current.replace(/[ \t]+$/, ""));
    const expected = {
      1: ["Pd", "(5", "mol", "%),", "then", "0.25", "M", "LiAlH4", "(2.0", "equiv),", "THF/H2O(4:1,", "5", "wt", "%)",
        "at", "80", "°C,", "12", "h"],
      100: ["Pd (5 mol %),", "then 0.25 M", "LiAlH4 (2.0", "equiv),", "THF/H2O(4:1,", "5 wt %) at", "80 °C, 12 h"],
      150: ["Pd (5 mol %), then", "0.25 M LiAlH4 (2.0", "equiv),", "THF/H2O(4:1, 5 wt", "%) at 80 °C, 12 h"],
      200: ["Pd (5 mol %), then 0.25 M", "LiAlH4 (2.0 equiv),", "THF/H2O(4:1, 5 wt %) at", "80 °C, 12 h"]
    }[width]!;
    expect(base).toEqual(expected);
    expect(result.caption!.text.split("\n")).toEqual(expected);
  });

  it("renders the planned lines and script spans through the canvas/export page renderer", () => {
    const molecule = {
      id: "mol", type: "molecule" as const, x: 0, y: 0, width: 40, height: 20,
      rotation: 0, style: {}, structureFormat: "smiles" as const, structure: "C",
      atoms: [{ id: "c", element: "C", x: 0, y: 0, formalCharge: 0 }], bonds: [], superatoms: [], rGroups: []
    };
    const result = layoutReactionScheme({
      ...defaults, reactants: [{ molecule, bounds: { minX: 0, minY: 0, maxX: 40, maxY: 20 } }], products: [],
      anchor: { x: 24, y: 120 }, gutter: 24, pagePadding: 24
    });
    const numbered = labels({ above: ["1. NaBH4, MeOH", "2. H3O+"], below: [] }).above!;
    const wrapped = labels({ above: ["CH2Cl2 ".repeat(30)], below: [], caption: "CH2Cl2 ".repeat(60) });
    // Include an overlong token to pin the old renderer/measurement disagreement above 240 px.
    const oversized = labels({ above: ["CH2".repeat(40)], below: [] }).above!;
    const objects = [result.above!, result.below!, result.caption!,
      { ...numbered, id: "numbered" }, { ...wrapped.above!, id: "wrapped" },
      { ...wrapped.caption!, id: "wrapped_caption" }, { ...oversized, id: "oversized" }];
    const page = { ...result.document.pages[0]!, objects: [...result.document.pages[0]!.objects, ...objects.slice(3)] };
    const fragments = planPageSvgRender(page).fragments.flatMap(elements);
    for (const object of objects) {
      const rendered = fragments.find((fragment) => fragment.key === `object-${object.id}`)!;
      expect(rendered.tag).toBe("text");
      const runs = rendered.children.filter((child): child is PageSvgElementFragment => child.kind === "element");
      const lines: PageSvgElementFragment[][] = [];
      for (const run of runs) {
        if (run.attrs.x !== undefined) lines.push([]);
        lines.at(-1)!.push(run);
      }
      expect(lines.map((line) => line.map(content).join(""))).toEqual(object.text.split("\n"));
      const style = nativeTextStyleFromObjectStyle(object.style);
      expect(runs.every(run => run.attrs["baseline-shift"] === undefined)).toBe(true);
      const scriptedRuns = runs.filter(run => run.attrs["font-size"] !== undefined);
      expect(scriptedRuns.map(content)).toEqual(object.spans.filter(span => span.script !== "normal").map(span => span.text));
      for (const run of scriptedRuns) {
        expect(run.attrs["font-size"]).toMatch(/px$/);
        expect(parseFloat(String(run.attrs["font-size"]))).toBeCloseTo(style.fontSizePx * 0.72);
      }
      const positions = renderedLines(object).lines;
      for (const [index, line] of lines.entries()) {
        const spans: TextSpan[] = line.map((run) => ({
          text: content(run), script: "normal",
          style: { fontSizePx: parseFloat(String(run.attrs["font-size"] ?? style.fontSizePx)) }
        }));
        expect(estimateNativeTextSpanLineWidth(spans, style)).toBeLessThanOrEqual(object.width + 2);
        expect(line[0].attrs.x).toBeCloseTo(style.textAlign === "left" ? object.x : object.x + object.width / 2);
        if (index > 0) expect(positions[index]!.baseline - positions[index - 1]!.baseline)
          .toBeCloseTo(style.fontSizePx * style.lineHeight + style.paragraphSpacingPx);
        for (const [runIndex, run] of line.entries()) {
          const offset = positions[index]!.baselines[runIndex]! - positions[index]!.baseline;
          expect(Math.abs(offset)).toBeCloseTo(run.attrs["font-size"] === undefined ? 0 : 0.4 * style.fontSizePx);
        }
      }
    }
  });
});
it.each(["H2O", "CH2Cl2", "Et2O", "K2CO3", "Pd(PPh3)4"])("subscripts condition formula %s", text => {
  const result = labels({ above: [text], below: [] });
  expect(result.above!.spans.some(span => span.script === "subscript")).toBe(true);
});

it.each(["90 °C", "2 h", "1:1", "10 mol%", "TS1/TS2", "TS1,TS2", "p-TsOH"])("leaves condition prose %s plain", text => {
  const result = labels({ above: [text], below: [] });
  expect(result.above!.spans.every(span => span.script === "normal")).toBe(true);
});
