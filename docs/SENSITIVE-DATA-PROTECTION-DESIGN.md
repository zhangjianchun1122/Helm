# Helm 敏感信息保护详细设计

> 状态：实施中（核心 DLP、分页、策略门禁、审计、双传输 E2E 已完成）
>
> 目标读者：负责实现、评审和测试 Helm 的编程智能体与工程师
>
> 适用范围：`gateway/`、`extension/`、MCP stdio、HTTP API、Side Panel、审计日志
> 非目标：本方案不建设中心化 DLP 服务，不依赖模型“自觉”脱敏，也不承诺从任意截图中可靠识别全部敏感像素。

### 0.1 当前实施取舍

- 优先保证“真实浏览器 + 现有登录态 + 低使用成本”的产品目标，安全控制不应让普通点击、输入和分页读取变得难用。
- S3 秘密删除、总输出预算、双层采集上限和统一审计是不可降级的硬边界。
- 确认机制采用本地状态型 UUID，不为单机第一版引入 HMAC 密钥管理；如未来网关变为多实例或远程服务，再升级为可跨实例验证的签名令牌。
- 企业自定义正则和复杂业务字段策略延后，直到能提供充分的 ReDoS 防护、配置校验和管理员信任边界。

## 1. 目标与安全边界

### 1.1 必须实现的目标

1. 密码、Cookie、认证令牌、API Key、私钥等秘密在进入模型上下文前被删除或替换。
2. `fill` 内容、工具参数、返回结果和错误信息写入控制台、Side Panel、审计日志前经过专用脱敏。
3. 页面内容、文件内容和 URL 只采集完成任务所需的最小范围，并设置硬性容量上限。
4. stdio MCP 与 HTTP API 使用完全相同的 DLP 策略，不能出现一个入口脱敏、另一个入口泄漏。
5. 所有脱敏行为可测试、可观测，但任何指标或日志均不得保存被脱敏的原文。
6. 默认配置保持个人开发场景可用；`managed` 模式必须 fail closed。

### 1.2 信任边界

数据流如下：

```text
网页 DOM / 浏览器状态 / 本地文件
        │
        ▼
扩展采集层（Source Guard）
        │ WebSocket，本地传输
        ▼
Gateway 统一执行层
        │
        ├── Context DLP ──► MCP/HTTP 返回 ──► 模型上下文
        ├── Audit DLP ────► audit-log.jsonl
        └── UI DLP ───────► Side Panel / stderr
```

安全结论：凡是模型绝对不能看到的数据，必须在 `MCP/HTTP 返回` 之前由确定性代码处理。智能体只能作为额外的语义防线，不能作为唯一防线。

## 2. 当前代码风险清单

实施前先为以下现状建立回归测试：

| 数据路径 | 当前风险 | 相关代码 |
|---|---|---|
| 页面快照 | `describe()` 收集 `value`，密码框可能直接进入快照 | `extension/content/dom-agent.js` |
| 页面文本 | `innerText/textContent` 可能包含客户数据、令牌和商业机密 | `extension/content/dom-agent.js` |
| `get_text` | 返回目标元素的完整文本，缺少大小限制和 DLP | `extension/content/dom-agent.js` |
| `eval` | 可读取 `document.cookie`、DOM 密码值、`localStorage`、`sessionStorage`，也可编码后返回 | `extension/content/dom-agent.js`、`extension/sw.js` |
| `fill` | 参数摘要截断但不脱敏，可能进入 Side Panel 和审计链路 | `extension/sw.js`、`extension/sidepanel.js` |
| `read_file` | 文件内容原样进入模型上下文 | `gateway/mcp-server.mjs`、`gateway/http-server.mjs` |
| URL | 查询参数和 fragment 可能包含 token/code/signature | 所有 list/navigation/download 返回及日志 |
| 审计日志 | 只截断字符串，未按字段和内容脱敏；stdio/HTTP 重复实现 | `gateway/mcp-server.mjs`、`gateway/http-server.mjs` |
| 错误信息 | 异常消息可能携带 URL、响应片段或输入原文 | gateway 与 extension 多处 catch |
| 截图 | 像素可能包含任何页面敏感信息 | `screenshot` 工具 |
| 主/附属网关 | 主网关对附属进程转发原始扩展结果 | `gateway/bridge.mjs` |

## 3. 数据分类与处理动作

### 3.1 分类等级

