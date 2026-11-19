import { useEffect, useState } from "react";
import { desktopPreferences } from "./desktopPreferences";
import { isKeybindingScheme, loadKeybindingSettings, saveKeybindingSettings, type KeybindingScheme } from "./keybindingSettings";
import { broadcastKeybindingSettings, listenForKeybindingSettings } from "./window-manager";

export function useShortcutPreference(): KeybindingScheme {
  const [scheme, setScheme] = useState(() => loadKeybindingSettings().scheme);
  useEffect(() => {
    let disposed = false;
    let changed = false;
    let unlisten: (() => void) | undefined;
    void listenForKeybindingSettings(next => {
      changed = true;
      setScheme(next.scheme);
    }).then(async stop => {
      if (disposed) { stop(); return; }
      unlisten = stop;
      const saved = (await desktopPreferences())?.shortcutScheme;
      if (!disposed && !changed && isKeybindingScheme(saved)) {
        saveKeybindingSettings({ scheme: saved });
        setScheme(saved);
      }
    }).catch(error => console.error("Could not load keyboard shortcuts", error));
    return () => { disposed = true; unlisten?.(); };
  }, []);
  return scheme;
}

export async function updateShortcutPreference(scheme: KeybindingScheme): Promise<void> {
  await desktopPreferences({ shortcutScheme: scheme });
  const settings = { scheme };
  saveKeybindingSettings(settings);
  await broadcastKeybindingSettings(settings);
}
