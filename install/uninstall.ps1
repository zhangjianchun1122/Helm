#Requires -Version 5.1
<#
.SYNOPSIS
  Helm 浏览器操作工具 —— 一键卸载器
.DESCRIPTION
  1. 停止并删除计划任务 HelmGateway（取消开机自启）
  2. 关闭正在运行的网关进程
  3. 提示用户在 Chrome 手动移除扩展
#>

$ErrorActionPreference = 'Continue'
$GATEWAY_PORT = 8787
$STARTUP_DIR = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft\Windows\Start Menu\Programs\Startup'
$VBS_NAME = 'HelmGateway.vbs'

function Write-Ok($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "  $msg" -ForegroundColor DarkGray }

Write-Host "`n========================================" -ForegroundColor White
Write-Host "  Helm 卸载器" -ForegroundColor White
Write-Host "========================================" -ForegroundColor White

# ---------- 1. 移除开机自启（删除启动文件夹里的 VBS）----------

Write-Host "`n[1/3] 移除开机自启`n" -ForegroundColor Cyan

$vbsPath = Join-Path $STARTUP_DIR $VBS_NAME
if (Test-Path $vbsPath) {
    Remove-Item $vbsPath -Force
    Write-Ok "启动项已删除 ($vbsPath)"
} else {
    Write-Info '未找到启动项（可能已卸载或从未安装）'
}

# 兼容：若旧版安装器曾创建过计划任务，一并清理
$prevPref = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
schtasks /End /TN 'HelmGateway' 2>&1 | Out-Null
schtasks /Delete /TN 'HelmGateway' /F 2>&1 | Out-Null
$ErrorActionPreference = $prevPref

# ---------- 2. 关闭网关进程 ----------

Write-Host "`n[2/3] 关闭网关进程`n" -ForegroundColor Cyan

# 通过端口找进程并杀掉
$killed = $false
try {
    $conns = Get-NetTCPConnection -LocalPort $GATEWAY_PORT -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
        foreach ($conn in $conns) {
            $pid_ = $conn.OwningProcess
            if ($pid_) {
                $proc = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
                if ($proc) {
                    Stop-Process -Id $pid_ -Force -ErrorAction SilentlyContinue
                    Write-Ok "已终止网关进程: $($proc.ProcessName) (PID=$pid_)"
                    $killed = $true
                }
            }
        }
    }
} catch {}

if (-not $killed) {
    # 兜底：按命令行匹配 node bridge-daemon
    $daemonProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*bridge-daemon*' }
    foreach ($p in $daemonProcs) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Ok "已终止网关进程 (PID=$($p.ProcessId))"
        $killed = $true
    }
}

if (-not $killed) {
    Write-Info '未检测到正在运行的网关进程'
}

# ---------- 3. 提示移除扩展 ----------

Write-Host "`n[3/3] Chrome 扩展`n" -ForegroundColor Cyan

Write-Warn 'Chrome 扩展无法通过命令行自动卸载，请手动移除：'
Write-Info ''
Write-Info '  1. 在 Chrome 地址栏输入 chrome://extensions'
Write-Info '  2. 找到 "Helm — Pilot your web"'
Write-Info '  3. 点击"移除"'
Write-Info ''
Write-Info '正在为你打开 chrome://extensions ...'

$chromePath = $null
$chromeCandidates = @(
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
)
foreach ($p in $chromeCandidates) {
    if (Test-Path $p) { $chromePath = $p; break }
}
if ($chromePath) {
    Start-Process $chromePath 'chrome://extensions'
}

# ---------- 总结 ----------

Write-Host "`n========================================" -ForegroundColor White
Write-Host "  卸载完成" -ForegroundColor White
Write-Host "========================================" -ForegroundColor White
Write-Host ""
Write-Host "  开机自启已移除，网关进程已停止。" -ForegroundColor Green
Write-Host "  请按上方提示在 Chrome 手动移除扩展。" -ForegroundColor Yellow
Write-Host ""
Write-Host "  项目文件未删除（位于 $(Split-Path $PSScriptRoot -Parent)）。" -ForegroundColor DarkGray
Write-Host "  如需彻底删除，手动删除整个项目目录即可。`n" -ForegroundColor DarkGray

exit 0
