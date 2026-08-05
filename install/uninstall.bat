@echo off
REM Helm 卸载器入口 —— 双击运行

set "SCRIPT_DIR=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '%SCRIPT_DIR%uninstall.ps1'"

echo.
pause
