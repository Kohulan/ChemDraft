import { describe, expect, it } from "vitest";
import { nativeTextStyleFromObjectStyle, type ChemDraftDocument, type NativeTextStyle, type TextObject } from "@chemdraft/chem-core";
import { openNativeDocument, updateNativeTextObjectStyle, updateNativeTextObjectStyleRange } from "./documentWorkflow";

// Codex (1.2.3): imported captions gained explicit run styles (face="0" became an explicit regular
// run), so formatting the whole text object changed only the object's style and the runs kept
// overriding it: Bold, italic, underline, font and size did nothing visible.
const fontTable = '<fonttable><font id="3" charset="iso-8859-1" name="Arial"/><font id="4" charset="iso-8859-1" name="Courier"/></fonttable>';
const captionSource = (runs: string) =>
  `<CDXML>${fontTable}<page><t id="10" p="52 210" BoundingBox="40 200 100 214" Justification="Left">${runs}</t></page></CDXML>`;
const open = (runs: string) => openNativeDocument(captionSource(runs)).document!;
const captionOf = (document: ChemDraftDocument) =>
  document.pages[0].objects.find((object): object is TextObject => object.type === "text")!;
/** What a run renders with: its own style over the text object's. */
const resolvedRuns = (document: ChemDraftDocument) => {
  const caption = captionOf(document);
  return caption.spans.map(span => nativeTextStyleFromObjectStyle({ ...caption.style, ...span.style }));
};
const regularThenSubscript = '<s font="3" size="12" face="0">Yield </s><s font="3" size="9" face="32">2</s>';

const wholeObjectPatches: Array<[string, Partial<NativeTextStyle>]> = [
  ["bold", { fontWeight: 700 }],
  ["italic", { fontStyle: "italic" }],
  ["underline", { textDecoration: "underline" }],
  ["font family", { fontFamily: "Times New Roman, Times, serif" }],
  ["font size", { fontSizePx: 26.667 }]
];

describe("whole-object formatting of an imported caption", () => {
  it("imports runs without overrides that merely repeat the caption's own style", () => {
    const caption = captionOf(open(regularThenSubscript));
    expect(caption.style).toMatchObject({ fontFamily: "Arial", fontSizePx: 16, textAlign: "left" });
    expect(caption.spans.map(span => span.style)).toEqual([{}, { fontSizePx: 12 }]);
    expect(caption.spans.map(span => span.script)).toEqual(["normal", "subscript"]);
    expect(resolvedRuns(open(regularThenSubscript)).map(run => [run.fontFamily, run.fontSizePx, run.fontWeight]))
      .toEqual([["Arial", 16, 400], ["Arial", 12, 400]]);
  });

  it.each(wholeObjectPatches)("applies whole-object %s to every run of an imported caption", (_name, patch) => {
    const before = open(regularThenSubscript);
    const after = updateNativeTextObjectStyle(before, captionOf(before).id, patch);
    for (const run of resolvedRuns(after)) expect(run).toMatchObject(patch);
    // The subscript run keeps its script; the previous document is untouched, so Undo restores it exactly.
    expect(captionOf(after).spans.map(span => span.script)).toEqual(["normal", "subscript"]);
    expect(captionOf(before).spans.map(span => span.style)).toEqual([{}, { fontSizePx: 12 }]);
  });

  it.each(wholeObjectPatches)("clears a stale explicit run value when whole-object %s is applied", (_name, patch) => {
    // A caption imported by the earlier build stated every value on every run.
    const document = open(regularThenSubscript);
    const caption = captionOf(document);
    caption.spans = caption.spans.map((span, index) => ({ ...span, style: { ...span.style, color: "#008800",
      fontFamily: "Arial", fontSizePx: index ? 12 : 16, fontWeight: 400, fontStyle: "normal", textDecoration: "none" } }));
    const after = updateNativeTextObjectStyle(document, caption.id, patch);
    for (const run of resolvedRuns(after)) expect(run).toMatchObject({ ...patch, color: "#008800" });
    const [key] = Object.keys(patch);
    for (const span of captionOf(after).spans) {
      expect(span.style).not.toHaveProperty(key);
      // Unrelated run properties stay.
      expect(Object.keys(span.style).sort()).toEqual(
        ["color", "fontFamily", "fontSizePx", "fontStyle", "fontWeight", "textDecoration"].filter(name => name !== key));
    }
  });

  it("makes a mixed caption all bold, then all regular, keeping a run's other formatting", () => {
    const document = open('<s font="3" size="12" face="3">Bold </s><s font="4" size="12" face="0">plain</s>');
    const caption = captionOf(document);
    expect(caption.spans.map(span => span.style)).toEqual([{ fontWeight: 700, fontStyle: "italic" }, { fontFamily: "Courier" }]);
    const bold = updateNativeTextObjectStyle(document, caption.id, { fontWeight: 700 });
    expect(resolvedRuns(bold).map(run => run.fontWeight)).toEqual([700, 700]);
    const regular = updateNativeTextObjectStyle(bold, caption.id, { fontWeight: 400 });
    expect(resolvedRuns(regular).map(run => [run.fontWeight, run.fontStyle, run.fontFamily]))
      .toEqual([[400, "italic", "Arial"], [400, "normal", "Courier"]]);
    // A whole-object property no run states leaves the runs as they were.
    const centered = updateNativeTextObjectStyle(document, caption.id, { textAlign: "center" });
    expect(captionOf(centered).spans).toEqual(caption.spans);
  });

  it("keeps character-range formatting on the selected runs only", () => {
    const document = open(regularThenSubscript);
    const caption = captionOf(document);
    const ranged = updateNativeTextObjectStyleRange(document, caption.id, { start: 0, end: 5 }, { fontWeight: 700 });
    expect(captionOf(ranged).style).toEqual(caption.style);
    expect(captionOf(ranged).spans.map(span => [span.text, span.style])).toEqual([
      ["Yield", { fontWeight: 700 }], [" ", {}], ["2", { fontSizePx: 12 }]
    ]);
  });
});
