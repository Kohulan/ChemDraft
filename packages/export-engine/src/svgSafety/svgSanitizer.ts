/**
 * The one SVG safety check, shared by the desktop drop path and the headless renderer. An SVG picture
 * is untrusted. It is parsed into an inert XML document (never a live DOM), kept to an allow-list of
 * drawing elements, stripped of script, embedded HTML, animation (SMIL and CSS), event handlers and
 * every external reference, and serialized again. The DOMParser and XMLSerializer are injected (the
 * webview's own, or jsdom's in Node), so the code is pure.
 *
 * Kept references: a `#fragment` naming an element of the same document (gradients, clip paths,
 * `<use href="#id">`), never on `<image>` or `<feImage>`, where a renderer could read it as a file
 * name; and, on those two only, base64 PNG, JPEG, GIF or WebP data. Never nested SVG data, never a
 * file, URL or `javascript:`, and never data in CSS, where only `url(#fragment)` is kept (quoted when
 * the id needs it). A reference is checked exactly as a URL parser reads it (only ASCII whitespace is
 * trimmed) and the checked value is what is written out. `<a>` stays, for selectors, but inert.
 *
 * An embedded bitmap must be what its label says (its magic bytes), and its header size must be
 * within the picture caps, all of them together within the decoded-size cap. One that is not makes
 * the whole SVG refused with the reason: dropping only the bitmap would change the drawing silently.
 * The admitted bitmaps are returned, so a caller with a decoder can prove each one decodes.
 *
 * CSS (`<style>`, `style` attributes, and the presentation attributes that can hold a reference) is
 * read by one tokenizer (`cssTokens.ts`) and written back from the same tokens, so what is checked is
 * what is kept. A declaration, rule or attribute that cannot be represented safely (a bad or
 * unterminated string, url, comment or block, a stray closer) is dropped. Element, attribute, CSS
 * text and CSS token counts are bounded before the work that depends on them.
 *
 * Two policies: the drop path removes what reaches outside the picture and says so; the headless
 * renderer (`outsideReferences: "refuse"`) refuses the picture instead, naming the reason, so a
 * document never draws differently from what its author saved without a warning.
 */

import { MAX_IMAGE_DECODED_BYTES } from "@chemdraft/chem-core";
import { CssTokenBudgetError, matchCssBlocks, tokenizeCss, type CssToken } from "./cssTokens";
import { readRasterHeaderSize, sniffBinaryImageFormat, type RasterHeaderFormat } from "./imageSniff";
import { pictureSizeLimitError } from "./pixelLimits";
import { parseSvgLength } from "./svgLength";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

export const MAX_SVG_SOURCE_CHARS = 20 * 1024 * 1024;
export const MAX_SVG_ELEMENTS = 200_000;
/** Elements, comments, CDATA sections and processing instructions together. */
export const MAX_SVG_NODES = 400_000;
export const MAX_SVG_ATTRIBUTES = 1_000_000;
export const MAX_SVG_DEPTH = 128;
/** All the text one SVG has read as CSS: style sheets, `style` and reference-bearing attributes. */
export const MAX_SVG_CSS_CHARS = 8 * 1024 * 1024;
/** All bitmaps embedded in one SVG together, decoded at four bytes a pixel. */
export const MAX_SVG_EMBEDDED_DECODED_BYTES = MAX_IMAGE_DECODED_BYTES;

const ALLOWED_ELEMENTS = new Set([
  "svg", "g", "a", "defs", "symbol", "use", "switch", "view", "title", "desc", "metadata", "style",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textPath",
  "image", "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask", "marker", "filter",
  "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting",
  "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG",
  "feFuncR", "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset",
  "fePointLight", "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence"
]);
/** Removing these can change behaviour, never a static drawing's appearance in an `<img>`. */
const ACTIVE_ELEMENTS = new Set([
  "script", "foreignObject", "iframe", "object", "embed", "audio", "video", "animate", "animateMotion",
  "animateTransform", "animateColor", "set", "discard", "handler", "listener", "mpath"
]);
/** Elements whose `href` loads a picture: only checked inline bitmap data, never a fragment. */
const PICTURE_ELEMENTS = new Set(["image", "feImage"]);
const KEPT_AT_RULE_BLOCKS = new Set(["media", "supports", "container", "layer"]);
/** CSS functions that load or construct a picture or resource, or read one from an attribute. */
const UNSAFE_CSS_FUNCTIONS = new Set([
  "image", "image-set", "-webkit-image-set", "cross-fade", "-webkit-cross-fade", "element", "-moz-element",
  "src", "expression", "paint", "attr", "-webkit-canvas"
]);
const UNSAFE_CSS_PROPERTIES = new Set(["behavior", "-moz-binding"]);
/** A vendor prefix (`-webkit-`, `-moz-`), which CSS animation names and properties may carry. */
const VENDOR_PREFIX = /^-[a-z0-9]+-/;
/**
 * CSS animation, removed like SMIL animation: a picture is drawn as its un-animated rules give it.
 * Names are decoded and lower-cased by the tokenizer, and checked without a vendor prefix. `offset-*`
 * stays: `offset-path` places an element even when nothing animates it.
 */
const isAnimationAtRule = (name: string) => name.replace(VENDOR_PREFIX, "") === "keyframes";
function isAnimationProperty(name: string): boolean {
  const bare = name.replace(VENDOR_PREFIX, "");
  return /^(animation|transition)(-|$)/.test(bare) || bare.startsWith("view-transition-")
    || /^(scroll|view)-timeline(-|$)/.test(bare) || bare === "timeline-scope";
}
/**
 * Presentation attributes whose value can hold a `url()` or another CSS reference. Only these (and
 * `style`) are read as CSS; any other attribute is plain text to a renderer and is kept as it is.
 */