| 等级 | 名称 | 示例 | 默认动作 |
|---|---|---|---|
| S0 | 公开 | 公开网页标题、公开文档 | 允许，受容量限制 |
| S1 | 内部 | 内部 URL、员工姓名、内部系统状态 | 掩码或允许，按策略决定 |
| S2 | 机密 | 客户名称、合同金额、产能、良率、工艺参数 | 默认掩码；精确字段需策略显式允许 |
| S3 | 秘密 | 密码、Cookie、Token、API Key、私钥、身份证、银行卡 | 始终删除或不可逆替换，不允许策略降级为明文 |

### 3.2 标准动作

- `allow`：返回原文。
- `mask`：保留少量结构，例如手机号 `138****5678`。
- `redact`：替换为 `[REDACTED:<TYPE>]`。
- `omit`：删除字段，并在同级增加安全元数据。
- `block`：拒绝整个工具调用。
- `confirm`：要求显式授权；仅适用于截图、敏感文件等无法可靠局部脱敏的载体，不适用于 S3 明文放行。

### 3.3 不可降级规则

以下内容即使用户配置为 `allow` 也不得返回明文：

- `input[type=password]`、匹配密码语义的输入框值；
- Cookie、`Authorization`、Bearer token、refresh token；
- PEM 私钥、常见云厂商密钥、明确命名的 `api_key/client_secret`；
- MCP/HTTP 自身鉴权密钥 `HELM_API_KEY`；
- 权限配置、策略签名使用的私钥。

## 4. 总体架构

### 4.1 新增模块

```text
gateway/security/
  config.mjs              # 加载、校验、合并策略
  detectors.mjs           # 内容检测器，不执行 I/O
  redact.mjs              # 递归结构化脱敏与字符串脱敏
  url-sanitizer.mjs       # URL 查询参数与 fragment 处理
  tool-policy.mjs         # 按工具、方向、载体决定 allow/block/confirm
  audit.mjs               # 唯一审计日志实现
  execution-guard.mjs     # 工具执行前/后统一安全入口
  stats.mjs               # 只记录类型和计数，不记录原文
  errors.mjs              # 安全错误类型和错误消息清洗
  index.mjs               # 对外稳定 API

gateway/tool-executor.mjs # 合并 stdio 与 HTTP 的重复执行逻辑
```

浏览器端新增：

```text
extension/content/source-guard.js  # DOM 敏感字段识别与安全描述
extension/redact-lite.js           # UI/扩展日志使用的轻量参数脱敏
```

不要在扩展和 Gateway 各复制完整正则库。扩展只做来源感知和最小化；Gateway 是最终、权威的上下文与日志 DLP 边界。

### 4.2 统一执行管线

所有工具必须经过同一函数：

```js
executeToolSecure({ name, args, transport, requestId })
```

执行顺序固定：

```text
1. validateToolArgs
2. sanitizeForUi(args)             # 仅供动作展示
3. evaluatePreExecutionPolicy      # block / confirm / allow
4. audit start（已脱敏）
5. execute raw tool
6. redactToolResult(name, rawData) # 在任何 JSON.stringify/返回前执行
7. enforceOutputBudget
8. audit end（独立脱敏，不复用上下文全文）
9. return safeData
10. 捕获异常后 sanitizeError，再返回/记录
```

严禁在步骤 6 之前打印、序列化到日志或发送给调用方。

### 4.3 确认令牌机制（confirm 不是 allow_once 的复用）

`eval`、`screenshot` 等高风险工具的 `confirm` 模式**不能**简单复用现有的 `allow_once(tool)` 权限机制。原因：

1. `allow_once` 只绑定工具名，不绑定具体调用参数。确认一次 `eval` 后，攻击者可替换 `code` 为任意脚本重复执行。
2. `allow_once` 没有有效期，会话期间持续有效。
3. `allow_once` 不绑定 `requestId`，无法防止重放。

**确认凭据设计（本地状态型）**：

Helm 的默认场景是单机本地网关。为了避免引入密钥持久化、签名轮换和跨进程共享的额外复杂度，第一版采用 Gateway 内存中的不透明 UUID 凭据，而不是无状态 HMAC 令牌。安全属性保持不变：参数绑定、逻辑请求绑定、60 秒过期、单次消费、不落盘。网关重启后所有凭据自动失效，符合 fail closed。

