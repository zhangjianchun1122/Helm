/**
 * sw.js — service worker（MV3）
 *
 * 职责：路由调度，无状态。
 *   上游：offscreen 经 chrome.runtime.sendMessage 推来的网关指令（短消息，非长连接）
 *   下游：tabs.sendMessage / scripting.executeScript 转发给各 frame 的 dom-agent
 *
 * 状态只存当前目标 tabId（可被 SW 回收后重建时从 storage 恢复）。
 *
 * 注意：Chrome 150 起，SW 内发起的 chrome.runtime.connect 长连接不再可用
 * （自连也会报 "Could not establish connection. Receiving end does not exist."）。
 * 故 offscreen↔sw 改用 sendMessage/onMessage 短消息通信。
 */

importScripts('redact-lite.js');

const OFFSCREEN_URL = 'offscreen.html';

let pendingTabId = null;      // 当前操作目标 tab（Agent 未指定时用 activeTab）
// 默认 frame 按 tab 隔离：tabId -> frameId。
// 早前是单个全局值，set_active_frame 设的 frame 会泄漏到后续显式 tabId 指向的其它标签页
// （frame 隶属于 tab，同一个 frameId 在别的 tab 里是另一个 frame 或不存在）。
const frameScopes = new Map();

// ---------- offscreen 生命周期 ----------
async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    // 'LOCAL_STORAGE' 是合法 reason 枚举值；Chrome 只校验数组非空与枚举合法
    reasons: ['LOCAL_STORAGE'],
    justification: '维持与本地网关的 WebSocket 长连接，跨 service worker 回收保持会话',
  });
}

// ---------- 当前 tab ----------
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function resolveTabId(tabIdHint) {
  if (tabIdHint) return tabIdHint;
  if (pendingTabId) {
    // 校验仍存在
    try { await chrome.tabs.get(pendingTabId); return pendingTabId; } catch (_) { /* fallthrough */ }
  }
  const tab = await getActiveTab();
  pendingTabId = tab?.id || null;
  return pendingTabId;
}

// 解析目标 frame：调用方显式传的 frameId 优先；否则用该 tab 自己的 set_active_frame 设定；
// 都无则 null（主文档）。frame 作用域按 tab 查，避免跨标签页复用别的 tab 的 frameId。
// 注意：frameId 传 0 也合法（主文档），故用 != null 判断
function resolveFrameId(frameIdHint, tabId) {
  if (frameIdHint != null) return frameIdHint;
  if (tabId == null) return null;
  const scoped = frameScopes.get(tabId);
  return scoped != null ? scoped : null;
}

async function persistFrameScopes() {
  await chrome.storage.session.set({ frameScopes: Object.fromEntries(frameScopes) });
}

// 设定只对某个 tab 生效的默认 frame。tabId 省略时作用于当前目标 tab。
async function setActiveFrame(frameId, tabIdHint) {
  const tabId = await resolveTabId(tabIdHint);
  if (!tabId) throw new Error('set_active_frame: 无可操作的 tab');
  // frameId 传 null/undefined 表示回到主文档；list_frames 的 frameId=0 即主文档
  if (frameId == null) {
    frameScopes.delete(tabId);
  } else {
    frameScopes.set(tabId, Number(frameId));
  }
  await persistFrameScopes();
  const activeFrameId = frameScopes.has(tabId) ? frameScopes.get(tabId) : null;
  return { ok: true, tabId, activeFrameId };
}

async function getActiveFrame(tabIdHint) {
  const tabId = await resolveTabId(tabIdHint);
  const activeFrameId = tabId != null && frameScopes.has(tabId) ? frameScopes.get(tabId) : null;
  return {
    ok: true, tabId, activeFrameId,
    note: activeFrameId == null ? '主文档（该 tab 未设定活跃 frame）' : `frame #${activeFrameId}（仅对 tab ${tabId} 生效）`,
  };
}

// ---------- frame 解析 ----------
// 列出所有 frame，便于 Agent 跨 iframe 操作
async function listFrames(tabId) {
  const [tab] = await chrome.tabs.query({ active: false }); // noop 占位
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  return (frames || [])
    .filter((f) => f.url && f.url !== 'about:blank')
    .map((f) => ({ frameId: f.frameId, url: f.url, parent: f.parentFrameId }));
}

