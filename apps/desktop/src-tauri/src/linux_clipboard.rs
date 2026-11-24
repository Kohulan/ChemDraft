//! Linux clipboard through GTK, the toolkit Tauri's webview (WebKitGTK) already runs on.
//!
//! X11 and Wayland both reach the clipboard through `gtk::Clipboard`, and Linux clipboard targets
//! are MIME types already, so the payload types the editor writes (`text/plain`, `text/html`,
//! `image/png`, `image/svg+xml`, `chemical/x-cdxml`, …) go to the clipboard unchanged. Reading
//! follows the same admission order and byte budget as the macOS and Windows readers
//! (`clipboard_limits`), so a paste resolves the same way on every platform.
//!
//! Both commands run on the main thread (they are sync Tauri commands off Windows), which GTK
//! requires. `wait_for_*` spins a nested main loop there, as every GTK application's paste does.

use std::borrow::Cow;
use std::ffi::{c_char, c_void, CStr};

use gtk::gdk;
use gtk::glib::prelude::ObjectType;

use crate::clipboard_formats::{ClipboardWriteResult, ValidatedClipboardItem};
use crate::clipboard_images::{self, ClipboardImageItem, SkippedClipboardImageItem};
use crate::clipboard_limits;
use crate::{ClipboardReadPayload, ClipboardTextItem};

#[link(name = "webkit2gtk-4.1")]
unsafe extern "C" {
    fn webkit_web_view_execute_editing_command(webview: *mut c_void, command: *const c_char);
}

/// Execute a menu click as a privileged WebKit editing action on the view's current focus.
pub(crate) fn execute_editing_command<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    command: &'static CStr,
) -> Result<(), String> {
    window
        .with_webview(move |webview| {
            let webview = webview.inner();
            // SAFETY: Tauri's Linux inner view is a live WebKitWebView and this closure runs on
            // its owning thread. The command is a static, nul-terminated WebKit command name.
            unsafe {
                webkit_web_view_execute_editing_command(webview.as_ptr().cast(), command.as_ptr())
            };
        })
        .map_err(|error| error.to_string())
}

/// Extra targets other Linux applications ask for when they want plain text. ChemDraft serves all
/// of them (GTK converts on request), but reads only the ones `plain_text_request` can decode.
const PLAIN_TEXT_ALIASES: [&str; 5] = [
    "text/plain;charset=utf-8",
    "UTF8_STRING",
    "STRING",
    "TEXT",
    "COMPOUND_TEXT",
];

/// X11 bookkeeping targets; never pasteable content.
const META_TARGETS: [&str; 6] = [
    "TARGETS",
    "TIMESTAMP",
    "MULTIPLE",
    "SAVE_TARGETS",
    "DELETE",
    "INSERT_PROPERTY",
];

fn clipboard() -> gtk::Clipboard {
    gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD)
}

pub(crate) fn write_items(items: &[ValidatedClipboardItem]) -> ClipboardWriteResult {
    // `info` indexes into `payloads`; a target alias shares its item's index.
    let mut targets = Vec::new();
    let mut payloads: Vec<(bool, Vec<u8>)> = Vec::new();
    for item in items {
        let index = payloads.len() as u32;
        let plain = item.r#type == "text/plain";
        payloads.push((plain, item.data.bytes().to_vec()));
        targets.push(gtk::TargetEntry::new(
            &item.r#type,
            gtk::TargetFlags::empty(),
            index,
        ));
        if plain {
            for alias in PLAIN_TEXT_ALIASES {
                targets.push(gtk::TargetEntry::new(
                    alias,
                    gtk::TargetFlags::empty(),
                    index,
                ));
            }
        }
    }

    let owned = clipboard().set_with_data(&targets, move |_, selection, info| {
        let Some((plain, bytes)) = payloads.get(info as usize) else {
            return;
        };
        if *plain {
            // set_text converts to whatever text target (UTF8_STRING, STRING, …) was requested.
            selection.set_text(&String::from_utf8_lossy(bytes));
        } else {
            selection.set(&selection.target(), 8, bytes);
        }
    });

    let mut result = ClipboardWriteResult::new();
    for item in items {
        result.record(
            item,
            if owned {
                Ok(())
            } else {
                Err(format!(
                    "Could not write clipboard data for type {}.",
                    item.r#type
                ))
            },
        );
    }
    if owned {
        // Hand the data to the clipboard manager, so a copy survives ChemDraft quitting.
        clipboard().store();
    }
    result
}

fn read_bytes(clipboard: &gtk::Clipboard, target: &str) -> Option<Vec<u8>> {
    let data = clipboard.wait_for_contents(&gdk::Atom::intern(target))?;
    (data.length() >= 0).then(|| data.data())
}

/// Read a text target and say how its bytes are encoded. For X11 `TEXT` the owner chooses the
/// encoding and names it in the reply's type ([`text_reply_encoding`]); a reply in an encoding
/// this reader does not decode is unavailable.
fn read_text(
    clipboard: &gtk::Clipboard,
    target: &str,
    encoding: TextEncoding,
) -> Option<(Vec<u8>, TextEncoding)> {
    let data = clipboard.wait_for_contents(&gdk::Atom::intern(target))?;
    if data.length() < 0 {
        return None;
    }
    let encoding = if encoding == TextEncoding::Utf8IfValid {
        text_reply_encoding(&data.data_type().name())?
    } else {
        encoding
    };
    Some((data.data(), encoding))
}

