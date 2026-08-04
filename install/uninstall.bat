@echo off
chcp 65001 >nul 2>&1
REM Helm 卸载器入口 —— 双击运行

set "SCRIPT_DIR=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%uninstall.ps1"

echo.
pause
