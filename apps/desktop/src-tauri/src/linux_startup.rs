use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

#[cfg(target_os = "linux")]
pub(super) struct Startup {
    pub(super) documents: Vec<PathBuf>,
    pub(super) legacy_webkit_cwd: Option<PathBuf>,
}

#[cfg(target_os = "linux")]
pub(super) fn configure() -> Startup {
    use std::env;

    configure_webkit_renderer();
    let cwd = env::current_dir().ok();
    let appdir = appimage_root(
        env::var_os("APPIMAGE").as_deref(),
        env::var_os("APPDIR").as_deref(),
        cwd.as_deref(),
    );
    let owd = env::var_os("OWD");
    let home = dirs::home_dir();
    let destination = appdir
        .as_ref()
        .and_then(|_| user_working_directory(owd.as_deref().map(Path::new), home.as_deref()));
    let documents = env::args_os()
        .skip(1)
        .filter_map(|arg| document_argument(&arg, destination.or(cwd.as_deref())))
        .collect();

    let mut legacy_webkit_cwd = None;
    if let Some(appdir) = appdir {
        let appdir = appdir.canonicalize().unwrap_or(appdir);
        env::set_var("APPDIR", &appdir);
        let bundled_webkit = appdir
            .join("usr")
            .join("lib")
            .join(format!("{}-linux-gnu", env::consts::ARCH))
            .join("webkit2gtk-4.1");
        let helper_override = env::var_os("WEBKIT_EXEC_PATH");
        let has_helper_override = present(helper_override.as_deref());
        let mut injected_bundle = env::var_os("WEBKIT_INJECTED_BUNDLE_PATH");
        if injected_bundle.is_none() {
            let bundled = bundled_webkit
                .join("injected-bundle")
                .join("libwebkit2gtkinjectedbundle.so");
            if bundled.is_file() {
                injected_bundle = Some(bundled.into_os_string());
            }
        }
        for (variable, value) in [
            ("WEBKIT_EXEC_PATH", helper_override),
            ("WEBKIT_INJECTED_BUNDLE_PATH", injected_bundle),
        ] {
            if let Some(path) = appimage_path_override(&appdir, value.as_deref()) {
                env::set_var(variable, path);
            }
        }
        legacy_webkit_cwd = legacy_webkit_working_directory(
            cwd.as_deref(),
            &appdir,
            bundled_webkit.join("WebKitWebProcess").is_file(),
            has_helper_override,
        )
        .map(Path::to_owned);
        if let Some(destination) = destination {
            let fallback =
                user_working_directory(None, home.as_deref()).filter(|path| *path != destination);
            for folder in std::iter::once(destination).chain(fallback) {
                match env::set_current_dir(folder) {
                    Ok(()) => break,
                    Err(error) => {
                        eprintln!(
                            "ChemDraft: could not enter AppImage launch folder {folder:?}: {error}"
                        );
                    }
                }
            }
        }
    }

    Startup {
        documents,
        legacy_webkit_cwd,
    }
}

#[cfg(target_os = "linux")]
pub(super) fn restore_legacy_webkit_cwd(cwd: Option<&Path>) {
    // The single-instance plugin has already forwarded the caller's cwd during build().
    // Tauri creates its first WebKit webview only after the event loop emits Ready.
    if let Some(cwd) = cwd {
        match std::env::set_current_dir(cwd) {
            Ok(()) => eprintln!("ChemDraft: retaining the AppImage working folder for bundled WebKit helpers"),
            Err(error) => eprintln!("ChemDraft: could not restore the AppImage folder for bundled WebKit helpers: {error}"),
        }
    }
}

