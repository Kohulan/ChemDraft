//! First frames of the palette family on Windows: tool palettes, their popovers and the shared
//! palette tooltip.
//!
//! On a cold WebView2 these windows showed one black frame (the native surface before WebView2's
//! first frame) and then blank light frames until the page had painted. On Windows all three are
//! now built through [`crate::first_paint::hidden_until_first_paint`] with the background their
//! page paints, which replaces the black frame. A palette, which used to be shown straight after
//! `build()`, also stays hidden until its page reports its first paint (or the fallback fires).
//! Popovers and the tooltip were already built hidden and shown only by their own reveal commands
//! (`show_toolset_popover_window`, `show_toolset_tooltip_window`) once real content is in place, so
//! they get the background only: arming the fallback on them would show a prewarmed popover, or an
//! empty tooltip, that nobody asked for.
//!
//! macOS and Linux keep their own reveals unchanged (macOS: the non-activating
//! `restore_utility_window` / `configure_toolset_utility_window`, since tao's `show()` is
//! `makeKeyAndOrderFront` there).
//!
//! A palette waiting for its first paint is never shown by the reveal if the user closed it in the
//! meantime. While the document window or the palette is minimized, or the floating windows are
//! suspended (a prompt, a quit), the reveal is held instead, and the held palette is shown when the
//! document window is restored or focused again ([`release_held`]).

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard, PoisonError};
#[cfg(windows)]
use std::time::Duration;

use tauri::window::Color;
use tauri::{Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

/// The windows this module decides for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PaletteWindowKind {
    /// A floating tool palette or inspector (`toolset-core-*`, `toolset-plugin-*`, ...).
    Toolbar,
    /// A palette's popover (`toolset-popover-*`).
    Popover,
    /// The shared palette tooltip (`toolset-tooltip`).
    Tooltip,
}

/// How a window of a [`PaletteWindowKind`] is first shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FirstShow {
    /// The platform's existing reveal, unchanged.
    Platform,
    /// Built hidden with this first frame; shown once its page has painted (or by the fallback).
    AfterFirstPaint(Color),
    /// Built hidden with this first frame; shown only by the window's own reveal command.
    OwnReveal(Color),
}

/// `--cd-bg-panel` in `App.css`, the background of `palette-window-*` and
/// `palette-popover-window-*`. Palettes have no dark theme: only the light palette exists.
pub(crate) const PANEL_BACKGROUND: Color = Color(0xee, 0xf1, 0xef, 0xff);

/// `--cd-bg-control-opaque` in `App.css` (white at 96%) composited over white, the tooltip window's
/// background.
pub(crate) const TOOLTIP_BACKGROUND: Color = Color(0xff, 0xff, 0xff, 0xff);

/// How long a palette waits for its page before the fallback shows it anyway. The same as the
/// helper's other caller; a palette page acknowledges well within it.
#[cfg(windows)]
pub(crate) const TOOLBAR_FIRST_PAINT_FALLBACK: Duration = Duration::from_millis(1500);

/// The decision: which kinds use the first-paint helper, on which platform.
pub(crate) fn first_show(kind: PaletteWindowKind, windows: bool) -> FirstShow {
    if !windows {
        return FirstShow::Platform;
    }
    match kind {
        PaletteWindowKind::Toolbar => FirstShow::AfterFirstPaint(PANEL_BACKGROUND),
        PaletteWindowKind::Popover => FirstShow::OwnReveal(PANEL_BACKGROUND),
        PaletteWindowKind::Tooltip => FirstShow::OwnReveal(TOOLTIP_BACKGROUND),
    }
}

/// The builder step for this platform: hidden with the window's background on Windows, the
/// builder unchanged elsewhere.
pub(crate) fn builder_step<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    kind: PaletteWindowKind,
) -> WebviewWindowBuilder<'a, R, M> {
    match first_show(kind, cfg!(windows)) {
        FirstShow::Platform => builder,
        FirstShow::AfterFirstPaint(background) | FirstShow::OwnReveal(background) => {
            crate::first_paint::hidden_until_first_paint(builder, background)
        }
    }
}

/// What the reveal reads about the palette and its document window when it runs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct RevealConditions {
    /// The floating windows are suspended (a prompt is up, or the app is quitting).
    pub(crate) suspended: bool,
    pub(crate) document_minimized: bool,
    pub(crate) palette_minimized: bool,
}

/// The outcome of a reveal attempt for a palette waiting for its first paint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Reveal {
    /// Show it now.
    Show,
    /// Not now: keep it hidden and show it when the document window comes back.
    Hold,
    /// The user closed it while it waited: never show it.
    Abandon,
    /// Nothing is waiting under this label.
    NotPending,
}