// ---------- 向某 frame 的 dom-agent 下发指令 ----------
// dom-agent 回包结构：{ ok:true(传输成功), data:{实际结果} }。
// data 本身可能是 {ok:false, error}（如 ref 失效、未知 direction）。
// 这里解包 data 后必须再检查 data.ok，否则错误会被当成成功结果返回给调用方。
async function dispatchToFrame(action, payload, { frameId, tabIdHint } = {}) {
  const tabId = await resolveTabId(tabIdHint);
  if (!tabId) throw new Error('无可操作的 tab（请先在浏览器打开目标页面）');
  const resolvedFrameId = resolveFrameId(frameId, tabId);
  const msg = { target: 'dom-agent', action, ...payload };
  const options = resolvedFrameId != null ? { frameId: resolvedFrameId } : undefined;
  const unwrap = (res) => {
    if (!res || !res.ok) throw new Error(res?.data?.error || res?.error || `frame 内执行失败: ${action}（dom-agent 可能未注入，请先 get_snapshot 触发注入）`);
    const data = res.data;
    // data 是 dom-agent 的实际结果对象，它自己有 ok 字段
    if (data && data.ok === false) throw new Error(data.error || `frame 内执行失败: ${action}`);
    return data;
  };
  try {
    const res = await chrome.tabs.sendMessage(tabId, msg, options);
    return unwrap(res);
  } catch (e) {
    // 可能是 content script 还没注入，尝试主动注入后再发
    if (String(e).includes('Could not establish connection') || String(e).includes('Receiving end does not exist')) {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: resolvedFrameId == null, ...(resolvedFrameId != null ? { frameIds: [resolvedFrameId] } : {}) },
        files: ['content/source-guard.js', 'content/dom-agent.js'],
      });
      const res2 = await chrome.tabs.sendMessage(tabId, msg, options);
      return unwrap(res2);
    }
    throw e;
  }
}

// ---------- 指令路由表：action -> handler ----------
// 广播动作流给 side panel（bt-action），无接收方时忽略错误
// 高亮策略：常亮模式——只要页面在操作就一直显示发光边框，空闲 8s 或切 tab 才淡出
let highlightTabId = null;       // 当前高亮的 tab（用于切 tab 时熄灭旧页）
let highlightTimer = null;       // 空闲超时计时器
const HIGHLIGHT_IDLE_MS = 8000;  // 空闲多久后淡出

function broadcastAction(phase, info) {
  try {
    chrome.runtime.sendMessage({ type: 'bt-action', phase, ...info }).catch(() => {});
  } catch (_) { /* side panel 未开或 SW 已回收 */ }
  // 高亮：start 点亮/更新标签；end 只更新标签（保持常亮），重置空闲计时
  if (phase === 'start') {
    highlightCurrentTab('start', info.action).catch(() => {});
  } else if (phase === 'end') {
    highlightCurrentTab('update', '✓ ' + info.action).catch(() => {});
    resetHighlightIdle().catch(() => {});
  }
}

// 重置空闲计时：8s 无新动作则淡出
async function resetHighlightIdle() {
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(async () => {
    if (highlightTabId) {
      try {
        await chrome.tabs.sendMessage(highlightTabId, { target: 'dom-agent', action: 'hideHighlight' });
      } catch (_) { /* ignore */ }
      highlightTabId = null;
    }
    highlightTimer = null;
  }, HIGHLIGHT_IDLE_MS);
}

// 给当前操作页面的主文档发高亮指令
// 只作用于主文档（frameId 不指定），避免 iframe 内闪烁叠加
async function highlightCurrentTab(phase, label) {
  const tabId = await resolveTabId();
  if (!tabId) return;
  // 切 tab：旧 tab 熄灭，新 tab 点亮
  if (highlightTabId && highlightTabId !== tabId) {
    try { await chrome.tabs.sendMessage(highlightTabId, { target: 'dom-agent', action: 'hideHighlight' }); } catch (_) {}
  }
  highlightTabId = tabId;
  const msg = { target: 'dom-agent', action: 'showHighlight', label };
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    // dom-agent 可能未注入主文档，尝试注入后再发
    if (/Could not establish connection|Receiving end does not exist/.test(String(e))) {
      try {
        await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ['content/source-guard.js', 'content/dom-agent.js'] });
        await chrome.tabs.sendMessage(tabId, msg);
      } catch (_) { /* ignore */ }
    }
  }
}

