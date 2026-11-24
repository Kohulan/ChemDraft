import { describe, expect, it } from "vitest";
import { nativeTextStyleFromObjectStyle, type TextObject, type TextSpan } from "@chemdraft/chem-core";
import { nativeTextSpanLayout, planTextObjectSvg, textObjectSpanLines, measureNativeTextSpanLineWidth,
  textContentFrame, type PageSvgElementFragment } from "./index";

const normal = (text: string): TextSpan => ({ text, script: "normal", style: {} });
const object = (width = 80): TextObject => ({ id: "resized-text", type: "text", x: 100, y: 100,
  width, height: 300, rotation: 0, text: "reaction conditions and temperature", spans: [],
  style: { fontSizePx: 18, textBoxSizingMode: "fixed-width" } });
const text = (lines: TextSpan[][]) => lines.map(line => line.map(span => span.text).join(""));

describe("current resized text layout", () => {
  it("wraps the finished SVG and reflows when widened without changing source content", () => {
    const narrow = { ...object(), height: 24 }, before = structuredClone(narrow);
    const plan = planTextObjectSvg(narrow, 0);
    const lines = plan.children.filter((child): child is PageSvgElementFragment => child.kind === "element" && child.attrs.x !== undefined);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every(line => typeof line.attrs.y === "number")).toBe(true);
    expect(text(textObjectSpanLines(narrow)).join("")).toBe(narrow.text);
    expect(textObjectSpanLines({ ...narrow, width: 1000 })).toHaveLength(1);
    expect(narrow).toEqual(before);
    expect(textContentFrame(narrow).height).toBeGreaterThan(narrow.height);
  });
  it("keeps auto text and attached reaction conditions on authored lines", () => {
    expect(textObjectSpanLines({ ...object(), style: { textBoxSizingMode: "auto" } })).toHaveLength(1);
    expect(textObjectSpanLines({ ...object(), arrowAttachment: { kind: "conditions", parentObjectId: "arrow", side: "above",
      frame: { origin: { x: 0, y: 0 }, tangent: { x: 1, y: 0 }, normal: { x: 0, y: 1 } }, offset: { x: 0, y: 0 } } })).toHaveLength(1);
  });
  it("uses current font/script metrics and retains formatted words across span boundaries", () => {
    const spans: TextSpan[] = [normal("water "), { text: "H", script: "normal", style: { color: "#ff0000" } },
      { text: "2", script: "subscript", style: {} }, normal("O and heat")];
    const lines = nativeTextSpanLayout(spans, nativeTextStyleFromObjectStyle({ fontSizePx: 18 }), 80).map(line => line.spans);
    expect(text(lines).join("")).toBe(spans.map(span => span.text).join(""));
    expect(text(lines).some(line => line.includes("H2O"))).toBe(true);
    expect(lines.flat().find(span => span.text === "2")?.script).toBe("subscript");
    expect(lines.flat().find(span => span.text === "H")?.style.color).toBe("#ff0000");
  });
  it("splits long Unicode words without losing characters", () => {
    const style = nativeTextStyleFromObjectStyle({ fontSizePx: 18 });
    const value = "polymerizationαβ😀";
    const lines = nativeTextSpanLayout([normal(value)], style, 60).map(line => line.spans);
    expect(text(lines).join("")).toBe(value);
    expect(lines.every(line => measureNativeTextSpanLineWidth(line, style) <= 60)).toBe(true);
  });
  it("preserves blank Windows paragraphs and distinguishes paragraph spacing from wrapping", () => {
    const style = nativeTextStyleFromObjectStyle({ fontSizePx: 18 });
    expect(text(nativeTextSpanLayout([normal("one\r"), normal("\n\r\ntwo\r")], style).map(line => line.spans)))
      .toEqual(["one", "", "two", ""]);
    const layout = nativeTextSpanLayout([normal("reaction conditions\nheat")], style, 70);
    expect(layout.filter(line => line.paragraphIndex === 0).length).toBeGreaterThan(1);
    expect(layout.filter(line => line.paragraphIndex === 1)).toHaveLength(1);
  });
  it("wraps long whitespace runs within the limit without losing characters", () => {
    const style = nativeTextStyleFromObjectStyle({ fontSizePx: 18 });
    for (const value of ["alpha" + " ".repeat(40) + "beta", " ".repeat(60), "\t".repeat(30), "word" + " ".repeat(30)]) {
      const lines = nativeTextSpanLayout([normal(value)], style, 60).map(line => line.spans);
      expect(text(lines).join("")).toBe(value);
      const trimmed = (line: TextSpan[]) => {
        const last = line[line.length - 1]!;
        return /\s$/.test(last.text) ? [...line.slice(0, -1), { ...last, text: last.text.slice(0, -1) }] : line;
      };
      expect(lines.every(line => measureNativeTextSpanLineWidth(trimmed(line), style) <= 60)).toBe(true);
    }
  });
  it("keeps a single wrap-point space at the end of the line", () => {
    const style = nativeTextStyleFromObjectStyle({ fontSizePx: 18 });
    const width = measureNativeTextSpanLineWidth([normal("alpha")], style);
    const lines = text(nativeTextSpanLayout([normal("alpha beta")], style, width).map(line => line.spans));
    expect(lines).toEqual(["alpha ", "beta"]);
    expect(lines.join("")).toBe("alpha beta");
  });
});