```ts
type ConfirmationRecord = {
  confirmationId: string; // CSPRNG UUID，仅作为不透明查找键
  tool: string;           // 工具名，如 "eval"
  requestId: string;      // 跨 MCP/HTTP 重试保持不变的逻辑请求 ID
  argsDigest: string;     // SHA-256(规范化后的安全关键参数)
  expiresAt: number;      // Unix 毫秒时间戳
};
```

**执行流程**：

1. `evaluatePreExecutionPolicy` 返回 `confirm` 时，Gateway 生成 `confirmationId`，并在内存中保存 `ConfirmationRecord`。
2. 调用方展示风险提示（工具名、参数摘要、有效期），等待用户确认。
3. 用户确认后，调用方调用 `confirm_execution`，再携带 `confirmationId` 和 `confirmationRequestId` 重试原工具。
4. Gateway 校验：
   - `confirmationId` 存在且已获用户确认；
   - `tool` 匹配当前工具名；
   - `requestId` 匹配重试携带的逻辑请求 ID；
   - `argsDigest` 匹配当前参数的 SHA-256；
   - `expiresAt` 未过期（有效期 60 秒）。
5. 任一校验失败，拒绝执行并返回安全错误。
6. 执行前原子删除已批准凭据，防止重放。

**参数摘要规则**：

- `eval`：对 `code` 和 `arg` 的规范化结构做 SHA-256；实施必须在进入大参数生产场景前增加摘要长度上限。
- `screenshot`：`argsDigest = SHA-256(JSON.stringify({format, quality}))`。
- 其他 confirm 工具：按工具定义选择关键字段。

**审计记录**：

- 确认成功：记录 `requestId`、`tool`、`argsDigest`、`expiresAt`，不记录 `confirmationId`。
- 确认失败：记录失败原因（签名无效、过期、参数不匹配），不记录令牌原文。

**与 `allow_once` 的关系**：

- `allow_once` 仍用于高危工具（`save_file`、`download` 等）的一次性授权，这些工具的参数不涉及不可结构化的敏感载体。
- `confirm` 专用于 `eval`、`screenshot` 等载体风险工具，必须绑定参数和有效期。
- 两套机制独立实现，不共享状态。

## 5. 策略配置

### 5.1 文件位置

第一版使用：

```text
%APPDATA%\Helm\security-policy.json
```

可通过 `HELM_SECURITY_POLICY` 指定绝对路径。找不到文件时加载内置安全默认值。配置错误时：

- `open`/`balanced`：回退内置安全默认值并输出不含配置内容的警告；
- `managed`：**在进程启动阶段**确定策略状态并拒绝启动工具执行服务，但 `/health` 可返回策略错误码。

### 5.1.1 managed 模式启动阶段确定

`managed` 模式的策略状态**必须在服务启动阶段一次性确定**，不在运行时动态切换。具体规则：

1. **启动时加载**：`mcp-server.mjs` 和 `http-server.mjs` 在进程启动时调用 `loadSecurityPolicy()`，解析并校验配置文件。
2. **状态冻结**：加载成功后，策略对象深冻结（`Object.freeze` 递归），整个进程生命周期使用同一不可变快照。
3. **加载失败**：`managed` 模式下，配置文件缺失、解析错误、校验失败时，进程**拒绝提供工具执行能力**：
   - HTTP `/health` 继续响应，返回 `{ status: "degraded", policyError: "<error_code>" }`（不含配置原文）。
   - HTTP `/v1/tools/call` 返回 `503 Service Unavailable`，错误码 `HELM_POLICY_NOT_LOADED`。
   - MCP `tools/call` 返回 JSON-RPC error，错误码 `HELM_POLICY_NOT_LOADED`。
4. **统一检查点**：策略状态检查**不在 HTTP 层或 MCP 层各自实现**，而是在 `executeToolSecure` 入口处统一检查。两个传输层都调用同一个 `executeToolSecure`，因此策略检查自动覆盖两条路径。

```js
// execution-guard.mjs 入口
export async function executeToolSecure({ name, args, transport, executeRaw, requestId, auditPath }) {
  const policy = getSecurityPolicy();  // 启动时加载的冻结快照
  if (policy.mode === 'managed' && !policy.loaded) {
    return { ok: false, error: { code: 'HELM_POLICY_NOT_LOADED', tool: name, message: 'Security policy not loaded in managed mode' } };
  }
  // ... 后续执行流程
}
```

