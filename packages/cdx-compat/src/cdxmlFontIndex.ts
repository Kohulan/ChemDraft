/**
 * Font-table indexes shared by CDXML import and export.
 *
 * Every font-table entry indexed or merged, and every lookup, is counted. Tests read the count to
 * prove that resolving caption fonts costs work linear in the font table plus the caption runs; a
 * wall-clock bound would flake on a loaded test runner. Resolve fonts only through these helpers
 * so the count stays honest, and wrap every font table in `trackCdxmlFontTable` so tests also
 * count its element reads.
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

/*
 * Helper calls alone would not catch a raw `table.find(...)` per caption run, which reads the font
 * table without calling a helper. So while a test tracks font tables, every font table import or
 * export builds (and every per-caption copy) is wrapped to count its element reads, and to throw
 * once a test's read budget is spent: a reintroduced per-run scan fails at once instead of running
 * for minutes. Outside tracking, tables are returned unwrapped.
 */
let tracking = false;
let tableReads = 0;
let tableReadLimit = Number.POSITIVE_INFINITY;

/** Returns `table`, wrapped to count element reads while a test tracks font tables. */
export function trackCdxmlFontTable<T extends readonly CdxmlFont[]>(table: T): T {
  if (!tracking) return table;
  return new Proxy(table, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(?:0|[1-9]\d*)$/.test(property) && ++tableReads > tableReadLimit) {
        throw new Error(`CDXML font table read ${tableReads} times, more than the ${tableReadLimit} allowed`);
      }
      return Reflect.get(target, property, receiver);
    }
  });
}

/** Starts counting font-table element reads (from zero), throwing past `limit` reads. */
export function startCdxmlFontTableTrackingForTesting(limit = Number.POSITIVE_INFINITY): void {
  tracking = true;
  tableReads = 0;
  tableReadLimit = limit;
}

/** Stops wrapping new tables and lifts the limit; returns the reads counted since the start. */
export function stopCdxmlFontTableTrackingForTesting(): number {
  tracking = false;
  tableReadLimit = Number.POSITIVE_INFINITY;
  return tableReads;
}
