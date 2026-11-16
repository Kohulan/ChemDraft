/** Value-encoded drawing tool IDs; retain the released IDs for ordinary bond tools. */
export function bondDrawingToolCommandId(order: "single" | "double" | "triple", stereo?: "either"): string {
  if (stereo === "either") {
    if (order !== "double") throw new Error("Either stereo requires a double bond tool.");
    return "tool.doubleBond:either";
  }
  return order === "single" ? "tool.bond" : `tool.${order}Bond`;
}
