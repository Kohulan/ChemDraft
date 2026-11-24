; Shared by every Windows installer: per-user, all-users, offline all-users, and branch (dev)
; builds. SHCTX writes to HKCU per-user and HKLM all-users.
;
; The association's ProgID is the `name` of the bundle's file association, which the build sets:
; "ChemDraft Document" for stable builds, "ChemDraft Document (dev)" for branch builds
; (scripts/desktop-tauri.mjs). The template passes it to APP_ASSOCIATE but exposes no define for it,
; so this hook never names it. The post-install hook reads the value APP_ASSOCIATE has just written
; and records it in this build's own uninstall key, which is named after this build's product name.
; scripts/desktop-tauri.mjs also passes the same name in the CHEMDRAFT_ASSOCIATION_PROGID environment
; variable, which makensis substitutes at compile time. The hooks use it before APP_ASSOCIATE runs and
; whenever no install recorded the ProgID (an interrupted install, or one made before this hook).
;
; Ownership of .chemdraft is a stack. Tauri's APP_ASSOCIATE saves the default it replaces as
; `<ProgID>_backup` on .chemdraft, and APP_UNASSOCIATE writes that value back on uninstall. A
; reinstall or /UPDATE runs APP_ASSOCIATE again over this build's own default, so Tauri would back
; this build up as its own predecessor and lose the owner .chemdraft had before ChemDraft. These hooks
; keep the owner this build really replaced in `<ProgID>_backup`, with a copy in the uninstall key,
; and on uninstall hand .chemdraft (or, if another owner has replaced this build since, that owner's
; backup) to it. Every ProgID comparison is case-insensitive, as registry key names are (LogicLib's
; == and != use StrCmp), and a ProgID is only ever made the default when its class still has a
; non-empty open command in the scope being written (see ChemDraftHasOpenCommand).

!define CHEMDRAFT_ASSOCIATION_PROGID "$%CHEMDRAFT_ASSOCIATION_PROGID%"
; An unset variable is left as written, so the name would still contain itself.
!searchreplace CHEMDRAFT_ASSOCIATION_PROGID_CHECK "${CHEMDRAFT_ASSOCIATION_PROGID}" "%CHEMDRAFT_ASSOCIATION_PROGID%" ""
!if "${CHEMDRAFT_ASSOCIATION_PROGID_CHECK}" != "${CHEMDRAFT_ASSOCIATION_PROGID}"
  !error "CHEMDRAFT_ASSOCIATION_PROGID is not set. Build Windows installers with scripts/desktop-tauri.mjs (pnpm tauri build)."
!endif
!if "${CHEMDRAFT_ASSOCIATION_PROGID}" == ""
  !error "CHEMDRAFT_ASSOCIATION_PROGID is empty. Build Windows installers with scripts/desktop-tauri.mjs (pnpm tauri build)."
!endif
!undef CHEMDRAFT_ASSOCIATION_PROGID_CHECK

Var ChemDraftAssociationOwnProgId
Var ChemDraftAssociationProgId
Var ChemDraftAssociationHadDefault
Var ChemDraftAssociationWasOwner
Var ChemDraftAssociationPrevious
Var ChemDraftAssociationOldPrevious
Var ChemDraftAssociationBackupSuffix
Var ChemDraftAssociationCursor
Var ChemDraftAssociationName
Var ChemDraftAssociationValue
Var ChemDraftAssociationFlag
Var ChemDraftAssociationSteps
Var ChemDraftAssociationScratch

; Sets OUT to 1 when PROGID is this build's ProgID, recorded or built in; otherwise 0.
!macro ChemDraftIsOwnProgId OUT PROGID
  StrCpy ${OUT} 0
  ${If} "${PROGID}" != ""
    ${If} "${PROGID}" == "$ChemDraftAssociationOwnProgId"
    ${OrIf} "${PROGID}" == "${CHEMDRAFT_ASSOCIATION_PROGID}"
      StrCpy ${OUT} 1
    ${EndIf}
  ${EndIf}
!macroend

; Sets OUT to the open command PROGID has for the user running this uninstaller: this user's class
; (HKCU) when it has an open command key, which shadows the machine's, otherwise the machine's (HKLM).
; This is the merged view HKCR gives that user. Empty when neither has a command value.
!macro ChemDraftUserOpenCommand OUT PROGID
  ClearErrors
  EnumRegKey ${OUT} HKCU "Software\Classes\${PROGID}\shell\open\command" 0
  ${If} ${Errors}
    ReadRegStr ${OUT} HKLM "Software\Classes\${PROGID}\shell\open\command" ""
  ${Else}
    ReadRegStr ${OUT} HKCU "Software\Classes\${PROGID}\shell\open\command" ""
  ${EndIf}
