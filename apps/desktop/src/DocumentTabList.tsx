import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";

type Strategy = "current" | "remount" | "transform" | "toggle";

function tabStripStrategy(): Strategy {
  // Temporary WebKit diagnostic. In devtools set chemdraft.debug.tabStripStrategy and reload the document window.
  if (import.meta.env.DEV) {
    try {
      const value = localStorage.getItem("chemdraft.debug.tabStripStrategy");
      if (value === "transform" || value === "remount" || value === "toggle" || value === "current") return value;
    } catch { /* Storage can be unavailable in a webview. */ }
  }
  return "transform";
}

export interface DocumentTabListHandle {
  beforeRemove(remaining: readonly { id: string }[]): void;
}

function clampOffset(offset: number, max: number) {
  return Math.max(0, Math.min(offset, max));
}

function offsetToReveal(strip: HTMLElement, tab: HTMLElement | null, offset: number, max: number) {
  if (!tab || max === 0) return clampOffset(offset, max);
  const rect = tab.getBoundingClientRect();
  const left = strip.getBoundingClientRect().left + strip.clientLeft;
  // Use the nearest edge, or align the start of a tab wider than the strip.
  const delta = Math.min(rect.left - left, Math.max(0, rect.right - left - strip.clientWidth));
  return clampOffset(offset + delta, max);
}

const activeTabSelector = '.document-tab[data-active="true"]';

function revealNativeActiveTab(strip: HTMLElement, max: number) {
  if (max > 0) {
    const target = offsetToReveal(strip, strip.querySelector(activeTabSelector), strip.scrollLeft, max);
    if (target !== strip.scrollLeft) strip.scrollLeft = target;
  }
  return strip.scrollLeft;
}

