Unicode true
ManifestDPIAware true

; Lumina's NSIS installer. Normally run silently by Lumina Setup (installer/), which shows the guided screens:
;   Lumina_x.y.z_x64-setup.exe /S /D=C:\path\to\Lumina [/NODESKTOP]
; It also works on its own as a plain installer. Installs for the current user (no administrator prompt).
; Lumina's updater runs it with /P /R /UPDATE: progress only (no pages), keep the install folder and the
; user's shortcut choice, and start Lumina again when done.

!include "MUI2.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define SHORTDESCRIPTION "{{short_description}}"
!define INSTALLMODE "{{install_mode}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define PLUGINSPATH "{{additional_plugins_path}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define APPKEY "Software\${MANUFACTURER}\${PRODUCTNAME}"
; WebView2 Evergreen runtime (the same GUID for every install; "pv" holds its version)
!define WEBVIEW2_GUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define BS "\"
!define WEBVIEW2_BOOTSTRAPPER "https://go.microsoft.com/fwlink/p/?LinkId=2124703"

Name "${PRODUCTNAME}"
BrandingText "${PRODUCTNAME} ${VERSION}"
OutFile "${OUTFILE}"

; Registry writes below use SHCTX, which follows SetShellVarContext: HKCU per user, HKLM per machine
!if "${INSTALLMODE}" == "perMachine"
  InstallDir "$PROGRAMFILES64\${PRODUCTNAME}"
  InstallDirRegKey HKLM "${APPKEY}" "InstallDir"
  RequestExecutionLevel admin
!else
  InstallDir "$LOCALAPPDATA\Programs\${PRODUCTNAME}"
  InstallDirRegKey HKCU "${APPKEY}" "InstallDir"
  RequestExecutionLevel user
!endif

!if "${PLUGINSPATH}" != ""
  !addplugindir "${PLUGINSPATH}"
!endif

!define MUI_ABORTWARNING
!define MUI_BGCOLOR "090A0F"
!define MUI_TEXTCOLOR "F1F5F9"
!define MUI_HEADERIMAGE
!define MUI_HEADER_TRANSPARENT_TEXT

!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
  !define MUI_UNICON "${INSTALLERICON}"
!else
  !define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
  !define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"
!endif

!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_BITMAP "${HEADERIMAGE}"
  !define MUI_HEADERIMAGE_UNBITMAP "${HEADERIMAGE}"
!endif

!if "${SIDEBARIMAGE}" != ""
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
  !define MUI_UNWELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
!endif

!define MUI_WELCOMEPAGE_TITLE "Install ${PRODUCTNAME} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "${PRODUCTNAME} sorts, searches and culls your photo library on your own PC.$\r$\n$\r$\nFor the guided setup that also installs the AI models, use Lumina Setup instead.$\r$\n$\r$\nClick Next to continue."

!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_FINISHPAGE_RUN "$INSTDIR\${MAINBINARYNAME}.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open ${PRODUCTNAME}"

Var PassiveMode
Var UpdateMode
Var Relaunch

!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipWhenUpdating
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipWhenUpdating
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipWhenPassive
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

!macro SetContext
  !if "${INSTALLMODE}" == "perMachine"
    SetShellVarContext all
  !else
    SetShellVarContext current
  !endif
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}
!macroend

; Lumina must not be running while its files are replaced or removed. Asks it to close (it saves as it goes),
; waits up to ~5 s; interactively the user can retry, silently the install stops with exit code 2.
!macro CloseLumina UN
  Function ${UN}CloseLumina
    StrCpy $R1 0
    loop:
      nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ${MAINBINARYNAME}.exe" /NH | find /I "${MAINBINARYNAME}.exe"'
      Pop $R0
      Pop $R2
      ${If} $R0 != 0
        Return
      ${EndIf}
      ${If} $R1 == 0
        nsExec::Exec 'taskkill /IM "${MAINBINARYNAME}.exe"'
      ${EndIf}
      IntOp $R1 $R1 + 1
      ${If} $R1 < 10
        Sleep 500
        Goto loop
      ${EndIf}
      IfSilent 0 +3
        SetErrorLevel 2
        Quit
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCTNAME} is still open. Close it and click Retry." IDRETRY retry
      Quit
    retry:
      StrCpy $R1 1
      Goto loop
  FunctionEnd
