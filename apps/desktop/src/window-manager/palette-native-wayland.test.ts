import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps native Wayland toolbars resizable at the GTK level while fitting their content", () => {
  const source = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const open = source.split("fn ensure_toolset_window<")[1]!.split("fn install_toolset_input_focus<")[0]!;
  expect(open).toMatch(/#\[cfg\(target_os = "linux"\)\]\s*let native_resizable = resizable\s*\|\| run_on_main_thread_blocking\(app,/);
  expect(open).toContain("gtk::gdk::Display::default().is_some_and(|display| display.backend().is_wayland())");
  expect(open).toMatch(/#\[cfg\(not\(target_os = "linux"\)\)\]\s*let native_resizable = resizable;/);
  expect(open).toContain(".resizable(native_resizable)");
  expect(open).toContain("&resizable={resizable}");
});
