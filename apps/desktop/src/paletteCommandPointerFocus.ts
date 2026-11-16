import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { detectDesktopShortcutPlatform } from "./keyboardShortcuts";
import { isPaletteCommandButton } from "./commandHitBoxes";

/** WebView2 can activate a NOACTIVATE window when a button takes DOM focus.
 * Capture both pointer and compatibility mouse presses without consuming their
 * release/click. Form controls and colour-picker interactions keep their defaults. */
export function preventPaletteCommandPointerFocus(
  event: { target: EventTarget | null; preventDefault(): void },
  platform: ShortcutPlatform = detectDesktopShortcutPlatform()
): void {
  if (platform !== "windows" || !(event.target instanceof Element)) return;
  if (isPaletteCommandButton(event.target)) event.preventDefault();
}
