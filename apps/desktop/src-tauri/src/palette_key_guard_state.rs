//! Pure pending-click policy. Times are supplied by the caller so timeout and IPC
//! ordering are testable without AppKit, WebView2 or a Tauri event loop.

pub(super) const TIMEOUT_MS: u64 = 1_000;

#[derive(Debug)]
struct Pending {
    label: String,
    sequence: u64,
    started: u64,
    wall_time: u64,
    #[cfg(any(target_os = "linux", test))]
    native_time: u32,
    #[cfg(any(target_os = "linux", test))]
    confirmation: Option<tokio::sync::oneshot::Sender<()>>,
}

#[derive(Default)]
pub(super) struct Guard {
    #[cfg(any(target_os = "linux", target_os = "macos", windows, test))]
    sequence: u64,
    pending: Option<Pending>,
    #[cfg(any(target_os = "linux", test))]
    focused: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Event {
    pub sequence: u64,
    pub pending: bool,
    pub expires_at: u64,
}

#[derive(Clone, Copy)]
pub(crate) enum End {
    Acquired,
    Refused,
    Released,
    Drag,
    Hide,
    Destroy,
    Deactivated,
    Outside,
}

impl Guard {
    pub const fn new() -> Self {
        Self {
            #[cfg(any(target_os = "linux", target_os = "macos", windows, test))]
            sequence: 0,
            pending: None,
            #[cfg(any(target_os = "linux", test))]
            focused: None,
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows, test))]
    pub fn pointer(&mut self, label: &str, now: u64, wall_time: u64) -> Event {
        self.sequence += 1;
        self.pending = Some(Pending {
            label: label.to_owned(),
            sequence: self.sequence,
            started: now,
            wall_time,
            #[cfg(any(target_os = "linux", test))]
            native_time: 0,
            #[cfg(any(target_os = "linux", test))]
            confirmation: None,
        });
        Event {
            sequence: self.sequence,
            pending: true,
            expires_at: wall_time + TIMEOUT_MS,
        }
    }

    pub fn blocks(&self, now: u64) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|p| now.saturating_sub(p.started) < TIMEOUT_MS)
    }

    fn clear(&mut self) -> Option<(String, Event)> {
        let pending = self.pending.take()?;
        Some((
            pending.label,
            Event {
                sequence: pending.sequence,
                pending: false,
                expires_at: 0,
            },
        ))
    }

    pub fn end(
        &mut self,
        label: &str,
        why: End,
        sequence: Option<u64>,
        before: u64,
    ) -> Option<(String, Event)> {
        #[cfg(any(target_os = "linux", test))]
        if matches!(why, End::Deactivated | End::Hide | End::Destroy)
            && self.focused.as_deref() == Some(label)
        {
            self.focused = None;
        }
        let pending = self.pending.as_ref()?;
        if matches!(why, End::Outside) || (matches!(why, End::Deactivated) && label.is_empty()) {
            return self.clear();
        }
        if pending.label != label && !(label.is_empty() && matches!(why, End::Released)) {
            return None;
        }
        // The page captures both values BEFORE queuing IPC. An old release must
        // never clear a later click, even in the same palette. A strict timestamp
        // comparison is a conservative fallback only for pointer classification
        // (before == 0 means no pointerdown). Escape, blur and observer cleanup
        // without a sequence cannot clear a pending click. An ambiguous
        // same-millisecond click expires on the native timer.
        if matches!(why, End::Released | End::Refused)
            && !match sequence {
                Some(sequence) => sequence == pending.sequence,
                None => before != 0 && pending.wall_time < before,
            }
        {
            return None;
        }
        // Acquired is reported only after native focus succeeds: this window is
        // now key, including if another click arrived during the focus operation.
        self.clear()
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows, test))]
    pub fn timeout(&mut self, sequence: u64, now: u64) -> Option<(String, Event)> {
        if self
            .pending
            .as_ref()
            .is_some_and(|p| p.sequence == sequence)
            && !self.blocks(now)
        {
            self.clear()
        } else {
            None
        }
    }
}

// A GTK presentation completes on a later window event. Keeping the reply with the
// click lets the existing hide, outside-click and expiry paths cancel the wait.
#[cfg(any(target_os = "linux", test))]
pub(super) enum FocusRequest {
    Denied,
    Focused,
    Present {
        timestamp: u32,
        remaining_ms: u64,
        confirmed: tokio::sync::oneshot::Receiver<()>,
    },
}

