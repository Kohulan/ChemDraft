use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{
    ipc::Invoke,
    plugin::{Plugin, TauriPlugin},
    AppHandle, Manager, Runtime, Window,
};
use tauri_plugin_dialog::{
    DialogExt, FileDialogBuilder, FilePath, MessageDialogBuilder, MessageDialogButtons,
    MessageDialogKind, MessageDialogResult,
};
use tauri_plugin_fs::FsExt;

/// The dialog plugin as every Linux build registers it. AppImage builds take over the file pickers
/// (default folders, scope grants); every build shows its message prompts through [`prompt`].
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
                let handler: fn(Invoke<R>) -> bool =
                    tauri::generate_handler![#![plugin(dialog)] message];
                handler(invoke)
            }
            _ => self.inner.extend_api(invoke),
        }
    }
}

/// The dialog plugin's `message` command, shown through [`prompt`]: same arguments, same result.
#[tauri::command]
async fn message<R: Runtime>(
    window: Window<R>,
    title: Option<String>,
    message: String,
    kind: Option<MessageDialogKind>,
    buttons: Option<MessageDialogButtons>,
) -> MessageDialogResult {
    let mut builder = prompt(
        window.app_handle(),
        Some(&window),
        title.as_deref(),
        &message,
    );
    if let Some(buttons) = buttons {
        builder = builder.buttons(gtk_buttons(buttons));
    }
    if let Some(kind) = kind {
        builder = builder.kind(kind);
    }
    builder.blocking_show_with_result()
}

/// A message prompt that is safe to hand to rfd's GTK backend, made transient for the document
/// window once it appears. Every Linux prompt goes through here: the webview's `message` command,
/// the update notice and the shell-open error alike.
///
/// rfd 0.16 passes the message to `gtk_message_dialog_format_secondary_text` as the printf FORMAT,
/// so a '%' in it (a document named "100%s.chemdraft" in "Save changes to …?") read a missing
/// vararg and could crash the app; it also builds a `CString` from the title, the message and
/// custom button labels with `unwrap`, so an embedded NUL panicked.
pub(super) fn prompt<R: Runtime>(
    app: &AppHandle<R>,
    caller: Option<&Window<R>>,
    title: Option<&str>,
    message: &str,
) -> MessageDialogBuilder<R> {
    let text = PromptText::new(title, message);
    // tauri-plugin-dialog titles an untitled prompt with the package name, and rfd sets it as the
    // GTK window title.
    let shown = ShownPrompt {
        title: text
            .title
            .clone()
            .unwrap_or_else(|| app.package_info().name.clone()),
        body: text.shown,
    };
    let mut builder = app.dialog().message(text.format);
    if let Some(title) = text.title {
        builder = builder.title(title);
    }
    match caller {
        Some(window) => builder = builder.parent(window),
        None => {
            if let Some(main) = app.get_webview_window(super::MAIN_WINDOW_LABEL) {
                builder = builder.parent(&main);
            }
        }
    }
    parent_message_dialog(app, caller.cloned(), shown);
    builder
}

/// The text of one prompt as rfd's GTK backend needs it.
#[derive(Debug, PartialEq, Eq)]
struct PromptText {
    /// The title, without NULs. rfd shows it through a "%s" format, so '%' is left alone.
    title: Option<String>,
    /// The message as a printf format whose output is `shown`: NULs removed, '%' doubled.
    format: String,
    /// The message as GTK will display it; the dialog is recognised by it.
    shown: String,
}

impl PromptText {
    fn new(title: Option<&str>, message: &str) -> Self {
        let shown = without_nul(message);
        Self {
            title: title.map(without_nul),
            format: shown.replace('%', "%%"),
            shown,
        }
    }
}

/// `CString::new` rejects an interior NUL, and rfd unwraps it. Nothing a person reads is lost.
fn without_nul(text: &str) -> String {
    text.replace('\0', "")
}

/// What GTK will show for one prompt; its dialog is recognised by both.
#[derive(Debug, PartialEq, Eq)]
struct ShownPrompt {
    /// The window title rfd sets.
    title: String,
    /// The secondary text: the message after printf formatting.
    body: String,
}

