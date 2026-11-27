@echo off
REM Double-click to build the Multiband Viewer Windows installer.
REM First run installs Node.js, Rust and the C++ build tools (needs internet, ~3 GB, 10-30 min).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-windows.ps1"
echo.
pause
