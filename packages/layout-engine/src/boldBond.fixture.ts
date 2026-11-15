import { MoleculeObjectSchema, createEmptyDocument, createCustomPageLayout } from "@chemdraft/chem-core";

/** Original geometry, in native units: a regular 48-unit ring and a 120-degree chain. */
export function boldBondFixture(kind: "ring" | "double" | "chain" | "ibuprofen") {
  const ring = [[75, 50], [75, 98], [75 + 24 * Math.sqrt(3), 122],
    [75 + 48 * Math.sqrt(3), 98], [75 + 48 * Math.sqrt(3), 50], [75 + 24 * Math.sqrt(3), 26],
    [75 - 24 * Math.sqrt(3), 26], [75 - 24 * Math.sqrt(3), 2]];
  const chain = [[35, 85], [75, 62], [123, 62], [163, 85]];
  const h = 24 * Math.sqrt(3);
  // Ibuprofen topology, drawn independently: a0 carries isobutyl and a3 the acid
  // side chain. The bold a0–a1 double meets a ring bond AND a substituent at a0.
  const ibuprofen = [[120, 80], [144, 80 - h], [192, 80 - h], [216, 80], [192, 80 + h], [144, 80 + h],
    [72, 80], [48, 80 + h], [0, 80 + h], [72, 80 + 2 * h],
    [264, 80], [288, 80 - h], [288, 80 + h], [336, 80 + h], [264, 80 + 2 * h]];
  const edges = kind === "chain" ? [[0, 1], [1, 2], [2, 3]]
    : kind === "ibuprofen" ? [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0],
      [0, 6], [6, 7], [7, 8], [7, 9], [3, 10], [10, 11], [10, 12], [12, 13], [12, 14]]
    : [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [0, 6], [6, 7]];
  const boldIndex = kind === "chain" ? 1 : 0;
  const object = MoleculeObjectSchema.parse({
    id: "bold-fixture", type: "molecule", x: 0, y: 0, width: 200, height: 140,
    structureFormat: "smiles", structure: kind === "chain" ? "CCCC" : kind === "ibuprofen"
      ? "CC(C)Cc1ccc(cc1)C(C)C(=O)O" : kind === "double" ? "CCc1ccccc1" : "CCC1CCCCC1",
    style: { bondStrokeWidthPx: 2, bondLengthPx: 48, multipleBondGapPx: 8,
      bondSpacingMode: "fixed", doubleBondInsetPx: 7, bondLineCap: "butt" },
    atoms: (kind === "chain" ? chain : kind === "ibuprofen" ? ibuprofen : ring)
      .map(([x, y], i) => ({ id: `a${i}`, element: kind === "ibuprofen" && i >= 13 ? "O" : "C", x, y })),
    bonds: edges.map(([from, to], i) => ({ id: `b${i}`, fromAtomId: `a${from}`, toAtomId: `a${to}`,
      order: (kind === "double" || kind === "ibuprofen") && [0, 2, 4, 13].includes(i) ? "double" : "single",
      ...(i === boldIndex ? { display: { bondStyle: "bold" } } : {}) }))
  });
  const document = createEmptyDocument({ now: "2026-11-15T00:00:00.000Z" });
  const width = kind === "ibuprofen" ? 380 : 200, height = kind === "ibuprofen" ? 200 : 140;
  object.width = width; object.height = height;
  document.pages[0]!.width = width;
  document.pages[0]!.height = height;
  document.pages[0]!.layout = createCustomPageLayout(width, height, "css-px", { top: 0, right: 0, bottom: 0, left: 0 });
  document.pages[0]!.objects = [object];
  return { document, object, boldId: `b${boldIndex}` };
}
