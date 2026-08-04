@echo off
REM start-gateway.bat — 网关启动包装器（供计划任务调用）
REM 切到网关目录后启动 bridge-daemon.mjs
cd /d "%~dp0"
node "%~dp0bridge-daemon.mjs"
