// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { boldBondFixture } from "../../../packages/layout-engine/src/boldBond.fixture";
import { MainWindow } from "./MainWindow";
import { copyAsScopedDocument, exportPhase4Svg } from "./documentWorkflow";

describe("bold canvas / SVG / clipboard-image parity", () => {
  it.each(["ring", "double", "chain"] as const)("uses the same filled band for %s", async kind => {
    const { document, boldId } = boldBondFixture(kind);
    const before = JSON.stringify(document);
    const canvas = new JSDOM(renderToStaticMarkup(createElement(MainWindow, {
      initialDocument: document, initialPaletteMode: "hidden", nativePalette: true
    })));
    const exported = new JSDOM(exportDocumentToSvg(document).contents, { contentType: "image/svg+xml" });
    // This is the exact document/SVG path used by Copy As PNG before native/browser rasterization.
    const clipboardSvg = await exportPhase4Svg(copyAsScopedDocument(document), { includeWarnings: false });
    const clipboard = new JSDOM(clipboardSvg.contents, { contentType: "image/svg+xml" });
    try {
      const selector = `[data-bond-id="${boldId}"][data-bond-order]`;
      const elements = (dom: JSDOM) => [...dom.window.document.querySelectorAll(selector)];
      const attributes = (dom: JSDOM) => elements(dom).map(element => ({ tag: element.tagName,
        attrs: Object.fromEntries([...element.attributes].filter(a => a.name !== "class").map(a => [a.name, a.value])) }));
      expect(attributes(canvas)).toEqual(attributes(exported));
      expect(elements(canvas).map(e => e.tagName)).toEqual(kind === "double" ? ["polygon", "line"] : ["polygon"]);
      const normalizedBand = (dom: JSDOM) => {
        const band = elements(dom).find(e => e.tagName === "polygon")!;
        const points = band.getAttribute("points")!.split(" ").map(p => p.split(",").map(Number));
        return points.map(([x, y]) => [Number((x! - points[0]![0]!).toFixed(2)), Number((y! - points[0]![1]!).toFixed(2))]);
      };
      expect(normalizedBand(clipboard)).toEqual(normalizedBand(canvas));
      if (kind === "double") {
        for (const dom of [canvas, exported, clipboard]) expect(elements(dom)[1]!.getAttribute("stroke-width")).toBe("2");
      }
      // Compare real RGBA ink from the React canvas polygon/pi attributes with the SVG export.
      const render = (dom: JSDOM) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="560" viewBox="0 0 200 140">${elements(dom).map(e => e.outerHTML).join("")}</svg>`).render();
      expect(render(canvas).pixels.equals(render(exported).pixels)).toBe(true);
      const png = new Resvg(clipboardSvg.contents).render().asPng();
      expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(clipboardSvg.warnings).toEqual([]);
      expect(JSON.stringify(document)).toBe(before);
    } finally { canvas.window.close(); exported.window.close(); clipboard.window.close(); }
  });
});
