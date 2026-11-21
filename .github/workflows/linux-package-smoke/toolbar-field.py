#!/usr/bin/env python3
"""Type into a floating toolbar's number field in a Wayland session, then check the result.

The Linux container smoke (.github/workflows/linux-container-smoke.yml) runs this as its
unprivileged user under dbus-run-session, in the Wayland jobs where ChemDraft uses XWayland.
That is the default for both packages: the AppImage's GTK hook exports GDK_BACKEND=x11, and
the .deb picks it itself when WAYLAND_DISPLAY is set. The check:

1. starts headless Weston with XWayland, then the package with no GDK_BACKEND of its own;
2. pastes propane and records the document's chemistry (Copy As SMILES and the native
   selection JSON);
3. opens Drawn Structure Settings from View > Toolbars over AT-SPI;
4. clicks into one of its number fields with a real XTEST click and types "30";
5. requires the field's value to change and the document's chemistry not to.

Native Wayland (CHEMDRAFT_NATIVE_WAYLAND=1) is not covered. Weston offers no protocol that lets
one client type into another client's window, and xdotool reaches X11 windows only.

Usage: toolbar-field.py <bundle> <appimage|deb> <log directory>
"""

import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

SOCKET = "chemdraft-field-smoke"
TEXT = "UTF8_STRING"
SELECTION = "application/x-chemdraft-selection+json"
SETTINGS_TITLE = "ChemDraft Drawn Structure Settings"
# Chain angle only sets the angle of chains drawn later, so committing it cannot move atoms.
PREFERRED_FIELD = "Chain angle"
TYPED = "30"


class SmokeFailure(Exception):
    pass


# AT-SPI calls raise GLib.Error while a window or webview is still registering.
RETRY = (SmokeFailure,)


def wait_for(check, description, seconds=20.0, interval=0.5):
    deadline = time.monotonic() + seconds
    while True:
        try:
            return check()
        except RETRY as error:
            if time.monotonic() >= deadline:
                raise SmokeFailure(f"{description} ({error})") from error
            time.sleep(interval)


def run(*command, timeout=5, check=True):
    return subprocess.run(command, capture_output=True, timeout=timeout, check=check)


def keys(*shortcuts):
    run("xdotool", "key", "--clearmodifiers", "--delay", "100", *shortcuts)


def xclip(target):
    return ["xclip", "-selection", "clipboard", "-target", target]


def read_clipboard(target):
    try:
        result = subprocess.run([*xclip(target), "-out"], capture_output=True, timeout=2)
    except subprocess.TimeoutExpired as error:
        raise SmokeFailure(f"xclip timed out reading {target}") from error
    if result.returncode:
        message = result.stderr.decode(errors="replace").strip()
        raise SmokeFailure(f"xclip could not read {target}: {message}")
    return result.stdout


