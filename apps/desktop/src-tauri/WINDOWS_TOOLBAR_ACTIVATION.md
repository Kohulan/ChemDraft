# Windows toolbar activation investigation

Native-only handoff, 2026-11-15. Windows execution and the reported shadow blink
have not been reproduced on this macOS host. This is a partial fix: WebView2's
DOM focus defaults and explicit E/Z keyboard focus remain outside this change.

## Activation paths

| Path | Can run on a mouse press after keyboard/editing use? | Finding |
| --- | --- | --- |
| `panel_window.rs::focus_subclass`, `WM_MOUSEACTIVATE` | Yes | Previously called the default subclass chain before returning `MA_NOACTIVATE`, and only over registered enabled drawing-command rectangles while the foreground process was ChemDraft. Missing/stale rectangles, other buttons, right clicks, and every popover fell through. Now command hits return `MA_NOACTIVATE` before that chain, without a foreground-process condition. Command flyouts use the same result over their whole surface. The original mouse message is delivered; no event is eaten or replayed. |
| `palette_key_guard.rs::windows::observe` | Yes | Observes `WM_MOUSEACTIVATE`, then delegates; it does not itself activate. The new early-return path explicitly runs the same pending-key observation, once. |
| `panel_window.rs::focus_subclass`, `WM_NCACTIVATE` | On activation | Existing `lParam=-1` suppresses nonclient repaint, preserving real activation bookkeeping. It does not prevent activation or reliably freeze DWM's shadow. Unchanged. |
| `panel_window.rs::resize_subclass` / `overlay_subclass` | Only plugin/report panels | Resize subclass returns `MA_ACTIVATE`; overlay forwards to its parent. Installed by `install_resize_hit_test` for report panels, not by `install_toolset_input_focus` for palettes/popovers. Unchanged. |
| `set_plugin_panel_input_focus` -> `focus_if_app_active` -> `SetActiveWindow` -> WebView2 `MoveFocus` | Yes, queued IPC from an editable control | `WS_EX_NOACTIVATE` does not prohibit explicit activation. Command presses now cancel a pending lease synchronously and forbid acquisition until a subsequent non-command press. Colour-to-flyout reuse invalidates the lease and forbids edit-focus acquisition while command content is installed. Deliberate editing still uses its existing lease. |
| `return_focus_after_interaction` / `return_focus_to_document` | Yes, on release/blur/idle/drag completion | Only calls `SetForegroundWindow` on the **document**, guarded by exact source/document foreground ownership, then focuses the document webview. Does not restore focus to a toolbar. |
| `route_toolset_command` -> `focus_main_document_window_impl(Force)` | Yes, after command dispatch | Refocuses the document unless an input lease/preserve request retains the palette. Its `set_focus()` never targets the palette. |
| `set_plugin_panel_activation` | Only a plugin report's input request | Checks genuine report activation before focusing its webview. Toolsets use the separate palette lease path. |
| `lib.rs` document reveal, main focus, file-open, single-instance paths | On explicit document requests | Their `set_focus()` targets `main`. The non-macOS `focus_native_document_window` itself is a no-op. |
| `dialog_windows.rs::show_on_main`, reopen, `bring_to_front_on_main` | A toolbar command may open a dialog | `set_focus()` targets the registered dialog. The raise uses `SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOOWNERZORDER`, and never focuses the toolbar sibling used as its z-order anchor. |
| `ensure_spin3d_debugger_window` | Only a debugger request | Explicit `set_focus()` targets the debugger, not a toolbar. |
| `utility_window_builder`, popover/tooltip builders, all subsequent `show()` calls | Yes, when showing/reusing a utility | `focused(false)` is retained by Tao for its lifetime and selects `SW_SHOWNOACTIVATE`. No toolbar path using raw `ShowWindow(SW_SHOW)` was found. The raw maximized show is document-only. |
| `restore_utility_window`, `raise_among_owned_windows` | Yes, suspension restore/popover reveal | All explicit `SetWindowPos` calls include `SWP_NOACTIVATE`. Geometry flags and window shadow configuration are unchanged. |
| Position/size/focusability updates through Tao; drag compensation | Yes | Tao position and style updates include `SWP_NOACTIVATE`. A native drag enters `WM_NCLBUTTONDOWN`; Wry forwards `WM_ENTERSIZEMOVE` to `MoveFocus`, so dragging needs its own hands-on check. |
| `configure_toolset_popover_window`, `toolset_popover_extended_style` | On reuse/open | Ordinary flyouts preserve `WS_EX_NOACTIVATE`. E/Z keyboard opens still deliberately allow focus; see the renderer path below. |
| `PalettePopoverWindow.tsx` E/Z keyboard reveal | After an asynchronous keyboard open | Calls both `getCurrentWindow().setFocus()` and `getCurrentWebview().setFocus()`. Tao's window focus calls `SetForegroundWindow`, with a synthetic-Alt fallback. These calls bypass the native input-lease gate. |
| `window-manager/index.ts::focusMainDocumentWindow` | On document focus requests | Native call targets main, then calls current-window/current-webview `setFocus()`. Current callers must remain document-only; this helper is unsafe to reuse from a palette. |
| Browser default button focus / `pluginPanelInputFocus.ts` | Yes | The existing source explicitly documents that WebView2 can activate its parent despite `NOACTIVATE`/`WM_MOUSEACTIVATE`. It hands focus back on pointerdown/up/click and after a 32 ms idle activation check. This repairs focus after activation and can still expose a dark-shadow frame. A native `MA_NOACTIVATE` result alone cannot prove this path is gone. |

