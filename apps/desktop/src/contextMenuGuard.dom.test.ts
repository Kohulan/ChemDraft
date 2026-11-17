// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { installContextMenuGuard } from "./contextMenuGuard";

afterEach(() => { document.body.replaceChildren(); });

it("suppresses browser menus on palette surfaces and editable fields", () => {
  const stop = installContextMenuGuard();
  const palette = document.createElement("div");
  const button = document.createElement("button");
  const input = document.createElement("input");
  const textarea = document.createElement("textarea");
  const editable = document.createElement("div");
  editable.setAttribute("contenteditable", "true");
  const child = document.createElement("span");
  editable.append(child);
  palette.append(button, input, textarea, editable);
  document.body.append(palette);
  const menu = (target: Element) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(menu(palette)).toBe(true);
  expect(menu(button)).toBe(true);
  expect(menu(input)).toBe(true);
  expect(menu(textarea)).toBe(true);
  expect(menu(child)).toBe(true);
  stop();
  expect(menu(palette)).toBe(false);
});
