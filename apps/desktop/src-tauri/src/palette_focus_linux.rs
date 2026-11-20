//! GTK input arrives before the web process classifies a click. Preserve its GDK
//! timestamp and let the compositor confirm (or refuse) the subsequent presentation.

use super::{end, now, publish_click, state, wall_time, End, GUARD};
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
    }
    press.connect_pressed(move |gesture, _, _, _| {
        let primary = gesture.current_button() == 1;
        if is_input_focus_window_label(&label)
            && (primary || crate::is_plugin_panel_window_label(&label))
        {
            let focused = owner.upgrade().is_some_and(|w| w.has_toplevel_focus());
            if GUARD.lock().unwrap().has_confirmed_focus(&label, focused) {
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

pub(crate) fn focus_changed<R: Runtime>(window: &tauri::Window<R>, active: bool) {
    if let Some(target) = window.app_handle().get_webview_window(window.label()) {
        // Ignore stale events in either direction if a newer transition has already occurred.
        if active
            != target
                .gtk_window()
                .is_ok_and(|w| w.has_toplevel_focus() && w.is_visible())
        {
            return;
        }
        panel_window::activation(&target, active);
        GUARD
            .lock()
            .unwrap()
            .focus_changed(window.label(), active, now());
    }
}

pub(crate) async fn acquire(
    window: tauri::WebviewWindow,
    page_token: &str,
    generation: u64,
    click_sequence: Option<u64>,
    before: u64,
) -> Result<bool, String> {
    let Some(epoch) = panel_window::request(&window, generation, page_token, true, false) else {
        return Ok(false);
    };
    let target = window.clone();
    let request = run_on_main_thread_blocking(&window, move || {
        let native = target.gtk_window().map_err(|error| error.to_string())?;
        if !panel_window::is_current(&target, generation, epoch)
            || !panel_window::holds_input_focus(&target)
            || !native.is_visible()
            || target.is_minimized().unwrap_or(true)
            || !crate::foreground_belongs_to_app()
        {
            return Ok(state::FocusRequest::Denied);
        }
        let request = GUARD.lock().unwrap().request_focus(
            target.label(),
            click_sequence,
            before,
            now(),
            native.has_toplevel_focus(),
        );
        if !matches!(request, state::FocusRequest::Denied) {
            native.set_accept_focus(true);
        }
        if let state::FocusRequest::Present { timestamp, .. } = &request {
            native.present_with_time(*timestamp);
        }
        Ok(request)
    })?;
    // Wait on the IPC task, leaving the GTK thread free to deliver Focused.
    let confirmed = match request {
        Ok(request) => Ok(request.confirmed().await),
        Err(error) => Err(error),
    };
    let target = window.clone();
    run_on_main_thread_blocking(&window, move || {
        let result = confirmed.and_then(|confirmed| {
            if !confirmed
                || !panel_window::is_current(&target, generation, epoch)
                || !panel_window::holds_input_focus(&target)
                || !panel_window::is_active(&target)?
            {
                return Ok(false);
            }
            let webview: &tauri::Webview = target.as_ref();
            webview.set_focus().map_err(|error| error.to_string())?;
            Ok(true)
        });
        let held = panel_window::acquired(&target, generation, epoch, matches!(result, Ok(true)));
        if !held && panel_window::is_current(&target, generation, epoch) {
            let _ = target.set_focusable(false);
        }
        end(
            target.app_handle(),
            target.label(),
            if held { End::Acquired } else { End::Refused },
            click_sequence,
            before,
        );
        result.map(|_| held)
    })?
}
