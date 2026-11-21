import { useCallback, useImperativeHandle, useLayoutEffect, useRef, type PointerEvent, type ReactNode, type Ref } from "react";

export interface DocumentTabListHandle {
  beforeRemove(remaining: readonly { id: string }[]): void;
}

function clampOffset(offset: number, max: number) {
  return Math.max(0, Math.min(offset, max));
}

function scrollGeometry(viewportWidth: number, trackWidth: number) {
  const max = Math.max(0, trackWidth - viewportWidth);
  // The scrollbar spans the viewport.
  const thumbWidth = max > 0 ? Math.min(viewportWidth, Math.max(24, viewportWidth ** 2 / trackWidth)) : viewportWidth;
  return { max, thumbWidth, thumbTravel: viewportWidth - thumbWidth };
}

function offsetToReveal(strip: HTMLElement, tab: HTMLElement | null, offset: number, max: number) {
  if (!tab || max === 0) return clampOffset(offset, max);
  const rect = tab.getBoundingClientRect();
  const left = strip.getBoundingClientRect().left + strip.clientLeft;
  // Use the nearest edge, or align the start of a tab wider than the strip.
  const delta = Math.min(rect.left - left, Math.max(0, rect.right - left - strip.clientWidth));
  return clampOffset(offset + delta, max);
}

export function DocumentTabList({ ref, activeId, order, children }: {
  ref: Ref<DocumentTabListHandle>;
  activeId: string;
  order: string;
  children: ReactNode;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const scrollbarRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const offset = useRef(0);
  const viewportWidth = useRef(0);
  const drag = useRef<{ pointerId: number; startX: number; startOffset: number } | null>(null);

  const moveTrack = useCallback((left: number, remainingWidth?: number) => {
    const strip = stripRef.current;
    const track = trackRef.current;
    const scrollbar = scrollbarRef.current;
    const thumb = thumbRef.current;
    if (!strip || !track || !scrollbar || !thumb) return;

    const stripWidth = strip.clientWidth;
    viewportWidth.current = stripWidth;
    const { max, thumbWidth, thumbTravel } = scrollGeometry(stripWidth, remainingWidth ?? track.scrollWidth);
    const next = clampOffset(left, max);
    // A shared transform keeps the painted tabs and their hit targets in sync.
    offset.current = next;
    track.style.transform = `translateX(${-next}px)`;
    scrollbar.style.visibility = max > 0 && stripWidth > 0 ? "visible" : "hidden";
    thumb.style.width = `${thumbWidth}px`;
    thumb.style.transform = `translateX(${max > 0 ? next / max * thumbTravel : 0}px)`;
  }, []);

  useImperativeHandle(ref, () => ({
    beforeRemove(remaining) {
      const strip = stripRef.current;
      const track = trackRef.current;
      if (!strip || !track || offset.current <= 0) return;

      // Include tabs whose removal React has queued but whose elements are still in the strip.
      const remainingIds = new Set(remaining.map(tab => tab.id));
      const tabs = Array.from(track.querySelectorAll<HTMLElement>("[data-document-tab-id]"));
      const closing = tabs.filter(tab => !remainingIds.has(tab.dataset.documentTabId!));
      const gap = Number.parseFloat(window.getComputedStyle(track).columnGap) || 0;
      const gapsRemoved = Math.min(closing.length, Math.max(0, tabs.length - 1));
      const widthRemoved = closing.reduce((width, tab) => width + tab.offsetWidth, 0) + gapsRemoved * gap;
      const remainingWidth = track.scrollWidth - widthRemoved;
      if (remainingWidth - strip.clientWidth < offset.current) moveTrack(offset.current, remainingWidth);
    }
  }), [moveTrack]);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const track = trackRef.current;
    if (!strip || !track) return;
    const max = Math.max(0, track.scrollWidth - strip.clientWidth);
    const activeTab = track.querySelector<HTMLElement>('.document-tab[data-active="true"]');
    moveTrack(offsetToReveal(strip, activeTab, offset.current, max));
  }, [activeId, order, moveTrack]);

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
      moveTrack(next);
    };
    const onFocus = (event: FocusEvent) => {
      // Leave a partially visible pointer target in place between mouse-down and click.
      const tab = event.target instanceof Element ? event.target.closest<HTMLElement>(".document-tab") : null;
      if (tab && !tab.matches(":active")) moveTrack(offsetToReveal(strip, tab, offset.current, maxOffset()));
    };
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      // The track still sits at its old offset, so the tab's rect and the last viewport width describe the
      // layout before this resize. Keep an active tab that was fully in view in view; otherwise only clamp.
      const activeTab = track.querySelector<HTMLElement>('.document-tab[data-active="true"]');
      let wasInView = false;
      if (activeTab) {
        const rect = activeTab.getBoundingClientRect();
        const left = strip.getBoundingClientRect().left + strip.clientLeft;
        wasInView = rect.left - left >= -0.5 && rect.right - left <= viewportWidth.current + 0.5;
      }
      moveTrack(wasInView ? offsetToReveal(strip, activeTab, offset.current, maxOffset()) : offset.current);
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

  function onScrollbarPointerDown(event: PointerEvent<HTMLDivElement>) {
    const strip = stripRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!strip || !track || !thumb || drag.current || event.button !== 0 || event.pointerType !== "mouse") return;
    const viewportWidth = strip.clientWidth;
    if (track.scrollWidth <= viewportWidth) return;

    event.preventDefault();
    if (event.target === thumb) {
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startOffset: offset.current };
    } else {
      const direction = event.clientX < thumb.getBoundingClientRect().left ? -1 : 1;
      moveTrack(offset.current + direction * viewportWidth);
    }
  }

  function onScrollbarPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    const strip = stripRef.current;
    const track = trackRef.current;
    if (!start || start.pointerId !== event.pointerId || !strip || !track) return;

    const { max, thumbTravel } = scrollGeometry(strip.clientWidth, track.scrollWidth);
    if (thumbTravel > 0) moveTrack(start.startOffset + (event.clientX - start.startX) / thumbTravel * max);
  }

  function endScrollbarDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }

  return (
    <div ref={stripRef} className="document-tab-list" role="tablist" aria-label="Open documents">
      <div className="document-tab-clip">
        <div ref={trackRef} className="document-tab-track">{children}</div>
      </div>
      <div ref={scrollbarRef} className="document-tab-scrollbar" aria-hidden="true"
        onPointerDown={onScrollbarPointerDown} onPointerMove={onScrollbarPointerMove}
        onPointerUp={endScrollbarDrag} onPointerCancel={endScrollbarDrag} onLostPointerCapture={endScrollbarDrag}>
        <div ref={thumbRef} className="document-tab-scrollbar-thumb" />
      </div>
    </div>
  );
}