5. **禁止运行时降级**：`managed` 模式不提供"临时关闭脱敏"或"切换到 balanced"的 API。`reload_security_policy` 工具在 `managed` 模式下默认禁用。
6. **健康检查语义**：`/health` 返回的策略状态仅用于运维监控，不用于工具执行决策。工具执行决策只看 `executeToolSecure` 入口的策略快照。

### 5.2 配置 Schema 示例

```json
{
  "version": 1,
  "mode": "balanced",
  "context": {
    "replacement": "[REDACTED:{type}]",
    "maxStringChars": 20000,
    "maxToolResultChars": 200000,
    "maxSnapshotElements": 500,
    "includeRedactionMetadata": true
  },
  "secrets": {
    "enabled": true,
    "customFieldNames": ["customer_secret", "license_key"],
    "customPatterns": []
  },
  "personalData": {
    "phone": "mask",
    "email": "mask",
    "nationalId": "redact",
    "bankCard": "redact"
  },
  "businessData": {
    "default": "allow",
    "fieldNames": {
      "contract_amount": "redact",
      "process_formula": "redact",
      "yield_rate": "mask"
    }
  },
  "urls": {
    "dropFragment": true,
    "sensitiveQueryKeys": [
      "token", "access_token", "refresh_token", "code", "key",
      "api_key", "secret", "signature", "sig", "password", "auth"
    ]
  },
  "tools": {
    "eval": { "mode": "block" },
    "screenshot": { "mode": "confirm" },
    "get_snapshot": { "mode": "sanitize" },
    "get_text": { "mode": "sanitize" },
    "read_file": { "mode": "sanitize", "maxBytes": 1048576 },
    "list_tabs": { "mode": "sanitize" }
  },
  "audit": {
    "enabled": true,
    "path": "%APPDATA%\\Helm\\audit-log.jsonl",
    "includeResultPreview": false,
    "retentionDays": 30,
    "maxFileBytes": 10485760
  }
}
```

### 5.3 配置约束

- `customPatterns` 只能由受信任管理员配置；必须限制正则长度并拒绝高风险表达式，避免 ReDoS。
- 用户自定义规则可以收紧，不能覆盖不可降级规则。
- 配置对象加载后深冻结，单次调用使用同一个不可变快照。
- 第一版不必实现热重载；如实现，采用“完整解析和校验成功后原子替换”，不能原地修改。
- 配置日志只记录 `version`、`mode`、文件路径和 SHA-256，不记录完整配置内容。

## 6. 检测与脱敏算法

### 6.1 字段名检测

字段名先规范化：转小写，移除 `-_.空格`，再匹配：

```text
password, passwd, pwd, passcode
token, accesstoken, refreshtoken, idtoken
authorization, auth, bearer
apikey, secret, clientsecret
cookie, setcookie, sessionid
privatekey, signingkey
```

命中后对字段值执行 `redact`，不能只截断。

### 6.2 内容检测

第一版至少实现并单元测试：

- JWT：三段 base64url 结构，并设置合理长度边界；
- Bearer/Basic Authorization；
- PEM 私钥块；
- GitHub、AWS、Google 等明确前缀的常见密钥；
- URL 内敏感查询参数；
- 中国手机号、身份证号、银行卡号（银行卡需 Luhn 校验以降低误报）；
- 邮箱地址；
- 高熵长字符串仅作为辅助信号，不得单独默认删除普通业务 ID。

检测顺序：结构来源规则 → 字段名规则 → 明确秘密模式 → 个人数据模式 → 企业自定义规则。

每个 detector 返回：

```ts
type Detection = {
  type: string;
  start: number;
  end: number;
  severity: "S1" | "S2" | "S3";
  detector: string;
};
```

重叠区间合并后从字符串尾部向前替换，避免索引漂移。Detector 不得返回匹配原文。

### 6.3 结构化递归脱敏

`redactValue(value, context)` 必须：

- 支持 string、number、boolean、null、array、plain object；
- 设置最大深度、最大节点数、最大数组长度；
- 处理循环引用并返回 `[CIRCULAR]`；
- 不调用对象自定义 `toJSON()`；
- 不因 getter 抛错导致整个请求失败；
- 返回新对象，不能修改原始工具结果；
- 返回 `{ value, report }`，其中 report 仅含类型计数和截断计数。

示例安全返回：

```json
{
  "value": "[REDACTED:PASSWORD]",
  "sensitive": true
}
```

通用对象不要擅自改变业务 Schema。推荐在工具结果顶层添加：

