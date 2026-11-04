@echo off
setlocal
rem Double-click to install or upgrade graft. Keep install-graft-helper.ps1 in the same folder, plus optionally an
rem offline package nanonets-graft-X.Y.Z-win32-x64.tgz (the newest one is used; otherwise the npm registry)
rem and optionally an offline Node.js zip node-vX.Y.Z-win-x64.zip (the newest one is used when Node.js has to
rem be installed; otherwise the latest LTS is downloaded from nodejs.org and checked against its SHA-256).
rem It asks for agreement before changing anything; "START-HERE-install-graft.cmd -Yes" agrees up front (including the
rem download of LiteLLM's model price list with "graft prices update" after graft is installed).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-graft-helper.ps1" %*
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