#[cfg(any(target_os = "linux", test))]
impl FocusRequest {
    pub async fn confirmed(self) -> bool {
        match self {
            Self::Denied => false,
            Self::Focused => true,
            Self::Present {
                confirmed,
                remaining_ms,
                ..
            } => matches!(
                tokio::time::timeout(std::time::Duration::from_millis(remaining_ms), confirmed)
                    .await,
                Ok(Ok(()))
            ),
        }
    }
}

#[cfg(any(target_os = "linux", test))]
impl Guard {
    pub fn has_confirmed_focus(&self, label: &str, native_focused: bool) -> bool {
        native_focused && self.focused.as_deref() == Some(label)
    }

    pub fn gtk_pointer(&mut self, label: &str, now: u64, wall_time: u64, timestamp: u32) -> Event {
        // A double-click on the same field reuses its outstanding DOM lease.
        let waiting = self
            .pending
            .as_mut()
            .filter(|p| p.label == label)
            .and_then(|p| p.confirmation.take());
        let event = self.pointer(label, now, wall_time);
        let pending = self.pending.as_mut().unwrap();
        pending.native_time = timestamp;
        pending.confirmation = waiting;
        event
    }

    pub fn focus_changed(&mut self, label: &str, active: bool, now: u64) {
        if active {
            self.focused = Some(label.to_owned());
            if let Some(reply) = self
                .pending
                .as_mut()
                .filter(|p| p.label == label && now.saturating_sub(p.started) < TIMEOUT_MS)
                .and_then(|p| p.confirmation.take())
            {
                let _ = reply.send(());
            }
        } else if self.focused.as_deref() == Some(label) {
            self.focused = None;
        }
    }

    pub fn request_focus(
        &mut self,
        label: &str,
        sequence: Option<u64>,
        before: u64,
        now: u64,
        native_focused: bool,
    ) -> FocusRequest {
        // A second control in a key window will not produce another focus-in event.
        if self.has_confirmed_focus(label, native_focused) {
            return FocusRequest::Focused;
        }
        let Some(p) = self.pending.as_mut().filter(|p| {
            p.label == label
                && p.native_time != 0
                && match sequence {
                    // The pointerdown may still have the preceding click's sequence if the
                    // native event is in flight. Its wall time can identify the newer click.
                    Some(seq) => p.sequence == seq || (seq < p.sequence && p.wall_time < before),
                    None => before == 0 || p.wall_time <= before,
                }
        }) else {
            return FocusRequest::Denied;
        };
        let remaining_ms = TIMEOUT_MS.saturating_sub(now.saturating_sub(p.started));
        if remaining_ms == 0 {
            return FocusRequest::Denied;
        }
        let (reply, confirmed) = tokio::sync::oneshot::channel();
        p.confirmation = Some(reply);
        FocusRequest::Present {
            timestamp: p.native_time,
            remaining_ms,
            confirmed,
        }
    }
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn blocks_document_key(
    pending: bool,
    leased: bool,
    key: &str,
    meta: bool,
    ctrl: bool,
    alt: bool,
) -> bool {
    (pending || leased)
        && (editing_key(key, meta, ctrl, alt)
            || (!meta
                && !alt
                && matches!(
                    key.strip_prefix("KP_").unwrap_or(key),
                    "Left"
                        | "Right"
                        | "Up"
                        | "Down"
                        | "Home"
                        | "End"
                        | "Page_Up"
                        | "Page_Down"
                        | "Tab"
                        | "ISO_Left_Tab"
                        | "Return"
                        | "Enter"
                        | "Escape"
                )))
}

pub(crate) fn blocks_menu(pending: bool, document_target: bool, command: &str) -> bool {
    pending
        && document_target
        && matches!(
            command,
            "edit.selectAll"
                | "clipboard.cut"
                | "clipboard.paste"
                | "edit.cut"
                | "edit.paste"
                | "edit.delete"
                | "edit.clear"
                | "edit.deleteSelection"
                | "edit.deleteHoveredNativeTarget"
                | "edit.undo"
                | "edit.redo"
        )
}

/// Panel IPC and native document keys use the same pending-click policy.
pub(crate) fn blocks_forwarded_shortcut(
    pending: bool,
    key: &str,
    meta: bool,
    ctrl: bool,
    alt: bool,
) -> bool {
    pending && editing_key(key, meta, ctrl, alt)
}

pub(crate) fn keeps_palette_focus(label: &str, held: bool) -> bool {
    label.starts_with("toolset-") && held
}

/// AppKit supplies charactersIgnoringModifiers, including private-use function keys.
pub(super) fn editing_key(key: &str, command: bool, control: bool, alt: bool) -> bool {
    // Panel IPC uses browser key names; normalize them to AppKit equivalents.
    let key = match key {
        "Backspace" => "\u{8}",
        "Delete" => "\u{f728}",
        _ => key,
    };
    if matches!(key, "\u{8}" | "\u{7f}" | "\u{f728}") {
        return true;
    }
    if command || control {
        return !alt
            && matches!(
                key.to_ascii_lowercase().as_str(),
                "a" | "x" | "v" | "z" | "y"
            );
    }
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|c| !c.is_control() && !(('\u{f700}'..='\u{f8ff}').contains(&c)))
        && chars.next().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presentation_uses_the_native_click_and_waits_for_its_window() {
        use tokio::sync::oneshot::error::TryRecvError;
        for label in ["toolset-structure", "plugin-panel-example"] {
            let mut guard = Guard::new();
            assert!(matches!(
                guard.request_focus(label, None, 0, 10, true),
                FocusRequest::Denied
            ));
            let click = guard.gtk_pointer(label, 10, 100, 42);
            let FocusRequest::Present {
                timestamp,
                remaining_ms,
                mut confirmed,
            } = guard.request_focus(label, Some(click.sequence), 0, 20, false)
            else {
                panic!("expected a pending focus request");
            };
            assert_eq!(timestamp, 42);
            assert_eq!(remaining_ms, TIMEOUT_MS - 10);
            guard.focus_changed("another-window", true, 21);
            assert_eq!(confirmed.try_recv(), Err(TryRecvError::Empty));
            // The frontend shares a single acquisition across a double-click.
            guard.gtk_pointer(label, 22, 112, 54);
            guard.focus_changed(label, true, 23);
            assert_eq!(confirmed.try_recv(), Ok(()));
            guard.end(label, End::Acquired, None, 0);
            assert!(matches!(
                guard.request_focus(label, None, 0, 30, true),
                FocusRequest::Focused
            ));
            guard.end(label, End::Deactivated, None, 0);
            assert!(matches!(
                guard.request_focus(label, None, 0, 31, true),
                FocusRequest::Denied
            ));
        }
    }

