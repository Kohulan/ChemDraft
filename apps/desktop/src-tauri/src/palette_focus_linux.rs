//! GTK input arrives before the web process classifies a click. Preserve its GDK
//! timestamp and let the compositor confirm (or refuse) the subsequent presentation.

use super::{end, now, publish, publish_click, state, wall_time, End, GUARD};
use crate::{
    is_input_focus_window_label, panel_window, run_on_main_thread_blocking, MAIN_WINDOW_LABEL,
};
use gtk::{gdk, glib::translate::ToGlibPtr, prelude::*};
use std::os::raw::{c_int, c_ulong, c_void};
use tauri::{Manager, Runtime, WebviewWindow};

pub(crate) fn install<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let native = window.gtk_window().map_err(|error| error.to_string())?;
    // GTK3 holds gesture controllers weakly. Keep one capture observer for the
    // lifetime of this widget across page reloads and repeated document reveals.
    const OBSERVER: &str = "chemdraft-palette-pointer-observer";
    // SAFETY: this private key only ever stores a GestureMultiPress on the GTK thread.
    if unsafe { native.data::<gtk::GestureMultiPress>(OBSERVER) }.is_some() {
        return Ok(());
    }
    let press = gtk::GestureMultiPress::new(&native);
    press.set_button(0);
    press.set_propagation_phase(gtk::PropagationPhase::Capture);
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let owner = native.downgrade();
    if is_input_focus_window_label(&label) {
        native.set_focus_on_map(false);
        let source = label.clone();
        // A compositor can deliver keys to a refused presentation. Stop them
        // before GtkWindow dispatches a menu accelerator or WebKit forwards a shortcut.
        native.connect_key_press_event(move |_, _| {
            (!GUARD.lock().unwrap().allows_window_keys(&source)).into()
        });
    }
    press.connect_pressed(move |gesture, _, _, _| {
        let primary = gesture.current_button() == 1;
        if is_input_focus_window_label(&label)
            && (primary || crate::is_plugin_panel_window_label(&label))
        {
            let focused = owner.upgrade().is_some_and(|w| w.has_toplevel_focus());
            if focused && GUARD.lock().unwrap().has_confirmed_focus(&label) {
                // A second click in a key field needs no new acquisition or key guard.
                end(&app, "", End::Outside, None, 0);
                return;
            }
            let timestamp = gesture
                .last_event(gesture.current_sequence().as_ref())
                .map_or(0, |event| event.time());
            let event = GUARD
                .lock()
                .unwrap()
                .gtk_pointer(&label, now(), wall_time(), timestamp);
            publish_click(&app, &label, event);
        } else {
            end(&app, "", End::Outside, None, 0);
        }
    });
    // SAFETY: same key and type as above; GTK drops the value with the widget.
    unsafe { native.set_data(OBSERVER, press) };

    if window.label() == MAIN_WINDOW_LABEL {
        let app = window.app_handle().clone();
        // Run before GtkWindow's default key-press handler forwards to its focused
        // WebKit child or dispatches menu accelerators. Field-window keys pass normally.
        native.connect_key_press_event(move |_, event| {
            let state = app.state::<panel_window::PanelFocusState>();
            let leased = state
                .0
                .lock()
                .unwrap()
                .values()
                .any(|lease| lease.is_held());
            let modifiers = event.state();
            let key = match event.keyval() {
                gdk::keys::constants::Delete | gdk::keys::constants::KP_Delete => "Delete".into(),
                gdk::keys::constants::BackSpace => "Backspace".into(),
                other => other
                    .to_unicode()
                    .filter(|c| !c.is_control())
                    .map(String::from)
                    .or_else(|| other.name().map(|name| name.to_string()))
                    .unwrap_or_default(),
            };
            state::blocks_document_key(
                super::blocks_document(),
                leased,
                &key,
                modifiers.intersects(gdk::ModifierType::META_MASK | gdk::ModifierType::SUPER_MASK),
                modifiers.contains(gdk::ModifierType::CONTROL_MASK),
                modifiers.contains(gdk::ModifierType::MOD1_MASK),
            )
            .into()
        });
    }
    Ok(())
}

