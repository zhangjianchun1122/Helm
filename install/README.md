# Helm 安装器

非技术用户一键安装 Helm 浏览器操作工具。

## 快速开始

1. **双击 `install.bat`** —— 完成
2. 打开 ZCode / Claude Desktop / Cursor，即可使用 helm 工具

就这么简单。

---

## 安装器做了什么

`install.bat` 会自动完成 6 步：

| 步骤 | 说明 |
|---|---|
| 1. 检测环境 | 确认 Node.js 18+ 和 Chrome 已安装 |
| 2. 安装依赖 | 网关的 npm 依赖（ws） |
| 3. 注册开机自启 | 在启动文件夹写入 VBS 脚本，登录时自动静默启动网关 |
| 4. 启动网关 | 立即运行网关（监听 127.0.0.1:8787） |
| 5. 加载扩展 | 自动启动 Chrome 并加载 Helm 扩展 |
| 6. 验证连通 | 确认扩展已连接网关 |

安装后，**每次开机登录时网关自动启动**，无需手动操作。

## 卸载

**双击 `uninstall.bat`**：

- 删除启动文件夹里的 VBS（取消开机自启）
- 关闭网关进程
- 打开 chrome://extensions 提示你手动移除扩展（Chrome 不支持命令行卸载扩展）

## 常见问题

### Q: 安装时提示「Chrome 正在运行，无法自动附加扩展」

Chrome 的限制：`--load-extension` 不能附加到正在运行的 Chrome 实例。

**解决**：关闭所有 Chrome 窗口后重新双击 `install.bat`；或在 chrome://extensions 手动「加载已解压的扩展程序」，选择 `extension/` 目录。

### Q: Side Panel 显示「未连接网关」

1. 确认网关在运行：打开终端输入 `curl http://127.0.0.1:8787/health`，应返回 `{"ok":true,...}`
2. 若网关未运行：双击 `install.bat` 重装，或手动运行 `node gateway/bridge-daemon.mjs`
3. 确认 Chrome 扩展已加载（chrome://extensions 里能看到 Helm）

### Q: 用了 nvm 切换 Node 版本后工具不工作了

nvm 切版本后，`node` 的真实路径变了，计划任务里的旧路径失效。

**解决**：重新双击 `install.bat`，安装器会用新路径更新计划任务。

### Q: 怎么确认网关在后台运行？

打开任务管理器，找 `node.exe` 进程，命令行含 `bridge-daemon.mjs` 的就是网关。

或检查启动项是否存在：
```
dir "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\HelmGateway.vbs"
```

### Q: 怎么手动启动/停止网关？

```bash
# 启动（手动触发启动项）
wscript "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\HelmGateway.vbs"

# 停止（双击 uninstall.bat，或按端口找进程）
# 在 PowerShell 中：
Get-NetTCPConnection -LocalPort 8787 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

# 或直接前台运行（调试用）
cd gateway
node bridge-daemon.mjs
```

## 文件说明

| 文件 | 作用 |
|---|---|
| `install.bat` | 安装入口（双击运行） |
| `install.ps1` | 安装主逻辑 |
| `uninstall.bat` | 卸载入口（双击运行） |
| `uninstall.ps1` | 卸载主逻辑 |
| `../gateway/bridge-daemon.mjs` | 网关常驻启动器（被计划任务调用） |

## 系统要求

- Windows 10 / 11
- Node.js 18+（[下载](https://nodejs.org)）
- Google Chrome
- 不需要管理员权限（启动文件夹是用户级，VBS 静默启动无需提权）