    #[test]
    fn timeout_hide_and_other_clicks_deny_unconfirmed_focus() {
        use tokio::sync::oneshot::error::TryRecvError;
        let label = "toolset-inspector";
        for end in [End::Hide, End::Destroy, End::Deactivated, End::Outside] {
            let mut guard = Guard::new();
            guard.gtk_pointer(label, 0, 100, 7);
            let FocusRequest::Present { mut confirmed, .. } =
                guard.request_focus(label, None, 0, 1, false)
            else {
                panic!("expected a pending focus request");
            };
            guard.end(label, end, None, 0);
            guard.focus_changed(label, true, 2);
            assert_eq!(confirmed.try_recv(), Err(TryRecvError::Closed));
        }
        let mut guard = Guard::new();
        let click = guard.gtk_pointer(label, 0, 100, 7);
        assert!(matches!(
            guard.request_focus(label, Some(click.sequence + 1), 0, 1, false),
            FocusRequest::Denied
        ));
        let FocusRequest::Present { mut confirmed, .. } =
            guard.request_focus(label, None, 0, 0, false)
        else {
            panic!("expected a pending focus request");
        };
        guard.focus_changed(label, true, TIMEOUT_MS);
        assert_eq!(confirmed.try_recv(), Err(TryRecvError::Empty));
        guard.timeout(click.sequence, TIMEOUT_MS);
        assert_eq!(confirmed.try_recv(), Err(TryRecvError::Closed));
        assert!(matches!(
            guard.request_focus(label, None, 0, TIMEOUT_MS, false),
            FocusRequest::Denied
        ));
    }

    #[tokio::test]
    async fn missing_focus_event_has_a_bounded_ipc_reply() {
        let mut guard = Guard::new();
        guard.gtk_pointer("palette", 0, 100, 7);
        let request = guard.request_focus("palette", None, 0, TIMEOUT_MS - 1, false);
        assert!(!request.confirmed().await);
        guard.focus_changed("palette", true, TIMEOUT_MS + 1);
        guard.end("palette", End::Hide, None, 0);
        assert!(
            !guard
                .request_focus("palette", None, 0, TIMEOUT_MS + 2, false)
                .confirmed()
                .await
        );
    }

