const SCROLLING_OVERFLOW = new Set(["auto", "scroll", "overlay"]);

interface ScrollbarAxes {
  x: boolean;
  y: boolean;
}

/**
 * True when a press landed on an element that can show a scrollbar: the palette's own content
 * scroller or any nested one, such as the Object Settings panel body. WebKit and WebView2
 * deliver a native scrollbar press (thumb or track) to the scroll owner itself, never to a
 * child, so a press whose target is a scroll owner must stay with the webview. Geometry cannot
 * separate a thumb from the owner's blank area: macOS overlay scrollbars draw inside the client
 * box. So a press anywhere on a scroll owner's own box stays with the webview, blank area
 * included; presses on the owner's non-scrolling descendants are ordinary background presses.
 *
 * An element counts only on an axis where it scrolls (`overflow` auto, scroll or overlay),
 * its content actually overflows, and CSS has not hidden the scrollbar. A floating tool
 * palette (`.tool-palette.floating`) scrolls with hidden scrollbars, so its blank background
 * still drags the window.
 */
export function isScrollOwnerPress(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const view = target.ownerDocument.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(target);
  // Browsers expand the `overflow` shorthand ("<x> [<y>]") into its longhands; jsdom reports
  // the declared shorthand and leaves the longhands at `visible`, so read both per axis.
  const [shorthandX = "", shorthandY = shorthandX] = style.overflow.split(/\s+/).filter(Boolean);
  const scrolls: ScrollbarAxes = {
    x: [style.overflowX, shorthandX].some((value) => SCROLLING_OVERFLOW.has(value)) &&
      target.scrollWidth > target.clientWidth,
    y: [style.overflowY, shorthandY].some((value) => SCROLLING_OVERFLOW.has(value)) &&
      target.scrollHeight > target.clientHeight
  };
  if (!scrolls.x && !scrolls.y) return false;
  const hidden = hiddenScrollbars(target, style, view);
  return (scrolls.x && !hidden.x) || (scrolls.y && !hidden.y);
}

/**
 * Which scrollbars CSS hides. App.css hides `.tool-palette.floating`'s with both
 * `scrollbar-width: none` (Chromium/WebView2 and WebKit from Safari 18.2) and
 * `::-webkit-scrollbar { width: 0; height: 0 }` (older WebKit), so read both.
 */
function hiddenScrollbars(target: Element, style: CSSStyleDeclaration, view: Window): ScrollbarAxes {
  const scrollbarWidth = style.getPropertyValue("scrollbar-width");
  if (scrollbarWidth === "none") return { x: true, y: true };
  // Chromium ignores ::-webkit-scrollbar once scrollbar-width is set. jsdom has neither `CSS`
  // nor pseudo-element styles (it would return the element's own style), so skip it there.
  if ((scrollbarWidth && scrollbarWidth !== "auto") || !("CSS" in view)) return { x: false, y: false };
  const bar = view.getComputedStyle(target, "::-webkit-scrollbar");
  if (bar.display === "none") return { x: true, y: true };
  return { x: bar.height === "0px", y: bar.width === "0px" };
}
