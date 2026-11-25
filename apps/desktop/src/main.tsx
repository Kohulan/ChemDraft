import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { perfProbeRequestedFromWindow } from "./perf/gate";
import { perfHook } from "./perf/runtime";
import { installContextMenuGuard } from "./contextMenuGuard";
import { installDropNavigationGuard } from "./imageDrop/dropNavigationGuard";
import { isBlockedByModalDialog } from "@chemdraft/shortcut-engine";
import "./App.css";

const utilityWindow = new URLSearchParams(window.location.search).has("window");
// The document window owns its canvas context menu; all other app windows share this guard.
if (utilityWindow) installContextMenuGuard();
// No drop navigates any window. Only the document window takes files (outside modal dialogs); a
// file dropped on a palette, popover or dialog is refused there.
installDropNavigationGuard(window, utilityWindow ? {} : { acceptsFiles: target => !isBlockedByModalDialog(target) });

function mount() {
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
// Probe calibration is background work: even a never-settling IPC must not delay React mount.
if (perfHook(() => perfProbeRequestedFromWindow())) perfHook(() => {
  return (new URLSearchParams(window.location.search).has("window")
    ? import("./perf/runtime").then(module => perfHook(() => module.startPerfProbe()))
    : import("./MainWindow").then(module => perfHook(() => module.startMainWindowPerfProbe())));
});
mount();
