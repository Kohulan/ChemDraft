import {
  compareToolsetPopoverOpenings, listenForToolsetPopoverContent, listenForToolsetPopoverDismiss,
  listenForToolsetFlyoutClosed, sendToolsetFlyoutKey, toolsetPopoverTimestamp, type ToolsetFlyoutSession,
  type ToolsetPopoverOpening
} from "./window-manager";

function compareOpenings(a: ToolsetPopoverOpening, b: ToolsetPopoverOpening): number {
  return a.generation === undefined || b.generation === undefined
    ? (a.openedAt ?? 0) - (b.openedAt ?? 0)
    : compareToolsetPopoverOpenings(a, b);
}

const openingKey = (toolsetId: string, flyoutId?: string) => JSON.stringify([toolsetId, flyoutId]);

function rememberDismissal(dismissals: Map<string, ToolsetPopoverOpening>, key: string, opening: ToolsetPopoverOpening) {
  const previous = dismissals.get(key);
  const order = previous ? compareOpenings(opening, previous) : 1;
  // A timestamp-only dismissal covers every generation at that time.
  if (order > 0 || (order === 0 && opening.generation === undefined)) dismissals.set(key, opening);
}

/** Install in the document and standalone palette windows: nonactivating flyouts
 * preserve either window's focus. Route keys before toolbar buttons, canvas
 * shortcuts and browser defaults, without transferring window or DOM focus. */
export function installNativeFlyoutKeyboard(): () => void {
  let session: ToolsetFlyoutSession | undefined;
  let closedThrough = -Infinity;
  let latestOpenedAt = -Infinity;
  const latestOpens = new Map<string, ToolsetPopoverOpening>();
  const latestCloses = new Map<string, ToolsetPopoverOpening>();
  const targetedDismissals = new Map<string, ToolsetPopoverOpening>();
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
    const key = openingKey(payload.toolsetId, payload.kind === "flyout" ? payload.flyout.flyoutId : undefined);
    const latestOpen = latestOpens.get(key);
    const latestClose = latestCloses.get(key);
    const targetedDismissal = targetedDismissals.get(payload.toolsetId);
    const order = latestOpen ? compareOpenings(opening, latestOpen) : 1;
    if (openedAt <= closedThrough || openedAt < latestOpenedAt || order < 0 ||
        (order === 0 && opening.generation !== undefined && latestOpen?.generation !== undefined) ||
        (latestClose && compareOpenings(opening, latestClose) <= 0) ||
        (targetedDismissal && compareOpenings(opening, targetedDismissal) <= 0)) return;
    latestOpenedAt = openedAt;
    if (order > 0 || opening.generation !== undefined) latestOpens.set(key, opening);
    session = payload.kind === "flyout" && payload.flyout.variant !== "bondStereo"
      ? { toolsetId: payload.toolsetId, flyoutId: payload.flyout.flyoutId, ...opening }
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
      rememberDismissal(targetedDismissals, target.toolsetId, target);
      if (session?.toolsetId === target.toolsetId && compareOpenings(session, target) <= 0) session = undefined;
    }
  }));
  subscribe(listenForToolsetFlyoutClosed(payload => {
    rememberDismissal(latestCloses, openingKey(payload.toolsetId, payload.flyoutId), payload);
    if (session?.toolsetId === payload.toolsetId && session.flyoutId === payload.flyoutId &&
        compareOpenings(session, payload) <= 0) session = undefined;
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
