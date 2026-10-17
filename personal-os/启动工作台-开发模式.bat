@echo off
title Personal Workbench
cd /d "%~dp0"

echo.
echo   ============================================
echo    Personal Workbench - starting...
echo   ============================================
echo.
echo    First launch compiles Rust and takes several
echo    minutes. Later launches are much faster.
echo.
echo    To close the app: Ctrl+C in this window,
echo    or right-click the tray icon -^> Quit.
echo.
echo   ============================================
echo.

npm run tauri:dev

echo.
echo   Closed. Press any key to close this window.
pause >nul