#[cfg(target_os = "linux")]
fn configure_webkit_renderer() {
    const VARIABLE: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    if should_disable_dmabuf(std::env::var_os(VARIABLE).as_deref()) {
        // Set the default before Tauri starts GTK, WebKitGTK, or any app threads.
        std::env::set_var(VARIABLE, "1");
    }

    let display = std::env::var_os("DISPLAY");
    let wayland_display = std::env::var_os("WAYLAND_DISPLAY");
    match backend_default(
        display.as_deref(),
        wayland_display.as_deref(),
        std::env::var_os("GDK_BACKEND").as_deref(),
        std::env::var_os("CHEMDRAFT_NATIVE_WAYLAND").as_deref(),
    ) {
        BackendDefault::X11 => {
            // Native Wayland leaves floating palette and dialog placement to the compositor.
            std::env::set_var("GDK_BACKEND", "x11");
            eprintln!("ChemDraft GTK backend default: GDK_BACKEND=x11");
        }
        BackendDefault::WaylandWithoutX11 => {
            eprintln!(
                "ChemDraft GTK backend: keeping native Wayland because DISPLAY is unavailable"
            );
        }
        BackendDefault::Unchanged => {}
    }

    let gdk_backend = std::env::var_os("GDK_BACKEND");
    if let Some(platform) = appimage_egl_platform(
        std::env::var_os("APPIMAGE").is_some(),
        std::env::var_os("EGL_PLATFORM").as_deref(),
        gdk_backend.as_deref(),
        present(wayland_display.as_deref()),
    ) {
        // Bundled WebKitGTK asks the host EGL for a default display without a platform.
        std::env::set_var("EGL_PLATFORM", platform);
        eprintln!(
            "ChemDraft AppImage EGL default: EGL_PLATFORM={platform} GDK_BACKEND={gdk_backend:?}"
        );
    }
}

fn should_disable_dmabuf(user_value: Option<&OsStr>) -> bool {
    user_value.is_none()
}

#[derive(Debug, PartialEq, Eq)]
enum BackendDefault {
    X11,
    WaylandWithoutX11,
    Unchanged,
}

fn present(value: Option<&OsStr>) -> bool {
    value.is_some_and(|value| !value.is_empty())
}

fn backend_default(
    display: Option<&OsStr>,
    wayland_display: Option<&OsStr>,
    gdk_backend: Option<&OsStr>,
    native_wayland: Option<&OsStr>,
) -> BackendDefault {
    if gdk_backend.is_some() || !present(wayland_display) {
        BackendDefault::Unchanged
    } else if !present(display) {
        BackendDefault::WaylandWithoutX11
    } else if native_wayland == Some(OsStr::new("1")) {
        BackendDefault::Unchanged
    } else {
        BackendDefault::X11
    }
}

fn absolute_path(path: &Path, base: Option<&Path>) -> Option<PathBuf> {
    if path.is_absolute() {
        Some(path.to_owned())
    } else {
        base.map(|base| base.join(path))
            .filter(|path| path.is_absolute())
    }
}

fn appimage_root(
    image: Option<&OsStr>,
    root: Option<&OsStr>,
    cwd: Option<&Path>,
) -> Option<PathBuf> {
    if !present(image) {
        return None;
    }
    let root = root.filter(|root| !root.is_empty())?;
    absolute_path(Path::new(root), cwd)
}

fn user_working_directory<'a>(owd: Option<&'a Path>, home: Option<&'a Path>) -> Option<&'a Path> {
    owd.filter(|path| path.is_absolute())
        .or_else(|| home.filter(|path| path.is_absolute()))
}

fn document_argument(arg: &OsStr, cwd: Option<&Path>) -> Option<PathBuf> {
    if arg.is_empty() || arg.as_encoded_bytes().starts_with(b"-") {
        return None;
    }
    absolute_path(Path::new(arg), cwd)
}

fn appimage_path_override(root: &Path, value: Option<&OsStr>) -> Option<PathBuf> {
    let path = Path::new(value.filter(|value| !value.is_empty())?);
    absolute_path(path, Some(root))
}

fn legacy_webkit_working_directory<'a>(
    cwd: Option<&'a Path>,
    root: &Path,
    bundled_webkit: bool,
    helper_override: bool,
) -> Option<&'a Path> {
    // linuxdeploy's standard WebKit build embeds relative helper paths. An AppImage whose
    // WebKit supports the absolute override can provide WEBKIT_EXEC_PATH before launch.
    if bundled_webkit && !helper_override {
        cwd.filter(|cwd| cwd.starts_with(root))
    } else {
        None
    }
}

