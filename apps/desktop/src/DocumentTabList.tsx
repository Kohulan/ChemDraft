import { useCallback, useImperativeHandle, useLayoutEffect, useRef, type PointerEvent, type ReactNode, type Ref } from "react";

export interface DocumentTabListHandle {
  beforeRemove(remaining: readonly { id: string }[]): void;
}

function clampOffset(offset: number, max: number) {
  return Math.max(0, Math.min(offset, max));
}

// Layout works in 1/64 px; ignore a sliver that cannot be seen.
const LAYOUT_EPSILON = 1 / 64;

// An overflow smaller than this many CSS pixels is a rounding artifact of fractional layout (display scaling such as
// 125% makes every width fractional), not a real overflow: nothing scrolls and the scrollbar stays hidden.
const MIN_OVERFLOW = 1;

// scrollWidth and clientWidth round to whole pixels, so mixing them with an exact box invents a sliver of overflow.
// The track and the viewport are both measured as exact boxes (the strip has no border or padding); the rounded
// scrollWidth is only the fallback for a box that reports no size.
function measureTrack(track: HTMLElement) {
  const exact = track.getBoundingClientRect().width;
  return exact > 0 ? exact : track.scrollWidth;
}

function measureViewport(strip: HTMLElement) {
  const exact = strip.getBoundingClientRect().width;
  return exact > 0 ? exact : strip.clientWidth;
}

function scrollGeometry(viewportWidth: number, trackWidth: number) {
  const overflow = trackWidth - viewportWidth;
  // Round a real overflow up so the end of the last tab, its close button included, is never clipped by a sub-pixel.
  const max = overflow < MIN_OVERFLOW ? 0 : Math.ceil(overflow - LAYOUT_EPSILON);
  // The scrollbar spans the viewport.
  const thumbWidth = max > 0 ? Math.min(viewportWidth, Math.max(24, viewportWidth ** 2 / trackWidth)) : viewportWidth;
  return { max, thumbWidth, thumbTravel: viewportWidth - thumbWidth };
}

// Whether the tab sits fully inside the viewport at its current offset (half a pixel of slack for rounding).
function isFullyVisible(strip: HTMLElement, tab: HTMLElement | null, viewport: number) {
  if (!tab) return false;
  const rect = tab.getBoundingClientRect();
  const left = strip.getBoundingClientRect().left + strip.clientLeft;
  return rect.left - left >= -0.5 && rect.right - left <= viewport + 0.5;
}

function offsetToReveal(strip: HTMLElement, tab: HTMLElement | null, offset: number, max: number) {
  if (!tab || max === 0) return clampOffset(offset, max);
  const rect = tab.getBoundingClientRect();
  const left = strip.getBoundingClientRect().left + strip.clientLeft;
  // Use the nearest edge, or align the start of a tab wider than the strip.
  const delta = Math.min(rect.left - left, Math.max(0, rect.right - left - measureViewport(strip)));
  // Revealing the last tab aligns its exact right edge, which sits under the rounded-up end of the range. Land on the
  // end itself, so a reveal and a wheel or thumb move to the end leave the same offset.
  const target = delta > 0 && max - (offset + delta) < MIN_OVERFLOW ? max : offset + delta;
  return clampOffset(target, max);
}

export function DocumentTabList({ ref, activeId, order, activeTitle, children }: {
  ref: Ref<DocumentTabListHandle>;
  activeId: string;
  order: string;
  // The active tab's title: a title change resizes the tab, so the reveal runs again at the final width.
  activeTitle: string;
  children: ReactNode;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const scrollbarRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const offset = useRef(0);
  // Whether the active tab was fully visible after the last move. A later resize of the viewport or of the track
  // (a tab growing to its title) is judged against this, because by then the tab's box already has the new size.
  // A wheel or thumb move away clears it, so a later growth never pulls the strip back.
  const activeInView = useRef(false);
  const drag = useRef<{ pointerId: number; startX: number; startOffset: number } | null>(null);

  const moveTrack = useCallback((left: number, remainingWidth?: number) => {
    const strip = stripRef.current;
    const track = trackRef.current;
    const scrollbar = scrollbarRef.current;
    const thumb = thumbRef.current;
    if (!strip || !track || !scrollbar || !thumb) return;

    const stripWidth = measureViewport(strip);
    const { max, thumbWidth, thumbTravel } = scrollGeometry(stripWidth, remainingWidth ?? measureTrack(track));
    const next = clampOffset(left, max);
    // A shared transform keeps the painted tabs and their hit targets in sync.
    offset.current = next;
    track.style.transform = `translateX(${-next}px)`;
    scrollbar.style.visibility = max > 0 && stripWidth > 0 ? "visible" : "hidden";
    thumb.style.width = `${thumbWidth}px`;
    thumb.style.transform = `translateX(${max > 0 ? next / max * thumbTravel : 0}px)`;
    activeInView.current = isFullyVisible(strip, track.querySelector<HTMLElement>('.document-tab[data-active="true"]'), stripWidth);
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
      const remainingWidth = measureTrack(track) - widthRemoved;
      if (scrollGeometry(measureViewport(strip), remainingWidth).max < offset.current) moveTrack(offset.current, remainingWidth);
    }
  }), [moveTrack]);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const track = trackRef.current;
    if (!strip || !track) return;
    const max = scrollGeometry(measureViewport(strip), measureTrack(track)).max;
    const activeTab = track.querySelector<HTMLElement>('.document-tab[data-active="true"]');
    moveTrack(offsetToReveal(strip, activeTab, offset.current, max));
  }, [activeId, order, activeTitle, moveTrack]);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const track = trackRef.current;
    if (!strip || !track) return;
    const maxOffset = () => scrollGeometry(measureViewport(strip), measureTrack(track)).max;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return; // Preserve pinch-to-zoom.
      const unit = event.deltaMode;
      let delta = event.deltaX || event.deltaY;
      if (unit === WheelEvent.DOM_DELTA_LINE) delta *= parseFloat(getComputedStyle(track).lineHeight) || 16;
      if (unit === WheelEvent.DOM_DELTA_PAGE) delta *= measureViewport(strip);
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
      // The track still sits at its old offset, so the active tab's rect already has the new size, but
      // activeInView describes the layout before it. Keep a tab that was fully in view in view; otherwise only clamp.
      const activeTab = track.querySelector<HTMLElement>('.document-tab[data-active="true"]');
      moveTrack(activeInView.current ? offsetToReveal(strip, activeTab, offset.current, maxOffset()) : offset.current);
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
    const stripWidth = measureViewport(strip);
    if (scrollGeometry(stripWidth, measureTrack(track)).max === 0) return;

    event.preventDefault();
    if (event.target === thumb) {
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startOffset: offset.current };
    } else {
      const direction = event.clientX < thumb.getBoundingClientRect().left ? -1 : 1;
      moveTrack(offset.current + direction * stripWidth);
    }
  }

  function onScrollbarPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    const strip = stripRef.current;
    const track = trackRef.current;
    if (!start || start.pointerId !== event.pointerId || !strip || !track) return;

    const { max, thumbTravel } = scrollGeometry(measureViewport(strip), measureTrack(track));
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
