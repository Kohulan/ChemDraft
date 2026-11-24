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
//! fully into the one work area it overlaps most, on the axis that overhung, the other axis
//! unchanged) is the window manager's placement: it is not saved, and the palette is moved back with
//! `_NET_MOVERESIZE_WINDOW` (utility_window::move_mapped), which KWin handles as a pager's request
//! and so does not pull back into the work area. A Moved event anywhere else is a real move (a drag,
//! a window manager move the user asked for such as Alt-drag): it ends the pin and is saved as usual.
//! A move ChemDraft makes itself re-targets the pin; the earlier target is then superseded, and a
//! Moved event still on its way to it is ignored. A drag the user starts ends the pin. A palette
//! shown again while already at its pin's clamp (a move back lost when it was hidden) is moved back
//! at once, since the map may report no move. A palette closed while pinned saves its pin, and a
//! reopen of the same hidden window pins that position rather than the clamp it may still sit at.
//! Only Linux X11/XWayland pins palettes (utility_window::map_replaces_position); elsewhere no pin
//! exists and every Moved event is handled as before.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// How long after a map a move to the window manager's clamp counts as its placement.
const PIN_DURATION: Duration = Duration::from_millis(1500);
/// How many times a pin moves the palette back before it leaves the window manager's position.
const MAX_CORRECTIONS: u8 = 2;
/// Pixels of slack for a window manager rounding a position.
const TOLERANCE: i32 = 2;
/// How often a palette just shown again is looked at for a frame already at its pin's clamp.
/// Only Linux waits for the map on the GTK main loop.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) const AFTER_MAP_INTERVAL: Duration = Duration::from_millis(50);
/// How long to wait for that palette to be mapped before giving up on the look.
pub(crate) const AFTER_MAP_WAIT: Duration = Duration::from_millis(500);

/// A physical position or frame size, in pixels.
type Pixels = (i32, i32);

/// A target ChemDraft moved a pinned palette away from, with the outer frame size it had there.
#[derive(Debug, Clone, Copy)]
struct SupersededTarget {
    position: Pixels,
    size: Option<Pixels>,
}

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
    /// The outer frame size last seen while `position` was the target, if any was.
    size: Option<(i32, i32)>,
    until: Instant,
    corrections: u8,
    /// Earlier targets ChemDraft moved the palette away from while it was pinned, each with the
    /// frame size it had then: a late clamp of an old target is predicted with the old frame, not
    /// with the size a content fit has given it since.
    superseded: Vec<SupersededTarget>,
}

/// Where a reported position lies relative to a pin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Spot {
    /// At the pin target, within the rounding slack.
    Target,
    /// Where the window manager's map clamp puts the pinned frame.
    Clamp,
    /// At a target ChemDraft has since replaced, or at that target's clamp.
    Superseded,
    /// Anywhere else: a real move.
    Elsewhere,
}

/// Pinned palettes by window label, with physical outer positions.
#[derive(Default)]
pub(crate) struct MapPins {
    pins: HashMap<String, Pin>,
    /// Palettes closed while pinned, with the position saved for them: a reopen of the same hidden
    /// window pins that position, not the clamp the hidden window may still sit at.
    closed: HashMap<String, (i32, i32)>,
}

fn near(a: (i32, i32), b: (i32, i32)) -> bool {
    (a.0 - b.0).abs() <= TOLERANCE && (a.1 - b.1).abs() <= TOLERANCE
}

