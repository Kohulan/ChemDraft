# Windows installer scope audit (#252)

This is a source review, not Windows runtime verification. Ground truth is the saved Tauri CLI
2.11.2 template `installer-tauri-cli-v2.11.2.nsi` and updater 2.12.0 source `updater-windows.rs`
under `/Users/jeremiahgassensmith/programming/chemdraw-wt/_master-scratch/b1-tauri-nsis/`.
References to those basenames below mean those read-only files. This adapts the earlier audit in
commit `140d2030` to two installers with separate feeds.

## Separate installers and update feeds

The base `tauri.conf.json` remains `currentUser`; `tauri.windows.conf.json` retains the existing
`latest.json` endpoint, public key and passive updater mode. The released per-user filename remains
`ChemDraft_<ver>_x64-setup.exe`.

The release workflow adds `--config src-tauri/tauri.allusers.conf.json` for a second build. This
overlay sets `bundle.windows.nsis.installMode` to `perMachine` and replaces
only the updater endpoint with `https://raw.githubusercontent.com/jgassens/ChemDraft/main/latest-allusers.json`.
It inherits the public key, passive update mode, quoting hook and Windows-only `.chemdraft` association. The workflow
stages this installer as `ChemDraft_<ver>_x64-allusers-setup.exe` before signing. Each feed is generated
with the existing `release:windows-manifest` script using its own installer and `.sig`; both feeds
must be committed to `main` together after the release assets are downloadable.

Each installer has a fixed scope. The template emits `RequestExecutionLevel admin` for `perMachine`
and `user` for `currentUser` (`installer-tauri-cli-v2.11.2.nsi:98`–`105`). On x64 it defaults the
machine install to `$PROGRAMFILES64\${PRODUCTNAME}`, normally `C:\Program Files\ChemDraft`; the
per-user default remains `$LOCALAPPDATA\${PRODUCTNAME}` (`:491`–`512`). `SetContext` selects the
scope used by `SHCTX` and shell folders. Shortcuts use `$SMPROGRAMS` (`:940`–`946`), so the machine
installer creates an all-users Start Menu shortcut. Existing installation locations are restored
from the selected scope's registry (`:893`–`897`).

Installing both produces two copies. Neither installer migrates or removes the other copy. They
share the stable application identifier; settings and plugins remain per account. Uninstall the
other scope before switching, including to avoid a retained HKCU file association overriding HKLM.

## Program Files and writable state

No application-owned write into the executable or bundled-resource directory was found in the
audited paths. All-users installation shares program files; application data remains per account.

| Area | Source evidence |
| --- | --- |
| Toolbar settings and document session | `apps/desktop/src-tauri/src/lib.rs:8930`–`8953` resolves files through `app_data_dir()`. |
| Plugin storage | `apps/desktop/src-tauri/src/lib.rs:2885`–`2898` resolves `plugins/<id>/storage.json` through `app_data_dir()`. |
| Installed-plugin serving | `apps/desktop/src-tauri/src/installed_plugins.rs:74`–`78` uses app data; `:151`–`163` reads validated paths beneath it. `:48`–`55` retains Windows origin `http://tauri.localhost`, independently of the installation path. |
| Naming and OCSR installation | `apps/desktop/src-tauri/src/naming_engine/mod.rs:550`–`559` and `apps/desktop/src-tauri/src/ocsr_engine/mod.rs:814`–`825` inject app data; `apps/desktop/src-tauri/src/local_engine/install.rs:30`–`45` derives final, staging and previous directories from it. |
| External tools | `apps/desktop/src-tauri/src/external_tools/mod.rs:424`–`428` uses `app_local_data_dir()/external-tools`. |
| Downloaded app updater | `updater-windows.rs:962`–`969` and `:1006`–`1025` write the installer to a temporary directory. |