// 参数摘要：截断长值，不泄露完整内容（如 base64 截图）
function summarizeArgs(args = {}, action = '') {
  return HelmRedactLite.safeDisplayArgs(action, args);
}

async function handleAction(req) {
  const { action, args = {}, frameId, tabIdHint } = req;
  const t0 = Date.now();
  broadcastAction('start', { action, args: summarizeArgs(args, action) });

  try {
    const data = await handleActionInner(req);
    broadcastAction('end', { action, ok: true, durationMs: Date.now() - t0,
      summary: summarizeResult(action, data) });
    return data;
  } catch (e) {
    broadcastAction('end', { action, ok: false, durationMs: Date.now() - t0,
      error: HelmRedactLite.safeDisplayError(e?.message || e) });
    throw e;
  }
}

// 结果摘要：screenshot 等大结果截断
function summarizeResult(action, data) {
  if (!data || typeof data !== 'object') return data;
  if (action === 'screenshot' || action === 'doScreenshot') {
    return { ok: data.ok, format: data.format, size: data.size, hasImage: !!data.base64 };
  }
  if (action === 'snapshot') {
    return { url: data.url, elementCount: data.elementCount };
  }
  if (action === 'listTabs') {
    return { count: (data || []).length };
  }
  if (action === 'listFrames') {
    return { count: (data || []).length };
  }
  // 通用：截断
  try {
    const s = JSON.stringify(data);
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  } catch { return '[unserializable]'; }
}

async function handleActionInner(req) {
  const { action, args = {}, frameId, tabIdHint } = req;

  switch (action) {
    case 'navigate': {
      const tabId = await resolveTabId(args.tabId || tabIdHint);
      await chrome.tabs.update(tabId, { url: args.url });
      // 等待页面完成首次加载（dom-agent 由 document_idle 注入）
      await waitTabComplete(tabId);
      return { ok: true, url: args.url, tabId };
    }
    case 'createTab': {
      const created = await chrome.tabs.create({
        url: args.url || 'about:blank',
        active: args.active !== false,
      });
      await waitTabComplete(created.id);
      // 新标签立刻成为操作目标：onActivated 是异步的，且 active:false 时根本不触发，
      // 不显式接管的话 resolveTabId 会校验旧 tab 仍存在并继续返回旧 tab
      pendingTabId = created.id;
      // 新 tab 在 frameScopes 里本就没有条目，无需清理
      await chrome.storage.session.set({ pendingTabId });
      const tab = await chrome.tabs.get(created.id);
      return { ok: true, tabId: tab.id, url: tab.url || '', title: tab.title || '' };
    }
    case 'listTabs': {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active }));
    }
    case 'listFrames': {
      const tabId = await resolveTabId(args.tabId || tabIdHint);
      return listFrames(tabId);
    }
    case 'setActiveFrame':
      return setActiveFrame(args.frameId, args.tabId ?? tabIdHint);
    case 'getActiveFrame':
      return getActiveFrame(args.tabId ?? tabIdHint);
    case 'snapshot':
      return dispatchToFrame('snapshot', { options: args.options || {} }, { frameId, tabIdHint });
    case 'click':
      return dispatchToFrame('click', { ref: args.ref, button: args.button }, { frameId, tabIdHint });
    case 'rightClick': {
      // 用 chrome.debugger 发真实右键事件（isTrusted=true），触发依赖原生 contextmenu 的自定义菜单
      // 先从 dom-agent 拿元素坐标，再用 CDP Input.dispatchMouseEvent 发右键
      const tabId = await resolveTabId(args.tabId || tabIdHint);
      if (!tabId) throw new Error('无可操作的 tab');
      // 取元素坐标：复用 dispatchToFrame 的 snapshot 能力拿单个 ref 的 rect
      const snap = await dispatchToFrame('snapshot', { options: { interactiveOnly: false } }, { frameId, tabIdHint });
      const el = (snap.elements || []).find((e) => String(e.ref) === String(args.ref));
      if (!el) throw new Error(`rightClick: ref ${args.ref} 未在快照中找到`);
      const x = el.rect.x + el.rect.w / 2;
      const y = el.rect.y + el.rect.h / 2;
      await sendRealRightClick(tabId, x, y);
      return { ok: true, x, y };
    }
    case 'fill':
      return dispatchToFrame('fill', { ref: args.ref, value: args.value }, { frameId, tabIdHint });
    case 'press':
      return dispatchToFrame('press', { key: args.key }, { frameId, tabIdHint });
    case 'hover':
      return dispatchToFrame('hover', { ref: args.ref }, { frameId, tabIdHint });
    case 'drag':
      return dispatchToFrame('drag', { fromRef: args.fromRef, toRef: args.toRef, options: args.options }, { frameId, tabIdHint });
    case 'getText':
      return dispatchToFrame('getText', { ref: args.ref, offset: args.offset, maxChars: args.maxChars }, { frameId, tabIdHint });
    case 'scroll':
      return dispatchToFrame('scroll', { options: args.options || {} }, { frameId, tabIdHint });
    case 'eval':
      // 用 MAIN world 注入执行（不受扩展 CSP 限制），失败时 fallback 到 dom-agent
      return evalViaMainWorld(args.code, args.arg, { frameId, tabIdHint });
    case 'wait':
      return doWait(args, { frameId, tabIdHint });
    case 'screenshot':
      return doScreenshot(args, { tabIdHint });
    case 'downloadViaBrowser':
      return downloadViaBrowser(args.url, args.filename);
    default:
      throw new Error(`未知 action: ${action}`);
  }
}