pub(crate) fn read_payload() -> Result<ClipboardReadPayload, String> {
    let clipboard = clipboard();
    let types = clipboard
        .wait_for_targets()
        .unwrap_or_default()
        .into_iter()
        .map(|atom| atom.name().to_string())
        .filter(|name| !META_TARGETS.contains(&name.as_str()))
        .collect::<Vec<_>>();
    // Plain-text aliases collapse onto one `text/plain` entry: the resolver only knows MIME names.
    // That entry is read through the best plain-text target the owner actually advertised.
    let (types, plain) = normalize_text_types(types);
    let plain = plain.as_ref();

    let read_plan = types
        .iter()
        .map(|source| {
            let priority = clipboard_limits::text_read_priority(source);
            let priority = if clipboard_limits::previews_text_for_chemistry(source, priority) {
                let (target, encoding) = request_for_type(source, plain);
                read_text(&clipboard, &target, encoding).map_or(priority, |(bytes, encoding)| {
                    clipboard_limits::text_priority_with_preview(
                        source,
                        &text_preview(&bytes, encoding),
                    )
                })
            } else {
                priority
            };
            (source.clone(), priority)
        })
        .collect::<Vec<_>>();

    let mut budget = clipboard_limits::ClipboardReadBudget::default();
    let mut text_items: Vec<ClipboardTextItem> = Vec::new();
    let mut image_items = Vec::new();
    let mut skipped_image_items = Vec::new();
    let priorities = read_plan.iter().map(|(_, p)| *p).collect::<Vec<_>>();
    for step in clipboard_limits::clipboard_read_steps(&priorities) {
        let source = match step {
            clipboard_limits::ClipboardReadStep::Pictures => {
                (image_items, skipped_image_items) = picture_items(&clipboard, &types, &mut budget);
                continue;
            }
            clipboard_limits::ClipboardReadStep::Text(index) => &read_plan[index].0,
        };
        if crate::is_opaque_clipboard_type(source) {
            continue;
        }
        let (target, encoding) = request_for_type(source, plain);
        let Some((bytes, encoding)) = read_text(&clipboard, &target, encoding) else {
            continue;
        };
        admit_text(&mut budget, &mut text_items, source, encoding, &bytes);
    }
    text_items.sort_by_key(|item| types.iter().position(|kind| kind == &item.r#type));

    Ok(ClipboardReadPayload {
        types,
        text_items,
        image_items,
        skipped_image_items,
        skipped_items: budget.skipped_items,
    })
}

/// How the bytes of a requested text target are encoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TextEncoding {
    /// UTF-8 (`UTF8_STRING`, `text/plain;charset=utf-8`), read by the shared decoder.
    Utf8,
    /// X11 `TEXT`: the owner picks the encoding and names it in the reply's type, which the reader
    /// resolves with [`text_reply_encoding`]. Bytes that reach the decoder still unresolved are
    /// read only when they are valid UTF-8, and are otherwise unavailable.
    Utf8IfValid,
    /// UTF-16 (`text/plain;charset=utf-16`). A byte-order mark wins; without one, this order.
    Utf16 { big_endian: bool },
    /// ISO-8859-1, the X11 `STRING` target.
    Latin1,
}

impl TextEncoding {
    /// How to read these bytes, or `None` when they are not in this encoding. Never returns
    /// `Utf8IfValid`.
    fn for_bytes(self, bytes: &[u8]) -> Option<TextEncoding> {
        match self {
            TextEncoding::Utf8IfValid => {
                let end = bytes
                    .iter()
                    .position(|byte| *byte == 0)
                    .unwrap_or(bytes.len());
                std::str::from_utf8(&bytes[..end])
                    .is_ok()
                    .then_some(TextEncoding::Utf8)
            }
            other => Some(other),
        }
    }
}

/// How to read the reply to a `TEXT` request, from the type the owner gave it: `STRING` is
/// ISO-8859-1, `UTF8_STRING` is UTF-8. `COMPOUND_TEXT` (ISO 2022) and anything else are
/// unavailable.
fn text_reply_encoding(reply_type: &str) -> Option<TextEncoding> {
    match reply_type {
        "STRING" => Some(TextEncoding::Latin1),
        "UTF8_STRING" => Some(TextEncoding::Utf8),
        _ => None,
    }
}

/// The plain-text target an owner advertised, chosen for the collapsed `text/plain` entry.
#[derive(Clone, Debug, PartialEq, Eq)]
struct PlainTextTarget {
    name: String,
    encoding: TextEncoding,
}

/// Linux publishes plain text under several names; the editor only knows `text/plain`. Returns
/// the collapsed type list and the plain-text target to request, chosen from those the owner
/// advertised: an owner that offers only `text/plain;charset=utf-16` (or only `;charset=utf-8`)
/// is asked for exactly that, never for a `UTF8_STRING` it does not serve.
fn normalize_text_types(types: Vec<String>) -> (Vec<String>, Option<PlainTextTarget>) {
    let mut out = Vec::new();
    let mut plain_seen = false;
    let mut best: Option<(u8, PlainTextTarget)> = None;
    for name in types {
        // Any parameterised `text/plain` (LibreOffice also offers `;charset=utf-16`) is the same
        // text again and is read once, through the collapsed entry. Kept separate, the UTF-16
        // copy was admitted first and the UTF-8 one dropped as its duplicate, leaving a name the
        // resolver does not treat as plain text (GitHub #304, raw RTF pasted).
        let is_plain =
            plain_text_charset(&name).is_some() || PLAIN_TEXT_ALIASES.contains(&name.as_str());
        if !is_plain {
            out.push(name);
            continue;
        }
        if !plain_seen {
            plain_seen = true;
            out.push("text/plain".to_string());
        }
        if let Some((rank, encoding)) = plain_text_request(&name) {
            if best.as_ref().is_none_or(|(best_rank, _)| rank < *best_rank) {
                best = Some((rank, PlainTextTarget { name, encoding }));
            }
        }
    }
    (out, best.map(|(_, target)| target))
}

/// For a `text/plain` MIME type with any parameters (`text/plain; format=flowed;
/// charset="UTF-8"`), its charset in lower case, or `Some(None)` when it names none. `None` when
/// the name is not `text/plain` at all. Type, parameter names and charset are case-insensitive.
fn plain_text_charset(name: &str) -> Option<Option<String>> {
    let mut parts = name.split(';');
    if !parts
        .next()
        .is_some_and(|essence| essence.trim().eq_ignore_ascii_case("text/plain"))
    {
        return None;
    }
    let charset = parts.find_map(|parameter| {
        let (key, value) = parameter.split_once('=')?;
        key.trim()
            .eq_ignore_ascii_case("charset")
            .then(|| value.trim().trim_matches('"').trim().to_ascii_lowercase())
    });
    Some(charset)
}

/// Preference rank (lower is better) and encoding of a plain-text target worth requesting.
/// Explicit Unicode first, then the bare MIME name, then the legacy X11 atoms. A `text/plain`
/// with a charset this reader cannot decode is still collapsed, but never requested, and so is
/// `COMPOUND_TEXT` (ISO 2022, which this reader does not decode).
///
/// A BOM-less `charset=utf-16` is big-endian (RFC 2781 §4.3); `utf-16le` and `utf-16be` name
/// their order. A byte-order mark in the data always wins.
fn plain_text_request(name: &str) -> Option<(u8, TextEncoding)> {
    match name {
        "UTF8_STRING" => return Some((0, TextEncoding::Utf8)),
        "STRING" => return Some((5, TextEncoding::Latin1)),
        "TEXT" => return Some((6, TextEncoding::Utf8IfValid)),
        "COMPOUND_TEXT" => return None,
        _ => {}
    }
    let Some(charset) = plain_text_charset(name)? else {
        return Some((3, TextEncoding::Utf8));
    };
    match charset.as_str() {
        "utf-8" | "utf8" => Some((1, TextEncoding::Utf8)),
        "utf-16" | "utf16" | "utf-16be" => Some((2, TextEncoding::Utf16 { big_endian: true })),
        "utf-16le" => Some((2, TextEncoding::Utf16 { big_endian: false })),
        "iso-8859-1" | "latin1" | "us-ascii" | "ascii" => Some((4, TextEncoding::Latin1)),
        _ => None,
    }
}

/// The target to request for a normalized type, and how its bytes are encoded. `text/plain` asks
/// for the plain-text target the owner advertised (`UTF8_STRING` when it named none we can read).
fn request_for_type(kind: &str, plain: Option<&PlainTextTarget>) -> (String, TextEncoding) {
    if kind != "text/plain" {
        return (kind.to_string(), TextEncoding::Utf8);
    }
    plain.map_or_else(
        || ("UTF8_STRING".to_string(), TextEncoding::Utf8),
        |target| (target.name.clone(), target.encoding),
    )
}

/// UTF-16 code units up to the first NUL, honouring a byte-order mark.
fn utf16_units(bytes: &[u8], big_endian: bool) -> impl Iterator<Item = u16> + '_ {
    let (content, big_endian) = if let Some(content) = bytes.strip_prefix(&[0xfe, 0xff]) {
        (content, true)
    } else if let Some(content) = bytes.strip_prefix(&[0xff, 0xfe]) {
        (content, false)
    } else {
        (bytes, big_endian)
    };
    content
        .chunks_exact(2)
        .map(move |pair| {
            if big_endian {
                u16::from_be_bytes([pair[0], pair[1]])
            } else {
                u16::from_le_bytes([pair[0], pair[1]])
            }
        })
        .take_while(|unit| *unit != 0)
}