    #[tokio::test]
    async fn a_click_in_another_window_revokes_the_first_presentation() {
        let mut guard = Guard::new();
        let first = guard.gtk_pointer("palette", 0, 100, 7);
        let waiting = guard.request_focus("palette", Some(first.sequence), 101, 1, false);
        guard.gtk_pointer("panel", 2, 102, 9);
        guard.focus_changed("palette", true, 3);
        assert!(!waiting.confirmed().await);
        // A delayed IPC predating this panel click cannot borrow its timestamp.
        assert!(matches!(
            guard.request_focus("panel", None, 101, 4, false),
            FocusRequest::Denied
        ));
        let waiting = guard.request_focus("panel", None, 103, 4, false);
        guard.focus_changed("panel", true, 5);
        assert!(waiting.confirmed().await);
    }

    #[test]
    fn document_key_presses_guard_the_field_before_and_after_confirmation() {
        for (pending, leased) in [(true, false), (false, true)] {
            for key in [
                "3",
                "0",
                "n",
                "Delete",
                "Backspace",
                "Return",
                "Left",
                "KP_Up",
                "ISO_Left_Tab",
            ] {
                assert!(blocks_document_key(
                    pending, leased, key, false, false, false
                ));
                assert!(!blocks_document_key(false, false, key, false, false, false));
            }
            assert!(blocks_document_key(
                pending, leased, "a", false, true, false
            ));
            assert!(!blocks_document_key(
                pending, leased, "s", false, true, false
            ));
        }
    }

    #[test]
    fn every_terminal_path_clears_pending_only() {
        for why in [
            End::Acquired,
            End::Refused,
            End::Released,
            End::Drag,
            End::Hide,
            End::Destroy,
            End::Deactivated,
            End::Outside,
        ] {
            let mut guard = Guard::new();
            let event = guard.pointer("toolset-a", 10, 100);
            assert!(guard.blocks(10));
            assert!(
                !guard
                    .end("toolset-a", why, Some(event.sequence), 100)
                    .unwrap()
                    .1
                    .pending
            );
            assert!(!guard.blocks(11));
        }
    }

    #[test]
    fn delayed_releases_refusals_and_timers_cannot_clear_a_later_click() {
        let mut guard = Guard::new();
        let first = guard.pointer("toolset-a", 0, 100);
        let second = guard.pointer("toolset-a", 10, 110);
        for why in [End::Released, End::Refused] {
            assert!(guard
                .end("toolset-a", why, Some(first.sequence), 200)
                .is_none());
            // Same-millisecond ambiguity fails closed, not by clearing the new click.
            assert!(guard.end("toolset-a", why, None, 110).is_none());
        }
        assert!(guard.timeout(first.sequence, 1_001).is_none());
        assert!(guard.blocks(1_001));
        assert!(guard.end("toolset-b", End::Hide, None, 0).is_none());
        assert!(guard.timeout(second.sequence, 1_009).is_none());
        assert!(!guard.blocks(1_010)); // Native monitor's clock needs no timer delivery.
        assert!(!guard.timeout(second.sequence, 1_010).unwrap().1.pending);
    }

    #[test]
    fn timestamp_fallback_and_acquisition_allow_no_stuck_guard() {
        let mut guard = Guard::new();
        guard.pointer("toolset-a", 0, 100);
        assert!(guard.end("toolset-a", End::Released, None, 101).is_some());
        guard.pointer("toolset-a", 0, 100);
        assert!(guard.end("toolset-a", End::Acquired, None, 0).is_some());
        assert!(!guard.blocks(1));
    }

    #[test]
    fn external_clears_notify_the_palette_that_owned_the_click() {
        for why in [End::Outside, End::Deactivated, End::Released] {
            let mut guard = Guard::new();
            let click = guard.pointer("toolset-a", 0, 100);
            // Document-page and app-wide notifications have no palette label.
            let (label, cleared) = guard.end("", why, None, 101).unwrap();
            assert_eq!(label, "toolset-a");
            assert_eq!(cleared.sequence, click.sequence);
            assert!(!cleared.pending);
            assert!(!guard.blocks(1));
        }
    }

