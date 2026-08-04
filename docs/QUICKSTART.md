# Browser Tool — 快速上手

通用浏览器操作工具：**Chrome 扩展 + 本地网关 + MCP**。让 AI Agent 在你**真实已登录的浏览器**里执行点击/输入/拖拽/下载等操作。

---

## 一键安装（推荐）

**双击 `install/install.bat`** 即可完成全部安装：
- 检测 Node.js / Chrome 环境
- 安装网关依赖
- 注册开机自启（登录时自动启动网关，无需手动）
- 启动网关 + 加载 Chrome 扩展
- 验证连通

安装后每次开机自动就绪，直接在 ZCode / Claude Desktop / Cursor 中使用即可。
卸载双击 `install/uninstall.bat`。详见 `install/README.md`。

> 以下为手动启动方式（调试或非 Windows 环境用）。

---

## 0. 目录结构

```
browser-tool/
├─ docs/
│  ├─ pms_automation.py          # 参考脚本（PMS 案例，仅作对照）
│  ├─ feasibility-and-plan.md     # 可行性与方案
│  └─ QUICKSTART.md               # 本文件
├─ extension/                     # Chrome 扩展（MV3）
│  ├─ manifest.json
│  ├─ sw.js                       # service worker：路由
│  ├─ offscreen.html / offscreen.js   # 长连接 WebSocket
│  ├─ sidepanel.html / sidepanel.js   # 状态/日志 UI
│  └─ content/dom-agent.js        # 注入各 frame 的 DOM 操作
└─ gateway/                       # 本地网关
   ├─ package.json
   ├─ bridge.mjs                  # WebSocket server + health
   └─ mcp-server.mjs              # MCP server (stdio)
```

---

## 1. 启动本地网关

```bash
cd <项目根目录>/gateway
npm install          # 仅一次，装 ws 依赖
npm start            # 等价 node mcp-server.mjs
```

启动后会看到：
```
[bridge] 监听 ws://127.0.0.1:8787  (等待扩展连接)
[mcp] browser-tool MCP server 已启动 (stdio)，等待 Agent 连接…
```

> 注意：`npm start` 启动的是 **MCP stdio 进程**，它内部会同时起 bridge。MCP 进程是给 Agent 启动的；如果你想单独验证 bridge，可 `npm run bridge`。

---

## 2. 加载扩展

1. Chrome 地址栏输入 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择 `<项目根目录>/extension`
4. 扩展加载后，点扩展栏的 Browser Tool 图标 → 打开 **Side Panel**
5. Side Panel 应显示绿色「已连接本地网关 ✓」

> 若显示「未连接网关」：确认 `npm start` 正在运行，且端口 8787 未被占用。可用 `curl http://127.0.0.1:8787/health` 自测。

---

## 3. 接入 Agent

browser-tool 通过 MCP stdio 暴露 21 个工具，任何支持 MCP 的 Agent 均可直接接入，零代码适配。以下是已验证的 Agent 配置：

> 以下配置假设网关已在运行（双击 `install/install.bat` 后自动启动，开机自启）。

### ZCode

配置文件：`~/.zcode/cli/config.json`

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

### Claude Code

配置文件：项目根 `.mcp.json`（项目级）或 `~/.claude.json`（用户级）

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

或用 CLI：`claude mcp add browser-tool -s user -- node /path/to/browser-tool/gateway/mcp-server.mjs`

### Qwen CLI

配置文件：`~/.qwen/settings.json`（用户级）或 `.qwen/settings.json`（项目级）

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

### Hermes Agent

配置文件：`%LOCALAPPDATA%\hermes\config.yaml`（即 `C:\Users\<用户名>\AppData\Local\hermes\config.yaml`）

```yaml
mcp_servers:
  browser-tool:
    command: "node"
    args: ["/path/to/browser-tool/gateway/mcp-server.mjs"]
```

### Codex CLI (OpenAI)

