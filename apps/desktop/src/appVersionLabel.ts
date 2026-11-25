// The detection keyboardShortcuts.ts wraps as detectDesktopShortcutPlatform(), taken from the engine
// directly so the About window does not load the whole command registry.
import { detectShortcutPlatform, type ShortcutPlatform } from "@chemdraft/shortcut-engine";

/** Owner rule: a Linux beta is named after its parent version plus β ("1.2.3β"). */
export const LINUX_BETA_MARK = "β";

/**
 * The version as the running build shows it: "1.2.3β" on Linux, "1.2.3" on macOS and Windows.
 * The platform defaults to detection so one test host can check every platform. Mirrors
 * `version_label_for` in src-tauri/src/lib.rs.
 */
export function versionLabel(version: string, platform: ShortcutPlatform = detectShortcutPlatform()): string {
  return platform === "linux" ? version + LINUX_BETA_MARK : version;
}

/**
 * The document window title. macOS, Windows and the browser keep "Name — ChemDraft"; the Linux
 * desktop build names its version ("Name — ChemDraft 1.2.3β"), as Rust's main_window_title does
 * before a document is open. Pass "web" for the browser build, which is not a Linux beta.
 */
export function documentWindowTitle(
  documentName: string,
  dirty: boolean,
  worktreeLabel: string,
  version: string,
  platform: ShortcutPlatform | "web" = detectShortcutPlatform()
): string {
  const product = platform === "linux" ? "ChemDraft " + versionLabel(version, platform) : "ChemDraft";
  return `${documentName}${dirty ? " •" : ""} — ${product}${worktreeLabel ? ` — ${worktreeLabel}` : ""}`;
}