```json
{
  "data": { "...": "..." },
  "_helmSecurity": {
    "redacted": true,
    "counts": { "PASSWORD": 1, "PHONE": 2 },
    "truncated": false
  }
}
```

为保持现有工具兼容，第一阶段可保留原顶层结构，仅增加可选 `_helmSecurity`。

## 7. 按工具的具体设计

### 7.1 `get_snapshot`

在 `dom-agent.js` 的 `describe()` 中实施来源保护：

1. `input[type=password]` 永不读取 `value`；返回 `attrs.value = "[REDACTED:PASSWORD]"` 或直接省略。
2. 对 `autocomplete` 包含 `current-password`、`new-password`、`one-time-code` 的元素同样处理。
3. 对 `name/id/aria-label/placeholder` 命中秘密字段名的元素，不采集值；元素文字也要谨慎处理。
4. 增加 `data-helm-sensitive="mask|redact|omit"` 支持；祖先为 `omit` 时整个子树不进入快照。
5. 默认不采集普通输入框的 `value`。如果业务确需，新增显式参数 `includeInputValues=false`，且密码类永远不可开启。
6. 增加 `maxElements`、`maxTextCharsPerElement`、`rootRef` 或 `selector` 范围参数。
7. `href` 必须经过 Gateway URL sanitizer；扩展可先做一次轻量处理，但 Gateway 仍需复检。
8. Gateway 对最终结构执行通用递归 DLP。

**双道容量限制**：

容量限制必须在**扩展采集端**和 **Gateway** 各执行一次，不能只依赖其中一道：

- **第一道（扩展端）**：`dom-agent.js` 的 `buildSnapshot` 在采集阶段执行：
  - 元素数量达到 `maxElements` 后停止遍历，返回已采集的元素并标记 `truncated: true`。
  - 每个元素的 `text` 截断到 `maxTextCharsPerElement`。
  - **目的**：阻止敏感数据进入 WebSocket 传输，减少内存占用和网络带宽。

- **第二道（Gateway）**：`redactValue` 对扩展返回的快照结构再次执行：
  - 检查 `elements` 数组长度，超过 `maxElements` 时截断并标记。
  - 检查每个元素的 `text` 长度，超过 `maxStringChars` 时截断。
  - **目的**：防止旧版扩展、恶意扩展或兼容问题绕过来源限制，确保敏感数据不进入模型上下文。

两道限制的默认值可以不同（扩展端可略宽松），但 Gateway 的限制是最终防线，不可绕过。

建议工具 Schema 新增：

```json
{
  "maxElements": 500,
  "maxTextCharsPerElement": 160,
  "includeInputValues": false,
  "selector": "#main"
}
```

`selector` 只用于选择采集根节点，不执行任意 JS；选择器非法时返回安全错误。

### 7.2 `get_text`

- 返回前经过 Gateway DLP。
- 增加 `maxChars`，默认 20,000，最大值由策略决定。
- 如果目标元素或祖先标记 `data-helm-sensitive="omit"`，返回拒绝信息而非文本。
- 如果目标是密码/秘密输入控件，返回 `[REDACTED:<TYPE>]`。
- 返回 `_helmSecurity` 的脱敏与截断元数据。

**双道容量限制**：

与 `get_snapshot` 相同，`get_text` 的 `maxChars` 限制必须在扩展端和 Gateway 各执行一次：

- **第一道（扩展端）**：`dom-agent.js` 的 `getText(ref)` 在读取 `innerText`/`textContent` 后立即截断到 `maxChars`，返回 `{ text, truncated: true }`。**目的**：阻止大段敏感文本进入 WebSocket。
- **第二道（Gateway）**：`redactValue` 对扩展返回的 `text` 字段再次检查长度，超过 `maxStringChars` 时截断。**目的**：防止旧版/恶意扩展绕过来源限制。

扩展端的 `maxChars` 默认值可与 Gateway 的 `maxStringChars` 相同（20,000），但 Gateway 的限制是最终防线。

### 7.3 `fill`

`fill` 是模型向页面发送数据，不是页面向模型泄漏，但它会通过 UI 和日志泄漏：

- 扩展 `summarizeArgs()` 对 `action === "fill"` 的 `value` 无条件替换为 `[REDACTED:INPUT]`，记录 `valueLength` 即可。
- Gateway 审计对 `fill.value` 无条件脱敏，即使字段不是密码。
- Side Panel 只显示 ref、长度和字段类型，不显示实际文本。
- 执行错误不得拼接输入值。
- 如需调试，提供仅本地内存、默认关闭的开发开关；禁止落盘，禁止 managed 模式开启。