OPSIN resolves bundled Java resources and strips Windows verbatim drive prefixes
(`apps/desktop/src-tauri/src/opsin.rs:124`–`167`). It launches Java with `Command::new`, the jar's
parent as cwd, and the jar basename as one argument (`:348`–`367`): no shell splits Program Files
at its space, and these operations read the bundle rather than writing to it.

Naming also strips verbatim drive prefixes (`apps/desktop/src-tauri/src/naming_engine/mod.rs:574`–`595`).
Its Python command uses `-I -B`, the writable engine directory as cwd, bundled JRE as `JAVA_HOME`,
and app-data cache (`apps/desktop/src-tauri/src/naming_engine/process.rs:104`–`119`). The sidecar
checks `<JAVA_HOME>/bin/server/jvm.dll` and host-supplied jars before requiring a working JPype JVM
(`apps/desktop/src-tauri/resources/naming/orthonym_sidecar.py:96`–`164`). The host requests no copying
or writing of the JVM. DLL loading from Program Files still needs a Windows pass.

The 3D sidecar is found beside the executable using path joins
(`apps/desktop/src-tauri/src/lib.rs:6394`–`6417`) and launched directly with piped stdio
(`:6483`–`6489`). The reviewed native sidecar source uses the stdio protocol, with no application-state
file write beside its executable.

## File association quoting: both installers

