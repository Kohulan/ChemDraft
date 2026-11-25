// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { DIAGRAM_SAMPLE, EDITOR_SAMPLE, PLOT_SAMPLE, TOOLKIT_SAMPLE } from "./benignSamples";
import { CssTokenBudgetError, tokenizeCss } from "./cssTokens";
import { hasUnsafeCssReference, sanitizeSvgPicture, sanitizeSvgStylesheet, type SvgSanitizeResult } from "./svgSanitizer";
import { PNG_1X1_BASE64, jpegHeader, pngWithSize, webpVp8lHeader } from "./testFixtures";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
const PNG_DATA = `data:image/png;base64,${PNG_1X1_BASE64}`;

function clean(source: string): Extract<SvgSanitizeResult, { ok: true }> {
  const result = sanitizeSvgPicture(source);
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result;
}

function parsed(svg: string): Document {
  return new DOMParser().parseFromString(svg, "image/svg+xml");
}

/** Nothing in the output may load, run or link anything outside the file. */
function expectInert(svg: string): void {
  const document = parsed(svg);
  expect(document.getElementsByTagName("parsererror")).toHaveLength(0);
  for (const element of Array.from(document.getElementsByTagName("*"))) {
    expect(["script", "foreignObject", "iframe", "object", "embed", "audio", "video", "animate", "set",
      "animateMotion", "animateTransform", "handler"]).not.toContain(element.localName);
    // An `<a>` may stay, but never as a link.
    if (element.localName === "a") {
      expect(Array.from(element.attributes).filter(attribute => ["href", "target", "download", "ping"].includes(attribute.localName))).toEqual([]);
    }
    for (const attribute of Array.from(element.attributes)) {
      expect(attribute.localName.toLowerCase().startsWith("on")).toBe(false);
      if (attribute.localName === "href") expect(attribute.value).toMatch(/^#|^data:image\/(png|jpeg|gif|webp);base64,/);
      expect(attribute.localName === "base" && attribute.namespaceURI === "http://www.w3.org/XML/1998/namespace").toBe(false);
      expect(hasUnsafeCssReference(attribute.value)).toBe(false);
    }
  }
  expect(svg).not.toMatch(/javascript:|@import|<\?xml-stylesheet|<!DOCTYPE|<!ENTITY/i);
}

describe("sanitizeSvgPicture attacks", () => {
  const attacks: Array<[string, string]> = [
    ["script element", `<svg ${NS}><script>alert(1)</script><rect width="5" height="5"/></svg>`],
    ["script with CDATA", `<svg ${NS}><script><![CDATA[alert(1)]]></script></svg>`],
    ["namespace-prefixed script", `<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script><s:rect width="1" height="1"/></s:svg>`],
    ["XHTML script", `<svg ${NS}><h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(1)</h:script></svg>`],
    ["foreignObject", `<svg ${NS}><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></div></foreignObject></svg>`],
    ["iframe/object/embed/audio/video", `<svg ${NS}><iframe src="https://e.test"/><object data="x"/><embed src="x"/><audio src="a.mp3"/><video src="v.mp4"/></svg>`],
    ["event handlers in any case", `<svg ${NS} onload="alert(1)"><rect width="1" height="1" onClick="alert(2)" ONMOUSEOVER="alert(3)"/></svg>`],
    ["javascript link", `<svg ${NS} ${XLINK}><a xlink:href="javascript:alert(1)"><rect width="1" height="1"/></a></svg>`],
    ["entity-encoded javascript link", `<svg ${NS}><a href="&#106;avascript:alert(1)" target="_blank"><text>x</text></a></svg>`],
    ["animation rewriting href", `<svg ${NS}><a href="#"><set attributeName="href" to="javascript:alert(1)"/><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>`],
    ["external use", `<svg ${NS}><use href="file.svg#x"/><use href="https://e.test/a.svg#y"/></svg>`],
    ["external xlink use", `<svg ${NS} ${XLINK}><use xlink:href="other.svg#x"/></svg>`],
    ["external image", `<svg ${NS}><image href="https://e.test/a.png" width="5" height="5"/><image href="file:///etc/passwd"/></svg>`],
    ["nested SVG data image", `<svg ${NS}><image href="data:image/svg+xml;base64,PHN2Zy8+" width="1" height="1"/></svg>`],
    ["feImage external", `<svg ${NS}><filter id="f"><feImage href="https://e.test/x.png"/></filter></svg>`],
    ["xml:base", `<svg ${NS} xml:base="https://e.test/"><use href="#a"/><rect id="a" width="1" height="1"/></svg>`],
    ["xml-stylesheet", `<?xml-stylesheet href="https://e.test/a.css" type="text/css"?><svg ${NS}><rect width="1" height="1"/></svg>`],
    ["@import", `<svg ${NS}><style>@import url(https://e.test/a.css); rect{fill:red}</style></svg>`],
    ["@import without url", `<svg ${NS}><style>@import "a.css";</style></svg>`],
    ["@font-face", `<svg ${NS}><style>@font-face{font-family:x;src:url(https://e.test/f.woff)}</style></svg>`],
    ["CSS escape url", `<svg ${NS}><style>rect{fill:u\\72l(https://e.test/x)}</style></svg>`],
    ["CSS hex escape with space", `<svg ${NS}><style>rect{background:\\75 rl(https://e.test/x)}</style></svg>`],
    ["comment inside url", `<svg ${NS}><style>rect{fill:url(/**/https://e.test/x)}</style></svg>`],
    ["mixed case url", `<svg ${NS}><style>rect{fill:URL("https://e.test/x")}</style></svg>`],
    ["image-set", `<svg ${NS}><style>rect{fill:image-set("a.png" 1x)}</style></svg>`],
    ["cursor/mask/filter/marker url", `<svg ${NS}><rect width="1" height="1" cursor="url(c.cur), auto" mask="url(m.svg#m)" filter="url(f.svg#f)" marker-start="url(https://e.test/#m)"/></svg>`],
    ["presentation fill url", `<svg ${NS}><rect width="1" height="1" fill="url(https://e.test/#g)"/></svg>`],
    ["style attribute url", `<svg ${NS}><rect width="1" height="1" style="fill:red;background-image:url('https://e.test/x.png')"/></svg>`],
    ["style attribute escape", `<svg ${NS}><rect width="1" height="1" style="fill:\\75\\72\\6c(x.png)"/></svg>`],
    ["entity-encoded style url", `<svg ${NS}><rect width="1" height="1" style="fill:&#117;rl(x.png)"/></svg>`],
    ["javascript in data uri style", `<svg ${NS}><rect width="1" height="1" style="fill:url(javascript:alert(1))"/></svg>`],
    ["media block with url", `<svg ${NS}><style>@media screen{rect{fill:url(https://e.test/x)}}</style></svg>`],
    ["textPath external", `<svg ${NS}><text><textPath href="other.svg#p">x</textPath></text></svg>`],
  ];

  it.each(attacks)("removes %s", (_name, source) => {
    const result = clean(source);
    expectInert(result.svg);
    expect(result.removedExternal || result.removedActive).toBe(true);
  });

  it("reads a comment between letters as CSS does: two tokens, never a url()", () => {
    const result = clean(`<svg ${NS}><style>rect{fill:u/**/rl(https://e.test/x)}</style></svg>`);
    expectInert(result.svg);
    expect(result.svg).not.toMatch(/url\(/i);
  });

  it("removes script but keeps the drawing beside it", () => {
    const result = clean(`<svg ${NS} width="10" height="10"><script>alert(1)</script><rect id="r" width="5" height="5" fill="red"/></svg>`);
    expect(result.removedActive).toBe(true);
    expect(result.removedExternal).toBe(false);
    expect(parsed(result.svg).getElementById("r")?.getAttribute("fill")).toBe("red");
  });

  it("keeps a link as an inert <a>: its children, transform and class stay, so selectors such as `a rect` still match", () => {
    const result = clean(`<svg ${NS} ${XLINK}><style>a rect{fill:red}</style><a href="https://e.test" xlink:href="#c" target="_blank" `
      + `download="x" ping="https://e.test/p" rel="noopener" tabindex="0" onclick="x()" class="k" transform="translate(3 4)"><rect id="c" width="2" height="2"/></a></svg>`);
    const document = parsed(result.svg);
    const link = document.getElementById("c")!.parentElement!;
    expect(link.localName).toBe("a");
    expect(Array.from(link.attributes).map(attribute => attribute.name).sort()).toEqual(["class", "transform"]);
    expect(link.getAttribute("transform")).toBe("translate(3 4)");
    expect(document.querySelector("a rect")?.id).toBe("c");
    expect(result).toMatchObject({ removedExternal: true, removedActive: true });
    expectInert(result.svg);
  });

  it("refuses malformed XML, entities and internal DOCTYPE subsets", () => {
    for (const source of [
      `<svg ${NS}><rect></svg>`,
      `<svg ${NS}`,
      `<!DOCTYPE svg [<!ENTITY x "y">]><svg ${NS}>&x;</svg>`,
      `<!DOCTYPE svg [<!ELEMENT svg ANY>]><svg ${NS}/>`,
      `<!DOCTYPE svg SYSTEM "x.dtd"><!ENTITY lol "lol"><svg ${NS}/>`,
      `<html><svg ${NS}/></html>`,
      `<svg xmlns="http://example.com/not-svg"/>`
    ]) {
      expect(sanitizeSvgPicture(source).ok, source).toBe(false);
    }
  });

  it("never hands a parser a DOCTYPE, so no parser sees an external identifier", () => {
    const parse = vi.fn((source: string, type: DOMParserSupportedType) => new DOMParser().parseFromString(source, type));
    const doctype = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">';
    for (const source of [`<?xml version="1.0"?>\n<!-- made by hand -->${doctype}<svg ${NS}><rect width="1" height="1"/></svg>`,
      `\uFEFF${doctype}\n<svg width="1" height="1"><rect width="1" height="1"/></svg>`]) {
      parse.mockClear();
      expect(sanitizeSvgPicture(source, { domParser: { parseFromString: parse } }).ok, source).toBe(true);
      expect(parse).toHaveBeenCalled();
      for (const [text] of parse.mock.calls) expect(text).not.toMatch(/DOCTYPE|w3\.org\/Graphics/);
    }
  });

  it("refuses a second DOCTYPE in the prolog before parsing, but not the text elsewhere", () => {
    const parse = vi.fn((source: string, type: DOMParserSupportedType) => new DOMParser().parseFromString(source, type));
    const doctype = '<!DOCTYPE svg SYSTEM "a.dtd">';
    for (const source of [`${doctype}${doctype}<svg ${NS}/>`, `${doctype}\n<!-- x --><?pi y?> <!doctype svg><svg ${NS}/>`]) {
      parse.mockClear();
      expect(sanitizeSvgPicture(source, { domParser: { parseFromString: parse } }), source)
        .toEqual({ ok: false, error: "the SVG is not well-formed XML." });
      expect(parse).not.toHaveBeenCalled();
    }
    for (const source of [`${doctype}<!-- <!DOCTYPE svg> --><svg ${NS}><![CDATA[<!DOCTYPE x>]]><text>&lt;!DOCTYPE svg></text></svg>`,
      `${doctype}<svg ${NS}><text><![CDATA[<!DOCTYPE svg>]]></text></svg>`]) {
      expect(sanitizeSvgPicture(source).ok, source).toBe(true);
    }
  });

  it("drops a DOCTYPE without an internal subset", () => {
    const result = clean(`<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg ${NS}><rect width="1" height="1"/></svg>`);
    expect(result.svg).not.toContain("DOCTYPE");
    expect(result.removedExternal).toBe(false);
  });

  it("refuses over-deep nesting and too many elements before parsing", () => {
    const deep = `<svg ${NS}>${"<g>".repeat(200)}${"</g>".repeat(200)}</svg>`;
    expect(sanitizeSvgPicture(deep)).toMatchObject({ ok: false, error: expect.stringContaining("levels deep") });
    const many = `<svg ${NS}>${"<g/>".repeat(200_001)}</svg>`;
    expect(sanitizeSvgPicture(many)).toMatchObject({ ok: false, error: expect.stringContaining("elements") });
  });

  it("adds the SVG namespace that hand-written files often omit", () => {
    const result = clean(`<svg width="4" height="2"><rect width="4" height="2"/></svg>`);
    expect(parsed(result.svg).documentElement.namespaceURI).toBe("http://www.w3.org/2000/svg");
  });

  it("adds the namespace on the real root start tag, or fills in an empty default declaration", () => {
    for (const source of [
      `<!-- an <svg> sketch --><svg width="4" height="2"><rect width="4" height="2"/></svg>`,
      `<?pi <svg?><svg width="4" height="2"><rect width="4" height="2"/></svg>`,
      `<svg xmlns="" width="4" height="2"><rect width="4" height="2"/></svg>`,
      `<svg width="4" xmlns = '' height="2"><rect width="4" height="2"/></svg>`
    ]) {
      const document = parsed(clean(source).svg);
      expect(document.documentElement.namespaceURI, source).toBe("http://www.w3.org/2000/svg");
      expect(document.querySelector("rect")?.namespaceURI, source).toBe("http://www.w3.org/2000/svg");
    }
  });

  it("counts closing tags only for depth, not as nodes", () => {
    // 150,000 elements and 150,000 comments: 300,000 nodes, within the limit, though 450,000 tags.
    const source = `<svg ${NS}>${"<g></g><!---->".repeat(150_000)}</svg>`;
    const parse = vi.fn(() => new DOMParser().parseFromString("<parsererror/>", "image/svg+xml"));
    expect(sanitizeSvgPicture(source, { domParser: { parseFromString: parse } })).toEqual({ ok: false, error: "the SVG is not well-formed XML." });
    expect(parse).toHaveBeenCalledTimes(1);
    const over = `<svg ${NS}>${"<!---->".repeat(400_000)}</svg>`;
    expect(sanitizeSvgPicture(over)).toMatchObject({ ok: false, error: expect.stringContaining("comments and other markup nodes") });
  });

  it("reads the prolog once: an internal subset or a second DOCTYPE is refused, elsewhere it is text", () => {
    const subset = "the SVG has a DOCTYPE with an internal subset, which is not allowed.";
    expect(sanitizeSvgPicture(`<!-- x --><?pi?><!DOCTYPE svg SYSTEM "a[.dtd" [ <!ELEMENT svg ANY> ]><svg ${NS}/>`)).toEqual({ ok: false, error: subset });
    expect(sanitizeSvgPicture(`<!DOCTYPE svg SYSTEM 'a.dtd'><!-- c --><!DOCTYPE svg [ ]><svg ${NS}/>`))
      .toEqual({ ok: false, error: "the SVG is not well-formed XML." });
    // After the root start tag a DOCTYPE with brackets is only text in a comment or CDATA section.
    expect(clean(`<svg ${NS}><!-- <!DOCTYPE x [ --><text><![CDATA[<!DOCTYPE y [ ]]></text></svg>`).svg).toContain("<!DOCTYPE y [");
  });

  it("fails closed on a prolog it cannot read: only a start tag may follow it, and XML 1.1 is refused", () => {
    const parse = vi.fn((source: string, type: DOMParserSupportedType) => new DOMParser().parseFromString(source, type));
    const subset = '<!DOCTYPE svg [ <!ELEMENT svg ANY> ]>';
    const notWellFormed = { ok: false, error: "the SVG is not well-formed XML." };
    // XML 1.1 reads U+0085 and U+2028 as line ends, so a DOCTYPE after one would reach the parser.
    for (const space of ["\u0085", "\u2028"]) {
      expect(sanitizeSvgPicture(`<?xml version="1.1"?>${space}${subset}<svg ${NS}/>`, { domParser: { parseFromString: parse } }))
        .toEqual({ ok: false, error: "the SVG is XML 1.1, which is not supported; save it as XML 1.0." });
      expect(sanitizeSvgPicture(`<?xml version="1.0"?>${space}${subset}<svg ${NS}/>`, { domParser: { parseFromString: parse } }))
        .toEqual(notWellFormed);
    }
    for (const source of [`<?xml encoding="UTF-8"?><svg ${NS}/>`, `text<svg ${NS}/>`, `<![CDATA[x]]><svg ${NS}/>`, `<!ELEMENT svg ANY><svg ${NS}/>`,
      `<!DOCTYPE svg SYSTEM "a.dtd"> <1svg ${NS}/>`, "  ", `<!-- x -->`]) {
      expect(sanitizeSvgPicture(source, { domParser: { parseFromString: parse } }), source).toEqual(notWellFormed);
    }
    expect(parse).not.toHaveBeenCalled();
    // A declaration of 1.0, a style sheet instruction and a name starting past ASCII still read.
    expect(sanitizeSvgPicture(`<?xml version='1.0' encoding="UTF-8"?><?xml-stylesheet href="a.css"?><svg ${NS}/>`).ok).toBe(true);
    expect(sanitizeSvgPicture('<\u00e9l/>')).toEqual({ ok: false, error: "the file is not an SVG document (its root element is <\u00e9l>)." });
  });
});

describe("sanitizeSvgPicture keeps benign drawings", () => {
  it("keeps gradients, url(#id) fills, <use href=#id>, clip paths, style blocks and embedded PNG", () => {
    const source = `<svg ${NS} ${XLINK} viewBox="0 0 100 50" width="100" height="50">
  <defs>
    <linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>
    <clipPath id="clip"><rect width="40" height="40"/></clipPath>
    <marker id="m" markerWidth="4" markerHeight="4"><path d="M0 0L4 2L0 4z"/></marker>
    <filter id="f"><feGaussianBlur stdDeviation="1"/></filter>
    <symbol id="s"><circle r="3"/></symbol>
  </defs>
  <style>.a{fill:url(#g);stroke:#000} @media print{.a{stroke:none}}</style>
  <rect class="a" width="50" height="20" clip-path="url(#clip)" filter="url( '#f' )"/>
  <path d="M0 0L10 10" marker-end="url(#m)" style="stroke: red; stroke-width: 2"/>
  <use href="#s" x="5"/><use xlink:href="#s" x="9"/>
  <image href="${PNG_DATA}" width="1" height="1"/>
  <text x="1" y="9" font-family="serif">Benzene ⌬ αβ</text>
</svg>`;
    const result = clean(source);
    expect(result.removedExternal).toBe(false);
    expect(result.removedActive).toBe(false);
    const document = parsed(result.svg);
    expect(document.querySelector("rect.a")?.getAttribute("clip-path")).toBe("url(#clip)");
    // Written back as the checked fragment.
    expect(document.querySelector("rect.a")?.getAttribute("filter")).toBe("url(#f)");
    expect(document.querySelector("path[marker-end]")?.getAttribute("marker-end")).toBe("url(#m)");
    expect(document.querySelector("path[marker-end]")?.getAttribute("style")).toBe("stroke: red;stroke-width: 2");
    expect(Array.from(document.getElementsByTagName("use")).map(use =>
      use.getAttribute("href") ?? use.getAttributeNS("http://www.w3.org/1999/xlink", "href"))).toEqual(["#s", "#s"]);
    expect(document.querySelector("image")?.getAttribute("href")).toBe(PNG_DATA);
    expect(document.querySelector("style")?.textContent).toBe(".a{fill:url(#g);stroke:#000}\n@media print{.a{stroke:none}}");
    expect(document.querySelector("text")?.textContent).toBe("Benzene ⌬ αβ");
    expect(document.getElementsByTagName("stop")).toHaveLength(2);
    expectInert(result.svg);
  });

  it("adds a viewBox only when the root has an absolute width and height and none", () => {
    expect(parsed(clean(`<svg ${NS} width="20mm" height="10mm"/>`).svg).documentElement.getAttribute("viewBox"))
      .toBe("0 0 75.5906 37.7953");
    expect(parsed(clean(`<svg ${NS} width="20" height="10" viewBox="0 0 2 1"/>`).svg).documentElement.getAttribute("viewBox"))
      .toBe("0 0 2 1");
    expect(parsed(clean(`<svg ${NS} width="100%" height="10"/>`).svg).documentElement.hasAttribute("viewBox")).toBe(false);
    // A valid length is read whatever its length.
    expect(parsed(clean(`<svg ${NS} width="${"0".repeat(5_000)}20.${"0".repeat(5_000)}" height="${"1".repeat(100)}e-98pt"/>`).svg)
      .documentElement.getAttribute("viewBox")).toBe("0 0 20 14.8148");
  });

  it("is idempotent: sanitizing its own output changes nothing", () => {
    const once = clean(`<svg ${NS} width="3" height="3"><style>/* c */ rect { fill : blue ; }</style><rect width="3" height="3"/></svg>`);
    expect(clean(once.svg).svg).toBe(once.svg);
  });
});

describe("sanitizeSvgStylesheet", () => {
  it("keeps supports blocks, drops unknown at-rules", () => {
    const state = { removedExternal: false, removedActive: false };
    expect(sanitizeSvgStylesheet("@supports (fill:red){rect{fill:red}} @namespace x url(y);", state))
      .toBe("@supports (fill:red){rect{fill:red}}");
    expect(state.removedExternal).toBe(true);
  });
});

describe("CSS animation is removed like SMIL animation", () => {
  const state = () => ({ removedExternal: false, removedActive: false });

  it("drops @keyframes in any case, vendor prefix or escape, and in nested at-rules", () => {
    for (const css of ["@keyframes k{from{opacity:0}to{opacity:1}}", "@KeyFrames k{to{opacity:1}}",
      "@-webkit-keyframes k{to{opacity:1}}", "@-MOZ-keyframes k{to{opacity:1}}", "@\\6b eyframes k{to{opacity:1}}",
      "@media screen{@keyframes k{to{opacity:1}}}", "@supports (fill:red){@layer a{@-o-keyframes k{to{opacity:1}}}}"]) {
      const removed = state();
      const kept = sanitizeSvgStylesheet(`${css} rect{fill:red}`, removed);
      expect(kept, css).not.toMatch(/keyframes|opacity/i);
      expect(kept, css).toContain("rect{fill:red}");
      expect(removed, css).toMatchObject({ removedExternal: false, removedActive: true });
    }
  });

  it("drops animation, transition and timeline properties, keeping the rest of the rule", () => {
    const removed = state();
    const css = "rect{fill:red;animation:spin 1s infinite;ANIMATION-NAME:spin;-webkit-animation:spin 1s;-moz-animation-duration:1s;"
      + "anim\\61tion-iteration-count:infinite;transition:fill 1s;transition-delay:1s;-webkit-transition:fill 1s;"
      + "view-transition-name:a;scroll-timeline:--t;view-timeline-name:--v;animation-timeline:--t;timeline-scope:--t;"
      + "offset-path:path('M0 0H9');stroke:blue}"
      + "@media screen{circle{animation:spin 1s;opacity:.5}}";
    expect(sanitizeSvgStylesheet(css, removed))
      .toBe("rect{fill:red;offset-path:path('M0 0H9');stroke:blue}\n@media screen{circle{opacity:.5}}");
    expect(removed).toMatchObject({ removedExternal: false, removedActive: true });
  });

  it("removes it from a drawing's style sheet and style attributes and reports it, without refusing", () => {
    const source = `<svg ${NS} width="2" height="2"><style>@keyframes k{to{fill:blue}} rect{fill:red;animation:k 1s infinite}</style>`
      + `<rect width="1" height="1" style="opacity:.5;transition:opacity 1s;-webkit-animation:k 1s"/></svg>`;
    for (const result of [sanitizeSvgPicture(source), sanitizeSvgPicture(source, { outsideReferences: "refuse" })]) {
      expect(result).toMatchObject({ ok: true, removedActive: true, removedExternal: false });
      if (!result.ok) continue;
      expect(result.svg).not.toMatch(/keyframes|animation|transition/i);
      expect(result.svg).toContain("rect{fill:red}");
      expect(result.svg).toContain('style="opacity:.5"');
      expect(clean(result.svg).svg).toBe(result.svg);
    }
  });
});

describe("CSS is checked and kept as the same tokens", () => {
  const state = () => ({ removedExternal: false, removedActive: false });

  it("keeps comment-like text inside a string as part of the string, so the url after it is checked", () => {
    // Read with comments stripped first, the mask was `mask:""` and its url looked like a comment.
    const css = `rect{font-family:"/*";mask:"/*" url(https://e.test/m.svg#m) "*/";stroke:"*/"}`;
    const kept = sanitizeSvgStylesheet(css, state());
    expect(kept).not.toContain("e.test");
    expect(kept).toBe(`rect{font-family:"/*";stroke:"*/"}`);
    const result = clean(`<svg ${NS}><rect width="1" height="1" style='mask:"/*" url(https://e.test/m.svg#m) "*/";fill:red'/></svg>`);
    expectInert(result.svg);
    expect(result.svg).not.toContain("e.test");
    expect(result.removedExternal).toBe(true);
  });

  it("reads an unquoted url to its parenthesis, comment-like text included", () => {
    const s0 = state();
    expect(sanitizeSvgStylesheet("rect{fill:url(https://e.test/*x*/);stroke:red}", s0)).toBe("rect{stroke:red}");
    expect(s0.removedExternal).toBe(true);
    // Here the comment-like text is part of a fragment name: kept exactly, as it was checked.
    expect(sanitizeSvgStylesheet("rect{fill:url(#g/**/)}", state())).toBe("rect{fill:url(#g/**/)}");
  });

  it("drops declarations with a bad string or a bad url, and keeps the rest of the rule", () => {
    expect(sanitizeSvgStylesheet('rect{fill:red;font-family:"abc\n;fill:url(https://e.test/x);stroke:blue}', state()))
      .toBe("rect{fill:red;stroke:blue}");
    expect(sanitizeSvgStylesheet('rect{fill:url(a"b);stroke:blue}', state())).toBe("rect{stroke:blue}");
    expect(sanitizeSvgStylesheet("rect{fill:url(a b);stroke:blue}", state())).toBe("rect{stroke:blue}");
  });

  it("drops whatever the text cuts off: a block, a string or a url", () => {
    for (const css of ["rect{fill:red", 'rect[title="x]{fill:red}', "rect{fill:url(#a", "@media print{rect{fill:red}"]) {
      const s0 = state();
      expect(sanitizeSvgStylesheet(css, s0), css).toBe("");
      expect(s0.removedExternal, css).toBe(true);
    }
    expect(sanitizeSvgStylesheet("rect{fill:red} /* unterminated", state())).toBe("rect{fill:red}");
  });

  it("decodes escapes in names wherever CSS does", () => {
    for (const css of ["@\\69mport url(x.css);rect{fill:red}", "@font\\-face{font-family:x;src:url(f.woff)}rect{fill:red}",
      "rect{fill:\\75\\72\\6c(x.png)}", "rect{fill:\\55 RL(x.png)}", "rect{fill:i\\6d age(x.png)}"]) {
      const s0 = state();
      const kept = sanitizeSvgStylesheet(css, s0);
      expect(kept, css).not.toMatch(/x\.(css|png)|f\.woff/);
      expect(s0.removedExternal, css).toBe(true);
    }
  });

  it("refuses loading functions and at-rules, in custom properties too, and keeps fragment references", () => {
    const css = [
      "rect{--a:image('https://e.test/a.png');--b:url(#g);--c:{fill:red};--d:src('x');fill:var(--b)}",
      "circle{fill:image-set('a.png' 1x);stroke:-webkit-image-set(url(#g) 1x);mask:attr(data-u url);clip-path:url( \"#c\" )}",
      "@namespace svg url(http://www.w3.org/2000/svg);",
      "@font-face{font-family:x}",
      "@import 'a.css';"
    ].join("\n");
    const s0 = state();
    expect(sanitizeSvgStylesheet(css, s0)).toBe("rect{--b:url(#g);fill:var(--b)}\ncircle{clip-path:url(#c)}");
    expect(s0.removedExternal).toBe(true);
    expect(sanitizeSvgStylesheet('rect{fill:url("#g" x)}', state())).toBe("rect{}");
    expect(sanitizeSvgStylesheet('rect{fill:url("data:image/png;base64,AAAA")}', state())).toBe("rect{}");
  });

  it("drops a selector or at-rule prelude that loads something", () => {
    const s0 = state();
    expect(sanitizeSvgStylesheet("rect:has(image(x)){fill:red} @media (url(x)){rect{fill:red}} g{fill:red}", s0)).toBe("g{fill:red}");
    expect(s0.removedExternal).toBe(true);
  });

  it("checks presentation attributes that can hold a reference, and leaves other attributes as text", () => {
    const result = clean(`<svg ${NS}><path d="M0 0" fill="url('https://e.test/#g')" stroke="url(#ok)" data-note="url(https://e.test/)" aria-label="it's"/></svg>`);
    const path = parsed(result.svg).querySelector("path")!;
    expect(path.hasAttribute("fill")).toBe(false);
    expect(path.getAttribute("stroke")).toBe("url(#ok)");
    // Not CSS to any renderer: kept as written.
    expect(path.getAttribute("data-note")).toBe("url(https://e.test/)");
    expect(path.getAttribute("aria-label")).toBe("it's");
    expect(result.removedExternal).toBe(true);
  });
});

describe("hostile sizes stay linear", () => {
  it("sanitizes multi-megabyte identifiers, attributes and styles in bounded time", () => {
    const run = "a".repeat(2_000_000);
    const sources = [
      // Long identifiers that never become a function, in a reference attribute, a style and a sheet.
      `<svg ${NS}><path d="${run}" fill="${run}" style="${run}:${run}"/></svg>`,
      `<svg ${NS}><style>${run}{fill:${run}}</style><rect width="1" height="1"/></svg>`,
      // Escapes, parentheses and quotes by the million.
      `<svg ${NS}><rect width="1" height="1" style="fill:${"\\61".repeat(400_000)};stroke:${"(".repeat(500_000)}"/></svg>`,
      `<svg ${NS}><style>rect{fill:${"url(#a)".repeat(200_000)};stroke:${"'x' ".repeat(300_000)}}</style></svg>`,
      // A data URI whose base64 is whitespace, then one bad character.
      `<svg ${NS}><image href="data:image/png;base64,${" ".repeat(2_000_000)}!" width="1" height="1"/></svg>`,
      // DOCTYPE openings that never close, plain and quoted, and comment openings in the prolog.
      "<!DOCTYPE".repeat(400_000),
      `<!DOCTYPE x "${"<!DOCTYPE".repeat(400_000)}`,
      `${"<!--<!DOCTYPE".repeat(300_000)}`,
      // A namespace-less root after a prolog full of `<svg`, and a width of two million digits.
      `<!--${"<svg ".repeat(500_000)}--><svg width="1" height="1"/>`,
      `<svg ${NS} width="${"1".repeat(2_000_000)}x" height="1"><rect width="1" height="1"/></svg>`
    ];
    for (const source of sources) {
      const started = performance.now();
      sanitizeSvgPicture(source);
      // Quadratic work on two million characters takes hours; linear work takes well under a second.
      expect(performance.now() - started, source.slice(0, 60)).toBeLessThan(8000);
    }
  }, 60_000);
});

describe("embedded bitmaps", () => {
  const embed = (mime: string, bytes: Uint8Array) =>
    `<image href="data:${mime};base64,${btoa(String.fromCharCode(...bytes))}" width="1" height="1"/>`;

  it("refuses an SVG whose embedded bitmap is not what its label says", () => {
    expect(sanitizeSvgPicture(`<svg ${NS}>${embed("image/png", jpegHeader(4, 4))}</svg>`))
      .toEqual({ ok: false, error: "an embedded picture is labelled image/png but its contents are JPEG." });
    expect(sanitizeSvgPicture(`<svg ${NS}>${embed("image/gif", new TextEncoder().encode("<svg/>"))}</svg>`))
      .toEqual({ ok: false, error: "an embedded picture is labelled image/gif but its contents are not a picture." });
  });

  it("reads each bitmap's size from its header and enforces the per-picture caps", () => {
    expect(sanitizeSvgPicture(`<svg ${NS}>${embed("image/png", pngWithSize(20_000, 1))}</svg>`))
      .toEqual({ ok: false, error: "an embedded picture is 20000 × 1 pixels; the limit is 16384 pixels on a side." });
    expect(sanitizeSvgPicture(`<svg ${NS}><filter id="f"><feImage href="data:image/jpeg;base64,${btoa(String.fromCharCode(...jpegHeader(9000, 9000)))}"/></filter></svg>`))
      .toEqual({ ok: false, error: "an embedded picture is 9000 × 9000 pixels; the decoded limit is 256 MiB." });
    const truncated = pngWithSize(2, 2).subarray(0, 20);
    expect(sanitizeSvgPicture(`<svg ${NS}>${embed("image/png", truncated)}</svg>`))
      .toEqual({ ok: false, error: "an embedded PNG picture's header is damaged, so its size can't be read." });
  });

  it("caps the decoded size of all embedded bitmaps together", () => {
    // Each 8000 × 2000 picture decodes to 64 MB, within the per-picture cap; five exceed 256 MiB.
    const one = embed("image/jpeg", jpegHeader(8000, 2000));
    expect(clean(`<svg ${NS}>${one.repeat(4)}</svg>`).svg).toContain("data:image/jpeg;base64,");
    expect(sanitizeSvgPicture(`<svg ${NS}>${one.repeat(5)}</svg>`))
      .toEqual({ ok: false, error: "its embedded pictures together decode to more than 256 MiB." });
  });
});

describe("fragment references resolve within the picture", () => {
  const refuse = (source: string) => sanitizeSvgPicture(source, { outsideReferences: "refuse" });

  it("never keeps a fragment on <image> or <feImage>, where a renderer may read it as a file name", () => {
    for (const body of [`<image href="#a" width="1" height="1"/>`, `<filter id="f"><feImage href="#a"/></filter>`,
      `<image xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#a"/>`]) {
      const source = `<svg ${NS}><rect id="a" width="1" height="1"/>${body}</svg>`;
      const result = clean(source);
      for (const element of Array.from(parsed(result.svg).querySelectorAll("image, feImage"))) {
        expect(Array.from(element.attributes).some(attribute => attribute.localName === "href"), body).toBe(false);
      }
      expect(result.removedExternal, body).toBe(true);
      expect(refuse(source), body).toEqual({ ok: false, error: "the SVG refers to a file or address outside the picture." });
    }
  });

  it("keeps a fragment that names a surviving element and drops one that names nothing", () => {
    const result = clean(`<svg ${NS} ${XLINK}><defs><path id="glyph" d="M0 0h1"/><script id="gone">x()</script></defs>`
      + `<use href="#glyph"/><use xlink:href="#missing"/><use href="#gone"/></svg>`);
    const uses = Array.from(parsed(result.svg).getElementsByTagName("use"));
    expect(uses.map(use => use.getAttribute("href") ?? use.getAttributeNS("http://www.w3.org/1999/xlink", "href"))).toEqual(["#glyph", null, null]);
    // A dangling fragment drew nothing before either: no note, and the renderer's policy draws it.
    expect(result.removedExternal).toBe(false);
    expect(refuse(`<svg ${NS}><use href="#missing"/></svg>`).ok).toBe(true);
  });

  it("validates the exact value a URL parser sees, trimming ASCII whitespace only, and writes that value", () => {
    const kept = clean(`<svg ${NS}><path id="a" d="M0 0"/><use href="&#10; #a &#9;"/></svg>`);
    expect(parsed(kept.svg).querySelector("use")!.getAttribute("href")).toBe("#a");
    // A no-break space is not URL whitespace: "#a\u00a0" names no element, and the old trim would have hidden that.
    const spaced = clean(`<svg ${NS}><path id="a" d="M0 0"/><use href="#a&#160;"/></svg>`);
    expect(parsed(spaced.svg).querySelector("use")!.hasAttribute("href")).toBe(false);
    // Before the data a no-break space makes a relative path, not a data URI.
    const bitmap = clean(`<svg ${NS}><image href="&#160;${PNG_DATA}" width="1" height="1"/></svg>`);
    expect(parsed(bitmap.svg).querySelector("image")!.hasAttribute("href")).toBe(false);
    expect(bitmap.removedExternal).toBe(true);
    const padded = clean(`<svg ${NS}><image href=" ${PNG_DATA}&#10;" width="1" height="1"/></svg>`);
    expect(parsed(padded.svg).querySelector("image")!.getAttribute("href")).toBe(PNG_DATA);
  });

  it("keeps an XML fragment to any surviving id, whatever a CSS url() would need, but not one renderers read differently", () => {
    const source = `<svg ${NS} ${XLINK}><defs><path id="atom(1)" d="M0 0h1"/><path id="a b" d="M0 0"/><path id="a%20b" d="M0 0"/>`
      + `<path id="ab" d="M0 0"/></defs><use href="#atom(1)"/><use xlink:href="#atom(1)"/><use href="#a%20b"/><use href="#a&#9;b"/></svg>`;
    for (const result of [clean(source), refuse(source)]) {
      if (!result.ok) throw new Error(result.error);
      const uses = Array.from(parsed(result.svg).getElementsByTagName("use"));
      // A browser decodes `%20` and strips a tab before matching an id, other renderers do not: neither is kept.
      expect(uses.map(use => use.getAttribute("href") ?? use.getAttributeNS("http://www.w3.org/1999/xlink", "href")))
        .toEqual(["#atom(1)", "#atom(1)", null, null]);
      expect(result.removedExternal).toBe(false);
    }
    // Still never on a picture element.
    expect(refuse(`<svg ${NS}><path id="atom(1)" d="M0 0"/><image href="#atom(1)" width="1" height="1"/></svg>`).ok).toBe(false);
  });

  it("refuses, under the renderer's policy only, an XML fragment to an id with a space, which the exporter cannot resolve", () => {
    const source = `<svg ${NS}><path id="a b" d="M0 0h1"/><use href="#a b"/></svg>`;
    expect(refuse(source)).toEqual({ ok: false, error: "the SVG refers to an id containing a space, which the exporter cannot draw." });
    expect(parsed(clean(source).svg).querySelector("use")!.getAttribute("href")).toBe("#a b");
    // A space naming nothing is dropped either way, and draws nothing in any renderer.
    expect(refuse(`<svg ${NS}><use href="#a b"/></svg>`).ok).toBe(true);
  });

  it("writes a CSS url() to an id an unquoted url cannot hold as a quoted string", () => {
    const source = `<svg ${NS}><linearGradient id="g(1)"/><linearGradient id='q"\\'/><style>rect{stroke:url('#g(1)')}</style>`
      + `<rect width="1" height="1" fill="url(#g\\(1\\))" style="fill:url(&quot;#q\\&quot;\\\\&quot;)"/></svg>`;
    {
      const result = clean(source);
      const document = parsed(result.svg);
      const rect = document.querySelector("rect")!;
      expect(rect.getAttribute("fill")).toBe('url("#g(1)")');
      expect(rect.getAttribute("style")).toBe('fill:url("#q\\"\\\\")');
      expect(document.querySelector("style")!.textContent).toBe('rect{stroke:url("#g(1)")}');
      expect(result.removedExternal).toBe(false);
    }
    // The exporter's renderer draws a quoted fragment black: under its policy each place refuses the picture.
    const quoted = { ok: false, error: "the SVG's style refers to an id that needs quoting, which the exporter cannot draw." };
    const g = `<svg ${NS}><linearGradient id="g(1)"/>`;
    expect(refuse(source)).toEqual(quoted);
    for (const body of [`<rect width="1" height="1" fill="url(#g\\(1\\))"/>`, `<rect width="1" height="1" style="fill:url('#g(1)')"/>`,
      `<style>rect{fill:url("#g(1)")}</style>`]) {
      expect(refuse(`${g}${body}</svg>`), body).toEqual(quoted);
    }
    expect(refuse(`<svg ${NS}><linearGradient id="g1"/><rect width="1" height="1" fill="url('#g1')"/></svg>`).ok).toBe(true);
  });

  it("writes a CSS url() as its checked fragment, with only ASCII whitespace trimmed", () => {
    const result = clean(`<svg ${NS}><rect width="1" height="1" fill="url(' #g&#9;')" stroke="url(&quot;#g&#160;&quot;)"/></svg>`);
    const rect = parsed(result.svg).querySelector("rect")!;
    expect(rect.getAttribute("fill")).toBe("url(#g)");
    expect(rect.getAttribute("stroke")).toBe("url(#g\u00a0)");
    expect(sanitizeSvgStylesheet("rect{fill:url( '\\9 #g' )}")).toBe("rect{fill:url(#g)}");
  });
});

describe("CSS comments are dropped without changing what the CSS means", () => {
  it("never turns a comment into a combinator, and keeps /**/ only where tokens would fuse", () => {
    expect(sanitizeSvgStylesheet("rect/**/.x{fill:red}")).toBe("rect.x{fill:red}");
    expect(sanitizeSvgStylesheet("g/**/rect{fill:red}")).toBe("g/**/rect{fill:red}");
    expect(sanitizeSvgStylesheet(".a/* x */ .b{stroke-width:2/**/px}")).toBe(".a .b{stroke-width:2/**/px}");
    expect(sanitizeSvgStylesheet("rect{fill:/* c */red/**/;stroke:#000}")).toBe("rect{fill:red;stroke:#000}");
    expect(sanitizeSvgStylesheet("#a/**/-b{fill:red}")).toBe("#a/**/-b{fill:red}");
    // Written together, `a(` would become a function.
    expect(sanitizeSvgStylesheet("a/**/(b){fill:red}")).toBe("a/**/(b){fill:red}");
  });

  it("keeps /**/ where a hex escape would otherwise take the blank after it as its terminator", () => {
    // `.\61 rect` would read back as the one class `.arect`.
    expect(sanitizeSvgStylesheet(".\\61/**/ rect{fill:red}")).toBe(".\\61/**/ rect{fill:red}");
    expect(sanitizeSvgStylesheet(".\\61/* c */\trect{fill:red}")).toBe(".\\61/**/\trect{fill:red}");
    // A blank the escape already ended with, an escaped backslash and seven hex digits need nothing.
    expect(sanitizeSvgStylesheet(".\\61 /**/ rect{fill:red}")).toBe(".\\61  rect{fill:red}");
    expect(sanitizeSvgStylesheet(".a\\\\61/**/ rect{fill:red}")).toBe(".a\\\\61 rect{fill:red}");
    expect(sanitizeSvgStylesheet(".\\1234567/**/ rect{fill:red}")).toBe(".\\1234567 rect{fill:red}");
    expect(sanitizeSvgStylesheet("rect/**/ .x{fill:red}")).toBe("rect .x{fill:red}");
  });

  it("is idempotent where a separator is kept", () => {
    const once = clean(`<svg ${NS}><style>g/**/rect,rect/**/.x{fill:red}</style></svg>`);
    expect(clean(once.svg).svg).toBe(once.svg);
    expect(parsed(once.svg).querySelector("style")!.textContent).toBe("g/**/rect,rect.x{fill:red}");
  });
});

describe("bounds before heavy work", () => {
  it("stops the tokenizer at its budget, before the token past it is made", () => {
    expect(() => tokenizeCss("a ".repeat(3), 5)).toThrow(CssTokenBudgetError);
    expect(tokenizeCss("a ".repeat(2), 4)).toHaveLength(4);
  });

  it("refuses a style sheet or style attribute with too many tokens, with the reason", () => {
    const reason = "a style sheet or style attribute in the SVG has more than 200,000 CSS tokens.";
    expect(sanitizeSvgPicture(`<svg ${NS}><style>${"a ".repeat(100_001)}</style></svg>`)).toEqual({ ok: false, error: reason });
    expect(sanitizeSvgPicture(`<svg ${NS}><rect style="${"a ".repeat(100_001)}"/></svg>`)).toEqual({ ok: false, error: reason });
  });

  it("refuses more CSS than the cap across the whole SVG", () => {
    const comment = `/*${"x".repeat(3 * 1024 * 1024)}*/`;
    expect(sanitizeSvgPicture(`<svg ${NS}><style>${comment}</style><style>${comment}</style><rect style="${comment}"/></svg>`))
      .toEqual({ ok: false, error: "the SVG has more than 8 MiB of CSS." });
  });

  it("refuses too many attributes or markup nodes before parsing", () => {
    expect(sanitizeSvgPicture(`<svg ${NS}><g ${'a="" '.repeat(1_000_001)}/></svg>`))
      .toEqual({ ok: false, error: "the SVG has more than 1,000,000 attributes." });
    expect(sanitizeSvgPicture(`<svg ${NS}>${"<!---->".repeat(400_001)}</svg>`))
      .toEqual({ ok: false, error: "the SVG has more than 400,000 elements, comments and other markup nodes." });
  });
});

describe("the parser and serializer are injected", () => {
  it("uses the ones it is given", () => {
    const parse = vi.fn((source: string, type: DOMParserSupportedType) => new DOMParser().parseFromString(source, type));
    const serialize = vi.fn((node: Node) => new XMLSerializer().serializeToString(node));
    const result = sanitizeSvgPicture(`<svg ${NS}><rect width="1" height="1"/></svg>`,
      { domParser: { parseFromString: parse }, xmlSerializer: { serializeToString: serialize } });
    expect(result.ok).toBe(true);
    expect(parse).toHaveBeenCalled();
    expect(serialize).toHaveBeenCalled();
  });
});

describe("the renderer's policy refuses instead of removing what loads", () => {
  const refuse = (source: string) => sanitizeSvgPicture(source, { outsideReferences: "refuse" });

  it("names the reason for a file, an address or a nested SVG", () => {
    expect(refuse(`<svg ${NS}><image href="/etc/hosts"/></svg>`)).toEqual({ ok: false, error: "the SVG refers to a file or address outside the picture." });
    expect(refuse(`<svg ${NS}><image href="data:image/svg+xml;base64,PHN2Zy8+"/></svg>`))
      .toEqual({ ok: false, error: "the SVG nests another SVG picture, which is not drawn." });
    expect(refuse(`<svg ${NS}><rect width="1" height="1" style="fill:url(a.png)"/></svg>`).ok).toBe(false);
    expect(refuse(`<svg ${NS}><style>@import "a.css";</style></svg>`).ok).toBe(false);
  });

  it("still draws a picture whose removals load nothing: scripts, links, editor data, malformed CSS", () => {
    const result = refuse(`<svg ${NS}><script>x()</script><a href="https://e.test"><rect width="1" height="1"/></a>`
      + `<rect width="1" height="1" style="fill:red;stroke:"/></svg>`);
    expect(result).toMatchObject({ ok: true, removedActive: true, removedExternal: true });
  });
});

describe("an @font-face that names only installed fonts", () => {
  const refuse = (source: string) => sanitizeSvgPicture(source, { outsideReferences: "refuse" });
  const svg = (rule: string) => `<svg ${NS}><style>${rule} rect{fill:red}</style><rect width="1" height="1"/></svg>`;

  it("is dropped on its own, without a note or a refusal", () => {
    for (const rule of ["@font-face{font-family:x;src:local(Arial), local('Helvetica Neue')}", "@font-face{font-family:x}",
      "@font-face{font-family:x;src:}"]) {
      const removed = clean(svg(rule));
      expect(removed.removedExternal, rule).toBe(false);
      expect(parsed(removed.svg).querySelector("style")!.textContent, rule).toBe("rect{fill:red}");
      expect(refuse(svg(rule)).ok, rule).toBe(true);
    }
  });

  it("keeps today's handling for url() and data sources", () => {
    for (const src of ["url(a.woff)", "local(x), url(data:font/woff2;base64,AAAA)", "url(#f)", "local(x) format('woff')"]) {
      const rule = `@font-face{font-family:x;src:${src}}`;
      expect(clean(svg(rule)).removedExternal, rule).toBe(true);
      expect(refuse(svg(rule)), rule).toEqual({ ok: false, error: "the SVG refers to a file or address outside the picture." });
    }
  });
});

describe("embedded bitmaps are listed for a decoder", () => {
  it("lists each distinct admitted bitmap once, with its format and header size", () => {
    const webp = btoa(String.fromCharCode(...webpVp8lHeader(3, 2)));
    const result = clean(`<svg ${NS}><image href="${PNG_DATA}"/><image href="${PNG_DATA}"/><image href="data:image/webp;base64,${webp}"/></svg>`);
    expect(result.embeddedBitmaps.map(bitmap => [bitmap.format, bitmap.mimeType, bitmap.width, bitmap.height]))
      .toEqual([["png", "image/png", 1, 1], ["webp", "image/webp", 3, 2]]);
  });
});

describe("benign drawings from common producers survive", () => {
  const ids = (svg: string, tag: string) => Array.from(parsed(svg).getElementsByTagName(tag)).map(element => element.getAttribute("id"));
  const href = (element: Element) => element.getAttribute("href") ?? element.getAttributeNS("http://www.w3.org/1999/xlink", "href");

  it("a vector editor's file: editor namespaces and RDF metadata go, gradients, styles and text stay", () => {
    const result = clean(EDITOR_SAMPLE);
    expect(result).toMatchObject({ removedExternal: false, removedActive: false });
    expectInert(result.svg);
    expect(result.svg).not.toMatch(/inkscape|sodipodi|rdf:/);
    const document = parsed(result.svg);
    expect(ids(result.svg, "linearGradient")).toEqual(["linearGradient2", "linearGradient3"]);
    expect(href(document.getElementById("linearGradient3")!)).toBe("#linearGradient2");
    expect(document.getElementsByTagName("stop")).toHaveLength(2);
    expect(document.getElementById("path1")!.getAttribute("style")).toBe("fill:url(#linearGradient3);fill-opacity:1;stroke:#000000;stroke-width:0.5;stroke-linejoin:round");
    expect(document.getElementById("tspan1")!.textContent).toBe("C₆H₆");
    expect(clean(result.svg).svg).toBe(result.svg);
  });

  it("a plotting library's file: glyph uses, clip paths and the style block stay", () => {
    const result = clean(PLOT_SAMPLE);
    expect(result).toMatchObject({ removedExternal: false, removedActive: false });
    const document = parsed(result.svg);
    expect(Array.from(document.getElementsByTagName("use")).map(href)).toEqual(["#Glyph-30", "#Glyph-2e"]);
    expect(document.querySelector("#line2d_1 path")!.getAttribute("clip-path")).toBe("url(#p1a2b3c4d5e)");
    expect(document.getElementById("p1a2b3c4d5e")!.getElementsByTagName("rect")).toHaveLength(1);
    expect(document.querySelector("style")!.textContent).toBe("*{stroke-linejoin: round;stroke-linecap: butt}");
    expect(document.querySelector("#line2d_1 path")!.getAttribute("style")).toBe("fill: none;stroke: #1f77b4;stroke-width: 1.5;stroke-linecap: square");
  });

  it("a diagram editor's file: the HTML label goes, its SVG text fallback and the shapes stay visible", () => {
    const result = clean(DIAGRAM_SAMPLE);
    expect(result.removedActive).toBe(true);
    // The footer link: its text stays, inside an inert <a>.
    expect(result.removedExternal).toBe(true);
    expectInert(result.svg);
    const document = parsed(result.svg);
    const fallback = document.querySelector("switch text")!;
    expect(fallback.textContent).toBe("Reagent A");
    // The fallback is now the switch's first child, so a viewer shows it.
    expect(fallback.parentElement!.firstElementChild).toBe(fallback);
    expect(document.querySelector("rect")!.getAttribute("fill")).toBe("rgb(255, 255, 255)");
    expect(document.getElementsByTagName("path")).toHaveLength(2);
    expect(sanitizeSvgPicture(DIAGRAM_SAMPLE, { outsideReferences: "refuse" }).ok).toBe(true);
  });

  it("a cheminformatics toolkit's file: its namespace and metadata go, bonds and atoms stay", () => {
    const result = clean(TOOLKIT_SAMPLE);
    expect(result).toMatchObject({ removedExternal: false, removedActive: false });
    expect(result.svg).not.toContain("rdkit:");
    const paths = Array.from(parsed(result.svg).getElementsByTagName("path"));
    expect(paths.map(path => path.getAttribute("class"))).toEqual(["bond-0 atom-0 atom-1", "bond-1 atom-1 atom-2", "atom-2"]);
    expect(paths[2]!.getAttribute("fill")).toBe("#FF0000");
    expect(paths[0]!.getAttribute("style")).toContain("stroke:#000000;stroke-width:2.0px");
  });

  it("every sample also passes the renderer's refusing policy", () => {
    for (const sample of [EDITOR_SAMPLE, PLOT_SAMPLE, DIAGRAM_SAMPLE, TOOLKIT_SAMPLE]) {
      expect(sanitizeSvgPicture(sample, { outsideReferences: "refuse" }).ok).toBe(true);
    }
  });
});
