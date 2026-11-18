//! A fail-closed macOS guard, installed before webviews and application setup.
//!
//! tauri-plugin-single-instance 2.4.5's macOS implementation starts its listener asynchronously,
//! unlinks the socket before binding, and continues startup on errors. Concurrent launches can
//! therefore both enter setup. An advisory lock is the authority here; IPC is only the handoff.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::Path,
    sync::{mpsc, Arc},
    thread,
    time::{Duration, Instant},
};
use tauri::{plugin::TauriPlugin, AppHandle, Context, Manager, RunEvent, Url, Wry};

const LOCK_FILE: &str = "single-instance.lock";
const MAX_MESSAGE_BYTES: usize = 256 * 1024;
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(2);
const LAUNCH_OPEN_WINDOW: Duration = Duration::from_secs(1);

#[derive(Deserialize, Serialize)]
struct Endpoint {
    port: u16,
    token: [u8; 32],
}

#[derive(Debug, Deserialize, Serialize)]
struct Launch {
    token: [u8; 32],
    #[serde(flatten)]
    request: LaunchRequest,
}

#[derive(Debug, Default, Deserialize, Serialize)]
pub struct LaunchRequest {
    pub argv: Vec<String>,
    pub cwd: String,
    #[serde(default)]
    pub urls: Vec<Url>,
}

// Never unlink this file: replacing its inode would let a second process lock a different file.
// Closing the descriptor (including a crash/SIGKILL) releases flock without stale-lock recovery.
struct InstanceLock {
    file: File,
}

impl InstanceLock {
    fn acquire(directory: &Path) -> io::Result<Option<Self>> {
        fs::create_dir_all(directory)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(directory.join(LOCK_FILE))?;
        // SAFETY: file owns a valid descriptor; LOCK_NB never waits for another process.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Some(Self { file }));
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::WouldBlock {
            Ok(None)
        } else {
            Err(error)
        }
    }

    fn publish(&mut self) -> io::Result<(TcpListener, Endpoint)> {
        // A loopback port avoids macOS's short Unix-socket path limit for long home directories.
        // Only a process able to read the app-data lock file can authenticate a handoff.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let mut token = [0; 32];
        getrandom::fill(&mut token).map_err(|error| io::Error::other(error.to_string()))?;
        let endpoint = Endpoint {
            port: listener.local_addr()?.port(),
            token,
        };
        self.write_endpoint(&endpoint)?;
        Ok((listener, endpoint))
    }

    fn write_endpoint(&mut self, endpoint: &Endpoint) -> io::Result<()> {
        self.file.rewind()?;
        self.file.set_len(0)?;
        serde_json::to_writer(&mut self.file, endpoint)?;
        self.file.flush()
    }
}

pub fn init(
    context: Context<Wry>,
    callback: impl Fn(&AppHandle<Wry>, LaunchRequest) + Send + Sync + 'static,
) -> tauri::Result<(Context<Wry>, TauriPlugin<Wry>)> {
    // Match PathResolver::app_data_dir before building either app. The configured identifier keeps
    // stable and dev separate even for unpackaged development executables.
    let directory = dirs::data_dir()
        .ok_or(tauri::Error::UnknownPath)?
        .join(&context.config().identifier);
    let Some(mut guard) = InstanceLock::acquire(&directory)? else {
        forward_secondary(context, &directory)?;
        std::process::exit(0);
    };
    let plugin = tauri::plugin::Builder::new("single-instance")
        .setup(move |app, _| {
            let (listener, endpoint) = guard.publish()?;
            let app_handle = app.clone();
            thread::Builder::new()
                .name("single-instance".into())
                .spawn(move || {
                    let callback = Arc::new(callback);
                    for connection in listener.incoming() {
                        let result = connection.and_then(|mut stream| {
                            stream.set_read_timeout(Some(HANDOFF_TIMEOUT))?;
                            stream.set_write_timeout(Some(HANDOFF_TIMEOUT))?;
                            receive_launch(&mut stream, &endpoint.token, |launch| {
                                let app = app_handle.clone();
                                let callback = callback.clone();
                                app_handle
                                    .run_on_main_thread(move || {
                                        callback(&app, launch);
                                    })
                                    .map_err(io::Error::other)
                            })
                        });
                        if let Err(error) = result {
                            eprintln!("ChemDraft single-instance handoff failed: {error}");
                        }
                    }
                })?;
            // The descriptor stays alive through session flush and application teardown. The IPC
            // thread never owns it, so a listener failure cannot release the startup guard.
            app.manage(guard);
            Ok(())
        })
        .build();
    Ok((context, plugin))
}

