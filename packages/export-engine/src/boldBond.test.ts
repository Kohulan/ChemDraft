// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { planPageSvgRender } from "@chemdraft/layout-engine";
import { elementFragments } from "@chemdraft/layout-engine/testing";
import { boldBondFixture } from "../../layout-engine/src/boldBond.fixture";
import { exportDocumentToPdf } from "./pdf";

describe("bold vector PDF", () => {
  it("fills the shared polygon and strokes only the normal-width pi line", async () => {
    const { document, object } = boldBondFixture("double");
    // Isolate one bold double; retaining an explicit side preserves its one-sided plan.
    object.atoms = object.atoms.slice(0, 2);
    object.bonds = [object.bonds[0]!];
    object.bonds[0]!.display!.doubleBondSide = "right";
    const polygon = planPageSvgRender(document.pages[0]!).fragments.flatMap(elementFragments)
      .find(f => f.tag === "polygon")!;
    const points = String(polygon.attrs.points).split(" ").map(p => p.split(",").map(Number));
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    try {
      const result = await exportDocumentToPdf(document, { compress: false, includePageGuides: false });
      const pdf = Buffer.from(result.bytes).toString("latin1");
      // svg2pdf emits the polygon in the original user coordinates under a page transform.
      // Match actual PDF path vertices and the fill operator, not just input SVG markup.
      const paths = [...pdf.matchAll(/([-\d.]+) ([-\d.]+) m\n((?:[-\d.]+ [-\d.]+ l\n)+)h\nf\n/g)];
      const vertices = paths.map(match => [Number(match[1]), Number(match[2]),
        ...[...match[3]!.matchAll(/([-\d.]+) ([-\d.]+) l/g)].flatMap(p => [Number(p[1]), Number(p[2])])]);
      expect(vertices).toContainEqual(points.flat());
      expect(pdf).toMatch(/\n2\.?0* w\n/);
      expect(pdf).not.toMatch(/\n6\.8\d* w\n/);
      expect(pdf).not.toContain("/Subtype /Image");
      expect(result.warnings).toEqual([]);
    } finally { context.mockRestore(); }
  });
});
