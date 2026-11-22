/**
 * Font-table indexes shared by CDXML import and export.
 *
 * Every font-table entry indexed or merged, and every lookup, is counted. Tests read the count to
 * prove that resolving caption fonts costs work linear in the font table plus the caption runs; a
 * wall-clock bound would flake on a loaded test runner. Resolve fonts only through these helpers
 * so the count stays honest.
 */
export type CdxmlFont = Record<string, string>;

let fontOperations = 0;

/** A key → font index; the first entry per key wins, as the linear searches it replaced did. */
export function indexCdxmlFonts<K>(fonts: Iterable<CdxmlFont>, key: (font: CdxmlFont) => K): Map<K, CdxmlFont> {
  const index = new Map<K, CdxmlFont>();
  for (const font of fonts) {
    fontOperations++;
    const value = key(font);
    if (!index.has(value)) index.set(value, font);
  }
  return index;
}

export function lookupCdxmlFont<K>(index: ReadonlyMap<K, CdxmlFont>, key: K): CdxmlFont | undefined {
  fontOperations++;
  return index.get(key);
}

/** Counts font-table entries visited outside an index (merging the per-text tables on export). */
export function countCdxmlFontEntries(count: number): void {
  fontOperations += count;
}

export function cdxmlFontOperationsForTesting(): number {
  return fontOperations;
}

export function resetCdxmlFontOperationsForTesting(): void {
  fontOperations = 0;
}