fn decide(wanted: bool, conditions: RevealConditions) -> Reveal {
    if !wanted {
        Reveal::Abandon
    } else if conditions.suspended || conditions.document_minimized || conditions.palette_minimized
    {
        Reveal::Hold
    } else {
        Reveal::Show
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pending {
    /// The palette is still open as far as the user is concerned.
    wanted: bool,
    /// The first-paint reveal ran and was held.
    held: bool,
}

/// Palettes built hidden whose first show has not happened yet, by window label.
#[derive(Debug, Default)]
pub(crate) struct PendingReveals(BTreeMap<String, Pending>);

impl PendingReveals {
    /// A palette was just built hidden and armed.
    #[cfg_attr(not(windows), allow(dead_code))] // only Windows palettes are armed
    pub(crate) fn armed(&mut self, label: &str) {
        self.0.insert(
            label.to_owned(),
            Pending {
                wanted: true,
                held: false,
            },
        );
    }

    /// The user closed the palette.
    pub(crate) fn closed(&mut self, label: &str) {
        if let Some(pending) = self.0.get_mut(label) {
            pending.wanted = false;
        }
    }

    /// The user opened an already-built palette again. Returns whether a pending reveal will show
    /// it, in which case the caller must not show it now (its page may not have painted yet).
    pub(crate) fn reopened(&mut self, label: &str) -> bool {
        match self.0.get_mut(label) {
            Some(pending) => {
                pending.wanted = true;
                true
            }
            None => false,
        }
    }

    /// Whether `label` is a palette the user has open that is still hidden until its first paint
    /// (or held), so it reads as open even though the window is not visible yet.
    pub(crate) fn opening(&self, label: &str) -> bool {
        self.0.get(label).is_some_and(|pending| pending.wanted)
    }

    /// The window is gone.
    pub(crate) fn forget(&mut self, label: &str) {
        self.0.remove(label);
    }

    /// The first-paint reveal (the page's acknowledgement, or the fallback) for `label`.
    pub(crate) fn first_paint(&mut self, label: &str, conditions: RevealConditions) -> Reveal {
        let Some(pending) = self.0.get_mut(label) else {
            return Reveal::NotPending;
        };
        let reveal = decide(pending.wanted, conditions);
        match reveal {
            Reveal::Hold => pending.held = true,
            Reveal::Show | Reveal::Abandon => {
                self.0.remove(label);
            }
            Reveal::NotPending => {}
        }
        reveal
    }

    /// Labels whose reveal is held.
    pub(crate) fn held(&self) -> Vec<String> {
        self.0
            .iter()
            .filter(|(_, pending)| pending.held)
            .map(|(label, _)| label.clone())
            .collect()
    }

    /// Retry a held reveal. A palette whose first-paint reveal has not run yet is left to it.
    pub(crate) fn release(&mut self, label: &str, conditions: RevealConditions) -> Reveal {
        match self.0.get(label) {
            Some(pending) if pending.held => self.first_paint(label, conditions),
            _ => Reveal::NotPending,
        }
    }
}

static PENDING: Mutex<PendingReveals> = Mutex::new(PendingReveals(BTreeMap::new()));

fn pending() -> MutexGuard<'static, PendingReveals> {
    PENDING.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Read on the main thread. A query that fails reads as "not minimized", so a failed query can
/// only show a palette, never strand it hidden.
fn conditions<R: Runtime>(window: &WebviewWindow<R>) -> RevealConditions {
    RevealConditions {
        suspended: crate::utility_windows_suspended(),
        document_minimized: window
            .app_handle()
            .get_webview_window(crate::MAIN_WINDOW_LABEL)
            .is_some_and(|main| main.is_minimized().unwrap_or(false)),
        palette_minimized: window.is_minimized().unwrap_or(false),
    }
}

/// Windows: registers a palette built with [`builder_step`] for its first-paint reveal. Main
/// thread, in the same turn the build finished setting up (the old immediate `show()`).
#[cfg(windows)]
pub(crate) fn arm_toolbar<R: Runtime>(window: &WebviewWindow<R>) {
    let label = window.label().to_owned();
    pending().armed(&label);
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            pending().forget(&label);
        }
    });
    crate::first_paint::arm_first_paint_fallback_with(
        window,
        TOOLBAR_FIRST_PAINT_FALLBACK,
        |window| {
            let conditions = conditions(window);
            match pending().first_paint(window.label(), conditions) {
                Reveal::Show => Ok(()),
                reveal => Err(format!("palette first show declined: {reveal:?}")),
            }
        },
        |window, shown| {
            if let Err(error) = shown {
                log::debug!(target: "chemdraft::windows_activation",
                    "palette first paint label={} result={error}", window.label());
            }
        },
    );
}

/// The user closed a palette: a reveal still waiting for its first paint must not show it.
pub(crate) fn closed(label: &str) {
    pending().closed(label);
}

