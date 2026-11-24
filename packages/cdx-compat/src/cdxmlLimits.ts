/**
 * Import and export caps for CDXML/CDX, in one record. Production code only reads it. Tests that
 * must cross a cap lower it for the duration of one call (`withCdxmlLimitsForTesting`) instead of
 * building inputs of hundreds of thousands of elements: those long synchronous loops blocked the
 * vitest worker (Windows CI: "Timeout calling onTaskUpdate"). `defaultCdxmlLimits` is what
 * production uses, and tests pin those values too.
 */
export const cdxmlLimits = {
  /**
   * Import cap on the color table. CDX color indices are 16-bit and the table starts at index 2, so
   * nothing ChemDraw writes lists more than 65,534 colors, and export writes no index past 65535; a
   * crafted file that does is cut to the cap with one warning. Every entry is an index and a
   * normalized "#rrggbb" color, at most 18 characters of native JSON, so this also caps characters.
   */
  colorTable: 65_534,
  /**
   * Document-wide budget, in entries, for the whole color-table copies imported texts and graphics
   * store (cdxmlTextColorTable / cdxmlGraphicColorTable). Each such object used to store the whole
   * table, so a crafted file of many colors and many texts saved (colors x texts) of native JSON on
   * autosave. The first object always stores the whole table, and so does every later one while the
   * budget lasts (about 1.2 MB of native JSON at most); past it an object stores only the colors its
   * own attributes and runs refer to. Export merges every object's table by index, so the first
   * object still supplies the rest and the saved color table is unchanged. An ordinary document (8 to
   * a few dozen colors) shares whole copies across thousands of objects, as before.
   */
  objectColorTableCopies: 65_536,
  /**
   * Import caps for the font table and for one caption's runs. CDX font ids and styled-text run
   * offsets are 16-bit (export writes no font id at or above 65535), so nothing ChemDraw writes
   * exceeds these; a crafted file that does is cut to the cap with a warning rather than hanging the
   * import (AGENTS.md §13).
   */
  fontTable: 65_535,
  /** Font ids export may write are below this (CDX font ids are 16-bit; 65535 is reserved). */
  fontId: 65_535,
  /** Runs one caption may have for its frame and run fonts to be restored (see `fontTable`). */
  captionRuns: 65_535,
  /**
   * Document-wide cap on the caption runs whose fonts are resolved on import and on export (2^18).
   * The per-caption cap alone still let a crafted file stack thousands of capped captions. Real
   * documents stay far below it: the largest local CDXML documents (up to ~1 MB) hold under 1,000
   * styled runs in total, so this is over 250 times that and four maximal captions' worth. Captions
   * past it keep their text and run styles as plain styled text, with one warning.
   */
  documentCaptionRuns: 262_144,
  /**
   * Every imported caption carries the font table its runs were written against, so a later save
   * can rebuild the CDXML font table. Saving a copy of the whole table on every caption is
   * quadratic in a crafted file's size (1,000 captions over 1,000 fonts, 160 KB, saved as a 70 MB
   * payload), so after the first caption the whole table is shared only while the copies total at
   * most this many entries (2^14); later captions keep just the fonts their own runs name. Real
   * documents (at most a few fonts across a few hundred captions) stay far below it, so what they
   * save is unchanged.
   */
  textFontTableCopies: 16_384,
  /**
   * The same budget in characters (2^20), since entries differ in size: sharing stops at whichever
   * runs out first, so shared copies add at most ~1 MB to the native payload whatever the table
   * holds. An ordinary document (a few fonts of ~50 characters over a few hundred captions) uses
   * under a tenth of it.
   */
  textFontTableCopyChars: 1_048_576,
  /**
   * Document-wide budget, in characters (names and values, 2^20), for the copies of the root page
   * setup (Header, Footer, MacPrintInfo, WinPrintInfo, ...) imported pages store
   * (cdxmlRootPageAttributes). Every page used to store all of it, so a crafted file of many pages
   * and one long attribute saved (pages x length) of native JSON on autosave. The first page always
   * stores the whole set (export writes it from the first page), and so does every later page while
   * the budget lasts; past it a page keeps only the short attributes its page grid is checked
   * against (PrintMargins, WidthPages, HeightPages) and lists the names it left out. Real files
   * (a few KB of print info over a few pages) stay far below it, so what they save is unchanged.
   */
  rootPageAttributeCopyChars: 1_048_576,
};

export type CdxmlLimits = typeof cdxmlLimits;

/** The production values, for tests that pin them. */
export const defaultCdxmlLimits: Readonly<CdxmlLimits> = Object.freeze({ ...cdxmlLimits });

/** Runs `run` with some caps lowered (tests only); the production values are restored afterwards. */
export function withCdxmlLimitsForTesting<T>(overrides: Partial<CdxmlLimits>, run: () => T): T {
  const saved = { ...cdxmlLimits };
  Object.assign(cdxmlLimits, overrides);
  try {
    return run();
  } finally {
    Object.assign(cdxmlLimits, saved);
  }
}