fn forward_secondary(mut context: Context<Wry>, directory: &Path) -> tauri::Result<()> {
    // LaunchServices sends `open -n ... file` as application:openURLs:, independently of argv.
    // Use a windowless AppKit loop so Tao can receive it without running ChemDraft's app setup.
    context.config_mut().app.windows.clear();
    let mut app = tauri::Builder::default()
        .enable_macos_default_menu(false)
        .build(context)?;
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    let (send_urls, received_urls) = mpsc::channel();
    let exit_code = app.run_return(move |app, event| match event {
        RunEvent::Opened { urls } => {
            let _ = send_urls.send(urls);
        }
        // Tao emits Ready from applicationDidFinishLaunching. Keep pumping events for the whole
        // window because LaunchServices can deliver several Opened events for a single launch.
        RunEvent::Ready => {
            let app = app.clone();
            thread::spawn(move || {
                thread::sleep(LAUNCH_OPEN_WINDOW);
                app.exit(0);
            });
        }
        _ => {}
    });
    if exit_code != 0 {
        return Err(
            io::Error::other(format!("launch event loop exited with status {exit_code}")).into(),
        );
    }
    let launch = LaunchRequest {
        argv: std::env::args().collect(),
        cwd: std::env::current_dir()?.to_string_lossy().into_owned(),
        urls: received_urls.try_iter().flatten().collect(),
    };
    Ok(forward_launch(directory, launch)?)
}

fn read_endpoint(directory: &Path) -> io::Result<Endpoint> {
    let file = File::open(directory.join(LOCK_FILE))?;
    Ok(serde_json::from_reader(file.take(1024))?)
}

fn forward_launch(directory: &Path, launch: LaunchRequest) -> io::Result<()> {
    forward_launch_with(directory, launch, |endpoint| {
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, endpoint.port));
        let stream = TcpStream::connect_timeout(&address, HANDOFF_TIMEOUT)?;
        stream.set_read_timeout(Some(HANDOFF_TIMEOUT))?;
        stream.set_write_timeout(Some(HANDOFF_TIMEOUT))?;
        Ok(stream)
    })
}

fn forward_launch_with<S: Read + Write>(
    directory: &Path,
    launch: LaunchRequest,
    mut connect: impl FnMut(&Endpoint) -> io::Result<S>,
) -> io::Result<()> {
    // The owner may have just taken flock and not published its endpoint yet. Never start a rival
    // on a timeout or I/O failure; report the error to the forwarding process.
    let deadline = Instant::now() + HANDOFF_TIMEOUT;
    let (endpoint, mut stream) = loop {
        let connection = read_endpoint(directory)
            .and_then(|endpoint| connect(&endpoint).map(|stream| (endpoint, stream)));
        match connection {
            Ok(connection) => break connection,
            Err(error) if Instant::now() >= deadline => return Err(error),
            Err(_) => thread::sleep(Duration::from_millis(20)),
        }
    };
    let request = serde_json::to_vec(&Launch {
        token: endpoint.token,
        request: launch,
    })?;
    if request.len() > MAX_MESSAGE_BYTES {
        return Err(io::Error::other(
            "second-launch request exceeds the handoff limit",
        ));
    }
    stream.write_all(&(request.len() as u32).to_le_bytes())?;
    stream.write_all(&request)?;
    let mut acknowledgement = [0];
    stream.read_exact(&mut acknowledgement)?;
    if acknowledgement != [1] {
        return Err(io::Error::other(
            "second-launch handoff was not acknowledged",
        ));
    }
    Ok(())
}

fn receive_launch(
    stream: &mut (impl Read + Write),
    token: &[u8; 32],
    deliver: impl FnOnce(LaunchRequest) -> io::Result<()>,
) -> io::Result<()> {
    let mut size = [0; 4];
    stream.read_exact(&mut size)?;
    let size = u32::from_le_bytes(size) as usize;
    if size > MAX_MESSAGE_BYTES {
        return Err(io::Error::other(
            "second-launch message exceeds the handoff limit",
        ));
    }
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes)?;
    let launch: Launch = serde_json::from_slice(&bytes)?;
    if &launch.token != token {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "invalid handoff token",
        ));
    }
    deliver(launch.request)?;
    // Acknowledge only after the request is queued on the owner's main thread.
    stream.write_all(&[1])
}

#[cfg(test)]
mod single_instance_tests {
    use super::*;
    use std::{
        os::unix::net::UnixStream,
        path::PathBuf,
        process::Command,
        sync::atomic::{AtomicU64, Ordering},
    };

    // Anonymous sockets exercise the framed protocol in restricted test hosts without requiring
    // permission to listen on a TCP port. Production binds only IPv4 loopback.
    fn streams() -> (UnixStream, UnixStream) {
        let (client, server) = UnixStream::pair().unwrap();
        for stream in [&client, &server] {
            stream.set_read_timeout(Some(HANDOFF_TIMEOUT)).unwrap();
            stream.set_write_timeout(Some(HANDOFF_TIMEOUT)).unwrap();
        }
        (client, server)
    }

