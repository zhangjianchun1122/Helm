/**
 * tools-def.mjs — 工具定义共享模块
 *
 * 被 mcp-server.mjs（MCP stdio）和 http-server.mjs（OpenAI 兼容 HTTP）共同引用。
 * 包含：TOOLS 数组（名称+描述+JSON Schema）、mapToolToAction（MCP工具名→扩展action映射）。
 */

// 从环境变量读取默认过滤级别，支持 HELM_FILTER_LEVEL=none|basic|smart
const VALID_FILTER_LEVELS = ['none', 'basic', 'smart'];
const envFilterLevel = process.env.HELM_FILTER_LEVEL?.toLowerCase();
const DEFAULT_FILTER_LEVEL = VALID_FILTER_LEVELS.includes(envFilterLevel) ? envFilterLevel : 'basic';

export const TOOLS = [
  {
    name: 'navigate',
    description: '在当前 tab 打开指定 URL，等待页面加载完成。用于任务起始或切换页面。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标 URL，含 http(s)://' },
      },
      required: ['url'],
    },
  },
  {
    name: 'list_tabs',
    description: '列出浏览器当前所有打开的 tab（含 id/url/title）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_frames',
    description: '列出当前页所有 iframe（含 frameId/url）。站点若有内嵌 frame，操作前需用本工具定位目标 frame。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_snapshot',
    description: '获取当前页（或指定 frame）的可交互元素快照。返回每个元素的 ref、tag、text、属性、坐标。后续 click/fill 等操作用 ref 引用元素。这是 Agent 感知页面的主要手段，应优先调用。',
    inputSchema: {
      type: 'object',
      properties: {
        frameId: { type: 'integer', description: '目标 iframe 的 frameId；省略则作用于主文档' },
        interactiveOnly: { type: 'boolean', default: true, description: '是否只返回可交互元素' },
        filterLevel: {
          type: 'string',
          enum: ['none', 'basic', 'smart'],
          default: DEFAULT_FILTER_LEVEL,
          description: `过滤级别：none=不过滤，basic=过滤广告/装饰元素，smart=基础过滤+智能去重（更省 token）。默认值: ${DEFAULT_FILTER_LEVEL}（可通过环境变量 HELM_FILTER_LEVEL 配置）`
        },
      },
    },
  },
  {
    name: 'click',
    description: '点击 get_snapshot 返回的某 ref 元素。button 可为 left/right，right 用于触发右键菜单。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'get_snapshot 返回的 ref' },
        button: { type: 'string', enum: ['left', 'right'], default: 'left' },
        frameId: { type: 'integer' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'right_click',
    description: '用 chrome.debugger 发真实右键事件（isTrusted=true），用于触发依赖原生 contextmenu 的自定义右键菜单。合成事件触发不了的站点右键菜单用这个。先 get_snapshot 拿 ref，再调本工具。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'get_snapshot 返回的 ref' },
        frameId: { type: 'integer' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'fill',
    description: '向输入框 ref 填入文本（账号、搜索词等），会清空原值并触发 input/change 事件。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        value: { type: 'string' },
        frameId: { type: 'integer' },
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'press',
    description: '在当前焦点元素上触发键盘事件（Enter/Escape/Tab/ArrowDown 等）。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'KeyEvent key 名，如 Enter' },
        frameId: { type: 'integer' },
      },
      required: ['key'],
    },
  },
  {
    name: 'get_text',
    description: '读取某 ref 元素的纯文本（读表格行、读列表内容等）。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        frameId: { type: 'integer' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'eval',
    description: '⚠️ 高危工具（执行任意 JS）。首次调用前需用户授权：若返回权限错误，请使用 AskUserQuestion 询问用户是否允许，选项包括"本次允许"和"总是允许（会话级/项目级/用户级）"。用户同意后调用 set_permission 保存权限，然后重新调用本工具。在页面（MAIN world 等价）执行任意 JS，返回序列化结果。逃生口：用于读取内部数据结构、调用隐藏 API、序列化复杂 DOM 树等。code 是函数体，可使用参数 arg。所有站点可用（经 MAIN world 注入绕过扩展 CSP）。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '函数体代码，例如 "return document.title"' },
        arg: { description: '任意传参，将被序列化后传入' },
        frameId: { type: 'integer' },
      },
      required: ['code'],
    },
  },
  {
    name: 'wait',
    description: '等待页面条件成立后再继续，避免在元素未就绪时操作导致 ref 失效或点击落空。支持等文本出现/消失、选择器匹配、网络空闲。超时返回 ok:false（不抛错），由 Agent 判断是否继续。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '等页面出现包含此子串的文本' },
        textGone: { type: 'string', description: '等页面不再包含此子串的文本' },
        selector: { type: 'string', description: '等此 CSS 选择器匹配到元素' },
        selectorGone: { type: 'string', description: '等此 CSS 选择器不再匹配到元素' },
        idleMs: { type: 'integer', description: '等 DOM 静止这么长毫秒' },
        timeoutMs: { type: 'integer', default: 10000, description: '总超时毫秒' },
        intervalMs: { type: 'integer', default: 200, description: '轮询间隔毫秒' },
        frameId: { type: 'integer' },
      },
    },
  },
  {
    name: 'screenshot',
    description: '截取当前 tab 可视区域的截图，返回 base64 PNG。用于视觉确认、记录操作证据。只能截可视区域（非整页），限频约 2 次/秒。',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['png', 'jpeg'], default: 'png' },
        quality: { type: 'integer', description: 'jpeg 质量 0-100' },
      },
    },
  },
  {
    name: 'scroll',
    description: '滚动页面。传 ref 则滚动到该元素；传 direction+amount 则按方向滚动指定像素。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '滚动到某 ref 元素' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer', default: 300 },
        frameId: { type: 'integer' },
      },
    },
  },
  {
    name: 'hover',
    description: '鼠标悬停在 ref 元素上，触发依赖 hover 的下拉菜单、tooltip、CSS :hover 状态。不触发点击。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        frameId: { type: 'integer' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'set_active_frame',
    description: '设置后续操作的默认 iframe 作用域。传 frameId 设定；传 null/省略回到主文档。',
    inputSchema: {
      type: 'object',
      properties: {
        frameId: { type: 'integer', description: 'list_frames 返回的 frameId；传 null 回到主文档' },
      },
    },
  },
  {
    name: 'get_active_frame',
    description: '查询当前默认 frame 作用域。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'drag',
    description: '把 fromRef 元素拖拽到 toRef 元素位置。同时模拟鼠标序列和原生 HTML5 DnD 事件。',
    inputSchema: {
      type: 'object',
      properties: {
        fromRef: { type: 'string' },
        toRef: { type: 'string' },
        steps: { type: 'integer', default: 10 },
        frameId: { type: 'integer' },
      },
      required: ['fromRef', 'toRef'],
    },
  },
  {
    name: 'save_file',
    description: '⚠️ 高危工具（写入本地文件，覆盖模式）。首次调用前需用户授权：若返回权限错误，请使用 AskUserQuestion 询问用户是否允许，选项包括"本次允许"和"总是允许（会话级/项目级/用户级）"。用户同意后调用 set_permission 保存权限，然后重新调用本工具。append=true 时追加（追加不视为高危，无需授权）。把文本内容写到本地任意路径。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        append: { type: 'boolean', default: false },
        encoding: { type: 'string', default: 'utf8' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_file',
    description: '读取本地文本文件内容。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        encoding: { type: 'string', default: 'utf8' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: '列出目录下的文件/子目录。',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        recursive: { type: 'boolean', default: false },
      },
      required: ['dir'],
    },
  },
  {
    name: 'download',
    description: '⚠️ 高危工具（下载文件到本地）。首次调用前需用户授权：若返回权限错误，请使用 AskUserQuestion 询问用户是否允许，选项包括"本次允许"和"总是允许（会话级/项目级/用户级）"。用户同意后调用 set_permission 保存权限，然后重新调用本工具。下载文件到本地任意路径。url 模式：网关 fetch 写盘；ref 模式：从页面元素取 href 再下载。网关 fetch 失败时自动 fallback 扩展 chrome.downloads。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '下载地址（与 ref 二选一）' },
        ref: { type: 'string', description: '页面元素 ref（与 url 二选一）' },
        path: { type: 'string', description: '保存路径。省略则存到 downloads/<文件名>' },
        frameId: { type: 'integer' },
      },
    },
  },
  // ---------- 权限管理工具 ----------
  {
    name: 'set_permission',
    description: '设置高危工具的权限。当用户选择"总是允许"时调用此工具保存权限。scope 可选：session（仅当前会话）、project（当前项目所有会话）、user（所有项目的所有会话）。',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '工具名：eval / download / save_file' },
        scope: { type: 'string', enum: ['session', 'project', 'user'], description: '权限级别' },
      },
      required: ['tool', 'scope'],
    },
  },
  {
    name: 'allow_once',
    description: '允许高危工具单次执行，执行后自动撤销权限。当用户选择"本次允许"时调用此工具。',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '工具名：eval / download / save_file' },
      },
      required: ['tool'],
    },
  },
  {
    name: 'get_permissions',
    description: '获取所有高危工具的权限状态，显示哪些工具在哪些级别已授权。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'revoke_permission',
    description: '撤销高危工具的权限。scope 可选：session / project / user / all（撤销所有级别）。',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '工具名：eval / download / save_file' },
        scope: { type: 'string', enum: ['session', 'project', 'user', 'all'], default: 'all', description: '权限级别，默认 all' },
      },
      required: ['tool'],
    },
  },
];