#[link(name = "gdk-3")]
extern "C" {
    fn gdk_x11_window_get_xid(window: *mut gdk::ffi::GdkWindow) -> c_ulong;
    fn gdk_x11_display_get_xdisplay(display: *mut gdk::ffi::GdkDisplay) -> *mut c_void;
    fn gdk_x11_display_error_trap_push(display: *mut gdk::ffi::GdkDisplay);
    fn gdk_x11_display_error_trap_pop(display: *mut gdk::ffi::GdkDisplay) -> c_int;
}
#[link(name = "X11")]
extern "C" {
    fn XSetInputFocus(
        display: *mut c_void,
        focus: c_ulong,
        revert_to: c_int,
        time: c_ulong,
    ) -> c_int;
    fn XGetInputFocus(
        display: *mut c_void,
        focus_return: *mut c_ulong,
        revert_to_return: *mut c_int,
    ) -> c_int;
}

/// The palette refused the click's WM_TAKE_FOCUS: it was not yet accepting focus. A window
/// manager may then keep it as its pending focus target and drop the `_NET_ACTIVE_WINDOW`
/// request that `present_with_time` sends (KWin returns early for its most recently activated
/// window, XWayland clients in a Plasma Wayland session included). No focus-in arrives, and
/// the field never gets keys. ICCCM 4.1.7 lets a client focus its own window with the
/// timestamp of the button press that asked for it, so take the focus directly. The X server
/// ignores a stale timestamp. Native Wayland is unaffected.
///
/// Weston's XWM does not allow this: it resets any client focus change on a managed window to
/// the window the compositor last activated (its own no-focus window when there is none), and
/// it ignores `_NET_ACTIVE_WINDOW`. Under Weston only a pointer press that the compositor itself
/// sees can focus the palette. The returned text records what happened, for the diagnostic.
fn take_x11_click_focus(native: &gtk::ApplicationWindow, timestamp: u32) -> String {
    const REVERT_TO_PARENT: c_int = 2;

    let Some(window) = native.window() else {
        return "skipped:unrealized".into();
    };
    let display = window.display();
    let x11 = display.backend().is_x11();
    let Some(time) = state::click_focus_time(x11, timestamp) else {
        let reason = if x11 {
            "skipped:no-click-time"
        } else {
            "skipped:not-x11"
        };
        return reason.into();
    };
    let window_ptr: *mut gdk::ffi::GdkWindow = window.to_glib_none().0;
    let display_ptr: *mut gdk::ffi::GdkDisplay = display.to_glib_none().0;
    // SAFETY: GTK's main thread, on an X11 display (checked above) and a realized toplevel
    // that outlives these calls. The trap absorbs BadMatch if the window stopped being viewable;
    // popping it synchronizes once, so the X error code (0 for none) is known here.
    let (xid, error) = unsafe {
        let xid = gdk_x11_window_get_xid(window_ptr);
        gdk_x11_display_error_trap_push(display_ptr);
        XSetInputFocus(
            gdk_x11_display_get_xdisplay(display_ptr),
            xid,
            REVERT_TO_PARENT,
            c_ulong::from(time),
        );
        (xid, gdk_x11_display_error_trap_pop(display_ptr))
    };
    display.flush();
    format!("sent:window=0x{xid:x},time={time},x-error={error}")
}

/// Which X window holds the keyboard now, next to this palette's own, for the diagnostic.
/// A window manager that undid `take_x11_click_focus` shows up here as a foreign window.
fn x11_focus_report(native: &gtk::ApplicationWindow) -> String {
    let Some(window) = native.window() else {
        return "x-focus=unrealized".into();
    };
    let display = window.display();
    if !display.backend().is_x11() {
        return "x-focus=n/a".into();
    }
    let window_ptr: *mut gdk::ffi::GdkWindow = window.to_glib_none().0;
    let display_ptr: *mut gdk::ffi::GdkDisplay = display.to_glib_none().0;
    let mut focus: c_ulong = 0;
    let mut revert: c_int = 0;
    // SAFETY: GTK's main thread, on an X11 display (checked above); XGetInputFocus only
    // writes the two out-parameters, which live on this stack frame.
    let xid = unsafe {
        XGetInputFocus(
            gdk_x11_display_get_xdisplay(display_ptr),
            &mut focus,
            &mut revert,
        );
        gdk_x11_window_get_xid(window_ptr)
    };
    format!("x-focus=0x{focus:x} palette-window=0x{xid:x}")
}