### 7.4 `eval`

`eval` 无法通过返回值正则实现可靠安全，因为代码可编码、切片或加密敏感数据。处理原则：

- `managed` 默认 `block`；`balanced` 默认 `confirm`，并明确提示可访问页面全部数据。
- **confirm 使用 §4.3 的确认令牌机制**，不复用 `allow_once`：
  - `argsDigest = SHA-256(code)`，绑定具体代码内容。
  - 令牌有效期 60 秒，过期后需重新确认。
  - 确认只对本次 `requestId` 有效，不可重放。
  - 用户确认后若修改 `code` 或 `arg`，`argsDigest` 校验失败，拒绝执行。
- 不要声称通过拦截 `document.cookie` 等关键字即可安全允许；这种方案很容易绕过。
- 即使获准执行，返回结果仍必须经过 Gateway DLP 和容量限制。
- 审计只记录代码 SHA-256、代码长度、授权来源，不记录代码正文和 `arg` 原文。
- 后续如需安全脚本能力，应新增受限工具（如 `query_selector_text`、`extract_table`），而不是扩展 eval 白名单。

### 7.5 `screenshot`

截图是不可结构化载体，第一阶段不实现”可靠像素脱敏”：

- `managed` 默认 block 或 confirm；由策略决定。
- **confirm 使用 §4.3 的确认令牌机制**，不复用 `allow_once`：
  - `argsDigest = SHA-256(JSON.stringify({format, quality}))`，绑定截图参数。
  - 令牌有效期 60 秒，过期后需重新确认。
  - 确认只对本次 `requestId` 有效，不可重放。
  - 用户确认后若修改 `format` 或 `quality`，`argsDigest` 校验失败，拒绝执行。
- 调用前提示截图可能包含客户数据、密码、通知和其他标签页浮层。
- 不把 base64 写入审计或 Side Panel 动作摘要。
- 审计只记录尺寸、格式、字节数和 SHA-256。
- 可选第二阶段：扩展根据 `data-helm-sensitive` 和密码控件坐标，在截图前临时覆盖遮罩；遮罩必须在 `finally` 中移除。
- OCR 脱敏只能作为附加能力，不作为安全保证。

### 7.6 `list_tabs`、`list_frames`、`navigate`、`download`

- 所有 URL 删除 fragment。
- 敏感 query value 替换为 `[REDACTED]`，保留 key 便于诊断。
- URL 中的 userinfo（`user:pass@host`）完全删除。
- `download` 审计不得记录带签名的完整 URL；只记录安全 URL、目标文件名、字节数和哈希。
- 下载结果返回路径是否暴露用户名由策略决定，可将用户目录替换为 `%USERPROFILE%`。

### 7.7 `read_file`、`save_file`、`list_files`

- `read_file` 内容返回前必须通用 DLP，并限制最大字节数；超限要求范围读取，而不是整文件读取。
- 为 `read_file` 增加 `offset`、`maxBytes`；返回 `truncated` 和 `nextOffset`。
- 二进制文件拒绝作为文本读取。
- `save_file.content` 在审计中永不记录，只记录字节数和 SHA-256。
- `list_files` 返回的路径可按策略隐藏用户目录；文件名也要经过字符串检测，防止文件名包含客户/身份信息。
- 不扫描或改写用户实际写入/下载的文件内容；DLP 控制的是进入模型上下文及 Helm 日志的副本。

### 7.8 `wait` 与错误信息

- `wait.text`、`textGone` 可能本身敏感，UI 和审计中按输入内容处理。
- 页面错误、网络错误和扩展异常统一经过 `sanitizeError()`。
- 生产返回错误应包含错误码、工具名和安全摘要，不返回堆栈；堆栈只在显式开发模式输出，且仍需 URL/secret 清洗。

## 8. 日志设计

### 8.1 唯一审计入口

删除 `mcp-server.mjs`、`http-server.mjs` 和 `sw.js` 中各自的自由格式敏感摘要逻辑。Gateway `security/audit.mjs` 是唯一落盘者；扩展只发送事件，不负责写日志。

建议 JSONL Schema：

