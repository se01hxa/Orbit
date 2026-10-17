; Register Orbit as an available browser. The user's default remains their choice.
; In particular, never modify HTTP/HTTPS shell commands or UserChoice keys.

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh

  Var orbitShortcutDialog
  Var orbitDesktopCheckbox
  Var orbitCreateDesktopShortcut

  LangString OrbitOptionsTitle 1033 "Additional options"
  LangString OrbitOptionsTitle 1042 "추가 설정"
  LangString OrbitOptionsSubtitle 1033 "Choose how you would like to launch Orbit."
  LangString OrbitOptionsSubtitle 1042 "Orbit을 실행할 방법을 선택하세요."
  LangString OrbitDesktopLabel 1033 "Create a desktop icon for Orbit"
  LangString OrbitDesktopLabel 1042 "바탕화면 아이콘 만들기"
  LangString OrbitShortcutHint 1033 "You can also launch Orbit from the Start menu."
  LangString OrbitShortcutHint 1042 "시작 메뉴에서도 Orbit을 실행할 수 있어요."

  ; Extend the template's condition, keeping its native shortcut, icon, AUMI
  ; and uninstall handling. Unchecking skips creation instead of deleting a link.
  !macro _orbitNoDesktopShortcut _a _b _t _f
    ${StdUtils.TestParameter} $R9 "no-desktop-shortcut"
    StrCmp "$orbitCreateDesktopShortcut" "0" 0 +2
    StrCpy $R9 "true"
    StrCmp "$R9" "true" `${_t}` `${_f}`
  !macroend
  !undef isNoDesktopShortcut
  !define isNoDesktopShortcut `"" orbitNoDesktopShortcut ""`

  !macro customInit
    StrCpy $orbitCreateDesktopShortcut "1"
    ${StdUtils.TestParameter} $R9 "no-desktop-shortcut"
    ${If} $R9 == "true"
      StrCpy $orbitCreateDesktopShortcut "0"
    ${EndIf}
  !macroend

  !macro customPageAfterChangeDir
    Page custom OrbitShortcutsPage OrbitShortcutsPageLeave

    Function OrbitShortcutsPage
      ${If} ${isUpdated}
        Abort
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT "$(OrbitOptionsTitle)" "$(OrbitOptionsSubtitle)"
      nsDialogs::Create 1018
      Pop $orbitShortcutDialog
      ${If} $orbitShortcutDialog == error
        Abort
      ${EndIf}
      ${NSD_CreateCheckbox} 0 12u 100% 16u "$(OrbitDesktopLabel)"
      Pop $orbitDesktopCheckbox
      ${NSD_SetState} $orbitDesktopCheckbox $orbitCreateDesktopShortcut
      ${NSD_OnClick} $orbitDesktopCheckbox OrbitDesktopSelectionChanged
      ${StdUtils.TestParameter} $R9 "no-desktop-shortcut"
      ${If} $R9 == "true"
        EnableWindow $orbitDesktopCheckbox 0
      ${EndIf}
      ${NSD_CreateLabel} 12u 36u 95% 28u "$(OrbitShortcutHint)"
      Pop $0
      nsDialogs::Show
    FunctionEnd

    Function OrbitDesktopSelectionChanged
      Pop $0
      ${NSD_GetState} $0 $orbitCreateDesktopShortcut
    FunctionEnd

    Function OrbitShortcutsPageLeave
      ${NSD_GetState} $orbitDesktopCheckbox $orbitCreateDesktopShortcut
    FunctionEnd
  !macroend
!endif

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
  SetShellVarContext current

  WriteRegStr HKCU "Software\Classes\OrbitBrowserURL" "" "Orbit URL"
  WriteRegStr HKCU "Software\Classes\OrbitBrowserURL" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\OrbitBrowserURL\DefaultIcon" "" '"$INSTDIR\Orbit.exe",0'
  WriteRegStr HKCU "Software\Classes\OrbitBrowserURL\shell\open\command" "" '"$INSTDIR\Orbit.exe" "%1"'

  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Orbit" "" "Orbit"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Orbit\DefaultIcon" "" '"$INSTDIR\Orbit.exe",0'
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Orbit\shell\open\command" "" '"$INSTDIR\Orbit.exe"'
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Orbit\Capabilities" "ApplicationName" "Orbit"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Orbit\Capabilities" "ApplicationDescription" "Orbit browser with spaces, vertical tabs and picture-in-picture."
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Orbit\Capabilities" "ApplicationIcon" '"$INSTDIR\Orbit.exe",0'
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Orbit\Capabilities\Startmenu" "StartMenuInternet" "Orbit"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Orbit\Capabilities\URLAssociations" "http" "OrbitBrowserURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Orbit\Capabilities\URLAssociations" "https" "OrbitBrowserURL"
  WriteRegStr HKCU "Software\RegisteredApplications" "Orbit" "Software\Clients\StartMenuInternet\Orbit\Capabilities"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
!macroend

!macro customUnInstall
  ; Only remove entries that still point at this particular installation.
  ; Browser settings, site data, downloads and user files are intentionally kept.
  ReadRegStr $R0 HKCU "Software\Clients\StartMenuInternet\Orbit\shell\open\command" ""
  ${If} $R0 == '"$INSTDIR\Orbit.exe"'
    ReadRegStr $R1 HKCU "Software\RegisteredApplications" "Orbit"
    ${If} $R1 == "Software\Clients\StartMenuInternet\Orbit\Capabilities"
      DeleteRegValue HKCU "Software\RegisteredApplications" "Orbit"
    ${EndIf}
    DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Orbit"
  ${EndIf}

  ReadRegStr $R0 HKCU "Software\Classes\OrbitBrowserURL\shell\open\command" ""
  ${If} $R0 == '"$INSTDIR\Orbit.exe" "%1"'
    DeleteRegKey HKCU "Software\Classes\OrbitBrowserURL"
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
!macroend
