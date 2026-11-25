// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { installDropNavigationGuard } from "./dropNavigationGuard";

function dragEvent(type: "dragover" | "drop", types: string[]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const dataTransfer = { types, dropEffect: "move" };
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return { event, dataTransfer };
}

describe("installDropNavigationGuard", () => {
  let remove: (() => void) | undefined;
  afterEach(() => { remove?.(); remove = undefined; document.body.replaceChildren(); });

  it("prevents a file drop anywhere, showing copy only where the window takes files", () => {
    remove = installDropNavigationGuard(window, { acceptsFiles: target => (target as Element).id === "canvas" });
    const canvas = Object.assign(document.createElement("div"), { id: "canvas" });
    const toolbar = document.createElement("div");
    document.body.append(canvas, toolbar);
    for (const [target, effect] of [[canvas, "copy"], [toolbar, "none"]] as const) {
      const over = dragEvent("dragover", ["Files"]);
      target.dispatchEvent(over.event);
      expect(over.event.defaultPrevented).toBe(true);
      expect(over.dataTransfer.dropEffect).toBe(effect);
      const drop = dragEvent("drop", ["Files"]);
      target.dispatchEvent(drop.event);
      expect(drop.event.defaultPrevented).toBe(true);
    }
  });

  it("refuses files in a utility window and never lets a link drop navigate", () => {
    remove = installDropNavigationGuard(window);
    const palette = document.createElement("div");
    document.body.append(palette);
    const files = dragEvent("dragover", ["Files"]);
    palette.dispatchEvent(files.event);
    expect([files.event.defaultPrevented, files.dataTransfer.dropEffect]).toEqual([true, "none"]);
    const link = dragEvent("drop", ["text/uri-list", "text/plain"]);
    palette.dispatchEvent(link.event);
    expect(link.event.defaultPrevented).toBe(true);
  });

  it("leaves text drag and drop into editable fields alone", () => {
    remove = installDropNavigationGuard(window);
    const input = document.createElement("input");
    const area = document.createElement("textarea");
    const editable = Object.assign(document.createElement("div"), { contentEditable: "true" });
    const inner = document.createElement("span");
    editable.setAttribute("contenteditable", "true");
    editable.append(inner);
    document.body.append(input, area, editable);
    for (const target of [input, area, inner]) {
      for (const type of ["dragover", "drop"] as const) {
        const text = dragEvent(type, ["text/plain"]);
        target.dispatchEvent(text.event);
        expect(text.event.defaultPrevented, `${type} on ${target.nodeName}`).toBe(false);
      }
    }
    const checkbox = Object.assign(document.createElement("input"), { type: "checkbox" });
    document.body.append(checkbox);
    const text = dragEvent("drop", ["text/plain"]);
    checkbox.dispatchEvent(text.event);
    expect(text.event.defaultPrevented).toBe(true);
  });

  it("keeps a nearer handler's own drop effect and stops after removal", () => {
    remove = installDropNavigationGuard(window);
    const target = document.createElement("div");
    document.body.append(target);
    target.addEventListener("dragover", event => { event.preventDefault(); (event as DragEvent).dataTransfer!.dropEffect = "copy"; });
    const over = dragEvent("dragover", ["Files"]);
    target.dispatchEvent(over.event);
    expect(over.dataTransfer.dropEffect).toBe("copy");
    remove();
    remove = undefined;
    const after = dragEvent("drop", ["text/uri-list"]);
    document.body.dispatchEvent(after.event);
    expect(after.event.defaultPrevented).toBe(false);
  });
});
