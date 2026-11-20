// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuitFlushPhase } from "./index";

const native = vi.hoisted(() => {
  type FlushEvent = { event: string; id: number; payload: { phase: QuitFlushPhase; requestId: number } | null };
  const listeners = new Map<string, (event: FlushEvent) => void>();
  return {
    listeners,
    invoke: vi.fn<(...args: unknown[]) => Promise<void>>(),
    listen: vi.fn(async (eventName: string, handler: (event: FlushEvent) => void) => {
      listeners.set(eventName, handler);
      return () => { listeners.delete(eventName); };
    })
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen: native.listen })
}));

import { confirmQuitAfterFlush, listenForQuitFlushRequest, QUIT_FLUSH_REQUEST_EVENT, saveDocumentSession } from "./index";

function requestFlush(requestId: number | null = 7) {
  const payload = requestId === null ? null : { phase: "committed" as const, requestId };
  native.listeners.get(QUIT_FLUSH_REQUEST_EVENT)?.({ event: QUIT_FLUSH_REQUEST_EVENT, id: 1, payload });
}

beforeEach(() => {
  native.listeners.clear();
  native.listen.mockClear();
  native.invoke.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("__TAURI_INTERNALS__", {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(["MacIntel", "Win32"])("quit flush on %s", (platform) => {
  beforeEach(() => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  });

  it("listens on the document window and confirms only after the session write finishes", async () => {
    let finishWrite: () => void = () => undefined;
    const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
    native.invoke.mockImplementation(async (command) => {
      if (command === "save_document_session") await pendingWrite;
    });
    const session = { lastEdit: "inside the autosave debounce" };
    const handler = vi.fn(async (_phase: QuitFlushPhase, requestId: number) => {
      // The document window uses this same write-then-confirm handshake on either platform.
      await saveDocumentSession(session);
      await confirmQuitAfterFlush(requestId);
    });
    const stop = await listenForQuitFlushRequest(handler);
    expect(native.listen).toHaveBeenCalledWith(QUIT_FLUSH_REQUEST_EVENT, expect.any(Function));
    requestFlush(42);
    expect(handler).toHaveBeenCalledWith("committed", 42);
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("save_document_session", { state: session }));
    expect(native.invoke).toHaveBeenCalledTimes(1);
    finishWrite();
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("quit_after_flush", { requestId: 42 }));
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(["save_document_session", "quit_after_flush"]);
    stop();
    requestFlush();
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });

  it("contains a rejected handler and leaves native timeout handling in charge", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("webview flush failed"));
    const stop = await listenForQuitFlushRequest(handler);
    requestFlush();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledExactlyOnceWith("committed", 7));
    expect(native.invoke).not.toHaveBeenCalled();
    stop();
  });

  it("ignores quit events without a valid native request ID", async () => {
    const handler = vi.fn();
    const stop = await listenForQuitFlushRequest(handler);
    requestFlush(null);
    requestFlush(0);
    requestFlush(1.5);
    expect(handler).not.toHaveBeenCalled();
    stop();
  });

  it("keeps the final quit snapshot behind an older autosave, even when the older write fails", async () => {
    let failAutosave: (error: Error) => void = () => undefined;
    const autosaving = new Promise<void>((_resolve, reject) => { failAutosave = reject; });
    let finishFinalWrite: () => void = () => undefined;
    const finalWrite = new Promise<void>((resolve) => { finishFinalWrite = resolve; });
    native.invoke.mockImplementationOnce(() => autosaving).mockImplementationOnce(() => finalWrite);
    const older = { lastEdit: "older autosave" };
    const latest = { lastEdit: "final quit snapshot" };
    const autosave = saveDocumentSession(older);
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1));
    const quitting = saveDocumentSession(latest, { strict: true }).then(() => confirmQuitAfterFlush(7));
    await Promise.resolve();
    expect(native.invoke).toHaveBeenCalledTimes(1);
    failAutosave(new Error("disk unavailable"));
    await autosave;
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("save_document_session", { state: latest }));
    expect(native.invoke).toHaveBeenCalledTimes(2);
    finishFinalWrite();
    await quitting;
    expect(native.invoke.mock.calls).toEqual([
      ["save_document_session", { state: older }],
      ["save_document_session", { state: latest }],
      ["quit_after_flush", { requestId: 7 }]
    ]);
  });

  it("contains a failed quit confirmation IPC", async () => {
    native.invoke.mockRejectedValue(new Error("native exit unavailable"));
    await expect(confirmQuitAfterFlush(7)).resolves.toBeUndefined();
    expect(native.invoke).toHaveBeenCalledWith("quit_after_flush", { requestId: 7 });
  });
});

it("does not install a quit listener or send native commands in the web preview", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", undefined);
  const handler = vi.fn();
  const stop = await listenForQuitFlushRequest(handler);
  await confirmQuitAfterFlush(7);
  stop();
  expect(native.listen).not.toHaveBeenCalled();
  expect(native.invoke).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});
