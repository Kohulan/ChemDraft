import { describe, expect, it } from "vitest";
import { createEmptyDocument, serializeDocument, type TextObject } from "@chemdraft/chem-core";
import { exportDocumentToCdxml, openChemDraftPayload } from "./index";
import { defaultCdxmlLimits, withCdxmlLimitsForTesting } from "./cdxmlLimits";

// Codex security finding (#442), follow-up to the caption font-byte cap: every imported text and
// graphic stored its own copy of the file's whole color table (cdxmlTextColorTable /
// cdxmlGraphicColorTable), and the table had no size limit, so a crafted file of many colors and
// many texts saved (colors x texts) of native JSON on autosave. Sizes are measured in characters
// and entries, never timed.
//
// Fixtures are small: the copy budget is lowered from 65,536 to 2,048 entries (and the table cap
// from 65,534 to 100 colors where a test must cross it), so a few hundred texts exercise what
// thousands did at the production values, which are pinned below. Long synchronous loops over
// 8,000-text fixtures blocked the vitest worker on Windows CI ("Timeout calling onTaskUpdate").
const BUDGET = 2_048;
const lowBudget = <T>(run: () => T) => withCdxmlLimitsForTesting({ objectColorTableCopies: BUDGET }, run);

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
  it("pins the production color caps", () => {
    expect(defaultCdxmlLimits).toMatchObject({ colorTable: 65_534, objectColorTableCopies: 65_536 });
  });

  it("bounds the whole-table copies of a crafted file of many colors and many texts, so native JSON grows linearly", () => {
    // 200 colors: the 2,048-entry budget holds 10 whole copies, as 65,536 held 16 of a 4,000-color table.
    const colors = 200;
    const sizes = [250, 500, 1_000].map(texts => {
      const source = crafted(colors, texts);
      const { opened, chars } = lowBudget(() => nativeJsonChars(source));
      const texts_ = textsOf(opened);
      expect(texts_).toHaveLength(texts);
      // Without the budget every text stored all 202 entries (at production sizes, 8,000 texts held 32 million entries, ~580 MB of JSON).
      const entries = storedColorEntries(texts_);
      // Whole copies stop at the budget; every later text stores the one color its run uses.
      expect(entries).toBeLessThanOrEqual(BUDGET + colors + texts);
      // The first text still stores the whole table, so export can restore every source index.
      expect(Object.keys(texts_[0].compatibility!.unknown.cdxmlTextColorTable as object)).toHaveLength(colors + 2);
      expect(texts_.at(-1)!.compatibility!.unknown.cdxmlTextColorTable).toEqual({ [2 + ((texts - 1) % colors)]: expect.any(String) });
      // Stated linear bound: shared whole-table copies of at most 20 characters per budgeted entry
      // (1.3 MB at the production budget) plus 15 characters of native JSON per source character.
      // (At production sizes the bound was 10 per source character, but there the 4,000-color source
      // table itself added ~140 KB of source; with this 200-color table a one-run text costs about
      // 12 native characters per source character, so 15 is the same bound without that slack. Without
      // the budget, 1,000 texts store ~4.5 MB here, far past it.)
      expect(chars).toBeLessThan(20 * BUDGET + 15 * source.length);
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
    const source = crafted(200, 500);
    const opened = lowBudget(() => openChemDraftPayload(source));
    expect(Object.keys(textsOf(opened).at(-1)!.compatibility!.unknown.cdxmlTextColorTable as object)).toHaveLength(1);
    const saved = exportDocumentToCdxml(opened.document!, plain);
    const written = saved.contents.match(/<colortable>([\s\S]*?)<\/colortable>/)![1].match(/<color /g)!;
    // The source table (200 entries) is written once, not grown, plus the eight standard colors export
    // always appends when the source table lacks them; no color-table conflicts are reported.
    expect(written.length).toBe(208);
    expect(saved.warnings.map(w => w.code)).not.toContain("cdxml.text_color_table_conflict");
    // The last text (past the budget, storing only its own color) keeps its color index and color on reopen.
    const again = openChemDraftPayload(saved.contents);
    // Every text, before and past the budget, keeps its run color: the source indices were all restored.
    expect(textsOf(again).map(text => text.spans[0].style.color)).toEqual(textsOf(opened).map(text => text.spans[0].style.color));
  });

  // The cap (65,534 colors, from 16-bit indices) is lowered to 100, and the copy budget to 102 entries,
  // exactly one whole table, as 65,536 is at the production cap.
  it("cuts a color table past the 16-bit index limit to the cap, with one warning", () => {
    const source = `<CDXML><colortable>${"<color/>".repeat(110)}</colortable><page>` +
      `${Array.from({ length: 200 }, (_, i) => `<t id="${i + 10}" p="30 ${72 + i}"><s size="10" face="0" color="3">x</s></t>`).join("")}</page></CDXML>`;
    const { opened, chars } = withCdxmlLimitsForTesting({ colorTable: 100, objectColorTableCopies: 102 }, () => nativeJsonChars(source));
    expect(opened.warnings.filter(w => w.code === "cdxml.color_table_truncated").map(w => w.message)).toEqual([
      "CDXML import: the color table lists 110 colors, more than the 100 supported (color indices are 16-bit); only the first 100 were imported, and an object colored by a later index takes the default or inherited color."
    ]);
    const texts = textsOf(opened);
    expect(texts).toHaveLength(200);
    expect(Object.keys(texts[0].compatibility!.unknown.cdxmlTextColorTable as object)).toHaveLength(102);
    // One whole copy (102 entries), then the one color each later text uses: 20 characters per entry plus 2 KB per text.
    expect(storedColorEntries(texts)).toBe(102 + 199);
    expect(chars).toBeLessThan(20 * 102 + 200 * 2_000);
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
    // Within the budget the page stores no copy of its own (that is only for documents past it).
    expect(opened.document!.pages[0].compatibility!.unknown.cdxmlColorTable).toBeUndefined();
    expect(opened.document!.pages[0].compatibility!.unknown.cdxmlColorTableSize).toBeUndefined();
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
    // 300 texts over a 12-entry table spend the 2,048-entry budget at text 171 (at the production budget,
    // 7,000 texts spent it at text 5,462); the rest store only their own colors.
    const body = Array.from({ length: 300 }, (_, i) => coloredText(i + 10, 2 + (i % 10), 72 + i)).join("");
    const source = realLooking.replace("</page>", `${body}</page>`);
    const opened = lowBudget(() => openChemDraftPayload(source));
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

// Kimi (#442, P3): past the copy budget later objects store only the colors they use, so deleting
// the objects that held whole copies dropped the palette's unused entries on the next save, with no
// warning. In that case the first page now keeps one whole copy, and if that page is deleted too the
// save names the entries it no longer has.
describe("the source palette past the color copy budget (#442)", () => {
  const paletteText = (id: number, y: number) => coloredText(id, 2 + (id % 10), y);
  const page = (first: number, count: number) =>
    `<page>${Array.from({ length: count }, (_, i) => paletteText(first + i, 72 + i)).join("")}</page>`;
  // 200 colors, of which the texts use only indices 2..11; 2,048 entries hold 10 whole copies.
  const source = (pages: string) => `<CDXML><fonttable><font id="3" charset="iso-8859-1" name="Arial"/></fonttable>${colorTable(200)}${pages}</CDXML>`;
  const writtenTable = (contents: string) => contents.match(/<colortable>([\s\S]*?)<\/colortable>/)![1].match(/<color [^>]*\/>/g)!;
  const whole = (object: { compatibility?: { unknown: Record<string, unknown> } }) =>
    Object.keys((object.compatibility?.unknown.cdxmlTextColorTable ?? {}) as object).length > 1;

  it("keeps one whole copy on the first page, so deleting the whole-table holders keeps the palette", () => {
    const opened = lowBudget(() => openChemDraftPayload(source(page(10, 30))));
    const first = opened.document!.pages[0];
    expect(Object.keys(first.compatibility!.unknown.cdxmlColorTable as object)).toHaveLength(202);
    expect(first.compatibility!.unknown.cdxmlColorTableSize).toBe(200);
    const before = writtenTable(exportDocumentToCdxml(opened.document!, plain).contents);
    expect(before).toHaveLength(208);
    expect(first.objects.filter(whole)).toHaveLength(10);
    first.objects = first.objects.filter(object => !whole(object));
    const saved = exportDocumentToCdxml(opened.document!, plain);
    expect(writtenTable(saved.contents)).toEqual(before);
    expect(saved.warnings.map(w => w.code)).not.toContain("cdxml.color_table_entries_not_kept");
  });

  it("warns once, naming the entries, when the page that kept the whole table is deleted too", () => {
    const opened = lowBudget(() => openChemDraftPayload(source(page(10, 20) + page(30, 20))));
    const document = opened.document!;
    expect(document.pages[1].compatibility!.unknown.cdxmlColorTable).toBeUndefined();
    expect(document.pages[1].compatibility!.unknown.cdxmlColorTableSize).toBe(200);
    document.pages = document.pages.slice(1);
    const saved = exportDocumentToCdxml(document, plain);
    expect(saved.warnings.filter(w => w.code === "cdxml.color_table_entries_not_kept").map(w => w.message)).toEqual([
      "CDXML export: 190 of the 200 colors in the source file's color table (indices 12, 13, 14, 15, 16, 17, 18, 19, 20, 21 and 180 more) " +
      "are used by nothing left in the document, and the page that kept the whole table was deleted; they are not written, and the table holds black in their place where later colors follow."
    ]);
    // The colors still in use keep their indices and colors.
    expect(textsOf(openChemDraftPayload(saved.contents)).map(text => text.spans[0].style.color))
      .toEqual(document.pages[0].objects.map(object => (object as TextObject).spans[0].style.color));
  });
});

// Kimi (#442): export merged a full source table and then still appended the standard colors it
// lacked, and gave a newly used color the next index with no limit, so a valid 65,534-color file
// saved indices past 65535; reopening cut the table and those colors were lost silently. The table
// now stays within the cap: standard colors fill free entries only, and a color with no index left
// is written without its own color, with one warning naming it. The cap is lowered from 65,534 to
// 20 so the fixture stays small (the production value is pinned above).
describe("export color indices stay within the 16-bit table (#442)", () => {
  const cap = { colorTable: 20 };
  const full = `<CDXML><fonttable><font id="3" charset="iso-8859-1" name="Arial"/></fonttable>${colorTable(20)}<page>` +
    `${coloredText(10, 21, 72)}${coloredText(11, 2, 100)}</page></CDXML>`;
  const newText = (id: string, color: string, y: number): TextObject => ({ type: "text", id, x: 30, y, width: 40, height: 22,
    rotation: 0, text: id, spans: [], style: { color } });
  const indices = (contents: string) => [...contents.matchAll(/ color="(\d+)"/g)].map(match => Number(match[1]));
  const tableSize = (contents: string) => contents.match(/<colortable>([\s\S]*?)<\/colortable>/)![1].match(/<color /g)!.length;

  it("writes no index past the table limit, and warns once naming the colors that did not fit", () => withCdxmlLimitsForTesting(cap, () => {
    const opened = openChemDraftPayload(full);
    const document = opened.document!;
    const sourceColors = textsOf(opened).map(text => text.spans[0].style.color);
    document.pages[0].objects.push(newText("new1", "#123456", 140), newText("new2", "#654321", 180), newText("new3", "#123456", 220));
    const saved = exportDocumentToCdxml(document, plain);
    // The full source table is written as it was: no standard colors appended past it.
    expect(tableSize(saved.contents)).toBe(20);
    expect(Math.max(...indices(saved.contents))).toBe(21);
    expect(saved.warnings.filter(w => w.code === "cdxml.color_table_full").map(w => w.message)).toEqual([
      "CDXML export: the color table is full (20 colors, the most its 16-bit color indices allow); colors #123456, #654321 could not be added, " +
      "so text and objects in them are written without their own color and show the default or inherited color."
    ]);
    const again = openChemDraftPayload(saved.contents);
    expect(again.warnings.map(w => w.code)).not.toContain("cdxml.color_table_truncated");
    const texts = textsOf(again);
    // Source colors keep their indices; the new texts show the default color, as the warning says.
    expect(texts.slice(0, 2).map(text => text.spans[0].style.color)).toEqual(sourceColors);
    expect(texts.slice(2).map(text => text.style.color)).toEqual([undefined, undefined, undefined]);
    // With the embedded payload, ChemDraft keeps the colors, and the warning says so.
    const embedded = exportDocumentToCdxml(document);
    expect(embedded.warnings.find(w => w.code === "cdxml.color_table_full")?.message).toContain("(the embedded ChemDraft document keeps them)");
    const reopened = openChemDraftPayload(embedded.contents);
    expect(reopened.source).toBe("native-payload");
    expect(textsOf(reopened).slice(2).map(text => text.style.color)).toEqual(["#123456", "#654321", "#123456"]);
  }));

  it("fills free entries with new colors up to the limit, without a warning", () => withCdxmlLimitsForTesting(cap, () => {
    const source = full.replace(colorTable(20), colorTable(10)).replace('color="21"', 'color="11"');
    const opened = openChemDraftPayload(source);
    const document = opened.document!;
    document.pages[0].objects.push(newText("new1", "#123456", 140));
    const saved = exportDocumentToCdxml(document, plain);
    // 10 source colors, the 8 standard colors, then the new color: 19 entries, all below the cap.
    expect(tableSize(saved.contents)).toBe(19);
    expect(saved.warnings.map(w => w.code)).not.toContain("cdxml.color_table_full");
    expect(textsOf(openChemDraftPayload(saved.contents)).at(-1)!.style.color).toBe("#123456");
  }));
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