/// The characters of a non-UTF-8 target, up to its terminator; unpaired surrogates become U+FFFD.
fn transcoded_chars(bytes: &[u8], encoding: TextEncoding) -> Box<dyn Iterator<Item = char> + '_> {
    match encoding {
        TextEncoding::Utf16 { big_endian } => Box::new(
            char::decode_utf16(utf16_units(bytes, big_endian))
                .map(|character| character.unwrap_or(char::REPLACEMENT_CHARACTER)),
        ),
        TextEncoding::Latin1 | TextEncoding::Utf8 | TextEncoding::Utf8IfValid => Box::new(
            bytes
                .iter()
                .take_while(|byte| **byte != 0)
                .map(|byte| char::from(*byte)),
        ),
    }
}

/// Decode a text target's bytes as the encoding its name declares.
fn decode_text(bytes: &[u8], encoding: TextEncoding) -> Option<String> {
    let encoding = encoding.for_bytes(bytes)?;
    if encoding == TextEncoding::Utf8 {
        return crate::decode_clipboard_text_bytes(bytes);
    }
    let text = transcoded_chars(bytes, encoding).collect::<String>();
    (!text.is_empty()).then_some(text)
}

/// At most 8 KiB of a target's text as UTF-8, for the chemistry sniff.
fn text_preview(bytes: &[u8], encoding: TextEncoding) -> Cow<'_, [u8]> {
    const PREVIEW: usize = 8192;
    let Some(encoding) = encoding.for_bytes(bytes) else {
        return Cow::Borrowed(&bytes[..0]);
    };
    if encoding == TextEncoding::Utf8 {
        return Cow::Borrowed(&bytes[..bytes.len().min(PREVIEW)]);
    }
    let mut text =
        decode_text(&bytes[..bytes.len().min(2 * PREVIEW)], encoding).unwrap_or_default();
    let mut end = text.len().min(PREVIEW);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    Cow::Owned(text.into_bytes())
}