!macroend
!insertmacro CloseLumina ""
!insertmacro CloseLumina "un."

; Lumina's window is a WebView2 control. Windows 11 ships the runtime; older systems get it from Microsoft.
Function EnsureWebView2
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_GUID}" "pv"
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_GUID}" "pv"
  ${EndIf}
  ${If} $0 != ""
  ${AndIf} $0 != "0.0.0.0"
    Return
  ${EndIf}
  DetailPrint "Installing the Microsoft Edge WebView2 runtime..."
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri ''${WEBVIEW2_BOOTSTRAPPER}'' -OutFile ''$TEMP\MicrosoftEdgeWebview2Setup.exe''"'
  Pop $0
  ${If} ${FileExists} "$TEMP\MicrosoftEdgeWebview2Setup.exe"
    ExecWait '"$TEMP\MicrosoftEdgeWebview2Setup.exe" /silent /install' $0
    Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
  ${Else}
    DetailPrint "Could not download WebView2. Install it from https://developer.microsoft.com/microsoft-edge/webview2/"
  ${EndIf}
FunctionEnd

Function .onInit
  !insertmacro SetContext
  ; Updater flags: /P passive (progress only), /UPDATE (an update of an existing install), /R (start Lumina after)
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/P" $1
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/UPDATE" $1
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/R" $1
  ${IfNot} ${Errors}
    StrCpy $Relaunch 1
  ${EndIf}
FunctionEnd

Function SkipWhenUpdating
  ${If} $PassiveMode == 1
  ${OrIf} $UpdateMode == 1
    Abort
  ${EndIf}
FunctionEnd

Function SkipWhenPassive
  ${If} $PassiveMode == 1
    Abort
  ${EndIf}
FunctionEnd

Function .onInstSuccess
  ${If} $Relaunch == 1
    Exec '"$INSTDIR\${MAINBINARYNAME}.exe"'
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext
FunctionEnd

Section "Install" SEC01
  ${If} $PassiveMode == 1
    SetAutoClose true
  ${EndIf}
  Call CloseLumina
  Call EnsureWebView2

  SetOutPath "$INSTDIR"
  SetOverwrite on
  File "/oname=${MAINBINARYNAME}.exe" "${MAINBINARYSRCPATH}"

  ; Resources (DirectML.dll): the key is the source, [0] the target folder, [1] the target path.
  ; ${BS} instead of a backslash: a backslash right before a template tag would escape it.
  {{#each resources}}
    CreateDirectory "$INSTDIR${BS}{{this.[0]}}"
    File /a "/oname={{this.[1]}}" "{{@key}}"
  {{/each}}

  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Desktop shortcut unless the setup was asked not to make one (/NODESKTOP); an update keeps the user's
  ; choice (it refreshes an existing shortcut but never brings back one that was deleted)
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/NODESKTOP" $1
  ${If} ${Errors}
    ${If} $UpdateMode != 1
    ${OrIf} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
      CreateShortCut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    ${EndIf}
  ${EndIf}
  CreateShortCut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"

  WriteRegStr SHCTX "${APPKEY}" "InstallDir" "$INSTDIR"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  Call un.CloseLumina

  Delete "$INSTDIR\${MAINBINARYNAME}.exe"
  {{#each resources}}
    Delete "$INSTDIR${BS}{{this.[1]}}"
  {{/each}}
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ; Shortcuts from versions before 3.6 lived in a Start menu folder
  Delete "$SMPROGRAMS\${PRODUCTNAME}\${PRODUCTNAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCTNAME}\Uninstall ${PRODUCTNAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCTNAME}"

  DeleteRegKey SHCTX "${UNINSTKEY}"
  DeleteRegKey SHCTX "${APPKEY}"

  ; The library data (database, thumbnails, face and search models) is kept unless the user asks.
  ; Photos themselves are never touched. A silent uninstall always keeps it.
  IfSilent done
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also remove ${PRODUCTNAME}'s library data?$\r$\n$\r$\nThis deletes the database (names, ratings, albums, captions), the thumbnails and the downloaded face and search models. Your photos are not touched." IDNO done
  RMDir /r "$LOCALAPPDATA\${BUNDLEID}"
  done:
SectionEnd
