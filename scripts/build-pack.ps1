#Requires -Version 5.1
<#
.SYNOPSIS
  Helm 便携包打包脚本
.DESCRIPTION
  收集 gateway/ + extension/ + install/ 中的必要文件，
  排除测试、文档、node_modules、downloads 等，打成 ZIP 便携包。
  产物：dist/Helm-Portable-<version>.zip
.EXAMPLE
  powershell -File scripts/build-pack.ps1
  powershell -File scripts/build-pack.ps1 -Version 0.2.0
#>

param(
    [string]$Version = '0.1.0'
)

$ErrorActionPreference = 'Stop'
$PROJECT_ROOT = (Resolve-Path "$PSScriptRoot\..").Path
$DIST_DIR = Join-Path $PROJECT_ROOT 'dist'
$ZIP_NAME = "Helm-Portable-$Version.zip"
$ZIP_PATH = Join-Path $DIST_DIR $ZIP_NAME
$STAGE_DIR = Join-Path $DIST_DIR 'stage'

# ---------- 辅助函数 ----------
function Write-Info($msg) { Write-Host "  $msg" -ForegroundColor DarkGray }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Step($msg){ Write-Host "`n== $msg" -ForegroundColor Cyan }

# ---------- 开始 ----------
Write-Host "`n========================================" -ForegroundColor White
Write-Host "  Helm 便携包打包器 v$Version" -ForegroundColor White
Write-Host "========================================" -ForegroundColor White

# ---------- 1. 准备暂存目录 ----------
Write-Step '准备暂存目录'
if (Test-Path $STAGE_DIR) { Remove-Item $STAGE_DIR -Recurse -Force }
if (Test-Path $DIST_DIR) { } else { New-Item -ItemType Directory -Path $DIST_DIR -Force | Out-Null }
New-Item -ItemType Directory -Path $STAGE_DIR -Force | Out-Null
Write-Ok "暂存目录: $STAGE_DIR"

# ---------- 2. 收集文件 ----------

# gateway/ — 排除 node_modules、test-*.mjs、verify-e2e.mjs、audit-log.txt
Write-Step '收集 gateway/'
$gwSrc = Join-Path $PROJECT_ROOT 'gateway'
$gwDst = Join-Path $STAGE_DIR 'gateway'
New-Item -ItemType Directory -Path $gwDst -Force | Out-Null
$gwFiles = @(
    'bridge.mjs', 'bridge-daemon.mjs', 'mcp-server.mjs', 'http-server.mjs',
    'tools-def.mjs', 'start-gateway.bat', 'package.json', 'package-lock.json'
)
foreach ($f in $gwFiles) {
    $src = Join-Path $gwSrc $f
    if (Test-Path $src) {
        Copy-Item $src $gwDst -Force
        Write-Info "  + $f"
    } else {
        Write-Info "  ! 跳过（不存在）: $f"
    }
}

# extension/ — 完整复制
Write-Step '收集 extension/'
$extSrc = Join-Path $PROJECT_ROOT 'extension'
$extDst = Join-Path $STAGE_DIR 'extension'
Copy-Item $extSrc $extDst -Recurse -Force
$extCount = (Get-ChildItem $extDst -Recurse -File).Count
Write-Ok "extension/ ($extCount 个文件)"

# install/ — 完整复制
Write-Step '收集 install/'
$instSrc = Join-Path $PROJECT_ROOT 'install'
$instDst = Join-Path $STAGE_DIR 'install'
Copy-Item $instSrc $instDst -Recurse -Force
$instCount = (Get-ChildItem $instDst -Recurse -File).Count
Write-Ok "install/ ($instCount 个文件)"

# ---------- 3. 写入顶层 README.txt ----------
Write-Step '写入 README.txt'
$readmeContent = @"
Helm - Pilot your web v$Version
================================

Let AI autonomously operate your real browser - click, type, download,
without re-login, undetected by anti-bot systems.

Install:
  1. Install Node.js 18+ (https://nodejs.org)
  2. Extract this zip to any folder
  3. Double-click install\install.bat
  4. Follow the prompts (auto-start on boot + load Chrome extension)

After install, install.bat prints MCP config snippets for each Agent.
Copy the snippet into your Agent's config file to start using.

Uninstall: Double-click install\uninstall.bat

Troubleshooting: See install\README.md
"@
$readmePath = Join-Path $STAGE_DIR 'README.txt'
# ASCII encoding to avoid garbled text on Windows Notepad
Set-Content -Path $readmePath -Value $readmeContent -Encoding ASCII
Write-Ok 'README.txt'

# ---------- 4. 打包 ZIP ----------
Write-Step '打包 ZIP'
if (Test-Path $ZIP_PATH) { Remove-Item $ZIP_PATH -Force }
Compress-Archive -Path (Join-Path $STAGE_DIR '*') -DestinationPath $ZIP_PATH -CompressionLevel Optimal
$zipSize = [math]::Round((Get-Item $ZIP_PATH).Length / 1KB, 1)
Write-Ok "$ZIP_PATH ($zipSize KB)"

# ---------- 5. 清理暂存 ----------
Remove-Item $STAGE_DIR -Recurse -Force

# ---------- 总结 ----------
$totalFiles = (Get-ChildItem $ZIP_PATH).Count
Write-Host "`n========================================" -ForegroundColor White
Write-Host "  打包完成" -ForegroundColor White
Write-Host "========================================" -ForegroundColor White
Write-Ok "产物: $ZIP_PATH"
Write-Ok "大小: $zipSize KB"
Write-Host ""
Write-Host "  部署方式：拷贝 ZIP 到目标主机 → 解压 → 双击 install\install.bat" -ForegroundColor DarkGray
Write-Host ""
exit 0