// ---------- 真实右键事件（chrome.debugger CDP） ----------
// 合成 MouseEvent 的 isTrusted=false，很多站点的自定义右键菜单不响应。
// 用 chrome.debugger 的 Input.dispatchMouseEvent 发 isTrusted=true 的右键事件。
async function sendRealRightClick(tabId, x, y) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    // 可能已 attach（重复调用），忽略
    if (!String(e).includes('Another debugger is already attached')) throw e;
  }
  try {
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1,
    });
  } finally {
    try { await chrome.debugger.detach(target); } catch (_) { /* ignore */ }
  }
}

function waitTabComplete(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      // 给 dom-agent 一点注入时间
      setTimeout(resolve, 300);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    // about:blank 等瞬时完成的页面可能在挂监听前就已 complete，否则要白等满超时
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === 'complete') finish();
    }).catch(() => finish());
    // 兜底：5s 内没等到也算完成
    setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 5000);
  });
}

// ---------- wait：轮询 dom-agent 的 checkCondition 直到条件满足或超时 ----------
// 不在 dom-agent 里长等待（异步回包在 Chrome 150 下不可靠），而是 SW 反复调
// 同步的 checkCondition。命中即返回 ok:true；超时返回 ok:false（不抛错，让 Agent 判断）。
async function doWait(args, { frameId, tabIdHint } = {}) {
  const timeoutMs = args.timeoutMs ?? 10000;
  const intervalMs = args.intervalMs ?? 200;
  // 把 idleMs 拆出来：checkCondition 每次探测都会返回当前 idle 时长，命中由 SW 判
  const cond = {
    text: args.text, textGone: args.textGone,
    selector: args.selector, selectorGone: args.selectorGone,
    idleMs: args.idleMs,
  };
  const hasCond = Object.values(cond).some((v) => v != null);
  if (!hasCond) throw new Error('wait 需至少指定 text/textGone/selector/selectorGone/idleMs 之一');

  const deadline = Date.now() + timeoutMs;
  let lastReason = '';
  while (Date.now() < deadline) {
    let res;
    try {
      res = await dispatchToFrame('checkCondition', { cond }, { frameId, tabIdHint });
    } catch (e) {
      // dom-agent 未注入或 frame 不存在：轮询重试，直到超时
      lastReason = `探测失败: ${e.message || e}`;
    }
    if (res && res.met) {
      return { ok: true, met: true, waitedMs: timeoutMs - (deadline - Date.now()), reason: '条件满足' };
    }
    if (res && res.reason) lastReason = res.reason;
    await sleep(intervalMs);
  }
  return { ok: false, met: false, waitedMs: timeoutMs, reason: lastReason || '超时未满足' };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- screenshot：截目标 tab ----------
// Chrome 只提供 captureVisibleTab，它没有 tabId 参数，截的永远是"窗口里可见的那个"。
// 早前实现只调它且传 WINDOW_ID_CURRENT，既无视 tabIdHint 也无视 pendingTabId，
// create_tab({active:false}) 后其它工具操作后台 tab、截图却截前台，产出错图且不报错。
//
// 后台 tab 试过两条 CDP 方案，都不可用（Chrome 150 实测）：
//   fromSurface:false（从渲染器视图取帧，本该不依赖可见性）→ 直接被拒：
//     -32000 "Only screenshots from surface are allowed."
//   fromSurface:true（默认，从系统合成表面取帧）→ 后台 tab 不在出帧，要等到它被唤醒，
//     实测 18s 才返回，窗口最小化时干脆挂死。
// 结论：Chrome 不存在"不让 tab 可见就能截到它"的途径。所以后台 tab 采用临时激活：
// 切过去截完立刻切回原 tab，约 200ms，代价是一次可见的闪烁，但结果正确且可预期。
const SHOT_TIMEOUT_MS = 5000;        // captureVisibleTab 正常在 100ms 内；最小化窗口会挂住，靠它兜底
const SHOT_ACTIVATE_SETTLE_MS = 150; // 切过去后给合成器出首帧的时间
// captureVisibleTab 限频约 2 次/秒，超了报 MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND。
// 连续截图（或激活后重试）很容易撞上，重试间隔必须大于限频窗口，否则越retry越撞。
const SHOT_RETRY_INTERVAL_MS = 600;
const SHOT_MAX_ATTEMPTS = 4;         // 4 次 × 600ms 远小于网关 30s 上限

// 临时激活期间不让 onActivated 改写操作目标：切 tab 是本次截图的副作用，
// 不是用户切页，若被当成用户切页会把 pendingTabId 改到目标 tab 并且不再切回。
let suppressActivationTracking = false;

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// 这几类失败都是暂时的，隔一会儿重试就能成：
//   限频配额、刚切过去还没出首帧（readback failed / not ready）
function isTransientCaptureError(message) {
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|readback failed|not ready|Cannot capture/i.test(message);
}

async function captureVisible(windowId, format, quality) {
  const opts = { format };
  if (format === 'jpeg' && quality != null) opts.quality = quality;
  return withTimeout(
    chrome.tabs.captureVisibleTab(windowId, opts),
    SHOT_TIMEOUT_MS,
    `截图失败：captureVisibleTab 超时（${SHOT_TIMEOUT_MS}ms）。窗口可能处于最小化状态——`
    + 'Chrome 无法截取未在渲染的窗口，请先还原窗口再重试',
  );
}

async function doScreenshot(args = {}, { tabIdHint } = {}) {
  const format = args.format === 'jpeg' ? 'jpeg' : 'png';
  const quality = args.quality != null ? Math.max(0, Math.min(100, args.quality)) : null;
  const tabId = await resolveTabId(tabIdHint);
  if (!tabId) throw new Error('截图失败：无可操作的 tab');

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    throw new Error(`截图失败：tab ${tabId} 不存在（可能已被关闭）`);
  }

  const decode = (dataUrl, via, note) => {
    if (!dataUrl) throw new Error('截图失败：captureVisibleTab 返回空');
    const base64 = dataUrl.split(',', 2)[1] || dataUrl;
    const mime = (dataUrl.match(/^data:([^;]+)/) || [])[1] || `image/${format}`;
    return { ok: true, format, mime, dataUrl, base64, size: base64.length, tabId, via, note };
  };

  // 目标已经是它所在窗口的可见 tab：直接截。
  // 用 tab.windowId 而不是 WINDOW_ID_CURRENT——多窗口下"当前窗口"可能不是目标所在窗口。
  if (tab.active) {
    return decode(await captureVisibleWithRetry(tab.windowId, format, quality), 'captureVisibleTab');
  }

  // 目标在后台：临时切过去截，再切回原 tab。
  const previousActive = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
  suppressActivationTracking = true;
  try {
    await chrome.tabs.update(tabId, { active: true });
    // 切过去后先等首帧，再交给带限频退避的重试
    await sleep(SHOT_ACTIVATE_SETTLE_MS);
    const dataUrl = await captureVisibleWithRetry(tab.windowId, format, quality);
    return decode(dataUrl, 'activate+captureVisibleTab',
      '目标在后台，已临时切到该标签页截图并切回原标签页');
  } finally {
    // 必须切回：否则用户看到的页面被我们悄悄换掉了
    if (previousActive?.id != null && previousActive.id !== tabId) {
      try { await chrome.tabs.update(previousActive.id, { active: true }); } catch (_) { /* ignore */ }
    }
    suppressActivationTracking = false;
  }
}

