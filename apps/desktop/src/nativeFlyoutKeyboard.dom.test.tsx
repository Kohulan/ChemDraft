// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installNativeFlyoutKeyboard } from "./nativeFlyoutKeyboard";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import {
  dismissToolsetPopovers, setToolsetPopoverContent, type ToolsetFlyoutKey, type ToolsetPopoverOpening
} from "./window-manager";

type Listener = (event: { event: string; id: number; payload: unknown }) => void;
const native = {
  listeners: new Map<string, Map<number, Listener>>(),
  nextListener: 0,
  hold: (_event: string, _payload: unknown): boolean => false,
  queued: [] as (() => void)[],
  emit: vi.fn(async (event: string, payload: unknown) => {
    for (const [id, receive] of native.listeners.get(event) ?? []) {
      const deliver = () => receive({ event, id, payload });
      if (native.hold(event, payload)) native.queued.push(deliver);
      else deliver();
    }
  }),
  show: vi.fn(async (_kind?: string) => {}),
  hide: vi.fn(async () => {}),
  routeCommand: vi.fn()
};

function installMockTauri() {
  vi.stubGlobal("__TAURI_INTERNALS__", {
    metadata: { currentWindow: { label: "test" }, currentWebview: { label: "test" } },
    transformCallback: (receive: Listener) => receive,
    invoke: async (command: string, args: { event: string; handler: Listener; payload?: unknown; kind?: string }) => {
      if (command === "plugin:event|listen") {
        const listeners = native.listeners.get(args.event) ?? new Map();
        native.listeners.set(args.event, listeners);
        const id = ++native.nextListener;
        listeners.set(id, args.handler);
        return id;
      }
      if (command === "plugin:event|emit") await native.emit(args.event, args.payload);
      if (command === "show_toolset_popover_window" || command === "plugin:window|show") await native.show(args.kind);
      if (command === "plugin:window|hide") await native.hide();
      if (command === "route_toolset_command") native.routeCommand(args);
    }
  });
  vi.stubGlobal("__TAURI_EVENT_PLUGIN_INTERNALS__", {
    unregisterListener: (event: string, id: number) => native.listeners.get(event)?.delete(id)
  });
}

const flyoutKeyEvent = "chemdraft://toolset-flyout-key";
const main = "core.main";
const art = "core.art";
const contentEvent = "chemdraft://toolset-popover-content";
const sendKeys = () => native.emit.mock.calls.filter(([event]) => event === flyoutKeyEvent)
  .map(([, payload]) => payload as ToolsetFlyoutKey);
const press = async (key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => document.body.dispatchEvent(event));
  return event.defaultPrevented;
};
const pushMenu = (toolsetId: string, flyoutId: string, opening: ToolsetPopoverOpening = {}) => act(async () => {
  await setToolsetPopoverContent(toolsetId, { kind: "flyout", ...opening, flyout: {
    flyoutId, title: flyoutId, commands: [{ id: flyoutId, title: flyoutId, enabled: true, active: false }]
  } });
});