/// Whether a GTK message dialog is this prompt's: it did not exist when the prompt started, has no
/// parent yet, and shows this prompt's title and message. A dialog that matches only by message
/// (another prompt with the same text opened meanwhile) is not ours.
fn is_this_prompt(
    existed_at_snapshot: bool,
    has_parent: bool,
    title: Option<&str>,
    body: Option<&str>,
    expected: &ShownPrompt,
) -> bool {
    !existed_at_snapshot
        && !has_parent
        && title.unwrap_or_default() == expected.title
        && body == Some(expected.body.as_str())
}

/// Custom button labels become `CString`s in rfd too (they are not formats).
fn gtk_buttons(buttons: MessageDialogButtons) -> MessageDialogButtons {
    match buttons {
        MessageDialogButtons::OkCustom(ok) => MessageDialogButtons::OkCustom(without_nul(&ok)),
        MessageDialogButtons::OkCancelCustom(ok, cancel) => {
            MessageDialogButtons::OkCancelCustom(without_nul(&ok), without_nul(&cancel))
        }
        MessageDialogButtons::YesNoCancelCustom(yes, no, cancel) => {
            MessageDialogButtons::YesNoCancelCustom(
                without_nul(&yes),
                without_nul(&no),
                without_nul(&cancel),
            )
        }
        other => other,
    }
}

