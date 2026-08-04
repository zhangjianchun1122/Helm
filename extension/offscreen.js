/**
 * offscreen.js — Offscreen Document
 *
 * 职责：持有与本地网关的 WebSocket 长连接，跨 service worker 回收保持会话。
 *   网关 ↔ offscreen : WebSocket
 *   offscreen ↔ sw   : chrome.runtime.sendMessage（短消息）
 *
 * 消息格式（网关 ↔ offscreen）：
 *   请求  { id, type:'invoke', action, args, frameId, tabIdHint }
 *   响应  { id, type:'result', ok, data|error }
 *   网关还会发 { type:'ping' } 保活
 *
 * 消息格式（offscreen ↔ sw）：
 *   请求  { type:'bt-invoke', id, action, args, frameId, tabIdHint }
 *   响应  { type:'result', id, ok, data|error }
 *
 * 注意：Chrome 150 起 SW 内 chrome.runtime.connect 长连接不可用，故改用
 * sendMessage 短消息。sendMessage 的 sendResponse 在 SW 异步处理时需 SW
 * 端 return true（sw.js 已处理）。offscreen 侧用 Promise 包装一次性监听。
 */

const GATEWAY_WS = 'ws://127.0.0.1:8787';

let ws = null;
const pending = new Map(); // id -> { resolve, reject, timer }

// ---------- 与 service worker 的短消息通信 ----------
// invokeOnSW：把网关转来的 invoke 用 sendMessage 发给 SW，等 SW 回 result。
function invokeOnSW(req) {
  return new Promise((resolve, reject) => {
    const id = req.id;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('扩展侧执行超时（30s）'));
    }, 30000);
    pending.set(id, { resolve, reject, timer });

    const msg = { type: 'bt-invoke', id, action: req.action, args: req.args || {}, frameId: req.frameId, tabIdHint: req.tabIdHint };

    // sendMessage 的回调是 SW 端 sendResponse 的同步调用；但 SW 用了 async，
    // 返回 true 后 sendResponse 会在异步完成时触发，回调仍能收到。
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        const entry = pending.get(id);
        if (!entry) return; // 已超时清掉
        // 检查 runtime 错误（如 SW 不可达）
        if (chrome.runtime.lastError || !resp) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error('SW 不可达: ' + (chrome.runtime.lastError?.message || '无响应')));
          return;
        }
        pending.delete(id);
        clearTimeout(timer);
        if (resp.ok) resolve(resp.data);
        else reject(new Error(resp.error || '扩展执行失败'));
      });
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error('sendMessage 失败: ' + e.message));
    }
  });
}

// ---------- WebSocket 与网关 ----------
function connectGateway() {
  ws = new WebSocket(GATEWAY_WS);

  ws.onopen = () => {
    console.log('[bt-offscreen] 网关 WS 已连接');
    ws.send(JSON.stringify({ type: 'hello', role: 'extension' }));
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    // 收到 reclaim：bridge 通知我们重新认领（可能 extSocket 被别的连接顶掉了）
    if (msg.type === 'reclaim') {
      console.log('[bt-offscreen] 收到 reclaim，重发 hello 认领');
      ws.send(JSON.stringify({ type: 'hello', role: 'extension' }));
      return;
    }
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
      return;
    }
    if (msg.type !== 'invoke') return;

    // 转发给 service worker
    try {
      const data = await invokeOnSW(msg);
      ws.send(JSON.stringify({ id: msg.id, type: 'result', ok: true, data }));
    } catch (e) {
      ws.send(JSON.stringify({ id: msg.id, type: 'result', ok: false, error: String(e?.message || e) }));
    }
  };

  // 周期性重发 hello，确保 extSocket 指向我们（防被探针/旧连接顶掉后不恢复）
  const helloTimer = setInterval(() => {
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'hello', role: 'extension' }));
    }
  }, 10000);
  ws.onclose = () => { clearInterval(helloTimer); };

  ws.onclose = () => {
    console.warn('[bt-offscreen] 网关 WS 断开，3s 后重连');
    setTimeout(connectGateway, 3000);
  };

  ws.onerror = (e) => {
    console.error('[bt-offscreen] WS 错误:', e);
  };
}

// ---------- 启动 ----------
connectGateway();
