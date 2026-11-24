use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{
    ipc::Invoke,
    plugin::{Plugin, TauriPlugin},
    AppHandle, Manager, Runtime, Window,
};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, FilePath};
use tauri_plugin_fs::FsExt;

/// The dialog plugin as every Linux build registers it. AppImage builds take over the file pickers
/// (default folders, scope grants); every build parents its message prompts.
pub(super) struct AppImageDialogs<R: Runtime> {
    pub(super) inner: TauriPlugin<R>,
    pub(super) appimage: bool,
}

impl<R: Runtime> Plugin<R> for AppImageDialogs<R> {
    fn name(&self) -> &'static str {
        self.inner.name()
    }

    fn initialize(
        &mut self,
        app: &AppHandle<R>,
        config: serde_json::Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.inner.initialize(app, config)
    }

    fn initialization_script(&self) -> Option<String> {
        self.inner.initialization_script()
    }

    fn extend_api(&mut self, invoke: Invoke<R>) -> bool {
        // Keep the existing dialog command names and Tauri ACL. Use its native builder, and
        // continue to grant access only to the picked paths in both filesystem scopes.
        match invoke.message.command() {
            "open" | "save" if self.appimage => {
                let handler: fn(Invoke<R>) -> bool =
                    tauri::generate_handler![#![plugin(dialog)] open, save];
                handler(invoke)
            }
            "message" => {
                parent_next_message_dialog(invoke.message.webview().window());
                self.inner.extend_api(invoke)
            }
            _ => self.inner.extend_api(invoke),
        }
    }
}

/// Make the next parentless GTK message dialog transient for the document window.
///
/// tauri-plugin-dialog passes the calling window as the parent, but rfd's GTK backend builds its
/// message box with `gtk_message_dialog_new(NULL, …)` and drops it. Without WM_TRANSIENT_FOR, KWin
/// does not keep the modal box above the document: any click that raises the document window
/// (a menu, the canvas) buried "Save changes before closing?" behind it, while the palettes stayed
/// hidden for the prompt and the menus stayed blocked, so ChemDraft looked frozen with its
/// toolbars gone. The box is created on GTK's main thread after this returns, so poll for it there
/// (nested `gtk_dialog_run` loops still dispatch timeouts) and give up after five seconds.
fn parent_next_message_dialog<R: Runtime>(window: Window<R>) {
    let app = window.app_handle().clone();
    let caller = window.clone();
    let _ = window.run_on_main_thread(move || {
        use gtk::prelude::{Cast, GtkWindowExt, WidgetExt};

        // Prefer the document window: palettes are hidden while a prompt is up.
        let owner = app
            .get_webview_window(super::MAIN_WINDOW_LABEL)
            .and_then(|main| main.gtk_window().ok())
            .filter(|main| main.is_visible())
            .or_else(|| caller.gtk_window().ok());
        let Some(owner) = owner else {
            return;
        };
        let mut attempts = 0_u32;
        let _ = gtk::glib::timeout_add_local(std::time::Duration::from_millis(25), move || {
            attempts += 1;
            let owner: &gtk::Window = owner.upcast_ref();
            for widget in gtk::Window::list_toplevels() {
                let Ok(dialog) = widget.downcast::<gtk::MessageDialog>() else {
                    continue;
                };
                if dialog.transient_for().is_none() {
                    dialog.set_transient_for(Some(owner));
                    return gtk::glib::ControlFlow::Break;
                }
            }
            if attempts < 200 {
                gtk::glib::ControlFlow::Continue
            } else {
                gtk::glib::ControlFlow::Break
            }
        });
    });
}

#[derive(Deserialize)]
struct Filter {
    name: String,
    extensions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    title: Option<String>,
    default_path: Option<PathBuf>,
    can_create_directories: Option<bool>,
    #[serde(default)]
    filters: Vec<Filter>,
    #[serde(default)]
    directory: bool,
    #[serde(default)]
    multiple: bool,
    #[serde(default)]
    recursive: bool,
}

fn file_dialog<R: Runtime>(window: &Window<R>, options: &Options) -> FileDialogBuilder<R> {
    let startup = window.state::<super::linux_startup::Startup>();
    let appimage = startup.appimage.as_ref().expect("AppImage dialog plugin");
    let path = super::linux_startup::file_dialog_default_path(
        options.default_path.as_deref(),
        &appimage.dialogs,
    );
    let mut dialog = window.dialog().file();
    if !path.is_dir() {
        if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
            dialog = dialog
                .set_directory(parent)
                .set_file_name(name.to_string_lossy());
        }
    } else {
        dialog = dialog.set_directory(path);
    }
    if let Some(title) = &options.title {
        dialog = dialog.set_title(title);
    }
    if let Some(can_create) = options.can_create_directories {
        dialog = dialog.set_can_create_directories(can_create);
    }
    for filter in &options.filters {
        let extensions: Vec<_> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    dialog
}

#[derive(Serialize)]
#[serde(untagged)]
enum Selection {
    One(Option<FilePath>),
    Many(Option<Vec<FilePath>>),
}

#[tauri::command]
async fn open<R: Runtime>(
    window: Window<R>,
    options: Options,
) -> tauri_plugin_dialog::Result<Selection> {
    let dialog = file_dialog(&window, &options);
    let selection = match (options.directory, options.multiple) {
        (false, false) => Selection::One(dialog.blocking_pick_file()),
        (false, true) => Selection::Many(dialog.blocking_pick_files()),
        (true, false) => Selection::One(dialog.blocking_pick_folder()),
        (true, true) => Selection::Many(dialog.blocking_pick_folders()),
    };
    let picked = match &selection {
        Selection::One(path) => path.as_slice(),
        Selection::Many(paths) => paths.as_deref().unwrap_or_default(),
    };
    for path in picked {
        grant_path(&window, path, options.directory, options.recursive)?;
    }
    Ok(selection)
}

#[tauri::command]
async fn save<R: Runtime>(
    window: Window<R>,
    options: Options,
) -> tauri_plugin_dialog::Result<Option<FilePath>> {
    let chosen = file_dialog(&window, &options)
        .set_parent(&window)
        .blocking_save_file();
    if let Some(path) = &chosen {
        grant_path(&window, path, false, false)?;
    }
    Ok(chosen)
}

fn grant_path<R: Runtime>(
    window: &Window<R>,
    picked: &FilePath,
    directory: bool,
    recursive: bool,
) -> tauri_plugin_dialog::Result<()> {
    let path = picked.clone().into_path()?;
    let scope = window.state::<tauri::scope::Scopes>();
    if directory {
        if let Some(fs_scope) = window.try_fs_scope() {
            fs_scope.allow_directory(&path, recursive)?;
        }
        scope.allow_directory(&path, true)?;
    } else {
        if let Some(fs_scope) = window.try_fs_scope() {
            fs_scope.allow_file(&path)?;
        }
        scope.allow_file(&path)?;
    }
    Ok(())
}