class Session:
    """Weston, its XWayland display and the package, all torn down together."""

    def __init__(self, bundle, package, logs):
        self.bundle = bundle
        self.package = package
        self.logs = logs
        self.work = Path(tempfile.mkdtemp(prefix="chemdraft-field-"))
        self.weston = None
        self.app = None
        self.main_pid = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        if self.app is not None and self.app.poll() is None:
            try:
                os.killpg(self.app.pid, signal.SIGTERM)
                self.app.wait(timeout=5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.app.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if self.weston is not None and self.weston.poll() is None:
            self.weston.terminate()
            try:
                self.weston.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.weston.kill()
        shutil.rmtree(self.work, ignore_errors=True)

    def start_display(self):
        runtime = self.work / "runtime"
        runtime.mkdir(mode=0o700)
        for name in ("DISPLAY", "WAYLAND_DISPLAY", "GDK_BACKEND", "CHEMDRAFT_NATIVE_WAYLAND",
                     "WEBKIT_DISABLE_DMABUF_RENDERER", "NO_AT_BRIDGE", "AT_SPI_BUS_ADDRESS"):
            os.environ.pop(name, None)
        os.environ["XDG_RUNTIME_DIR"] = str(runtime)
        for name, folder in (("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"),
                             ("XDG_CACHE_HOME", "cache")):
            (self.work / folder).mkdir()
            os.environ[name] = str(self.work / folder)
        os.environ["RUST_BACKTRACE"] = "1"
        display_log = self.logs / "display.log"
        self.weston = subprocess.Popen(
            ["weston", "--backend=headless", "--renderer=pixman", "--shell=kiosk-shell.so",
             "--xwayland", f"--socket={SOCKET}", "--idle-time=0", "--width=1920", "--height=1080"],
            stdout=display_log.open("wb"), stderr=subprocess.STDOUT)

        def ready():
            if self.weston.poll() is not None:
                raise SmokeFailure(f"Weston exited with status {self.weston.returncode}")
            found = re.findall(r"xserver listening on display (:\d+)",
                               display_log.read_text(errors="replace"))
            if not (runtime / SOCKET).is_socket() or not found:
                raise SmokeFailure("no Wayland socket or XWayland display yet")
            return found[-1]

        os.environ["DISPLAY"] = wait_for(ready, "Weston and XWayland did not start")
        os.environ["WAYLAND_DISPLAY"] = SOCKET
        print(f"Weston session: WAYLAND_DISPLAY={SOCKET} DISPLAY={os.environ['DISPLAY']}",
              flush=True)

    def launch(self):
        command = [self.bundle]
        if self.package == "appimage":
            command.append("--appimage-extract-and-run")
        self.app = subprocess.Popen(command, stdout=(self.logs / "chemdraft.log").open("wb"),
                                    stderr=subprocess.STDOUT, start_new_session=True)

        def main_pid():
            self.alive()
            for entry in Path("/proc").iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    if ((entry / "comm").read_text().strip() == "chemdraft"
                            and os.getsid(int(entry.name)) == self.app.pid):
                        return int(entry.name)
                except (OSError, ValueError):
                    continue
            raise SmokeFailure("no chemdraft process in the launch session yet")

        self.main_pid = wait_for(main_pid, "ChemDraft did not start", seconds=60, interval=1)
        environment = (Path("/proc") / str(self.main_pid) / "environ").read_bytes().split(b"\0")

        def uses_xwayland():
            if (b"GDK_BACKEND=x11" in environment
                    or "ChemDraft GTK backend default: GDK_BACKEND=x11" in
                    (self.logs / "chemdraft.log").read_text(errors="replace")):
                return True
            raise SmokeFailure("no GDK_BACKEND=x11 in its environment or log")

        wait_for(uses_xwayland, "ChemDraft did not choose XWayland in the Wayland session",
                 seconds=10)

    def alive(self):
        if self.app.poll() is not None:
            raise SmokeFailure(f"ChemDraft exited with status {self.app.returncode}")
        if self.weston.poll() is not None:
            raise SmokeFailure(f"Weston exited with status {self.weston.returncode}")

    def window(self, title):
        """The visible X11 window with this exact title that belongs to the launch."""
        self.alive()
        result = run("xdotool", "search", "--onlyvisible", "--name", f"^{re.escape(title)}$",
                     check=False)
        for window in result.stdout.decode().split():
            owner = run("xdotool", "getwindowpid", window, check=False)
            try:
                if os.getsid(int(owner.stdout.decode().strip())) == self.app.pid:
                    return window
            except (ValueError, ProcessLookupError):
                continue
        raise SmokeFailure(f"no visible {title!r} window")


SENTINEL = b"chemdraft-smoke-sentinel"


def host_clipboard(data):
    # xclip forks a selection owner. Keep its file descriptors off the harness log pipe.
    subprocess.run([*xclip(TEXT), "-in"], input=data, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, check=True, timeout=5)

    def claimed():
        if read_clipboard(TEXT) != data:
            raise SmokeFailure("the X11 clipboard still has other text")

    wait_for(claimed, "Host xclip did not claim the clipboard", seconds=3)


def copied(target):
    """Wait for ChemDraft to replace the host's sentinel, so a stale copy never passes."""
    def check():
        data = read_clipboard(target)
        if data == SENTINEL:
            raise SmokeFailure("the clipboard still holds the host sentinel")
        return data

    return wait_for(check, f"ChemDraft did not copy {target}", seconds=5)


def chemistry():
    """The whole document's SMILES and a summary of its native selection JSON."""
    keys("ctrl+a")
    host_clipboard(SENTINEL)
    keys("ctrl+alt+c")
    smiles = copied(TEXT)
    host_clipboard(SENTINEL)
    keys("ctrl+c")
    try:
        payload = json.loads(copied(SELECTION))
        objects = [
            (item["type"], sorted(str(atom.get("element", "")) for atom in item.get("atoms", [])),
             sorted(str(bond.get("order", "")) for bond in item.get("bonds", [])))
            for item in payload["objects"]
        ]
    except (KeyError, TypeError, ValueError) as error:
        raise SmokeFailure(f"invalid ChemDraft selection JSON: {error}") from error
    return smiles, sorted(objects)


def paste_propane(session, document):
    run("xdotool", "windowfocus", document, check=False)
    host_clipboard(b"C-C-C")
    keys("ctrl+v")

    def pasted():
        session.alive()
        smiles, summary = chemistry()
        if smiles != b"CCC":
            raise SmokeFailure(f"Copy As SMILES read {smiles[:120]!r}")
        return smiles, summary

    return wait_for(pasted, "Pasting propane into the document failed", seconds=30)


def atspi():
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi, GLib

    global RETRY
    RETRY = (SmokeFailure, GLib.Error)
    Atspi.set_timeout(1000, 1000)
    return Atspi


def children(node):
    for index in range(node.get_child_count()):
        child = node.get_child_at_index(index)
        if child is not None:
            yield child


def application(Atspi, pid):
    desktop = Atspi.get_desktop(0)
    if desktop is None:
        raise SmokeFailure("the AT-SPI desktop is unavailable")
    app = next((child for child in children(desktop) if child.get_process_id() == pid), None)
    if app is None:
        raise SmokeFailure(f"process {pid} never registered with AT-SPI")
    return app


def named_child(node, name):
    for child in children(node):
        if child.get_name() == name:
            return child
    raise SmokeFailure(f"missing {name!r} in the accessibility tree")


def open_settings_toolbar(Atspi, pid):
    def menu_item():
        app = application(Atspi, pid)
        stack = [named_child(app, "ChemDraft")]
        while stack:
            node = stack.pop()
            if node.get_role() == Atspi.Role.MENU_BAR:
                toolbars = named_child(named_child(node, "View"), "Toolbars")
                return named_child(toolbars, "Drawn Structure Settings")
            stack.extend(children(node))
        raise SmokeFailure("the document has no accessible native menu bar")

    item = wait_for(menu_item, "View > Toolbars > Drawn Structure Settings is missing")
    if not item.get_state_set().contains(Atspi.StateType.CHECKED):
        Atspi.Action.do_action(item, 0)


def number_field(Atspi, pid):
    """The settings toolbar's preferred enabled number field, or any other one."""
    window = named_child(application(Atspi, pid), SETTINGS_TITLE)
    fields = []
    stack = [window]
    visited = 0
    while stack and visited < 20000:
        node = stack.pop()
        visited += 1
        if node.get_role() == Atspi.Role.SPIN_BUTTON:
            states = node.get_state_set()
            if states.contains(Atspi.StateType.ENABLED) and states.contains(Atspi.StateType.SHOWING):
                fields.append(node)
        stack.extend(children(node))
    if not fields:
        raise SmokeFailure(f"{SETTINGS_TITLE!r} shows no enabled number field")
    fields.sort(key=lambda node: node.get_name() != PREFERRED_FIELD)
    return fields[0]


def field_value(Atspi, field):
    try:
        return Atspi.Text.get_text(field, 0, Atspi.Text.get_character_count(field))
    except Exception:  # noqa: BLE001 - WebKit may expose only the Value interface.
        return str(Atspi.Value.get_current_value(field))


def pointer():
    location = run("xdotool", "getmouselocation", "--shell").stdout.decode()
    return dict(line.split("=", 1) for line in location.split() if "=" in line)


def type_into_field(session, Atspi, settings):
    field = wait_for(lambda: number_field(Atspi, session.main_pid),
                     f"No enabled number field in {SETTINGS_TITLE}")
    name = field.get_name()
    before = field_value(Atspi, field)
    extents = Atspi.Component.get_extents(field, Atspi.CoordType.SCREEN)
    if extents.width <= 4 or extents.height <= 4:
        raise SmokeFailure(f"the {name!r} field has no usable screen extents ({extents.width}x{extents.height})")
    # Click left of center, clear of the spin arrows at the right edge.
    x = extents.x + max(3, extents.width // 4)
    y = extents.y + extents.height // 2
    print(f"Clicking {name!r} (value {before!r}) at {x},{y}", flush=True)
    run("xdotool", "mousemove", str(x), str(y))
    location = pointer()
    if (abs(int(location.get("X", -1)) - x) > 1 or abs(int(location.get("Y", -1)) - y) > 1):
        raise SmokeFailure(f"XWayland did not move the X pointer to {x},{y}: {location}")
    if location.get("WINDOW") != settings:
        raise SmokeFailure(f"window {location.get('WINDOW')} covers the field, not {settings}")
    run("xdotool", "click", "1")

    def focused():
        if not field.get_state_set().contains(Atspi.StateType.FOCUSED):
            raise SmokeFailure("the field is not focused")

    try:
        wait_for(focused, f"The {name!r} field did not take focus", seconds=5, interval=0.2)
    except SmokeFailure as error:
        print(f"{error}; typing anyway to record where the keys go", flush=True)
    run("xdotool", "type", "--delay", "150", TYPED)

    def changed():
        after = field_value(Atspi, field)
        if after == before or TYPED not in after:
            raise SmokeFailure(f"value {before!r} became {after!r}")
        return after

    after = wait_for(changed, f"Typing {TYPED!r} did not reach the {name!r} field", seconds=5)
    print(f"Typing {TYPED!r} changed {name!r} from {before!r} to {after!r}", flush=True)
    # Discard the draft so no setting is committed.
    keys("Escape")


def main(bundle, package, logs):
    logs.mkdir(parents=True, exist_ok=True)
    with Session(bundle, package, logs) as session:
        session.start_display()
        session.launch()
        document = wait_for(lambda: session.window("ChemDraft"),
                            "No ChemDraft document window appeared", seconds=60, interval=1)
        wait_for(lambda: session.window("ChemDraft Main Toolbar"),
                 "The Main Toolbar window did not appear", seconds=30, interval=1)
        before = paste_propane(session, document)
        print(f"Document before typing: {before[0].decode()} {before[1]}", flush=True)

        Atspi = atspi()
        open_settings_toolbar(Atspi, session.main_pid)
        settings = wait_for(lambda: session.window(SETTINGS_TITLE),
                            f"The {SETTINGS_TITLE} window did not appear", seconds=30)
        type_into_field(session, Atspi, settings)

        session.alive()
        run("xdotool", "windowfocus", document, check=False)
        time.sleep(0.5)
        after = chemistry()
        print(f"Document after typing: {after[0].decode()} {after[1]}", flush=True)
        if after != before:
            raise SmokeFailure(f"the document's chemistry changed from {before} to {after}")
        session.alive()
    print("Typing into a toolbar number field changed the field and left the chemistry alone.",
          flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[2] not in ("appimage", "deb"):
        sys.exit(__doc__)
    try:
        main(sys.argv[1], sys.argv[2], Path(sys.argv[3]))
    except Exception as error:  # noqa: BLE001 - report every failure as one annotation.
        sys.exit(f"::error::Toolbar number field check failed: {type(error).__name__}: {error}")
