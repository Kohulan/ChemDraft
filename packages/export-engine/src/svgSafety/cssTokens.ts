/**
 * One forward-only CSS tokenizer (CSS Syntax Level 3, §4) for untrusted SVG. The sanitizer validates
 * and writes out the same tokens, so what is checked is exactly what is kept: a comment-like run
 * inside a string or an unquoted url() is part of that token, as a browser reads it, and an escape
 * is decoded wherever it would be. Every step consumes input, so the work is linear in the text,
 * and the token count is checked before each token is made, so the memory is bounded too.
 */

/** Tokens one stylesheet or attribute value may make; past it the whole SVG is refused. */
export const MAX_CSS_TOKENS = 200_000;

/** Thrown when a text would make more than its token budget; nothing past the budget is allocated. */
export class CssTokenBudgetError extends Error {
  constructor(maxTokens: number) {
    super(`a style sheet or style attribute in the SVG has more than ${maxTokens.toLocaleString("en-US")} CSS tokens.`);
    this.name = "CssTokenBudgetError";
  }
}

export type CssTokenType =
  | "ws" | "comment" | "string" | "url" | "function" | "at-keyword" | "hash" | "ident" | "number" | "delim"
  | "(" | ")" | "[" | "]" | "{" | "}" | ";" | ":" | "," | "cdo" | "cdc";

export interface CssToken {
  type: CssTokenType;
  start: number;
  end: number;
  /**
   * Decoded, lower-cased name for ident, function (without the parenthesis), at-keyword (without
   * the `@`) and hash tokens; decoded value for string and url tokens.
   */
  value: string;
  /** A bad string or bad url, or a string, url or comment cut off by the end of the text. */
  bad?: boolean;
}

