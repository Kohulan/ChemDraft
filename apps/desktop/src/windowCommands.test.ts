import { describe, expect, it, vi } from "vitest";

import {
  isDocumentWindowCommandId,
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
    const fromDocument = async () => "main";
    for (const id of windowCommandIds) await requestWindowAction(id, emit, fromDocument);
    expect(emit.mock.calls).toEqual(windowCommandIds.map(commandId => [WINDOW_ACTION_EVENT, { commandId }]));
    await expect(requestWindowAction("document.closeTab", emit, fromDocument)).rejects.toThrow("not a window command");
    expect(emit).toHaveBeenCalledTimes(windowCommandIds.length);
  });

  it("asks only from the document window, never a panel, palette or dialog", async () => {
    const emit = vi.fn(async () => undefined);
    for (const label of ["plugin-panel-abc", "toolset-core-main", "preferences", "dialog-main-x"]) {
      for (const id of windowCommandIds) {
        await expect(requestWindowAction(id, emit, async () => label)).rejects.toThrow("only in the document window");
      }
    }
    expect(emit).not.toHaveBeenCalled();
  });

  it("names every command that acts on the whole document window", () => {
    for (const id of [
      ...windowCommandIds,
      "window.close.fileMenu",
      "window.minimize:forceDocumentHistory",
      "document.closeTab",
      "document.closeTab.other"
    ]) expect(isDocumentWindowCommandId(id), id).toBe(true);
    for (const id of ["window.minimizeAll", "document.closeTabs", "edit.undo", "plugin.demo.run"]) {
      expect(isDocumentWindowCommandId(id), id).toBe(false);
    }
  });
});
