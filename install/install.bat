@echo off
REM Helm 安装器入口 —— 双击运行

set "SCRIPT_DIR=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '%SCRIPT_DIR%install.ps1'"

echo.
pause
