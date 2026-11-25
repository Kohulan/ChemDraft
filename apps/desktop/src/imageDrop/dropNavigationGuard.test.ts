// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { installDropNavigationGuard, isEditableDropTarget } from "./dropNavigationGuard";

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

  it("reads contenteditable as the browser does: case-insensitive, never trimmed", () => {
    const host = document.createElement("div");
    host.setAttribute("contenteditable", "TRUE");
    // " false " is not "false": an invalid value, so it inherits the editable host.
    const padded = document.createElement("span");
    padded.setAttribute("contenteditable", " false ");
    const closed = document.createElement("span");
    closed.setAttribute("contenteditable", "False");
    // The empty string and plaintext-only (in any case) are editable states of their own.
    const empty = document.createElement("span");
    empty.setAttribute("contenteditable", "");
    const plain = document.createElement("span");
    plain.setAttribute("contenteditable", "PlainText-Only");
    closed.append(empty, plain);
    host.append(padded, closed);
    expect(isEditableDropTarget(host)).toBe(true);
    expect(isEditableDropTarget(padded)).toBe(true);
    expect(isEditableDropTarget(closed)).toBe(false);
    expect(isEditableDropTarget(empty)).toBe(true);
    expect(isEditableDropTarget(plain)).toBe(true);
    const island = document.createElement("span");
    island.setAttribute("contenteditable", "false");
    const reopened = document.createElement("span");
    reopened.setAttribute("contenteditable", " true");
    island.append(reopened);
    expect(isEditableDropTarget(reopened)).toBe(false);
  });

  it("uses the nearest editing boundary and lets only text-compatible drags edit", () => {
    remove = installDropNavigationGuard(window);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const island = document.createElement("div");
    island.setAttribute("contenteditable", "false");
    const islandChild = document.createElement("span");
    island.append(islandChild);
    // An invalid value inherits: inside the island it is still not editable.
    const inherited = document.createElement("span");
    inherited.setAttribute("contenteditable", "maybe");
    island.append(inherited);
    const reopened = document.createElement("span");
    reopened.setAttribute("contenteditable", "plaintext-only");
    island.append(reopened);
    editable.append(island);
    document.body.append(editable);
    for (const target of [island, islandChild, inherited]) {
      const link = dragEvent("drop", ["text/uri-list"]);
      target.dispatchEvent(link.event);
      expect(link.event.defaultPrevented, target.nodeName).toBe(true);
    }
    const text = dragEvent("drop", ["text/plain"]);
    reopened.dispatchEvent(text.event);
    expect(text.event.defaultPrevented).toBe(false);
    // An editable target still refuses a drag that is not text.
    const opaque = dragEvent("drop", ["application/x-custom"]);
    editable.dispatchEvent(opaque.event);
    expect(opaque.event.defaultPrevented).toBe(true);
    const field = document.createElement("input");
    document.body.append(field);
    const none = dragEvent("dragover", []);
    field.dispatchEvent(none.event);
    expect([none.event.defaultPrevented, none.dataTransfer.dropEffect]).toEqual([true, "none"]);
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
