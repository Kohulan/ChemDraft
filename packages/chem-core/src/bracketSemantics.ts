import type { BracketObject } from "./schemas";

const cdxmlNames = { sru: "SRU", multiple: "MultipleGroup" } as const;

function usageAttribute(record: unknown) {
  if (!record || typeof record !== "object" || !("attributes" in record)) return;
  const attrs = record.attributes;
  if (attrs && typeof attrs === "object" && "BracketUsage" in attrs && typeof attrs.BracketUsage === "string") return attrs.BracketUsage;
}

/** CDXML/CDX declare usage on the group, or on an attached glyph in older records. */
export function importedBracketUsage(glyphs: readonly BracketObject[], group?: unknown) {
  const cdxmlUsage = usageAttribute(group) ??
    glyphs.map(glyph => usageAttribute(glyph.compatibility?.unknown.bracketedGroup)).find(value => value !== undefined) ??
    glyphs.map(glyph => usageAttribute(glyph.compatibility?.unknown.cdxmlBracket)).find(Boolean);
  const usage = cdxmlUsage === undefined ? "generic" : cdxmlUsage === cdxmlNames.sru ? "sru" :
    cdxmlUsage === cdxmlNames.multiple ? "multiple" : "unknown";
  return { usage, cdxmlUsage } as const;
}

/** A legacy pair can have conflicting values. Resolve it in page order, including
 * the original name when native chemistry cannot interpret an imported usage. */
export function bracketUsageSemantics(pair: readonly BracketObject[]) {
  const usage = pair.find(object => object.bracketUsage && object.bracketUsage !== "generic")?.bracketUsage ??
    (pair.some(object => object.repeatUnit || object.bracketKind === "polymer") ? "sru" : "generic");
  const cdxmlUsage = usage === "unknown" ? importedBracketUsage(pair).cdxmlUsage ?? "Unspecified" :
    usage === "generic" ? undefined : cdxmlNames[usage];
  return { usage, cdxmlUsage };
}

export function bracketPairSemantics(pair: readonly BracketObject[]) {
  const closing = pair.find(object => object.side === "close")!;
  return { ...bracketUsageSemantics(pair), closing, label: closing.label ?? "n", count: pair.find(object => object.repeatCount !== undefined)?.repeatCount };
}