The only direct application `SetForegroundWindow` call found is the guarded
document hand-back. Tao's `set_focus` is the indirect force-activation path.
No macOS behavior, hold timer, command dispatch, dimensions, or shadow setting is
changed. No build stamp was bumped because no `apps/desktop/src` file was edited.

## Debugging the native result

Launch a Windows development build with `CHEMDRAFT_AGENT_BRIDGE=1` (or the existing
`--chemdraft-agent-bridge` argument), capturing stderr. The narrow logger enables
only the `chemdraft::windows_activation` target. Ordinary launches install no
logger and emit none of these diagnostics.

`WM_MOUSEACTIVATE label=toolset-core-main return=3 ...` means `MA_NOACTIVATE`.
For a flyout, `command_popover: true` must appear, even with no registered button
rectangles. `activation ... active=true` after such a return identifies a later
activation path. The log also records default-handler return values on editable
surfaces and rejected late input-focus requests. No logging includes field text.

## Remaining renderer work (outside native ownership)

1. In `ToolPalette.tsx` command buttons and `PalettePopoverWindow.tsx` flyout
   choices, suppress the Windows primary-pointer default that focuses the
   button/webview (`preventDefault` on pointerdown, with the platform supplied
   through the existing detection/test seam). Preserve real pointerup/click
   dispatch, pointer capture and the 200 ms hold timer. Do not suppress editable
   controls or native colour/select chooser defaults. Verify with real events:
   the gated bridge produces synthetic events and cannot prove default focus.
2. Remove Windows E/Z keyboard reveal's direct native window/webview `setFocus`
   calls; keep document keyboard ownership and route menu navigation to the
   command surface. Its existing native Focus-mode exception must be retired
   with that renderer change. Removing it here alone would break keyboard use.
3. `paletteInputFocusCapabilities.test.ts` currently asserts the old late-return,
   foreground-gated native implementation text. Update those assertions to the
   new policy; keep the native-colour-picker regression coverage.
4. Mixed toolbars still depend on renderer-supplied command hit boxes. Expand
   registration to every applicable non-editable command (including custom
   palettes), or supply explicit editable-control bounds before broadening the
   native policy. Forcing `MA_NOACTIVATE` indiscriminately is already documented
   to break WebView2 native colour popups. A literal never-active requirement for
   editable palette windows needs a separate input/keyboard ownership design.

## Charge hold then short press

`PaletteWindow.tsx` capture-phase pointerdown calls `dismissPaletteFlyouts`, even
on the same command button. This invalidates `popoverRequestRef`, clears replay,
queues `closeToolsetPopoverWindow` behind native open/content work, and broadcasts
dismissal. A drawing-command invocation also dismisses. The 200 ms hold timer
creates a fresh generation; a short press clears it. Rust's
`close_toolset_popover` immediately ends the lease and calls `hide()`; it has no
650 ms grace period.

The precise reason for the captured persistence is **not established**. Check
whether the short press reaches renderer pointerdown, whether its dismissal IPC
is delayed behind `popoverOperationsRef`, and whether a queued renderer reveal
arrives after close. Do not add an unversioned hide in `WM_MOUSEACTIVATE`: it would
leave the renderer's opening/replay live and could hide a newer valid hold.
If reproduced, fix the versioned renderer dismissal/reveal sequence and add a
350 ms hold -> short same-button press test with delayed native operations.

## Windows hands-on gate

Test fresh launch and again after HEX entry, native colour chooser use, caption
editing, and keyboard shortcuts. Capture synchronized foreground/active HWNDs,
native logs, and shadows for Main and its flyout: 350 ms Charge holds, short
same-button presses, bond/ring choices, and keyboard opens. Check no command
surface becomes active, shadow darkness stays constant, geometry stays fixed,
short presses dispatch exactly once, holds do not dispatch the primary command,
and a short press dismisses the old dropdown promptly. Also exercise disabled
commands, customized toolbars, mixed DPI, window dragging, and colour/select
editing. Windows runtime and Windows clippy/test remain unverified here; macOS
hands-on and Intel runtime are also unverified.

## Local verification

- macOS Apple silicon: `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`
  and `cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`
  passed. Sparkle was copied from the existing local framework into the ignored
  worktree build-support directory; no dependency was downloaded or installed.
- Full `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`: 838 passed,
  28 failed, 9 ignored. Twenty-seven failures were sandbox-denied loopback socket
  operations. One was the unrelated fake 3D sidecar round-trip assertion; it
  passed on an isolated rerun with `tests::engine3d_sidecar_session_manager_round_trips_fake_protocol -- --exact`.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml panel_window::`:
  all 45 passed, including the three new activation-policy tests.
- Focused Vitest using `--configLoader runner --no-cache`: the existing native
  source-shape assertion described above failed (9 other assertions passed).
  The flyout and dismissal DOM suites could not load React/Tauri API imports
  from this isolated worktree's existing dependency links. No `pnpm install`
  was run and no frontend file was edited.
- `git diff --check` passed. No desktop app was launched; no visual/platform
  acceptance result is claimed from these unit checks.