describe.each(["macos", "windows"] as const)("keyboard routing with reordered popover events on %s", platform => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let stop: (() => void) | undefined;
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    installMockTauri();
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<>
      <PalettePopoverWindow toolsetId={main} kind="flyout" prewarm platform={platform} />
      <PalettePopoverWindow toolsetId={art} kind="flyout" prewarm platform={platform} />
    </>));
    await vi.waitFor(() => expect(native.listeners.get(contentEvent)?.size).toBe(2));
    await act(async () => { stop = installNativeFlyoutKeyboard(); });
    await vi.waitFor(() => expect(native.listeners.get(contentEvent)?.size).toBe(3));
    await vi.waitFor(() => expect(native.listeners.get(flyoutKeyEvent)?.size).toBe(2));
  });
  afterEach(async () => {
    stop?.();
    stop = undefined;
    await act(async () => root.unmount());
    host.remove();
    native.listeners.clear();
    native.queued.length = 0;
    native.hold = () => false;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const highlighted = () => host.querySelector('[data-keyboard-highlighted="true"]')?.getAttribute("data-command-id");

  it("routes to the second unstamped menu in the same clock tick", async () => {
    vi.spyOn(performance, "now").mockReturnValue(50);
    await pushMenu(main, "rings");
    await pushMenu(main, "shapes");
    expect(await press("ArrowDown")).toBe(true);
    expect(sendKeys().at(-1)).toMatchObject({ toolsetId: main, flyoutId: "shapes", generation: expect.any(Number) });
    expect(highlighted()).toBe("shapes");
  });

  it("routes a stamped reopening at the timestamp of a closed timestamp-only menu", async () => {
    await pushMenu(main, "rings", { openedAt: 1 });
    await act(async () => host.querySelector("button")!.click());
    await vi.waitFor(() => expect(native.hide).toHaveBeenCalledOnce());
    expect(await press("ArrowDown")).toBe(false);
    await pushMenu(main, "rings", { openedAt: 1, generation: 1 });
    expect(await press("ArrowDown")).toBe(true);
    expect(highlighted()).toBe("rings");
    // Reordered duplicate close notices still identify the timestamp-only opening.
    const closes = native.emit.mock.calls.filter(([event]) =>
      event === "chemdraft://toolset-popover-closed" || event === "chemdraft://toolset-flyout-closed");
    expect(closes).toHaveLength(2);
    await act(async () => { for (const [event, payload] of closes) await native.emit(event, payload); });
    expect(await press("ArrowDown")).toBe(true);
  });

  it("rejects queued timestamp-only Enter on a same-time stamped replacement", async () => {
    await pushMenu(main, "rings", { openedAt: 1 });
    native.hold = (event, payload) => event === flyoutKeyEvent && (payload as ToolsetFlyoutKey).key === "Enter";
    expect(await press("Enter")).toBe(true);
    expect(sendKeys().at(-1)?.generation).toBeUndefined();
    await pushMenu(main, "rings", { openedAt: 1, generation: 1 });
    expect(await press("ArrowDown")).toBe(true);
    expect(highlighted()).toBe("rings");
    await act(async () => native.queued.splice(0).forEach(deliver => deliver()));
    expect(native.routeCommand).not.toHaveBeenCalled();
    expect(native.hide).not.toHaveBeenCalled();
  });

  it("routes an older opening from another toolset after the newer toolset closes", async () => {
    await pushMenu(main, "rings", { openedAt: 3, generation: 1 });
    await act(async () => host.querySelector("button")!.click());
    await vi.waitFor(() => expect(native.hide).toHaveBeenCalledOnce());
    expect(await press("ArrowDown")).toBe(false);
    await pushMenu(art, "shapes", { openedAt: 2, generation: 1 });
    expect(await press("ArrowDown")).toBe(true);
    expect(highlighted()).toBe("shapes");
  });

  it("allows delayed content after a payload-less dismissal", async () => {
    await act(async () => dismissToolsetPopovers());
    await pushMenu(main, "rings", { openedAt: 1, generation: 1 });
    expect(native.show).toHaveBeenCalledOnce();
    expect(await press("ArrowDown")).toBe(true);
    expect(highlighted()).toBe("rings");
  });

  it("releases routing when the failed color reveal closes before its content reaches the router", async () => {
    await pushMenu(main, "rings", { openedAt: 1, generation: 1 });
    expect(await press("ArrowDown")).toBe(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    native.show.mockRejectedValueOnce(new Error("Color picker reveal failed"))
      .mockRejectedValueOnce(new Error("Color picker fallback failed"));
    let contentDeliveries = 0;
    native.hold = (event, payload) => {
      if (event !== contentEvent) return false;
      const notice = payload as { kind?: string; accepted?: true; flyoutId?: string };
      return notice.accepted ? notice.flyoutId === undefined
        : notice.kind === "artColor" && ++contentDeliveries >= 3;
    };
    // Deliver the picker request to its renderer and hold its content notice to the router.
    await act(async () => setToolsetPopoverContent(main, { kind: "artColor", openedAt: 2, generation: 2 }));
    expect(native.queued.length).toBeGreaterThan(0);
    expect(native.hide).toHaveBeenCalledOnce();
    expect(await press("ArrowDown")).toBe(false);
    expect(native.emit).toHaveBeenCalledWith(contentEvent, expect.objectContaining({
      toolsetId: main, openedAt: 2, generation: 2, accepted: true
    }));
    await act(async () => native.queued.splice(0).forEach(deliver => deliver()));
    expect(await press("ArrowDown")).toBe(false);
  });
});
