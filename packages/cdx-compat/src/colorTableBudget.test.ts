import { describe, expect, it } from "vitest";
import { createEmptyDocument, serializeDocument, type TextObject } from "@chemdraft/chem-core";
import { exportDocumentToCdxml, openChemDraftPayload } from "./index";

// Codex security finding (#442), follow-up to the caption font-byte cap: every imported text and
// graphic stored its own copy of the file's whole color table (cdxmlTextColorTable /
// cdxmlGraphicColorTable), and the table had no size limit, so a crafted file of many colors and
// many texts saved (colors x texts) of native JSON on autosave. Sizes are measured in characters
// and entries, never timed.

const plain = { embedNativePayload: false };
const textsOf = (opened: ReturnType<typeof openChemDraftPayload>) =>
  opened.document!.pages[0].objects.filter((object): object is TextObject => object.type === "text");
const colorTable = (count: number) =>
  `<colortable>${Array.from({ length: count }, (_, i) => `<color r="${(i % 256) / 255}" g="${(Math.floor(i / 256) % 256) / 255}" b="0.5"/>`).join("")}</colortable>`;
const coloredText = (id: number, color: number, y: number) =>
  `<t id="${id}" p="30 ${y}"><s font="3" size="10" face="0" color="${color}">x</s></t>`;
const crafted = (colors: number, texts: number) =>
  `<CDXML><fonttable><font id="3" charset="iso-8859-1" name="Arial"/></fonttable>${colorTable(colors)}<page>` +
  `${Array.from({ length: texts }, (_, i) => coloredText(i + 10, 2 + (i % colors), 72 + i)).join("")}</page></CDXML>`;
const nativeJsonChars = (source: string) => {
  const opened = openChemDraftPayload(source);
  return { opened, chars: JSON.stringify(opened.document).length };
};
const storedColorEntries = (objects: readonly { compatibility?: { unknown: Record<string, unknown> } }[]) =>
  objects.reduce((sum, object) => sum + Object.keys((object.compatibility?.unknown.cdxmlTextColorTable ??
    object.compatibility?.unknown.cdxmlGraphicColorTable ?? {}) as object).length, 0);