    struct Directory(PathBuf);

    impl Directory {
        fn new() -> Self {
            static SERIAL: AtomicU64 = AtomicU64::new(0);
            let directory = std::env::temp_dir().join(format!(
                "chemdraft-single-instance-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&directory).unwrap();
            Self(directory)
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn single_instance_process_probe() {
        let Some(directory) = std::env::var_os("CHEMDRAFT_SINGLE_INSTANCE_TEST_DIR") else {
            return;
        };
        let directory = PathBuf::from(directory);
        match std::env::var("CHEMDRAFT_SINGLE_INSTANCE_TEST_MODE")
            .unwrap()
            .as_str()
        {
            "contend" => assert!(InstanceLock::acquire(&directory).unwrap().is_none()),
            "hold" => {
                let _guard = InstanceLock::acquire(&directory).unwrap().unwrap();
                fs::write(directory.join("ready"), "ready").unwrap();
                loop {
                    thread::park();
                }
            }
            mode => panic!("unknown single-instance test mode: {mode}"),
        }
    }

    fn probe(directory: &Path, mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["single_instance_process_probe", "--nocapture"])
            .env("CHEMDRAFT_SINGLE_INSTANCE_TEST_DIR", directory)
            .env("CHEMDRAFT_SINGLE_INSTANCE_TEST_MODE", mode);
        command
    }

    #[test]
    fn single_instance_rejects_second_process_without_changing_shared_files() {
        let directory = Directory::new();
        let _guard = InstanceLock::acquire(&directory.0).unwrap().unwrap();
        for file in ["document-session.json", "toolbar-state.json"] {
            fs::write(directory.0.join(file), "original").unwrap();
        }
        assert!(probe(&directory.0, "contend").status().unwrap().success());
        assert!(InstanceLock::acquire(&directory.0).unwrap().is_none());
        for file in ["document-session.json", "toolbar-state.json"] {
            assert_eq!(
                fs::read_to_string(directory.0.join(file)).unwrap(),
                "original"
            );
        }
    }

    #[test]
    fn single_instance_releases_after_abrupt_process_exit() {
        let directory = Directory::new();
        let mut child = probe(&directory.0, "hold").spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !directory.0.join("ready").exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let ready = directory.0.join("ready").exists();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(ready, "lock holder did not start");
        assert!(InstanceLock::acquire(&directory.0).unwrap().is_some());
    }

    #[test]
    fn single_instance_stable_and_dev_lock_independently_and_reuse_stale_file() {
        let directory = Directory::new();
        let stable = directory.0.join("org.chemdraft.desktop");
        let dev = directory.0.join("org.chemdraft.desktop.dev");
        let stable_guard = InstanceLock::acquire(&stable).unwrap().unwrap();
        let _dev_guard = InstanceLock::acquire(&dev).unwrap().unwrap();
        fs::write(stable.join(LOCK_FILE), "stale endpoint").unwrap();
        assert!(InstanceLock::acquire(&stable).unwrap().is_none());
        assert!(InstanceLock::acquire(&dev).unwrap().is_none());
        drop(stable_guard);
        assert!(InstanceLock::acquire(&stable).unwrap().is_some());
    }

    #[test]
    fn single_instance_simultaneous_launches_choose_one_owner() {
        use std::sync::{Arc, Barrier};

        let directory = Directory::new();
        let barrier = Arc::new(Barrier::new(8));
        let launches: Vec<_> = (0..8)
            .map(|_| {
                let path = directory.0.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    let guard = InstanceLock::acquire(&path).unwrap();
                    // Nobody releases the lock until every launch has tried to acquire it.
                    barrier.wait();
                    guard.is_some()
                })
            })
            .collect();
        let owners = launches
            .into_iter()
            .map(|launch| usize::from(launch.join().unwrap()))
            .sum::<usize>();
        assert_eq!(owners, 1);
    }

    #[test]
    fn single_instance_waits_for_owner_to_publish_its_endpoint() {
        let directory = Directory::new();
        let mut guard = InstanceLock::acquire(&directory.0).unwrap().unwrap();
        let path = directory.0.clone();
        let (client, mut server) = streams();
        let client = thread::spawn(move || {
            let mut client = Some(client);
            forward_launch_with(&path, LaunchRequest::default(), |_| {
                Ok(client.take().unwrap())
            })
        });
        // The first launch can be descheduled between locking and publishing its endpoint.
        thread::sleep(Duration::from_millis(60));
        let endpoint = Endpoint {
            port: 1,
            token: [3; 32],
        };
        guard.write_endpoint(&endpoint).unwrap();
        receive_launch(&mut server, &endpoint.token, |_| Ok(())).unwrap();
        client.join().unwrap().unwrap();
    }

