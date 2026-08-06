# 通用浏览器操作 Agent 工具 — 可行性分析与方案

> 目标：做一个**通用**的浏览器操作工具。用户用自然语言下达指令（"用 xx 账号登录 xxxx 网站，下载 xxx，点击 xxx，把 A 拖到 B……"），Agent 规划操作序列，工具在**用户真实浏览器**里按序执行并逐步反馈，替代人工。PMS 自动下载文档只是其中一个验证案例，工具本身与具体站点无关。

---

## 一、可行性结论

**可行，且推荐做。** 核心判断：通用浏览器自动化所需的全部能力——跨 iframe DOM 操作、键鼠交互、下载、截图、等待、状态轮询——在「Chrome 扩展 + 本地网关 + MCP」架构下都能覆盖；而让 Agent 可规划、可接入的标准化通道已有成熟协议（MCP）。难点不在技术可行，而在**元素定位的稳定性**与**Agent 决策的可靠性**，这两点都有业界成熟解法可借鉴。

### 三种实现路线对比

| 维度 | A. Chrome 扩展（推荐） | B. CDP `--remote-debugging-port` | C. Playwright 新实例（现状脚本路线） |
|---|---|---|---|
| 复用用户已登录会话/Cookie | ✅ 日常浏览器自带 | ⚠️ 需复用 profile，易触发风控 | ❌ 每次重登 |
| 跨 iframe 操作 | ✅ `all_frames` + host_permissions | ✅ Runtime.evaluate | ✅ frame API |
| 任意路径下载 | ⚠️ 需 Native Host 写盘 | ✅ | ✅ |
| 站点自动化检测（navigator.webdriver 等） | ✅ 真实 profile，最隐蔽 | ❌ 痕迹明显 | ❌ 痕迹明显 |
| Agent 接入标准协议 | ✅ MCP | ✅ MCP | ✅ MCP |
| 安装成本 | 中（扩展 + native host） | 低（启动参数） | 中 |

通用工具的命门是"在用户真实、已登录的浏览器里干活"——这是扩展方案的强项，也是 C/现状脚本每次重登、易被风控的痛点。**选 A。**

---

## 二、总体架构

```
┌─────────────────────────────────────────────────────────────┐
│  Agent 层（任选）                                            │
│  Claude / Codex / Cursor（MCP 原生）                         │
│  Hermes / Qwen Agent（走网关兜底：OpenAI 兼容 function-call） │
└───────────────────┬─────────────────────────────────────────┘
                    │ MCP stdio/HTTP        OpenAI 兼容 function-call
                    ▼
┌─────────────────────────────────────────────────────────────┐
│  本地网关  helm（Node）                       │
│   • MCP Server（tools/list, tools/call）                     │
│   • WebSocket 桥 ↔ 扩展                                      │
│   • 长任务/会话/截图缓冲（MV3 SW 易回收，状态放这）           │
│   • OpenAI 兼容 function-call 端点（兜底非 MCP host）        │
│   • Native Messaging Host（任意路径写盘/分块传输）           │
└───────────────────┬─────────────────────────────────────────┘
                    │ connectNative / WebSocket
                    ▼
┌─────────────────────────────────────────────────────────────┐
│  Chrome 扩展（MV3）                                          │
│   • Side Panel：指令流 / 进度 / 确认 / 回放                  │
│   • Service Worker：路由调度（无状态）                        │
│   • Offscreen Document：长连接、长任务状态                    │
│   • Content Script（all_frames）：DOM 探查与操作、iframe 穿透│
│   • chrome.scripting / chrome.downloads / chrome.debugger    │
└───────────────────┬─────────────────────────────────────────┘
                    ▼
            用户真实浏览器（任意站点，已登录会话）
```

要点：
- 工具**不针对任何站点**，站点逻辑由 Agent 根据实时页面快照动态规划。
- **本地网关**承担三件事：对 Agent 暴露统一协议（MCP 为主、OpenAI 兼容兜底）、对扩展路由指令、替 MV3 service worker 持有长任务状态。
- 扩展跑在日常浏览器里，天然带登录态、避开自动化检测。

