// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyToolsetLayoutState, type ToolsetLayoutState } from "@chemdraft/toolset-registry";
import { SHELL_COMMAND_IDS } from "../../shellCommandIds";
import type { DesktopToolsetDefinition } from "../../toolsets";
import { filterToolbarCustomizationCommands } from "../toolbarCustomizationCommands";
import { CustomizeToolbarsDialog } from "./CustomizeToolbarsDialog";

vi.mock("../../drawingTools", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../drawingTools")>(),
  TRANSITIONAL_STUB_COMMAND_IDS: new Set(["tool.testStub"])
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// React tracks input value/checked itself, so a raw `input.value = …` is ignored. Use the native
// setter + an input event so React's onChange sees the change (the pattern the ToolPalette tests use).
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const baseToolsets: DesktopToolsetDefinition[] = [
  {
    id: "core.main",
    title: "Main Toolbar",
    source: "core",
    defaultVisible: true,
    defaultMode: "floating",
    groups: [{ id: "core.main.g", items: [{ id: "tool.a", kind: "button", label: "A", primary: { type: "command", commandId: "tool.a" }, submenu: null }] }]
  },
  {
    id: "core.art",
    title: "Art Toolbar",
    source: "core",
    defaultVisible: false,
    defaultMode: "floating",
    groups: [{ id: "core.art.g", items: [{ id: "tool.b", kind: "button", label: "B", primary: { type: "command", commandId: "tool.b" }, submenu: null }] }]
  },
  {
    id: "plugin.fixture",
    title: "Fixture Toolbar",
    source: "plugin",
    defaultVisible: false,
    defaultMode: "floating",
    groups: [{ id: "plugin.fixture.g", items: [{ commandId: "plugin.fixture.ping", label: "Ping" }] }]
  }
];

const emptyState: ToolsetLayoutState = { version: 1, toolsetOverrides: [], userToolsets: [] };

describe("CustomizeToolbarsDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onApply: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  const circle = { id: "tool.art.circle", title: "Circle", icon: "bracket", assetName: "Art_Circle" } as const;
  const availableCommands = filterToolbarCustomizationCommands([
    { id: "tool.a", title: "A" },
    { id: "tool.b", title: "B" },
    { id: "plugin.fixture.ping", title: "Ping" },
    circle,
    { id: "tool.testStub", title: "Unimplemented Test Tool" },
    { id: "tool.art.rectShadow", title: "Shadow Rectangle" },
    { id: "edit.undo", title: "Undo", enabled: false, disabledReason: "Nothing to undo" }
  ], { enabled: false });

  function render(state: ToolsetLayoutState = emptyState) {
    onApply = vi.fn();
    onClose = vi.fn();
    act(() => {
      root.render(createElement(CustomizeToolbarsDialog, { baseToolsets, layoutState: state, availableCommands, onApply, onClose }));
    });
  }

  function clickButton(predicate: (button: HTMLButtonElement) => boolean) {
    const button = [...container.querySelectorAll("button")].find(predicate);
    expect(button).toBeDefined();
    act(() => button!.click());
  }

  function click(selector: string) {
    const element = container.querySelector<HTMLElement>(selector);
    expect(element, selector).not.toBeNull();
    act(() => element!.click());
  }

  function openPicker() {
    clickButton((button) => button.textContent === "Add command…");
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search commands to add"]');
    expect(search).not.toBeNull();
    return search!;
  }

  function applied(): ToolsetLayoutState {
    const apply = container.querySelector<HTMLButtonElement>(".customize-toolbars-apply");
    act(() => apply?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    return onApply.mock.calls.at(-1)?.[0];
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders a row per toolset with current visibility", () => {
    render();
    const rows = container.querySelectorAll("[data-toolset-id]");
    expect([...rows].map((row) => row.getAttribute("data-toolset-id"))).toEqual(["core.main", "core.art", "plugin.fixture"]);
    const mainVisible = container.querySelector<HTMLInputElement>('[data-toolset-id="core.main"] .customize-toolset-visible');
    expect(mainVisible?.checked).toBe(true);
    const artVisible = container.querySelector<HTMLInputElement>('[data-toolset-id="core.art"] .customize-toolset-visible');
    expect(artVisible?.checked).toBe(false);
  });

  it("toggles visibility into the applied state", () => {
    render();
    const artVisible = container.querySelector<HTMLInputElement>('[data-toolset-id="core.art"] .customize-toolset-visible');
    // core.art starts unchecked; a click toggles it on and fires React's onChange.
    act(() => artVisible!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(applied().toolsetOverrides).toContainEqual({ toolsetId: "core.art", visible: true });
  });

  it("commits a rename on Enter", () => {
    render();
    const title = container.querySelector<HTMLInputElement>('[data-toolset-id="core.main"] .customize-toolset-title');
    act(() => {
      setInputValue(title!, "My Main");
      title!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(applied().toolsetOverrides).toContainEqual({ toolsetId: "core.main", title: "My Main" });
  });

  it("keeps Escape inside a rename field from discarding the whole session's edits", () => {
    render();
    // A live-applied edit first: hiding a toolbar. Escape in a text field must not roll it back.
    const artVisible = container.querySelector<HTMLInputElement>('[data-toolset-id="core.art"] .customize-toolset-visible');
    act(() => artVisible!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const title = container.querySelector<HTMLInputElement>('[data-toolset-id="core.main"] .customize-toolset-title');
    act(() => {
      setInputValue(title!, "Half-typed name");
      title!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    // The dialog is still open and the earlier edit survives.
    expect(onClose).not.toHaveBeenCalled();
    expect(applied().toolsetOverrides).toContainEqual({ toolsetId: "core.art", visible: true });
  });

  it("still closes on Escape outside a text field", () => {
    render();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("creates a user toolbar", () => {
    render();
    const nameInput = container.querySelector<HTMLInputElement>('[aria-label="New toolbar name"]');
    act(() => setInputValue(nameInput!, "My Tools"));
    const createButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Create Toolbar");
    act(() => createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector('[data-toolset-id="user.my-tools"]')).not.toBeNull();
    const state = applied();
    expect(state.userToolsets.map((toolset) => toolset.id)).toEqual(["user.my-tools"]);
  });

  it("duplicates a built-in toolset into a user copy and lets it be deleted", () => {
    render();
    const cloneButton = container.querySelector<HTMLButtonElement>('[data-toolset-id="core.main"] .customize-toolset-action');
    act(() => cloneButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const cloneRow = container.querySelector('[data-toolset-id="user.main-toolbar-copy"]');
    expect(cloneRow).not.toBeNull();
    // The clone (a user toolset) exposes a Delete button; core toolsets don't.
    expect(container.querySelector('[data-toolset-id="core.main"] .customize-toolset-delete')).toBeNull();
    const deleteButton = cloneRow!.querySelector<HTMLButtonElement>(".customize-toolset-delete");
    act(() => deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector('[data-toolset-id="user.main-toolbar-copy"]')).toBeNull();
  });

  it("shows the selected toolset's items and hides one", () => {
    render();
    // core.main is selected by default; its item tool.a shows in the detail pane, visible.
    const item = container.querySelector('[data-item-id="tool.a"]');
    expect(item).not.toBeNull();
    const visible = item!.querySelector<HTMLInputElement>(".customize-item-visible");
    expect(visible?.checked).toBe(true);
    act(() => visible!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(applied().toolsetOverrides).toContainEqual({ toolsetId: "core.main", hiddenCommandIds: ["tool.a"] });
  });

  it("adds a command to a user toolset via the palette", () => {
    render();
    const nameInput = container.querySelector<HTMLInputElement>('[aria-label="New toolbar name"]');
    act(() => setInputValue(nameInput!, "Mine"));
    clickButton((button) => button.textContent === "Create Toolbar");
    const search = openPicker();
    act(() => setInputValue(search, "Circle"));
    click(`[data-command-id="${circle.id}"]`);
    const state = applied();
    expect(state.toolsetOverrides).toEqual([]);
    expect(state.userToolsets.find((toolset) => toolset.id === "user.mine")?.groups[0]?.items).toMatchObject([
      { id: circle.id, icon: circle.icon, assetName: circle.assetName }
    ]);
  });

  it.each([
    ["core.main", "core.main.g", "tool.a"],
    ["plugin.fixture", "plugin.fixture.g", "plugin.fixture.ping"]
  ])("adds and removes a command via the override for %s", (toolsetId, groupId, manifestItemId) => {
    render();
    click(`[data-toolset-id="${toolsetId}"] .customize-toolset-title`);
    const manifestItem = container.querySelector(`[data-item-id="${manifestItemId}"]`)!;
    expect(manifestItem.querySelector(".customize-item-remove")).toBeNull();
    const search = openPicker();
    expect(container.querySelector(`[data-command-id="${manifestItemId}"]`)).toBeNull();
    act(() => setInputValue(search, circle.id));
    click(`[data-command-id="${circle.id}"]`);
    expect(container.querySelector(`[data-command-id="${circle.id}"]`)).toBeNull();
    expect(applied()).toEqual({
      ...emptyState,
      toolsetOverrides: [{
        toolsetId,
        itemAdditions: [{
          groupId,
          item: {
            id: circle.id, kind: "button", label: circle.title, icon: circle.icon, assetName: circle.assetName,
            primary: { type: "command", commandId: circle.id }, submenu: null
          }
        }]
      }]
    });
    click(`[data-item-id="${circle.id}"] .customize-item-visible`);
    click(`[data-item-id="${circle.id}"] .customize-item-remove`);
    expect(container.querySelector(`[data-item-id="${circle.id}"]`)).toBeNull();
    expect(container.querySelector(`[data-command-id="${circle.id}"]`)).not.toBeNull();
    expect(applied()).toEqual(emptyState);
  });

  it("resets a built-in toolbar to its manifest layout", () => {
    render();
    openPicker();
    click('[data-command-id="edit.undo"]');
    click('[data-item-id="tool.a"] .customize-item-visible');
    const edited = applyToolsetLayoutState(baseToolsets, applied(), { additionalCommandIds: SHELL_COMMAND_IDS });
    expect(edited.find((toolset) => toolset.id === "core.main")?.groups[0]?.items.map((item) => item.id))
      .toEqual(["edit.undo"]);
    click('[title="Reset Main Toolbar"]');
    expect(container.querySelector('[data-item-id="edit.undo"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[data-item-id="tool.a"] .customize-item-visible')?.checked).toBe(true);
    expect(applied()).toEqual(emptyState);
  });

  it("offers transiently disabled commands and excludes transitional stubs and compatibility-only variants", () => {
    render();
    openPicker();
    expect(container.querySelector('[data-command-id="tool.testStub"]')).toBeNull();
    expect(container.querySelector('[data-command-id="tool.art.rectShadow"]')).toBeNull();
    expect(container.querySelector('[data-command-id="edit.undo"]')?.textContent).toBe("+ Undo");
  });

  it("surfaces an in-place addition (spacer) as a row so it can be hidden there too", () => {
    const withSpacer: ToolsetLayoutState = {
      version: 1,
      userToolsets: [],
      toolsetOverrides: [
        {
          toolsetId: "core.main",
          itemAdditions: [
            {
              groupId: "core.main.g",
              index: 1,
              item: { id: "user.spacer.1", kind: "spacer", label: "Spacer", primary: { type: "none" }, layout: { rowSpan: 2 } }
            }
          ]
        }
      ]
    };
    render(withSpacer);
    const spacerRow = container.querySelector('[data-item-id="user.spacer.1"]');
    expect(spacerRow).not.toBeNull();
    const visible = spacerRow!.querySelector<HTMLInputElement>(".customize-item-visible");
    act(() => visible!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const override = applied().toolsetOverrides.find((entry) => entry.toolsetId === "core.main");
    expect(override?.hiddenCommandIds).toContain("user.spacer.1");
  });

  it("shows multiple additions in the registry's chronological insertion order", () => {
    render({
      version: 1,
      userToolsets: [],
      toolsetOverrides: [
        {
          toolsetId: "core.main",
          itemAdditions: [
            {
              groupId: "core.main.g",
              index: 1,
              item: { id: "user.spacer.1", kind: "spacer", label: "First", primary: { type: "none" } }
            },
            {
              groupId: "core.main.g",
              index: 0,
              item: { id: "user.spacer.2", kind: "spacer", label: "Second", primary: { type: "none" } }
            }
          ]
        }
      ]
    });

    expect([...container.querySelectorAll("[data-item-id]")].map((row) => row.getAttribute("data-item-id"))).toEqual([
      "user.spacer.2",
      "tool.a",
      "user.spacer.1"
    ]);
  });

  it("preserves a shell-only toolbar addition when duplicating the effective toolbar", () => {
    render({
      version: 1,
      userToolsets: [],
      toolsetOverrides: [
        {
          toolsetId: "core.main",
          itemAdditions: [
            {
              groupId: "core.main.g",
              index: 1,
              item: {
                id: "edit.undo",
                kind: "button",
                label: "Undo",
                primary: { type: "command", commandId: "edit.undo" },
                submenu: null
              }
            }
          ]
        }
      ]
    });

    const cloneButton = container.querySelector<HTMLButtonElement>('[data-toolset-id="core.main"] .customize-toolset-action');
    act(() => cloneButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const clone = applied().userToolsets.find((toolset) => toolset.id === "user.main-toolbar-copy");
    expect(clone?.groups.flatMap((group) => group.items).map((item) => item.id ?? item.commandId)).toContain("edit.undo");
  });

  it("duplicates the on-screen (customized) toolset, not the raw manifest", () => {
    render();
    // Hide core.main's only item, then Duplicate core.main.
    const visible = container.querySelector<HTMLInputElement>('[data-item-id="tool.a"] .customize-item-visible');
    act(() => visible!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const cloneButton = container.querySelector<HTMLButtonElement>('[data-toolset-id="core.main"] .customize-toolset-action');
    act(() => cloneButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const clone = applied().userToolsets.find((toolset) => toolset.id === "user.main-toolbar-copy");
    // The clone mirrors what's on screen (the hidden item is gone), not the raw manifest.
    expect(clone?.groups.every((group) => group.items.every((item) => item.id !== "tool.a"))).toBe(true);
  });
});
