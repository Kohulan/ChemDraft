import { describe, expect, it } from "vitest";
import { bracketKindForToolCommand, createPhase4Document, insertNativeBracket } from "./documentWorkflow";
import { getDrawingToolDefinition } from "./drawingTools";

describe("current curly bracket pair tool", () => {
  it.each([undefined, { x: 250, y: 220 }])("creates and selects both curly halves (drag end: %j)", end => {
    const kind = bracketKindForToolCommand("tool.bracket")!;
    expect(kind).toBe("curly");
    const document = insertNativeBracket(createPhase4Document("Curly pair"), { x: 100, y: 100 }, kind, end);
    const pair = document.pages[0].objects.filter(object => object.type === "bracket");
    expect(pair).toHaveLength(2);
    expect(pair.map(object => object.side)).toEqual(["open", "close"]);
    expect(pair[0]!.pairId).toBeTruthy();
    expect(pair[1]!.pairId).toBe(pair[0]!.pairId);
    expect(pair.every(object => object.bracketKind === "curly")).toBe(true);
    expect(document.selection.objectIds).toEqual(pair.map(object => object.id));
  });
  it("describes the implemented pair gesture instead of the retired single-glyph behavior", () => {
    const hint = getDrawingToolDefinition("tool.bracket")!.usageHint!;
    expect(hint.action).toBe("drag around a repeat unit");
    expect(hint.optionalActions).toBe("click to place a default pair");
  });
});
