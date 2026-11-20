import type { BracketObject } from "./schemas";

const cdxmlNames = { sru: "SRU", multiple: "MultipleGroup" } as const;

/** Classify the source name after interchange resolves the group and glyph declarations. */
export function importedBracketUsage(cdxmlUsage: string | undefined) {
  return cdxmlUsage === undefined ? "generic" : cdxmlUsage === cdxmlNames.sru ? "sru" :
    cdxmlUsage === cdxmlNames.multiple ? "multiple" : "unknown";
}

/** Resolve legacy native usage values in page order. */
export function bracketPairUsage(pair: readonly BracketObject[]): NonNullable<BracketObject["bracketUsage"]> {
  return pair.find(object => object.bracketUsage && object.bracketUsage !== "generic")?.bracketUsage ??
    (pair.some(object => object.repeatUnit || object.bracketKind === "polymer") ? "sru" : "generic");
}

export function bracketUsageSemantics(pair: readonly BracketObject[], sourceUsage?: string) {
  const usage = bracketPairUsage(pair);
  const cdxmlUsage = usage === "unknown" ? sourceUsage ?? "Unspecified" :
    usage === "generic" ? undefined : cdxmlNames[usage];
  return { usage, cdxmlUsage };
}

export function bracketPairSemantics(pair: readonly BracketObject[]) {
  const closing = pair.find(object => object.side === "close")!;
  return { ...bracketUsageSemantics(pair), closing, label: closing.label ?? "n", count: pair.find(object => object.repeatCount !== undefined)?.repeatCount };
}