!macroend

; Sets OUT to 1 when PROGID names a class whose open command has a non-empty value in the scope
; SHCTX writes .chemdraft to; otherwise 0. A command key left without a value opens nothing. An
; all-users uninstall checks HKLM only: HKCR would also show the uninstalling administrator's own
; HKCU classes, which no other user has. A per-user uninstall checks the class this user sees.
; INSTALLMODE is the template's define (perMachine, currentUser or both); MultiUser.nsh sets
; $MultiUser.InstallMode only in `both` mode.
!macro ChemDraftHasOpenCommand OUT PROGID
  StrCpy ${OUT} 0
  ${If} "${PROGID}" != ""
    !if "${INSTALLMODE}" == "perMachine"
      ReadRegStr $ChemDraftAssociationScratch HKLM "Software\Classes\${PROGID}\shell\open\command" ""
    !else if "${INSTALLMODE}" == "both"
      ${If} $MultiUser.InstallMode == "AllUsers"
        ReadRegStr $ChemDraftAssociationScratch HKLM "Software\Classes\${PROGID}\shell\open\command" ""
      ${Else}
        !insertmacro ChemDraftUserOpenCommand $ChemDraftAssociationScratch "${PROGID}"
      ${EndIf}
    !else
      !insertmacro ChemDraftUserOpenCommand $ChemDraftAssociationScratch "${PROGID}"
    !endif
    ${If} $ChemDraftAssociationScratch != ""
      StrCpy ${OUT} 1
    ${EndIf}
  ${EndIf}
!macroend

; Sets OUT to the owner this build replaced at its last install: its `<ProgID>_backup`, or the copy
; in its uninstall key when that value is missing or names this build itself. Empty when none.
!macro ChemDraftReadPrevious OUT
  StrCpy $ChemDraftAssociationFlag 1
  ClearErrors
  ReadRegStr ${OUT} SHCTX "Software\Classes\.chemdraft" "$ChemDraftAssociationOwnProgId$ChemDraftAssociationBackupSuffix"
  ${IfNot} ${Errors}
    !insertmacro ChemDraftIsOwnProgId $ChemDraftAssociationFlag "${OUT}"
  ${EndIf}
  ${If} $ChemDraftAssociationFlag = 1
    ReadRegStr ${OUT} SHCTX "${UNINSTKEY}" "ChemDraftAssociationPreviousOwner"
    !insertmacro ChemDraftIsOwnProgId $ChemDraftAssociationFlag "${OUT}"
    ${If} $ChemDraftAssociationFlag = 1
      StrCpy ${OUT} ""
    ${EndIf}
  ${EndIf}
!macroend

; FROM is an owner that holds .chemdraft above this build. Follow `<ProgID>_backup` values down from
; it to the owner that replaced this build, and point that owner's backup at TO (the owner this build
; replaced) instead, so restoring it later never names this build's deleted class. Only a value that
; names this build is changed. Bounded, so a cycle of backups cannot hang the installer.
!macro ChemDraftRepointSuccessor FROM TO
  StrCpy $ChemDraftAssociationCursor "${FROM}"
  StrCpy $ChemDraftAssociationSteps 0
  ${Do}
    ${If} $ChemDraftAssociationCursor == ""
    ${OrIf} $ChemDraftAssociationSteps >= 16
      ${ExitDo}
    ${EndIf}
    IntOp $ChemDraftAssociationSteps $ChemDraftAssociationSteps + 1
    !insertmacro ChemDraftIsOwnProgId $ChemDraftAssociationFlag $ChemDraftAssociationCursor
    ${If} $ChemDraftAssociationFlag = 1
      ${ExitDo}
    ${EndIf}
    StrCpy $ChemDraftAssociationName "$ChemDraftAssociationCursor$ChemDraftAssociationBackupSuffix"
    ClearErrors
    ReadRegStr $ChemDraftAssociationValue SHCTX "Software\Classes\.chemdraft" "$ChemDraftAssociationName"
    ${If} ${Errors}
      ${ExitDo}
    ${EndIf}
    !insertmacro ChemDraftIsOwnProgId $ChemDraftAssociationFlag $ChemDraftAssociationValue
    ${If} $ChemDraftAssociationFlag = 1
      StrCpy $ChemDraftAssociationValue "${TO}"
      ${If} $ChemDraftAssociationValue == $ChemDraftAssociationCursor
        StrCpy $ChemDraftAssociationValue ""
      ${EndIf}
      WriteRegStr SHCTX "Software\Classes\.chemdraft" "$ChemDraftAssociationName" "$ChemDraftAssociationValue"
      ${ExitDo}
    ${EndIf}
    StrCpy $ChemDraftAssociationCursor $ChemDraftAssociationValue
  ${Loop}
