<div align="center">

<img src="assets/helm-wordmark.svg" width="360" alt="Helm — Pilot your web">

<h1>Helm</h1>

<h3>让 AI 在你真实浏览器里自主操作——点击、输入、下载，无需重登，不被识别为机器</h3>

[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue)](https://github.com/zhangjianchun1122/browser-tool)
[![Chrome](https://img.shields.io/badge/Chrome-MV3-4285F4)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![MCP](https://img.shields.io/badge/protocol-MCP-0F766E)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org)

</div>

---

## 这是什么

Helm 是一个**通用浏览器操作工具**。你用自然语言下达指令，AI Agent 自主规划操作序列，Helm 在你**日常使用的、已登录的浏览器**里按序执行——复用你的 Cookie/会话，隐蔽性最好，不被反爬检测识别。

它**不针对任何特定网站**。Agent 根据实时页面快照动态决策，PMS 文档下载、Wikipedia 信息抓取、任何站点的表单提交……都是同一个工具集的不同组合。

```
你："用账号 A 登录 xx.com，下载最新报表"
  → Agent 规划：navigate → fill(账号) → fill(密码) → click(登录)
               → wait → get_snapshot → click(报表) → download
  → Helm 逐步执行，Side Panel 实时展示动作流
```

## 为什么用 Helm

| 对比 | Helm（Chrome 扩展） | Playwright/Puppeteer | 手动操作 |
|---|---|---|---|
| 复用已登录会话 | ✅ 日常浏览器自带 | ❌ 每次重登 | ✅ |
| 自动化检测 | ✅ 真实 profile，最隐蔽 | ❌ webdriver 痕迹明显 | — |
| 跨 iframe 操作 | ✅ all_frames 注入 | ✅ | 手动 |
| Agent 接入 | ✅ MCP 标准 | 需自封装 | — |
| 任意路径下载 | ✅ 网关 fetch + 扩展兜底 | ✅ | 手动 |
| 安装成本 | 中（扩展 + 网关） | 低 | — |

## 架构

```
Agent（ZCode / Claude Code / Qwen / Hermes / Codex）
  │  MCP stdio（JSON-RPC）
  ▼
mcp-server.mjs ──invoke──▶ bridge.mjs（WS :8787，常驻后台）
                                │  WebSocket
                                ▼
                     Chrome 扩展（MV3）
                      ├─ offscreen.js    长连接保活
                      ├─ sw.js           路由调度 + chrome.debugger
                      ├─ dom-agent.js    DOM 探查与操作（all_frames）
                      └─ sidepanel.js    动作流 + 高危确认 UI
                                │
                                ▼
                     用户真实浏览器页面
```

**关键设计**：MV3 Service Worker 约 30s 被回收，长连接和状态放在 Offscreen Document 与网关进程里，SW 保持无状态可随时重建。多个 Agent 同时使用时，各自 spawn 的 mcp-server 走附属模式连同一个常驻 bridge，互不干扰。

## 21 个工具

### 感知类
| 工具 | 作用 |
|---|---|
| `get_snapshot` | 返回页面可交互元素快照（ref/tag/text/attrs），Agent 用 ref 引用元素，不写 CSS 选择器 |
| `list_tabs` | 列出 Chrome 所有标签页 |
| `list_frames` | 枚举当前页所有 iframe（跨 iframe 操作基础） |
| `get_text` | 读取元素纯文本 |

### 操作类
| 工具 | 作用 |
|---|---|
| `navigate` | 打开 URL，等待加载完成 |
| `click` / `right_click` | 左键点击 / 真实右键（chrome.debugger isTrusted） |
| `fill` | 输入文本 |
| `press` | 键盘事件（Enter / Esc / 快捷键） |
| `scroll` | 滚动到元素 / 方向滚动 |
| `hover` | 悬停（触发菜单 / tooltip） |
| `drag` | 拖拽（双协议：鼠标序列 + HTML5 DnD） |

### 流程控制类
| 工具 | 作用 |
|---|---|
| `wait` | 等待文本出现/消失、选择器匹配、DOM 静止（SW 轮询，超时返回 false 不抛错） |
| `set_active_frame` / `get_active_frame` | 切换 iframe 作用域 |
| `eval` | 执行任意 JS（MAIN world 注入，绕过扩展 CSP，所有站点可用） |
| `screenshot` | 截图（base64 PNG/JPEG） |

### 产物类
| 工具 | 作用 |
|---|---|
| `download` | 下载文件（三级 fallback：网关 fetch → 扩展 chrome.downloads → 搬运） |
| `save_file` / `read_file` / `list_files` | 本地文件读写（网关 Node fs 直写） |

## 快速开始

### 方式一：一键安装（推荐）

1. 下载 [Helm-Portable-0.1.0.zip](../../releases)
2. 解压到任意目录
3. 双击 `install/install.bat`

安装器自动完成：检测环境 → 安装依赖 → 注册开机自启 → 启动网关 → 加载 Chrome 扩展 → 验证连通。安装完成后会打印各 Agent 的 MCP 配置片段，复制即可使用。

### 方式二：从源码安装

```bash
git clone https://github.com/zhangjianchun1122/browser-tool.git
cd browser-tool
cd gateway && npm install
```

然后双击 `install/install.bat`，或手动启动网关：

```bash
node gateway/bridge-daemon.mjs
```

在 Chrome `chrome://extensions` 开启开发者模式，加载 `extension/` 目录。

### 接入 Agent

Helm 通过 MCP stdio 暴露工具，任何支持 MCP 的 Agent 直接配置即可：

<details>
<summary><b>ZCode</b> — <code>~/.zcode/cli/config.json</code></summary>

```json
{
  "mcp": {
    "servers": {
      "browser-tool": {
        "type": "stdio",
        "command": "node",
        "args": ["/path/to/browser-tool/gateway/mcp-server.mjs"]
      }
    }
  }
}
```
</details>

<details>
<summary><b>Claude Code</b> — <code>.mcp.json</code></summary>

```json
{
  "mcpServers": {
    "browser-tool": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/browser-tool/gateway/mcp-server.mjs"]
    }
  }
}
```
</details>

<details>
<summary><b>Qwen CLI</b> — <code>~/.qwen/settings.json</code></summary>

```json
{
  "mcpServers": {
    "browser-tool": {
      "command": "node",
      "args": ["/path/to/browser-tool/gateway/mcp-server.mjs"]
    }
  }
}
```
</details>

<details>
<summary><b>Hermes Agent</b> — <code>%LOCALAPPDATA%/hermes/config.yaml</code></summary>

```yaml
mcp_servers:
  browser-tool:
    command: "node"
    args: ["/path/to/browser-tool/gateway/mcp-server.mjs"]
```
</details>

<details>
<summary><b>Codex CLI</b> — <code>~/.codex/config.toml</code></summary>

```toml
[mcp_servers.browser-tool]
command = "node"
args = ["/path/to/browser-tool/gateway/mcp-server.mjs"]
```
> Codex 有内置浏览器工具，在 Codex 中建议使用其自带工具。
</details>

<details>
<summary><b>非 MCP 智能体 / 自研 Agent（HTTP 接入）</summary>

```bash
# 启动 HTTP 端点
HELM_API_KEY=mykey node gateway/http-server.mjs --port 8788

# 获取工具清单
curl -H "Authorization: Bearer mykey" http://127.0.0.1:8788/v1/tools

# 调用工具
curl -X POST -H "Authorization: Bearer mykey" -H "Content-Type: application/json" \
  -d '{"name":"list_tabs","arguments":{}}' \
  http://127.0.0.1:8788/v1/tools/call
```
</details>

## 安全设计

Helm 在用户真实浏览器里操作，安全是核心关切。三层防护：

| 层 | 机制 | 说明 |
|---|---|---|
| **Agent 会话授权** | 工具默认信任不阻塞 | 用户在会话中下达意图即隐含授权，工具自主执行 |
| **高危动作确认** | download/eval/save_file 弹确认卡 | Side Panel 橙色卡片，30s 无响应自动拒绝（安全侧倒） |
| **审计日志** | 所有高危操作记录 | `gateway/audit-log.txt`，JSON 格式，含时间/工具/参数/结果 |

加上 Side Panel 动作流可视化 + 页面琥珀发光边框，用户随时知道 Agent 在干什么，可随时介入。

## 项目结构

```
browser-tool/
├─ extension/              # Chrome 扩展（MV3，站点无关）
│  ├─ manifest.json
│  ├─ sw.js                # Service Worker：路由调度 + chrome.debugger
│  ├─ offscreen.js         # Offscreen Document：WebSocket 长连接保活
│  ├─ sidepanel.js         # 动作流 + 高危确认 UI
│  └─ content/dom-agent.js # DOM 探查与操作（注入各 frame）
├─ gateway/                # 本地网关
│  ├─ mcp-server.mjs       # MCP Server（stdio，主接入协议）
│  ├─ http-server.mjs      # HTTP 端点（非 MCP Agent 兜底）
│  ├─ bridge.mjs           # WebSocket 桥（主/附属模式自动切换）
│  ├─ bridge-daemon.mjs    # 常驻启动器（开机自启用）
│  ├─ tools-def.mjs        # 21 个工具定义 + 映射（共享模块）
│  └─ start-gateway.bat    # 启动包装器
├─ install/                # 一键安装/卸载器
│  ├─ install.bat / install.ps1
│  ├─ uninstall.bat / uninstall.ps1
│  └─ README.md
├─ scripts/
│  └─ build-pack.ps1       # 打包脚本（生成可分发 ZIP）
└─ docs/                   # 设计文档
```

## 系统要求

- **Windows** 10 / 11
- **Node.js** 18+
- **Google Chrome**

不需要管理员权限。

## 开发

```bash
# 运行 e2e 测试（需扩展已连接）
cd gateway && node verify-e2e.mjs

# 打包分发 ZIP
powershell -File scripts/build-pack.ps1 -Version 0.1.0
```

## 已验证的 Agent

| Agent | 协议 | 状态 |
|---|---|---|
| ZCode | MCP stdio | ✅ 已验证 |
| Qwen CLI | MCP stdio | ✅ 已验证 |
| Hermes Agent | MCP stdio | ✅ 已验证 |
| Claude Code | MCP stdio | ⬜ 待测 |
| Codex CLI | MCP stdio | ⚠️ 建议用自带工具 |

## License

MIT
