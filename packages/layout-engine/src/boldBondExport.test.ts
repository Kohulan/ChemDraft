// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { exportDocumentToSvg } from "../../export-engine/src/svg";
import { exportDocumentToPdf } from "../../export-engine/src/pdf";
import { planPageSvgRender } from "./index";
import { elementFragments } from "./testing";
import { boldBondFixture } from "./boldBond.fixture";

describe("adjacent bold band canvas/export parity", () => {
  for (const count of [2, 3, 6]) {
    it.each([false, true])(`exports the same ${count} joined bands in SVG and PDF (reversed %s)`, async reversed => {
      const { document, object } = boldBondFixture("double");
      for (let i = 0; i < count; i++) {
        const bond = object.bonds[i]!;
        bond.display = { ...bond.display, bondStyle: "bold" };
        if (reversed) [bond.fromAtomId, bond.toAtomId] = [bond.toAtomId, bond.fromAtomId];
      }
      const bands = planPageSvgRender(document.pages[0]!).fragments.flatMap(elementFragments)
        .filter(f => f.tag === "polygon" && String(f.attrs.class).includes("native-bond-line"));
      expect(bands).toHaveLength(count);
      const svg = new DOMParser().parseFromString(exportDocumentToSvg(document).contents, "image/svg+xml");
      for (const band of bands) {
        const exported = svg.querySelector(`polygon[data-bond-id="${band.attrs["data-bond-id"]}"]`);
        expect(exported?.getAttribute("points")).toBe(band.attrs.points);
      }
      const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
      const bbox = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox");
      Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true,
        value: () => ({ x: 0, y: 0, width: 10, height: 10 }) });
      try {
        const result = await exportDocumentToPdf(document, { compress: false, includePageGuides: false });
        const pdf = Buffer.from(result.bytes).toString("latin1");
        // Verify painted PDF vertices, beyond checking the SVG supplied to svg2pdf.
        const paths = [...pdf.matchAll(/([-\d.]+) ([-\d.]+) m\n((?:[-\d.]+ [-\d.]+ l\n)+)h\nf\n/g)];
        const vertices = paths.map(match => [Number(match[1]), Number(match[2]),
          ...[...match[3]!.matchAll(/([-\d.]+) ([-\d.]+) l/g)].flatMap(p => [Number(p[1]), Number(p[2])])]);
        for (const band of bands) {
          expect(vertices).toContainEqual(String(band.attrs.points).split(" ").flatMap(p => p.split(",").map(Number)));
        }
        expect(result.warnings).toEqual([]);
        expect(pdf).not.toContain("/Subtype /Image");
      } finally {
        context.mockRestore();
        if (bbox) Object.defineProperty(SVGElement.prototype, "getBBox", bbox);
        else Reflect.deleteProperty(SVGElement.prototype, "getBBox");
      }
    });
  }
});