const CSS_REFERENCE_ATTRIBUTES = new Set([
  "fill", "stroke", "clip-path", "mask", "filter", "marker", "marker-start", "marker-mid", "marker-end",
  "cursor", "color-profile"
]);
const DATA_MIME_FORMAT: Readonly<Record<string, RasterHeaderFormat>> = {
  "image/png": "png", "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/gif": "gif", "image/webp": "webp"
};
const FORMAT_MIME = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as const;
export const SVG_PICTURE_FORMAT_LABEL: Readonly<Record<string, string>> = {
  png: "PNG", jpeg: "JPEG", gif: "GIF", webp: "WebP", svg: "SVG", bmp: "BMP", tiff: "TIFF", ico: "icon",
  heic: "HEIC", avif: "AVIF", pdf: "PDF", svgz: "compressed SVG"
};
const OUTSIDE = "the SVG refers to a file or address outside the picture.";
const NESTED = "the SVG nests another SVG picture, which is not drawn.";
/** The headless renderer resolves neither of these, and would draw the picture wrong. */
const QUOTED_CSS_REFERENCE = "the SVG's style refers to an id that needs quoting, which the exporter cannot draw.";
const SPACED_REFERENCE = "the SVG refers to an id containing a space, which the exporter cannot draw.";

/** A bitmap the SVG embeds, admitted by its magic bytes and header size. */
export interface EmbeddedSvgBitmap {
  format: RasterHeaderFormat;
  mimeType: (typeof FORMAT_MIME)[RasterHeaderFormat];
  bytes: Uint8Array;
  /** From the header. */
  width: number;
  height: number;
}

export interface SanitizedSvg {
  svg: string;
  /** A link, stylesheet, font or picture outside the file was removed; what is shown may differ. */
  removedExternal: boolean;
  /** Script, embedded HTML, animation or event handlers were removed. */
  removedActive: boolean;
  /** Each distinct embedded bitmap once, in document order. */
  embeddedBitmaps: EmbeddedSvgBitmap[];
}
export type SvgSanitizeResult = ({ ok: true } & SanitizedSvg) | { ok: false; error: string };

export interface SvgSafetyOptions {
  /** Defaults to the global one; in Node pass jsdom's. */
  domParser?: Pick<DOMParser, "parseFromString">;
  xmlSerializer?: Pick<XMLSerializer, "serializeToString">;
  /**
   * A reference that would load something from outside the picture: removed with a note (the
   * default, for a drop), or the whole SVG refused with the reason (for a renderer drawing a saved
   * document). Links, scripts and unsupported elements are removed either way: none of them loads.
   */
  outsideReferences?: "remove" | "refuse";
}

/** The sanitizer's bookkeeping for one pass. Only the two flags are needed to call the CSS helpers. */
export interface SvgSanitizeState {
  removedExternal: boolean;
  removedActive: boolean;
  refuseOutside?: boolean;
  /** Decoded bytes of the bitmaps embedded so far. */
  embeddedDecodedBytes?: number;
  embedded?: Map<string, EmbeddedSvgBitmap>;
  /** Characters read as CSS so far. */
  cssChars?: number;
  /** Ids of the elements that survive, which a fragment must name. */
  ids?: ReadonlySet<string>;
  /** Why the whole SVG is refused. */
  error?: string;
}

/** Thrown inside one pass when a bound is exceeded; the pass returns the reason. */
class SvgRefusal extends Error {}

/**
 * What was removed: a reference that would load something (refused under the renderer's policy),
 * or anything else (a link, an unsupported element, CSS that cannot be kept).
 */
function noteRemoved(state: SvgSanitizeState, kind: "load" | "other", reason = OUTSIDE): void {
  state.removedExternal = true;
  if (kind === "load" && state.refuseOutside) state.error ??= reason;
}

const isAsciiSpace = (code: number) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
/**
 * A URL parser drops ASCII whitespace at either end, and only that (never NBSP and the like).
 * Scanned by hand: an end-anchored regex would be quadratic on a long run of spaces.
 */
function trimUrlSpace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isAsciiSpace(value.charCodeAt(start))) start += 1;
  while (end > start && isAsciiSpace(value.charCodeAt(end - 1))) end -= 1;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}
/** `#` and an id that can be written in an unquoted `url()`: no space, control, quote, parenthesis, angle bracket or backslash. */
const FRAGMENT = /^#[^\u0000- \u007f"'()<>\\]+$/;
/**
 * `#` and an id in a CSS `url()`, which can never load anything: any id without a control character,
 * written back quoted where an unquoted url could not hold it (`url("#atom(1)")`).
 */
const CSS_FRAGMENT = /^#[^\u0000-\u001f\u007f]+$/;
const isFragmentReference = (target: string) => CSS_FRAGMENT.test(target);

/** A checked CSS fragment as `url()` text: bare when it can be, else a quoted CSS string. */
const cssFragmentUrl = (target: string) => `url(${FRAGMENT.test(target) ? target : `"${target.replace(/["\\]/g, "\\$&")}"`})`;

/** {@link cssFragmentUrl}, noting under the `refuse` policy a fragment that has to be quoted. */
function checkedCssFragmentUrl(target: string, state: SvgSanitizeState | undefined): string {
  if (state?.refuseOutside && !FRAGMENT.test(target)) state.error ??= QUOTED_CSS_REFERENCE;
  return cssFragmentUrl(target);
}

/**
 * The id an XML `href="#…"` names in every renderer, or undefined when they may disagree. A URL parser
 * strips tabs and newlines anywhere, and browsers percent-decode the fragment before matching an id
 * while other renderers match it as written, so a fragment with either is ambiguous and is not kept.
 */
function xmlFragmentId(value: string): string | undefined {
  const id = value.slice(1);
  return id && !/[\t\n\r]|%[0-9a-f]{2}/i.test(id) ? id : undefined;
}

