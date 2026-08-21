# 标签页作用域与工具面收口路线图（P1 / P2）

> **当前基线（P2-3）**：版本 `0.2.5`；当前共 **31 个工具**。`create_tab`、`activate_tab`、`close_tab` 已可用；浏览器工具支持显式 `tabId` 全链路定位；frame 作用域按 tab 隔离；后台 screenshot 临时激活目标 tab 后截图并切回；download 明确区分 `url` 与 `ref` 模式。本文中的 9、21、29 等数字均为对应章节记录时的**历史数字**，不代表当前工具总数。

本文记录 P0 完成后剩余的两批工作。P0（截图按 tabId 定位、download ref 模式透传 tabId、
frame 作用域按标签页隔离）已在真实 Chrome 验证 20/20 并推送，不在本文范围内。

## 背景

`tabId` 机制的来历：多步任务此前只能依赖扩展侧的全局 `pendingTabId`，而用户中途切换标签
会触发 `chrome.tabs.onActivated` 改写它，导致后续操作打到错误的页面。HelmFlow 依赖该机制
——它每次真实执行前调 `create_tab` 拿到 `tabId`，再把这个 id 贯穿动作调用、目标解析、
成功条件判定、失败截图，并写入 `RunSnapshot` 供断点续跑沿用。

因此 `tabId` 不是可选的锦上添花，而是生产链路已经在用的能力，缺口都会表现为静默错位。

---

## P1：工具面缺口（会静默错位或无法完成任务）

### P1-1 补齐所有 tab-aware 工具的 `tabId` schema

**问题**：`mapToolToAction` 会把任意工具参数里的 `tabId` 转成 `opts.tabIdHint`
（`gateway/tools-def.mjs`），扩展侧 15 个动作实际都遵守它，但 schema 里只声明了 4 个。
两台服务器都不校验 schema（`mcp-server.mjs`、`http-server.mjs` 只查工具名），所以现在能用。

**影响**：任何 schema 驱动的调用方都发不出这个参数——基于 `/v1/tools` 做 function-calling
的 LLM 是最典型的受害者。HelmFlow 能用纯属它自己硬编码 `NODE_TO_TOOL` 拼 payload、从不读
schema。schema 严格的客户端会直接拒掉该参数。

**做法**：在 `tools-def.mjs` 顶部定义共用的 `TAB_ID_PROP` 常量，各工具 schema 统一引用，
避免 15 处手写描述各自漂移。

需要补的远程工具：`navigate`、`list_frames`、`get_snapshot`、`click`、`right_click`、
`fill`、`press`、`get_text`、`eval`、`wait`、`scroll`、`hover`、`drag`。

不需要的：`create_tab`（自己造标签）、`list_tabs`（查全部标签）、纯本地文件工具。
`download` 已声明（仅 ref 模式有意义）。

**进度**：P1-1 已完成。所有 tab-aware 工具统一声明 integer `tabId`，并由
`TAB_ID_PROP` 复用同一份 schema；显式 `tabId` 统一映射为 `tabIdHint`。

### P1-2 新增 `activate_tab` 与 `close_tab`

**问题**：标签只能开不能关，也无法显式激活。核实过是真的缺失而非没找到——
`chrome.tabs.remove` 全仓零出现，`chrome.tabs.highlight` 零出现，`chrome.tabs.update`
只在两处出现：`navigate` 设 `{ url }`，以及截图临时激活设 `{ active: true }`。
`handleActionInner` 的 switch 里没有 `closeTab` / `activateTab` 分支。

**影响**：
- HelmFlow 每次真实执行都 `create_tab`，跑一天堆几十个标签没法回收。它的设计文档把
  「运行后自动关标签」列为 out of scope，正是因为 Helm 没这个能力。
- 测试脚本每跑一轮都留下标签，只能请人手动关。
- 截图那条限制没法从工具面绕过：无法把后台目标标签切到前台。

**做法**：
- `activate_tab`：`chrome.tabs.update(tabId, { active: true })`。
- `close_tab`：`chrome.tabs.remove(tabId)`，并补齐关闭后的清理——高亮状态、`frameScopes`
  条目、`pendingTabId` 的回退（关掉的正好是当前目标时要让它回落到活动标签）。
