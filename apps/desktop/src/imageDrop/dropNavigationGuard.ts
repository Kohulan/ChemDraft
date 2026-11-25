/**
 * No drop ever navigates a ChemDraft webview. A file, link or text dropped where nothing handles it
 * would otherwise replace the app with that file or URL, discarding the document. Installed on every
 * window (document, palettes, popovers, dialogs), including the web build.
 *
 * Text dragged into or within an editable field is left alone: that is ordinary editing.
 */

export interface DropGuardEventLike {
  type: string;
  target: EventTarget | null;
  defaultPrevented: boolean;
  dataTransfer: { types: ArrayLike<string> | readonly string[]; dropEffect?: string } | null;
  preventDefault(): void;
}

export function dragCarriesFiles(types: ArrayLike<string> | readonly string[] | undefined | null): boolean {
  return !!types && Array.from(types).includes("Files");
}

const NON_TEXT_INPUT_TYPES = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];

/**
 * Inputs, text areas and content-editable regions accept text drops natively. The nearest explicit
 * editing boundary decides: a `contenteditable="false"` island inside an editable region is not
 * editable, and an invalid `contenteditable` value inherits from its parent, as the HTML spec says.
 */
export function isEditableDropTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  for (let element: Element | null = target; element; element = element.parentElement) {
    if (element instanceof HTMLInputElement) {
      return !element.disabled && !element.readOnly && !NON_TEXT_INPUT_TYPES.includes(element.type);
    }
    if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
    const state = element.getAttribute("contenteditable");
    if (state === null) continue;
    const normalized = state.trim().toLowerCase();
    if (normalized === "false") return false;
    if (normalized === "" || normalized === "true" || normalized === "plaintext-only") return true;
  }
  return false;
}

/** Drags an editable field inserts as text; anything else (a picture, a file promise) is refused. */
const TEXT_DROP_TYPES = new Set(["text/plain", "text/uri-list", "text/html"]);

export function dragIsTextCompatible(types: ArrayLike<string> | readonly string[] | undefined | null): boolean {
  return !!types && Array.from(types).some(type => TEXT_DROP_TYPES.has(type.toLowerCase()));
}

export interface DropGuardOptions {
  /** Whether this window takes dropped files at `target` (shows the copy cursor); default never. */
  acceptsFiles?: (target: EventTarget | null) => boolean;
}

/** The guard's decision for one `dragover`/`drop`, separate from the DOM for tests. */
export function guardDropEvent(event: DropGuardEventLike, options: DropGuardOptions = {}): void {
  const transfer = event.dataTransfer;
  // A handler nearer the target (the canvas) already took the drag and chose its drop effect.
  if (!transfer || event.defaultPrevented) return;
  if (dragCarriesFiles(transfer.types)) {
    event.preventDefault();
    if (event.type === "dragover") transfer.dropEffect = options.acceptsFiles?.(event.target) ? "copy" : "none";
    return;
  }
  // A link, text or HTML drag: allowed into editable fields, never a navigation anywhere else.
  if (dragIsTextCompatible(transfer.types) && isEditableDropTarget(event.target)) return;
  event.preventDefault();
  if (event.type === "dragover") transfer.dropEffect = "none";
}

export function installDropNavigationGuard(target: Window = window, options: DropGuardOptions = {}): () => void {
  const listener = (event: DragEvent) => guardDropEvent(event, options);
  target.addEventListener("dragover", listener);
  target.addEventListener("drop", listener);
  return () => {
    target.removeEventListener("dragover", listener);
    target.removeEventListener("drop", listener);
  };
}
