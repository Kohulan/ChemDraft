/**
 * Dropped SVG is untrusted. It is parsed into an inert XML document (never the app's DOM), kept to
 * an allow-list of drawing elements, stripped of script, embedded HTML, animation, event handlers and
 * every external reference, and serialized again. The result is what gets embedded; it is still only
 * ever shown through `<image href="data:image/svg+xml;base64,...">`.
 *
 * Kept references: same-document `#fragment` targets (gradients, clip paths, `<use href="#id">`) and,
 * for `<image>`/`<feImage>` `href` only, base64 PNG, JPEG, GIF or WebP data. Never nested SVG data,
 * never a file, URL or `javascript:`, and never data in CSS, where only `url(#fragment)` is kept.
 *
 * An embedded bitmap must be what its label says (its magic bytes), and its header size must be
 * within the picture caps, all of them together within the decoded-size cap. One that is not makes
 * the whole SVG refused with the reason: dropping only the bitmap would change the drawing silently.
 *
 * CSS (`<style>`, `style` attributes, and the presentation attributes that can hold a reference) is
 * read by one tokenizer (`cssTokens.ts`) and written back from the same tokens, so what is checked is
 * what is kept. A declaration, rule or attribute that cannot be represented safely (a bad or
 * unterminated string, url, comment or block, a stray closer) is dropped.
 */

import { MAX_IMAGE_DECODED_BYTES } from "@chemdraft/chem-core";
import { matchCssBlocks, tokenizeCss, type CssToken } from "./cssTokens";
import { readRasterHeaderSize, sniffBinaryImageFormat, type RasterHeaderFormat } from "./imageSniff";
import { dropPixelLimitError } from "./pixelLimits";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

export const MAX_SVG_SOURCE_CHARS = 20 * 1024 * 1024;
export const MAX_SVG_ELEMENTS = 200_000;
export const MAX_SVG_DEPTH = 128;
/** All bitmaps embedded in one SVG together, decoded at four bytes a pixel. */
export const MAX_SVG_EMBEDDED_DECODED_BYTES = MAX_IMAGE_DECODED_BYTES;