- 两者都默认作用于当前目标标签页，显式 `tabId` 时作用于指定标签页，复用 P1-3 的校验。

**风险**：`close_tab` 会丢弃用户可能正在看的页面，属不可逆操作。计划按普通工具实现
（不进高危授权），但描述里必须写明它会关闭真实标签页、且未保存的表单内容会丢失。

**进度**：P1-2 已完成。两个工具已加入 schema、MCP/HTTP 映射和 service worker 路由；关闭时会清理 frame scope、pending 目标与高亮状态。

### P1-3 收紧 `tabId` 语义，修掉静默错位与错误高亮

**问题 A：陈旧 `tabId` 不校验。** `resolveTabId(tabIdHint)` 在第一行就
`if (tabIdHint) return tabIdHint`，那个 `chrome.tabs.get` 存在性校验只作用于
`pendingTabId`，从不校验显式 hint。标签关掉后再用它的 id，会拿到 Chrome 原生报错
（`No tab with id: N.`）。而 `dispatchToFrame` 的重试逻辑只认
`Could not establish connection` 和 `Receiving end does not exist`，两个都不匹配，直接重抛。

对 HelmFlow 断点续跑影响直接：快照里存的 `tabId` 在浏览器重启后必然失效，此时应给出
「目标标签页已关闭，请新建」这类可判断的错误，而不是一个 Chrome 内部字符串。

边界：`if (tabIdHint)` 是真值判断，`tabId: 0` 会静默走到 pending 分支；
`-1`（`chrome.tabs.TAB_ID_NONE`）会被原样转发下去。

**问题 B：高亮画在错误的标签上。** `highlightCurrentTab` 调 `resolveTabId()`
**不传参数**，所以每个 `tabId` 定向的操作，琥珀色发光边框都画在活动标签而不是真正被操作
的标签上。`broadcastAction` 也从不接收 tab id——`handleAction` 只传 `{ action, args }`。

更隐蔽的副作用：`resolveTabId` 在回退分支会**写** `pendingTabId`。也就是说这个看起来只读
的高亮逻辑，会顺手改掉全局操作目标。

**做法**：
- 引入统一的「解析并校验目标 tab」流程：显式 `tabId` 先 `chrome.tabs.get` 校验，不存在就
抛可读错误；只有未传时才回退到 `pendingTabId` / 活动标签页。同时把真值判断改成 `!= null`，
让 `0` 与负数走校验而不是静默回退。
- 把读与写拆开：新增只读的解析函数供高亮等旁路使用，不再让它改写 `pendingTabId`。
- 把 `handleAction → broadcastAction → highlightCurrentTab` 链路携带本次
`tabIdHint`，让高亮跟随真正被操作的标签。

**进度**：P1-3 已完成。显式目标已做存在性校验并统一友好错误；默认目标只在非显式回退时更新；高亮使用本次动作的实际标签页。


### P1-4 测试、文档与发布

- `gateway/test/tools-def.test.mjs`：补 `activate_tab` / `close_tab` 的映射断言；
  把「声明了 tabId 的工具」这条从「至少 4 个」改成**枚举所有应声明的工具**，
  这样以后新增 tab-aware 工具漏声明会被测出来。
- `gateway/verify-tab-scope.mjs`：加一组真实 Chrome 的标签页生命周期验证——显式激活、
  关闭、关闭当前目标后的回退、以及「高亮跟随正确标签」。
- `gateway/verify-e2e.mjs`：更新工具数断言（29 → 31；29 为历史数字）。
- `README.md`：同步新增工具与工具总数。
- 版本升到 `0.2.4`，重建安装包、部署，跑单测 + 真实 Chrome 回归。（P1 历史记录）

**进度**：P1-4 的代码、契约测试、mock 全链路验证、版本同步和 0.2.4 包构建已完成。（历史记录）
真实 Chrome 回归脚本已补齐生命周期/高亮/陈旧 tabId 场景；当时浏览器仍加载 0.2.3 的旧部署目录，随后已部署更新版本。当前文档基线为 0.2.5。

改完 `sw.js` 后用 `node gateway/reload.mjs` 自助重载即可，不需要人工去
`chrome://extensions` 点重载。

