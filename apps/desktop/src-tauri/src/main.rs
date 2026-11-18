// Release builds on Windows are GUI-subsystem executables: no console window behind the app.
// Debug builds keep the console so `pnpm dev` shows Rust-side logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    configure_webkit_renderer();
    chemdraft_lib::run();
}

#[cfg(target_os = "linux")]
fn configure_webkit_renderer() {
    const VARIABLE: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    if should_disable_dmabuf(std::env::var_os(VARIABLE).as_deref()) {
        // Set the default before Tauri starts GTK, WebKitGTK, or any app threads.
        std::env::set_var(VARIABLE, "1");
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_webkit_renderer() {}

#[cfg(any(target_os = "linux", test))]
fn should_disable_dmabuf(user_value: Option<&std::ffi::OsStr>) -> bool {
    user_value.is_none()
}

#[cfg(test)]
mod tests {
    use super::should_disable_dmabuf;
    use std::ffi::OsStr;

    #[test]
    fn dmabuf_default_respects_every_explicit_value() {
        assert!(should_disable_dmabuf(None));
        for value in ["0", "1", ""] {
            assert!(!should_disable_dmabuf(Some(OsStr::new(value))));
        }
    }
}