/// See [`PendingReveals::opening`].
pub(crate) fn opening(label: &str) -> bool {
    pending().opening(label)
}

/// See [`PendingReveals::reopened`].
pub(crate) fn reopened(label: &str) -> bool {
    pending().reopened(label)
}

/// Shows palettes whose first-paint reveal was held, now that nothing holds them any more. Main
/// thread; called when the document window is restored, moved, resized or focused. `show()` only:
/// a palette is built unfocused, so this never activates it.
pub(crate) fn release_held<R: Runtime>(app: &tauri::AppHandle<R>) {
    let labels = pending().held();
    for label in labels {
        let Some(window) = app.get_webview_window(&label) else {
            pending().forget(&label);
            continue;
        };
        let conditions = conditions(&window);
        if pending().release(&label, conditions) == Reveal::Show {
            if let Err(error) = window.show() {
                eprintln!("Could not show ChemDraft palette {label}: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KINDS: [PaletteWindowKind; 3] = [
        PaletteWindowKind::Toolbar,
        PaletteWindowKind::Popover,
        PaletteWindowKind::Tooltip,
    ];

    fn shown() -> RevealConditions {
        RevealConditions::default()
    }

    #[test]
    fn only_windows_palettes_wait_for_first_paint_and_popovers_keep_their_own_reveal() {
        for kind in KINDS {
            // macOS and Linux: unchanged.
            assert_eq!(first_show(kind, false), FirstShow::Platform, "{kind:?}");
        }
        assert_eq!(
            first_show(PaletteWindowKind::Toolbar, true),
            FirstShow::AfterFirstPaint(PANEL_BACKGROUND)
        );
        assert_eq!(
            first_show(PaletteWindowKind::Popover, true),
            FirstShow::OwnReveal(PANEL_BACKGROUND)
        );
        assert_eq!(
            first_show(PaletteWindowKind::Tooltip, true),
            FirstShow::OwnReveal(TOOLTIP_BACKGROUND)
        );
    }

    #[test]
    fn first_frame_backgrounds_match_the_palette_css() {
        let css = include_str!("../../src/App.css");
        let hex = |Color(r, g, b, _): Color| format!("#{r:02x}{g:02x}{b:02x}");
        assert!(css.contains(&format!("--cd-bg-panel: {};", hex(PANEL_BACKGROUND))));
        assert!(css.contains("--cd-bg-control-opaque: rgb(255 255 255 / 96%);"));
        assert_eq!(hex(TOOLTIP_BACKGROUND), "#ffffff");
        let rule = |selector: &str| {
            let start = css.find(selector).unwrap_or_else(|| panic!("{selector}"));
            let rest = &css[start..];
            &rest[..rest.find('}').unwrap()]
        };
        assert!(rule("html.palette-window-html {").contains("background: var(--cd-bg-panel);"));
        assert!(rule("body.palette-window-body {").contains("background: var(--cd-bg-panel);"));
        assert!(
            rule("html.palette-popover-window-html,").contains("background: var(--cd-bg-panel);")
        );
        assert!(rule("html.palette-tooltip-window-html,")
            .contains("background: var(--cd-bg-control-opaque);"));
        // No dark palette theme exists for the first frame to follow.
        assert!(!css.contains("prefers-color-scheme"));
        for color in [PANEL_BACKGROUND, TOOLTIP_BACKGROUND] {
            assert_eq!(color.3, 0xff, "opaque, like the palette windows");
        }
    }

    #[test]
    fn a_palette_shows_once_when_its_first_paint_arrives() {
        let mut reveals = PendingReveals::default();
        assert!(!reveals.opening("toolset-core-main"));
        reveals.armed("toolset-core-main");
        // Hidden but open: the toolbar state reports it open while it waits.
        assert!(reveals.opening("toolset-core-main"));
        assert_eq!(
            reveals.first_paint("toolset-core-main", shown()),
            Reveal::Show
        );
        assert_eq!(
            reveals.first_paint("toolset-core-main", shown()),
            Reveal::NotPending
        );
        assert_eq!(
            reveals.first_paint("toolset-core-never-armed", shown()),
            Reveal::NotPending
        );
    }

    #[test]
    fn a_palette_closed_while_it_waited_is_never_shown() {
        let mut reveals = PendingReveals::default();
        reveals.armed("toolset-core-main");
        reveals.closed("toolset-core-main");
        assert!(!reveals.opening("toolset-core-main"));
        assert_eq!(
            reveals.first_paint("toolset-core-main", shown()),
            Reveal::Abandon
        );
        assert!(reveals.held().is_empty());
        // Closed while held: the document's return does not bring it back either.
        reveals.armed("toolset-core-arrows");
        let minimized = RevealConditions {
            document_minimized: true,
            ..shown()
        };
        assert_eq!(
            reveals.first_paint("toolset-core-arrows", minimized),
            Reveal::Hold
        );
        reveals.closed("toolset-core-arrows");
        assert_eq!(
            reveals.release("toolset-core-arrows", shown()),
            Reveal::Abandon
        );
        assert!(reveals.held().is_empty());
    }

    #[test]
    fn a_minimized_or_suspended_palette_is_held_until_the_document_returns() {
        for conditions in [
            RevealConditions {
                document_minimized: true,
                ..shown()
            },
            RevealConditions {
                palette_minimized: true,
                ..shown()
            },
            RevealConditions {
                suspended: true,
                ..shown()
            },
        ] {
            let mut reveals = PendingReveals::default();
            reveals.armed("toolset-core-main");
            assert_eq!(
                reveals.first_paint("toolset-core-main", conditions),
                Reveal::Hold,
                "{conditions:?}"
            );
            assert_eq!(reveals.held(), ["toolset-core-main"]);
            assert!(reveals.opening("toolset-core-main"), "held, still open");
            // Still minimized: stays held.
            assert_eq!(
                reveals.release("toolset-core-main", conditions),
                Reveal::Hold
            );
            assert_eq!(reveals.release("toolset-core-main", shown()), Reveal::Show);
            assert!(reveals.held().is_empty());
            assert_eq!(
                reveals.release("toolset-core-main", shown()),
                Reveal::NotPending
            );
        }
    }

    #[test]
    fn release_leaves_a_palette_still_waiting_for_its_page_alone() {
        let mut reveals = PendingReveals::default();
        reveals.armed("toolset-core-main");
        assert_eq!(
            reveals.release("toolset-core-main", shown()),
            Reveal::NotPending
        );
        assert_eq!(
            reveals.first_paint("toolset-core-main", shown()),
            Reveal::Show
        );
    }

    #[test]
    fn reopening_a_waiting_palette_lets_its_reveal_show_it() {
        let mut reveals = PendingReveals::default();
        assert!(!reveals.reopened("toolset-core-main"), "nothing pending");
        reveals.armed("toolset-core-main");
        reveals.closed("toolset-core-main");
        assert!(reveals.reopened("toolset-core-main"));
        assert_eq!(
            reveals.first_paint("toolset-core-main", shown()),
            Reveal::Show
        );
        assert!(!reveals.reopened("toolset-core-main"), "already shown");
        reveals.armed("toolset-core-text");
        reveals.forget("toolset-core-text");
        assert_eq!(
            reveals.first_paint("toolset-core-text", shown()),
            Reveal::NotPending
        );
    }

    #[test]
    fn windows_builders_use_the_helper_and_show_palettes_only_after_first_paint() {
        let lib = include_str!("lib.rs");
        let body = |signature: &str| {
            let start = lib.find(signature).unwrap_or_else(|| panic!("{signature}"));
            let rest = &lib[start..];
            &rest[..rest.find("\n}\n").unwrap()]
        };
        let toolbar = body("fn ensure_toolset_window<");
        assert!(toolbar.contains(
            "palette_first_paint::builder_step(builder, palette_first_paint::PaletteWindowKind::Toolbar)"
        ));
        let built = &toolbar[toolbar.find("builder.build()").unwrap()..];
        let windows = &built[built.find("#[cfg(windows)]\n    {").unwrap()..];
        assert!(windows.contains("palette_first_paint::arm_toolbar(&target);"));
        assert!(
            !windows.contains(".show()"),
            "a new Windows palette is shown before its page paints"
        );
        // The reopen path keeps its immediate show unless a first-paint reveal is still pending.
        let reopen = &toolbar[..toolbar.find("builder.build()").unwrap()];
        assert!(reopen.contains("if !palette_first_paint::reopened(&label) {"));
        assert!(body("fn close_toolset_window(").contains("palette_first_paint::closed("));
        assert!(body("fn toolset_state<").contains("palette_first_paint::opening(window.label())"));
        // Held reveals are retried when the document returns and when a suspension ends.
        assert_eq!(
            lib.matches("palette_first_paint::release_held(").count(),
            3,
            "main window geometry, main window focus, suspension release"
        );

        let popover = body("fn build_toolset_popover_window(");
        assert!(popover.contains("palette_first_paint::PaletteWindowKind::Popover"));
        assert!(!popover.contains("arm_"));
        let tooltip = body("fn build_toolset_tooltip_window(");
        assert!(tooltip.contains("palette_first_paint::PaletteWindowKind::Tooltip"));
        assert!(!tooltip.contains("arm_"));

        // Never focuses: the palette is built unfocused and revealed with show() only.
        let source = include_str!("palette_first_paint.rs");
        let code = &source[..source.find("#[cfg(test)]\nmod tests").unwrap()];
        assert!(!code.contains("set_focus("));
        assert!(!code.contains("unminimize("));
    }
}