/// Whether a flavor's payload is markup, not the text a person copied. Mirrors the clipboard
/// adapter's `isMarkupType` (packages/clipboard-adapter), which never pastes such a flavor as
/// text: `html`, `rtf`, `richtext`, `text/enriched`, and a web archive (`/web[\s-]?archive/`:
/// `webarchive`, `web-archive`, `web archive`).
fn is_markup_type(kind: &str) -> bool {
    let lower = kind.trim().to_lowercase();
    let web_archive = lower.match_indices("web").any(|(at, web)| {
        let rest = &lower[at + web.len()..];
        rest.strip_prefix(|character: char| character.is_whitespace() || character == '-')
            .unwrap_or(rest)
            .starts_with("archive")
    });
    lower.contains("html")
        || lower.contains("rtf")
        || lower.contains("richtext")
        || lower == "text/enriched"
        || web_archive
}

/// Whether a flavor refused for size may be reported as chemistry, given the head of its text: an
/// advertised chemistry type, or a generic text flavor the readers preview for chemistry. Of the
/// markup flavors only `text/richtext` is previewed (a molfile is sometimes published under that
/// name), and it counts only when its text actually starts as a structure file
/// ([`head_is_structure_file`]), never for a mention of one. HTML, RTF, `text/enriched` and web
/// archives never do: an oversized HTML document that quotes a molfile must not block the paste of
/// its admitted plain-text sibling.
fn refused_flavor_may_be_chemistry(kind: &str, head: &[u8]) -> bool {
    if clipboard_limits::is_chemistry_type(kind) {
        return true;
    }
    if !clipboard_limits::previews_text_for_chemistry(
        kind,
        clipboard_limits::text_read_priority(kind),
    ) {
        return false;
    }
    if !is_markup_type(kind) {
        return true;
    }
    kind.to_ascii_lowercase().contains("richtext") && head_is_structure_file(head)
}

/// Whether text begins as a structure file: a molfile (its fourth line, the counts line, ends in
/// `V2000` or `V3000`) or a CDXML document (its root element, after any XML declaration, is
/// `CDXML`).
fn head_is_structure_file(head: &[u8]) -> bool {
    let text = String::from_utf8_lossy(head);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&*text);
    let molfile = text.lines().nth(3).is_some_and(|counts| {
        let counts = counts.trim_end();
        counts.ends_with("V2000") || counts.ends_with("V3000")
    });
    molfile || cdxml_root(text)
}

/// Whether the first element of an XML document, past its declaration, doctype and comments, is
/// `<CDXML`.
fn cdxml_root(text: &str) -> bool {
    let mut rest = text.trim_start();
    loop {
        let skip_to = if rest.starts_with("<?") {
            "?>"
        } else if rest.starts_with("<!--") {
            "-->"
        } else if rest.starts_with("<!") {
            ">"
        } else {
            break;
        };
        let Some(end) = rest.find(skip_to) else {
            return false;
        };
        rest = rest[end + skip_to.len()..].trim_start();
    }
    rest.strip_prefix("<CDXML")
        .and_then(|after| after.chars().next())
        .is_some_and(|next| next == '>' || next == '/' || next.is_whitespace())
}

/// The admitted item these bytes repeat, compared in place before anything is charged.
fn admitted_alias(
    bytes: &[u8],
    encoding: TextEncoding,
    admitted: &[ClipboardTextItem],
) -> Option<usize> {
    admitted.iter().position(|item| match encoding {
        TextEncoding::Utf8 | TextEncoding::Utf8IfValid => {
            clipboard_limits::is_admitted_text_alias(bytes, std::slice::from_ref(item))
        }
        TextEncoding::Utf16 { .. } | TextEncoding::Latin1 => {
            transcoded_chars(bytes, encoding).eq(item.text.chars())
        }
    })
}

/// Admit one text flavor under the shared budget, as the macOS and Windows readers do.
///
/// A byte-identical repeat of an admitted flavor is dropped, except that plain text displaces a
/// markup flavor it repeats: the adapter never pastes markup as text, so keeping `text/enriched`
/// over the same plain text left nothing to paste. A refused flavor is marked as chemistry before
/// it is given up, so the paste reports a structure that was too large instead of falling through
/// to prose, but only when the flavor can carry chemistry ([`refused_flavor_may_be_chemistry`]).
/// Bytes that are not in the target's encoding (`TEXT` that is not UTF-8) are unavailable.
fn admit_text(
    budget: &mut clipboard_limits::ClipboardReadBudget,
    text_items: &mut Vec<ClipboardTextItem>,
    source: &str,
    encoding: TextEncoding,
    bytes: &[u8],
) {
    let Some(encoding) = encoding.for_bytes(bytes) else {
        return;
    };
    if let Some(index) = admitted_alias(bytes, encoding, text_items) {
        let admitted = &mut text_items[index];
        if source == "text/plain" && is_markup_type(&admitted.r#type) {
            admitted.r#type = source.to_string();
        }
        return;
    }
    let reservation = match encoding {
        TextEncoding::Utf8 | TextEncoding::Utf8IfValid => {
            budget.reserve(source, bytes.len()).map(|()| bytes.len())
        }
        TextEncoding::Utf16 { .. } | TextEncoding::Latin1 => {
            let decoded = transcoded_chars(bytes, encoding).map(char::len_utf8).sum();
            budget.reserve_utf16_allocation(source, bytes.len(), decoded)
        }
    };
    let Ok(reserved) = reservation else {
        let preview = text_preview(bytes, encoding);
        if refused_flavor_may_be_chemistry(source, &preview) {
            budget.mark_chemistry(source, &preview);
        }
        return;
    };
    let Some(text) = decode_text(bytes, encoding) else {
        budget.release(reserved);
        return;
    };
    if encoding != TextEncoding::Utf8 {
        // Replace the native-size reservation with the retained UTF-8 text.
        budget.release(reserved);
        if budget.reserve(source, text.len()).is_err() {
            if refused_flavor_may_be_chemistry(source, text.as_bytes()) {
                budget.mark_chemistry(source, text.as_bytes());
            }
            return;
        }
    }
    text_items.push(ClipboardTextItem {
        r#type: source.to_string(),
        text,
    });
}