// ---------- MCP 工具 -> 扩展 action 映射 ----------
export function mapToolToAction(name, args) {
  if (name === 'set_active_frame') {
    const a = args || {};
    return ['setActiveFrame', { frameId: a.frameId }, {}];
  }
  if (name === 'get_active_frame') {
    return ['getActiveFrame', {}, {}];
  }
  const { frameId, ...rest } = args || {};
  const opts = frameId != null ? { frameId } : {};
  switch (name) {
    case 'navigate':      return ['navigate', { url: rest.url }, opts];
    case 'list_tabs':     return ['listTabs', {}, opts];
    case 'list_frames':   return ['listFrames', {}, opts];
    case 'get_snapshot':  return ['snapshot', { options: { interactiveOnly: rest.interactiveOnly ?? true, filterLevel: rest.filterLevel ?? DEFAULT_FILTER_LEVEL } }, opts];
    case 'click':         return ['click', { ref: rest.ref, button: rest.button || 'left' }, opts];
    case 'right_click':   return ['rightClick', { ref: rest.ref }, opts];
    case 'fill':          return ['fill', { ref: rest.ref, value: rest.value }, opts];
    case 'press':         return ['press', { key: rest.key }, opts];
    case 'get_text':      return ['getText', { ref: rest.ref }, opts];
    case 'eval':          return ['eval', { code: rest.code, arg: rest.arg }, opts];
    case 'wait':          return ['wait', {
      text: rest.text, textGone: rest.textGone,
      selector: rest.selector, selectorGone: rest.selectorGone,
      idleMs: rest.idleMs, timeoutMs: rest.timeoutMs, intervalMs: rest.intervalMs,
    }, opts];
    case 'screenshot':    return ['screenshot', { format: rest.format, quality: rest.quality }, opts];
    case 'scroll':        return ['scroll', {
      options: { ref: rest.ref, direction: rest.direction, amount: rest.amount },
    }, opts];
    case 'hover':         return ['hover', { ref: rest.ref }, opts];
    case 'drag':          return ['drag', { fromRef: rest.fromRef, toRef: rest.toRef, options: { steps: rest.steps } }, opts];
    default: throw new Error(`未知工具: ${name}`);
  }
}

// 本地工具（不经扩展 invoke）
export function isLocalTool(name) {
  return name === 'save_file' || name === 'read_file' || name === 'list_files' || name === 'download'
    || name === 'set_permission' || name === 'get_permissions' || name === 'revoke_permission'
    || name === 'allow_once';
}

// 高危判定
export function isHighRisk(name, args = {}) {
  if (name === 'download' || name === 'eval') return true;
  if (name === 'save_file' && !args?.append) return true;
  return false;
}