---

## P2：测试债与文档漂移（不影响功能，但会误导判断）

> 本节保留当时的排查记录；其中“9 个测试脚本”“21 个工具”等数字均为历史数字，不代表当前工具总数。

### P2-1 根目录 legacy 测试脚本与安全门禁不一致（已完成）

这组脚本跨越两种测试层次：部分脚本直接 `bridge.invoke()` 验证 SW/bridge，绕过 Gateway 安全门禁；经 MCP `tools/call` 的脚本则会遇到 `HELM_CONFIRMATION_REQUIRED` 或 `HELM_PERMISSION_REQUIRED`。旧版 `verify-e2e.mjs` 还会在失败后无条件 `statSync` 不存在的下载文件，掩盖原始失败。

本批次新增 `gateway/run-legacy-e2e.mjs`：功能型 MCP 脚本使用临时 `open` 策略和临时项目权限，安全专项仍使用 balanced confirmation；所有临时策略、权限和审计文件在退出时清理。直接 bridge 脚本在 runner 输出中明确标注为底层链路测试，不冒充安全策略测试。

### P2-2 `open` 安全模式开发语义已明确（已完成）

当前实现已把 `HELM_SECURITY_MODE=open` 接入默认策略构建：open 模式下 `eval` 与 `screenshot` 默认 `allow`，不再要求 confirm。这里的“开发宽松”只针对这两个工具的默认策略，不等于关闭安全边界：DLP/容量预算、审计、错误清洗与脱敏仍然生效；`download` 与覆盖式 `save_file` 仍由独立的高危权限系统控制，需通过 `allow_once` 或 `set_permission` 授权。

| 请求模式 | eval | screenshot | 其他工具/边界 |
|---|---|---|---|
| 未指定 / balanced | confirm | confirm | 继续按策略执行；DLP、预算、审计、脱敏生效 |
| open | allow | allow | DLP、预算、审计、脱敏仍生效；download/save_file 独立授权 |
| managed | block（强制） | 按策略，allow 会收紧为 confirm | 策略缺失/损坏时 fail closed |

`managed` 在没有策略文件或策略无效时返回 `ok:false`，工具执行被阻断；HTTP `/health` 仍用于诊断，调用端应遵守统一错误契约（见下文）。

### P2-3 文档同步（已完成）

- 当前文档基线统一为 **31 个工具**、版本 `0.2.5`。
- 当前能力已记录：`create_tab` / `activate_tab` / `close_tab`、显式 `tabId` 全链路、按 tab 隔离的 frame 作用域、后台 screenshot 临时激活后切回、download 的 `url` / `ref` 模式区分。
- 早期章节中的 9、21、29 等数字保留为历史验证或迁移记录，并明确标注“历史”，不作为当前能力说明。

有点讽刺的是，HelmFlow 的 `docs/08-helm-reference.md` 和 `09-helm-integration-contract.md`
把 Helm 的 `tabId` 行为记得比 Helm 自己详细。

### P2-4 HelmFlow 契约同步（已完成）

`HelmFlow/docs/08-helm-reference.md` 有两条限制说明现在都不成立了：

- 「`screenshot` 目标标签页在后台时截图不可靠」——已修好，后台标签会临时切换后截图。
- 「`download` 仅 `ref` 模式使用 `tabId`」——原本描述与代码相反（当时 ref 模式恰恰**不**用），
  现在才真正成立。

### P2 总体进度：已完成

- P2-1：隔离 legacy E2E runner、临时策略/项目权限、异常安全收尾和权限单测已完成；`verify-e2e` 通过 56/56，`download-ref` 通过 10/10。
- P2-2：`open`/`balanced`/`managed` 语义、DLP/预算/审计边界和 managed HTTP/MCP 错误契约已完成；安全单测 39/39，安全专项 E2E 通过。后台截图若遇 Chrome `image readback failed` 只记录为环境限制。
- P2-3：browser-tool 文档已同步到 31 工具和 0.2.5，并补齐 tabId、frame、截图和下载语义。
- P2-4：HelmFlow 参考文档、mock 工具清单和 `list_frames` 数组兼容性已同步；helm-client 49/49、runtime 35/35、全 workspace typecheck 通过。