describe("CDXML color table bytes (#442)", () => {
  it("bounds the whole-table copies of a crafted file of many colors and many texts, so native JSON grows linearly", () => {
    const colors = 4_000;
    const sizes = [2_000, 4_000, 8_000].map(texts => {
      const source = crafted(colors, texts);
      const { opened, chars } = nativeJsonChars(source);
      const texts_ = textsOf(opened);
      expect(texts_).toHaveLength(texts);
      // Before the budget every text stored all 4,002 entries: 8,000 texts held 32 million entries (~580 MB of JSON).
      const entries = storedColorEntries(texts_);
      // Whole copies stop at the 65,536-entry budget; every later text stores the one color its run uses.
      expect(entries).toBeLessThanOrEqual(65_536 + colors + texts);
      // The first text still stores the whole table, so export can restore every source index.
      expect(Object.keys(texts_[0].compatibility!.unknown.cdxmlTextColorTable as object)).toHaveLength(colors + 2);
      expect(texts_.at(-1)!.compatibility!.unknown.cdxmlTextColorTable).toEqual({ [2 + ((texts - 1) % colors)]: expect.any(String) });
      // Stated linear bound: at most 1.3 MB of shared whole-table copies plus 10 characters of native JSON per source character.
      expect(chars).toBeLessThan(1_300_000 + 10 * source.length);
      // Colors are kept: each text's run takes its source color.
      expect(texts_[5].spans[0].style.color).toBe("#050080");
      return chars;
    });
    // Equal steps in texts add (about) equal bytes once the shared copies are spent: linear growth.
    const [a, b, c] = sizes;
    expect((c - b) / (b - a)).toBeGreaterThan(1.9);
    expect((c - b) / (b - a)).toBeLessThan(2.1);
  });

  it("saves a crafted file's source colors at their indices once, even after the budget runs out", () => {
    const source = crafted(4_000, 4_000);
    const opened = openChemDraftPayload(source);
    const saved = exportDocumentToCdxml(opened.document!, plain);
    const written = saved.contents.match(/<colortable>([\s\S]*?)<\/colortable>/)![1].match(/<color /g)!;
    // The source table (4,000 entries) is written once, not grown, plus the eight standard colors export
    // always appends when the source table lacks them; no color-table conflicts are reported.
    expect(written.length).toBe(4_008);
    expect(saved.warnings.map(w => w.code)).not.toContain("cdxml.text_color_table_conflict");
    // The last text (past the budget, storing only its own color) keeps its color index and color on reopen.
    const again = openChemDraftPayload(saved.contents);
    // Every text, before and past the budget, keeps its run color: the source indices were all restored.
    expect(textsOf(again).map(text => text.spans[0].style.color)).toEqual(textsOf(opened).map(text => text.spans[0].style.color));
  });

  it("cuts a color table past the 16-bit index limit to 65,534 colors, with one warning", () => {
    const source = `<CDXML><colortable>${"<color/>".repeat(70_000)}</colortable><page>` +
      `${Array.from({ length: 200 }, (_, i) => `<t id="${i + 10}" p="30 ${72 + i}"><s size="10" face="0" color="3">x</s></t>`).join("")}</page></CDXML>`;
    const { opened, chars } = nativeJsonChars(source);
    expect(opened.warnings.filter(w => w.code === "cdxml.color_table_truncated").map(w => w.message)).toEqual([
      "CDXML import: the color table lists 70000 colors, more than the 65534 supported (color indices are 16-bit); only the first 65534 were imported, and an object colored by a later index takes the default or inherited color."
    ]);
    const texts = textsOf(opened);
    expect(texts).toHaveLength(200);
    expect(Object.keys(texts[0].compatibility!.unknown.cdxmlTextColorTable as object)).toHaveLength(65_536);
    // One whole copy (65,536 entries), then the one color each later text uses: under 1.3 MB plus 2 KB per text.
    expect(storedColorEntries(texts)).toBe(65_536 + 199);
    expect(chars).toBeLessThan(1_300_000 + 200 * 2_000);
  });

  // A real-looking document (a ChemDraw-style 10-color table, a few colored texts and a colored
  // ellipse) keeps sharing whole copies, so its native state and its saved CDXML are unchanged.
  const realLooking = `<?xml version="1.0" encoding="UTF-8" ?>
<CDXML CreationProgram="ChemDraw 22.2.0.3300" BoundingBox="30 40 260 140"><colortable>
<color r="1" g="1" b="1"/><color r="0" g="0" b="0"/><color r="1" g="0" b="0"/><color r="1" g="1" b="0"/>
<color r="0" g="1" b="0"/><color r="0" g="1" b="1"/><color r="0" g="0" b="1"/><color r="1" g="0" b="1"/>
<color r="0.2" g="0.4" b="0.6"/><color r="0.5" g="0.25" b="0"/></colortable><fonttable>
<font id="3" charset="iso-8859-1" name="Arial"/><font id="4" charset="iso-8859-1" name="Times New Roman"/></fonttable>
<page id="1" BoundingBox="0 0 612 792">
<t id="2" p="30 40"><s font="3" size="10" face="0" color="4">Na</s><s font="4" size="10" face="1" color="10">Cl</s></t>
<t id="5" p="30 80" color="11"><s font="3" size="12" face="0">yield 92%</s></t>
<t id="6" p="30 120"><s font="3" size="10" face="0" color="3">H</s><s font="3" size="7.5" face="32" color="3">2</s><s font="3" size="10" face="0" color="3">O</s></t>
<graphic id="7" BoundingBox="200 60 260 120" GraphicType="Oval" OvalType="Circle" Center3D="230 90 0" MajorAxisEnd3D="260 90 0" MinorAxisEnd3D="230 120 0" color="10"/>
</page></CDXML>`;

  it("keeps a real-looking file's whole shared color tables and saves it the same way twice", () => {
    const opened = openChemDraftPayload(realLooking);
    expect(opened.warnings.map(w => w.code)).not.toContain("cdxml.color_table_truncated");
    const objects = opened.document!.pages[0].objects;
    const tables = objects.map(object => object.compatibility?.unknown.cdxmlTextColorTable ?? object.compatibility?.unknown.cdxmlGraphicColorTable)
      .filter(table => table !== undefined);
    expect(tables.length).toBe(4);
    // Every text and the ellipse store the whole table (indices 0 and 1 plus ten colors), as before.
    for (const table of tables) expect(Object.keys(table as object)).toHaveLength(12);
    expect(tables[0]).toEqual(Object.fromEntries([[0, "#000000"], [1, "#ffffff"], [2, "#ffffff"], [3, "#000000"], [4, "#ff0000"],
      [5, "#ffff00"], [6, "#00ff00"], [7, "#00ffff"], [8, "#0000ff"], [9, "#ff00ff"], [10, "#336699"], [11, "#804000"]]));
    const saved = exportDocumentToCdxml(opened.document!, plain);
    const written = saved.contents.match(/<colortable>([\s\S]*?)<\/colortable>/)![1].match(/<color [^>]*\/>/g);
    expect(written).toEqual(['<color r="1" g="1" b="1"/>', '<color r="0" g="0" b="0"/>', '<color r="1" g="0" b="0"/>',
      '<color r="1" g="1" b="0"/>', '<color r="0" g="1" b="0"/>', '<color r="0" g="1" b="1"/>', '<color r="0" g="0" b="1"/>',
      '<color r="1" g="0" b="1"/>', '<color r="0.2" g="0.4" b="0.6"/>', '<color r="0.502" g="0.251" b="0"/>']);
    expect(saved.contents).toContain('<s font="4" size="10" face="1" color="10">Cl</s>');
    // Round trip: reopening the saved file and saving again writes the same CDXML.
    const reopened = openChemDraftPayload(saved.contents);
    expect(exportDocumentToCdxml(reopened.document!, plain).contents).toBe(saved.contents);
    expect(textsOf(reopened).map(text => text.spans.map(span => span.style.color))).toEqual(textsOf(opened).map(text => text.spans.map(span => span.style.color)));
  });

  it("writes the same CDXML whether later objects store the whole table or only the colors they use", () => {
    // 7,000 texts over a 12-entry table spend the 65,536-entry budget at text 5,462; the rest store only their own colors.
    const body = Array.from({ length: 7_000 }, (_, i) => coloredText(i + 10, 2 + (i % 10), 72 + i)).join("");
    const source = realLooking.replace("</page>", `${body}</page>`);
    const opened = openChemDraftPayload(source);
    const texts = textsOf(opened);
    expect(Object.keys(texts.at(-1)!.compatibility!.unknown.cdxmlTextColorTable as object)).toHaveLength(1);
    const saved = exportDocumentToCdxml(opened.document!, plain).contents;
    // The previous behavior: every object stores the whole table.
    const whole = texts[0].compatibility!.unknown.cdxmlTextColorTable;
    for (const object of opened.document!.pages[0].objects) {
      const unknown = object.compatibility?.unknown;
      if (unknown?.cdxmlTextColorTable) unknown.cdxmlTextColorTable = { ...(whole as object) };
      if (unknown?.cdxmlGraphicColorTable) unknown.cdxmlGraphicColorTable = { ...(whole as object) };
    }
    expect(exportDocumentToCdxml(opened.document!, plain).contents).toBe(saved);
  });
});

