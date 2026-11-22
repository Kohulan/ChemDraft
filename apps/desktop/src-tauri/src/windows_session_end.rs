//! Tao 0.35.3 delivers Exit directly from WM_ENDSESSION on its hidden event target.
//! Run the document's committed flush before passing that message down the subclass chain.

#[cfg(any(windows, test))]
use crate::{QuitHost, QuitReason};
#[cfg(any(windows, test))]
use std::{sync::mpsc, time::Duration};

#[cfg(any(windows, test))]
const HARD_LIMIT: Duration = Duration::from_secs(3);

#[cfg(any(windows, test))]
pub(super) fn watch_flush(watchdog: mpsc::Receiver<()>, remaining: Duration, host: &impl QuitHost) {
    if watchdog.recv_timeout(remaining) == Err(mpsc::RecvTimeoutError::Timeout) {
        host.force_exit(HARD_LIMIT, QuitReason::GraceExpired);
    }
}

#[cfg(not(windows))]
pub(super) fn install(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub(super) fn in_progress() -> bool {
    false
}

#[cfg(windows)]
pub(super) use windows::{in_progress, install};

#[cfg(windows)]
mod windows {
    use super::{watch_flush, HARD_LIMIT};
    use crate::{request_document_quit_flush, APP_QUITTING, QUIT};
    use std::{
        ptr::null_mut,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc,
        },
        thread,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::Threading::GetCurrentThreadId,
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                DispatchMessageW, EnumThreadWindows, GetClassNameW, PeekMessageW, PostQuitMessage,
                MSG, PM_QS_POSTMESSAGE, PM_QS_SENDMESSAGE, PM_REMOVE, WM_ENDSESSION, WM_NCDESTROY,
                WM_QUERYENDSESSION, WM_QUIT,
            },
        },
    };

    const FLUSH_BUDGET: Duration = Duration::from_secs(2);
    static ENDING: AtomicBool = AtomicBool::new(false);

    pub(crate) fn in_progress() -> bool {
        ENDING.load(Ordering::SeqCst)
    }

    unsafe extern "system" fn find_tao_event_target(hwnd: HWND, data: LPARAM) -> i32 {
        let mut class_name = [0u16; 64];
        // SAFETY: The buffer holds the number of UTF-16 code units passed to GetClassNameW.
        let len = unsafe { GetClassNameW(hwnd, class_name.as_mut_ptr(), class_name.len() as i32) };
        if class_name[..len as usize]
            .iter()
            .copied()
            .eq("Tao Thread Event Target".encode_utf16())
        {
            // SAFETY: EnumThreadWindows calls back synchronously with install's HWND slot.
            unsafe { *(data as *mut HWND) = hwnd };
            return 0;
        }
        1
    }

    pub(crate) fn install(app: &tauri::AppHandle) -> Result<(), String> {
        let mut hwnd: HWND = null_mut();
        // SAFETY: Primary setup runs on Tao's UI thread, and the slot outlives enumeration.
        unsafe {
            EnumThreadWindows(
                GetCurrentThreadId(),
                Some(find_tao_event_target),
                &mut hwnd as *mut HWND as LPARAM,
            );
        }
        if hwnd.is_null() {
            return Err("Tao's session-end window was not found".into());
        }
        let data = Box::into_raw(Box::new(app.clone()));
        // SAFETY: The target belongs to this thread. The subclass owns data until WM_NCDESTROY.
        if unsafe { SetWindowSubclass(hwnd, Some(observe), 1, data as usize) } == 0 {
            unsafe { drop(Box::from_raw(data)) };
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    unsafe extern "system" fn observe(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        data: usize,
    ) -> LRESULT {
        match message {
            // A different app can still veto the query. Leave ChemDraft editable until TRUE.
            WM_QUERYENDSESSION => return 1,
            WM_ENDSESSION if wparam != 0 => {
                if ENDING.swap(true, Ordering::SeqCst) {
                    return 0; // The outer callback will forward the committed message to Tao.
                }
                APP_QUITTING.store(true, Ordering::SeqCst);
                // SAFETY: Clone the installed handle before pumping messages that can destroy it.
                let app = unsafe { (&*(data as *const tauri::AppHandle)).clone() };
                flush(&app);
            }
            WM_NCDESTROY => {
                // SAFETY: Remove this callback before releasing the handle allocated in install.
                unsafe {
                    RemoveWindowSubclass(hwnd, Some(observe), id);
                    drop(Box::from_raw(data as *mut tauri::AppHandle));
                }
            }
            _ => {}
        }
        // SAFETY: Forward on the same thread and through the live subclass chain.
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }

    fn flush(app: &tauri::AppHandle) {
        let start = Instant::now();
        // The nested WebView2 pump can enter a native callback. Keep a hard ceiling even if
        // that callback stalls. Windows has already committed to ending this session.
        let (disarm, watchdog) = mpsc::channel::<()>();
        let watchdog_app = app.clone();
        thread::spawn(move || {
            watch_flush(
                watchdog,
                HARD_LIMIT.saturating_sub(start.elapsed()),
                &watchdog_app,
            );
        });

        // Join an existing app quit or ask the document once. Pump WebView2 and its IPC so the
        // worker can persist the renderer's snapshot and acknowledge this specific request.
        let request_id = match request_document_quit_flush(app) {
            Ok(Some(id)) => id,
            Ok(None) => return,
            Err(error) => {
                eprintln!("ChemDraft: could not request session-end flush: {error}");
                return;
            }
        };
        while !QUIT.flush_confirmed(request_id) && start.elapsed() < FLUSH_BUDGET {
            let mut message = MSG::default();
            // SAFETY: Pump this thread's posted/sent work. Hardware input is unnecessary.
            let available = unsafe {
                PeekMessageW(
                    &mut message,
                    null_mut(),
                    0,
                    0,
                    PM_REMOVE | PM_QS_POSTMESSAGE | PM_QS_SENDMESSAGE,
                )
            };
            if available == 0 {
                thread::sleep(Duration::from_millis(5));
            } else if message.message == WM_QUIT {
                // SAFETY: Preserve a quit already pending for the outer event loop.
                unsafe { PostQuitMessage(message.wParam as i32) };
                break;
            } else {
                // SAFETY: PeekMessageW initialized this message for the current thread.
                unsafe { DispatchMessageW(&message) };
            }
        }
        if !QUIT.flush_confirmed(request_id) {
            eprintln!("ChemDraft: session-end flush was not confirmed before shutdown");
        }
        drop(disarm);
    }
}
