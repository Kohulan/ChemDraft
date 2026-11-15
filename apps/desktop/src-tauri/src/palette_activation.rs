//! Windows command surfaces never borrow activation. Editable palette controls still
//! need their explicit input lease (including WebView2's native colour chooser).

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Policy {
    command_popover: bool,
    command_press: bool,
}

impl Policy {
    pub fn set_content(&mut self, kind: &str) {
        self.command_popover = kind == "flyout";
        // A new content session must not inherit the previous control's focus permission.
        self.command_press = self.command_popover;
    }

    pub fn mouse_activate(&mut self, command_hit: bool) -> Option<isize> {
        self.command_press = command_hit;
        if self.command_popover || command_hit {
            // MA_NOACTIVATE, deliberately not MA_NOACTIVATEANDEAT: WebView2 must
            // receive the original press/release exactly once, including a 200 ms hold.
            Some(3)
        } else {
            None
        }
    }

    pub fn permits_input_focus(self) -> bool {
        !self.command_popover && !self.command_press
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_click_does_not_activate_or_eat_the_click_before_or_after_editing() {
        let mut policy = Policy::default();
        for _ in 0..2 {
            assert_eq!(policy.mouse_activate(true), Some(3));
            assert!(!policy.permits_input_focus()); // Also rejects a delayed input lease.
            assert_eq!(policy.mouse_activate(false), None);
            assert!(policy.permits_input_focus()); // A deliberate control click still works.
        }
    }

    #[test]
    fn every_flyout_press_is_nonactivating_without_hit_boxes_or_foreground_state() {
        let mut policy = Policy::default();
        policy.set_content("flyout");
        for hit in [false, true] {
            assert_eq!(policy.mouse_activate(hit), Some(3));
            assert!(!policy.permits_input_focus());
        }
    }

    #[test]
    fn reused_colour_popover_cannot_restore_an_edit_lease_into_a_command_flyout() {
        let mut policy = Policy::default();
        for kind in ["textColor", "artColor"] {
            policy.set_content(kind);
            assert!(policy.permits_input_focus());
            policy.set_content("flyout");
            assert!(!policy.permits_input_focus());
            policy.set_content(kind);
            assert_eq!(policy.mouse_activate(false), None);
            assert!(policy.permits_input_focus());
        }
    }
}