/** `data:image/<type>;base64,<payload>`, checked in one linear pass (no backtracking regex). */
function parseRasterDataUri(target: string): { format: RasterHeaderFormat; label: string; base64: string } | undefined {
  const match = /^data:(image\/[a-z]+);base64,/i.exec(target.slice(0, 40));
  const format = match && DATA_MIME_FORMAT[match[1]!.toLowerCase()];
  if (!match || !format) return undefined;
  const payload = target.slice(match[0].length);
  let padding = 0;
  let data = 0;
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c) continue;
    if (code === 0x3d) { padding += 1; continue; }
    const alphabet = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f;
    // Data after padding, or more than two padding characters, is not base64.
    if (!alphabet || padding > 0) return undefined;
    data += 1;
  }
  if (padding > 2 || (data + padding) % 4 === 1) return undefined;
  return { format, label: match[1]!.toLowerCase(), base64: payload };
}

function decodeBase64(base64: string): Uint8Array | undefined {
  try {
    const binary = atob(base64.replace(/[\t\n\f\r ]+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}

/** An embedded bitmap's own bytes against its label and the caps; the reason it is refused, if it is. */
function embeddedBitmapError(href: string, data: { format: RasterHeaderFormat; label: string; base64: string }, state: SvgSanitizeState): string | undefined {
  const known = state.embedded?.get(href);
  const bytes = known?.bytes ?? decodeBase64(data.base64);
  if (!bytes) return "an embedded picture's base64 data is damaged.";
  const actual = sniffBinaryImageFormat(bytes);
  if (actual !== data.format) {
    return `an embedded picture is labelled ${data.label} but its contents are ${actual ? SVG_PICTURE_FORMAT_LABEL[actual] : "not a picture"}.`;
  }
  const size = known ?? readRasterHeaderSize(data.format, bytes);
  if (!size) return `an embedded ${SVG_PICTURE_FORMAT_LABEL[data.format]} picture's header is damaged, so its size can't be read.`;
  const limit = pictureSizeLimitError(size.width, size.height);
  if (limit) return `an embedded picture ${limit.replace(/^it /, "")}`;
  // Every use is charged: a renderer may decode each one.
  const total = (state.embeddedDecodedBytes ?? 0) + size.width * size.height * 4;
  state.embeddedDecodedBytes = total;
  if (total > MAX_SVG_EMBEDDED_DECODED_BYTES) {
    return `its embedded pictures together decode to more than ${MAX_SVG_EMBEDDED_DECODED_BYTES / (1024 * 1024)} MiB.`;
  }
  if (!known) {
    state.embedded ??= new Map();
    state.embedded.set(href, { format: data.format, mimeType: FORMAT_MIME[data.format], bytes, width: size.width, height: size.height });
  }
  return undefined;
}

/**
 * The value to keep for an `href` on `element`, or undefined to remove it: a fragment naming a
 * surviving element (not on a picture element), or on a picture element checked bitmap data.
 */
function checkedHref(element: string, raw: string, state: SvgSanitizeState): string | undefined {
  const value = trimUrlSpace(raw);
  const picture = PICTURE_ELEMENTS.has(element);
  if (value.startsWith("#") && !picture) {
    // A same-document fragment loads nothing. One naming nothing, or not the same id in every
    // renderer, draws nothing either way: dropped without a note.
    const id = xmlFragmentId(value);
    if (id === undefined || !state.ids?.has(id)) return undefined;
    if (state.refuseOutside && id.includes(" ")) state.error ??= SPACED_REFERENCE;
    return value;
  }
  const data = picture ? parseRasterDataUri(value) : undefined;
  if (!data) {
    noteRemoved(state, "load", /^data:image\/svg\+xml[;,]/i.test(value) ? NESTED : OUTSIDE);
    return undefined;
  }
  const error = embeddedBitmapError(value, data, state);
  if (error) { state.error ??= error; return undefined; }
  return value;
}

/** Tokens with what tells them apart for the structure: block pairs and stray closers. */
interface CssText {
  css: string;
  tokens: CssToken[];
  close: Int32Array;
  stray: Uint8Array;
}

function readCss(css: string, state?: SvgSanitizeState): CssText {
  if (state) {
    state.cssChars = (state.cssChars ?? 0) + css.length;
    if (state.cssChars > MAX_SVG_CSS_CHARS) throw new SvgRefusal(`the SVG has more than ${MAX_SVG_CSS_CHARS / (1024 * 1024)} MiB of CSS.`);
  }
  const tokens = tokenizeCss(css);
  return { css, tokens, ...matchCssBlocks(tokens) };
}

const isBlank = (token: CssToken) => token.type === "ws" || token.type === "comment";
const IDENT_LIKE = ["ident", "function", "url"];

/**
 * Whether `next` written straight after `previous` would read back as different tokens (the CSS
 * Syntax serialization table, with number, percentage and dimension as one "number" here, plus
 * the `<!--` and `-->` markers). Where a comment between them is dropped, `/**\/` is kept instead.
 */
function wouldFuse(text: CssText, previous: CssToken, next: CssToken): boolean {
  const a = previous.type === "delim" ? previous.value : previous.type;
  const b = next.type === "delim" ? next.value : next.type;
  const is = (...kinds: string[]) => kinds.includes(b);
  switch (a) {
    case "ident":
      return is(...IDENT_LIKE, "-", "number", "cdc", "(") || (b === ">" && text.css[previous.end - 1] === "-");
    case "at-keyword": case "hash": return is(...IDENT_LIKE, "-", "number", "cdc");
    case "number": return is(...IDENT_LIKE, "-", "number", "cdc", "%");
    case "#": case "-": return is(...IDENT_LIKE, "-", "number");
    case "@": return is(...IDENT_LIKE, "-");
    case ".": case "+": return is("number");
    case "/": return is("*");
    case "<": return is("!");
    case "!": return text.css[next.start] === "-";
    default: return false;
  }
}

/**
 * Whether `token`'s source ends in a hex escape (`\61`), which would take a whitespace character
 * written straight after it as its own terminator rather than as a separator.
 */
function endsInHexEscape(text: CssText, token: CssToken): boolean {
  const { css } = text;
  let index = token.end;
  while (index > token.start && token.end - index < 7 && /[0-9a-fA-F]/.test(css[index - 1]!)) index -= 1;
  if (index === token.end || token.end - index > 6) return false;
  let backslashes = 0;
  while (index - backslashes > token.start && css[index - backslashes - 1] === "\\") backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * The kept text of tokens `[from, to)`, which have been checked: their source, without blanks at
 * either end, comments dropped (`/**\/` only where the tokens on both sides would otherwise fuse,
 * so `rect/**\/.x` stays one selector, or where a hex escape would take the blank after it) and
 * each `url()` written as its checked fragment. Under the `refuse` policy a fragment that must be
 * quoted refuses the picture: the headless renderer misses it.
 */
function cssSource(text: CssText, from: number, to: number, state?: SvgSanitizeState): string {
  const { tokens, close } = text;
  let out = "";
  let previous: CssToken | undefined;
  let space = "";
  let comment = false;
  for (let index = from; index < to; index += 1) {
    const token = tokens[index]!;
    if (token.type === "ws") { space += text.css.slice(token.start, token.end); continue; }
    if (token.type === "comment") { comment = true; continue; }
    if (previous) {
      // `.\61/**/ rect`: written without the comment, the escape would take the space as its own.
      if (comment && (space ? endsInHexEscape(text, previous) : wouldFuse(text, previous, token))) out += "/**/";
      out += space;
    }
    space = "";
    comment = false;
    if (token.type === "url") {
      out += checkedCssFragmentUrl(trimUrlSpace(token.value), state);
      previous = token;
    } else if (token.type === "function" && token.value === "url") {
      let inner = index + 1;
      while (isBlank(tokens[inner]!)) inner += 1;
      out += checkedCssFragmentUrl(trimUrlSpace(tokens[inner]!.value), state);
      index = close[index]!;
      previous = tokens[index]!;
    } else {
      out += text.css.slice(token.start, token.end);
      previous = token;
    }
  }
  return out;
}

type CssVerdict = "safe" | "loads" | "malformed";

/**
 * Whether tokens `[from, to)` are safe to keep as they are: nothing bad or unterminated, no stray
 * closer, no block (`{`) or at-rule ("malformed"), no url but `url(#fragment)` and no function that
 * loads ("loads").
 */
function cssComponentsVerdict(text: CssText, from: number, to: number): CssVerdict {
  const { tokens, close, stray } = text;
  let verdict: CssVerdict = "safe";
  for (let index = from; index < to; index += 1) {
    const token = tokens[index]!;
    // A bad url never loads: like any bad token it only makes the text unusable.
    if (token.bad || stray[index]) { verdict = "malformed"; continue; }
    switch (token.type) {
      case "{": case "}": case "at-keyword": case "cdo": case "cdc":
        if (verdict === "safe") verdict = "malformed";
        break;
      case "url":
        if (!isFragmentReference(trimUrlSpace(token.value))) return "loads";
        break;
      case "(": case "[":
        if (close[index]! < 0 || close[index]! >= to) return verdict === "safe" ? "malformed" : verdict;
        break;
      case "function": {
        if (UNSAFE_CSS_FUNCTIONS.has(token.value)) return "loads";
        if (close[index]! < 0 || close[index]! >= to) return verdict === "safe" ? "malformed" : verdict;
        if (token.value === "url") {
          // `url( "#id" )`: exactly one string, which must be a fragment.
          let inner = index + 1;
          while (isBlank(tokens[inner]!)) inner += 1;
          const target = tokens[inner]!;
          if (target.type !== "string" || target.bad || !isFragmentReference(trimUrlSpace(target.value))) return "loads";
          inner += 1;
          while (isBlank(tokens[inner]!)) inner += 1;
          if (inner !== close[index]) return "loads";
          index = inner;
        }
        break;
      }
      default:
        break;
    }
  }
  return verdict;
}

/** True when a CSS or presentation value reaches outside the file or cannot be kept safely. */
export function hasUnsafeCssReference(value: string): boolean {
  const text = readCss(value);
  return cssComponentsVerdict(text, 0, text.tokens.length) !== "safe";
}

/** Notes a dropped piece of CSS by its verdict. */
function noteCss(state: SvgSanitizeState, verdict: CssVerdict): void {
  noteRemoved(state, verdict === "loads" ? "load" : "other");
}

/** The next index in `[from, to)` whose token is `type` on this level (nested blocks skipped), or `to`. */
function nextOnLevel(text: CssText, from: number, to: number, types: ReadonlySet<string>): number {
  for (let index = from; index < to; index += 1) {
    const token = text.tokens[index]!;
    if (types.has(token.type)) return index;
    if (token.type === "(" || token.type === "[" || token.type === "{" || token.type === "function") {
      const closer = text.close[index]!;
      if (closer < 0) return to;
      index = closer;
    }
  }
  return to;
}

const SEMICOLON = new Set([";"]);
const BLOCK_OR_SEMICOLON = new Set(["{", ";"]);
const BLOCK = new Set(["{"]);

/** A declaration list (a rule's block or a `style` attribute), kept declaration by declaration. */
function sanitizeDeclarations(text: CssText, from: number, to: number, state: SvgSanitizeState): string {
  const kept: string[] = [];
  for (let start = from; start < to;) {
    const end = nextOnLevel(text, start, to, SEMICOLON);
    let name = start;
    while (name < end && isBlank(text.tokens[name]!)) name += 1;
    if (name < end) {
      let colon = name + 1;
      while (colon < end && isBlank(text.tokens[colon]!)) colon += 1;
      const property = text.tokens[name]!;
      const wellFormed = property.type === "ident" && !property.bad && colon < end && text.tokens[colon]!.type === ":";
      const verdict = wellFormed ? cssComponentsVerdict(text, colon + 1, end) : undefined;
      if (!wellFormed) {
        // A nested rule or at-rule, or text that is no declaration: dropped.
        if (property.type === "at-keyword" || nextOnLevel(text, name, end, BLOCK) < end) {
          noteCss(state, cssComponentsVerdict(text, name, end));
        }
      } else if (UNSAFE_CSS_PROPERTIES.has(property.value)) {
        noteRemoved(state, "load");
      } else if (isAnimationProperty(property.value)) {
        state.removedActive = true;
      } else if (verdict !== "safe") {
        noteCss(state, verdict!);
      } else {
        kept.push(cssSource(text, name, end, state));
      }
    }
    start = end + 1;
  }
  return kept.join(";");
}

/**
 * Whether an `@font-face` block (tokens `[from, to)`) names only installed fonts: every `src` is empty
 * or a list of `local()` faces, and nothing else in the block loads.
 */
function fontFaceLoadsNothing(text: CssText, from: number, to: number): boolean {
  const { tokens, close } = text;
  if (cssComponentsVerdict(text, from, to) === "loads") return false;
  for (let start = from; start < to;) {
    const end = nextOnLevel(text, start, to, SEMICOLON);
    let name = start;
    while (name < end && isBlank(tokens[name]!)) name += 1;
    if (name < end && tokens[name]!.type === "ident" && tokens[name]!.value === "src") {
      let colon = name + 1;
      while (colon < end && isBlank(tokens[colon]!)) colon += 1;
      if (colon >= end || tokens[colon]!.type !== ":") return false;
      for (let index = colon + 1; index < end; index += 1) {
        const token = tokens[index]!;
        if (isBlank(token) || token.type === ",") continue;
        if (token.type !== "function" || token.value !== "local" || close[index]! < 0 || close[index]! >= end) return false;
        index = close[index]!;
      }
    }
    start = end + 1;
  }
  return true;
}

/** A rule list (a stylesheet or a kept at-rule's block). */
function sanitizeRules(text: CssText, from: number, to: number, state: SvgSanitizeState, depth: number): string {
  const out: string[] = [];
  const { tokens, close } = text;
  for (let start = from; start < to;) {
    const first = tokens[start]!;
    if (isBlank(first) || first.type === "cdo" || first.type === "cdc") { start += 1; continue; }
    if (first.type === "at-keyword") {
      const stop = nextOnLevel(text, start + 1, to, BLOCK_OR_SEMICOLON);
      if (stop >= to || tokens[stop]!.type === ";") {
        // A statement at-rule (`@import`, `@charset`, `@namespace`, `@layer a;`), or one the text cuts off.
        noteRemoved(state, first.value === "import" ? "load" : "other");
        start = stop + 1;
        continue;
      }
      const closer = close[stop]!;
      if (closer < 0 || closer >= to) { noteRemoved(state, "other"); break; }
      const prelude = cssComponentsVerdict(text, start + 1, stop);
      if (isAnimationAtRule(first.value)) {
        state.removedActive = true;
      } else if (KEPT_AT_RULE_BLOCKS.has(first.value) && depth < 8 && prelude === "safe") {
        out.push(`${cssSource(text, start, stop, state)}{${sanitizeRules(text, stop + 1, closer, state, depth + 1)}}`);
      } else if (first.value === "font-face" && prelude !== "loads" && fontFaceLoadsNothing(text, stop + 1, closer)) {
        // Installed fonts only: nothing outside the picture is named. Dropped without a note.
      } else {
        // `@font-face` (which loads its `src`), `@page`, `@property` and the rest, or a prelude that loads.
        noteRemoved(state, first.value === "font-face" || prelude === "loads" ? "load" : "other");
      }
      start = closer + 1;
      continue;
    }
    // A qualified rule: its prelude runs to the block, as CSS reads it, `;` included.
    const open = nextOnLevel(text, start, to, BLOCK);
    if (open >= to) {
      // Stray text with no block. When the text cuts something off, what it held is gone.
      for (let index = start; index < to; index += 1) {
        const token = tokens[index]!;
        const opener = token.type === "(" || token.type === "[" || token.type === "function";
        if (token.bad || (opener && close[index]! < 0)) { noteRemoved(state, "other"); break; }
      }
      break;
    }
    const closer = close[open]!;
    if (closer < 0 || closer >= to) { noteRemoved(state, "other"); break; }
    const verdict = cssComponentsVerdict(text, start, open);
    if (verdict !== "safe") noteCss(state, verdict);
    else {
      const prelude = cssSource(text, start, open, state);
      if (prelude) out.push(`${prelude}{${sanitizeDeclarations(text, open + 1, closer, state)}}`);
    }
    start = closer + 1;
  }
  return out.join("\n");
}

export function sanitizeSvgStylesheet(css: string, state: SvgSanitizeState = { removedExternal: false, removedActive: false }): string {
  const text = readCss(css, state);
  const sanitized = sanitizeRules(text, 0, text.tokens.length, state, 0);
  // Defence in depth: the kept text must read back as itself; anything else is dropped whole.
  const again = readCss(sanitized);
  const check: SvgSanitizeState = { removedExternal: false, removedActive: false };
  if (sanitizeRules(again, 0, again.tokens.length, check, 0) !== sanitized || check.removedExternal) {
    noteRemoved(state, "load", "the SVG's style sheet could not be made safe to draw.");
    return "";
  }
  return sanitized;
}

/** A `style` attribute's declarations, kept one by one. */
export function sanitizeStyleAttribute(value: string, state: SvgSanitizeState): string {
  const text = readCss(value, state);
  return sanitizeDeclarations(text, 0, text.tokens.length, state);
}

/** A presentation attribute read as CSS: its checked text, or undefined when it cannot be kept. */
function sanitizePresentationValue(value: string, state: SvgSanitizeState): string | undefined {
  const text = readCss(value, state);
  const verdict = cssComponentsVerdict(text, 0, text.tokens.length);
  if (verdict === "safe") return cssSource(text, 0, text.tokens.length, state);
  noteCss(state, verdict);
  return undefined;
}

/**
 * Bound the work before building a DOM: elements, other markup nodes, attributes and nesting
 * depth. Every value is quoted in XML, so attributes are counted by their opening quotes.
 */
function scanBounds(source: string): string | undefined {
  let depth = 0;
  let elements = 0;
  let nodes = 0;
  let attributes = 0;
  const skipTo = (from: number, end: string) => {
    const index = source.indexOf(end, from);
    return index < 0 ? -1 : index + end.length;
  };
  for (let index = source.indexOf("<"); index >= 0 && index < source.length; index = source.indexOf("<", index)) {
    let next: number;
    if (source.startsWith("<!--", index)) next = skipTo(index + 4, "-->");
    else if (source.startsWith("<![CDATA[", index)) next = skipTo(index + 9, "]]>");
    else if (source.startsWith("<?", index)) next = skipTo(index + 2, "?>");
    else {
      let quote = "";
      let quoted = 0;
      let end = index + 1;
      for (; end < source.length; end += 1) {
        const character = source[end];
        if (quote) { if (character === quote) quote = ""; }
        else if (character === '"' || character === "'") { quote = character; quoted += 1; }
        else if (character === ">") break;
      }
      if (end >= source.length) return "the SVG is not well-formed XML.";
      if (source[index + 1] === "/") {
        // A closing tag ends a node already counted at its start tag.
        depth -= 1;
        index = end + 1;
        continue;
      }
      if (source[index + 1] !== "!") {
        elements += 1;
        attributes += quoted;
        if (source[end - 1] !== "/") depth += 1;
        if (elements > MAX_SVG_ELEMENTS) return `the SVG has more than ${MAX_SVG_ELEMENTS.toLocaleString("en-US")} elements.`;
        if (attributes > MAX_SVG_ATTRIBUTES) return `the SVG has more than ${MAX_SVG_ATTRIBUTES.toLocaleString("en-US")} attributes.`;
        if (depth > MAX_SVG_DEPTH) return `the SVG is nested more than ${MAX_SVG_DEPTH} levels deep.`;
      }
      next = end + 1;
    }
    if (next < 0) return "the SVG is not well-formed XML.";
    nodes += 1;
    if (nodes > MAX_SVG_NODES) return `the SVG has more than ${MAX_SVG_NODES.toLocaleString("en-US")} elements, comments and other markup nodes.`;
    index = next;
  }
  return undefined;
}

interface XmlTools {
  parser: Pick<DOMParser, "parseFromString">;
  serializer: Pick<XMLSerializer, "serializeToString">;
}

function xmlTools(options: SvgSafetyOptions): XmlTools {
  const parser = options.domParser ?? (typeof DOMParser === "function" ? new DOMParser() : undefined);
  const serializer = options.xmlSerializer ?? (typeof XMLSerializer === "function" ? new XMLSerializer() : undefined);
  if (!parser || !serializer) throw new Error("Checking an SVG picture needs a DOMParser and an XMLSerializer; none is available here.");
  return { parser, serializer };
}

const NOT_WELL_FORMED = "the SVG is not well-formed XML.";
const INTERNAL_SUBSET = "the SVG has a DOCTYPE with an internal subset, which is not allowed.";

const isDoctypeAt = (source: string, index: number) => source.slice(index, index + 9).toUpperCase() === "<!DOCTYPE";

/**
 * One forward pass over the prolog: whitespace, the XML declaration, comments, processing
 * instructions and at most one DOCTYPE, up to the root start tag. Returns the text without its
 * DOCTYPE, so no parser is ever handed an external identifier it might fetch, and where the root
 * start tag begins in that text; or the reason to refuse: an internal subset (which could declare
 * entities) or a second DOCTYPE (not well-formed). Nothing after the root start is read, so a
 * DOCTYPE in a comment, CDATA section or text of the body is only text, and every character is
 * visited once. It fails closed: anything else, such as a character this does not read as white
 * space, is refused here rather than left for a parser to read differently. XML 1.1 (which reads
 * U+0085 and U+2028 as line ends) is refused outright.
 */
function readProlog(source: string): { text: string; root: number } | string {
  let index = 0;
  let doctype: { start: number; end: number } | undefined;
  for (;;) {
    while (index < source.length && (isAsciiSpace(source.charCodeAt(index)) || source.charCodeAt(index) === 0xfeff)) index += 1;
    const close = source.startsWith("<?", index) ? "?>" : source.startsWith("<!--", index) ? "-->" : undefined;
    if (close) {
      const end = source.indexOf(close, index + (close === "?>" ? 2 : 4));
      if (end < 0) return NOT_WELL_FORMED;
      if (close === "?>") {
        const version = xmlDeclarationVersion(source.slice(index + 2, end));
        if (version === "") return NOT_WELL_FORMED;
        if (version !== undefined && version !== "1.0") return `the SVG is XML ${version}, which is not supported; save it as XML 1.0.`;
      }
      index = end + close.length;
      continue;
    }
    if (!isDoctypeAt(source, index)) break;
    if (doctype) return NOT_WELL_FORMED;
    let quote = "";
    let end = index + 9;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if (quote) { if (character === quote) quote = ""; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === "[") return INTERNAL_SUBSET;
      else if (character === ">") break;
    }
    if (end >= source.length) return NOT_WELL_FORMED;
    doctype = { start: index, end: end + 1 };
    index = end + 1;
  }
  if (source[index] !== "<" || !isNameStartAt(source, index + 1)) return NOT_WELL_FORMED;
  const read = doctype
    ? { text: source.slice(0, doctype.start) + source.slice(doctype.end), root: index - (doctype.end - doctype.start) }
    : { text: source, root: index };
  return hasMarkupDeclarationBefore(read.text, read.root) ? NOT_WELL_FORMED : read;
}

/**
 * The version an `<?xml ...?>` declaration (given without its `<?` and `?>`) names, empty when it
 * names none; undefined for any other processing instruction.
 */
function xmlDeclarationVersion(body: string): string | undefined {
  if (!/^xml(?:[\t\n\r ]|$)/i.test(body)) return undefined;
  return /\bversion[\t\n\r ]*=[\t\n\r ]*(["'])([^"']*)\1/.exec(body)?.[2] ?? "";
}

/** An XML NameStartChar at `index` (a supplementary-plane one is a high surrogate here). */
function isNameStartAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  const within = (low: number, high: number) => code >= low && code <= high;
  return code === 0x3a || code === 0x5f || within(0x41, 0x5a) || within(0x61, 0x7a) || within(0xc0, 0xd6)
    || within(0xd8, 0xf6) || within(0xf8, 0x2ff) || within(0x370, 0x37d) || within(0x37f, 0x1fff) || within(0x200c, 0x200d)
    || within(0x2070, 0x218f) || within(0x2c00, 0x2fef) || within(0x3001, 0xd7ff) || within(0xd800, 0xdb7f)
    || within(0xf900, 0xfdcf) || within(0xfdf0, 0xfffd);
}

/**
 * Belt and braces for `readProlog`: in the text a parser is handed, anything before the root other
 * than white space, comments and processing instructions (a DOCTYPE, an entity or a CDATA section)
 * means the prolog was misread, so the picture is refused.
 */
function hasMarkupDeclarationBefore(text: string, root: number): boolean {
  let index = 0;
  while (index < root) {
    const code = text.charCodeAt(index);
    if (isAsciiSpace(code) || code === 0xfeff) { index += 1; continue; }
    const close = text.startsWith("<!--", index) ? "-->" : text.startsWith("<?", index) ? "?>" : undefined;
    const end = close ? text.indexOf(close, index + (close === "?>" ? 2 : 4)) : -1;
    if (end < 0 || end >= root) return true;
    index = end + close!.length;
  }
  return index !== root;
}

/**
 * `text` with the SVG namespace on the root start tag at `root`: added, or written into an empty
 * default declaration (`xmlns=""`), which a second declaration would make not well-formed.
 * Undefined when the tag there is not a plain `<svg` start tag this can read.
 */
function withSvgNamespace(text: string, root: number): string | undefined {
  if (!text.startsWith("<svg", root) || !/^[\t\n\f\r />]$/.test(text[root + 4] ?? "")) return undefined;
  const skipSpace = (from: number) => {
    while (from < text.length && isAsciiSpace(text.charCodeAt(from))) from += 1;
    return from;
  };
  let index = root + 4;
  for (;;) {
    index = skipSpace(index);
    if (index >= text.length) return undefined;
    if (text[index] === ">" || text[index] === "/") break;
    const nameStart = index;
    while (index < text.length && !isAsciiSpace(text.charCodeAt(index)) && !"=/>".includes(text[index]!)) index += 1;
    const name = text.slice(nameStart, index);
    index = skipSpace(index);
    if (text[index] !== "=") return undefined;
    index = skipSpace(index + 1);
    const quote = text[index];
    if (quote !== '"' && quote !== "'") return undefined;
    const valueEnd = text.indexOf(quote, index + 1);
    if (valueEnd < 0) return undefined;
    if (name === "xmlns") return text.slice(0, index + 1) + SVG_NS + text.slice(valueEnd);
    index = valueEnd + 1;
  }
  return `${text.slice(0, root + 4)} xmlns="${SVG_NS}"${text.slice(root + 4)}`;
}

function parseSvg(source: string, xml: XmlTools): Document | string {
  const parsed = xml.parser.parseFromString(source, "image/svg+xml");
  if (parsed.getElementsByTagName("parsererror").length) return NOT_WELL_FORMED;
  return parsed;
}

function absoluteLengthPx(value: string | null): number | undefined {
  const length = parseSvgLength(value ?? "");
  if (!length) return undefined;
  const scale: Record<string, number> = { "": 1, px: 1, pt: 96 / 72, pc: 16, in: 96, mm: 96 / 25.4, cm: 96 / 2.54 };
  const result = length.value * (scale[length.unit.toLowerCase()] ?? NaN);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function sanitizeAttributes(element: Element, state: SvgSanitizeState): void {
  for (const attribute of Array.from(element.attributes)) {
    const { namespaceURI: namespace, localName: name, value } = attribute;
    let kept: string | undefined;
    if (namespace === XMLNS_NS) kept = value === SVG_NS || value === XLINK_NS ? value : undefined;
    else if (namespace === XML_NS) {
      kept = name === "space" || name === "lang" ? value : undefined;
      if (name === "base") noteRemoved(state, "load");
    } else if ((namespace === XLINK_NS || namespace === null) && name === "href") {
      kept = checkedHref(element.localName, value, state);
    } else if (namespace !== null) {
      // Editor data (Inkscape, Sodipodi, RDKit) and the like: no renderer draws it. A namespaced
      // `href` is still an attempt at a reference.
      if (name.toLowerCase() === "href") noteRemoved(state, "load");
    } else {
      const lower = name.toLowerCase();
      if (lower.startsWith("on")) state.removedActive = true;
      else if (!/^[A-Za-z_][\w.-]*$/.test(name) || lower === "src" || lower === "base" || lower === "href") {
        // Not a name any renderer reads (XML names are case-sensitive): dropped.
      } else if (lower === "style") {
        kept = sanitizeStyleAttribute(value, state) || undefined;
      } else if (CSS_REFERENCE_ATTRIBUTES.has(lower)) {
        kept = sanitizePresentationValue(value, state);
      } else {
        // Geometry, text, ids and the rest: no renderer reads them as CSS.
        kept = value;
      }
    }
    if (kept === undefined) element.removeAttributeNode(attribute);
    else if (kept !== value) attribute.value = kept;
  }
}

/**
 * What makes an `<a>` a link or focusable (in any namespace, so `xlink:href` too). Event handlers go
 * with every element's attributes, and namespaced XLink attributes (`xlink:show`) are dropped anyway.
 */
const LINK_ATTRIBUTES = new Set(["href", "target", "download", "ping", "rel", "referrerpolicy", "hreflang", "type", "tabindex", "autofocus"]);

/**
 * `<a>` stays an `<a>`, so style sheet selectors such as `a rect` still match, but inert: with no
 * href it is a plain group to every renderer. Its children, transform and class stay.
 */
function inertLinks(document: Document, state: SvgSanitizeState): void {
  for (const link of Array.from(document.getElementsByTagNameNS(SVG_NS, "a"))) {
    for (const attribute of Array.from(link.attributes)) {
      if (!LINK_ATTRIBUTES.has(attribute.localName.toLowerCase())) continue;
      if (attribute.localName === "href" || attribute.localName === "target") noteRemoved(state, "other");
      link.removeAttributeNode(attribute);
    }
  }
}

const isStylesheetInstruction = (node: Node) =>
  node.nodeType === 7 && (node as ProcessingInstruction).target.toLowerCase() === "xml-stylesheet";

/** Keep only allowed elements, text and CDATA; returns the surviving elements in document order. */
function pruneElements(root: Element, state: SvgSanitizeState): Element[] {
  const kept: Element[] = [];
  const pending: Element[] = [root];
  while (pending.length) {
    const element = pending.pop()!;
    kept.push(element);
    // A style sheet's content is replaced as a whole.
    if (element.localName === "style") continue;
    const children: Element[] = [];
    for (let child = element.firstChild; child;) {
      const next = child.nextSibling;
      if (child.nodeType === 1) {
        const childElement = child as Element;
        if (childElement.namespaceURI === SVG_NS && ALLOWED_ELEMENTS.has(childElement.localName)) children.push(childElement);
        else {
          if (childElement.namespaceURI === SVG_NS && ACTIVE_ELEMENTS.has(childElement.localName)) state.removedActive = true;
          else if (childElement.namespaceURI === SVG_NS || childElement.namespaceURI === "http://www.w3.org/1999/xhtml") noteRemoved(state, "other");
          child.remove();
        }
      } else if (child.nodeType !== 3 && child.nodeType !== 4) {
        if (isStylesheetInstruction(child)) noteRemoved(state, "load");
        child.remove();
      }
      child = next;
    }
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
  }
  return kept;
}

function sanitizeTree(document: Document, state: SvgSanitizeState): void {
  for (const node of Array.from(document.childNodes)) {
    if (node === document.documentElement) continue;
    if (isStylesheetInstruction(node)) noteRemoved(state, "load");
    node.remove();
  }
  inertLinks(document, state);
  const elements = pruneElements(document.documentElement, state);
  // Fragments must name an element that is still there.
  const ids = new Set<string>();
  for (const element of elements) {
    const id = element.getAttributeNS(null, "id");
    if (id) ids.add(id);
  }
  state.ids = ids;
  for (const element of elements) {
    sanitizeAttributes(element, state);
    if (state.error) return;
    if (element.localName !== "style") continue;
    const type = element.getAttribute("type");
    const css = element.textContent ?? "";
    while (element.firstChild) element.firstChild.remove();
    if (type && !/^\s*text\/css\s*$/i.test(type)) { noteRemoved(state, "other"); continue; }
    const cleaned = sanitizeSvgStylesheet(css, state);
    if (cleaned) element.append(cleaned.includes("]]>") ? document.createTextNode(cleaned) : document.createCDATASection(cleaned));
  }
  // A fixed width and height without a viewBox draws at one size; a viewBox lets it scale.
  const root = document.documentElement;
  if (!root.hasAttribute("viewBox")) {
    const width = absoluteLengthPx(root.getAttribute("width"));
    const height = absoluteLengthPx(root.getAttribute("height"));
    const format = (value: number) => String(Number(value.toFixed(4)));
    if (width && height) root.setAttribute("viewBox", `0 0 ${format(width)} ${format(height)}`);
  }
}

function sanitizeOnce(source: string, xml: XmlTools, refuseOutside: boolean): SvgSanitizeResult {
  if (source.length > MAX_SVG_SOURCE_CHARS) return { ok: false, error: "the SVG text is too large." };
  if (/<!ENTITY/i.test(source)) return { ok: false, error: "the SVG declares XML entities, which are not allowed." };
  const prolog = readProlog(source);
  if (typeof prolog === "string") return { ok: false, error: prolog };
  const bounds = scanBounds(source);
  if (bounds) return { ok: false, error: bounds };
  const { text, root: rootStart } = prolog;
  let parsed = parseSvg(text, xml);
  if (typeof parsed === "string") return { ok: false, error: parsed };
  // Hand-written SVG often omits its namespace; a picture viewer would not draw it at all.
  if (parsed.documentElement.namespaceURI === null && parsed.documentElement.nodeName === "svg") {
    const repaired = withSvgNamespace(text, rootStart);
    if (repaired === undefined) return { ok: false, error: NOT_WELL_FORMED };
    parsed = parseSvg(repaired, xml);
    if (typeof parsed === "string") return { ok: false, error: parsed };
  }
  const root = parsed.documentElement;
  if (root.namespaceURI !== SVG_NS || root.localName !== "svg") {
    return { ok: false, error: `the file is not an SVG document (its root element is <${root.nodeName}>).` };
  }
  const state: SvgSanitizeState = { removedExternal: false, removedActive: false, refuseOutside };
  try {
    sanitizeTree(parsed, state);
  } catch (error) {
    if (error instanceof SvgRefusal || error instanceof CssTokenBudgetError) return { ok: false, error: error.message };
    throw error;
  }
  if (state.error) return { ok: false, error: state.error };
  return {
    ok: true,
    svg: xml.serializer.serializeToString(root),
    removedExternal: state.removedExternal,
    removedActive: state.removedActive,
    embeddedBitmaps: [...(state.embedded?.values() ?? [])]
  };
}

/**
 * Sanitize, then sanitize the result again: the second pass must find nothing to remove, or the
 * picture is refused. A serializer or parser quirk can never let something through unexamined.
 */
export function sanitizeSvgPicture(source: string, options: SvgSafetyOptions = {}): SvgSanitizeResult {
  const xml = xmlTools(options);
  const refuse = options.outsideReferences === "refuse";
  const first = sanitizeOnce(source, xml, refuse);
  if (!first.ok) return first;
  const second = sanitizeOnce(first.svg, xml, refuse);
  if (!second.ok || second.removedActive || second.removedExternal || second.svg !== first.svg) {
    return { ok: false, error: "the SVG could not be made safe to embed." };
  }
  return first;
}