// 限频与首帧未就绪都是暂时性失败，退避重试；其它错误立即抛出，不做无意义的重试
async function captureVisibleWithRetry(windowId, format, quality) {
  let lastError = null;
  for (let attempt = 0; attempt < SHOT_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(SHOT_RETRY_INTERVAL_MS);
    try {
      const dataUrl = await captureVisible(windowId, format, quality);
      if (dataUrl) return dataUrl;
      lastError = new Error('截图失败：captureVisibleTab 返回空');
    } catch (e) {
      lastError = e;
      if (!isTransientCaptureError(String(e?.message || e))) throw e;
    }
  }
  throw lastError || new Error('截图失败：重试后仍未取到帧');
}

// ---------- downloadViaBrowser：用浏览器网络下载（fallback 网关 fetch） ----------
// 场景：网关进程无代理/被墙时，浏览器能访问。用 chrome.downloads 走浏览器网络
// （带代理、登录态、绕墙），下载到 Chrome 下载目录，返回绝对路径供网关搬运到目标位置。
// chrome.downloads 不受"不安全下载"拦截（与原生 <a> 下载不同）。
async function downloadViaBrowser(url, filename) {
  if (!url) throw new Error('downloadViaBrowser 需要 url');
  // filename 是相对下载目录的路径，不能含绝对路径或 ..
  let safeName = filename || url.split('/').pop().split('?')[0] || 'download.bin';
  safeName = safeName.replace(/[/\\]/g, '_').replace(/^\.+/, '');

  const downloadId = await chrome.downloads.download({
    url,
    filename: safeName,
    conflictAction: 'overwrite', // 同名覆盖，避免累积
    saveAs: false, // 不弹"另存为"对话框
  });

  // 等下载完成（state: 'complete'）或失败（state: 'interrupted'）
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      reject(new Error(`浏览器下载超时（60s）：${url}`));
    }, 60000);
    const listener = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state && delta.state.current === 'complete') {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(listener);
        // 取下载项的最终本地路径
        chrome.downloads.search({ id: downloadId }).then((items) => {
          const item = items && items[0];
          if (!item || !item.filename) {
            reject(new Error('下载完成但无法获取文件路径'));
            return;
          }
          resolve({ ok: true, downloadId, path: item.filename, url, mime: item.mime });
        }).catch((e) => reject(new Error(`获取下载路径失败: ${e.message}`)));
      } else if (delta.state && delta.state.current === 'interrupted') {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(listener);
        const errDetail = delta.error || (delta.error && delta.error.current) || '未知错误';
        reject(new Error(`浏览器下载中断: ${typeof errDetail === 'object' ? JSON.stringify(errDetail) : errDetail}`));
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });

  return result;
}

