const SCROLLING_OVERFLOW = new Set(["auto", "scroll", "overlay"]);

/**
 * True when a press landed on an element that owns a scrollbar: the palette's own content
 * scroller or any nested one, such as the Object Settings panel body. WebKit and WebView2
 * deliver a native scrollbar press (thumb or track) to the scroll owner itself, never to a
 * child, so a press whose target is a scroll owner must stay with the webview. Geometry cannot
 * separate a thumb from the owner's blank area: macOS overlay scrollbars draw inside the client
 * box. Presses on the owner's non-scrolling descendants are ordinary background presses.
 */
export function isScrollOwnerPress(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const view = target.ownerDocument.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(target);
  // Browsers expand the `overflow` shorthand into its longhands; jsdom reports only the
  // declared form, so read both.
  return [style.overflowX, style.overflowY, ...style.overflow.split(/\s+/)]
    .some((value) => SCROLLING_OVERFLOW.has(value));
}