---

## 三、对 Agent 暴露的通用工具集

设计原则：**不让 Agent 写 CSS 选择器**。Agent 看到的是带 `ref` 的可交互元素清单，后续用 `ref` 引用——这是 playwright-mcp / browser-use 的成熟范式，避免 LLM 写出脆弱选择器。

### 3.1 感知类（让 Agent "看见"页面）

| 工具 | 作用 |
|---|---|
| `get_snapshot(selector?, frame_id?)` | 返回当前页/指定 iframe 的简化结构树（a11y 树 + 可交互元素 + 每个元素的 `ref`），含滚动状态、可见性 |
| `list_frames()` | 枚举所有 iframe（URL、标题、frame_id），用于跨 iframe 任务 |
| `get_text(ref)` | 取某元素文本，用于读表格、读列表 |
| `screenshot(frame_id?)` | 截图（base64，分块回传），视觉模型兜底 |
| `read_url()` | 当前 URL、标题 |

### 3.2 操作类（让 Agent "动手"）

| 工具 | 作用 |
|---|---|
| `navigate(url)` | 打开 URL（在当前 tab 或新 tab） |
| `click(ref, button?)` | 左/右键点击（右键常触发自定义菜单） |
| `fill(ref, value)` | 输入文本（账号、搜索词……） |
| `press(key)` | 键盘事件（Enter、Esc、快捷键） |
| `select(ref, value)` | 下拉选择 |
| `drag(ref_from, ref_to)` | 拖拽（A→B） |
| `hover(ref)` | 悬停（触发菜单/tooltip） |
| `scroll(ref \| direction, amount)` | 滚动到元素/方向滚动 |

### 3.3 流程控制类

| 工具 | 作用 |
|---|---|
| `wait(condition)` | 等文本出现 / 元素可见 / 行数稳定 / 网络空闲 / 自定超时 |
| `set_active_frame(frame_id)` | 切换后续操作的 iframe 作用域 |
| `eval(js, frame_id?)` | 逃生口：执行任意 JS（如读取内部数据结构、触发隐藏 API） |

### 3.4 产物类

| 工具 | 作用 |
|---|---|
| `download({ref\|url, filename, subdir})` | 下载到指定子目录（用 native host 写任意路径） |
| `save_file(path, content)` | 本地落盘任意文本/二进制（清单、索引、抓取结果） |
| `read_file(path)` / `list_files(dir)` | 配合增量任务读本地状态 |

> 这套工具集与站点无关。只是 Agent 调用 `navigate→list_frames→set_active_frame→get_snapshot→right_click→wait→download→save_file` 的一个组合。

---

## 四、典型交互流程（用户视角）

```
用户（自然语言）         Agent              工具（扩展+网关）         浏览器
   │ "用账号 A 登录        │ 规划成           │                      │
   │  xx.com, 下载         │  1 navigate      │                      │
   │  最新报表"            │  2 get_snapshot  │                      │
   │                      │  3 fill(账号)     │                      │
   │                      │  4 fill(密码)     │                      │
   │                      │  5 click(登录)    │                      │
   │                      │  6 wait(登录后)   │                      │
   │                      │  7 get_snapshot   │                      │
   │                      │  8 click(报表)    │                      │
   │                      │  9 download(...)  │                      │
   ▼                      ▼ 10 save_file(清单)▼                      ▼
  Side Panel 实时显示动作流 + 截图，用户可随时介入/确认
```

- Agent 每步基于上一步的 `get_snapshot` 结果决策，**闭环**而非写死脚本。
- 高危动作（下载、提交、删除、支付）默认 Side Panel 弹确认，用户一键放行。
- 全程截图可回放，便于复盘失败。

---

