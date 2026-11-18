import {
  listenForAcceptedToolsetPopoverContent, listenForToolsetPopoverClosed, listenForToolsetPopoverDismiss,
  listenForToolsetFlyoutClosed, sendToolsetFlyoutKey, toolsetPopoverTimestamp
} from "./window-manager";
import {
  acceptFlyoutOpening, closeFlyoutMenu, closeFlyoutOpening, dismissFlyoutOpenings, latestLiveFlyoutOpening,
  newFlyoutOpeningState
} from "./window-manager/flyoutOpeningRule";

/** Install in the document and standalone palette windows: nonactivating flyouts
 * preserve either window's focus. Route keys before toolbar buttons, canvas
 * shortcuts and browser defaults, without transferring window or DOM focus. */
export function installNativeFlyoutKeyboard(): () => void {
  let openings = newFlyoutOpeningState();
  const activationKeys = new Set<string>();
  let disposed = false;
  const cleanups: (() => void)[] = [];
  const subscribe = (promise: Promise<() => void>) => {
    void promise.then(stop => disposed ? stop() : cleanups.push(stop)).catch(() => undefined);
  };
  subscribe(listenForAcceptedToolsetPopoverContent(opening => {
    if (!disposed) openings = acceptFlyoutOpening(openings, opening);
  }));
  subscribe(listenForToolsetPopoverDismiss(payload => {
    // Only the renderer knows what it had accepted when an unstamped broadcast arrived.
    // Its close notice retires that opening even if its content notice is still in flight.
    if (!disposed && payload) openings = dismissFlyoutOpenings(openings, payload);
  }));
  subscribe(listenForToolsetPopoverClosed(payload => {
    if (!disposed) openings = closeFlyoutOpening(openings, payload);
  }));
  subscribe(listenForToolsetFlyoutClosed(payload => {
    if (!disposed) openings = closeFlyoutMenu(openings, payload);
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
      void sendToolsetFlyoutKey({ ...session, flyoutId: session.flyoutId, key: event.key }).catch(() => undefined);
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
    openings = dismissFlyoutOpenings(openings, { requestedAt: toolsetPopoverTimestamp() });
  };
  window.addEventListener("keydown", keyDown, true);
  window.addEventListener("keyup", keyUp, true);
  window.addEventListener("blur", blur);
  return () => {
    disposed = true;
    cleanups.forEach(stop => stop());
    window.removeEventListener("keydown", keyDown, true);
    window.removeEventListener("keyup", keyUp, true);
    window.removeEventListener("blur", blur);
  };
}
