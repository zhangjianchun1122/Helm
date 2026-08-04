@echo off
chcp 65001 >nul 2>&1
REM Helm 安装器入口 —— 双击运行
REM 调起同目录下的 install.ps1，绕过执行策略限制

set "SCRIPT_DIR=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1"

echo.
pause