const ALLOWED_ELEMENTS = new Set([
  "svg", "g", "defs", "symbol", "use", "switch", "view", "title", "desc", "metadata", "style",
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
const KEPT_AT_RULE_BLOCKS = new Set(["media", "supports", "container", "layer", "keyframes", "-webkit-keyframes"]);
/** CSS functions that load or construct a picture or resource, or read one from an attribute. */
const UNSAFE_CSS_FUNCTIONS = new Set([
  "image", "image-set", "-webkit-image-set", "cross-fade", "-webkit-cross-fade", "element", "-moz-element",
  "src", "expression", "paint", "attr", "-webkit-canvas"
]);
const UNSAFE_CSS_PROPERTIES = new Set(["behavior", "-moz-binding"]);
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
const FORMAT_LABEL: Readonly<Record<string, string>> = {
  png: "PNG", jpeg: "JPEG", gif: "GIF", webp: "WebP", svg: "SVG", bmp: "BMP", tiff: "TIFF", ico: "icon",
  heic: "HEIC", avif: "AVIF", pdf: "PDF", svgz: "compressed SVG"
};

export interface SanitizedSvg {
  svg: string;
  /** A link, stylesheet, font or picture outside the file was removed; what is shown may differ. */
  removedExternal: boolean;
  /** Script, embedded HTML, animation or event handlers were removed. */
  removedActive: boolean;
}
export type SvgSanitizeResult = ({ ok: true } & SanitizedSvg) | { ok: false; error: string };

interface SanitizeState {
  removedExternal: boolean;
  removedActive: boolean;
  /** Decoded bytes of the bitmaps embedded so far. */
  embeddedDecodedBytes?: number;
  /** Why the whole SVG is refused. */
  error?: string;
}

const isFragmentReference = (target: string) => /^#[^\s"'()<>\\]*$/.test(target);

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
function embeddedBitmapError(data: { format: RasterHeaderFormat; label: string; base64: string }, state: SanitizeState): string | undefined {
  const bytes = decodeBase64(data.base64);
  if (!bytes) return "an embedded picture's base64 data is damaged.";
  const actual = sniffBinaryImageFormat(bytes);
  if (actual !== data.format) {
    return `an embedded picture is labelled ${data.label} but its contents are ${actual ? FORMAT_LABEL[actual] : "not a picture"}.`;
  }
  const size = readRasterHeaderSize(data.format, bytes);
  if (!size) return `an embedded ${FORMAT_LABEL[data.format]} picture's header is damaged, so its size can't be read.`;
  const limit = dropPixelLimitError(size.width, size.height);
  if (limit) return `an embedded picture ${limit.replace(/^it /, "")}`;
  const total = (state.embeddedDecodedBytes ?? 0) + size.width * size.height * 4;
  state.embeddedDecodedBytes = total;
  if (total > MAX_SVG_EMBEDDED_DECODED_BYTES) {
    return `its embedded pictures together decode to more than ${MAX_SVG_EMBEDDED_DECODED_BYTES / (1024 * 1024)} MiB.`;
  }
  return undefined;
}

/** A kept `href`: a fragment, or for a picture element base64 bitmap data that passes its checks. */
function safeHref(target: string, rasterAllowed: boolean, state: SanitizeState): boolean {
  if (isFragmentReference(target)) return true;
  const data = rasterAllowed ? parseRasterDataUri(target) : undefined;
  if (!data) return false;
  const error = embeddedBitmapError(data, state);
  if (error) state.error ??= error;
  return !error;
}

/** Tokens with what tells them apart for the structure: block pairs and stray closers. */
interface CssText {
  css: string;
  tokens: CssToken[];
  close: Int32Array;
  stray: Uint8Array;
}

function readCss(css: string): CssText {
  const tokens = tokenizeCss(css);
  return { css, tokens, ...matchCssBlocks(tokens) };
}

/** The kept text of tokens `[from, to)`: their source, a comment written as one space, trimmed. */
function cssSource(text: CssText, from: number, to: number): string {
  let out = "";
  for (let index = from; index < to; index += 1) {
    const token = text.tokens[index]!;
    out += token.type === "comment" ? " " : text.css.slice(token.start, token.end);
  }
  return out.trim();
}

const isBlank = (token: CssToken) => token.type === "ws" || token.type === "comment";

/**
 * Whether tokens `[from, to)` are safe to keep as they are: nothing bad or unterminated, no stray
 * closer, no block (`{`) or at-rule, no url but `url(#fragment)`, and no function that loads.
 */
function cssComponentsSafe(text: CssText, from: number, to: number): boolean {
  const { tokens, close, stray } = text;
  for (let index = from; index < to; index += 1) {
    const token = tokens[index]!;
    if (token.bad || stray[index]) return false;
    switch (token.type) {
      case "{": case "}": case "at-keyword": case "cdo": case "cdc":
        return false;
      case "url":
        if (!isFragmentReference(token.value.trim())) return false;
        break;
      case "(": case "[":
        if (close[index]! < 0 || close[index]! >= to) return false;
        break;
      case "function": {
        if (close[index]! < 0 || close[index]! >= to || UNSAFE_CSS_FUNCTIONS.has(token.value)) return false;
        if (token.value === "url") {
          // `url( "#id" )`: exactly one string, which must be a fragment.
          let inner = index + 1;
          while (isBlank(tokens[inner]!)) inner += 1;
          const target = tokens[inner]!;
          if (target.type !== "string" || target.bad || !isFragmentReference(target.value.trim())) return false;
          inner += 1;
          while (isBlank(tokens[inner]!)) inner += 1;
          if (inner !== close[index]) return false;
          index = inner;
        }
        break;
      }
      default:
        break;
    }
  }
  return true;
}

/** True when a CSS or presentation value reaches outside the file or cannot be kept safely. */
export function hasUnsafeCssReference(value: string): boolean {
  const text = readCss(value);
  return !cssComponentsSafe(text, 0, text.tokens.length);
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
function sanitizeDeclarations(text: CssText, from: number, to: number, state: SanitizeState): string {
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
      if (!wellFormed) {
        // A nested rule or at-rule, or text that is no declaration: dropped.
        if (property.type === "at-keyword" || nextOnLevel(text, name, end, BLOCK) < end) state.removedExternal = true;
      } else if (UNSAFE_CSS_PROPERTIES.has(property.value) || !cssComponentsSafe(text, colon + 1, end)) {
        state.removedExternal = true;
      } else {
        kept.push(cssSource(text, name, end));
      }
    }
    start = end + 1;
  }
  return kept.join(";");
}

/** A rule list (a stylesheet or a kept at-rule's block). */
function sanitizeRules(text: CssText, from: number, to: number, state: SanitizeState, depth: number): string {
  const out: string[] = [];
  const { tokens, close } = text;
  for (let start = from; start < to;) {
    const first = tokens[start]!;
    if (isBlank(first) || first.type === "cdo" || first.type === "cdc") { start += 1; continue; }
    if (first.type === "at-keyword") {
      const stop = nextOnLevel(text, start + 1, to, BLOCK_OR_SEMICOLON);
      if (stop >= to || tokens[stop]!.type === ";") {
        // A statement at-rule (`@import`, `@charset`, `@namespace`, `@layer a;`), or one the text cuts off.
        state.removedExternal = true;
        start = stop + 1;
        continue;
      }
      const closer = close[stop]!;
      if (closer < 0 || closer >= to) { state.removedExternal = true; break; }
      if (KEPT_AT_RULE_BLOCKS.has(first.value) && depth < 8 && cssComponentsSafe(text, start + 1, stop)) {
        out.push(`${cssSource(text, start, stop)}{${sanitizeRules(text, stop + 1, closer, state, depth + 1)}}`);
      } else {
        // `@font-face`, `@page`, `@property` and the rest, or a prelude that loads something.
        state.removedExternal = true;
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
        if (token.bad || (opener && close[index]! < 0)) { state.removedExternal = true; break; }
      }
      break;
    }
    const closer = close[open]!;
    if (closer < 0 || closer >= to) { state.removedExternal = true; break; }
    if (!cssComponentsSafe(text, start, open)) state.removedExternal = true;
    else {
      const prelude = cssSource(text, start, open);
      if (prelude) out.push(`${prelude}{${sanitizeDeclarations(text, open + 1, closer, state)}}`);
    }
    start = closer + 1;
  }
  return out.join("\n");
}

export function sanitizeSvgStylesheet(css: string, state: SanitizeState = { removedExternal: false, removedActive: false }): string {
  const text = readCss(css);
  const sanitized = sanitizeRules(text, 0, text.tokens.length, state, 0);
  // Defence in depth: the kept text must read back as itself; anything else is dropped whole.
  const again = readCss(sanitized);
  const check: SanitizeState = { removedExternal: false, removedActive: false };
  if (sanitizeRules(again, 0, again.tokens.length, check, 0) !== sanitized || check.removedExternal) {
    state.removedExternal = true;
    return "";
  }
  return sanitized;
}

/** A `style` attribute's declarations, kept one by one. */
export function sanitizeStyleAttribute(value: string, state: SanitizeState): string {
  const text = readCss(value);
  return sanitizeDeclarations(text, 0, text.tokens.length, state);
}

/** Bound the work before building a DOM: element count and nesting depth, outside markup sections. */
function scanBounds(source: string): string | undefined {
  let depth = 0;
  let elements = 0;
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
      let end = index + 1;
      for (; end < source.length; end += 1) {
        const character = source[end];
        if (quote) { if (character === quote) quote = ""; }
        else if (character === '"' || character === "'") quote = character;
        else if (character === ">") break;
      }
      if (end >= source.length) return "the SVG is not well-formed XML.";
      if (source[index + 1] === "/") depth -= 1;
      else if (source[index + 1] !== "!") {
        elements += 1;
        if (source[end - 1] !== "/") depth += 1;
        if (elements > MAX_SVG_ELEMENTS) return `the SVG has more than ${MAX_SVG_ELEMENTS.toLocaleString("en-US")} elements.`;
        if (depth > MAX_SVG_DEPTH) return `the SVG is nested more than ${MAX_SVG_DEPTH} levels deep.`;
      }
      next = end + 1;
    }
    if (next < 0) return "the SVG is not well-formed XML.";
    index = next;
  }
  return undefined;
}