!macroend

; Runs before APP_ASSOCIATE replaces .chemdraft's default and this build's backup. Works out the owner
; this build replaces; nothing is written until the install has succeeded.
!macro NSIS_HOOK_PREINSTALL
  StrCpy $ChemDraftAssociationBackupSuffix "_backup"
  ReadRegStr $ChemDraftAssociationOwnProgId SHCTX "${UNINSTKEY}" "ChemDraftAssociationProgId"
  ${If} $ChemDraftAssociationOwnProgId == ""
    StrCpy $ChemDraftAssociationOwnProgId "${CHEMDRAFT_ASSOCIATION_PROGID}"
  ${EndIf}
  !insertmacro ChemDraftReadPrevious $ChemDraftAssociationOldPrevious
  ReadRegStr $ChemDraftAssociationProgId SHCTX "Software\Classes\.chemdraft" ""
  !insertmacro ChemDraftIsOwnProgId $ChemDraftAssociationWasOwner $ChemDraftAssociationProgId
  ${If} $ChemDraftAssociationWasOwner = 1
    ; A reinstall or /UPDATE over this build's own default keeps the owner it replaced before.
    StrCpy $ChemDraftAssociationPrevious $ChemDraftAssociationOldPrevious
  ${Else}
    StrCpy $ChemDraftAssociationPrevious $ChemDraftAssociationProgId
  ${EndIf}
!macroend

; Tauri CLI 2.11.2's installer.nsi passes an unquoted executable path to APP_ASSOCIATE,
; and FileAssociation.nsh writes it verbatim. Quote the executable and document paths.
!macro NSIS_HOOK_POSTINSTALL
  StrCpy $ChemDraftAssociationBackupSuffix "_backup"
  ; APP_ASSOCIATE always sets .chemdraft's default to this build's ProgID just before this hook.
  ReadRegStr $ChemDraftAssociationOwnProgId SHCTX "Software\Classes\.chemdraft" ""
  ${If} $ChemDraftAssociationOwnProgId == ""
    StrCpy $ChemDraftAssociationOwnProgId "${CHEMDRAFT_ASSOCIATION_PROGID}"
  ${EndIf}
  ${If} $ChemDraftAssociationOwnProgId != ""
    WriteRegStr SHCTX "Software\Classes\$ChemDraftAssociationOwnProgId\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
    WriteRegStr SHCTX "${UNINSTKEY}" "ChemDraftAssociationProgId" "$ChemDraftAssociationOwnProgId"

    ; APP_ASSOCIATE has just backed up the default it replaced, which on a reinstall or /UPDATE is
    ; this build itself. Put back the owner this build really replaced, and keep a copy of it.
    !insertmacro ChemDraftIsOwnProgId $ChemDraftAssociationFlag $ChemDraftAssociationPrevious
    ${If} $ChemDraftAssociationFlag = 1
      StrCpy $ChemDraftAssociationPrevious ""
    ${EndIf}
    WriteRegStr SHCTX "Software\Classes\.chemdraft" "$ChemDraftAssociationOwnProgId$ChemDraftAssociationBackupSuffix" "$ChemDraftAssociationPrevious"
    WriteRegStr SHCTX "${UNINSTKEY}" "ChemDraftAssociationPreviousOwner" "$ChemDraftAssociationPrevious"

    ; Another owner held .chemdraft (it may have replaced this build): this build has moved above it,
    ; so whichever owner had replaced this build now follows the owner this build used to follow.
    ${If} $ChemDraftAssociationWasOwner <> 1
      !insertmacro ChemDraftRepointSuccessor $ChemDraftAssociationProgId $ChemDraftAssociationOldPrevious
    ${EndIf}
  ${EndIf}
!macroend

; Deletes KEY only when it has no default value, no other values and no subkeys.
!macro ChemDraftDeleteRegKeyIfEmpty KEY
  Push $0
  Push $1
  ClearErrors
  ReadRegStr $0 SHCTX "${KEY}" ""
  ${If} ${Errors}
    EnumRegKey $0 SHCTX "${KEY}" 0
    EnumRegValue $1 SHCTX "${KEY}" 0
    ${If} $0 == ""
    ${AndIf} $1 == ""
      DeleteRegKey /ifempty SHCTX "${KEY}"
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend

