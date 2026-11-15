import { MoleculeObjectSchema, createEmptyDocument, createCustomPageLayout } from "@chemdraft/chem-core";

/** Original geometry, in native units: a regular 48-unit ring and a 120-degree chain. */
export function boldBondFixture(kind: "ring" | "double" | "chain") {
  const ring = [[75, 50], [75, 98], [75 + 24 * Math.sqrt(3), 122],
    [75 + 48 * Math.sqrt(3), 98], [75 + 48 * Math.sqrt(3), 50], [75 + 24 * Math.sqrt(3), 26],
    [75 - 24 * Math.sqrt(3), 26], [75 - 24 * Math.sqrt(3), 2]];
  const chain = [[35, 85], [75, 62], [123, 62], [163, 85]];
  const edges = kind === "chain" ? [[0, 1], [1, 2], [2, 3]]
    : [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [0, 6], [6, 7]];
  const boldIndex = kind === "chain" ? 1 : 0;
  const object = MoleculeObjectSchema.parse({
    id: "bold-fixture", type: "molecule", x: 0, y: 0, width: 200, height: 140,
    structureFormat: "smiles", structure: kind === "chain" ? "CCCC" : kind === "double" ? "CCc1ccccc1" : "CCC1CCCCC1",
    style: { bondStrokeWidthPx: 2, bondLengthPx: 48, multipleBondGapPx: 8,
      bondSpacingMode: "fixed", doubleBondInsetPx: 7, bondLineCap: "butt" },
    atoms: (kind === "chain" ? chain : ring).map(([x, y], i) => ({ id: `a${i}`, element: "C", x, y })),
    bonds: edges.map(([from, to], i) => ({ id: `b${i}`, fromAtomId: `a${from}`, toAtomId: `a${to}`,
      order: kind === "double" && [0, 2, 4].includes(i) ? "double" : "single",
      ...(i === boldIndex ? { display: { bondStyle: "bold" } } : {}) }))
  });
  const document = createEmptyDocument({ now: "2026-11-15T00:00:00.000Z" });
  document.pages[0]!.width = 200;
  document.pages[0]!.height = 140;
  document.pages[0]!.layout = createCustomPageLayout(200, 140, "css-px", { top: 0, right: 0, bottom: 0, left: 0 });
  document.pages[0]!.objects = [object];
  return { document, object, boldId: `b${boldIndex}` };
}