// ---------- evalViaMainWorld：在页面主上下文执行任意 JS ----------
// 解決 dom-agent 的 doEval（new Function）受扩展 CSP 限制（所有页面都不可用）的问题。
// 用 chrome.scripting.executeScript 的 MAIN world 注入：受页面 CSP 约束（非扩展 CSP），
// 无 CSP 或允许 unsafe-eval 的页面可用。失败时 fallback 到 dom-agent 的 doEval。
async function evalViaMainWorld(code, arg, { frameId, tabIdHint } = {}) {
  const tabId = await resolveTabId(tabIdHint);
  if (!tabId) throw new Error('无可操作的 tab');
  const resolvedFrameId = resolveFrameId(frameId, tabId);
  const target = { tabId };
  if (resolvedFrameId != null) target.frameIds = [resolvedFrameId];
  else target.allFrames = true;

  // executeScript 的 func 是静态函数，会被序列化后在 MAIN world 执行。
  // func 内部用 new Function 执行用户 code——此处的 new Function 受页面 CSP 约束（非扩展 CSP）。
  // args 数组透传 [code, arg]，func 内解构。注意：args 不允许 undefined，用 null 兜底。
  const safeArg = arg === undefined ? null : arg;
  const results = await chrome.scripting.executeScript({
    target,
    world: 'MAIN',
    func: (code, arg) => {
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function('arg', code);
        const result = fn(arg);
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: String(e && (e.stack || e.message || e)) };
      }
    },
    args: [code, safeArg],
  });

  // executeScript 返回 [{ frameId, result }]，取第一个（或匹配 frameId 的）
  if (!results || results.length === 0) {
    throw new Error('eval: executeScript 返回空（页面可能无权限或 frame 不存在）');
  }
  const entry = resolvedFrameId != null
    ? results.find((r) => r.frameId === resolvedFrameId) || results[0]
    : results[0];
  const r = entry.result;
  if (!r || !r.ok) {
    // MAIN world 也失败（严格 CSP 页面），fallback 到 dom-agent
    try {
      return await dispatchToFrame('eval', { code, arg }, { frameId, tabIdHint });
    } catch (e2) {
      throw new Error(`eval 失败（MAIN world: ${r?.error || '无结果'}；dom-agent: ${e2.message}）`);
    }
  }
  return r;
}