/// One line per Linux field acquisition, written whatever the agent-bridge setting, so a
/// CI log shows where focus went without changing what the smoke tests. Field order: what
/// started it, the window system, accept-focus before and after, the request the key guard
/// made, the X11 focus call, the presentation, the outcome, and the key guard at the end.
struct AcquireLog {
    label: String,
    trigger: String,
    backend: &'static str,
    accept_before: Option<bool>,
    request: String,
    x11: String,
    present: Option<u32>,
}

impl AcquireLog {
    fn new(label: &str, click_sequence: Option<u64>, before: u64) -> Self {
        let click = click_sequence.map_or_else(|| "none".to_owned(), |s| s.to_string());
        Self {
            label: label.to_owned(),
            trigger: format!(
                "page-click={click} pointer-before={before} {}",
                GUARD.lock().unwrap().describe_pending_click()
            ),
            backend: "unknown",
            accept_before: None,
            request: String::new(),
            x11: "not-called".into(),
            present: None,
        }
    }

    fn emit(&self, outcome: &str, end: &str) {
        let accept_before = self
            .accept_before
            .map_or_else(|| "unknown".to_owned(), |a| a.to_string());
        let present = self
            .present
            .map_or_else(|| "not-called".to_owned(), |time| format!("time={time}"));
        crate::palette_focus_log_always(format_args!(
            "linux-acquire label={} {} backend={} accept-focus-before={accept_before} \
             request={} xsetinputfocus={} present-with-time={present} outcome={outcome} {end}",
            self.label, self.trigger, self.backend, self.request, self.x11
        ));
    }
}

fn backend_name(native: &gtk::ApplicationWindow) -> &'static str {
    match native.display().backend() {
        gdk::Backend::X11 => "x11",
        gdk::Backend::Wayland => "wayland",
        _ => "other",
    }
}

pub(crate) fn set_keyboard_popover(label: &str, keyboard: bool) {
    GUARD.lock().unwrap().set_keyboard_popover(label, keyboard);
}

pub(crate) fn has_confirmed_focus(label: &str) -> bool {
    GUARD.lock().unwrap().has_confirmed_focus(label)
}

// A reopened window can reuse both the Tauri label and the page's JS generations.
// Resolve the actual GTK widget before acting on a queued event or IPC completion.
fn current_window<R: Runtime>(
    window: &tauri::Window<R>,
) -> Option<(WebviewWindow<R>, gtk::ApplicationWindow)> {
    let target = window.app_handle().get_webview_window(window.label())?;
    let native = target.gtk_window().ok()?;
    (window.gtk_window().ok()? == native).then_some((target, native))
}

pub(crate) fn focus_changed<R: Runtime>(window: &tauri::Window<R>, active: bool) {
    let Some((target, native)) = current_window(window) else {
        return;
    };
    if active != (native.has_toplevel_focus() && native.is_visible()) {
        return;
    }
    if active {
        GUARD.lock().unwrap().focus_in(window.label(), now());
    } else {
        panel_window::activation(&target, false);
    }
}

