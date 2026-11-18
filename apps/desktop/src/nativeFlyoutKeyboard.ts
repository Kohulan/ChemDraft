import {
  listenForAcceptedToolsetPopoverContent, listenForToolsetPopoverContent, listenForToolsetPopoverClosed,
  listenForToolsetPopoverDismiss, listenForToolsetFlyoutClosed, sendToolsetFlyoutKey, toolsetPopoverTimestamp,
  type ToolsetFlyoutSession
} from "./window-manager";
import {
  acceptFlyoutOpening, closeFlyoutMenu, closeFlyoutOpening, currentFlyoutOpening, dismissFlyoutOpenings,
  latestLiveFlyoutOpening, matchesToolsetPopoverOpening, newFlyoutOpeningState
} from "./window-manager/flyoutOpeningRule";

/** Install in the document and standalone palette windows: nonactivating flyouts
 * preserve either window's focus. Route keys before toolbar buttons, canvas
 * shortcuts and browser defaults, without transferring window or DOM focus. */
export function installNativeFlyoutKeyboard(): () => void {
  let openings = newFlyoutOpeningState();
  const pending = new Map<string, { session: ToolsetFlyoutSession; keys: string[]; flushing: boolean }>();
  const activationKeys = new Set<string>();
  let disposed = false;
  const cleanups: (() => void)[] = [];
  const subscribe = (promise: Promise<() => void>) => {
    void promise.then(stop => disposed ? stop() : cleanups.push(stop)).catch(() => undefined);
  };
  const updateOpenings = (next: typeof openings) => {
    openings = next;
    for (const [toolsetId, queue] of pending) {
      if (currentFlyoutOpening(openings, toolsetId) !== queue.session) pending.delete(toolsetId);
    }
  };
  const sendKey = (session: ToolsetFlyoutSession, key: string) =>
    sendToolsetFlyoutKey({ ...session, key }).catch(() => undefined);
  subscribe(listenForAcceptedToolsetPopoverContent(opening => {
    if (disposed) return;
    updateOpenings(acceptFlyoutOpening(openings, opening));
    const queue = pending.get(opening.toolsetId);
    if (!queue || queue.flushing || opening.flyoutId !== queue.session.flyoutId ||
        !matchesToolsetPopoverOpening(opening, queue.session)) return;
    queue.flushing = true;
    void (async () => {
      // Keep newly pressed keys behind the buffered keys while their IPC is in flight.
      for (const key of queue.keys) {
        if (pending.get(opening.toolsetId) !== queue) return;
        await sendKey(queue.session, key);
      }
      if (pending.get(opening.toolsetId) === queue) pending.delete(opening.toolsetId);
    })();
  }));
  subscribe(listenForToolsetPopoverContent(payload => {
    // Only the renderer assigns identities to legacy content without an opening timestamp.
    if (disposed || payload.openedAt === undefined) return;
    const flyoutId = payload.kind === "flyout" && payload.flyout.variant !== "bondStereo" ? payload.flyout.flyoutId : undefined;
    const opening = { toolsetId: payload.toolsetId, openedAt: payload.openedAt, generation: payload.generation };
    const session = flyoutId === undefined ? undefined : { ...opening, flyoutId };
    const next = acceptFlyoutOpening(openings, session ?? opening);
    if (next === openings) return;
    updateOpenings(next);
    if (session) pending.set(session.toolsetId, { session, keys: [], flushing: false });
  }));
  subscribe(listenForToolsetPopoverDismiss(payload => {
    // Only the renderer knows what it had accepted when an unstamped broadcast arrived.
    // Its close notice retires that opening even if its content notice is still in flight.
    if (!disposed && payload) updateOpenings(dismissFlyoutOpenings(openings, payload));
  }));
  subscribe(listenForToolsetPopoverClosed(payload => {
    if (!disposed) updateOpenings(closeFlyoutOpening(openings, payload));
  }));
  subscribe(listenForToolsetFlyoutClosed(payload => {
    if (!disposed) updateOpenings(closeFlyoutMenu(openings, payload));
  }));
  const keyDown = (event: KeyboardEvent) => {
    if (event.repeat && activationKeys.has(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const session = latestLiveFlyoutOpening(openings);
    if (session?.flyoutId === undefined || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    const arrow = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key);
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (!arrow && !(plain && (event.key === "Enter" || event.key === " "))) return;
    // All arrows belong to the open flyout, including its unused axis and modified
    // arrows: none may fall through to selection nudging or page scrolling.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!arrow) activationKeys.add(event.key);
    if (plain) {
      const queue = pending.get(session.toolsetId);
      if (queue) queue.keys.push(event.key);
      else void sendKey({ ...session, flyoutId: session.flyoutId }, event.key);
    }
  };
  const keyUp = (event: KeyboardEvent) => {
    if (!activationKeys.delete(event.key)) return;
    // Space's native button click can occur on keyup, after the flyout has closed.
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const blur = () => {
    activationKeys.clear();
    // Native utility windows hide on app deactivation without a renderer close notice.
    updateOpenings(dismissFlyoutOpenings(openings, { requestedAt: toolsetPopoverTimestamp() }));
  };
  window.addEventListener("keydown", keyDown, true);
  window.addEventListener("keyup", keyUp, true);
  window.addEventListener("blur", blur);
  return () => {
    disposed = true;
    pending.clear();
    cleanups.forEach(stop => stop());
    window.removeEventListener("keydown", keyDown, true);
    window.removeEventListener("keyup", keyUp, true);
    window.removeEventListener("blur", blur);
  };
}