    #[test]
    fn sequence_less_non_pointer_finishes_cannot_clear_a_new_click() {
        for why in [End::Released, End::Refused] {
            let mut guard = Guard::new();
            guard.pointer("toolset-a", 0, 100);
            let newer = guard.pointer("toolset-a", 10, 110);
            // Escape, blur and MutationObserver finishes omit pointerBefore; IPC
            // maps that absence to zero, even if they run after the newer click.
            assert!(guard.end("toolset-a", why, None, 0).is_none());
            assert!(guard.blocks(11));
            // A classification from pointerdown can use the timestamp fallback.
            let (label, cleared) = guard.end("toolset-a", why, None, 111).unwrap();
            assert_eq!(label, "toolset-a");
            assert_eq!(cleared.sequence, newer.sequence);
            assert!(!cleared.pending);
        }
    }

    #[test]
    fn only_editing_menu_commands_are_suppressed_and_only_while_pending() {
        for command in [
            "edit.selectAll",
            "clipboard.cut",
            "clipboard.paste",
            "edit.delete",
            "edit.clear",
            "edit.undo",
            "edit.redo",
        ] {
            assert!(blocks_menu(true, true, command));
            assert!(!blocks_menu(false, true, command));
            assert!(!blocks_menu(true, false, command));
        }
        for command in [
            "document.save",
            "document.saveAs",
            "document.open",
            "document.close",
            "app.quit",
            "app.hide",
            "export.open",
            "view.toggleRulers",
            "clipboard.copy",
            "clipboard.copyAs.smiles",
            "preferences.open",
        ] {
            assert!(!blocks_menu(true, true, command), "{command}");
        }
    }

    #[test]
    fn acquired_and_refused_clicks_restore_document_menus() {
        for why in [End::Acquired, End::Refused] {
            let mut guard = Guard::new();
            let click = guard.pointer("toolset-a", 0, 100);
            assert!(blocks_menu(guard.blocks(1), true, "edit.selectAll"));
            assert!(!blocks_menu(guard.blocks(1), true, "document.save"));
            guard.end("toolset-a", why, Some(click.sequence), 100);
            for command in [
                "edit.selectAll",
                "edit.undo",
                "document.save",
                "export.open",
            ] {
                assert!(!blocks_menu(guard.blocks(2), true, command));
            }
        }
    }

    #[test]
    fn app_loss_clears_any_owner_but_panel_loss_only_clears_that_panel() {
        let mut guard = Guard::new();
        guard.pointer("toolset-b", 0, 100);
        assert!(guard.end("toolset-a", End::Deactivated, None, 0).is_none());
        assert!(guard.blocks(1));
        assert!(guard.end("", End::Deactivated, None, 0).is_some());
        assert!(!guard.blocks(2));
    }

    #[test]
    fn toolset_routes_commands_without_refocusing_a_held_palette() {
        assert!(keeps_palette_focus("toolset-core-main", true));
        assert!(!keeps_palette_focus("toolset-core-main", false));
        assert!(!keeps_palette_focus("main", true));
        assert!(!keeps_palette_focus("plugin-panel-a", true));
    }

    #[test]
    fn mac_key_equivalents_preserve_app_shortcuts() {
        for key in ["a", "A", "x", "v", "z", "Z", "y"] {
            assert!(editing_key(key, true, false, false));
            assert!(editing_key(key, false, true, false));
        }
        for key in ["s", "S", "q", "h", "w", "o", ",", "c", "m"] {
            assert!(!editing_key(key, true, false, false));
        }
        for key in ["k", "K", "3", " ", "\u{8}", "\u{7f}", "\u{f728}"] {
            assert!(editing_key(key, false, false, false));
        }
        for key in ["\u{1b}", "\t", "\r", "\u{f700}"] {
            assert!(!editing_key(key, false, false, false));
        }
    }
}

#[cfg(test)]
mod forwarded_shortcut_tests {
    use super::*;
    #[test]
    fn panel_forwarding_respects_pending_palette_clicks() {
        for (key, meta, ctrl, alt) in [
            ("3", false, false, false),
            ("N", false, false, false),
            ("Delete", false, false, false),
            ("z", true, false, false),
            ("v", false, true, false),
        ] {
            assert!(
                blocks_forwarded_shortcut(true, key, meta, ctrl, alt),
                "{key}"
            );
            assert!(!blocks_forwarded_shortcut(false, key, meta, ctrl, alt));
        }
        for (key, meta, ctrl, alt) in [
            ("s", true, false, false),
            ("r", false, true, false),
            ("c", true, false, false),
            ("ArrowDown", false, false, false),
            ("Escape", false, false, false),
        ] {
            assert!(
                !blocks_forwarded_shortcut(true, key, meta, ctrl, alt),
                "{key}"
            );
        }
    }
}