; Record this build's ProgID (written by its installer, else the built-in one), the current owner
; (including a missing default), and the owner this build replaced, before Tauri's APP_UNASSOCIATE
; restores its backup and Tauri deletes the uninstall key.
!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $ChemDraftAssociationBackupSuffix "_backup"
  ReadRegStr $ChemDraftAssociationOwnProgId SHCTX "${UNINSTKEY}" "ChemDraftAssociationProgId"
  ${If} $ChemDraftAssociationOwnProgId == ""
    StrCpy $ChemDraftAssociationOwnProgId "${CHEMDRAFT_ASSOCIATION_PROGID}"
  ${EndIf}
  StrCpy $ChemDraftAssociationHadDefault 0
  ClearErrors
  ReadRegStr $ChemDraftAssociationProgId SHCTX "Software\Classes\.chemdraft" ""
  ${IfNot} ${Errors}
    StrCpy $ChemDraftAssociationHadDefault 1
  ${EndIf}
  !insertmacro ChemDraftIsOwnProgId $ChemDraftAssociationWasOwner $ChemDraftAssociationProgId
  !insertmacro ChemDraftReadPrevious $ChemDraftAssociationPrevious
!macroend

; Remove only what this installer registered. Another program's or the other ChemDraft build's
; ProgID and OpenWithProgids entries are never touched; the only other value changed is a backup that
; names this build, which is pointed at the owner this build replaced.
!macro NSIS_HOOK_POSTUNINSTALL
  ; Tauri's optional app-data removal switches the shell context to current.
  ; Restore the install scope before using SHCTX (especially for all-users).
  !insertmacro SetContext

  ; Delete this build's class first, so nothing below can make a default of it.
  ${If} $ChemDraftAssociationOwnProgId != ""
    DeleteRegKey SHCTX "Software\Classes\$ChemDraftAssociationOwnProgId"
  ${EndIf}

  ; The owner this build replaced is handed .chemdraft only while its class still opens files.
  !insertmacro ChemDraftHasOpenCommand $ChemDraftAssociationFlag $ChemDraftAssociationPrevious
  ${If} $ChemDraftAssociationFlag <> 1
    StrCpy $ChemDraftAssociationPrevious ""
  ${EndIf}

  ${If} $ChemDraftAssociationHadDefault <> 1
    ; There was no default: keep it missing over APP_UNASSOCIATE's restore.
    DeleteRegValue SHCTX "Software\Classes\.chemdraft" ""
  ${ElseIf} $ChemDraftAssociationWasOwner = 1
    ; This build owned .chemdraft: return it to the owner this build replaced, or to nobody.
    ${If} $ChemDraftAssociationPrevious != ""
      WriteRegStr SHCTX "Software\Classes\.chemdraft" "" "$ChemDraftAssociationPrevious"
    ${Else}
      DeleteRegValue SHCTX "Software\Classes\.chemdraft" ""
    ${EndIf}
  ${Else}
    ; Someone claimed .chemdraft after this build did (another program or the other ChemDraft build):
    ; put that owner back over APP_UNASSOCIATE's restore while its class still opens files.
    !insertmacro ChemDraftHasOpenCommand $ChemDraftAssociationFlag $ChemDraftAssociationProgId
    ${If} $ChemDraftAssociationFlag = 1
      WriteRegStr SHCTX "Software\Classes\.chemdraft" "" "$ChemDraftAssociationProgId"
    ${Else}
      DeleteRegValue SHCTX "Software\Classes\.chemdraft" ""
    ${EndIf}
    !insertmacro ChemDraftRepointSuccessor $ChemDraftAssociationProgId $ChemDraftAssociationPrevious
  ${EndIf}

  ${If} $ChemDraftAssociationOwnProgId != ""
    DeleteRegValue SHCTX "Software\Classes\.chemdraft" "$ChemDraftAssociationOwnProgId$ChemDraftAssociationBackupSuffix"
    DeleteRegValue SHCTX "Software\Classes\.chemdraft\OpenWithProgids" "$ChemDraftAssociationOwnProgId"
  ${EndIf}

  !insertmacro ChemDraftDeleteRegKeyIfEmpty "Software\Classes\.chemdraft\OpenWithProgids"
  !insertmacro ChemDraftDeleteRegKeyIfEmpty "Software\Classes\.chemdraft"

  !insertmacro UPDATEFILEASSOC
!macroend