fn distance(a: (i32, i32), b: (i32, i32)) -> i64 {
    (i64::from(a.0) - i64::from(b.0)).abs() + (i64::from(a.1) - i64::from(b.1)).abs()
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

/// How many pixels of `[start, start + length)` lie in `[area_start, area_start + area_length)`.
fn overlap_length(start: i32, length: i32, area_start: i32, area_length: i32) -> i64 {
    let end = i64::from(start) + i64::from(length);
    let area_end = i64::from(area_start) + i64::from(area_length);
    (end.min(area_end) - i64::from(start).max(i64::from(area_start))).max(0)
}

/// The work area a window manager keeps a frame at `position` inside as it maps it: the one the
/// frame overlaps most (the first of equal ones). KWin clamps into the area of the one output the
/// window is placed on, not into every area the frame touches.
fn placement_area(
    position: (i32, i32),
    size: (i32, i32),
    work_areas: &[WorkArea],
) -> Option<&WorkArea> {
    let mut best: Option<(&WorkArea, i64)> = None;
    for area in work_areas {
        let overlap = overlap_length(position.0, size.0, area.x, area.width)
            * overlap_length(position.1, size.1, area.y, area.height);
        let better = match best {
            Some((_, most)) => overlap > most,
            None => true,
        };
        if overlap > 0 && better {
            best = Some((area, overlap));
        }
    }
    best.map(|(area, _)| area)
}

/// Where a window manager keeping a frame of `size` at `target` inside its placement work area
/// puts it, when that moves it at all. The clamp moves only the axis that overhung that area.
fn predicted_clamp(
    target: (i32, i32),
    size: (i32, i32),
    work_areas: &[WorkArea],
) -> Option<(i32, i32)> {
    let area = placement_area(target, size, work_areas)?;
    let clamp = (
        clamp_axis(target.0, size.0, area.x, area.width),
        clamp_axis(target.1, size.1, area.y, area.height),
    );
    (clamp != target).then_some(clamp)
}

/// Whether `position` is where a window manager's map clamp puts a frame of `size` pinned at
/// `target`. A 1-2 px overhang puts the clamp within the target's rounding slack, so a position
/// near both counts as the clamp when it is nearer the clamp: an exact clamp is not the target.
fn is_clamp_of(
    target: (i32, i32),
    size: (i32, i32),
    position: (i32, i32),
    work_areas: &[WorkArea],
) -> bool {
    predicted_clamp(target, size, work_areas).is_some_and(|clamp| {
        near(position, clamp)
            && (!near(position, target) || distance(position, clamp) < distance(position, target))
    })
}

impl Pin {
    fn spot(&self, position: (i32, i32), layout: &Layout<'_>) -> Spot {
        if is_clamp_of(self.position, layout.size, position, layout.work_areas) {
            return Spot::Clamp;
        }
        if near(position, self.position) {
            return Spot::Target;
        }
        let superseded = self.superseded.iter().any(|old| {
            near(position, old.position)
                || is_clamp_of(
                    old.position,
                    old.size.unwrap_or(layout.size),
                    position,
                    layout.work_areas,
                )
        });
        if superseded {
            Spot::Superseded
        } else {
            Spot::Elsewhere
        }
    }
}

impl MapPins {
    fn prune(&mut self, now: Instant) {
        self.pins.retain(|_, pin| now < pin.until);
    }

    /// Hold `label` at `position` through the map that is about to happen. `size` is its outer
    /// frame, when known.
    pub(crate) fn pin(
        &mut self,
        label: &str,
        position: (i32, i32),
        size: Option<(i32, i32)>,
        now: Instant,
    ) {
        self.prune(now);
        self.closed.remove(label);
        self.pins.insert(
            label.to_string(),
            Pin {
                position,
                size,
                until: now + PIN_DURATION,
                corrections: 0,
                superseded: Vec::new(),
            },
        );
    }

    /// ChemDraft moved a pinned palette itself (content fit, off-screen recovery): hold it there.
    /// `size` is the outer frame it moved the palette with, when known. The old target is
    /// superseded, with the frame size it had: a correction or clamp still on its way to it is
    /// ignored, and the new target gets its own moves back. Every target keeps its own size, so a
    /// target replaced before any Moved event reached it is still judged with its own frame.
    pub(crate) fn moved_by_chemdraft(
        &mut self,
        label: &str,
        position: (i32, i32),
        size: Option<(i32, i32)>,
        now: Instant,
    ) {
        self.prune(now);
        if let Some(pin) = self.pins.get_mut(label) {
            if pin.position != position {
                let old = std::mem::replace(&mut pin.position, position);
                let old_size = pin.size;
                pin.size = size.or(old_size);
                pin.superseded.push(SupersededTarget {
                    position: old,
                    size: old_size,
                });
                pin.corrections = 0;
            } else if size.is_some() {
                pin.size = size;
            }
        }
    }

    /// ChemDraft resized a pinned palette without moving it (a content fit in place): the target
    /// stays, but it now has this outer frame, so a later retarget archives it with the frame it
    /// really had. The target is left alone even when the palette sits at its clamp: only the size
    /// changed.
    pub(crate) fn resized_by_chemdraft(&mut self, label: &str, size: (i32, i32), now: Instant) {
        self.prune(now);
        if let Some(pin) = self.pins.get_mut(label) {
            pin.size = Some(size);
        }
    }

    /// The user is dragging the palette, or its window is gone: every later move is not a map's.
    pub(crate) fn forget(&mut self, label: &str) {
        self.pins.remove(label);
        self.closed.remove(label);
    }

    /// The palette is being closed: its pin ends. `kept` is the position saved for it when it was
    /// pinned as the close began (the caller's one look at the pin, so an expiry during the close
    /// changes nothing); a reopen of the same hidden window then starts from `kept`
    /// ([`Self::reopen_position`]). `None` leaves no record.
    pub(crate) fn close(&mut self, label: &str, kept: Option<(i32, i32)>) {
        self.pins.remove(label);
        match kept {
            Some(kept) => {
                self.closed.insert(label.to_string(), kept);
            }
            None => {
                self.closed.remove(label);
            }
        }
    }

    /// Where to pin a palette closed while pinned as it is shown again: the position saved at the
    /// close, as long as its hidden window (`live`) is still there or at that position's clamp,
    /// where a close before the move back landed left it. Anything else moved it since, and `None`
    /// leaves the caller to its live frame. Consumes the record.
    pub(crate) fn reopen_position(
        &mut self,
        label: &str,
        live: Option<(i32, i32)>,
        layout: &Layout<'_>,
    ) -> Option<(i32, i32)> {
        let kept = self.closed.remove(label)?;
        match live {
            None => Some(kept),
            Some(live) => (near(live, kept)
                || is_clamp_of(kept, layout.size, live, layout.work_areas))
            .then_some(kept),
        }
    }

    /// Whether `label` was closed while pinned and has not been shown again since.
    pub(crate) fn was_closed_while_pinned(&self, label: &str) -> bool {
        self.closed.contains_key(label)
    }

    /// The live pin target of `label`, if it has one.
    pub(crate) fn target(&mut self, label: &str, now: Instant) -> Option<(i32, i32)> {
        self.prune(now);
        self.pins.get(label).map(|pin| pin.position)
    }

    /// The position to save or remember for `label` instead of its `live` frame: while a pin is
    /// live, the live frame may be the window manager's clamp, so the pin target is the user's.
    /// A live frame that is neither the target, its clamp nor a superseded target is a real move
    /// whose Moved event has yet to run (judged against `layout` when the caller has one): it wins.
    pub(crate) fn position_to_keep(
        &mut self,
        label: &str,
        live: Option<(i32, i32)>,
        layout: Option<&Layout<'_>>,
        now: Instant,
    ) -> Option<(i32, i32)> {
        self.prune(now);
        let Some(pin) = self.pins.get(label) else {
            return live;
        };
        match (live, layout) {
            (Some(live), Some(layout)) if pin.spot(live, layout) == Spot::Elsewhere => Some(live),
            _ => Some(pin.position),
        }
    }

    /// A pinned palette was just shown again and its `live` frame already sits at the pin's clamp.
    /// The window manager may report no move for it (the frame was clamped before and the move back
    /// was lost when it was hidden), so the move back is due now: returns the target to move it to,
    /// and counts it as one of the pin's moves back. `None` when no move back is due.
    pub(crate) fn correction_due(
        &mut self,
        label: &str,
        live: (i32, i32),
        layout: &Layout<'_>,
        now: Instant,
    ) -> Option<(i32, i32)> {
        self.prune(now);
        let pin = self.pins.get_mut(label)?;
        if pin.spot(live, layout) != Spot::Clamp
            || pin.corrections >= MAX_CORRECTIONS
            || !(layout.title_reachable)(pin.position)
        {
            return None;
        }
        pin.corrections += 1;
        Some(pin.position)
    }

    pub(crate) fn moved(
        &mut self,
        label: &str,
        position: (i32, i32),
        layout: &Layout<'_>,
        now: Instant,
    ) -> MovedDecision {
        self.prune(now);
        let Some(pin) = self.pins.get_mut(label) else {
            return MovedDecision::Unpinned;
        };
        let target = pin.position;
        match pin.spot(position, layout) {
            Spot::Target => {
                pin.size = Some(layout.size);
                // Before any move back, the window manager's placement may still be on its way
                // (GTK reports the requested position first). Once a move back has landed, it is
                // done.
                if pin.corrections > 0 {
                    self.pins.remove(label);
                }
                MovedDecision::AtPin
            }
            Spot::Superseded => MovedDecision::Superseded,
            Spot::Elsewhere => {
                self.pins.remove(label);
                MovedDecision::Moved
            }
            Spot::Clamp => {
                pin.size = Some(layout.size);
                if !(layout.title_reachable)(target) {
                    self.pins.remove(label);
                    return MovedDecision::Unreachable(target);
                }
                if pin.corrections >= MAX_CORRECTIONS {
                    return MovedDecision::Hold(target);
                }
                pin.corrections += 1;
                MovedDecision::Reassert(target)
            }
        }
    }
}

/// What one look at a palette just shown again does (see [`AFTER_MAP_INTERVAL`]). The show is
/// queued on the GTK main loop, so the frame is judged once the palette is mapped, not as the show
/// is requested: judged before the map, a palette that then maps at its pin's clamp with no Moved
/// event would stay there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AfterMapStep {
    /// Mapped: judge the frame now, then stop looking.
    Check,
    /// Not mapped yet: look again after [`AFTER_MAP_INTERVAL`].
    Wait,
    /// No pin left to hold, or the map did not come within [`AFTER_MAP_WAIT`]: stop looking.
    Stop,
}