```json
{
  "schemaVersion": 1,
  "time": "2026-08-08T12:00:00.000Z",
  "requestId": "uuid",
  "transport": "mcp",
  "tool": "fill",
  "outcome": "success",
  "durationMs": 42,
  "args": {
    "ref": "14",
    "value": "[REDACTED:INPUT]",
    "valueLength": 16
  },
  "result": {
    "ok": true
  },
  "security": {
    "policyVersion": 1,
    "redactionCounts": { "INPUT": 1 },
    "truncated": false
  }
}
```

### 8.2 日志规则

- 默认不保存结果 preview。
- 对所有工具记录固定 allowlist 字段，不要对未知对象做 `JSON.stringify(...).slice(...)`。
- 文件权限尽量限制为当前用户；启动时检测权限异常并告警。
- 实现按大小轮转；保留天数清理由独立、可测试函数完成。
- 日志写入失败不得把待写入内容放进错误消息。
- 禁止记录 MCP 原始请求行、HTTP Authorization header、HTTP 原始 body、WebSocket 原始 payload。
- 不在 stderr 输出随机生成的完整 `HELM_API_KEY`。首次生成时写入权限受限文件，stderr 只打印存放位置和后四位。

## 9. Side Panel 设计

- Side Panel 只接收 `safeDisplayArgs` 与 `safeDisplaySummary`，不接收原始参数和结果。
- `fill`、`wait.text`、`eval.arg/code`、`save_file.content` 全部使用专用摘要。
- screenshot 可显示缩略图意味着它仍可能泄密；managed 模式下默认不在 Side Panel 缓存或显示。
- 清空动作流时释放对象 URL 和内存中的截图数据。
- UI 中显示“已脱敏 N 项”和策略模式，帮助用户理解数据已被处理。

## 10. MCP 与 HTTP 接口兼容

### 10.1 返回格式

第一阶段保持工具的主要返回 Schema，允许追加：

```json
"_helmSecurity": {
  "redacted": true,
  "counts": { "TOKEN": 1 },
  "truncated": false,
  "policyVersion": 1
}
```

不要把检测位置、匹配文本、前后文写入元数据。

### 10.2 新增管理工具

可以新增只返回安全状态的工具：

- `get_security_status`：策略模式、版本、配置哈希、启用的 detector 名称、最近统计。
- `reload_security_policy`：仅本地显式调用；managed 模式可禁用。

不要新增“显示被脱敏原文”或“临时关闭所有脱敏”的工具。

## 11. 实施步骤

### 阶段 A：堵住确定性泄漏（必须先合并）

1. 为当前泄漏建立失败测试。
2. 新建 `security/` 的纯函数 detector、URL sanitizer、递归 redactor。
3. `dom-agent.describe()` 禁止密码/OTP/秘密字段 value；普通 input 默认不返回 value。
4. `fill`、`save_file.content`、`eval` 参数从 Side Panel 和所有日志中移除。
5. 建立统一 `tool-executor.mjs`，stdio/HTTP 都走同一输出 DLP。
6. 统一安全错误处理。
7. 禁止日志打印完整 HTTP API key。

阶段 A 验收：测试夹具中的密码、JWT、Cookie、API Key、私钥无法出现在 MCP 返回、HTTP 返回、Side Panel 消息、stderr 和 audit 文件中。

### 阶段 B：数据最小化与企业策略

1. 加载并校验 `security-policy.json`。
2. 快照增加范围与容量参数。
3. `get_text`、`read_file` 增加分页/截断能力。
4. 实现个人数据与自定义业务字段规则。
5. 实现 `data-helm-sensitive`。
6. 增加 `_helmSecurity` 元数据与 `get_security_status`。
7. audit JSONL、轮转与保留策略。

### 阶段 C：高风险载体

1. managed 模式下 eval block。
2. screenshot 策略门禁。
3. 可选 DOM 坐标遮罩截图，但不降低 screenshot 风险等级。
4. 对下载、文件路径和 iframe URL 做完整安全处理。

## 12. 测试方案

### 12.1 单元测试

新增 Node 测试目录：

```text
gateway/test/security/
  detectors.test.mjs
  redact.test.mjs
  url-sanitizer.test.mjs
  tool-policy.test.mjs
  audit.test.mjs
  config.test.mjs
```

覆盖：

- 每种秘密的正例和近似反例；
- 多个、重叠、跨大小写匹配；
- URL 编码 query、重复 key、userinfo、fragment；
- 深层对象、超大数组、循环引用、恶意 getter；
- Unicode、中文字段名、emoji；
- 超长字符串与 ReDoS 超时基准；
- 配置错误和 managed fail closed；
- redactor 幂等性：脱敏结果再次脱敏不应继续变化；
- 原对象不被修改。