function parseSvg(source: string): Document | string {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  if (parsed.getElementsByTagName("parsererror").length) return "the SVG is not well-formed XML.";
  return parsed;
}

function absoluteLengthPx(value: string | null): number | undefined {
  const match = value?.trim().match(/^([+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|pt|pc|in|mm|cm)?$/i);
  if (!match) return undefined;
  const scale: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, in: 96, mm: 96 / 25.4, cm: 96 / 2.54 };
  const result = Number(match[1]) * scale[(match[2] ?? "px").toLowerCase()]!;
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function sanitizeAttributes(element: Element, state: SanitizeState): void {
  const rasterAllowed = element.localName === "image" || element.localName === "feImage";
  for (const attribute of Array.from(element.attributes)) {
    const { namespaceURI: namespace, localName: name, value } = attribute;
    let keep: boolean;
    if (namespace === XMLNS_NS) keep = value === SVG_NS || value === XLINK_NS;
    else if (namespace === XML_NS) {
      keep = name === "space" || name === "lang";
      if (name === "base") state.removedExternal = true;
    }
    else if (namespace === XLINK_NS) {
      keep = name === "href" && safeHref(value.trim(), rasterAllowed, state);
      if (!keep && name === "href") state.removedExternal = true;
    } else if (namespace !== null) keep = false;
    else {
      const lower = name.toLowerCase();
      if (lower.startsWith("on")) { keep = false; state.removedActive = true; }
      else if (!/^[A-Za-z_][\w.-]*$/.test(name) || lower === "src" || lower === "base") keep = false;
      else if (lower === "href") {
        keep = name === "href" && safeHref(value.trim(), rasterAllowed, state);
        if (!keep) state.removedExternal = true;
      } else if (lower === "style") {
        const cleaned = sanitizeStyleAttribute(value, state);
        if (cleaned) {
          if (cleaned !== value) element.setAttribute("style", cleaned);
          continue;
        }
        keep = false;
      } else if (CSS_REFERENCE_ATTRIBUTES.has(lower)) {
        keep = !hasUnsafeCssReference(value);
        if (!keep) state.removedExternal = true;
      } else {
        // Geometry, text, ids and the rest: no renderer reads them as CSS.
        keep = true;
      }
    }
    if (!keep) element.removeAttributeNode(attribute);
  }
}

/** `<a>` becomes `<g>`: its children and transform stay, its link goes. */
function linksToGroups(document: Document, state: SanitizeState): void {
  for (const link of Array.from(document.getElementsByTagNameNS(SVG_NS, "a"))) {
    const group = document.createElementNS(SVG_NS, "g");
    for (const attribute of Array.from(link.attributes)) {
      if (attribute.localName === "href" || attribute.localName === "target") { state.removedExternal = true; continue; }
      if (attribute.namespaceURI === null) group.setAttribute(attribute.name, attribute.value);
    }
    while (link.firstChild) group.append(link.firstChild);
    link.replaceWith(group);
  }
}

function sanitizeTree(document: Document, state: SanitizeState): void {
  for (const node of Array.from(document.childNodes)) {
    if (node === document.documentElement) continue;
    if (node.nodeType === 7 && (node as ProcessingInstruction).target.toLowerCase() === "xml-stylesheet") state.removedExternal = true;
    node.remove();
  }
  linksToGroups(document, state);
  const pending: Element[] = [document.documentElement];
  while (pending.length) {
    const element = pending.pop()!;
    sanitizeAttributes(element, state);
    if (element.localName === "style") {
      const type = element.getAttribute("type");
      const css = element.textContent ?? "";
      while (element.firstChild) element.firstChild.remove();
      if (type && !/^\s*text\/css\s*$/i.test(type)) { state.removedExternal = true; continue; }
      const cleaned = sanitizeSvgStylesheet(css, state);
      if (cleaned) element.append(cleaned.includes("]]>") ? document.createTextNode(cleaned) : document.createCDATASection(cleaned));
      continue;
    }
    for (let child = element.firstChild; child;) {
      const next = child.nextSibling;
      if (child.nodeType === 1) {
        const childElement = child as Element;
        if (childElement.namespaceURI === SVG_NS && ALLOWED_ELEMENTS.has(childElement.localName)) pending.push(childElement);
        else {
          if (childElement.namespaceURI === SVG_NS && ACTIVE_ELEMENTS.has(childElement.localName)) state.removedActive = true;
          else if (childElement.namespaceURI === SVG_NS || childElement.namespaceURI === "http://www.w3.org/1999/xhtml") state.removedExternal = true;
          child.remove();
        }
      } else if (child.nodeType !== 3 && child.nodeType !== 4) {
        if (child.nodeType === 7 && (child as ProcessingInstruction).target.toLowerCase() === "xml-stylesheet") state.removedExternal = true;
        child.remove();
      }
      child = next;
    }
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

function sanitizeOnce(source: string): SvgSanitizeResult {
  if (source.length > MAX_SVG_SOURCE_CHARS) return { ok: false, error: "the SVG text is too large." };
  if (/<!ENTITY/i.test(source)) return { ok: false, error: "the SVG declares XML entities, which are not allowed." };
  if (/<!DOCTYPE(?:[^>"'[]|"[^"]*"|'[^']*')*\[/i.test(source)) {
    return { ok: false, error: "the SVG has a DOCTYPE with an internal subset, which is not allowed." };
  }
  const bounds = scanBounds(source);
  if (bounds) return { ok: false, error: bounds };
  let parsed = parseSvg(source);
  if (typeof parsed === "string") return { ok: false, error: parsed };
  // Hand-written SVG often omits its namespace; a picture viewer would not draw it at all.
  if (parsed.documentElement.namespaceURI === null && parsed.documentElement.nodeName === "svg") {
    parsed = parseSvg(source.replace(/<svg(?=[\s/>])/, `<svg xmlns="${SVG_NS}"`));
    if (typeof parsed === "string") return { ok: false, error: parsed };
  }
  const root = parsed.documentElement;
  if (root.namespaceURI !== SVG_NS || root.localName !== "svg") {
    return { ok: false, error: `the file is not an SVG document (its root element is <${root.nodeName}>).` };
  }
  const state: SanitizeState = { removedExternal: false, removedActive: false };
  sanitizeTree(parsed, state);
  if (state.error) return { ok: false, error: state.error };
  return { ok: true, svg: new XMLSerializer().serializeToString(root), removedExternal: state.removedExternal, removedActive: state.removedActive };
}

/**
 * Sanitize, then sanitize the result again: the second pass must find nothing to remove, or the
 * picture is refused. A serializer or parser quirk can never let something through unexamined.
 */
export function sanitizeDroppedSvg(source: string): SvgSanitizeResult {
  const first = sanitizeOnce(source);
  if (!first.ok) return first;
  const second = sanitizeOnce(first.svg);
  if (!second.ok || second.removedActive || second.removedExternal || second.svg !== first.svg) {
    return { ok: false, error: "the SVG could not be made safe to embed." };
  }
  return first;
}