export function DocumentTabList({ ref, activeId, order, children }: {
  ref: Ref<DocumentTabListHandle>;
  activeId: string;
  order: string;
  children: ReactNode;
}) {
  const [strategy] = useState(tabStripStrategy);
  const stripRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const offset = useRef(0);
  const removal = useRef<{ offset: number; max: number } | null>(null);
  const [generation, setGeneration] = useState(0);
  const restore = useRef<{ offset: number; reveal: boolean; tabId?: string; close: boolean } | null>(null);

  const moveTrack = useCallback((track: HTMLElement, left: number) => {
    offset.current = left;
    track.style.transform = `translateX(${-left}px)`;
  }, []);

  useImperativeHandle(ref, () => ({
    beforeRemove(remaining) {
      const strip = stripRef.current;
      if (!strip) return;
      const track = trackRef.current;
      if (strategy === "remount" || strategy === "toggle") {
        removal.current = { offset: strip.scrollLeft, max: Math.max(0, strip.scrollWidth - strip.clientWidth) };
        return;
      }
      const left = track ? offset.current : strip.scrollLeft;
      if (left > 0) {
        // Include tabs whose removal React has queued but whose elements are still in the strip.
        const row = track ?? strip;
        const remainingIds = new Set(remaining.map(tab => tab.id));
        const tabs = Array.from(row.querySelectorAll<HTMLElement>("[data-document-tab-id]"));
        const closing = tabs.filter(tab => !remainingIds.has(tab.dataset.documentTabId!));
        const gap = Number.parseFloat(window.getComputedStyle(row).columnGap) || 0;
        const gapsRemoved = Math.min(closing.length, Math.max(0, tabs.length - 1));
        const widthRemoved = closing.reduce((width, tab) => width + tab.offsetWidth, 0) + gapsRemoved * gap;
        const target = Math.max(0, row.scrollWidth - widthRemoved - strip.clientWidth);
        if (target < left) {
          if (track) moveTrack(track, target);
          else strip.scrollLeft = target;
        }
      }
      if (!track) offset.current = strip.scrollLeft;
    }
  }), [strategy, moveTrack]);

  const replaceStrip = useCallback((strip: HTMLElement, left: number, reveal: boolean) => {
    const focused = document.activeElement;
    const tab = strip.contains(focused) ? focused?.closest<HTMLElement>("[data-document-tab-id]") : null;
    restore.current = { offset: left, reveal, tabId: tab?.dataset.documentTabId,
      close: focused?.classList.contains("document-tab-close") ?? false };
    setGeneration(previous => previous + 1);
  }, []);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const saved = restore.current;
    if (!strip || !saved) return;
    restore.current = null;
    const max = Math.max(0, strip.scrollWidth - strip.clientWidth);
    strip.scrollLeft = clampOffset(saved.offset, max);
    if (saved.tabId) {
      const tab = Array.from(strip.querySelectorAll<HTMLElement>("[data-document-tab-id]"))
        .find(element => element.dataset.documentTabId === saved.tabId);
      tab?.querySelector<HTMLElement>(saved.close ? ".document-tab-close" : '[role="tab"]')?.focus({ preventScroll: true });
    }
    if (saved.reveal) revealNativeActiveTab(strip, max);
  }, [generation]);

  useLayoutEffect(() => {
    if (strategy !== "remount") return;
    let frame = 0;
    function onFocus() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const strip = stripRef.current;
        if (!strip) return;
        // A click may be making this window key. Keep its target alive through mouseup and click.
        if (strip.querySelector("button:active")) onFocus();
        else replaceStrip(strip, strip.scrollLeft, false);
      });
    }
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.cancelAnimationFrame(frame);
    };
  }, [strategy, replaceStrip]);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const track = trackRef.current;
    const max = Math.max(0, (track ?? strip).scrollWidth - strip.clientWidth);
    if (track) {
      moveTrack(track, offsetToReveal(strip, strip.querySelector(activeTabSelector), offset.current, max));
      return;
    }
    const before = removal.current;
    removal.current = null;
    if (strategy === "remount" && before && before.max !== max) {
      replaceStrip(strip, before.offset, true);
      return;
    }
    if (strategy === "toggle" && before) {
      strip.style.overflowX = "hidden";
      void strip.offsetWidth;
      strip.style.overflowX = "auto";
      const frame = window.requestAnimationFrame(() => {
        const limit = Math.max(0, strip.scrollWidth - strip.clientWidth);
        strip.scrollLeft = clampOffset(before.offset, limit);
        revealNativeActiveTab(strip, limit);
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (strategy !== "current" || max === 0 || offset.current <= max) {
      offset.current = revealNativeActiveTab(strip, max);
      return;
    }
    // HEAD baseline: when WebKit clamps beyond the pre-close target, nudge and return next frame.
    const nudge = Math.max(0, max - 1);
    if (strip.scrollLeft !== nudge) strip.scrollLeft = nudge;
    offset.current = strip.scrollLeft;
    const frame = window.requestAnimationFrame(() => {
      if (strip.scrollLeft !== max) strip.scrollLeft = max;
      offset.current = revealNativeActiveTab(strip, max);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [strategy, activeId, order, moveTrack, replaceStrip]);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const track = trackRef.current;
    if (!strip || !track) return;
    const maxOffset = () => Math.max(0, track.scrollWidth - strip.clientWidth);
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return; // Preserve pinch-to-zoom.
      const unit = event.deltaMode;
      let delta = event.deltaX || event.deltaY;
      if (unit === WheelEvent.DOM_DELTA_LINE) delta *= parseFloat(getComputedStyle(track).lineHeight) || 16;
      if (unit === WheelEvent.DOM_DELTA_PAGE) delta *= strip.clientWidth;
      const next = clampOffset(offset.current + delta, maxOffset());
      if (next === offset.current) return;
      event.preventDefault();
      moveTrack(track, next);
    };
    const onFocus = (event: FocusEvent) => {
      // Leave a partially visible pointer target in place between mouse-down and click.
      const tab = event.target instanceof Element ? event.target.closest<HTMLElement>(".document-tab") : null;
      if (tab && !tab.matches(":active")) moveTrack(track, offsetToReveal(strip, tab, offset.current, maxOffset()));
    };
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      moveTrack(track, clampOffset(offset.current, maxOffset()));
    });
    resize?.observe(strip);
    resize?.observe(track);
    strip.addEventListener("wheel", onWheel, { passive: false });
    strip.addEventListener("focusin", onFocus);
    return () => {
      resize?.disconnect();
      strip.removeEventListener("wheel", onWheel);
      strip.removeEventListener("focusin", onFocus);
    };
  }, [moveTrack]);

  return (
    <div key={generation} ref={stripRef} className="document-tab-list" role="tablist" aria-label="Open documents"
      data-strategy={strategy} onScroll={strategy === "current" ? event => { offset.current = event.currentTarget.scrollLeft; } : undefined}>
      {strategy === "transform" ? (
        <div className="document-tab-clip">
          <div ref={trackRef} className="document-tab-track">{children}</div>
        </div>
      ) : children}
    </div>
  );
}