### 12.2 扩展测试页面

建立本地 fixture 页面，包含：

- password、OTP、普通 input；
- 隐藏 input token；
- 含 JWT/手机号/身份证的文本；
- `data-helm-sensitive` 三种模式；
- iframe 敏感内容；
- 大表格和超长页面；
- URL 查询 token 和 fragment。

验证 snapshot/get_text 结果以及 Side Panel 消息。

### 12.3 端到端矩阵

对 MCP stdio 与 HTTP 分别执行：

| 工具 | 敏感输入/输出 | 验证位置 |
|---|---|---|
| get_snapshot | 密码、Token、客户字段 | 返回、audit、UI |
| get_text | JWT、手机号、商业字段 | 返回、audit |
| fill | 密码和普通业务文本 | UI、audit、错误 |
| list_tabs | URL token | 返回、UI、audit |
| read_file | 私钥、API Key | 返回、audit |
| save_file | 密钥内容 | audit、UI |
| eval | cookie/storage 读取 | policy block、audit |
| screenshot | 敏感页面 | confirm/block、无 base64 日志 |
| download | 签名 URL | 返回、audit |

测试结束后对所有产物执行 canary 搜索。每个测试秘密使用唯一随机 canary，例如 `HELM_TEST_SECRET_...`，断言它不出现在：

```text
MCP stdout
HTTP response
audit-log.jsonl
captured stderr
Side Panel 消息记录
```

### 12.4 性能指标

- 200 KB 文本 DLP P95 小于 30 ms（基准机器需记录）。
- 500 个元素快照的额外处理 P95 小于 50 ms。
- detector 必须线性或近似线性，不允许灾难性回溯。
- 达到输出预算时截断并返回元数据，不能内存无限增长。

## 13. 验收标准

以下条件全部满足才算完成：

1. S3 canary 在所有模型输出通道和日志通道中为零命中。
2. password/OTP 字段值从扩展采集阶段即不可见。
3. stdio 与 HTTP 对同一调用产生等价的安全结果。
4. `fill.value`、`save_file.content`、`eval.code/arg` 不落盘、不进入 UI。
5. URL token、userinfo 和 fragment 被处理。
6. managed 模式下配置缺失/损坏时工具执行 fail closed。
7. eval 与 screenshot 按策略被 block/confirm，且没有“正则足够安全”的错误承诺。
8. 所有输出有容量上限，超限行为可预测且有元数据。
9. 安全模块单元测试、扩展 fixture 和双传输端到端测试全部通过。
10. 文档说明剩余风险：截图、已获准 eval、模型对未配置业务机密的语义判断、同权限本地用户篡改程序。

## 14. 编程智能体实施约束

将本文件交给编程智能体时，同时给出以下约束：

1. 先写测试再改执行路径，按阶段 A、B、C 分开提交。
2. 不进行与安全设计无关的大规模重构。
3. 不改变现有工具名称和主要参数语义；新增参数必须有安全默认值。
4. 不把敏感样例写入真实日志；测试只使用一次性 canary。
5. 不用截断代替脱敏，不用 hash 代替密码字段的删除，不保存被脱敏原文。
6. 不依赖模型提示词保证安全。
7. 不以关键字过滤宣称 eval 安全。
8. stdio 与 HTTP 必须复用同一执行和 DLP 模块。
9. 每个阶段完成后运行 canary 泄漏扫描，并在变更说明中列出扫描范围和结果。
10. 遇到兼容性与安全性冲突时，S3 数据保护优先；需要放宽时必须由人工评审设计，而不是加入隐藏 bypass。

## 15. 建议的首个编程任务

可直接向编程智能体下达：

> 实施《Helm 敏感信息保护详细设计》的阶段 A。先为 password snapshot、fill 日志、URL token、read_file 私钥、HTTP API key 日志建立失败测试；随后实现 `gateway/security` 的 detector、URL sanitizer、递归 redactor和统一 audit，建立 `gateway/tool-executor.mjs` 让 stdio 与 HTTP 共用安全执行路径。修改 `dom-agent.js`，使 password、OTP、秘密字段及默认普通 input 均不返回 value；修改扩展动作展示，使 fill/save/eval 敏感参数永不进入 Side Panel。不得实现通用关闭脱敏的 bypass。完成后运行单元测试、MCP/HTTP 端到端 canary 扫描并报告结果。