const isNewline = (code: number) => code === 0x0a || code === 0x0d || code === 0x0c;
const isWhitespace = (code: number) => code === 0x20 || code === 0x09 || isNewline(code);
const isDigit = (code: number) => code >= 0x30 && code <= 0x39;
const isHexDigit = (code: number) => isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
const isIdentStart = (code: number) => (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f || code >= 0x80;
const isIdent = (code: number) => isIdentStart(code) || isDigit(code) || code === 0x2d;
/** Non-printable code points end an unquoted url as a bad url. */
const isNonPrintable = (code: number) => (code >= 0 && code <= 0x08) || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f;

const SIMPLE: Readonly<Record<string, CssTokenType>> = {
  "(": "(", ")": ")", "[": "[", "]": "]", "{": "{", "}": "}", ";": ";", ":": ":", ",": ","
};

export function tokenizeCss(css: string, maxTokens = MAX_CSS_TOKENS): CssToken[] {
  const tokens: CssToken[] = [];
  const length = css.length;
  let index = 0;
  // NaN past the end, so every class test above is false there.
  const at = (offset: number) => (offset < length ? css.charCodeAt(offset) : Number.NaN);
  const validEscape = (offset: number) => at(offset) === 0x5c && !isNewline(at(offset + 1));
  const startsIdent = (offset: number) => {
    const first = at(offset);
    if (first === 0x2d) return isIdentStart(at(offset + 1)) || at(offset + 1) === 0x2d || validEscape(offset + 1);
    return isIdentStart(first) || validEscape(offset);
  };
  const startsNumber = (offset: number) => {
    const first = at(offset);
    if (first === 0x2b || first === 0x2d) return isDigit(at(offset + 1)) || (at(offset + 1) === 0x2e && isDigit(at(offset + 2)));
    if (first === 0x2e) return isDigit(at(offset + 1));
    return isDigit(first);
  };
  /** After a backslash: the escaped code point, as CSS decodes it. */
  const consumeEscape = (): string => {
    if (index >= length) return "�";
    if (isHexDigit(at(index))) {
      const from = index;
      while (index < length && index - from < 6 && isHexDigit(at(index))) index += 1;
      const code = Number.parseInt(css.slice(from, index), 16);
      if (at(index) === 0x0d && at(index + 1) === 0x0a) index += 2;
      else if (isWhitespace(at(index))) index += 1;
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "�" : String.fromCodePoint(code);
    }
    const code = css.codePointAt(index)!;
    index += code > 0xffff ? 2 : 1;
    return String.fromCodePoint(code);
  };
  const consumeIdentSequence = (): string => {
    let name = "";
    for (;;) {
      const code = at(index);
      if (isIdent(code)) {
        const from = index;
        while (isIdent(at(index))) index += 1;
        name += css.slice(from, index);
      } else if (validEscape(index)) {
        index += 1;
        name += consumeEscape();
      } else {
        return name;
      }
    }
  };
  const consumeString = (quote: number): { value: string; bad: boolean } => {
    let value = "";
    for (;;) {
      if (index >= length) return { value, bad: true };
      const code = at(index);
      if (code === quote) { index += 1; return { value, bad: false }; }
      // An unescaped newline ends a bad string; the newline is left for the next token.
      if (isNewline(code)) return { value, bad: true };
      if (code === 0x5c) {
        if (index + 1 >= length) { index += 1; continue; }
        if (isNewline(at(index + 1))) {
          index += at(index + 1) === 0x0d && at(index + 2) === 0x0a ? 3 : 2;
          continue;
        }
        index += 1;
        value += consumeEscape();
        continue;
      }
      const from = index;
      while (index < length && at(index) !== quote && at(index) !== 0x5c && !isNewline(at(index))) index += 1;
      value += css.slice(from, index);
    }
  };
  const consumeBadUrlRemnants = () => {
    while (index < length) {
      if (at(index) === 0x29) { index += 1; return; }
      if (validEscape(index)) { index += 1; consumeEscape(); continue; }
      index += 1;
    }
  };
  /** After `url(` and its leading whitespace, with no quote next. */
  const consumeUrl = (): { value: string; bad: boolean } => {
    let value = "";
    for (;;) {
      if (index >= length) return { value, bad: true };
      const code = at(index);
      if (code === 0x29) { index += 1; return { value, bad: false }; }
      if (isWhitespace(code)) {
        while (isWhitespace(at(index))) index += 1;
        if (index >= length) return { value, bad: true };
        if (at(index) === 0x29) { index += 1; return { value, bad: false }; }
        consumeBadUrlRemnants();
        return { value, bad: true };
      }
      if (code === 0x22 || code === 0x27 || code === 0x28 || isNonPrintable(code)) {
        consumeBadUrlRemnants();
        return { value, bad: true };
      }
      if (code === 0x5c) {
        if (!validEscape(index)) { consumeBadUrlRemnants(); return { value, bad: true }; }
        index += 1;
        value += consumeEscape();
        continue;
      }
      const from = index;
      while (index < length) {
        const next = at(index);
        if (next === 0x29 || next === 0x5c || next === 0x22 || next === 0x27 || next === 0x28 || isWhitespace(next) || isNonPrintable(next)) break;
        index += 1;
      }
      value += css.slice(from, index);
    }
  };
  const push = (type: CssTokenType, start: number, value = "", bad = false) => {
    if (tokens.length >= maxTokens) throw new CssTokenBudgetError(maxTokens);
    tokens.push(bad ? { type, start, end: index, value, bad } : { type, start, end: index, value });
  };

  while (index < length) {
    const start = index;
    const code = at(index);
    if (code === 0x2f && at(index + 1) === 0x2a) {
      const close = css.indexOf("*/", index + 2);
      index = close < 0 ? length : close + 2;
      push("comment", start, "", close < 0);
    } else if (isWhitespace(code)) {
      while (isWhitespace(at(index))) index += 1;
      push("ws", start);
    } else if (code === 0x22 || code === 0x27) {
      index += 1;
      const string = consumeString(code);
      push("string", start, string.value, string.bad);
    } else if (code === 0x23 && (isIdent(at(index + 1)) || validEscape(index + 1))) {
      index += 1;
      push("hash", start, consumeIdentSequence().toLowerCase());
    } else if (startsNumber(index)) {
      if (at(index) === 0x2b || at(index) === 0x2d) index += 1;
      while (isDigit(at(index))) index += 1;
      if (at(index) === 0x2e && isDigit(at(index + 1))) { index += 1; while (isDigit(at(index))) index += 1; }
      if ((at(index) === 0x45 || at(index) === 0x65) && (isDigit(at(index + 1)) ||
        ((at(index + 1) === 0x2b || at(index + 1) === 0x2d) && isDigit(at(index + 2))))) {
        index += 2;
        while (isDigit(at(index))) index += 1;
      }
      if (startsIdent(index)) consumeIdentSequence();
      else if (at(index) === 0x25) index += 1;
      push("number", start);
    } else if (code === 0x2d && at(index + 1) === 0x2d && at(index + 2) === 0x3e) {
      index += 3;
      push("cdc", start);
    } else if (code === 0x3c && css.startsWith("!--", index + 1)) {
      index += 4;
      push("cdo", start);
    } else if (code === 0x40 && startsIdent(index + 1)) {
      index += 1;
      push("at-keyword", start, consumeIdentSequence().toLowerCase());
    } else if (startsIdent(index)) {
      const name = consumeIdentSequence().toLowerCase();
      if (at(index) !== 0x28) {
        push("ident", start, name);
      } else if (name !== "url") {
        index += 1;
        push("function", start, name);
      } else {
        index += 1;
        const afterParen = index;
        while (isWhitespace(at(index))) index += 1;
        if (at(index) === 0x22 || at(index) === 0x27) {
          // `url("…")` is a function holding a string token, whitespace included.
          index = afterParen;
          push("function", start, name);
        } else {
          const url = consumeUrl();
          push("url", start, url.value, url.bad);
        }
      }
    } else {
      index += css.codePointAt(index)! > 0xffff ? 2 : 1;
      push(SIMPLE[css[start]!] ?? "delim", start, css.slice(start, index));
    }
  }
  return tokens;
}

/**
 * Where each block opened by a `(`, `[`, `{` or function token closes, as CSS pairs them: inside a
 * `(` block a `}` is an ordinary token. `close[i]` is the matching closer's index (-1 when the text
 * ends first); `stray` marks closers that close nothing.
 */
export function matchCssBlocks(tokens: readonly CssToken[]): { close: Int32Array; stray: Uint8Array } {
  const close = new Int32Array(tokens.length).fill(-1);
  const stray = new Uint8Array(tokens.length);
  const stack: number[] = [];
  const closerOf = (type: CssTokenType) => type === "[" ? "]" : type === "{" ? "}" : ")";
  for (let index = 0; index < tokens.length; index += 1) {
    const type = tokens[index]!.type;
    if (type === "(" || type === "[" || type === "{" || type === "function") stack.push(index);
    else if (type === ")" || type === "]" || type === "}") {
      const open = stack.at(-1);
      if (open !== undefined && closerOf(tokens[open]!.type) === type) {
        close[open] = index;
        stack.pop();
      } else {
        stray[index] = 1;
      }
    }
  }
  return { close, stray };
}
