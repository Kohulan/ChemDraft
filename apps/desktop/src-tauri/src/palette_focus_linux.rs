//! GTK input arrives before the web process classifies a click. Preserve its GDK
//! timestamp and let the compositor confirm (or refuse) the subsequent presentation.

use super::{end, now, publish, publish_click, state, wall_time, End, GUARD};
use crate::{
    is_input_focus_window_label, panel_window, run_on_main_thread_blocking, MAIN_WINDOW_LABEL,
};
use gtk::{gdk, prelude::*};
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

/// The palette refused the click's WM_TAKE_FOCUS: it was not yet accepting focus. A window
/// manager may then keep it as its pending focus target and drop the `_NET_ACTIVE_WINDOW`
/// request that `present_with_time` sends (KWin returns early for its most recently activated
/// window, XWayland clients in a Plasma Wayland session included). No focus-in arrives, and
/// the field never gets keys. ICCCM 4.1.7 lets a client focus its own window with the
/// timestamp of the button press that asked for it, so take the focus directly. The X server
/// ignores a stale timestamp. Native Wayland is unaffected.
fn take_x11_click_focus(native: &gtk::ApplicationWindow, timestamp: u32) {
    use gtk::glib::translate::ToGlibPtr;
    use std::os::raw::{c_int, c_ulong, c_void};

    #[link(name = "gdk-3")]
    extern "C" {
        fn gdk_x11_window_get_xid(window: *mut gdk::ffi::GdkWindow) -> c_ulong;
        fn gdk_x11_display_get_xdisplay(display: *mut gdk::ffi::GdkDisplay) -> *mut c_void;
        fn gdk_x11_display_error_trap_push(display: *mut gdk::ffi::GdkDisplay);
        fn gdk_x11_display_error_trap_pop_ignored(display: *mut gdk::ffi::GdkDisplay);
    }
    #[link(name = "X11")]
    extern "C" {
        fn XSetInputFocus(
            display: *mut c_void,
            focus: c_ulong,
            revert_to: c_int,
            time: c_ulong,
        ) -> c_int;
    }
    const REVERT_TO_PARENT: c_int = 2;

    let Some(window) = native.window() else {
        return;
    };
    let display = window.display();
    let Some(time) = state::click_focus_time(display.backend().is_x11(), timestamp) else {
        return;
    };
    let window_ptr: *mut gdk::ffi::GdkWindow = window.to_glib_none().0;
    let display_ptr: *mut gdk::ffi::GdkDisplay = display.to_glib_none().0;
    // SAFETY: GTK's main thread, on an X11 display (checked above) and a realized toplevel
    // that outlives these calls. The trap absorbs BadMatch if the window stopped being viewable.
    unsafe {
        gdk_x11_display_error_trap_push(display_ptr);
        XSetInputFocus(
            gdk_x11_display_get_xdisplay(display_ptr),
            gdk_x11_window_get_xid(window_ptr),
            REVERT_TO_PARENT,
            c_ulong::from(time),
        );
        gdk_x11_display_error_trap_pop_ignored(display_ptr);
    }
    display.flush();
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
    let request = run_on_main_thread_blocking(&window, move || {
        let (_, native) = current_window(&target.as_ref().window())?;
        let epoch = panel_window::request(&target, generation, &page_token, true, false)?;
        let request = GUARD.lock().unwrap().request_focus(
            target.label(),
            click_sequence,
            before,
            now(),
            native.has_toplevel_focus(),
        );
        let sequence = request.sequence();
        if !native.is_visible()
            || target.is_minimized().unwrap_or(true)
            || !crate::foreground_belongs_to_app()
        {
            return Some((epoch, sequence, state::FocusRequest::Denied));
        }
        if !matches!(request, state::FocusRequest::Denied) {
            native.set_accept_focus(true);
        }
        if let state::FocusRequest::Present { timestamp, .. } = &request {
            take_x11_click_focus(&native, *timestamp);
            native.present_with_time(*timestamp);
        }
        Some((epoch, sequence, request))
    })?;
    let Some((epoch, sequence, request)) = request else {
        return Ok(false);
    };
    // Wait on the IPC task, leaving the GTK thread free to deliver Focused.
    let confirmed = request.confirmed().await;
    let target = window.clone();
    run_on_main_thread_blocking(&window, move || {
        let Some((_, native)) = current_window(&target.as_ref().window()) else {
            return Ok(false);
        };
        if !panel_window::is_current(&target, generation, epoch) {
            return Ok(false);
        }
        let result = (|| {
            if !confirmed
                || !sequence.is_some_and(|seq| {
                    GUARD
                        .lock()
                        .unwrap()
                        .ticket_is_current(target.label(), seq, now())
                })
                || !panel_window::holds_input_focus(&target)
                || !native.has_toplevel_focus()
                || !panel_window::is_active(&target)?
            {
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
        result.map(|_| held)
    })?
}