// ---------- 上游：接收 offscreen 推来的网关指令（短消息） ----------
// Chrome 150 下 connect 长连接不可用，改用 sendMessage。
// offscreen 发 { type:'bt-invoke', id, action, args, frameId, tabIdHint }，
// SW 处理后用 sendResponse 回 { type:'result', id, ok, data|error }。
// 注意 onMessage 回调里要做异步处理，必须 return true 才能保持 sendResponse 可用。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type !== 'bt-invoke') return; // 忽略非本扩展 invoke 消息（如 sidepanel 的 bt-action）
  // 异步处理
  (async () => {
    let reply;
    try {
      const data = await handleAction(msg);
      reply = { type: 'result', id: msg.id, ok: true, data };
    } catch (e) {
      reply = { type: 'result', id: msg.id, ok: false, error: String(e?.message || e) };
    }
    // SW 回收可能导致 sendResponse 失败，但通常 30s 内的同步回包没问题
    try { sendResponse(reply); } catch (_) { /* SW 已断则忽略 */ }
  })();
  return true; // 表示异步调用 sendResponse
});

// ---------- 启动：确保 offscreen，它再连网关 ----------
chrome.runtime.onStartup.addListener(bootstrap);
chrome.runtime.onInstalled.addListener(bootstrap);

async function bootstrap() {
  // 1) 最关键：点图标即开侧栏。放最前，失败也别阻断后续
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    console.log('[helm] setPanelBehavior ok');
  } catch (e) {
    console.error('[helm] setPanelBehavior 失败:', e);
  }
  // 2) offscreen 失败不阻断侧栏功能
  try {
    await ensureOffscreen();
    const saved = await chrome.storage.session.get(['pendingTabId', 'frameScopes']);
    if (saved.pendingTabId) pendingTabId = saved.pendingTabId;
    frameScopes.clear();
    for (const [tabId, frameId] of Object.entries(saved.frameScopes || {})) {
      if (frameId != null) frameScopes.set(Number(tabId), Number(frameId));
    }
  } catch (e) {
    console.error('[helm] offscreen 失败:', e);
  }
}

// 让 offscreen 也能读/写当前目标 tab
// 切 tab 时：更新 pendingTabId，旧 tab 的高亮熄灭（不再被操作）。
// frame 作用域按 tab 存，切回来仍然有效，无需清空。
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // 截图为了取帧临时切了 tab，那不是用户切页，不能据此改写操作目标
  if (suppressActivationTracking) return;
  // 旧 tab 熄灭高亮
  if (highlightTabId && highlightTabId !== activeInfo.tabId) {
    try { await chrome.tabs.sendMessage(highlightTabId, { target: 'dom-agent', action: 'hideHighlight' }); } catch (_) {}
    highlightTabId = null;
    if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = null; }
  }
  pendingTabId = activeInfo.tabId;
  await chrome.storage.session.set({ pendingTabId });
});

// tab 关闭：回收它的 frame 作用域，避免 frameScopes 随开关标签无限增长，
// 也避免 Chrome 复用 tabId 时继承到上一个页面的 frame
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!frameScopes.delete(tabId)) return;
  try { await persistFrameScopes(); } catch (_) { /* ignore */ }
});

// 兜底：若 setPanelBehavior 未生效，点图标时手动开侧栏
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId }).catch((e) => {
    console.error('[helm] sidePanel.open 失败:', e);
  });
});

// 兜底：任何错误别让 SW 崩
self.addEventListener('unhandledrejection', (e) => {
  console.error('[helm] unhandledrejection:', e.reason);
});
