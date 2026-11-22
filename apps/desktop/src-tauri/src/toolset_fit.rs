//! Palette frames ChemDraft adjusts to fit a work area, kept apart from frames the user chose.
//!
//! B9 (1.2.2, KDE Plasma VM on XWayland): a live 1680 -> 1024 switch squeezed Drawn Structure
//! Settings onto the smaller work area (moved to 504,202, narrowed 520 -> 498). The Moved and
//! Resized handlers saved that squeezed frame as the user's, so back at 1680 it stayed there, with
//! its title strip under the Main toolbar (which stacks above other palettes) and no way to drag it.
//!
//! Two rules follow:
//! - A fit is ChemDraft's adjustment, not the user's choice. The native events it causes are not
//!   persisted, the saved frame stays the user's, and the palette returns to that frame once the
//!   work area can hold it again ([`ToolsetFitMemory`], [`plan_fit`]).
//! - A palette ChemDraft moves never lands with its title strip under the Main toolbar
//!   ([`frame_clear_of_toolbar`]).
//!
//! Also: on Linux and Windows the document window carries its own menu bar. In the 1.2.2 VM run the
//! unmaximized document's GTK menu bar (y about 199) sat under the Main toolbar (bottom 220), so no
//! menu could be clicked. A palette's first-ever position stays clear of the document's title and
//! menu bars ([`position_clear_of_document_chrome`]).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use super::{ScreenRect, ToolsetWindowPosition};

/// A fit ChemDraft applied, in physical pixels: the live frame it replaced and the one it set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FittedFrame {
    pub from: (i32, i32),
    pub to: (i32, i32),
    pub from_size: (u32, u32),
    pub to_size: (u32, u32),
    /// Native rounding allowance in physical pixels.
    pub tolerance: i32,
}

/// What a native Moved or Resized event on a palette should persist.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FitEventDecision {
    /// The palette is not fitted: persist the event as before.
    Persist,
    /// The fit itself, or a late report of the frame it replaced: keep the user's saved frame.
    Skip,
    /// The user moved or resized a fitted palette: its whole live frame is now the user's.
    PersistFrame,
}

/// Fitted palettes by window label, until the user moves or resizes them or ChemDraft restores
/// their saved frame.
#[derive(Debug, Default)]
pub(crate) struct ToolsetFitMemory {
    frames: HashMap<String, FittedFrame>,
}

impl ToolsetFitMemory {
    /// Record a fit before applying it: native events for it can arrive before the setter returns.
    pub fn record(&mut self, label: &str, frame: FittedFrame) {
        self.frames.insert(label.to_string(), frame);
    }

    pub fn forget(&mut self, label: &str) {
        self.frames.remove(label);
    }

    pub fn is_fitted(&self, label: &str) -> bool {
        self.frames.contains_key(label)
    }

    pub fn moved(&mut self, label: &str, position: (i32, i32)) -> FitEventDecision {
        let Some(frame) = self.frames.get(label) else {
            return FitEventDecision::Persist;
        };
        let near = |other: (i32, i32)| {
            (position.0 - other.0).abs() <= frame.tolerance
                && (position.1 - other.1).abs() <= frame.tolerance
        };
        if near(frame.to) || near(frame.from) {
            return FitEventDecision::Skip;
        }
        self.frames.remove(label);
        FitEventDecision::PersistFrame
    }

    pub fn resized(&mut self, label: &str, size: (u32, u32)) -> FitEventDecision {
        let Some(frame) = self.frames.get(label) else {
            return FitEventDecision::Persist;
        };
        let near = |other: (u32, u32)| {
            (i64::from(size.0) - i64::from(other.0)).abs() <= i64::from(frame.tolerance)
                && (i64::from(size.1) - i64::from(other.1)).abs() <= i64::from(frame.tolerance)
        };
        if near(frame.to_size) || near(frame.from_size) {
            return FitEventDecision::Skip;
        }
        self.frames.remove(label);
        FitEventDecision::PersistFrame
    }
}

static FIT_MEMORY: LazyLock<Mutex<ToolsetFitMemory>> =
    LazyLock::new(|| Mutex::new(ToolsetFitMemory::default()));

pub(crate) fn with_memory<T>(f: impl FnOnce(&mut ToolsetFitMemory) -> T) -> T {
    f(&mut FIT_MEMORY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()))
}

/// Two physical pixels, or one logical pixel rounded up at the window's scale, whichever is larger
/// (the dialog host's placement tolerance).
pub(crate) fn tolerance(scale: f64) -> i32 {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    (scale.ceil() as i32).max(2)
}

