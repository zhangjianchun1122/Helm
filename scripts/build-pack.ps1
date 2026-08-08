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
# 打包根目录用 Helm/，这样解压时所有文件都在 Helm/ 文件夹下
$PKG_DIR = Join-Path $STAGE_DIR 'Helm'
New-Item -ItemType Directory -Path $PKG_DIR -Force | Out-Null
Write-Ok "暂存目录: $STAGE_DIR"

# ---------- 2. 收集文件 ----------

# gateway/ — 排除 node_modules、test-*.mjs、verify-e2e.mjs、audit-log.txt
Write-Step '收集 gateway/'
$gwSrc = Join-Path $PROJECT_ROOT 'gateway'
$gwDst = Join-Path $PKG_DIR 'gateway'
New-Item -ItemType Directory -Path $gwDst -Force | Out-Null
$gwFiles = @(
    'bridge.mjs', 'bridge-daemon.mjs', 'mcp-server.mjs', 'http-server.mjs',
    'tools-def.mjs', 'tool-executor.mjs', 'permissions.mjs', 'start-gateway.bat', 'package.json', 'package-lock.json'
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
$securitySrc = Join-Path $gwSrc 'security'
if (Test-Path $securitySrc) {
    Copy-Item $securitySrc (Join-Path $gwDst 'security') -Recurse -Force
    Write-Info "  + security/"
}

# extension/ — 完整复制
Write-Step '收集 extension/'
$extSrc = Join-Path $PROJECT_ROOT 'extension'
$extDst = Join-Path $PKG_DIR 'extension'
Copy-Item $extSrc $extDst -Recurse -Force
$extCount = (Get-ChildItem $extDst -Recurse -File).Count
Write-Ok "extension/ ($extCount 个文件)"

# install/ — 完整复制
Write-Step '收集 install/'
$instSrc = Join-Path $PROJECT_ROOT 'install'
$instDst = Join-Path $PKG_DIR 'install'
Copy-Item $instSrc $instDst -Recurse -Force
$instCount = (Get-ChildItem $instDst -Recurse -File).Count
Write-Ok "install/ ($instCount 个文件)"

# ---------- 3. 写入顶层 README.txt ----------
Write-Step '写入 README.txt'
$readmeContent = @"
Helm — Pilot your web v$Version
================================

在你的真实浏览器里让 AI 自动完成点击/输入/下载等操作，不用重新登录，不被识别为机器。

安装步骤：
  1. 确保已安装 Node.js 18+（https://nodejs.org）
  2. 解压本压缩包到任意目录
  3. 双击 install\install.bat
  4. 安装器会自动完成：安装依赖 → 注册开机自启 → 启动网关 → 打开 Chrome 扩展页
  5. 在 Chrome 扩展页中手动加载扩展（约 10 秒）：
     a. 确认右上角"开发者模式"已开启
     b. 点击"加载已解压的扩展程序"
     c. 选择解压目录下的 extension 文件夹
  6. 安装完成后，install.bat 会打印各 Agent 的 MCP 配置片段，复制到你的 Agent 配置文件中即可使用

注：Chrome MV3 不允许命令行自动加载扩展到已有 profile，步骤 5 需手动操作。

卸载：双击 install\uninstall.bat（扩展需在 chrome://extensions 手动移除）

问题排查：见 install\README.md
"@
$readmePath = Join-Path $PKG_DIR 'README.txt'
# 用 .NET WriteAllText 写 UTF-8 with BOM，避免 PowerShell 5.1 的 Set-Content 编码 bug
$utf8Bom = New-Object System.Text.UTF8Encoding $true
[System.IO.File]::WriteAllText($readmePath, $readmeContent, $utf8Bom)
Write-Ok 'README.txt'

# ---------- 4. 打包 ZIP ----------
Write-Step '打包 ZIP'
if (Test-Path $ZIP_PATH) { Remove-Item $ZIP_PATH -Force }
Compress-Archive -Path $PKG_DIR -DestinationPath $ZIP_PATH -CompressionLevel Optimal
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
