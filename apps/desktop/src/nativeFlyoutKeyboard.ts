import {
  compareToolsetPopoverOpenings, listenForToolsetPopoverContent, listenForToolsetPopoverDismiss,
  listenForToolsetFlyoutClosed, sendToolsetFlyoutKey, toolsetPopoverTimestamp, type ToolsetFlyoutSession,
  type ToolsetPopoverOpening
} from "./window-manager";

const flyoutKey = (toolsetId: string, flyoutId: string) => JSON.stringify([toolsetId, flyoutId]);

/** Install in the document and standalone palette windows: nonactivating flyouts
 * preserve either window's focus. Route keys before toolbar buttons, canvas
 * shortcuts and browser defaults, without transferring window or DOM focus. */
export function installNativeFlyoutKeyboard(): () => void {
  let session: ToolsetFlyoutSession | undefined;
  let closedThrough = -Infinity;
  let latestOpenedAt = -Infinity;
  const latestOpens = new Map<string, ToolsetPopoverOpening>();
  const closedOpenings = new Map<string, ToolsetPopoverOpening>();
  const legacyCloseTimes = new Map<string, number>();
  const rememberClose = (toolsetId: string, opening: ToolsetPopoverOpening) => {
    const previous = closedOpenings.get(toolsetId);
    if (!previous || compareToolsetPopoverOpenings(opening, previous) > 0) closedOpenings.set(toolsetId, opening);
  };
  const isClosed = (toolsetId: string, opening: ToolsetPopoverOpening & { openedAt: number }, flyoutId?: string) => {
    const closed = closedOpenings.get(toolsetId);
    return (closed && compareToolsetPopoverOpenings(opening, closed) <= 0) ||
      (flyoutId !== undefined && opening.openedAt <= (legacyCloseTimes.get(flyoutKey(toolsetId, flyoutId)) ?? -Infinity));
  };
  const activationKeys = new Set<string>();
  let disposed = false;
  const cleanups: (() => void)[] = [];
  const subscribe = (promise: Promise<() => void>) => {
    void promise.then(stop => disposed ? stop() : cleanups.push(stop)).catch(() => undefined);
  };
  subscribe(listenForToolsetPopoverContent(payload => {
    if (disposed) return;
    const { toolsetId } = payload;
    const openedAt = payload.openedAt ?? toolsetPopoverTimestamp();
    const opening = { openedAt, generation: payload.generation };
    const flyoutId = payload.kind === "flyout" ? payload.flyout.flyoutId : undefined;
    // One popover window receives all the menus and color pickers in a toolset.
    const latestOpen = latestOpens.get(toolsetId);
    if (openedAt <= closedThrough || openedAt < latestOpenedAt ||
        (latestOpen && compareToolsetPopoverOpenings(opening, latestOpen) <= 0) ||
        isClosed(toolsetId, opening, flyoutId)) return;
    latestOpenedAt = openedAt;
    latestOpens.set(toolsetId, opening);
    session = payload.kind === "flyout" && payload.flyout.variant !== "bondStereo"
      ? { toolsetId, flyoutId: payload.flyout.flyoutId, ...opening }
      : undefined;
  }));
  const dismiss = (requestedAt = toolsetPopoverTimestamp()) => {
    closedThrough = Math.max(closedThrough, requestedAt);
    if (session && session.openedAt <= requestedAt) session = undefined;
  };
  subscribe(listenForToolsetPopoverDismiss(payload => {
    if (!payload?.openings) {
      dismiss(payload?.requestedAt);
      return;
    }
    for (const target of payload.openings) {
      rememberClose(target.toolsetId, target);
      if (session?.toolsetId === target.toolsetId && compareToolsetPopoverOpenings(session, target) <= 0) session = undefined;
    }
  }));
  subscribe(listenForToolsetFlyoutClosed(payload => {
    const { toolsetId, flyoutId, openedAt, generation } = payload;
    rememberClose(toolsetId, payload);
    if (generation === undefined) {
      // Older flyout-close senders identify their menu by timestamp alone.
      const key = flyoutKey(toolsetId, flyoutId);
      legacyCloseTimes.set(key, Math.max(legacyCloseTimes.get(key) ?? -Infinity, openedAt));
    }
    if (session?.toolsetId === toolsetId && isClosed(toolsetId, session, session.flyoutId)) session = undefined;
  }));
  const keyDown = (event: KeyboardEvent) => {
    if (event.repeat && activationKeys.has(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!session || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    const arrow = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key);
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (!arrow && !(plain && (event.key === "Enter" || event.key === " "))) return;
    // All arrows belong to the open flyout, including its unused axis and modified
    // arrows: none may fall through to selection nudging or page scrolling.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!arrow) activationKeys.add(event.key);
    if (plain) {
      void sendToolsetFlyoutKey({ ...session, key: event.key }).catch(() => undefined);
    }
  };
  const keyUp = (event: KeyboardEvent) => {
    if (!activationKeys.delete(event.key)) return;
    // Space's native button click can occur on keyup, after the flyout has closed.
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const pointerAway = () => dismiss();
  const blur = () => { activationKeys.clear(); dismiss(); }; // App deactivation hides utility windows.
  window.addEventListener("keydown", keyDown, true);
  window.addEventListener("keyup", keyUp, true);
  window.addEventListener("pointerdown", pointerAway, true);
  window.addEventListener("blur", blur);
  return () => {
    disposed = true;
    session = undefined;
    cleanups.forEach(stop => stop());
    window.removeEventListener("keydown", keyDown, true);
    window.removeEventListener("keyup", keyUp, true);
    window.removeEventListener("pointerdown", pointerAway, true);
    window.removeEventListener("blur", blur);
  };
}