/// What the fit memory should do after a clamp pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FitMemoryChange {
    Keep,
    /// The clamp adjusted the frame and it is being applied: remember it as a fit.
    Record,
    /// The saved frame fits unchanged again: the palette is back at the user's frame.
    Forget,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FitPlan {
    /// Move or resize the live window to the clamp's target.
    pub apply: bool,
    pub memory: FitMemoryChange,
}

/// Decide a clamp pass. A fitted palette is clamped from its saved frame (so it grows back when
/// the work area does); any other palette from its live frame.
///
/// - `target_is_live`: the clamp's target equals the live frame.
/// - `adjusted`: the clamp (or the Main-toolbar rule) changed the frame it was given.
pub(crate) fn plan_fit(target_is_live: bool, adjusted: bool, fitted: bool) -> FitPlan {
    let apply = !target_is_live;
    let memory = if !adjusted {
        if fitted {
            FitMemoryChange::Forget
        } else {
            FitMemoryChange::Keep
        }
    } else if apply {
        FitMemoryChange::Record
    } else {
        FitMemoryChange::Keep
    };
    FitPlan { apply, memory }
}

/// Keep a palette ChemDraft places from landing with its title strip under `toolbar` (the Main
/// toolbar, which stacks above the other palettes, so the strip could not be grabbed).
///
/// Tried in order: directly below the toolbar at full size; directly above it at full size; below
/// it with a scrolling inspector shortened to the work area (not under `min_height`); below it
/// with a fixed palette's lower edge past the work area (its title strip, the part that matters,
/// still inside). If the title strip cannot fit below the toolbar at all the frame is unchanged.
/// All rectangles share one coordinate space. Returns the frame and whether it changed.
pub(crate) fn frame_clear_of_toolbar(
    position: ToolsetWindowPosition,
    size: (f64, f64),
    resizable: bool,
    area: ScreenRect,
    toolbar: ScreenRect,
    title_height: f64,
    min_height: f64,
) -> (ToolsetWindowPosition, f64, f64, bool) {
    let (width, height) = size;
    let unchanged = (position, width, height, false);
    let title = ScreenRect::new(position.x, position.y, width, title_height);
    if title.overlap_area(&toolbar) <= 0.0 {
        return unchanged;
    }
    let below = toolbar.y + toolbar.height;
    let bottom = area.y + area.height;
    let at = |y: f64, height: f64| {
        (
            ToolsetWindowPosition { x: position.x, y },
            width,
            height,
            true,
        )
    };
    if below + height <= bottom {
        return at(below, height);
    }
    if toolbar.y - height >= area.y {
        return at(toolbar.y - height, height);
    }
    if below + title_height > bottom {
        return unchanged;
    }
    if resizable {
        let shortened = bottom - below;
        if shortened >= min_height {
            return at(below, shortened);
        }
        return unchanged;
    }
    at(below, height)
}

/// The document window's title bar and in-window menu bar: from the outer top to the client top
/// plus `menu_height` (a menu bar drawn inside the client area, as GTK does on Linux; zero where
/// the menu is non-client, as on Windows). All values in global logical points.
#[cfg(any(not(target_os = "macos"), test))]
pub(crate) fn document_chrome(
    outer: (f64, f64),
    client_top: f64,
    width: f64,
    menu_height: f64,
) -> ScreenRect {
    ScreenRect::new(
        outer.0,
        outer.1,
        width,
        (client_top + menu_height - outer.1).max(0.0),
    )
}

