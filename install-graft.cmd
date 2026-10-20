@echo off
setlocal
rem Double-click to install or upgrade graft. Keep install-graft.ps1 in the same folder, plus optionally an
rem offline package nanonets-graft-X.Y.Z-win32-x64.tgz (the newest one is used; otherwise the npm registry).
rem It asks for agreement before changing anything; "install-graft.cmd -Yes" agrees up front.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-graft.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo graft installation finished.
) else if "%RC%"=="2" (
  echo graft installation cancelled. Nothing was changed.
) else (
  echo graft installation FAILED ^(exit code %RC%^). See the messages above.
)
pause
exit /b %RC%
