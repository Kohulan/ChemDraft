/**
 * Dropped SVG is untrusted. It is parsed into an inert XML document (never the app's DOM), kept to
 * an allow-list of drawing elements, stripped of script, embedded HTML, animation, event handlers and
 * every external reference, and serialized again. The result is what gets embedded; it is still only
 * ever shown through `<image href="data:image/svg+xml;base64,...">`.
 *
 * Kept references: same-document `#fragment` targets (gradients, clip paths, `<use href="#id">`) and,
 * for `<image>`/`<feImage>`, base64 PNG, JPEG, GIF or WebP data. Never nested SVG data, never a file,
 * URL or `javascript:`.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

export const MAX_SVG_SOURCE_CHARS = 20 * 1024 * 1024;
export const MAX_SVG_ELEMENTS = 200_000;
export const MAX_SVG_DEPTH = 128;

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
const UNSAFE_CSS_FUNCTIONS = new Set([
  "image", "image-set", "-webkit-image-set", "cross-fade", "-webkit-cross-fade", "element", "-moz-element",
  "src", "expression", "paint"
]);
const RASTER_DATA_URI = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/\s]*={0,2}\s*$/i;

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
}

/** Comments out, CSS escapes decoded, lower case: the form every reference check reads. */
export function normalizeCssForCheck(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "")
    .replace(/\\(?:([0-9a-f]{1,6})[ \t\r\n\f]?|\r\n|([\s\S]))/gi, (_match, hex: string | undefined, character: string | undefined) => {
      if (hex) {
        const code = Number.parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "�";
      }
      return character === "\n" || character === "\r" || character === "\f" || character === undefined ? "" : character;
    })
    .toLowerCase();
}

function urlArgument(text: string, from: number): string {
  let index = from;
  while (/\s/.test(text[index] ?? "")) index += 1;
  const quote = text[index];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, index + 1);
    return text.slice(index + 1, end < 0 ? undefined : end).trim();
  }
  const end = text.indexOf(")", index);
  return text.slice(index, end < 0 ? undefined : end).trim();
}

function safeReference(target: string, rasterAllowed: boolean): boolean {
  return /^#[^\s"'()<>\\]*$/.test(target) || (rasterAllowed && RASTER_DATA_URI.test(target));
}

/** True when a CSS or presentation value reaches outside the file. */
export function hasUnsafeCssReference(value: string): boolean {
  const normalized = normalizeCssForCheck(value);
  if (/@import|javascript:|vbscript:|-moz-binding|behavior\s*:/.test(normalized)) return true;
  for (const match of normalized.matchAll(/([a-z0-9_-]+)\s*\(/g)) {
    const name = match[1]!;
    if (UNSAFE_CSS_FUNCTIONS.has(name)) return true;
    if (name === "url" && !safeReference(urlArgument(normalized, match.index! + match[0].length), true)) return true;
  }
  return false;
}

/** Copy CSS without comments, keeping strings intact. */
function stripCssComments(css: string): string {
  let out = "";
  for (let index = 0; index < css.length;) {
    const character = css[index]!;
    if (character === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      index = end < 0 ? css.length : end + 2;
      out += " ";
      continue;
    }
    if (character === '"' || character === "'") {
      const start = index;
      for (index += 1; index < css.length && css[index] !== character; index += css[index] === "\\" ? 2 : 1);
      out += css.slice(start, index + 1);
      index += 1;
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

/** Split at `stop` characters on the top level, outside strings, parentheses and blocks. */
function scanCss(css: string, onStop: (character: string, index: number) => boolean | void): void {
  let parens = 0;
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index]!;
    if (character === '"' || character === "'") {
      for (index += 1; index < css.length && css[index] !== character; index += css[index] === "\\" ? 2 : 1);
      continue;
    }
    if (character === "\\") { index += 1; continue; }
    if (character === "(") parens += 1;
    else if (character === ")") parens = Math.max(0, parens - 1);
    else if (parens === 0 && onStop(character, index) === false) return;
  }
}

function matchingBrace(css: string, open: number): number {
  let depth = 0;
  let found = -1;
  scanCss(css.slice(open), (character, index) => {
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) { found = open + index; return false; }
  });
  return found;
}

function sanitizeDeclarations(block: string, state: SanitizeState): string {
  const declarations: string[] = [];
  let start = 0;
  const take = (end: number) => {
    const declaration = block.slice(start, end).trim();
    start = end + 1;
    if (!declaration) return;
    if (/[{}]/.test(declaration) || hasUnsafeCssReference(declaration)) {
      state.removedExternal = true;
      return;
    }
    declarations.push(declaration);
  };
  scanCss(block, (character, index) => { if (character === ";") take(index); });
  take(block.length);
  return declarations.join(";");
}

function sanitizeRules(css: string, state: SanitizeState, depth: number): string {
  const out: string[] = [];
  let start = 0;
  while (start < css.length) {
    let stop = -1;
    let stopCharacter = "";
    scanCss(css.slice(start), (character, index) => {
      if (character === "{" || character === ";" || character === "}") { stop = start + index; stopCharacter = character; return false; }
    });
    if (stop < 0) break;
    const prelude = css.slice(start, stop).trim();
    if (stopCharacter !== "{") {
      // A statement at-rule (`@import`, `@charset`, `@namespace`) or stray text.
      if (prelude.startsWith("@")) state.removedExternal = true;
      start = stop + 1;
      continue;
    }
    const close = matchingBrace(css, stop);
    if (close < 0) { state.removedExternal = true; break; }
    const block = css.slice(stop + 1, close);
    start = close + 1;
    const atRule = /^@(-?[a-z-]+)/i.exec(normalizeCssForCheck(prelude))?.[1];
    if (hasUnsafeCssReference(prelude)) { state.removedExternal = true; continue; }
    if (atRule) {
      if (KEPT_AT_RULE_BLOCKS.has(atRule) && depth < 8) out.push(`${prelude}{${sanitizeRules(block, state, depth + 1)}}`);
      else state.removedExternal = true;
    } else if (prelude) {
      out.push(`${prelude}{${sanitizeDeclarations(block, state)}}`);
    }
  }
  return out.join("\n");
}

export function sanitizeSvgStylesheet(css: string, state: SanitizeState = { removedExternal: false, removedActive: false }): string {
  const sanitized = sanitizeRules(stripCssComments(css), state, 0);
  // Defence in depth: anything the rule parser misread is dropped whole.
  if (hasUnsafeCssReference(sanitized)) {
    state.removedExternal = true;
    return "";
  }
  return sanitized;
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
      keep = name === "href" && safeReference(value.trim(), rasterAllowed);
      if (!keep && name === "href") state.removedExternal = true;
    } else if (namespace !== null) keep = false;
    else {
      const lower = name.toLowerCase();
      if (lower.startsWith("on")) { keep = false; state.removedActive = true; }
      else if (!/^[A-Za-z_][\w.-]*$/.test(name) || lower === "src" || lower === "base") keep = false;
      else if (lower === "href") {
        keep = name === "href" && safeReference(value.trim(), rasterAllowed);
        if (!keep) state.removedExternal = true;
      } else if (lower === "style") {
        const cleaned = sanitizeDeclarations(stripCssComments(value), state);
        if (cleaned) {
          if (cleaned !== value) element.setAttribute("style", cleaned);
          continue;
        }
        keep = false;
      } else {
        keep = !hasUnsafeCssReference(value);
        if (!keep) state.removedExternal = true;
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
  return { ok: true, svg: new XMLSerializer().serializeToString(root), ...state };
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