/// Make this prompt's GTK message dialog transient for the document window.
///
/// tauri-plugin-dialog passes the calling window as the parent, but rfd's GTK backend builds its
/// message box with `gtk_message_dialog_new(NULL, …)` and drops it. Without WM_TRANSIENT_FOR, KWin
/// does not keep the modal box above the document: any click that raises the document window
/// (a menu, the canvas) buried "Save changes before closing?" behind it, while the palettes stayed
/// hidden for the prompt and the menus stayed blocked, so ChemDraft looked frozen with its
/// toolbars gone. The box is created after this is queued, so poll for it on GTK's main thread
/// (nested `gtk_dialog_run` loops still dispatch timeouts) and give up after five seconds.
///
/// Only this prompt's dialog is parented: one that did not exist when the prompt started, still
/// has no parent, and shows this prompt's title and message ([`is_this_prompt`]). Another
/// parentless message box that was already open (or opened by someone else meanwhile) is left
/// alone, and the poll does not stop on it.
fn parent_message_dialog<R: Runtime>(
    app: &AppHandle<R>,
    caller: Option<Window<R>>,
    shown: ShownPrompt,
) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        use gtk::prelude::{Cast, GtkWindowExt, MessageDialogExt, WidgetExt};

        // Prefer the document window: palettes are hidden while a prompt is up.
        let owner = handle
            .get_webview_window(super::MAIN_WINDOW_LABEL)
            .and_then(|main| main.gtk_window().ok())
            .filter(|main| main.is_visible())
            .or_else(|| caller.and_then(|caller| caller.gtk_window().ok()));
        let Some(owner) = owner else {
            return;
        };
        let message_dialogs = || {
            gtk::Window::list_toplevels()
                .into_iter()
                .filter_map(|widget| widget.downcast::<gtk::MessageDialog>().ok())
        };
        let earlier = message_dialogs().collect::<Vec<_>>();
        let mut attempts = 0_u32;
        let _ = gtk::glib::timeout_add_local(std::time::Duration::from_millis(25), move || {
            attempts += 1;
            let owner: &gtk::Window = owner.upcast_ref();
            let ours = message_dialogs().find(|dialog| {
                is_this_prompt(
                    earlier.contains(dialog),
                    dialog.transient_for().is_some(),
                    dialog.title().as_deref(),
                    dialog.secondary_text().as_deref(),
                    &shown,
                )
            });
            if let Some(dialog) = ours {
                dialog.set_transient_for(Some(owner));
                return gtk::glib::ControlFlow::Break;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// What a printf-family function prints for a format with no conversions but "%%".
    fn printf_output(format: &str) -> Option<String> {
        let mut out = String::new();
        let mut chars = format.chars();
        while let Some(character) = chars.next() {
            // Anything but "%%" would read a vararg rfd never passes.
            if character == '%' && chars.next() != Some('%') {
                return None;
            }
            out.push(character);
        }
        Some(out)
    }

    #[test]
    fn a_percent_in_the_message_is_a_literal_for_gtk() {
        for message in [
            "Save changes to \"100%s.chemdraft\" before closing?",
            "Yield 92% after %n %d %x %p %%",
            "%",
            "trailing %",
            "no conversions at all",
            "",
        ] {
            let text = PromptText::new(None, message);
            assert_eq!(text.shown, message);
            assert_eq!(
                printf_output(&text.format).as_deref(),
                Some(message),
                "{message}"
            );
        }
    }

    #[test]
    fn nul_characters_never_reach_cstring() {
        let text = PromptText::new(Some("Close\0 100%s"), "Save \"a\0b%s\"?\0");
        // The title goes through rfd's own "%s", so its '%' stays single.
        assert_eq!(text.title.as_deref(), Some("Close 100%s"));
        assert_eq!(text.shown, "Save \"ab%s\"?");
        assert_eq!(text.format, "Save \"ab%%s\"?");
        for text in [text.title.unwrap(), text.shown, text.format] {
            assert!(std::ffi::CString::new(text).is_ok());
        }
        assert_eq!(PromptText::new(None, "x").title, None);
    }

    #[test]
    fn only_a_new_parentless_dialog_with_this_title_and_message_is_ours() {
        let shown = ShownPrompt {
            title: "ChemDraft".into(),
            body: "Save changes to \"100%s.chemdraft\" before closing?".into(),
        };
        let ours = |existed: bool, parented: bool, title: Option<&str>, body: Option<&str>| {
            is_this_prompt(existed, parented, title, body, &shown)
        };
        let body = Some(shown.body.as_str());
        assert!(ours(false, false, Some("ChemDraft"), body));
        // Already open when the prompt started, or already parented.
        assert!(!ours(true, false, Some("ChemDraft"), body));
        assert!(!ours(false, true, Some("ChemDraft"), body));
        // Same message under another title: someone else's prompt.
        assert!(!ours(false, false, Some("Other App"), body));
        assert!(!ours(false, false, None, body));
        // Same title, other message, or no message.
        assert!(!ours(false, false, Some("ChemDraft"), Some("Save?")));
        assert!(!ours(false, false, Some("ChemDraft"), None));

        // An empty title matches a window GTK reports as untitled.
        let untitled = ShownPrompt {
            title: String::new(),
            body: "x".into(),
        };
        assert!(is_this_prompt(false, false, None, Some("x"), &untitled));
        assert!(is_this_prompt(false, false, Some(""), Some("x"), &untitled));
    }

    #[test]
    fn custom_button_labels_lose_their_nul_characters() {
        let labels = |buttons: MessageDialogButtons| match buttons {
            MessageDialogButtons::OkCustom(ok) => vec![ok],
            MessageDialogButtons::OkCancelCustom(ok, cancel) => vec![ok, cancel],
            MessageDialogButtons::YesNoCancelCustom(yes, no, cancel) => vec![yes, no, cancel],
            _ => Vec::new(),
        };
        assert_eq!(
            labels(gtk_buttons(MessageDialogButtons::OkCustom("O\0K".into()))),
            ["OK"]
        );
        assert_eq!(
            labels(gtk_buttons(MessageDialogButtons::OkCancelCustom(
                "Save 100%".into(),
                "Can\0cel".into()
            ))),
            ["Save 100%", "Cancel"]
        );
        assert_eq!(
            labels(gtk_buttons(MessageDialogButtons::YesNoCancelCustom(
                "\0Save".into(),
                "Don't Save".into(),
                "Cancel\0".into()
            ))),
            ["Save", "Don't Save", "Cancel"]
        );
        assert!(matches!(
            gtk_buttons(MessageDialogButtons::YesNo),
            MessageDialogButtons::YesNo
        ));
    }
}
