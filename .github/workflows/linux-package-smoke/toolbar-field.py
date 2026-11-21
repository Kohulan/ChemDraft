#!/usr/bin/env python3
"""Type into a floating toolbar's number field in a Wayland session, then check the result.

The Linux container smoke (.github/workflows/linux-container-smoke.yml) runs this as its
unprivileged user under dbus-run-session, in the Wayland jobs where ChemDraft uses XWayland.
That is the default for both packages: the AppImage's GTK hook exports GDK_BACKEND=x11, and
the .deb picks it itself when WAYLAND_DISPLAY is set. The check:

1. starts headless Weston with XWayland, then the package with no GDK_BACKEND of its own;
2. pastes propane with Edit > Paste and records the document's chemistry with Edit > Select All,
   Edit > Copy As > SMILES and Edit > Copy (the native selection JSON);
3. opens Drawn Structure Settings from View > Toolbars, whose number fields are enabled only
   while a molecule is selected (Select All in step 2 leaves propane selected);
4. finds an enabled number field over AT-SPI (a spin button, or a text entry with a number field's
   label), logging every candidate it saw, then clicks into it with a real XTEST click and types "30";
5. requires the field's value to change and the document's chemistry not to.

Every menu command in steps 2 and 3 is chosen over AT-SPI, not typed. Weston's X window manager
decides where X keyboard focus goes and can put it back when an X client such as xdotool moves
it, so keyboard shortcuts meant for the document window may land elsewhere or nowhere.
Edit > Paste, Copy and Select All go to whichever ChemDraft window has focus, or to the document
window when none does, so the check first requires that no other ChemDraft window has focus. Only the field click
and the typing in step 4 use XTEST input, because that is what the check tests.

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
# The <input type="number"> fields on the palette's Structure tab, by their aria-label. They are
# disabled until a molecule, atom, bond or ring is selected (MoleculeInspectorControls in
# apps/desktop/src/ToolPalette.tsx), which Edit > Select All in chemistry() leaves in place.
FIELD_LABELS = ("Chain angle", "Target bond length", "Line width", "Bold width", "Spacing %",
                "Spacing abs.", "Margin width", "Hash spacing", "Double-bond inset")
LOGGED_STATES = ("enabled", "sensitive", "showing", "visible", "editable", "focusable", "focused")
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


def chemistry(Atspi, pid):
    """The whole document's SMILES and a summary of its native selection JSON."""
    choose(Atspi, pid, "Edit", "Select All")
    host_clipboard(SENTINEL)
    choose(Atspi, pid, "Edit", "Copy As", "SMILES")
    smiles = copied(TEXT)
    host_clipboard(SENTINEL)
    choose(Atspi, pid, "Edit", "Copy")
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


def paste_propane(session, Atspi, document):
    require_document_focus(session, Atspi, document)
    host_clipboard(b"C-C-C")
    # Paste once: a retried paste could add a second propane.
    choose(Atspi, session.main_pid, "Edit", "Paste")

    def pasted():
        session.alive()
        smiles, summary = chemistry(Atspi, session.main_pid)
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


def menu_item(Atspi, pid, *path):
    """The document window's native menu item at this path, such as Edit > Copy As > SMILES."""
    stack = [named_child(application(Atspi, pid), "ChemDraft")]
    while stack:
        node = stack.pop()
        if node.get_role() == Atspi.Role.MENU_BAR:
            for name in path:
                node = named_child(node, name)
            return node
        stack.extend(children(node))
    raise SmokeFailure("the document has no accessible native menu bar")


def choose(Atspi, pid, *path):
    """Choose a native menu item over AT-SPI, as a click on it would, with no keyboard focus."""
    label = " > ".join(path)

    def enabled():
        item = menu_item(Atspi, pid, *path)
        if not item.get_state_set().contains(Atspi.StateType.SENSITIVE):
            raise SmokeFailure(f"{label} is disabled")
        return item

    item = wait_for(enabled, f"{label} was not available", seconds=10)
    # Act once, never in a retry loop: a repeated Paste adds a second structure, and a
    # repeated toggle closes the toolbar it opened.
    try:
        acted = Atspi.Action.do_action(item, 0)
    except RETRY as error:
        raise SmokeFailure(f"Choosing {label} failed: {error}") from error
    if not acted:
        raise SmokeFailure(f"{label} refused its action")


def active_windows(Atspi, pid):
    """The titles of the ChemDraft windows GTK reports as focused."""
    return [child.get_name() for child in children(application(Atspi, pid))
            if child.get_state_set().contains(Atspi.StateType.ACTIVE)]


def report_focus(Atspi, pid, moment):
    focus = run("xdotool", "getwindowfocus", check=False)
    window = focus.stdout.decode().strip() or focus.stderr.decode(errors="replace").strip()
    name = ""
    if focus.returncode == 0 and window.isdigit():
        name = run("xdotool", "getwindowname", window, check=False).stdout.decode(
            errors="replace").strip()
    try:
        active = active_windows(Atspi, pid)
    except RETRY as error:
        active = f"unknown ({error})"
    print(f"Focus {moment}: X input focus {window} {name!r}; focused ChemDraft windows {active}",
          flush=True)


def require_document_focus(session, Atspi, document):
    """Edit > Paste, Copy and Select All follow the focused ChemDraft window, if there is one."""
    # Under Openbox this hands the document the focus. Weston's X window manager may undo it.
    run("xdotool", "windowfocus", document, check=False)

    def document_or_none():
        session.alive()
        others = [name for name in active_windows(Atspi, session.main_pid) if name != "ChemDraft"]
        if others:
            raise SmokeFailure(f"{others} has focus, so Edit menu commands would go there")

    try:
        wait_for(document_or_none, "Another ChemDraft window kept the focus from the document",
                 seconds=10)
    finally:
        report_focus(Atspi, session.main_pid, "before the Edit menu commands")


