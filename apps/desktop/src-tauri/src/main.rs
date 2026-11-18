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

    let gdk_backend = std::env::var_os("GDK_BACKEND");
    if let Some(platform) = appimage_egl_platform(
        std::env::var_os("APPIMAGE").is_some(),
        std::env::var_os("EGL_PLATFORM").as_deref(),
        gdk_backend.as_deref(),
        std::env::var_os("WAYLAND_DISPLAY").is_some(),
    ) {
        // Bundled WebKitGTK asks the host EGL for a default display without a platform.
        std::env::set_var("EGL_PLATFORM", platform);
        eprintln!(
            "ChemDraft AppImage EGL default: EGL_PLATFORM={platform} GDK_BACKEND={gdk_backend:?}"
        );
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_webkit_renderer() {}

#[cfg(any(target_os = "linux", test))]
fn should_disable_dmabuf(user_value: Option<&std::ffi::OsStr>) -> bool {
    user_value.is_none()
}

#[cfg(any(target_os = "linux", test))]
fn appimage_egl_platform(
    appimage_set: bool,
    egl_platform: Option<&std::ffi::OsStr>,
    gdk_backend: Option<&std::ffi::OsStr>,
    wayland_display_set: bool,
) -> Option<&'static str> {
    if !appimage_set || egl_platform.is_some() {
        return None;
    }

    let x11_backend =
        gdk_backend.is_some_and(|backend| backend.as_encoded_bytes().starts_with(b"x11"));
    Some(if x11_backend || !wayland_display_set {
        "x11"
    } else {
        "wayland"
    })
}

#[cfg(test)]
mod tests {
    use super::{appimage_egl_platform, should_disable_dmabuf};
    use std::ffi::OsStr;

    #[test]
    fn dmabuf_default_respects_every_explicit_value() {
        assert!(should_disable_dmabuf(None));
        for value in ["0", "1", ""] {
            assert!(!should_disable_dmabuf(Some(OsStr::new(value))));
        }
    }

    #[test]
    fn egl_platform_default_only_applies_to_appimages() {
        assert_eq!(appimage_egl_platform(false, None, None, false), None);
        assert_eq!(appimage_egl_platform(false, None, None, true), None);
    }

    #[test]
    fn egl_platform_default_respects_every_explicit_value() {
        for value in ["x11", "wayland", "surfaceless", ""] {
            assert_eq!(
                appimage_egl_platform(true, Some(OsStr::new(value)), None, false),
                None
            );
        }
    }

    #[test]
    fn egl_platform_default_matches_the_gdk_backend() {
        for (backend, wayland_display_set, expected) in [
            (Some("x11"), true, "x11"),
            (Some("x11,wayland"), true, "x11"),
            (None, false, "x11"),
            (Some("wayland"), false, "x11"),
            (Some("wayland"), true, "wayland"),
            (None, true, "wayland"),
        ] {
            assert_eq!(
                appimage_egl_platform(true, None, backend.map(OsStr::new), wayland_display_set),
                Some(expected)
            );
        }
    }
}