配置文件：`~/.codex/config.toml`（TOML 格式）

```toml
[mcp_servers.browser-tool]
command = "node"
args = ["/path/to/browser-tool/gateway/mcp-server.mjs"]
```

> 注：Codex 有内置浏览器工具，与 browser-tool 功能重叠。在 Codex 中建议使用其自带工具。

### 非 MCP 智能体 / 自研 Agent（HTTP 接入）

对于不支持 MCP 的自研 Agent，可用 HTTP 端点（`gateway/http-server.mjs`）：

```bash
# 启动 HTTP 端点（bridge 已在跑）
HELM_API_KEY=mykey node http-server.mjs --port 8788

# 调用
curl -H "Authorization: Bearer mykey" http://127.0.0.1:8788/v1/tools
curl -X POST -H "Authorization: Bearer mykey" -H "Content-Type: application/json" \
  -d '{"name":"list_tabs","arguments":{}}' http://127.0.0.1:8788/v1/tools/call
```

### 多 Agent 共存

多个 Agent 可同时使用 browser-tool：每个 Agent spawn 的 mcp-server 进程调 `startOrAttach()`，检测到 8787 被占会走**附属模式**连常驻 bridge，互不干扰。

---

## 4. 验收测试（阶段 0 验收标准）

在已登录任一站点的浏览器里，让 Agent 完成两件事即算通过：

**测试 A — 读页面**
> 用 browser-tool，打开当前已登录的页面，告诉我页面标题和前 5 个可点击元素。

Agent 预期调用：`list_tabs` 或 `navigate` → `get_snapshot` → 汇报。

**测试 B — 点击+读取**
> 在当前页面找一个链接/按钮叫「xxx」，点击它，然后告诉我跳转后的 URL。

Agent 预期调用：`get_snapshot` → 找到 ref → `click(ref)` → `list_tabs` 读 URL。

---

## 5. 工作原理速览

```
Agent (Claude/Codex)
   │  MCP stdio（JSON-RPC: tools/call）
   ▼
mcp-server.mjs ──invoke──▶ bridge.mjs (WS server:8787)
                                │  WebSocket
                                ▼
                     extension/offscreen.js（长连接，跨 SW 回收）
                                │  chrome.runtime.connect
                                ▼
                     extension/sw.js（service worker，路由）
                                │  chrome.tabs.sendMessage
                                ▼
                     extension/content/dom-agent.js（各 frame 内操作）
                                ▼
                        用户真实浏览器页面
```

关键设计：
- **ref 而非选择器**：`get_snapshot` 给每个可交互元素发 `ref`，Agent 只用 ref 引用，避免写脆弱 CSS。
- **状态在 offscreen/网关**：MV3 service worker 约 30s 回收，长连接放在 offscreen document 和网关进程里，SW 无状态可随时重建。
- **真实会话**：操作发生在你日常浏览器，天然带登录态、隐蔽性最好。

---

## 6. 常见问题

| 现象 | 原因/处理 |
|---|---|
| Side Panel 显示「未连接网关」 | 网关未启动 / 端口被占。`npm start`；`netstat -ano \| findstr 8787` 查占用 |
| Agent 报「扩展未连接」 | 扩展未加载或 Side Panel 未开。打开 Side Panel 触发 offscreen |
| `get_snapshot` 返回空 | 页面还在加载，或目标元素不在主 frame。先 `list_frames` 再对 frameId 取 snapshot |
| 操作无反应 | content script 可能未注入；sw 会自动补注入一次。若仍失败，刷新目标页面后重试 |
| `ref` 失效 | DOM 变化导致 ref 失效；重新 `get_snapshot` 拿新 ref |

---

## 7. 下一步（阶段 1）

补齐：`wait` / `drag` / `hover` / `scroll` / `download` / `save_file`，以及 Side Panel 动作流可视化、高危动作确认。详见 `docs/feasibility-and-plan.md` 第六节。
