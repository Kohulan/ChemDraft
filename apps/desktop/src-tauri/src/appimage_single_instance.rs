use tauri::{plugin, AppHandle, Manager, RunEvent, Runtime};
use zbus::{blocking::Connection, interface};

struct SingleInstance<R: Runtime>(AppHandle<R>);

struct Primary {
    connection: Connection,
    name: String,
}

#[interface(name = "org.SingleInstance.DBus")]
impl<R: Runtime> SingleInstance<R> {
    fn execute_callback(&mut self, argv: Vec<String>, cwd: String) {
        super::handle_second_launch(&self.0, argv, cwd);
    }
}

pub(super) fn init<R: Runtime>() -> plugin::TauriPlugin<R> {
    // Match Tauri's Linux service so an AppImage and a .deb can hand off to each other.
    plugin::Builder::new("single-instance")
        .setup(|app, _| {
            let name = format!("{}.SingleInstance", app.config().identifier);
            let path = format!("/{}", name.replace('.', "/").replace('-', "_"));
            match zbus::blocking::connection::Builder::session()?
                .name(name.as_str())?
                .replace_existing_names(false)
                .allow_name_replacements(false)
                .serve_at(path.as_str(), SingleInstance(app.clone()))?
                .build()
            {
                Ok(connection) => {
                    app.manage(Primary { connection, name });
                }
                Err(zbus::Error::NameTaken) => {
                    // Forward the paths resolved against the caller's OWD at startup. Absolute
                    // paths work even when the running instance was started in another folder.
                    // The stock D-Bus protocol uses UTF-8 and expects argv[0] before the paths.
                    let startup = app.state::<super::linux_startup::Startup>();
                    let argv: Vec<_> = std::iter::once("")
                        .chain(startup.documents.iter().filter_map(|path| path.to_str()))
                        .collect();
                    Connection::session()?.call_method(
                        Some(name.as_str()),
                        path.as_str(),
                        Some("org.SingleInstance.DBus"),
                        "ExecuteCallback",
                        &(argv, ""),
                    )?;
                    app.cleanup_before_exit();
                    std::process::exit(0);
                }
                Err(error) => return Err(error.into()),
            }
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(primary) = app.try_state::<Primary>() {
                    let _ = primary.connection.release_name(primary.name.as_str());
                }
            }
        })
        .build()
}