/// A palette's first-ever position, moved straight down below `chrome` (the document window's
/// title and menu bars) plus `gap` when its frame would cover any of it. A position the user saved
/// never comes through here.
pub(crate) fn position_clear_of_document_chrome(
    position: ToolsetWindowPosition,
    size: (f64, f64),
    chrome: Option<ScreenRect>,
    gap: f64,
) -> ToolsetWindowPosition {
    let Some(chrome) = chrome else {
        return position;
    };
    let frame = ScreenRect::new(position.x, position.y, size.0, size.1);
    if frame.overlap_area(&chrome) <= 0.0 {
        return position;
    }
    ToolsetWindowPosition {
        x: position.x,
        y: chrome.y + chrome.height + gap,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_main_toolbar_never_covers_the_document_menu_bar() {
        let main_default = position(88.0, 154.0);
        let main_size = (1311.0, 85.0);

        // Linux, 1680x1050: the unmaximized 1280x820 document at 200,115 with a 30 px title bar
        // and the GTK menu bar inside its client area. Main moves below the menu bar.
        let linux = document_chrome((200.0, 115.0), 145.0, 1280.0, 32.0);
        assert_eq!(linux, ScreenRect::new(200.0, 115.0, 1280.0, 62.0));
        let placed = position_clear_of_document_chrome(main_default, main_size, Some(linux), 8.0);
        assert_eq!((placed.x, placed.y), (88.0, 185.0));

        // Windows, 1920x1200 at 100%: the centred document's non-client menu ends at its client top
        // (192), inside Main's default rows 154..239. The same rule moves Main below it.
        let windows = document_chrome((312.0, 141.0), 192.0, 1296.0, 0.0);
        let placed = position_clear_of_document_chrome(main_default, main_size, Some(windows), 8.0);
        assert_eq!((placed.x, placed.y), (88.0, 200.0));

        // Windows, 1680x1050: the menu ends at 117, above Main. Unchanged.
        let clear = document_chrome((192.0, 66.0), 117.0, 1296.0, 0.0);
        let placed = position_clear_of_document_chrome(main_default, main_size, Some(clear), 8.0);
        assert_eq!((placed.x, placed.y), (88.0, 154.0));

        // macOS (global menu bar) or no visible document window: the default stands.
        let placed = position_clear_of_document_chrome(main_default, main_size, None, 8.0);
        assert_eq!((placed.x, placed.y), (88.0, 154.0));

        // A document beside the palette, not under it, is no reason to move.
        let beside = document_chrome((1500.0, 100.0), 130.0, 1000.0, 32.0);
        let placed = position_clear_of_document_chrome(main_default, main_size, Some(beside), 8.0);
        assert_eq!((placed.x, placed.y), (88.0, 154.0));
    }

    fn frame(
        from: (i32, i32),
        to: (i32, i32),
        from_size: (u32, u32),
        to_size: (u32, u32),
    ) -> FittedFrame {
        FittedFrame {
            from,
            to,
            from_size,
            to_size,
            tolerance: 2,
        }
    }

    #[test]
    fn the_events_a_fit_causes_are_not_persisted_until_the_user_moves_the_palette() {
        let mut memory = ToolsetFitMemory::default();
        assert_eq!(
            memory.moved("toolset-a", (10, 10)),
            FitEventDecision::Persist
        );

        // B9: 1680 -> 1024 squeezed Drawn Structure Settings to 504,202 and 498 wide.
        memory.record(
            "toolset-a",
            frame((900, 160), (504, 202), (520, 600), (498, 566)),
        );
        assert_eq!(
            memory.moved("toolset-a", (504, 202)),
            FitEventDecision::Skip
        );
        assert_eq!(
            memory.moved("toolset-a", (505, 203)),
            FitEventDecision::Skip
        );
        // A queued report of the frame the fit replaced is stale, not a user move.
        assert_eq!(
            memory.moved("toolset-a", (900, 160)),
            FitEventDecision::Skip
        );
        assert_eq!(
            memory.resized("toolset-a", (498, 566)),
            FitEventDecision::Skip
        );
        assert_eq!(
            memory.resized("toolset-a", (520, 600)),
            FitEventDecision::Skip
        );
        assert!(memory.is_fitted("toolset-a"));
        // Other palettes are untouched.
        assert_eq!(
            memory.moved("toolset-b", (504, 202)),
            FitEventDecision::Persist
        );

        // A real drag makes the whole live frame the user's, once.
        assert_eq!(
            memory.moved("toolset-a", (300, 250)),
            FitEventDecision::PersistFrame
        );
        assert!(!memory.is_fitted("toolset-a"));
        assert_eq!(
            memory.moved("toolset-a", (504, 202)),
            FitEventDecision::Persist
        );
    }

    #[test]
    fn a_user_resize_of_a_fitted_inspector_is_persisted_with_its_position() {
        let mut memory = ToolsetFitMemory::default();
        memory.record(
            "toolset-a",
            frame((900, 160), (504, 202), (520, 600), (498, 566)),
        );
        assert_eq!(
            memory.resized("toolset-a", (430, 566)),
            FitEventDecision::PersistFrame
        );
        assert!(!memory.is_fitted("toolset-a"));
        memory.record("toolset-a", frame((1, 1), (2, 2), (3, 3), (4, 4)));
        memory.forget("toolset-a");
        assert!(!memory.is_fitted("toolset-a"));
    }

    #[test]
    fn tolerance_scales_with_the_display() {
        assert_eq!(tolerance(1.0), 2);
        assert_eq!(tolerance(2.0), 2);
        assert_eq!(tolerance(2.5), 3);
        assert_eq!(tolerance(f64::NAN), 2);
    }

    #[test]
    fn a_fit_is_remembered_and_the_saved_frame_comes_back_when_it_fits_again() {
        // A palette that fits where it is: nothing to do.
        assert_eq!(
            plan_fit(true, false, false),
            FitPlan {
                apply: false,
                memory: FitMemoryChange::Keep
            }
        );
        // The work area shrank: apply the clamp and remember it as a fit, not a user frame.
        assert_eq!(
            plan_fit(false, true, false),
            FitPlan {
                apply: true,
                memory: FitMemoryChange::Record
            }
        );
        // Still too small for the saved frame, and already at the fit.
        assert_eq!(
            plan_fit(true, true, true),
            FitPlan {
                apply: false,
                memory: FitMemoryChange::Keep
            }
        );
        // Shrank again while fitted: a new fit.
        assert_eq!(
            plan_fit(false, true, true),
            FitPlan {
                apply: true,
                memory: FitMemoryChange::Record
            }
        );
        // Back at 1680: the saved frame fits unchanged, so return to it and stop tracking.
        assert_eq!(
            plan_fit(false, false, true),
            FitPlan {
                apply: true,
                memory: FitMemoryChange::Forget
            }
        );
    }

    fn position(x: f64, y: f64) -> ToolsetWindowPosition {
        ToolsetWindowPosition { x, y }
    }

    fn unpack(result: (ToolsetWindowPosition, f64, f64, bool)) -> (f64, f64, f64, f64, bool) {
        let (position, width, height, changed) = result;
        (position.x, position.y, width, height, changed)
    }

    #[test]
    fn a_placed_title_never_lands_under_the_main_toolbar() {
        // 1024x768 with a 44 px panel; Main 1024x85 at 0,135.
        let area = ScreenRect::new(0.0, 0.0, 1024.0, 724.0);
        let main = ScreenRect::new(0.0, 135.0, 1024.0, 85.0);

        // B9: an inspector squeezed to 504,202 has its title inside Main (135..220). It moves
        // below Main and gives up height to fit.
        assert_eq!(
            unpack(frame_clear_of_toolbar(
                position(504.0, 202.0),
                (498.0, 566.0),
                true,
                area,
                main,
                22.0,
                56.0
            )),
            (504.0, 220.0, 498.0, 504.0, true)
        );
        // Room below at full size.
        assert_eq!(
            unpack(frame_clear_of_toolbar(
                position(504.0, 202.0),
                (498.0, 300.0),
                true,
                area,
                main,
                22.0,
                56.0
            )),
            (504.0, 220.0, 498.0, 300.0, true)
        );
        // A title clear of Main is left alone, even if the body overlaps it.
        assert_eq!(
            unpack(frame_clear_of_toolbar(
                position(504.0, 100.0),
                (498.0, 300.0),
                true,
                area,
                main,
                22.0,
                56.0
            )),
            (504.0, 100.0, 498.0, 300.0, false)
        );
        assert_eq!(
            unpack(frame_clear_of_toolbar(
                position(504.0, 240.0),
                (498.0, 300.0),
                true,
                area,
                main,
                22.0,
                56.0
            )),
            (504.0, 240.0, 498.0, 300.0, false)
        );
    }

    #[test]
    fn a_toolbar_low_on_the_screen_sends_the_palette_above_it_or_keeps_its_title_reachable() {
        let area = ScreenRect::new(0.0, 0.0, 1024.0, 724.0);
        let low_main = ScreenRect::new(0.0, 600.0, 1024.0, 85.0);
        // No room below at full size, room above.
        assert_eq!(
            unpack(frame_clear_of_toolbar(
                position(200.0, 610.0),
                (300.0, 200.0),
                false,
                area,
                low_main,
                22.0,
                56.0
            )),
            (200.0, 400.0, 300.0, 200.0, true)
        );
        // A fixed palette too tall for either side keeps its size below Main: its title is reachable.
        let main = ScreenRect::new(0.0, 135.0, 1024.0, 85.0);
        assert_eq!(
            unpack(frame_clear_of_toolbar(
                position(200.0, 150.0),
                (300.0, 600.0),
                false,
                area,
                main,
                22.0,
                56.0
            )),
            (200.0, 220.0, 300.0, 600.0, true)
        );
        // Nowhere for the title below Main: unchanged rather than off the work area.
        let bottom_main = ScreenRect::new(0.0, 690.0, 1024.0, 34.0);
        assert_eq!(
            unpack(frame_clear_of_toolbar(
                position(200.0, 700.0),
                (300.0, 800.0),
                true,
                area,
                bottom_main,
                22.0,
                56.0
            )),
            (200.0, 700.0, 300.0, 800.0, false)
        );
    }
}
