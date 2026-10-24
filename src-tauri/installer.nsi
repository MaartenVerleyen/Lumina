Unicode true
ManifestDPIAware true

!include "MUI2.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

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

Name "${PRODUCTNAME}"
BrandingText "${MANUFACTURER} • ${PRODUCTNAME} v${VERSION}"
OutFile "${OUTFILE}"

; Default install directory
InstallDir "$PROGRAMFILES64\${PRODUCTNAME}"
InstallDirRegKey HKLM "Software\${MANUFACTURER}\${PRODUCTNAME}" "InstallDir"

; Request admin rights for perMachine installation
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!else
  RequestExecutionLevel user
!endif

!if "${PLUGINSPATH}" != ""
  !addplugindir "${PLUGINSPATH}"
!endif

; --- Lumina Obsidian Darkroom UI Theme (#090a0f / #0c0d14 / Emerald #10b981) ---
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

!define MUI_WELCOMEPAGE_TITLE "Welcome to ${PRODUCTNAME} v${VERSION} Studio Setup"
!define MUI_WELCOMEPAGE_TEXT "This wizard will install ${PRODUCTNAME} (${SHORTDESCRIPTION}) on your computer.$\r$\n$\r$\nBuilt by ${MANUFACTURER} with native Rust speed, SQLite WAL caching, ONNX Neural Face Recognition, and Local AI Vision.$\r$\n$\r$\nClick Next to continue."

!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_FINISHPAGE_RUN "$INSTDIR\${MAINBINARYNAME}.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${PRODUCTNAME} Studio"

; --- Pages ---
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

Section "Install" SEC01
  !if "${INSTALLMODE}" == "perMachine"
    SetShellVarContext all
  !else
    SetShellVarContext current
  !endif

  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}

  SetOutPath "$INSTDIR"
  SetOverwrite on

  ; Copy compiled Tauri release binary using Tauri's exact variable & output name
  File "/oname=${MAINBINARYNAME}.exe" "${MAINBINARYSRCPATH}"

  ; Copy any configured Tauri resources
  {{#each resources}}
    CreateDirectory "$INSTDIR\{{this.[1]}}"
    File /a "/oname={{this.[2]}}" "{{@key}}"
  {{/each}}

  ; Create Uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Create Desktop & Start Menu Shortcuts
  CreateShortCut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  CreateDirectory "$SMPROGRAMS\${PRODUCTNAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCTNAME}\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  CreateShortCut "$SMPROGRAMS\${PRODUCTNAME}\Uninstall ${PRODUCTNAME}.lnk" "$INSTDIR\uninstall.exe"

  ; Write Registry Keys for Windows Add/Remove Programs
  WriteRegStr HKLM "Software\${MANUFACTURER}\${PRODUCTNAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr HKLM "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr HKLM "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKLM "${UNINSTKEY}" "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${UNINSTKEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  !if "${INSTALLMODE}" == "perMachine"
    SetShellVarContext all
  !else
    SetShellVarContext current
  !endif

  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}

  Delete "$INSTDIR\${MAINBINARYNAME}.exe"
  {{#each resources}}
    Delete "$INSTDIR\{{this.[2]}}"
  {{/each}}
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCTNAME}\${PRODUCTNAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCTNAME}\Uninstall ${PRODUCTNAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCTNAME}"

  DeleteRegKey HKLM "${UNINSTKEY}"
  DeleteRegKey HKLM "Software\${MANUFACTURER}\${PRODUCTNAME}"
SectionEnd