pub(crate) async fn acquire(
    window: tauri::WebviewWindow,
    page_token: &str,
    generation: u64,
    click_sequence: Option<u64>,
    before: u64,
) -> Result<bool, String> {
    let page_token = page_token.to_owned();
    let target = window.clone();
    let started = now();
    let (request, mut log) = run_on_main_thread_blocking(&window, move || {
        let mut log = AcquireLog::new(target.label(), click_sequence, before);
        let Some((_, native)) = current_window(&target.as_ref().window()) else {
            log.request = "denied:window-replaced".into();
            return (None, log);
        };
        log.backend = backend_name(&native);
        log.accept_before = Some(native.accepts_focus());
        let Some(epoch) = panel_window::request(&target, generation, &page_token, true, false)
        else {
            log.request = "denied:stale-page-or-generation".into();
            return (None, log);
        };
        let request = GUARD.lock().unwrap().request_focus(
            target.label(),
            click_sequence,
            before,
            now(),
            native.has_toplevel_focus(),
        );
        let sequence = request.sequence();
        let kind = match &request {
            state::FocusRequest::Denied => "denied:no-current-gtk-click",
            state::FocusRequest::Focused(_) => "focused",
            state::FocusRequest::Present { .. } => "present",
        };
        log.request = kind.into();
        let refusal = if !native.is_visible() {
            Some("denied:hidden")
        } else if target.is_minimized().unwrap_or(true) {
            Some("denied:minimized")
        } else if !crate::foreground_belongs_to_app() {
            // No ChemDraft window has toplevel focus, so a delayed request could steal
            // focus from another application.
            Some("denied:app-not-focused")
        } else {
            None
        };
        if let Some(refusal) = refusal {
            // Keep the guard's own verdict: it shows whether the GTK press matched.
            log.request = format!("{refusal}(guard:{kind})");
            return (Some((epoch, sequence, state::FocusRequest::Denied)), log);
        }
        if !matches!(request, state::FocusRequest::Denied) {
            native.set_accept_focus(true);
        }
        if let state::FocusRequest::Present { timestamp, .. } = &request {
            log.x11 = take_x11_click_focus(&native, *timestamp);
            native.present_with_time(*timestamp);
            log.present = Some(*timestamp);
        }
        (Some((epoch, sequence, request)), log)
    })?;
    let Some((epoch, sequence, request)) = request else {
        log.emit("not-requested", "");
        return Ok(false);
    };
    // Wait on the IPC task, leaving the GTK thread free to deliver Focused.
    let confirmed = request.confirmed().await;
    if log.request == "present" {
        log.request = if confirmed {
            "present:focus-in"
        } else {
            "present:timeout-or-cancelled"
        }
        .into();
    }
    let target = window.clone();
    run_on_main_thread_blocking(&window, move || {
        let elapsed = now().saturating_sub(started);
        let Some((_, native)) = current_window(&target.as_ref().window()) else {
            log.emit("window-replaced", &format!("elapsed-ms={elapsed}"));
            return Ok(false);
        };
        if !panel_window::is_current(&target, generation, epoch) {
            log.emit(
                "superseded",
                &format!("elapsed-ms={elapsed} {}", x11_focus_report(&native)),
            );
            return Ok(false);
        }
        let mut refusal = "";
        let result = (|| {
            refusal = if !confirmed {
                "no-focus-in"
            } else if !sequence.is_some_and(|seq| {
                GUARD
                    .lock()
                    .unwrap()
                    .ticket_is_current(target.label(), seq, now())
            }) {
                "stale-click"
            } else if !panel_window::holds_input_focus(&target) {
                "lease-lost"
            } else if !native.has_toplevel_focus() {
                "no-toplevel-focus"
            } else if !panel_window::is_active(&target)? {
                "window-inactive"
            } else {
                ""
            };
            if !refusal.is_empty() {
                return Ok(false);
            }
            let webview: &tauri::Webview = target.as_ref();
            webview.set_focus().map_err(|error| error.to_string())?;
            Ok(true)
        })();
        let (held, event) =
            GUARD
                .lock()
                .unwrap()
                .finish_focus(target.label(), sequence, now(), |eligible| {
                    panel_window::acquired(
                        &target,
                        generation,
                        epoch,
                        eligible && matches!(result, Ok(true)),
                    )
                });
        publish(target.app_handle(), event);
        if !held {
            native.set_accept_focus(false);
        }
        let outcome = match (&result, held) {
            (Err(_), _) => "error".to_owned(),
            (_, true) => "held".to_owned(),
            (Ok(true), false) => "refused:lease-not-settled".to_owned(),
            (Ok(false), false) => format!("refused:{refusal}"),
        };
        let window_keys = GUARD.lock().unwrap().allows_window_keys(target.label());
        log.emit(
            &outcome,
            &format!(
                "elapsed-ms={elapsed} toplevel-focus={} accept-focus-after={} {} \
                 key-guard=window-keys:{window_keys},document-blocked:{}",
                native.has_toplevel_focus(),
                native.accepts_focus(),
                x11_focus_report(&native),
                super::blocks_document(),
            ),
        );
        result.map(|_| held)
    })?
}
