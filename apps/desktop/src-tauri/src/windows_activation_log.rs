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
                eprintln!("[windows-activation] {}", record.args());
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
