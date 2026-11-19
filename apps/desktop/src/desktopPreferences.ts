import { invoke, isTauri } from "@tauri-apps/api/core";
import type { KeybindingScheme } from "./keybindingSettings";

export interface DesktopPreferences {
  shortcutScheme?: KeybindingScheme;
  guidedTourSeen?: true;
}

/** The native settings file is shared by the document window and Preferences. */
export function desktopPreferences(patch?: DesktopPreferences): Promise<DesktopPreferences> {
  return isTauri() ? invoke("desktop_preferences", { patch }) : Promise.resolve({});
}
