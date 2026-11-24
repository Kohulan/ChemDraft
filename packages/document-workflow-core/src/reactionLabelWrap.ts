// A quantity and its unit never break apart ("0.25 M", "80 °C", "1.2 equiv"), nor does a
// multi-word unit ("5 mol %", "5 wt %"). The authored characters are kept: these words are only
// grouped for wrapping, never rewritten with a non-breaking space.
const unitWords = [
  "M", "mM", "µM", "μM", "nM", "N", "equiv", "eq", "mol", "mmol", "µmol", "μmol", "mol%", "wt%", "vol%", "%",
  "g", "mg", "µg", "μg", "kg", "L", "mL", "ml", "µL", "μL", "°C", "℃", "°F", "°", "K",
  "h", "hr", "hrs", "min", "s", "sec", "d", "atm", "bar", "mbar", "psi", "Torr", "torr", "Pa", "kPa", "MPa",
  "nm", "W", "kW", "V", "mA", "rpm", "ppm"
];
const escapeRegex = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Trailing punctuation still belongs to the unit: "12 h," and "(1.2 equiv.)".
const unitWord = new RegExp(`^(?:${unitWords.map(escapeRegex).join("|")})[.,;:)\\]]*$`, "u");
// A bare quantity, optionally signed, approximate, bracketed, or a range: "5", "−78", "~0.25", ".5", "(2–3".
const quantityNumber = String.raw`(?:\d+(?:[.,]\d+)?|\.\d+)`;
const quantityWord = new RegExp(`^[([~≈<>≤≥±+\\-−–]*${quantityNumber}(?:[–−\\-/]${quantityNumber})*$`, "u");
// The first word of a multi-word unit: "mol", "wt" and "vol" before "%".
const unitPrefixWords = new Set(["mol", "wt", "vol"]);

function joinedToNext(word: string, next: string): boolean {
  return (quantityWord.test(word) && (unitWord.test(next) || unitPrefixWords.has(next)))
    || (unitPrefixWords.has(word) && /^%[.,;:)\]]*$/u.test(next))
    || (word === "°" && /^[CF][.,;:)\]]*$/u.test(next));
}

const endsClause = (word: string) => /[,;:]$/u.test(word);
// What may follow an amount's closing parenthesis within its word: nothing, or punctuation ending the piece.
// A name character ("(R)-BINAP", "(+)-DET") makes the group a prefix of that name instead. A word's trailing
// punctuation run is found once per word, so each closing parenthesis checks it in constant time.
const trailingPunctuation = ".,;:)]";

export interface WrapPiece {
  /** The authored characters, with the trailing spaces/tabs that separate it from the next piece. */
  text: string;
  /** Conditions only: the piece ends in a comma outside every parenthesis, a preferred break. */
  commaBreak: boolean;
}

/** Breakable pieces of a line, each with its trailing spaces/tabs; joined words keep their authored spacing.
 * Captions break at every space or tab, as before quantity grouping existed. Conditions labels keep a quantity
 * with its unit and a matched parenthesised group whole, wherever it opens, and attach a group that is an amount
 * to the word before it when exactly one space separates them: "K2CO3 (2.0 equiv)". One linear pass. */
export function wrapPieces(line: string, conditions: boolean): WrapPiece[] {
  return scanPieces(line, conditions).pieces;
}

/** The scan behind `wrapPieces`, also reporting how many units of work it did (one per word, per character, and
 * per trailing-punctuation character), for the linearity test in `./testing`. */
export function scanPieces(line: string, conditions: boolean): { pieces: WrapPiece[]; steps: number } {
  let steps = 0;
  // Break only at spaces/tabs; NBSP and narrow NBSP stay inside indivisible tokens.
  const words = [...line.matchAll(/[^ \t]+[ \t]*/g)].map((match) => match[0]);
  if (!conditions) return { pieces: words.map((text) => ({ text, commaBreak: false })), steps: words.length };
  const bare = words.map((word) => word.replace(/[ \t]+$/, ""));
  // Match parentheses across the whole line. insideGroup[i] counts matched groups spanning the break after
  // word i; amountGroup[i] marks a word that opens a matched group at its first character which is an amount.
  const insideGroup = new Array<number>(words.length).fill(0);
  const amountGroup = new Array<boolean>(words.length).fill(false);
  const commaBreak = new Array<boolean>(words.length).fill(false);
  const open: Array<{ word: number; char: number }> = [];
  for (let index = 0; index < words.length; index++) {
    const word = bare[index]!;
    let trailStart = word.length;
    while (trailStart > 0 && trailingPunctuation.includes(word[trailStart - 1]!)) trailStart--;
    steps += 1 + (word.length - trailStart);
    for (let char = 0; char < word.length; char++) {
      steps++;
      if (word[char] === "(") open.push({ word: index, char });
      else if (word[char] === ")") {
        const opener = open.pop();
        if (!opener) continue; // A stray ")" closes nothing.
        insideGroup[opener.word]!++;
        insideGroup[index]!--;
        if (opener.char === 0 && char + 1 >= trailStart) amountGroup[opener.word] = true;
      }
    }
    // A comma inside any open parenthesis, matched or not, is never a preferred break.
    commaBreak[index] = open.length === 0 && word.endsWith(",");
  }
  const pieces: WrapPiece[] = [];
  let depth = 0;
  for (let index = 0; index < words.length; index++) {
    steps++;
    const last = pieces.at(-1);
    const joined = last !== undefined && (depth > 0
      || (amountGroup[index]! && /[^ \t] $/.test(words[index - 1]!) && !endsClause(bare[index - 1]!))
      || joinedToNext(bare[index - 1]!, bare[index]!));
    if (joined) last.text += words[index]!;
    else pieces.push({ text: words[index]!, commaBreak: false });
    pieces.at(-1)!.commaBreak = commaBreak[index]!;
    depth += insideGroup[index]!;
  }
  return { pieces, steps };
}

