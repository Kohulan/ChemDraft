//! Hold a palette where ChemDraft put it while the window manager maps it again.
//!
//! An X11 window manager manages a window afresh every time it is mapped. KWin (KDE Plasma,
//! XWayland included) then keeps the whole frame inside the work area (`keepInArea` in its manage
//! step), even for a window that carries USPosition (utility_window::pin_content_fit_frame). So a
//! palette the user had left overhanging a screen edge jumped fully onto the screen whenever it was
//! shown again: after a Save As or Open dialog had hidden it (utility_suspension), or when it was
//! reopened from View ▸ Toolbars. The Moved event then saved that position as the user's (GitHub
//! #304; Linux VM retest: Main moved from 450,315 to 369,315, 1680 - 1311, on a 1680-px screen).
//! None of ChemDraft's own clamps move a palette whose title strip is reachable.
//!
//! Before such a map ChemDraft pins the palette at the position it must keep. For a short time
//! afterwards a Moved event that lands exactly where that clamp would put the pinned frame (pushed
//! fully into a work area it overlaps, on the axis that overhung, the other axis unchanged) is the
//! window manager's placement: it is not saved, and the palette is moved back with
//! `_NET_MOVERESIZE_WINDOW` (utility_window::move_mapped), which KWin handles as a pager's request
//! and so does not pull back into the work area. A Moved event anywhere else is a real move (a drag,
//! a window manager move the user asked for such as Alt-drag): it ends the pin and is saved as usual.
//! A move ChemDraft makes itself re-targets the pin; the earlier target is then superseded, and a
//! Moved event still on its way to it is ignored. A drag the user starts ends the pin. Only Linux
//! X11/XWayland pins palettes (utility_window::map_replaces_position); elsewhere no pin exists and
//! every Moved event is handled as before.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// How long after a map a move to the window manager's clamp counts as its placement.
const PIN_DURATION: Duration = Duration::from_millis(1500);
/// How many times a pin moves the palette back before it leaves the window manager's position.
const MAX_CORRECTIONS: u8 = 2;
/// Pixels of slack for a window manager rounding a position.
const TOLERANCE: i32 = 2;

/// A monitor's work area, in the same physical pixels as the outer positions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WorkArea {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: i32,
    pub(crate) height: i32,
}

/// What a Moved event is judged against: the palette's outer frame size, the current work areas,
/// and whether the palette's title strip could be grabbed at a given outer position.
pub(crate) struct Layout<'a> {
    pub(crate) size: (i32, i32),
    pub(crate) work_areas: &'a [WorkArea],
    pub(crate) title_reachable: &'a dyn Fn((i32, i32)) -> bool,
}

/// What a Moved event of a palette means for its pin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MovedDecision {
    /// Not pinned (or the pin expired): handle the move as usual.
    Unpinned,
    /// The palette is at its pin: handle the move as usual.
    AtPin,
    /// The window manager clamped it as it mapped it: do not save it, and move it back here.
    Reassert((i32, i32)),
    /// Still clamped after the moves back: do not save it, and leave it to the window manager.
    Hold((i32, i32)),
    /// A move to a target ChemDraft has since replaced (a correction or clamp still on its way):
    /// do not save it and do not move it; ChemDraft's newer move follows.
    Superseded,
    /// Not where the window manager's clamp would put it, so the user moved it: the pin is gone,
    /// handle the move as usual.
    Moved,
    /// The window manager clamped it, but the pinned position's title strip can no longer be
    /// grabbed on the current monitors: the pin is gone, handle the move as usual.
    Unreachable((i32, i32)),
}

#[derive(Debug, Clone)]
struct Pin {
    position: (i32, i32),
    until: Instant,
    corrections: u8,
    /// Earlier targets ChemDraft moved the palette away from while it was pinned.
    superseded: Vec<(i32, i32)>,
}

