; Shared by every Windows installer: per-user, all-users, offline all-users, and branch (dev)
; builds. SHCTX writes to HKCU per-user and HKLM all-users.
;
; The association's ProgID is the `name` of the bundle's file association, which the build sets:
; "ChemDraft Document" for stable builds, "ChemDraft Document (dev)" for branch builds
; (scripts/desktop-tauri.mjs). The template passes it to APP_ASSOCIATE but exposes no define for it,
; so this hook never names it. It reads the value APP_ASSOCIATE has just written and records it in
; this build's own uninstall key, which is named after this build's product name.

Var ChemDraftAssociationOwnProgId
Var ChemDraftAssociationBackupName
Var ChemDraftAssociationProgId
Var ChemDraftAssociationHadDefault

; Tauri CLI 2.11.2's installer.nsi passes an unquoted executable path to APP_ASSOCIATE,
; and FileAssociation.nsh writes it verbatim. Quote the executable and document paths.
!macro NSIS_HOOK_POSTINSTALL
  ; APP_ASSOCIATE always sets .chemdraft's default to this build's ProgID just before this hook.
  ReadRegStr $ChemDraftAssociationOwnProgId SHCTX "Software\Classes\.chemdraft" ""
  ${If} $ChemDraftAssociationOwnProgId != ""
    WriteRegStr SHCTX "Software\Classes\$ChemDraftAssociationOwnProgId\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
    WriteRegStr SHCTX "${UNINSTKEY}" "ChemDraftAssociationProgId" "$ChemDraftAssociationOwnProgId"
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

; Record this build's ProgID (written by its installer) and the current owner, including a
; missing default value, before Tauri's APP_UNASSOCIATE restores its install-time backup.
!macro NSIS_HOOK_PREUNINSTALL
  ReadRegStr $ChemDraftAssociationOwnProgId SHCTX "${UNINSTKEY}" "ChemDraftAssociationProgId"
  StrCpy $ChemDraftAssociationHadDefault 0
  ClearErrors
  ReadRegStr $ChemDraftAssociationProgId SHCTX "Software\Classes\.chemdraft" ""
  ${IfNot} ${Errors}
    StrCpy $ChemDraftAssociationHadDefault 1
  ${EndIf}
!macroend

; Remove only what this installer registered. Another program's or the other ChemDraft build's
; ProgID, default and OpenWithProgids entries are never touched.
!macro NSIS_HOOK_POSTUNINSTALL
  ; Tauri's optional app-data removal switches the shell context to current.
  ; Restore the install scope before using SHCTX (especially for all-users).
  !insertmacro SetContext

  ; Someone claimed .chemdraft after this build did (another program or the other ChemDraft build):
  ; put that owner, or the missing default, back over APP_UNASSOCIATE's install-time backup.
  ${If} $ChemDraftAssociationHadDefault <> 1
    DeleteRegValue SHCTX "Software\Classes\.chemdraft" ""
  ${ElseIf} $ChemDraftAssociationProgId S!= $ChemDraftAssociationOwnProgId
    WriteRegStr SHCTX "Software\Classes\.chemdraft" "" "$ChemDraftAssociationProgId"
  ${Else}
    ; This build owned .chemdraft, so keep the owner APP_UNASSOCIATE restored from the backup,
    ; unless it is this build's own ProgID (a reinstall backs itself up), empty (nothing owned it),
    ; or a class that no longer exists in either hive (an owner uninstalled since).
    Push $0
    Push $1
    ReadRegStr $0 SHCTX "Software\Classes\.chemdraft" ""
    ${If} $0 S== $ChemDraftAssociationOwnProgId
    ${OrIf} $0 == ""
      DeleteRegValue SHCTX "Software\Classes\.chemdraft" ""
    ${Else}
      ClearErrors
      EnumRegKey $1 HKCR "$0" 0
      ${If} ${Errors}
        DeleteRegValue SHCTX "Software\Classes\.chemdraft" ""
      ${EndIf}
    ${EndIf}
    Pop $1
    Pop $0
  ${EndIf}

  ${If} $ChemDraftAssociationOwnProgId != ""
    DeleteRegKey SHCTX "Software\Classes\$ChemDraftAssociationOwnProgId"
    StrCpy $ChemDraftAssociationBackupName "_backup"
    StrCpy $ChemDraftAssociationBackupName "$ChemDraftAssociationOwnProgId$ChemDraftAssociationBackupName"
    DeleteRegValue SHCTX "Software\Classes\.chemdraft" "$ChemDraftAssociationBackupName"
    DeleteRegValue SHCTX "Software\Classes\.chemdraft\OpenWithProgids" "$ChemDraftAssociationOwnProgId"
  ${EndIf}

  !insertmacro ChemDraftDeleteRegKeyIfEmpty "Software\Classes\.chemdraft\OpenWithProgids"
  !insertmacro ChemDraftDeleteRegKeyIfEmpty "Software\Classes\.chemdraft"

  !insertmacro UPDATEFILEASSOC
!macroend
