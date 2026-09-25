@echo off
setlocal
rem wxemoticon installer (Windows, native cmd; requires Windows 10 1803+ for curl.exe/tar.exe)
rem
rem Usage (cmd):
rem   curl -fsSL https://raw.githubusercontent.com/liusheng22/export-wechat-emoji/main/scripts/install-wxemoticon.cmd -o "%TEMP%\install-wxemoticon.cmd" && "%TEMP%\install-wxemoticon.cmd"
rem
rem Options (environment variables):
rem   WXEMOTICON_REPO            default: liusheng22/export-wechat-emoji
rem   WXEMOTICON_DOWNLOAD_BASE   default: https://github.com (mirror override)
rem   INSTALL_DIR                default: %LOCALAPPDATA%\Programs\wxemoticon
rem   WXEMOTICON_VERSION         default: latest
rem   WXEMOTICON_NO_PATH_MODIFY  set to skip adding INSTALL_DIR to the user PATH
rem
rem NOTE: keep this file ASCII-only and CRLF.

if not defined WXEMOTICON_REPO set "WXEMOTICON_REPO=liusheng22/export-wechat-emoji"
if not defined WXEMOTICON_DOWNLOAD_BASE set "WXEMOTICON_DOWNLOAD_BASE=https://github.com"
if not defined INSTALL_DIR set "INSTALL_DIR=%LOCALAPPDATA%\Programs\wxemoticon"
if not defined WXEMOTICON_VERSION set "WXEMOTICON_VERSION=latest"

rem Pin curl/tar to System32 so user PATH (e.g. Git Bash GNU tar) cannot
rem shadow them: GNU tar rejects "C:\..." paths and zip archives.
set "CURL=%SystemRoot%\System32\curl.exe"
set "TAR=%SystemRoot%\System32\tar.exe"
if not exist "%CURL%" (echo error: curl.exe not found in System32 ^(requires Windows 10 1803+^)& exit /b 1)
if not exist "%TAR%" (echo error: tar.exe not found in System32 ^(requires Windows 10 1803+^)& exit /b 1)

if "%WXEMOTICON_VERSION%"=="latest" (
  set "URL=%WXEMOTICON_DOWNLOAD_BASE%/%WXEMOTICON_REPO%/releases/latest/download/wxemoticon-x86_64-windows.zip"
) else (
  set "URL=%WXEMOTICON_DOWNLOAD_BASE%/%WXEMOTICON_REPO%/releases/download/%WXEMOTICON_VERSION%/wxemoticon-x86_64-windows.zip"
)

set "TMPDIR=%TEMP%\wxemoticon-%RANDOM%"
mkdir "%TMPDIR%" || exit /b 1

echo download: %URL%
"%CURL%" -fsSL --retry 3 -o "%TMPDIR%\wxemoticon.zip" "%URL%" || (echo error: download failed& exit /b 1)

"%TAR%" -xf "%TMPDIR%\wxemoticon.zip" -C "%TMPDIR%" || (echo error: extract failed& exit /b 1)

if not exist "%TMPDIR%\wxemoticon.exe" (echo error: wxemoticon.exe not found in package& exit /b 1)

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%" || exit /b 1

rem Windows does not allow overwriting a running exe, but renaming it is fine:
rem move the old binary aside so that "wxemoticon update" (which runs this script
rem as a child of the running exe) can replace it safely.
if exist "%INSTALL_DIR%\wxemoticon.exe" (
  move /y "%INSTALL_DIR%\wxemoticon.exe" "%INSTALL_DIR%\wxemoticon.exe.old" >nul || (echo error: cannot move old wxemoticon.exe& exit /b 1)
)
copy /y "%TMPDIR%\wxemoticon.exe" "%INSTALL_DIR%\wxemoticon.exe" >nul || (echo error: copy failed& exit /b 1)
rem Best-effort cleanup; the .old file may still be locked by the running
rem process and is harmless to leave behind (next update cleans it up).
if exist "%INSTALL_DIR%\wxemoticon.exe.old" del /q "%INSTALL_DIR%\wxemoticon.exe.old" >nul 2>nul

echo installed: %INSTALL_DIR%\wxemoticon.exe
echo verify: wxemoticon --help

if defined WXEMOTICON_NO_PATH_MODIFY (
  echo skipped PATH modification ^(WXEMOTICON_NO_PATH_MODIFY is set^)
  goto :cleanup
)

set "USER_PATH="
for /f "skip=2 tokens=2,*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%b"

if defined USER_PATH (
  echo ;%USER_PATH%; | find /i ";%INSTALL_DIR%;" >nul && (
    echo PATH already contains %INSTALL_DIR%
    goto :cleanup
  )
)

if not defined USER_PATH (
  set "NEW_PATH=%INSTALL_DIR%"
) else (
  set "NEW_PATH=%USER_PATH%;%INSTALL_DIR%"
)

reg add "HKCU\Environment" /v Path /t REG_EXPAND_SZ /d "%NEW_PATH%" /f >nul || (
  echo warn: failed to update user PATH, add %INSTALL_DIR% manually
  goto :cleanup
)
echo added %INSTALL_DIR% to user PATH ^(takes effect in new terminals^)

:cleanup
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%"
endlocal
