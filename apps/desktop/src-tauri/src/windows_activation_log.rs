//! Narrow debug sink for the existing opt-in agent-bridge diagnostics. No log
//! backend is installed during ordinary launches, and other targets stay silent.

#[cfg(windows)]
pub(crate) fn init(enabled: bool) {
    struct ActivationLog;
    impl log::Log for ActivationLog {
        fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
            metadata.target() == "chemdraft::windows_activation"
                && metadata.level() <= log::Level::Debug
        }

        fn log(&self, record: &log::Record<'_>) {
            if self.enabled(record.metadata()) {
                eprintln!(
                    "[windows-activation {}] {}",
                    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    record.args()
                );
            }
        }

        fn flush(&self) {}
    }

    static LOGGER: ActivationLog = ActivationLog;
    if enabled && log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Debug);
    }
}

#[cfg(not(windows))]
pub(crate) fn init(_enabled: bool) {}

/// Frame writes use the same opt-in debug sink as focus and activation diagnostics.
pub(super) fn frame_set<P: std::fmt::Debug, S: std::fmt::Debug>(
    label: &str,
    reason: &str,
    units: &str,
    frame: impl FnOnce() -> (P, S),
) {
    if cfg!(debug_assertions)
        && log::log_enabled!(target: "chemdraft::windows_activation", log::Level::Debug)
    {
        let (position, size) = frame();
        log::debug!(target: "chemdraft::windows_activation",
            "set utility frame label={label} reason={reason} units={units} position={position:?} size={size:?}");
    }
}

/// Trace document menu replacements and incoming menu events for the current generation.
#[cfg(all(windows, debug_assertions))]
pub(super) fn menu(event: Option<&str>) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static GENERATION: AtomicU64 = AtomicU64::new(0);
    if log::log_enabled!(target: "chemdraft::windows_activation", log::Level::Debug) {
        let generation = if event.is_none() {
            GENERATION.fetch_add(1, Ordering::Relaxed) + 1
        } else {
            GENERATION.load(Ordering::Relaxed)
        };
        log::debug!(target: "chemdraft::windows_activation",
            "native menu generation={generation} event={}", event.unwrap_or("<installed>"));
    }
}

#[cfg(not(all(windows, debug_assertions)))]
pub(super) fn menu(_event: Option<&str>) {}