    #[test]
    fn single_instance_forwards_open_events_and_reports_missing_files() {
        let directory = Directory::new();
        let names = ["first file.chemdraft", "missing file.chemdraft", "β.cdx"];
        fs::write(directory.0.join(names[0]), "<CDXML/>").unwrap();
        fs::write(directory.0.join(names[2]), "VjCD0100").unwrap();
        let urls: Vec<_> = names
            .iter()
            .map(|name| Url::from_file_path(directory.0.join(name)).unwrap())
            .collect();
        // LaunchServices normally supplies only the executable in argv.
        let launch = round_trip(
            &directory.0,
            LaunchRequest {
                argv: vec!["ChemDraft".into()],
                urls: urls.clone(),
                ..Default::default()
            },
        );
        assert_eq!(launch.urls, urls);
        let mut opened = Vec::new();
        let error = crate::deliver_opened_documents(
            crate::forwarded_document_payloads(launch),
            |payloads| {
                assert_eq!(payloads.len(), 2);
                opened = payloads;
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(
            error,
            crate::open_document_payload_from_path(&directory.0.join(names[1]))
                .err()
                .expect("missing file must fail")
        );
        assert_eq!(opened[0].path, directory.0.join(names[0]).to_str().unwrap());
        assert_eq!(opened[0].contents, "<CDXML/>");
        assert_eq!(opened[1].path, directory.0.join(names[2]).to_str().unwrap());
        assert_eq!(opened[1].bytes.as_deref(), Some(b"VjCD0100".as_slice()));
    }

    #[test]
    fn single_instance_keeps_distinct_argv_files_and_accepts_activation_only() {
        let directory = Directory::new();
        let first = "first file.chemdraft";
        let second = "β.cdxml";
        for name in [first, second] {
            fs::write(directory.0.join(name), "<CDXML/>").unwrap();
        }
        let argv = vec!["ChemDraft".into(), first.into(), second.into()];
        let cwd = directory.0.to_str().unwrap().to_string();
        let launch = round_trip(
            &directory.0,
            LaunchRequest {
                argv: argv.clone(),
                cwd: cwd.clone(),
                urls: vec![Url::from_file_path(directory.0.join(first)).unwrap()],
            },
        );
        assert_eq!(launch.argv, argv);
        assert_eq!(launch.cwd, cwd);
        let opened: Vec<_> = crate::forwarded_document_payloads(launch)
            .map(|payload| payload.unwrap().display_name)
            .collect();
        assert_eq!(opened, [first, second]);

        let activation = round_trip(
            &directory.0,
            LaunchRequest {
                argv: vec!["ChemDraft".into()],
                ..Default::default()
            },
        );
        assert!(crate::forwarded_document_payloads(activation)
            .next()
            .is_none());
    }

    fn round_trip(directory: &Path, launch: LaunchRequest) -> LaunchRequest {
        let mut guard = InstanceLock::acquire(directory).unwrap().unwrap();
        let endpoint = Endpoint {
            port: 1,
            token: [4; 32],
        };
        guard.write_endpoint(&endpoint).unwrap();
        let (client, mut stream) = streams();
        let server = thread::spawn(move || {
            let mut delivered = None;
            receive_launch(&mut stream, &endpoint.token, |launch| {
                delivered = Some(launch);
                Ok(())
            })
            .unwrap();
            delivered.unwrap()
        });
        let mut client = Some(client);
        forward_launch_with(directory, launch, |_| Ok(client.take().unwrap())).unwrap();
        assert!(InstanceLock::acquire(directory).unwrap().is_none());
        server.join().unwrap()
    }

    #[test]
    fn single_instance_rejects_unauthenticated_and_oversized_messages() {
        for oversized in [false, true] {
            let (mut stream, mut server_stream) = streams();
            let server = thread::spawn(move || {
                receive_launch(&mut server_stream, &[1; 32], |_| {
                    panic!("must not deliver invalid input")
                })
                .unwrap_err()
            });
            if oversized {
                stream
                    .write_all(&((MAX_MESSAGE_BYTES + 1) as u32).to_le_bytes())
                    .unwrap();
            } else {
                let request = serde_json::to_vec(&Launch {
                    token: [2; 32],
                    request: LaunchRequest::default(),
                })
                .unwrap();
                stream
                    .write_all(&(request.len() as u32).to_le_bytes())
                    .unwrap();
                stream.write_all(&request).unwrap();
            }
            let error = server.join().unwrap();
            if !oversized {
                assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
            }
        }
    }

    #[test]
    fn single_instance_lock_errors_fail_closed() {
        let directory = Directory::new();
        fs::create_dir(directory.0.join(LOCK_FILE)).unwrap();
        assert!(InstanceLock::acquire(&directory.0).is_err());
    }
}
