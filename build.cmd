@echo off
cd /d "%~dp0"
call npm run build
if errorlevel 1 (echo BUILD FAILED & pause & exit /b 1)
pause