/// Pinned palettes by window label, with physical outer positions.
#[derive(Default)]
pub(crate) struct MapPins(HashMap<String, Pin>);

fn near(a: (i32, i32), b: (i32, i32)) -> bool {
    (a.0 - b.0).abs() <= TOLERANCE && (a.1 - b.1).abs() <= TOLERANCE
}

/// Where keeping a frame of `length` starting at `start` inside `[area_start, area_start +
/// area_length)` puts it: unchanged when it does not overhang, else pushed in from the far edge and
/// then the near one, as KWin's `keepInArea` does (a frame longer than the area starts at its edge).
fn clamp_axis(start: i32, length: i32, area_start: i32, area_length: i32) -> i32 {
    let area_end = area_start.saturating_add(area_length);
    if start >= area_start && start.saturating_add(length) <= area_end {
        return start;
    }
    start.min(area_end.saturating_sub(length)).max(area_start)
}

fn overlaps(position: (i32, i32), size: (i32, i32), area: &WorkArea) -> bool {
    let overlap = |start: i32, length: i32, area_start: i32, area_length: i32| {
        start
            .saturating_add(length)
            .min(area_start.saturating_add(area_length))
            > start.max(area_start)
    };
    overlap(position.0, size.0, area.x, area.width)
        && overlap(position.1, size.1, area.y, area.height)
}

/// Where a window manager keeping the frame at `target` inside a work area it overlaps puts it.
/// Only work areas the frame overlaps are candidates, so the clamp moves the axis that overhung and
/// leaves the other alone.
fn predicted_clamps(
    target: (i32, i32),
    size: (i32, i32),
    work_areas: &[WorkArea],
) -> impl Iterator<Item = (i32, i32)> + '_ {
    work_areas
        .iter()
        .filter(move |area| overlaps(target, size, area))
        .map(move |area| {
            (
                clamp_axis(target.0, size.0, area.x, area.width),
                clamp_axis(target.1, size.1, area.y, area.height),
            )
        })
}

/// Whether `position` is where a window manager's map clamp puts a frame pinned at `target`.
fn is_clamp_of(target: (i32, i32), position: (i32, i32), layout: &Layout<'_>) -> bool {
    predicted_clamps(target, layout.size, layout.work_areas)
        .any(|clamp| clamp != target && near(position, clamp))
}

impl MapPins {
    fn prune(&mut self, now: Instant) {
        self.0.retain(|_, pin| now < pin.until);
    }

    /// Hold `label` at `position` through the map that is about to happen.
    pub(crate) fn pin(&mut self, label: &str, position: (i32, i32), now: Instant) {
        self.prune(now);
        self.0.insert(
            label.to_string(),
            Pin {
                position,
                until: now + PIN_DURATION,
                corrections: 0,
                superseded: Vec::new(),
            },
        );
    }

    /// ChemDraft moved a pinned palette itself (content fit, off-screen recovery): hold it there.
    /// The old target is superseded: a correction or clamp still on its way to it is ignored, and
    /// the new target gets its own moves back.
    pub(crate) fn moved_by_chemdraft(&mut self, label: &str, position: (i32, i32), now: Instant) {
        self.prune(now);
        if let Some(pin) = self.0.get_mut(label) {
            if pin.position != position {
                let old = std::mem::replace(&mut pin.position, position);
                pin.superseded.push(old);
                pin.corrections = 0;
            }
        }
    }

    /// The user is dragging the palette, or its window is gone: every later move is not a map's.
    pub(crate) fn forget(&mut self, label: &str) {
        self.0.remove(label);
    }

    /// The live pin target of `label`, if it has one.
    pub(crate) fn target(&mut self, label: &str, now: Instant) -> Option<(i32, i32)> {
        self.prune(now);
        self.0.get(label).map(|pin| pin.position)
    }