describe("fonts stored in a saved native payload (#442)", () => {
  const longName = "N".repeat(1_000);
  const stored = Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), charset: "iso-8859-1", name: `Font${i + 1}` }));
  const documentWithStoredFonts = () => {
    const document = createEmptyDocument();
    const holder: TextObject = { type: "text", id: "holder", x: 10, y: 10, width: 40, height: 22, rotation: 0, text: "h", spans: [],
      style: {}, compatibility: { warnings: [], unknown: { cdxmlTextFontTable: [
        ...stored, { id: "7", charset: "iso-8859-1", name: longName }] } } };
    const caption: TextObject = { type: "text", id: "caption", x: 36, y: 80, width: 40, height: 22, rotation: 0, text: "New",
      style: { fontFamily: "Helvetica", fontSizePx: 16 }, spans: [{ text: "New", script: "normal", style: {} }],
      compatibility: { warnings: [], unknown: { sourceCdxmlAttributes: { p: "30 72", Justification: "Left" } } } };
    document.pages[0].objects = [holder, caption];
    return document;
  };
  const exportMessage = "CDXML export: font 7 has a name longer than 256 characters, or more than 512 characters of font attributes, far beyond any real font; " +
    "it was not written, and text set in it was written without its caption frame and run fonts, or in the default font.";
  const openMessage = "ChemDraft document: font 7 has a name longer than 256 characters, or more than 512 characters of font attributes, far beyond any real font; " +
    "it was dropped from the text font tables stored in this document, and saving to CDXML or CDX does not write it.";

  it("does not write a stored font whose name is too long, with one warning, and never reuses its id", () => {
    const saved = exportDocumentToCdxml(documentWithStoredFonts(), plain);
    expect(saved.warnings.filter(w => w.code === "cdxml.font_entry_too_long").map(w => w.message)).toEqual([exportMessage]);
    expect(saved.contents).not.toContain(longName.slice(0, 257));
    const fonts = [...saved.contents.matchAll(/<font id="(\d+)"[^>]*name="([^"]+)"/g)].map(match => [match[1], match[2]]);
    // Id 7 stays reserved (an unchanged source text may still name it); the new caption font takes the next free id.
    expect(fonts).toEqual([...stored.map(font => [font.id, font.name]), ["8", "Helvetica"]]);
  });

  it("drops a stored over-long font when an embedded native payload is opened, with one warning", () => {
    const saved = exportDocumentToCdxml(documentWithStoredFonts());
    const opened = openChemDraftPayload(saved.contents);
    expect(opened.source).toBe("native-payload");
    expect(opened.warnings.filter(w => w.code === "cdxml.font_entry_too_long").map(w => w.message)).toEqual([openMessage]);
    const holder = opened.document!.pages[0].objects[0] as TextObject;
    expect(holder.compatibility!.unknown.cdxmlTextFontTable).toEqual(stored);
    expect(JSON.stringify(opened.document)).not.toContain(longName.slice(0, 257));
    // Saving again writes no warning for it: the entry is gone.
    expect(exportDocumentToCdxml(opened.document!, plain).warnings.map(w => w.code)).not.toContain("cdxml.font_entry_too_long");
  });

  it("drops a stored over-long font when a native JSON document is opened, with one warning", () => {
    const opened = openChemDraftPayload(serializeDocument(documentWithStoredFonts()));
    expect(opened.source).toBe("legacy-json");
    expect(opened.warnings.filter(w => w.code === "cdxml.font_entry_too_long").map(w => w.message)).toEqual([openMessage]);
    const holder = opened.document!.pages[0].objects[0] as TextObject;
    expect(holder.compatibility!.unknown.cdxmlTextFontTable).toEqual(stored);
    // The text itself is untouched.
    expect(holder.text).toBe("h");
  });

  it("does not register a caption font whose name is too long on export", () => {
    const document = createEmptyDocument();
    const caption: TextObject = { type: "text", id: "caption", x: 36, y: 80, width: 40, height: 22, rotation: 0, text: "x",
      style: { fontFamily: longName, fontSizePx: 16 }, spans: [{ text: "x", script: "normal", style: {} }],
      compatibility: { warnings: [], unknown: { sourceCdxmlAttributes: { p: "30 72", Justification: "Left" } } } };
    document.pages[0].objects = [caption];
    const saved = exportDocumentToCdxml(document, plain);
    expect(saved.warnings.filter(w => w.code === "cdxml.font_entry_too_long").map(w => w.message)).toEqual([
      "CDXML export: the font of text caption has a name longer than 256 characters, or more than 512 characters of font attributes, far beyond any real font; " +
      "it was not written, and text set in it was written without its caption frame and run fonts, or in the default font."
    ]);
    expect(saved.contents).not.toContain(longName.slice(0, 257));
    expect(saved.warnings.map(w => w.code)).toContain("cdxml.text_format_native_only");
  });
});
