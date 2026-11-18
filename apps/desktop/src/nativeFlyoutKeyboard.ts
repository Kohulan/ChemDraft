import {
  compareToolsetPopoverOpenings, listenForToolsetPopoverContent, listenForToolsetPopoverDismiss,
  listenForToolsetFlyoutClosed, sendToolsetFlyoutKey, toolsetPopoverTimestamp, type ToolsetFlyoutSession,
  type ToolsetPopoverOpening
} from "./window-manager";

/** Install in the document and standalone palette windows: nonactivating flyouts
 * preserve either window's focus. Route keys before toolbar buttons, canvas
 * shortcuts and browser defaults, without transferring window or DOM focus. */
export function installNativeFlyoutKeyboard(): () => void {
  let session: ToolsetFlyoutSession | undefined;
  let closedThrough = -Infinity;
  let latestOpen: ToolsetPopoverOpening | undefined;
  let latestClose: ToolsetPopoverOpening | undefined;
  const activationKeys = new Set<string>();
  let disposed = false;
  const cleanups: (() => void)[] = [];
  const subscribe = (promise: Promise<() => void>) => {
    void promise.then(stop => disposed ? stop() : cleanups.push(stop)).catch(() => undefined);
  };
  subscribe(listenForToolsetPopoverContent(payload => {
    if (disposed) return;
    const openedAt = payload.openedAt ?? toolsetPopoverTimestamp();
    const opening = { openedAt, generation: payload.generation };
    if (openedAt <= closedThrough ||
        (latestOpen && compareToolsetPopoverOpenings(opening, latestOpen) < 0) ||
        (latestClose && compareToolsetPopoverOpenings(opening, latestClose) <= 0)) return;
    latestOpen = opening;
    session = payload.kind === "flyout" && payload.flyout.variant !== "bondStereo"
      ? { toolsetId: payload.toolsetId, flyoutId: payload.flyout.flyoutId, ...opening }
      : undefined;
  }));
  const dismiss = (requestedAt = toolsetPopoverTimestamp()) => {
    closedThrough = Math.max(closedThrough, requestedAt);
    if (session && session.openedAt <= requestedAt) session = undefined;
  };
  subscribe(listenForToolsetPopoverDismiss(payload => dismiss(payload?.requestedAt)));
  subscribe(listenForToolsetFlyoutClosed(payload => {
    if (session?.toolsetId === payload.toolsetId && session.flyoutId === payload.flyoutId &&
        session.openedAt === payload.openedAt) {
      if (payload.generation !== undefined && payload.generation !== session.generation) return;
      session = undefined;
    }
    if (payload.generation === undefined) {
      closedThrough = Math.max(closedThrough, payload.openedAt);
    } else if (!latestClose || compareToolsetPopoverOpenings(payload, latestClose) > 0) {
      latestClose = payload;
    }
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
      const { toolsetId, flyoutId, openedAt } = session;
      void sendToolsetFlyoutKey({ toolsetId, flyoutId, openedAt, key: event.key }).catch(() => undefined);
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