    /// The position to save or remember for `label` instead of its `live` frame: while a pin is
    /// live, the live frame may be the window manager's clamp, so the pin target is the user's.
    pub(crate) fn position_to_keep(
        &mut self,
        label: &str,
        live: Option<(i32, i32)>,
        now: Instant,
    ) -> Option<(i32, i32)> {
        self.target(label, now).or(live)
    }

    pub(crate) fn moved(
        &mut self,
        label: &str,
        position: (i32, i32),
        layout: &Layout<'_>,
        now: Instant,
    ) -> MovedDecision {
        self.prune(now);
        let Some(pin) = self.0.get(label) else {
            return MovedDecision::Unpinned;
        };
        let target = pin.position;
        let corrections = pin.corrections;
        if near(position, target) {
            // Before any move back, the window manager's placement may still be on its way (GTK
            // reports the requested position first). Once a move back has landed, it is done.
            if corrections > 0 {
                self.0.remove(label);
            }
            return MovedDecision::AtPin;
        }
        if !is_clamp_of(target, position, layout) {
            let superseded = pin
                .superseded
                .iter()
                .any(|&old| near(position, old) || is_clamp_of(old, position, layout));
            if superseded {
                return MovedDecision::Superseded;
            }
            self.0.remove(label);
            return MovedDecision::Moved;
        }
        if !(layout.title_reachable)(target) {
            self.0.remove(label);
            return MovedDecision::Unreachable(target);
        }
        if corrections >= MAX_CORRECTIONS {
            return MovedDecision::Hold(target);
        }
        if let Some(pin) = self.0.get_mut(label) {
            pin.corrections += 1;
        }
        MovedDecision::Reassert(target)
    }
}

static PINS: LazyLock<Mutex<MapPins>> = LazyLock::new(Default::default);

