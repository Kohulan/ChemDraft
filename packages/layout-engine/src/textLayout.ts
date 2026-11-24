import type { NativeTextStyle, TextSpan } from "@chemdraft/chem-core";
import { measureNativeTextSpanLineWidth } from "./textMetrics";

type Glyph = { text: string; span: TextSpan };
function runs(glyphs: readonly Glyph[]): TextSpan[] {
  const result: TextSpan[] = [];
  let previous: TextSpan | undefined;
  for (const glyph of glyphs) {
    if (previous === glyph.span) result[result.length - 1]!.text += glyph.text;
    else result.push({ ...glyph.span, text: glyph.text });
    previous = glyph.span;
  }
  return result;
}
const breakSpace = (text: string) => /\s/u.test(text) && text !== "\u00a0" && text !== "\u202f";

/** Deterministic wrapping using the current shared font/script metrics; never rewrites source text. */
export function nativeTextSpanLayout(spans: readonly TextSpan[], style: NativeTextStyle, contentWidth?: number):
  Array<{ spans: TextSpan[]; paragraphIndex: number }> {
  const paragraphs: Glyph[][] = [[]];
  let carriageReturn = false;
  for (const span of spans) for (const text of span.text) {
    if (text === "\r" || text === "\n") {
      if (!(text === "\n" && carriageReturn)) paragraphs.push([]);
      carriageReturn = text === "\r";
    } else {
      carriageReturn = false;
      paragraphs[paragraphs.length - 1]!.push({ span, text });
    }
  }
  const limit = contentWidth === undefined ? Infinity : Math.max(1, contentWidth);
  const measure = (glyphs: readonly Glyph[]) => measureNativeTextSpanLineWidth(runs(glyphs), style);
  const result: Array<{ spans: TextSpan[]; paragraphIndex: number }> = [];
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    let line: Glyph[] = [];
    const flush = () => { result.push({ spans: runs(line), paragraphIndex }); line = []; };
    if (limit === Infinity) { line = paragraph; flush(); continue; }
    for (let index = 0; index < paragraph.length;) {
      const whitespace = breakSpace(paragraph[index]!.text);
      let end = index + 1;
      while (end < paragraph.length && breakSpace(paragraph[end]!.text) === whitespace) end++;
      const token = paragraph.slice(index, end);
      if (!whitespace && line.length && measure([...line, ...token]) > limit) flush();
      if (measure([...line, ...token]) <= limit || (!whitespace && !line.length && measure(token) <= limit)) line.push(...token);
      else {
        let rest = token;
        if (whitespace && line.length) { line.push(token[0]!); flush(); rest = token.slice(1); }
        for (const glyph of rest) {
          if (line.length && measure([...line, glyph]) > limit) flush();
          line.push(glyph);
        }
      }
      index = end;
    }
    flush();
  }
  return result;
}
