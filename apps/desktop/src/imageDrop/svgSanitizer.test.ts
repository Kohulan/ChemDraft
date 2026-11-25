// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { hasUnsafeCssReference, sanitizeDroppedSvg, sanitizeSvgStylesheet, type SvgSanitizeResult } from "./svgSanitizer";
import { PNG_1X1_BASE64 } from "./testFixtures";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
const PNG_DATA = `data:image/png;base64,${PNG_1X1_BASE64}`;

function clean(source: string): Extract<SvgSanitizeResult, { ok: true }> {
  const result = sanitizeDroppedSvg(source);
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
    expect(["script", "foreignObject", "iframe", "object", "embed", "audio", "video", "a", "animate", "set",
      "animateMotion", "animateTransform", "handler"]).not.toContain(element.localName);
    for (const attribute of Array.from(element.attributes)) {
      expect(attribute.localName.toLowerCase().startsWith("on")).toBe(false);
      if (attribute.localName === "href") expect(attribute.value).toMatch(/^#|^data:image\/(png|jpeg|gif|webp);base64,/);
      expect(attribute.localName === "base" && attribute.namespaceURI === "http://www.w3.org/XML/1998/namespace").toBe(false);
      expect(hasUnsafeCssReference(attribute.value)).toBe(false);
    }
  }
  expect(svg).not.toMatch(/javascript:|@import|<\?xml-stylesheet|<!DOCTYPE|<!ENTITY/i);
}

describe("sanitizeDroppedSvg attacks", () => {
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

  it("keeps a link's children and transform as a group", () => {
    const result = clean(`<svg ${NS}><a href="https://e.test" transform="translate(3 4)"><circle id="c" r="2"/></a></svg>`);
    const circle = parsed(result.svg).getElementById("c")!;
    expect(circle.parentElement?.localName).toBe("g");
    expect(circle.parentElement?.getAttribute("transform")).toBe("translate(3 4)");
    expect(result.removedExternal).toBe(true);
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
      expect(sanitizeDroppedSvg(source).ok, source).toBe(false);
    }
  });

  it("drops a DOCTYPE without an internal subset", () => {
    const result = clean(`<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg ${NS}><rect width="1" height="1"/></svg>`);
    expect(result.svg).not.toContain("DOCTYPE");
    expect(result.removedExternal).toBe(false);
  });

  it("refuses over-deep nesting and too many elements before parsing", () => {
    const deep = `<svg ${NS}>${"<g>".repeat(200)}${"</g>".repeat(200)}</svg>`;
    expect(sanitizeDroppedSvg(deep)).toMatchObject({ ok: false, error: expect.stringContaining("levels deep") });
    const many = `<svg ${NS}>${"<g/>".repeat(200_001)}</svg>`;
    expect(sanitizeDroppedSvg(many)).toMatchObject({ ok: false, error: expect.stringContaining("elements") });
  });

  it("adds the SVG namespace that hand-written files often omit", () => {
    const result = clean(`<svg width="4" height="2"><rect width="4" height="2"/></svg>`);
    expect(parsed(result.svg).documentElement.namespaceURI).toBe("http://www.w3.org/2000/svg");
  });
});

describe("sanitizeDroppedSvg keeps benign drawings", () => {
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
    expect(document.querySelector("rect.a")?.getAttribute("filter")).toBe("url( '#f' )");
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
  });

  it("is idempotent: sanitizing its own output changes nothing", () => {
    const once = clean(`<svg ${NS} width="3" height="3"><style>/* c */ rect { fill : blue ; }</style><rect width="3" height="3"/></svg>`);
    expect(clean(once.svg).svg).toBe(once.svg);
  });
});

describe("sanitizeSvgStylesheet", () => {
  it("keeps keyframes and supports blocks, drops unknown at-rules", () => {
    const state = { removedExternal: false, removedActive: false };
    expect(sanitizeSvgStylesheet("@keyframes k{from{opacity:0}to{opacity:1}} @supports (fill:red){rect{fill:red}} @namespace x url(y);", state))
      .toBe("@keyframes k{from{opacity:0}\nto{opacity:1}}\n@supports (fill:red){rect{fill:red}}");
    expect(state.removedExternal).toBe(true);
  });
});