The template passes an unquoted executable to `APP_ASSOCIATE`
(`installer-tauri-cli-v2.11.2.nsi:660`). Its matching
[FileAssociation.nsh:79](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.2/crates/tauri-bundler/src/bundle/windows/nsis/FileAssociation.nsh#L79)
writes that command verbatim, making a Program Files path ambiguous. The shared hook
`apps/desktop/src-tauri/windows/installer-hooks.nsh` rewrites the command with both paths
quoted, using `SHCTX` (HKCU per-user, HKLM all-users):

```text
"C:\Program Files\ChemDraft\chemdraft.exe" "%1"
```

The template calls `NSIS_HOOK_POSTINSTALL` after associations and shortcuts (`:727`–`729`). The
post-install hook is wired by the Windows config for every installer and changes only the open
command of the class this installer just registered. No `.cdxml` association is added. The config
test checks the hook wiring and resulting command with spaces in both paths.

## Which ProgID belongs to this build

The association's ProgID is the file association's `name`: `ChemDraft Document` for stable builds
and `ChemDraft Document (dev)` for branch builds, which `scripts/desktop-tauri.mjs` gives their own
product name and suffixed association names. Both share this hook. The template passes the name to
`APP_ASSOCIATE` and `APP_UNASSOCIATE` (`:660`) but defines no symbol for it, so the hook never
hard-codes either name. `APP_ASSOCIATE` always sets `.chemdraft`'s default to this build's ProgID
just before `NSIS_HOOK_POSTINSTALL` runs. The post-install hook reads that value, quotes the open
command under it, and records it as `ChemDraftAssociationProgId` in this build's uninstall key
(`${UNINSTKEY}`, named after the product name, so stable and dev builds never share it). The
pre-uninstall hook reads it back before Tauri deletes that key. A dev install therefore never
rewrites the stable class's command, and neither build's uninstaller deletes the other's class.

The hooks also need the ProgID where nothing recorded it: before `APP_ASSOCIATE` runs on an install,
and on uninstall after an install that stopped before its post-install hook or was made before these
hooks. On Windows, `scripts/desktop-tauri.mjs` sets `CHEMDRAFT_ASSOCIATION_PROGID` to the same
association name it gives Tauri (the dev names for a branch build, otherwise the Windows config's),
and makensis substitutes that environment variable into the hook at compile time. The hook stops the
build with `!error` when the variable is unset or empty, so every installer carries its ProgID. The
recorded value is used when present, and the built-in one otherwise.

## File association owners across installs and uninstalls

Tauri CLI 2.11.2 supports all four hooks: `NSIS_HOOK_PREINSTALL` before any file is copied,
`NSIS_HOOK_POSTINSTALL` after associations and shortcuts, and `NSIS_HOOK_PREUNINSTALL` and
`NSIS_HOOK_POSTUNINSTALL` around the uninstall section (`installer-tauri-cli-v2.11.2.nsi:772`–`774`,
`:880`–`882`). At install, `APP_ASSOCIATE` saves `.chemdraft`'s previous default as
`<ProgID>_backup`. At uninstall, `APP_UNASSOCIATE` writes that backup back as the default, even if
another program has claimed the extension since, and deletes the ProgID key, but leaves the extension
key and backup value behind (`FileAssociation-tauri-cli-v2.11.2.nsh:108`–`114`). A reinstall, and an
update with `/UPDATE` (which installs over the existing copy without uninstalling it), runs
`APP_ASSOCIATE` again while this build owns `.chemdraft`, so Tauri alone would back the build up as its
own predecessor and lose the owner from before ChemDraft was installed.

Ownership of `.chemdraft` is treated as a stack, linked by those `<ProgID>_backup` values. All
registry operations use `SHCTX` (HKCU for per-user installs, HKLM for all-users installs), and every
ProgID comparison is case-insensitive, as registry key names are.

- **Before install**, the pre-install hook works out the owner this build replaces: the current
  default, or, when that is already this build (a reinstall or `/UPDATE`), the owner it replaced
  before, read from its `<ProgID>_backup` or, if that names the build itself, from the copy in its
  uninstall key. Nothing is written yet, so a cancelled install leaves no trace.
- **After install**, the post-install hook writes that owner back over `APP_ASSOCIATE`'s backup and
  saves a copy as `ChemDraftAssociationPreviousOwner` in this build's uninstall key, so an interrupted
  reinstall that leaves a self-backup still has it. It never saves this build's own ProgID. If another
  owner held `.chemdraft` (for example the other ChemDraft build, which had replaced this one), this
  build has moved above it: the backup that named this build is pointed at the owner this build used
  to follow.
- **Before uninstall**, the pre-uninstall hook records this build's ProgID, the current default
  (including whether it exists) and the owner this build replaced. After uninstall, the hook first
  restores the install scope with `SetContext`, since optional app-data deletion switches the shell
  context to the current user, then deletes this build's class.
- If this build **was** the owner, `.chemdraft` goes back to the owner it replaced: the program that
  owned it before ChemDraft, or the other ChemDraft build. If that class no longer has a
  `shell\open\command` in `HKCR` (it was uninstalled since), or nothing owned `.chemdraft` before,
  the default is removed instead.
- If the default before uninstall was **not** this build's ProgID (another program, or the other
  ChemDraft build, claimed `.chemdraft` later), that owner is put back over Tauri's restored backup
  while its class still has an open command; otherwise the default is removed. A missing default
  stays missing. The owner that replaced this build, found by following backups down from the current
  owner, has its backup pointed at the owner this build replaced, so a later uninstall of it restores
  a live class rather than this build's deleted one. That backup is the only value of another owner
  the hook changes, and only when it names this build.
- It deletes this build's ProgID tree, its own `<ProgID>_backup` value, and only its own value
  under `.chemdraft\OpenWithProgids`. Another program's or the other build's ProgID and OpenWith
  entries are never touched.
- It never deletes `.chemdraft` or `OpenWithProgids` wholesale. Each is removed only when it is then
  empty: no default value, no other values and no subkeys (checked explicitly, then
  `DeleteRegKey /ifempty`). No other extension is touched, and `.cdxml` is never registered.
- Finally, Tauri's `UPDATEFILEASSOC` macro calls
  `SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_FLUSH, 0, 0)` to refresh the shell.

An install that a release without these hooks has already reinstalled or updated over itself has lost
its predecessor to a self-backup, so its uninstall removes the default rather than guess. One installed
only once by such a release still has Tauri's backup, and the first update under these hooks keeps it.

`apps/desktop/src/windowsAssociationQuoting.test.ts` runs the hook's own text through a small
interpreter for the NSIS commands it uses (including LogicLib's `If` and `Do` blocks), over an
in-memory registry, with Tauri's association macros and the install and uninstall sections around the
hooks modeled after the saved template. It covers a program that owned `.chemdraft` before install
surviving a reinstall and `/UPDATE` and being restored on uninstall, an interrupted reinstall, an
upgrade that runs the old uninstaller first, stable and dev builds installed in either order (with
and without an earlier owner, with reinstalls between) and uninstalled in either order, a missing
recorded ProgID with a ChemDraft-owned or a foreign default, an interrupted first install, a program
that claimed `.chemdraft` afterward, a later owner or saved owner whose class is gone, another
program's OpenWith entry, a missing default, and case-only ProgID changes (checking that the restored
class still has its open command). Every uninstall also checks that nothing the build registered
remains. It does not execute NSIS, and the compile-time `!error` guard is checked only as text. The
cleanup still requires real Windows tests of the CI-built installers. Check silent `/S` uninstall after
a clean install, a reinstall and an `/UPDATE`, a stable and a dev build side by side in both orders
with another program owning `.chemdraft` first, a changed or missing default, another program's
OpenWith entry, and uninstall with app-data removal selected. Confirm cleanup in the correct registry
hive and preservation of associations owned by another program.

## Updates require administrator rights for the machine install

Updater 2.12.0 launches the temporary installer with `ShellExecuteW("open", ...)`
(`updater-windows.rs:854`–`882`). Parameters include passive-mode arguments, `/UPDATE` and restart
arguments (`:885`–`914`). `/UPDATE` avoids uninstalling before replacement
(`installer-tauri-cli-v2.11.2.nsi:312`–`315`); restart uses `RunAsUser` (`:735`–`746`).

The all-users feed always delivers a `perMachine` installer, whose `RequestExecutionLevel admin`
manifest requests elevation even for passive updates. **Every machine update needs admin rights.**
An unelevated administrator sees the normal UAC consent prompt; a standard user sees an
admin-credentials UAC prompt. Passive mode is not an elevation bypass. If no administrator can
supply credentials, defer the update for managed deployment. A process already elevated does not
need another prompt. Test cancellation and restoration in the original account on Windows.

Because each feed delivers an installer with the same fixed scope as the installed app, an all-users
update cannot choose the per-user destination. No updater scope flags or native updater changes are
needed. This depends on release discipline: never put the per-user artifact URL in `latest-allusers.json`.

## Integration handoff

On macOS, the focused config tests passed (8 tests), as did the existing manifest-generator tests
(5 tests), using existing dependencies without installing packages. The workflow YAML and all
embedded PowerShell blocks parsed successfully; `git diff --check` passed. No native app, installer,
Rust check or full suite was run. Windows runtime behavior remains unverified. Test CI-built
installers only: both scopes' UAC/update destination,
HKCU/HKLM associations, all-users Start Menu, `/S` from an elevated prompt, normal-user runtime use
under Program Files (OPSIN, naming/JVM, installed plugins, 3D), administrator-credential updates,
cancellation, session restoration to the original account, no duplicate per-user copy, and uninstall.
No macOS native build is needed for these Windows-only packaging changes; macOS runtime was not run.
The recommended next task is this CI-built Windows installer and update pass.

Before a signed CI run, update any existing SignPath artifact configuration to select all three
installers: `ChemDraft_<ver>_x64-setup.exe`, `ChemDraft_<ver>_x64-allusers-setup.exe` and the offline
`ChemDraft_<ver>_x64-allusers-offline-setup.exe`, as documented in `docs/releasing/windows-signing.md`.
The workflow verifies the exact returned filename set and requires a valid Authenticode signature on
each installer, so a configuration that omits the offline installer fails the signed run.

The build stamp in `apps/desktop/src/MainWindow.tsx` is bumped so the build is identifiable; `scripts/ci/require-build-stamp-bump.sh` alone would not require it, since the only other change under `apps/desktop/src` is a test file.