fn picture_items(
    clipboard: &gtk::Clipboard,
    types: &[String],
    budget: &mut clipboard_limits::ClipboardReadBudget,
) -> (Vec<ClipboardImageItem>, Vec<SkippedClipboardImageItem>) {
    let mut image_items = Vec::new();
    let mut skipped = Vec::new();
    for (sources, output_type) in [
        (&["image/png", "image/tiff"][..], "image/png"),
        (&["image/svg+xml"][..], "image/svg+xml"),
    ] {
        if !image_items.is_empty() {
            break;
        }
        for &source in sources {
            if !types.iter().any(|kind| kind == source) {
                continue;
            }
            let Some(bytes) = read_bytes(clipboard, source) else {
                skipped.push(SkippedClipboardImageItem::new(
                    output_type,
                    0,
                    format!("Could not read {source} clipboard data"),
                ));
                continue;
            };
            let svg = output_type == "image/svg+xml";
            let admission = if svg {
                budget.reserve_svg_allocation(source, bytes.len())
            } else {
                budget.reserve(source, bytes.len())
            };
            let result = admission.and_then(|()| {
                let item = match source {
                    "image/png" => clipboard_images::png_image_item(&bytes),
                    "image/tiff" => clipboard_images::tiff_image_item(&bytes),
                    _ => clipboard_images::svg_image_item(&bytes, source),
                };
                if svg {
                    budget.release(bytes.len());
                }
                let item = item?;
                if svg {
                    budget.reserve(source, item.retained_byte_length())?;
                }
                Ok(item)
            });
            match result {
                Ok(item) => {
                    image_items.push(item);
                    break;
                }
                Err(reason) => {
                    if !svg && !budget.skipped_items.iter().any(|s| s.r#type == source) {
                        budget.release(bytes.len());
                    }
                    skipped.push(SkippedClipboardImageItem::new(
                        output_type,
                        bytes.len(),
                        reason,
                    ));
                }
            }
        }
    }
    (image_items, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16le(text: &str, bom: bool) -> Vec<u8> {
        let mut bytes = if bom { vec![0xff, 0xfe] } else { Vec::new() };
        bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        bytes
    }

    fn plain_item(kind: &str, text: &str) -> ClipboardTextItem {
        ClipboardTextItem {
            r#type: kind.to_string(),
            text: text.to_string(),
        }
    }

    fn exhausted_budget() -> clipboard_limits::ClipboardReadBudget {
        let mut budget = clipboard_limits::ClipboardReadBudget::default();
        let mut left = clipboard_limits::MAX_CLIPBOARD_BYTES;
        while left > 0 {
            let chunk = left.min(clipboard_limits::MAX_CLIPBOARD_TEXT_BYTES);
            budget.reserve("sibling", chunk).unwrap();
            left -= chunk;
        }
        budget
    }

    #[test]
    fn plain_text_aliases_collapse_to_one_mime_type() {
        let (types, plain) = normalize_text_types(vec![
            "UTF8_STRING".into(),
            "chemical/x-cdxml".into(),
            "text/plain;charset=utf-8".into(),
            "STRING".into(),
            "text/html".into(),
        ]);
        assert_eq!(types, ["text/plain", "chemical/x-cdxml", "text/html"]);
        assert_eq!(plain.unwrap().name, "UTF8_STRING");
    }

    #[test]
    fn parameterised_plain_text_collapses_too() {
        // The target list LibreOffice Writer offers for a text selection.
        let (types, plain) = normalize_text_types(vec![
            "text/rtf".into(),
            "text/richtext".into(),
            "text/html".into(),
            "text/plain;charset=utf-16".into(),
            "text/plain;charset=utf-8".into(),
            "text/plain".into(),
            "UTF8_STRING".into(),
            "Text/Plain; charset=UTF-8".into(),
        ]);
        assert_eq!(
            types,
            ["text/rtf", "text/richtext", "text/html", "text/plain"]
        );
        assert_eq!(
            plain,
            Some(PlainTextTarget {
                name: "UTF8_STRING".into(),
                encoding: TextEncoding::Utf8,
            })
        );
    }

    #[test]
    fn plain_text_is_requested_through_the_target_the_owner_advertised() {
        // An owner that serves only UTF-8 under the MIME name.
        let (types, plain) =
            normalize_text_types(vec!["text/html".into(), "text/plain;charset=utf-8".into()]);
        assert_eq!(types, ["text/html", "text/plain"]);
        assert_eq!(
            request_for_type("text/plain", plain.as_ref()),
            ("text/plain;charset=utf-8".to_string(), TextEncoding::Utf8)
        );

        // An owner that serves only UTF-16.
        let (types, plain) = normalize_text_types(vec!["text/plain;charset=utf-16".into()]);
        assert_eq!(types, ["text/plain"]);
        assert_eq!(
            request_for_type("text/plain", plain.as_ref()),
            (
                "text/plain;charset=utf-16".to_string(),
                TextEncoding::Utf16 { big_endian: true }
            )
        );

        // Explicit Unicode beats the bare name and the legacy atoms, in any order.
        let (_, plain) = normalize_text_types(vec![
            "STRING".into(),
            "text/plain".into(),
            "text/plain; charset=UTF-16".into(),
        ]);
        assert_eq!(plain.unwrap().name, "text/plain; charset=UTF-16");
        let (_, plain) = normalize_text_types(vec!["STRING".into(), "text/plain".into()]);
        assert_eq!(plain.unwrap().name, "text/plain");
        let (_, plain) = normalize_text_types(vec!["COMPOUND_TEXT".into(), "STRING".into()]);
        assert_eq!(
            plain,
            Some(PlainTextTarget {
                name: "STRING".into(),
                encoding: TextEncoding::Latin1,
            })
        );

        // A charset this reader cannot decode collapses, but is never requested.
        let (types, plain) = normalize_text_types(vec!["text/plain;charset=shift_jis".into()]);
        assert_eq!(types, ["text/plain"]);
        assert_eq!(plain, None);
        assert_eq!(
            request_for_type("text/plain", None),
            ("UTF8_STRING".to_string(), TextEncoding::Utf8)
        );
        assert_eq!(
            request_for_type("chemical/x-cdxml", plain.as_ref()),
            ("chemical/x-cdxml".to_string(), TextEncoding::Utf8)
        );
    }

    #[test]
    fn utf8_only_owner_pastes_its_text() {
        let mut budget = clipboard_limits::ClipboardReadBudget::default();
        let mut items = Vec::new();
        admit_text(
            &mut budget,
            &mut items,
            "text/plain",
            TextEncoding::Utf8,
            "Yield 92% → 2 h".as_bytes(),
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].r#type, "text/plain");
        assert_eq!(items[0].text, "Yield 92% → 2 h");
    }

    #[test]
    fn utf16_only_owner_pastes_its_text() {
        let utf16 = TextEncoding::Utf16 { big_endian: false };
        // Without a byte-order mark, with one, with a NUL terminator, and big-endian with a BOM;
        // CJK text has no NUL bytes for a heuristic to find, so only the declared encoding reads it.
        let mut terminated = utf16le("Yield 92% after 2 h", false);
        terminated.extend([0, 0]);
        let mut big_endian = vec![0xfe, 0xff];
        big_endian.extend(
            "Yield 92% after 2 h"
                .encode_utf16()
                .flat_map(u16::to_be_bytes),
        );
        for (bytes, expected) in [
            (utf16le("Yield 92% after 2 h", false), "Yield 92% after 2 h"),
            (utf16le("Yield 92% after 2 h", true), "Yield 92% after 2 h"),
            (terminated, "Yield 92% after 2 h"),
            (big_endian, "Yield 92% after 2 h"),
            (utf16le("収率 92%", false), "収率 92%"),
            (utf16le("𝛼-pinene", false), "𝛼-pinene"),
        ] {
            let mut budget = clipboard_limits::ClipboardReadBudget::default();
            let mut items = Vec::new();
            admit_text(&mut budget, &mut items, "text/plain", utf16, &bytes);
            assert_eq!(items.len(), 1, "{expected}");
            assert_eq!(items[0].text, expected);
            assert!(budget.skipped_items.is_empty());
        }
        assert_eq!(
            decode_text(&utf16le("A", false)[..1], utf16),
            None,
            "a lone byte is no text"
        );
        assert_eq!(
            decode_text(b"caf\xe9", TextEncoding::Latin1).as_deref(),
            Some("café")
        );
    }

    #[test]
    fn plain_text_displaces_markup_it_repeats() {
        // An owner offering text/enriched before byte-identical plain text at the same priority:
        // the enriched copy is admitted first, and the adapter never pastes markup as text.
        let mut budget = clipboard_limits::ClipboardReadBudget::default();
        let mut items = Vec::new();
        admit_text(
            &mut budget,
            &mut items,
            "text/enriched",
            TextEncoding::Utf8,
            b"Yield 92%",
        );
        admit_text(
            &mut budget,
            &mut items,
            "text/plain",
            TextEncoding::Utf8,
            b"Yield 92%",
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].r#type, "text/plain");
        assert_eq!(items[0].text, "Yield 92%");

        // The same through a UTF-16 plain target, and with RTF.
        let mut items = vec![plain_item("text/rtf", "Yield 92%")];
        admit_text(
            &mut budget,
            &mut items,
            "text/plain",
            TextEncoding::Utf16 { big_endian: false },
            &utf16le("Yield 92%", true),
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].r#type, "text/plain");

        // Plain text admitted first keeps its place; the markup repeat is dropped.
        let mut items = vec![plain_item("text/plain", "Yield 92%")];
        admit_text(
            &mut budget,
            &mut items,
            "text/enriched",
            TextEncoding::Utf8,
            b"Yield 92%",
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].r#type, "text/plain");

        // A repeat of a flavor that is not markup changes nothing.
        let mut items = vec![plain_item("chemical/x-daylight-smiles", "CCO")];
        admit_text(
            &mut budget,
            &mut items,
            "text/plain",
            TextEncoding::Utf8,
            b"CCO",
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].r#type, "chemical/x-daylight-smiles");
    }

    #[test]
    fn refused_chemistry_is_marked_before_the_reader_gives_up() {
        for (encoding, bytes) in [
            (TextEncoding::Utf8, b"CCO".to_vec()),
            (
                TextEncoding::Utf16 { big_endian: false },
                utf16le("CCO", false),
            ),
            (TextEncoding::Utf8, b"<CDXML><page/></CDXML>".to_vec()),
        ] {
            let mut budget = exhausted_budget();
            let mut items = Vec::new();
            admit_text(&mut budget, &mut items, "text/plain", encoding, &bytes);
            assert!(items.is_empty());
            let skipped = budget
                .skipped_items
                .last()
                .expect("refused flavor is reported");
            assert_eq!(skipped.r#type, "text/plain");
            assert!(skipped.chemistry, "{encoding:?}");
        }

        // Prose refused for size is reported, but not as chemistry.
        let mut budget = exhausted_budget();
        admit_text(
            &mut budget,
            &mut Vec::new(),
            "text/plain",
            TextEncoding::Utf8,
            b"Yield after two hours",
        );
        assert!(!budget.skipped_items.last().unwrap().chemistry);
    }

    #[test]
    fn plain_text_with_extra_mime_parameters_is_recognised() {
        for (name, expected) in [
            ("text/plain;charset=utf-8;format=flowed", TextEncoding::Utf8),
            (
                "text/plain; format=flowed; CharSet=\"UTF-8\"",
                TextEncoding::Utf8,
            ),
            ("TEXT/PLAIN ; charset = utf8", TextEncoding::Utf8),
            (
                "text/plain;format=flowed;charset=utf-16le",
                TextEncoding::Utf16 { big_endian: false },
            ),
            ("text/plain;format=flowed", TextEncoding::Utf8),
        ] {
            let (types, plain) = normalize_text_types(vec!["text/html".into(), name.into()]);
            assert_eq!(types, ["text/html", "text/plain"], "{name}");
            assert_eq!(
                request_for_type("text/plain", plain.as_ref()),
                (name.to_string(), expected),
                "{name}"
            );
        }
        // An explicit charset beats the bare name even with other parameters around it.
        let (_, plain) = normalize_text_types(vec![
            "text/plain;format=flowed".into(),
            "text/plain;format=flowed;charset=utf-8".into(),
        ]);
        assert_eq!(
            plain.unwrap().name,
            "text/plain;format=flowed;charset=utf-8"
        );
        // Not plain text at all.
        assert_eq!(plain_text_charset("text/plainx;charset=utf-8"), None);
        assert_eq!(plain_text_charset("text/html;charset=utf-8"), None);
        let (types, plain) = normalize_text_types(vec!["text/plainx".into()]);
        assert_eq!(types, ["text/plainx"]);
        assert_eq!(plain, None);
    }

    #[test]
    fn utf16_without_a_bom_is_big_endian_unless_the_charset_says_otherwise() {
        let be = |text: &str, bom: bool| {
            let mut bytes = if bom { vec![0xfe, 0xff] } else { Vec::new() };
            bytes.extend(text.encode_utf16().flat_map(u16::to_be_bytes));
            bytes
        };
        let encoding = |name: &str| plain_text_request(name).unwrap().1;
        let utf16 = encoding("text/plain;charset=utf-16");
        let little_endian = encoding("text/plain;charset=UTF-16LE");
        let utf16be = encoding("text/plain;charset=utf-16be");
        assert_eq!(utf16, TextEncoding::Utf16 { big_endian: true });
        assert_eq!(little_endian, TextEncoding::Utf16 { big_endian: false });
        assert_eq!(utf16be, TextEncoding::Utf16 { big_endian: true });

        let text = "Yield 92% → 収率";
        // RFC 2781: BOM-less "UTF-16" is big-endian.
        assert_eq!(decode_text(&be(text, false), utf16).as_deref(), Some(text));
        assert_eq!(
            decode_text(&be(text, false), utf16be).as_deref(),
            Some(text)
        );
        assert_eq!(
            decode_text(&utf16le(text, false), little_endian).as_deref(),
            Some(text)
        );
        // A byte-order mark always wins over the declared order.
        assert_eq!(
            decode_text(&utf16le(text, true), utf16).as_deref(),
            Some(text)
        );
        assert_eq!(
            decode_text(&utf16le(text, true), utf16be).as_deref(),
            Some(text)
        );
        assert_eq!(
            decode_text(&be(text, true), little_endian).as_deref(),
            Some(text)
        );

        let mut budget = clipboard_limits::ClipboardReadBudget::default();
        let mut items = Vec::new();
        admit_text(
            &mut budget,
            &mut items,
            "text/plain",
            utf16,
            &be(text, false),
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, text);
    }

    #[test]
    fn text_is_read_only_as_utf8_and_compound_text_never() {
        assert_eq!(plain_text_request("COMPOUND_TEXT"), None);
        assert_eq!(
            plain_text_request("TEXT"),
            Some((6, TextEncoding::Utf8IfValid))
        );
        // Collapsed into text/plain, but never requested.
        let (types, plain) = normalize_text_types(vec!["COMPOUND_TEXT".into()]);
        assert_eq!(types, ["text/plain"]);
        assert_eq!(plain, None);
        let (_, plain) = normalize_text_types(vec!["COMPOUND_TEXT".into(), "TEXT".into()]);
        assert_eq!(plain.unwrap().name, "TEXT");

        // TEXT that is UTF-8 pastes.
        let mut budget = clipboard_limits::ClipboardReadBudget::default();
        let mut items = Vec::new();
        admit_text(
            &mut budget,
            &mut items,
            "text/plain",
            TextEncoding::Utf8IfValid,
            "Yield 92% → 2 h\0".as_bytes(),
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "Yield 92% → 2 h");

        // TEXT in any other encoding (Latin-1, compound text) is unavailable: nothing admitted,
        // nothing reported, no preview for the chemistry sniff.
        for bytes in [&b"caf\xe9"[..], &b"\x1b%G\xff\xfe"[..]] {
            let mut budget = clipboard_limits::ClipboardReadBudget::default();
            let mut items = Vec::new();
            admit_text(
                &mut budget,
                &mut items,
                "text/plain",
                TextEncoding::Utf8IfValid,
                bytes,
            );
            assert!(items.is_empty());
            assert!(budget.skipped_items.is_empty());
            assert_eq!(decode_text(bytes, TextEncoding::Utf8IfValid), None);
            assert!(text_preview(bytes, TextEncoding::Utf8IfValid).is_empty());
        }
    }

    #[test]
    fn refused_markup_is_never_reported_as_chemistry() {
        let molfile = b"\n  ChemDraft\n\n  1  0  0  0  0  0            999 V2000\n";
        for kind in [
            "text/html",
            "text/rtf",
            "text/enriched",
            "application/x-web-archive",
        ] {
            let mut budget = exhausted_budget();
            admit_text(
                &mut budget,
                &mut Vec::new(),
                kind,
                TextEncoding::Utf8,
                molfile,
            );
            let skipped = budget
                .skipped_items
                .last()
                .expect("refused flavor is reported");
            assert_eq!(skipped.r#type, kind);
            assert!(!skipped.chemistry, "{kind}");
        }
        // Flavors that can carry chemistry still are.
        for kind in ["text/plain", "chemical/x-mdl-molfile"] {
            let mut budget = exhausted_budget();
            admit_text(
                &mut budget,
                &mut Vec::new(),
                kind,
                TextEncoding::Utf8,
                molfile,
            );
            assert!(budget.skipped_items.last().unwrap().chemistry, "{kind}");
        }
    }

    #[test]
    fn refused_richtext_is_chemistry_only_when_it_is_a_structure_file() {
        let refused_as_chemistry = |bytes: &[u8]| {
            let mut budget = exhausted_budget();
            admit_text(
                &mut budget,
                &mut Vec::new(),
                "text/richtext",
                TextEncoding::Utf8,
                bytes,
            );
            let skipped = budget
                .skipped_items
                .last()
                .expect("refused flavor is reported");
            assert_eq!(skipped.r#type, "text/richtext");
            skipped.chemistry
        };
        // A molfile (V2000 and V3000) or a CDXML document carried as text/richtext.
        assert!(refused_as_chemistry(
            b"\n  ChemDraft\n\n  1  0  0  0  0  0            999 V2000\n"
        ));
        assert!(refused_as_chemistry(
            b"\r\n  ChemDraft\r\n\r\n  0  0  0     0  0            999 V3000\r\n"
        ));
        assert!(refused_as_chemistry(
            b"<?xml version=\"1.0\"?>\n<!DOCTYPE CDXML SYSTEM \"cdxml.dtd\">\n<CDXML><page/></CDXML>"
        ));
        // Rich text that only mentions a format, or looks like SMILES, is prose.
        assert!(!refused_as_chemistry(
            b"<bold>Note</bold> the V2000 counts line and the <CDXML> root."
        ));
        assert!(!refused_as_chemistry(b"CCO"));

        assert!(head_is_structure_file(
            b"\xef\xbb\xbf<CDXML\n  Version=\"1\">"
        ));
        assert!(head_is_structure_file(b"<!-- saved -->\n<CDXML/>"));
        assert!(!head_is_structure_file(b"<CDXMLish/>"));
        assert!(!head_is_structure_file(b"<?xml version=\"1.0\"?><html/>"));
        assert!(!head_is_structure_file(b"V2000\n\n\n"));
    }

    #[test]
    fn a_text_reply_is_decoded_by_the_type_the_owner_gave_it() {
        let decode = |reply_type: &str, bytes: &[u8]| {
            text_reply_encoding(reply_type).and_then(|encoding| decode_text(bytes, encoding))
        };
        assert_eq!(decode("STRING", b"caf\xe9").as_deref(), Some("café"));
        assert_eq!(
            decode("UTF8_STRING", "café → 収率".as_bytes()).as_deref(),
            Some("café → 収率")
        );
        assert_eq!(decode("COMPOUND_TEXT", b"caf\xe9"), None);
        assert_eq!(decode("COMPOUND_TEXT", b"plain ascii"), None);
        assert_eq!(decode("TEXT", b"plain ascii"), None);
    }

    #[test]
    fn markup_types_match_the_clipboard_adapter() {
        // The same cases as the isMarkupType test in packages/clipboard-adapter/src/index.test.ts.
        for kind in [
            "text/html",
            "public.html",
            "text/rtf",
            "public.rtf",
            "text/richtext",
            "text/enriched",
            "com.apple.webarchive",
            "application/x-webarchive",
            "application/x-web-archive",
            "Apple Web Archive pasteboard type",
            "  TEXT/HTML  ",
        ] {
            assert!(is_markup_type(kind), "{kind}");
        }
        for kind in [
            "text/plain",
            "chemical/x-mdl-molfile",
            "application/x-web",
            "web/archived-not",
            "image/svg+xml",
        ] {
            assert!(!is_markup_type(kind), "{kind}");
        }
    }

    #[test]
    fn previews_are_bounded_utf8() {
        let long = "é".repeat(10_000);
        let preview = text_preview(
            &utf16le(&long, true),
            TextEncoding::Utf16 { big_endian: false },
        );
        assert!(preview.len() <= 8192);
        assert!(std::str::from_utf8(&preview).is_ok());
        assert_eq!(text_preview(&[b'C'; 9000], TextEncoding::Utf8).len(), 8192);
    }
}
