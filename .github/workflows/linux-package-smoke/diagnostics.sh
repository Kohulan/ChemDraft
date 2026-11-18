# Sourced by the Ubuntu runner's package smoke and its disposable AppRun wrapper.

print_dependencies() {
  local executable=$1 helper
  shift
  for helper in "$executable" "$@"; do
    printf '\nldd %s\n' "$helper"
    /usr/bin/ldd "$helper" || true
  done
}

record_profile() {
  find "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" -maxdepth 3 -ls
  dbus-send --session --print-reply --dest=org.freedesktop.DBus \
    /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner \
    string:org.chemdraft.desktop.SingleInstance
}

prepare_diagnostics() {
  # Run against host libraries except where AppRun explicitly supplies its own environment.
  unset APPDIR APPIMAGE APPIMAGE_EXTRACT_AND_RUN LD_LIBRARY_PATH LD_PRELOAD
  dpkg-query -W -f='${db:Status-Abbrev} ${binary:Package} ${Version}\n' \
    'libgtk-3-0*' 'libwebkit2gtk-4.1-0*' 'libsoup-3.0-0*' libc6 2>/dev/null \
    | awk '$1 == "ii" { print $2, $3 }' > "$logs/libraries.log" || true

  if [[ "$package" == deb ]]; then
    local -a helpers
    mapfile -t helpers < <(dpkg-query -L libwebkit2gtk-4.1-0 | grep -E '/WebKit(Web|Network|GPU)Process$')
    print_dependencies "$bundle" "${helpers[@]}" > "$logs/ldd.log" 2>&1
    return
  fi

  # Only the disposable copy gets a wrapper. The smoke still launches the delivered AppImage.
  appdir="$work/squashfs-root"
  if ! (cd "$work" && "$bundle" --appimage-extract) > "$logs/extract.log" 2>&1; then
    echo '::warning::Could not extract a diagnostic copy of the AppImage'
    return
  fi
  if [[ ! -x "$appdir/usr/bin/chemdraft" ]]; then
    echo '::warning::Could not locate the AppImage executable for diagnostics'
    return
  fi
  mv "$appdir/usr/bin/chemdraft" "$appdir/usr/bin/chemdraft.real"
  cat > "$appdir/usr/bin/chemdraft" <<'DEBUG'
#!/bin/bash
set -euo pipefail
source "$CHEMDRAFT_SMOKE_DIAGNOSTICS"
appimage_diagnostics "$@"
DEBUG
  chmod +x "$appdir/usr/bin/chemdraft"
  apprun=(env "APPDIR=$appdir" "APPIMAGE=$bundle" "CHEMDRAFT_SMOKE_DIAGNOSTICS=$action_path/diagnostics.sh"
    "CHEMDRAFT_SMOKE_WORK=$work" "$appdir/AppRun")
  timeout --kill-after=5s 60s "${apprun[@]}" > "$logs/ldd.log" 2>&1 || true
}

appimage_diagnostics() {
  local binary="$APPDIR/usr/bin/chemdraft.real" variable environment_script
  if [[ -z "${CHEMDRAFT_SMOKE_GDB_SCRIPT:-}" ]]; then
    local -a helpers
    mapfile -d '' -t helpers < <(find "$APPDIR" \
      \( -name WebKitWebProcess -o -name WebKitNetworkProcess -o -name WebKitGPUProcess \) -print0)
    echo 'ldd inside the AppRun environment:'
    print_dependencies "$binary" "${helpers[@]}"
    if (( ${#helpers[@]} == 0 )); then
      echo 'No bundled WebKit helpers found. The process trace shows the helper paths used at runtime.'
    fi
    return
  fi

  # AppRun can set Python and loader paths that prevent host GDB from starting. The inferior
  # still needs AppRun's loader and helper paths.
  for variable in "${!PYTHON@}"; do unset "$variable"; done
  environment_script="$CHEMDRAFT_SMOKE_WORK/apprun-environment.gdb"
  printf 'set environment LD_LIBRARY_PATH = %s\nset environment LD_PRELOAD = %s\nset environment PATH = %s\n' \
    "${LD_LIBRARY_PATH-}" "${LD_PRELOAD-}" "$PATH" > "$environment_script"
  exec /usr/bin/env -u LD_LIBRARY_PATH -u LD_PRELOAD PATH=/usr/bin:/bin \
    /usr/bin/gdb --nx --nh -batch -x "$environment_script" \
    -x "$CHEMDRAFT_SMOKE_GDB_SCRIPT" --args "$binary" "$@"
}

retry_under_gdb() {
  local debug_script="$work/backtrace.gdb" debug_status=0
  local -a debug_command
  if [[ "$package" == appimage && -z "${apprun[*]:-}" ]]; then
    echo 'GDB retry unavailable because AppImage diagnostic extraction failed.'
    return
  fi
  cat > "$debug_script" <<'GDB'
set pagination off
set breakpoint pending on
set startup-with-shell off
break exit
break _exit
run
thread apply all bt full
GDB
  new_profile
  debug_command=(/usr/bin/gdb --nx --nh -batch -x "$debug_script" --args "$bundle")
  if [[ "$package" == appimage ]]; then
    debug_command=(env "CHEMDRAFT_SMOKE_GDB_SCRIPT=$debug_script" "${apprun[@]}")
  fi
  GDK_SYNCHRONIZE=1 timeout --signal=INT --kill-after=10s 90s \
    dbus-run-session -- "${debug_command[@]}" > "$logs/gdb.log" 2>&1 || debug_status=$?
  report_status "$debug_status" 'GDB retry (124 means the 90-second timeout)'
}