## 五、关键技术风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| MV3 service worker ~30s 回收 | 长任务断连 | 长连接/状态放 Offscreen Document 与网关进程，SW 保持无状态、可随时重建 |
| `chrome.downloads` 只能写到"下载"目录子路径 | 无法落任意目录 | 经 Native Host 写盘；或扩展下载后由 host 搬运到目标路径 |
| Native Messaging 单消息 1MB 上限 | 截图/大 DOM 超限 | 网关侧分块；大对象先落临时文件再传路径 |
| 跨域 iframe 注入需 host_permissions | 任意站点都要支持 | manifest 声明宽 host_permissions（`*://*/*`），运行时按需请求权限，UI 明确提示 |
| 元素定位不稳（SPA 动态 DOM） | Agent 拿到的 ref 失效 | 每次操作前重新 `get_snapshot` 刷新 ref；ref 失效即报错让 Agent 重新感知 |
| Agent 决策错误（点错/误删/误支付） | 真实会话风险 | 动作流可视化 + 高危确认 + 截图回放 + 可回滚动作优先 |
| Qwen/Hermes 非 MCP 原生 host | 接入不了 | 网关额外提供 OpenAI 兼容 function-calling 端点兜底 |
| 站点反爬/验证码 | 操作被拦 | 默认在真实 profile 操作，隐蔽性最好；验证码场景设计"暂停转人工"动作 |

---

## 六、分阶段实施计划

**阶段 0 — 最小链路验证（1～2 天）**
- 扩展实现：`navigate` / `get_snapshot` / `click` / `fill` / `eval`。
- 网关：Node 起 MCP server（stdio），WebSocket 连扩展。
- 验收：Claude Desktop 接入，在一个**任意已登录站点**（不限于 PMS）上点击一个按钮、读一段文本，证明"真实会话 + Agent 闭环"成立。

**阶段 1 — 通用操作全集（3～5 天）**
- 补齐 `list_frames` / `set_active_frame` / `wait` / `drag` / `hover` / `scroll` / `screenshot` / `download` / `save_file`。
- Side Panel 基础版：动作流 + 截图。
- 验收：用一个非 PMS 站点完成"登录→搜索→下载→存清单"全流程，全程不重登。

**阶段 2 — 多 Agent 接入 + 可靠性（1～2 周）**
- 网关加 OpenAI 兼容 function-calling 端点，接入 Qwen Agent / Hermes。
- 高危动作确认、动作回放、错误恢复与重试策略。
- 用复杂多 iframe 站点全流程作为回归用例：验证"遍历目录→右键下载→增量清单"。
- 验收：同一套工具，至少 3 个不同 Agent 各自完成 2 个不同站点的任务。

**阶段 3 — 生产化（按需）**
- 安装器（扩展 + native host 注册，Win/Mac）、权限审计日志、敏感站点白名单、并发任务队列、动作录制与回放。

---

## 七、目录结构建议

```
helm/
├─ docs/
│  └─ feasibility-and-plan.md      # 本文件
├─ extension/                      # Chrome 扩展（MV3，站点无关）
│  ├─ manifest.json
│  ├─ sw.js                        # service worker：路由调度
│  ├─ offscreen.html / .js         # 长连接/状态
│  ├─ sidepanel.html / .js         # 动作流/确认/回放 UI
│  └─ content/
│     └─ dom-agent.js              # DOM 探查与操作（注入各 frame）
├─ gateway/                        # 本地网关进程
│  ├─ mcp-server.ts                # MCP server（主接入协议）
│  ├─ openai-compat.ts             # OpenAI 兼容 function-call（兜底）
│  ├─ bridge.ts                    # 与扩展 WebSocket/Native Messaging 桥
│  └─ native-host.ts               # 任意路径写盘/分块
└─ agents/                         # 各 Agent 连接配置示例
   ├─ claude-desktop-config.json
   ├─ codex-config.md
   └─ qwen-hermes-example.md
```

---

## 八、一句话总结

**可行。** 做"Chrome 扩展（站点无关，复用真实登录态）+ 本地网关 + MCP（OpenAI 兼容兜底）"的通用浏览器操作工具：Agent 看 `ref` 化页面快照做决策，工具按序执行点击/输入/拖拽/下载等通用动作，PMS 只是众多用例之一。建议从阶段 0 最小链路起步，2 天打通"真实会话 + Agent 闭环"后再决定投入。
