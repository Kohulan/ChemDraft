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

    let wayland_display_set = std::env::var_os("WAYLAND_DISPLAY").is_some();
    if should_default_to_xwayland(
        wayland_display_set,
        std::env::var_os("GDK_BACKEND").as_deref(),
        std::env::var_os("CHEMDRAFT_NATIVE_WAYLAND").as_deref(),
    ) {
        // Native Wayland leaves floating palette and dialog placement to the compositor.
        std::env::set_var("GDK_BACKEND", "x11");
        eprintln!("ChemDraft GTK backend default: GDK_BACKEND=x11");
    }

    let gdk_backend = std::env::var_os("GDK_BACKEND");
    if let Some(platform) = appimage_egl_platform(
        std::env::var_os("APPIMAGE").is_some(),
        std::env::var_os("EGL_PLATFORM").as_deref(),
        gdk_backend.as_deref(),
        wayland_display_set,
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
fn should_default_to_xwayland(
    wayland_display_set: bool,
    gdk_backend: Option<&std::ffi::OsStr>,
    native_wayland: Option<&std::ffi::OsStr>,
) -> bool {
    wayland_display_set
        && gdk_backend.is_none()
        && native_wayland != Some(std::ffi::OsStr::new("1"))
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

    let backend = gdk_backend
        .map(std::ffi::OsStr::as_encoded_bytes)
        .unwrap_or_default();
    Some(if backend.starts_with(b"x11") {
        "x11"
    } else if backend.starts_with(b"wayland") || wayland_display_set {
        "wayland"
    } else {
        "x11"
    })
}

#[cfg(test)]
mod tests {
    use super::{appimage_egl_platform, should_default_to_xwayland, should_disable_dmabuf};
    use std::ffi::OsStr;

    #[test]
    fn dmabuf_default_respects_every_explicit_value() {
        assert!(should_disable_dmabuf(None));
        for value in ["0", "1", ""] {
            assert!(!should_disable_dmabuf(Some(OsStr::new(value))));
        }
    }

    #[test]
    fn xwayland_default_requires_wayland_and_respects_opt_out() {
        for (native_wayland, expected_on_wayland) in [
            (None, true),
            (Some("0"), true),
            (Some(""), true),
            (Some("1"), false),
        ] {
            let native_wayland = native_wayland.map(OsStr::new);
            assert!(!should_default_to_xwayland(false, None, native_wayland));
            assert_eq!(
                should_default_to_xwayland(true, None, native_wayland),
                expected_on_wayland
            );
        }
    }

    #[test]
    fn xwayland_default_respects_every_explicit_backend() {
        for backend in ["x11", "wayland", "x11,wayland", "other", ""] {
            assert!(!should_default_to_xwayland(
                true,
                Some(OsStr::new(backend)),
                None
            ));
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
            for backend in [None, Some("x11"), Some("wayland")] {
                assert_eq!(
                    appimage_egl_platform(
                        true,
                        Some(OsStr::new(value)),
                        backend.map(OsStr::new),
                        true,
                    ),
                    None
                );
            }
        }
    }

    #[test]
    fn egl_platform_default_matches_the_gdk_backend() {
        for (backend, wayland_display_set, expected) in [
            (Some("x11"), false, "x11"),
            (Some("x11"), true, "x11"),
            (Some("x11,wayland"), true, "x11"),
            (Some("wayland"), false, "wayland"),
            (Some("wayland"), true, "wayland"),
            (Some("wayland,x11"), false, "wayland"),
            (Some("other,wayland"), false, "x11"),
            (Some("other,x11"), true, "wayland"),
            (None, false, "x11"),
            (None, true, "wayland"),
        ] {
            assert_eq!(
                appimage_egl_platform(true, None, backend.map(OsStr::new), wayland_display_set),
                Some(expected)
            );
        }
    }
}