pub(crate) fn with_pins<T>(task: impl FnOnce(&mut MapPins) -> T) -> T {
    task(&mut PINS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: &str = "toolset-core-main";
    /// The Linux VM: one 1680 x 1050 screen with a 44-px panel at the bottom.
    const SCREEN: [WorkArea; 1] = [WorkArea {
        x: 0,
        y: 0,
        width: 1680,
        height: 1006,
    }];
    /// Main's outer frame: 1311 x 80.
    const MAIN_SIZE: (i32, i32) = (1311, 80);

    fn reachable(_: (i32, i32)) -> bool {
        true
    }

    fn unreachable(_: (i32, i32)) -> bool {
        false
    }

    fn vm() -> Layout<'static> {
        Layout {
            size: MAIN_SIZE,
            work_areas: &SCREEN,
            title_reachable: &reachable,
        }
    }

    #[test]
    fn the_predicted_clamp_moves_only_the_axis_that_overhung() {
        // 450 + 1311 overhangs the right edge by 81 px; y stays.
        assert_eq!(
            predicted_clamps((450, 315), MAIN_SIZE, &SCREEN).collect::<Vec<_>>(),
            vec![(369, 315)]
        );
        // Off the left edge, and below the panel.
        assert_eq!(
            predicted_clamps((-40, 990), MAIN_SIZE, &SCREEN).collect::<Vec<_>>(),
            vec![(0, 926)]
        );
        // A frame wider than the work area starts at its left edge.
        assert_eq!(
            predicted_clamps((200, 10), (2000, 80), &SCREEN).collect::<Vec<_>>(),
            vec![(0, 10)]
        );
        // Inside: no clamp moves it. A work area it does not touch is no candidate.
        let two = [
            SCREEN[0],
            WorkArea {
                x: 1680,
                y: 0,
                width: 1920,
                height: 1080,
            },
        ];
        assert_eq!(
            predicted_clamps((100, 100), MAIN_SIZE, &two).collect::<Vec<_>>(),
            vec![(100, 100)]
        );
        // Straddling two monitors: each is a candidate.
        assert_eq!(
            predicted_clamps((1000, 100), MAIN_SIZE, &two).collect::<Vec<_>>(),
            vec![(369, 100), (1680, 100)]
        );
    }

    #[test]
    fn a_window_manager_clamp_after_a_dialog_is_moved_back_and_never_saved() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), now);
        // GTK reports the requested position as it maps the window.
        assert_eq!(
            pins.moved(MAIN, (450, 315), &vm(), now),
            MovedDecision::AtPin
        );
        // KWin keeps the whole 1311-px frame on the 1680-px screen; within 2 px still counts.
        assert_eq!(
            pins.moved(MAIN, (371, 314), &vm(), now + Duration::from_millis(20)),
            MovedDecision::Reassert((450, 315))
        );
        // The move back lands; the pin is done.
        assert_eq!(
            pins.moved(MAIN, (450, 315), &vm(), now + Duration::from_millis(40)),
            MovedDecision::AtPin
        );
        assert_eq!(pins.target(MAIN, now), None);
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now + Duration::from_millis(60)),
            MovedDecision::Unpinned
        );
    }

    #[test]
    fn a_window_manager_move_by_the_user_ends_the_pin_and_is_saved() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), now);
        // Alt-drag right after the dialog: same x as the clamp, another y.
        assert_eq!(
            pins.moved(MAIN, (369, 500), &vm(), now + Duration::from_millis(300)),
            MovedDecision::Moved
        );
        assert_eq!(pins.target(MAIN, now), None);
        // Window Operations ▸ Move a little further than the rounding slack.
        pins.pin(MAIN, (450, 315), now);
        assert_eq!(
            pins.moved(MAIN, (366, 315), &vm(), now),
            MovedDecision::Moved
        );
        // A palette fully inside the work area has no clamp at all: any move is the user's.
        pins.pin(MAIN, (100, 100), now);
        assert_eq!(
            pins.moved(MAIN, (100, 400), &vm(), now),
            MovedDecision::Moved
        );
    }

    #[test]
    fn a_window_manager_that_refuses_the_move_back_keeps_the_saved_position() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), now);
        for _ in 0..MAX_CORRECTIONS {
            assert_eq!(
                pins.moved(MAIN, (369, 315), &vm(), now),
                MovedDecision::Reassert((450, 315))
            );
        }
        // No endless fight: the position is neither saved nor moved again until the pin expires.
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Hold((450, 315))
        );
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now + PIN_DURATION),
            MovedDecision::Unpinned
        );
        assert_eq!(pins.target(MAIN, now), None);
    }

    #[test]
    fn a_pin_whose_title_became_unreachable_is_dropped_instead_of_corrected() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), now);
        let layout = Layout {
            title_reachable: &unreachable,
            ..vm()
        };
        assert_eq!(
            pins.moved(MAIN, (369, 315), &layout, now),
            MovedDecision::Unreachable((450, 315))
        );
        assert_eq!(pins.target(MAIN, now), None);
    }

    #[test]
    fn a_pin_that_no_window_manager_disturbs_expires_by_itself() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), now);
        assert_eq!(
            pins.moved(MAIN, (451, 314), &vm(), now),
            MovedDecision::AtPin
        );
        assert_eq!(pins.target(MAIN, now), Some((450, 315)));
        // A later move is the user's.
        let later = now + PIN_DURATION + Duration::from_millis(1);
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), later),
            MovedDecision::Unpinned
        );
        assert_eq!(pins.target(MAIN, later), None);
    }

    #[test]
    fn expired_pins_are_pruned_on_every_decision() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin("toolset-core-rings", (10, 10), now);
        let later = now + PIN_DURATION;
        // A decision about another palette drops the expired pin too.
        assert_eq!(
            pins.moved(MAIN, (1, 1), &vm(), later),
            MovedDecision::Unpinned
        );
        assert!(pins.0.is_empty());
        pins.pin("toolset-core-rings", (10, 10), now);
        pins.pin(MAIN, (450, 315), later);
        assert_eq!(pins.0.len(), 1);
        pins.pin("toolset-core-rings", (10, 10), now);
        pins.moved_by_chemdraft(MAIN, (0, 315), later);
        assert_eq!(pins.0.len(), 1);
        pins.pin("toolset-core-rings", (10, 10), now);
        assert_eq!(pins.target(MAIN, later), Some((0, 315)));
        assert_eq!(pins.0.len(), 1);
    }

    #[test]
    fn closing_or_hiding_a_pinned_palette_keeps_the_pin_not_the_clamp() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        // Unpinned: the live frame.
        assert_eq!(
            pins.position_to_keep(MAIN, Some((369, 315)), now),
            Some((369, 315))
        );
        assert_eq!(pins.position_to_keep(MAIN, None, now), None);
        // Closed (or hidden by a second dialog) before the move back landed.
        pins.pin(MAIN, (450, 315), now);
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Reassert((450, 315))
        );
        assert_eq!(
            pins.position_to_keep(MAIN, Some((369, 315)), now),
            Some((450, 315))
        );
        assert_eq!(pins.position_to_keep(MAIN, None, now), Some((450, 315)));
        // Once the pin has expired, the live frame again.
        assert_eq!(
            pins.position_to_keep(MAIN, Some((369, 315)), now + PIN_DURATION),
            Some((369, 315))
        );
    }

    #[test]
    fn chemdraft_moves_retarget_the_pin_and_a_drag_ends_it() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        // Unpinned palettes are untouched by ChemDraft's own moves.
        pins.moved_by_chemdraft(MAIN, (0, 315), now);
        assert_eq!(pins.target(MAIN, now), None);
        assert_eq!(
            pins.moved(MAIN, (0, 315), &vm(), now),
            MovedDecision::Unpinned
        );

        pins.pin(MAIN, (450, 315), now);
        pins.moved_by_chemdraft(MAIN, (300, 315), now);
        assert_eq!(
            pins.moved(MAIN, (300, 315), &vm(), now),
            MovedDecision::AtPin
        );
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Superseded
        );
        pins.forget(MAIN);
        assert_eq!(
            pins.moved(MAIN, (700, 20), &vm(), now),
            MovedDecision::Unpinned
        );
        // Other palettes keep their own pins.
        pins.pin("toolset-core-rings", (10, 10), now);
        pins.forget(MAIN);
        assert_eq!(pins.target("toolset-core-rings", now), Some((10, 10)));
    }

    #[test]
    fn a_correction_to_a_superseded_target_is_neither_saved_nor_corrected() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), now);
        // KWin clamps; ChemDraft sends a move back to 450.
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Reassert((450, 315))
        );
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Reassert((450, 315))
        );
        // A content fit then puts the palette at 100 (a narrower frame).
        pins.moved_by_chemdraft(MAIN, (100, 315), now);
        let narrower = Layout {
            size: (900, 80),
            ..vm()
        };
        // The move back to 450 lands late: ignored, and the fit's own move follows.
        assert_eq!(
            pins.moved(MAIN, (450, 315), &narrower, now),
            MovedDecision::Superseded
        );
        assert_eq!(pins.target(MAIN, now), Some((100, 315)));
        assert_eq!(
            pins.moved(MAIN, (100, 315), &narrower, now),
            MovedDecision::AtPin
        );
        // The new target starts with its own moves back: the count was reset.
        pins.moved_by_chemdraft(MAIN, (1000, 315), now);
        for _ in 0..MAX_CORRECTIONS {
            assert_eq!(
                pins.moved(MAIN, (780, 315), &narrower, now),
                MovedDecision::Reassert((1000, 315))
            );
        }
        assert_eq!(
            pins.moved(MAIN, (780, 315), &narrower, now),
            MovedDecision::Hold((1000, 315))
        );
        // A real move elsewhere still ends the pin.
        assert_eq!(
            pins.moved(MAIN, (500, 600), &narrower, now),
            MovedDecision::Moved
        );
    }
}