def open_settings_toolbar(Atspi, pid):
    item = wait_for(lambda: menu_item(Atspi, pid, "View", "Toolbars", "Drawn Structure Settings"),
                    "View > Toolbars > Drawn Structure Settings is missing")
    if not item.get_state_set().contains(Atspi.StateType.CHECKED):
        choose(Atspi, pid, "View", "Toolbars", "Drawn Structure Settings")


def describe(Atspi, node, depth):
    """One line per accessible: role, name, owning process, child count and the states we use."""
    states = node.get_state_set()
    flags = " ".join(name for name in LOGGED_STATES
                     if states.contains(getattr(Atspi.StateType, name.upper())))
    line = (f"{'  ' * depth}{node.get_role_name()} {node.get_name()!r} "
            f"pid={node.get_process_id()} children={node.get_child_count()} [{flags}]")
    if not node.get_name() and node.get_child_count() == 0:
        # Unnamed leaves are mostly static text, such as "1 molecule" or "No molecule" in the
        # palette's target row, which shows whether the selection reached it.
        try:
            if "Text" in node.get_interfaces():
                text = Atspi.Text.get_text(node, 0, min(60, Atspi.Text.get_character_count(node)))
                if text.strip():
                    line += f" text={text.strip()!r}"
        except RETRY:
            pass
    return line


# The last complete scan of the settings window, printed when no field is found.
LAST_SCAN = {"outline": [], "candidates": []}


def number_field(Atspi, pid):
    """The settings toolbar's preferred enabled number field, or any other one.

    WebKitGTK exposes <input type="number"> as a spin button whose name is its aria-label.
    Older builds expose it as a text entry, so an entry counts when its name is one of the
    palette's number field labels. A field is usable when it is enabled or sensitive; WebKit
    sets both on an enabled control and neither on a disabled one.
    """
    window = named_child(application(Atspi, pid), SETTINGS_TITLE)
    # libatspi caches child lists and state sets. The palette's web content renders disabled
    # fields first and enables them when the main window sends its selection, so drop the
    # cache before every scan rather than read a stale "disabled" or an empty subtree.
    window.clear_cache()
    roles = (Atspi.Role.SPIN_BUTTON, Atspi.Role.ENTRY)
    fields = []
    outline = []
    candidates = []
    stack = [(window, 0)]
    visited = 0
    while stack and visited < 5000:
        node, depth = stack.pop()
        visited += 1
        line = describe(Atspi, node, depth)
        if len(outline) < 400:
            outline.append(line)
        role = node.get_role()
        name = node.get_name()
        if role in roles or name in FIELD_LABELS:
            candidates.append(line.strip())
            states = node.get_state_set()
            usable = (states.contains(Atspi.StateType.ENABLED)
                      or states.contains(Atspi.StateType.SENSITIVE))
            if usable and (role == Atspi.Role.SPIN_BUTTON
                           or (role == Atspi.Role.ENTRY and name in FIELD_LABELS)):
                fields.append(node)
        stack.extend((child, depth + 1) for child in reversed(list(children(node))))
    LAST_SCAN["outline"] = outline
    LAST_SCAN["candidates"] = candidates
    if not fields:
        raise SmokeFailure(f"{SETTINGS_TITLE!r} shows no enabled number field "
                           f"({visited} accessibles, {len(candidates)} candidates)")
    fields.sort(key=lambda node: (node.get_name() != PREFERRED_FIELD,
                                  not node.get_state_set().contains(Atspi.StateType.SHOWING)))
    return fields[0]


def print_scan(title, lines):
    print(title, flush=True)
    for line in lines or ["(none)"]:
        print(f"  {line}", flush=True)


def field_value(Atspi, field):
    try:
        return Atspi.Text.get_text(field, 0, Atspi.Text.get_character_count(field))
    except Exception:  # noqa: BLE001 - WebKit may expose only the Value interface.
        return str(Atspi.Value.get_current_value(field))


def pointer():
    location = run("xdotool", "getmouselocation", "--shell").stdout.decode()
    return dict(line.split("=", 1) for line in location.split() if "=" in line)


def type_into_field(session, Atspi, settings):
    try:
        field = wait_for(lambda: number_field(Atspi, session.main_pid),
                         f"No enabled number field in {SETTINGS_TITLE}", seconds=30)
    except SmokeFailure:
        print_scan("Number field candidates in the last scan (role, name, process, states):",
                   LAST_SCAN["candidates"])
        print_scan(f"{SETTINGS_TITLE} accessibility tree in the last scan:", LAST_SCAN["outline"])
        raise
    print_scan("Number field candidates (role, name, process, states):", LAST_SCAN["candidates"])
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
    report_focus(Atspi, session.main_pid, f"after clicking {name!r}")

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
        Atspi = atspi()
        report_focus(Atspi, session.main_pid, "after startup")
        before = paste_propane(session, Atspi, document)
        print(f"Document before typing: {before[0].decode()} {before[1]}", flush=True)

        open_settings_toolbar(Atspi, session.main_pid)
        settings = wait_for(lambda: session.window(SETTINGS_TITLE),
                            f"The {SETTINGS_TITLE} window did not appear", seconds=30)
        type_into_field(session, Atspi, settings)

        session.alive()
        time.sleep(0.5)
        require_document_focus(session, Atspi, document)
        after = chemistry(Atspi, session.main_pid)
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