fn appimage_egl_platform(
    appimage_set: bool,
    egl_platform: Option<&OsStr>,
    gdk_backend: Option<&OsStr>,
    wayland_display_set: bool,
) -> Option<&'static str> {
    if !appimage_set || egl_platform.is_some() {
        return None;
    }

    let backend = gdk_backend.map(OsStr::as_encoded_bytes).unwrap_or_default();
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
    use super::*;

    #[test]
    fn dmabuf_default_respects_every_explicit_value() {
        assert!(should_disable_dmabuf(None));
        for value in ["0", "1", ""] {
            assert!(!should_disable_dmabuf(Some(OsStr::new(value))));
        }
    }

    #[test]
    fn xwayland_default_requires_both_displays_and_respects_opt_out() {
        for (native_wayland, expected_on_wayland) in [
            (None, BackendDefault::X11),
            (Some("0"), BackendDefault::X11),
            (Some(""), BackendDefault::X11),
            (Some("1"), BackendDefault::Unchanged),
        ] {
            let native_wayland = native_wayland.map(OsStr::new);
            let display = Some(OsStr::new(":0"));
            let wayland = Some(OsStr::new("wayland-0"));
            assert_eq!(
                backend_default(display, None, None, native_wayland),
                BackendDefault::Unchanged
            );
            assert_eq!(
                backend_default(display, Some(OsStr::new("")), None, native_wayland),
                BackendDefault::Unchanged
            );
            assert_eq!(
                backend_default(display, wayland, None, native_wayland),
                expected_on_wayland
            );
            for unavailable in [None, Some(OsStr::new(""))] {
                assert_eq!(
                    backend_default(unavailable, wayland, None, native_wayland),
                    BackendDefault::WaylandWithoutX11
                );
            }
        }
    }

    #[test]
    fn xwayland_default_respects_every_explicit_backend() {
        for backend in ["x11", "wayland", "x11,wayland", "other", ""] {
            for display in [None, Some(OsStr::new(":0"))] {
                assert_eq!(
                    backend_default(
                        display,
                        Some(OsStr::new("wayland-0")),
                        Some(OsStr::new(backend)),
                        None
                    ),
                    BackendDefault::Unchanged
                );
            }
        }
    }

    fn test_root() -> &'static Path {
        Path::new(if cfg!(windows) { "C:\\" } else { "/" })
    }

    #[test]
    fn appimage_requires_both_variables_and_anchors_a_relative_mount() {
        let cwd = test_root().join("extracted");
        let image = Some(OsStr::new("ChemDraft.AppImage"));
        let root = Some(OsStr::new("AppDir"));
        assert_eq!(appimage_root(None, root, Some(&cwd)), None);
        assert_eq!(appimage_root(image, None, Some(&cwd)), None);
        assert_eq!(appimage_root(image, Some(OsStr::new("")), Some(&cwd)), None);
        assert_eq!(appimage_root(image, root, None), None);
        assert_eq!(
            appimage_root(image, root, Some(&cwd)),
            Some(cwd.join("AppDir"))
        );
    }

    #[test]
    fn relative_document_arguments_use_the_original_folder_or_home() {
        let owd = test_root().join("original");
        let home = test_root().join("home");
        let name = OsStr::new("drawing.cdxml");
        for (original, expected) in [(Some(owd.as_path()), &owd), (None, &home)] {
            let folder = user_working_directory(original, Some(&home));
            assert_eq!(document_argument(name, folder), Some(expected.join(name)));
        }
        assert_eq!(
            user_working_directory(Some(Path::new("relative")), Some(&home)),
            Some(home.as_path())
        );
        let absolute = owd.join("absolute.cdx");
        assert_eq!(
            document_argument(absolute.as_os_str(), Some(&home)),
            Some(absolute)
        );
        assert_eq!(
            document_argument(OsStr::new("--chemdraft-agent-bridge"), Some(&home)),
            None
        );
        assert_eq!(document_argument(name, None), None);
    }

    #[test]
    fn bundled_webkit_overrides_use_appdir_and_keep_absolute_paths() {
        let appdir = test_root().join("AppDir");
        let relative = Path::new("usr").join("lib").join("webkit2gtk-4.1");
        assert_eq!(
            appimage_path_override(&appdir, Some(relative.as_os_str())),
            Some(appdir.join(relative))
        );
        let absolute = test_root().join("system-webkit");
        assert_eq!(
            appimage_path_override(&appdir, Some(absolute.as_os_str())),
            Some(absolute)
        );
        assert_eq!(appimage_path_override(&appdir, None), None);
    }

    #[test]
    fn retain_cwd_for_bundles_with_relative_webkit_helpers() {
        let appdir = test_root().join("AppDir");
        let cwd = appdir.join("usr");
        assert_eq!(
            legacy_webkit_working_directory(Some(&cwd), &appdir, true, false),
            Some(cwd.as_path())
        );
        assert_eq!(
            legacy_webkit_working_directory(Some(&cwd), &appdir, true, true),
            None
        );
        assert_eq!(
            legacy_webkit_working_directory(Some(&cwd), &appdir, false, false),
            None
        );
        assert_eq!(
            legacy_webkit_working_directory(Some(test_root()), &appdir, true, false),
            None
        );
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