/// The decision behind each look: `pinned` is whether the palette still has a live pin, `mapped`
/// whether it is mapped (and visible), and `elapsed` the time since the show.
pub(crate) fn after_map_step(pinned: bool, mapped: bool, elapsed: Duration) -> AfterMapStep {
    if !pinned {
        AfterMapStep::Stop
    } else if mapped {
        AfterMapStep::Check
    } else if elapsed >= AFTER_MAP_WAIT {
        AfterMapStep::Stop
    } else {
        AfterMapStep::Wait
    }
}

/// The outer frame a window will have once its inner size is `inner`: its decorations (the
/// difference between `outer` and `current_inner`, the frame it has now) stay as they are.
pub(crate) fn outer_size_for_inner(
    outer: (u32, u32),
    current_inner: (u32, u32),
    inner: (u32, u32),
) -> (i32, i32) {
    let axis = |outer: u32, current: u32, inner: u32| {
        let value = i64::from(inner) + i64::from(outer) - i64::from(current);
        i32::try_from(value.max(0)).unwrap_or(i32::MAX)
    };
    (
        axis(outer.0, current_inner.0, inner.0),
        axis(outer.1, current_inner.1, inner.1),
    )
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

    /// Two monitors side by side: the VM's screen, and a 1920 x 1080 one to its right.
    const TWO: [WorkArea; 2] = [
        SCREEN[0],
        WorkArea {
            x: 1680,
            y: 0,
            width: 1920,
            height: 1080,
        },
    ];

    #[test]
    fn the_predicted_clamp_moves_only_the_axis_that_overhung() {
        // 450 + 1311 overhangs the right edge by 81 px; y stays.
        assert_eq!(
            predicted_clamp((450, 315), MAIN_SIZE, &SCREEN),
            Some((369, 315))
        );
        // Off the left edge, and below the panel.
        assert_eq!(
            predicted_clamp((-40, 990), MAIN_SIZE, &SCREEN),
            Some((0, 926))
        );
        // A frame wider than the work area starts at its left edge.
        assert_eq!(
            predicted_clamp((200, 10), (2000, 80), &SCREEN),
            Some((0, 10))
        );
        // Inside: no clamp moves it.
        assert_eq!(predicted_clamp((100, 100), MAIN_SIZE, &TWO), None);
        // Touching no work area at all: nothing to clamp into.
        assert_eq!(predicted_clamp((5000, 100), MAIN_SIZE, &TWO), None);
        // Straddling two monitors: only the one it overlaps most (680 px of the left one against
        // 631 of the right) is where the window manager keeps it.
        assert_eq!(
            predicted_clamp((1000, 100), MAIN_SIZE, &TWO),
            Some((369, 100))
        );
        assert_eq!(
            predicted_clamp((1400, 100), MAIN_SIZE, &TWO),
            Some((1680, 100))
        );
    }

    #[test]
    fn a_window_manager_clamp_after_a_dialog_is_moved_back_and_never_saved() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), None, now);
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
        pins.pin(MAIN, (450, 315), None, now);
        // Alt-drag right after the dialog: same x as the clamp, another y.
        assert_eq!(
            pins.moved(MAIN, (369, 500), &vm(), now + Duration::from_millis(300)),
            MovedDecision::Moved
        );
        assert_eq!(pins.target(MAIN, now), None);
        // Window Operations ▸ Move a little further than the rounding slack.
        pins.pin(MAIN, (450, 315), None, now);
        assert_eq!(
            pins.moved(MAIN, (366, 315), &vm(), now),
            MovedDecision::Moved
        );
        // A palette fully inside the work area has no clamp at all: any move is the user's.
        pins.pin(MAIN, (100, 100), None, now);
        assert_eq!(
            pins.moved(MAIN, (100, 400), &vm(), now),
            MovedDecision::Moved
        );
    }

    #[test]
    fn a_window_manager_that_refuses_the_move_back_keeps_the_saved_position() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), None, now);
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
        pins.pin(MAIN, (450, 315), None, now);
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
        pins.pin(MAIN, (450, 315), None, now);
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
        pins.pin("toolset-core-rings", (10, 10), None, now);
        let later = now + PIN_DURATION;
        // A decision about another palette drops the expired pin too.
        assert_eq!(
            pins.moved(MAIN, (1, 1), &vm(), later),
            MovedDecision::Unpinned
        );
        assert!(pins.pins.is_empty());
        pins.pin("toolset-core-rings", (10, 10), None, now);
        pins.pin(MAIN, (450, 315), None, later);
        assert_eq!(pins.pins.len(), 1);
        pins.pin("toolset-core-rings", (10, 10), None, now);
        pins.moved_by_chemdraft(MAIN, (0, 315), None, later);
        assert_eq!(pins.pins.len(), 1);
        pins.pin("toolset-core-rings", (10, 10), None, now);
        assert_eq!(pins.target(MAIN, later), Some((0, 315)));
        assert_eq!(pins.pins.len(), 1);
    }

    #[test]
    fn closing_or_hiding_a_pinned_palette_keeps_the_pin_not_the_clamp() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        // Unpinned: the live frame.
        assert_eq!(
            pins.position_to_keep(MAIN, Some((369, 315)), Some(&vm()), now),
            Some((369, 315))
        );
        assert_eq!(pins.position_to_keep(MAIN, None, Some(&vm()), now), None);
        // Closed (or hidden by a second dialog) before the move back landed.
        pins.pin(MAIN, (450, 315), None, now);
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Reassert((450, 315))
        );
        assert_eq!(
            pins.position_to_keep(MAIN, Some((369, 315)), Some(&vm()), now),
            Some((450, 315))
        );
        assert_eq!(
            pins.position_to_keep(MAIN, None, Some(&vm()), now),
            Some((450, 315))
        );
        // Once the pin has expired, the live frame again.
        assert_eq!(
            pins.position_to_keep(MAIN, Some((369, 315)), Some(&vm()), now + PIN_DURATION),
            Some((369, 315))
        );
    }

    #[test]
    fn chemdraft_moves_retarget_the_pin_and_a_drag_ends_it() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        // Unpinned palettes are untouched by ChemDraft's own moves.
        pins.moved_by_chemdraft(MAIN, (0, 315), None, now);
        assert_eq!(pins.target(MAIN, now), None);
        assert_eq!(
            pins.moved(MAIN, (0, 315), &vm(), now),
            MovedDecision::Unpinned
        );

        pins.pin(MAIN, (450, 315), None, now);
        pins.moved_by_chemdraft(MAIN, (300, 315), None, now);
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
        pins.pin("toolset-core-rings", (10, 10), None, now);
        pins.forget(MAIN);
        assert_eq!(pins.target("toolset-core-rings", now), Some((10, 10)));
    }

    #[test]
    fn a_correction_to_a_superseded_target_is_neither_saved_nor_corrected() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), None, now);
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
        pins.moved_by_chemdraft(MAIN, (100, 315), None, now);
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
        pins.moved_by_chemdraft(MAIN, (1000, 315), None, now);
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

    #[test]
    fn a_late_clamp_of_a_superseded_target_is_judged_with_the_frame_it_had() {
        let now = Instant::now();
        let narrower = Layout {
            size: (900, 80),
            ..vm()
        };
        // The 1311-px frame pinned at 450 is clamped to 369; a fit then narrows it to 900 px and
        // puts it at 700. A late Moved at the old clamp is neither saved nor the user's.
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Reassert((450, 315))
        );
        pins.moved_by_chemdraft(MAIN, (700, 315), None, now);
        assert_eq!(
            pins.moved(MAIN, (369, 315), &narrower, now),
            MovedDecision::Superseded
        );
        assert_eq!(pins.target(MAIN, now), Some((700, 315)));
        // The same when the fit came before any Moved event: the pin's own size is used.
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        pins.moved_by_chemdraft(MAIN, (700, 315), None, now);
        assert_eq!(
            pins.moved(MAIN, (369, 315), &narrower, now),
            MovedDecision::Superseded
        );
        assert_eq!(pins.target(MAIN, now), Some((700, 315)));
    }

    #[test]
    fn each_superseded_target_keeps_the_frame_it_was_moved_with() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        // A recovery moves the 1100-px frame to 700 (its clamp would be 1680 - 1100 = 580), then a
        // fit narrows it to 700 px at 900, both before any Moved event.
        pins.moved_by_chemdraft(MAIN, (700, 315), Some((1100, 80)), now);
        pins.moved_by_chemdraft(MAIN, (900, 315), Some((700, 80)), now);
        let fitted = Layout {
            size: (700, 80),
            ..vm()
        };
        // A late clamp of the 700 target is judged with its 1100-px frame: ignored, not saved.
        assert_eq!(
            pins.moved(MAIN, (580, 315), &fitted, now),
            MovedDecision::Superseded
        );
        assert_eq!(
            pins.position_to_keep(MAIN, Some((580, 315)), Some(&fitted), now),
            Some((900, 315))
        );
        // The first target's clamp still uses its own 1311-px frame.
        assert_eq!(
            pins.moved(MAIN, (369, 315), &fitted, now),
            MovedDecision::Superseded
        );
        assert_eq!(pins.target(MAIN, now), Some((900, 315)));
        // A real move elsewhere still ends the pin.
        assert_eq!(
            pins.moved(MAIN, (575, 315), &fitted, now),
            MovedDecision::Moved
        );
    }

    #[test]
    fn a_resize_in_place_gives_the_target_its_new_frame_without_moving_it() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        // Unpinned palettes are untouched.
        pins.resized_by_chemdraft(MAIN, (900, 80), now);
        assert_eq!(pins.target(MAIN, now), None);
        // The 1311-px frame pinned at 450 is fitted in place to 1250 px, then retargeted to 700.
        // On the 1680-px work area: 450 + 1311 = 1761 overhangs, clamp 1680 - 1311 = 369;
        // 450 + 1250 = 1700 still overhangs, clamp 1680 - 1250 = 430 (not within 2 px of 450 or
        // 369). The new 700-px frame at 700 ends at 1400 and fits, so it has no clamp.
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        pins.resized_by_chemdraft(MAIN, (1250, 80), now);
        assert_eq!(pins.target(MAIN, now), Some((450, 315)));
        pins.moved_by_chemdraft(MAIN, (700, 315), None, now);
        let narrower = Layout {
            size: (700, 80),
            ..vm()
        };
        // A late clamp of 450 is predicted with the 1250-px frame it had (430), not the 1311-px
        // one (369).
        assert_eq!(
            pins.moved(MAIN, (430, 315), &narrower, now),
            MovedDecision::Superseded
        );
        assert_eq!(
            pins.moved(MAIN, (369, 315), &narrower, now),
            MovedDecision::Moved
        );
    }

    #[test]
    fn a_palette_just_shown_is_judged_once_it_is_mapped() {
        let soon = AFTER_MAP_INTERVAL;
        // The show is still queued: look again.
        assert_eq!(after_map_step(true, false, soon), AfterMapStep::Wait);
        assert_eq!(
            after_map_step(true, false, Duration::ZERO),
            AfterMapStep::Wait
        );
        // Mapped: judge now, even at the last look.
        assert_eq!(after_map_step(true, true, soon), AfterMapStep::Check);
        assert_eq!(
            after_map_step(true, true, AFTER_MAP_WAIT),
            AfterMapStep::Check
        );
        // Never mapped in time, or the pin is gone (expired, dragged, closed): stop.
        assert_eq!(
            after_map_step(true, false, AFTER_MAP_WAIT),
            AfterMapStep::Stop
        );
        assert_eq!(after_map_step(false, true, soon), AfterMapStep::Stop);
        assert_eq!(after_map_step(false, false, soon), AfterMapStep::Stop);
    }

    #[test]
    fn the_outer_frame_after_a_resize_keeps_its_decorations() {
        assert_eq!(
            outer_size_for_inner((1311, 80), (1311, 80), (700, 80)),
            (700, 80)
        );
        assert_eq!(
            outer_size_for_inner((1313, 110), (1311, 80), (700, 60)),
            (702, 90)
        );
    }

    #[test]
    fn only_the_work_area_the_frame_is_placed_in_supplies_the_clamp() {
        let now = Instant::now();
        let two = Layout {
            work_areas: &TWO,
            ..vm()
        };
        let mut pins = MapPins::default();
        pins.pin(MAIN, (1000, 100), Some(MAIN_SIZE), now);
        // KWin keeps the frame in the left work area, which it overlaps most.
        assert_eq!(
            pins.moved(MAIN, (369, 100), &two, now),
            MovedDecision::Reassert((1000, 100))
        );
        // An Alt-drag onto the right monitor's edge is the user's, not another clamp.
        assert_eq!(
            pins.moved(MAIN, (1680, 100), &two, now),
            MovedDecision::Moved
        );
        assert_eq!(pins.target(MAIN, now), None);
    }

    #[test]
    fn a_real_move_still_queued_wins_over_the_pin_when_closing_or_hiding() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        // The clamp, or the target itself: the pin.
        assert_eq!(
            pins.position_to_keep(MAIN, Some((369, 315)), Some(&vm()), now),
            Some((450, 315))
        );
        assert_eq!(
            pins.position_to_keep(MAIN, Some((451, 315)), Some(&vm()), now),
            Some((450, 315))
        );
        // An Alt-drag whose Moved event has not run yet: the live frame.
        assert_eq!(
            pins.position_to_keep(MAIN, Some((200, 600)), Some(&vm()), now),
            Some((200, 600))
        );
        // Without a layout to judge it by, the pin as before.
        assert_eq!(
            pins.position_to_keep(MAIN, Some((200, 600)), None, now),
            Some((450, 315))
        );
        // A frame still at a target ChemDraft replaced: the newer target.
        pins.moved_by_chemdraft(MAIN, (300, 315), None, now);
        assert_eq!(
            pins.position_to_keep(MAIN, Some((450, 315)), Some(&vm()), now),
            Some((300, 315))
        );
        // Judging it leaves the pin to the Moved event.
        assert_eq!(pins.target(MAIN, now), Some((300, 315)));
    }

    #[test]
    fn an_exact_clamp_of_a_tiny_overhang_is_corrected_not_taken_for_the_pin() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        // 370 + 1311 overhangs the 1680-px screen by one pixel: the clamp is 369, within the
        // target's slack.
        pins.pin(MAIN, (370, 315), Some(MAIN_SIZE), now);
        assert_eq!(
            pins.moved(MAIN, (370, 315), &vm(), now),
            MovedDecision::AtPin
        );
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Reassert((370, 315))
        );
        assert_eq!(
            pins.position_to_keep(MAIN, Some((369, 315)), Some(&vm()), now),
            Some((370, 315))
        );
        // The move back lands.
        assert_eq!(
            pins.moved(MAIN, (370, 315), &vm(), now),
            MovedDecision::AtPin
        );
        assert_eq!(pins.target(MAIN, now), None);
    }

    #[test]
    fn a_palette_shown_at_its_old_clamp_is_moved_back_without_waiting_for_a_move() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        // At the target, or somewhere else: nothing is due, and the pin stays.
        assert_eq!(pins.correction_due(MAIN, (450, 315), &vm(), now), None);
        assert_eq!(pins.correction_due(MAIN, (100, 100), &vm(), now), None);
        assert_eq!(pins.target(MAIN, now), Some((450, 315)));
        // At the clamp: due now, and it counts as a move back.
        assert_eq!(
            pins.correction_due(MAIN, (369, 315), &vm(), now),
            Some((450, 315))
        );
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Reassert((450, 315))
        );
        assert_eq!(pins.correction_due(MAIN, (369, 315), &vm(), now), None);
        // A target whose title can no longer be grabbed is not restored.
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        let layout = Layout {
            title_reachable: &unreachable,
            ..vm()
        };
        assert_eq!(pins.correction_due(MAIN, (369, 315), &layout, now), None);
        // Unpinned: nothing.
        assert_eq!(
            pins.correction_due("toolset-core-rings", (0, 0), &vm(), now),
            None
        );
    }

    #[test]
    fn a_palette_closed_before_the_move_back_reopens_at_its_pin() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Reassert((450, 315))
        );
        // Closed at the clamp: the pin is saved and the pin ends.
        let kept = pins.position_to_keep(MAIN, Some((369, 315)), Some(&vm()), now);
        assert_eq!(kept, Some((450, 315)));
        pins.close(MAIN, kept);
        assert_eq!(pins.target(MAIN, now), None);
        // The hidden window is still at the clamp: reopen from the saved position, once.
        assert_eq!(
            pins.reopen_position(MAIN, Some((369, 315)), &vm()),
            Some((450, 315))
        );
        assert_eq!(pins.reopen_position(MAIN, Some((369, 315)), &vm()), None);

        // Moved elsewhere while hidden: its live frame, not the old record.
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        pins.close(MAIN, Some((450, 315)));
        assert_eq!(pins.reopen_position(MAIN, Some((100, 100)), &vm()), None);
        // Closed with no pin: the caller passes nothing, and nothing is recorded.
        pins.close(MAIN, None);
        assert_eq!(pins.reopen_position(MAIN, Some((369, 315)), &vm()), None);
        // A destroyed window, or a new pin, drops the record.
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        pins.close(MAIN, Some((450, 315)));
        pins.forget(MAIN);
        assert_eq!(pins.reopen_position(MAIN, Some((369, 315)), &vm()), None);
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        pins.close(MAIN, Some((450, 315)));
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        assert_eq!(pins.reopen_position(MAIN, Some((369, 315)), &vm()), None);
    }
}
