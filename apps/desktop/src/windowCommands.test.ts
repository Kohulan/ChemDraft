import { describe, expect, it, vi } from "vitest";

import {
  requestWindowAction,
  WINDOW_ACTION_EVENT,
  windowCommandId,
  windowCommandIds,
  windowCommands,
  windowCommandsSupported
} from "./windowCommands";

describe("window commands", () => {
  it("are value-encoded per action", () => {
    expect(windowCommandId("minimize")).toBe("window.minimize");
    expect(windowCommandId("toggleMaximize")).toBe("window.toggleMaximize");
    expect(windowCommandId("close")).toBe("window.close");
    expect(windowCommandIds).toEqual(["window.minimize", "window.toggleMaximize", "window.close"]);
  });

  it("exist only in the Linux desktop build", () => {
    const linux = windowCommands({ isDesktop: true, platform: "linux" });
    expect(linux.map(command => [command.id, command.title])).toEqual([
      ["window.minimize", "Minimize"],
      ["window.toggleMaximize", "Maximize / Restore"],
      ["window.close", "Close Window"]
    ]);
    for (const command of linux) {
      // Always runnable while they exist; no accelerator to take Ctrl+W from the webview.
      expect(command.enabled).not.toBe(false);
      expect(command.disabledReason).toBeUndefined();
      expect(command.shortcut).toBeUndefined();
    }
    // macOS and Windows keep the OS's predefined items, so no copy of these exists there at all.
    for (const platform of ["macos", "windows"] as const) {
      expect(windowCommandsSupported({ isDesktop: true, platform })).toBe(false);
      expect(windowCommands({ isDesktop: true, platform })).toEqual([]);
    }
    expect(windowCommands({ isDesktop: false, platform: "linux" })).toEqual([]);
  });

  it("asks the native side to run the command's action", async () => {
    const emit = vi.fn(async () => undefined);
    for (const id of windowCommandIds) await requestWindowAction(id, emit);
    expect(emit.mock.calls).toEqual(windowCommandIds.map(commandId => [WINDOW_ACTION_EVENT, { commandId }]));
    await expect(requestWindowAction("document.closeTab", emit)).rejects.toThrow("not a window command");
    expect(emit).toHaveBeenCalledTimes(windowCommandIds.length);
  });
});
