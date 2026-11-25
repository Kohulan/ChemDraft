const isDigit = (code: number) => code >= 0x30 && code <= 0x39;
const isLetter = (code: number) => (code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a;
const isSpace = (character: string | undefined) => character !== undefined && /\s/.test(character);

/**
 * An SVG length as `[sign]number[exponent] [unit]`, with white space around it allowed: the number
 * and its unit letters as written, or undefined when the text is not one. One forward pass with no
 * length cutoff, so a value of millions of digits costs linear time and a long valid one still reads.
 */
export function parseSvgLength(text: string): { value: number; unit: string } | undefined {
  let index = 0;
  while (isSpace(text[index])) index += 1;
  const start = index;
  if (text[index] === "+" || text[index] === "-") index += 1;
  const integerStart = index;
  while (isDigit(text.charCodeAt(index))) index += 1;
  let digits = index - integerStart;
  if (text[index] === ".") {
    const fractionStart = index + 1;
    index = fractionStart;
    while (isDigit(text.charCodeAt(index))) index += 1;
    digits += index - fractionStart;
  }
  if (!digits) return undefined;
  if (text[index] === "e" || text[index] === "E") {
    let exponent = index + 1;
    if (text[exponent] === "+" || text[exponent] === "-") exponent += 1;
    const exponentDigits = exponent;
    while (isDigit(text.charCodeAt(exponent))) exponent += 1;
    // Without digits the `e` begins the unit (`1em`), not an exponent.
    if (exponent > exponentDigits) index = exponent;
  }
  const value = Number(text.slice(start, index));
  while (isSpace(text[index])) index += 1;
  const unitStart = index;
  while (isLetter(text.charCodeAt(index))) index += 1;
  const unit = text.slice(unitStart, index);
  while (isSpace(text[index])) index += 1;
  return index === text.length ? { value, unit } : undefined;
}
