/**
 * bridge.mjs — 本地网关桥
 *
 * 两种运行模式（自动选择）：
 *  1. 主模式：端口 8787 空闲 → 起 WS server，扩展连这里，本进程即网关
 *  2. 附属模式：8787 已被占 → 作为 WS client 连已有网关，转发 invoke
 *
 * 对外仍只暴露 invoke / isExtensionConnected，调用方（mcp-server）无需感知模式。
 * 这样多个 Agent 各自 spawn 的 mcp-server 进程能共存：
 *   第一个进程起网关，后续进程都连它，不再 EADDRINUSE 崩溃。
 */

import http from 'node:http';
import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.BT_PORT || 8787);
// BT_HOST: 网关监听/连接的主机地址。默认 127.0.0.1（本机回环）。
// 沙箱场景（如 Claude Desktop + ccswitch）：设为宿主机 LAN IP（如 192.168.x.x），
// bridge-daemon 会监听 0.0.0.0 接受外部连接，mcp-server 用此地址连 bridge。
const HOST = process.env.BT_HOST || '127.0.0.1';
// 监听地址：BT_HOST 非 127.0.0.1 时监听 0.0.0.0（接受外部连接），否则监听 127.0.0.1
const LISTEN_HOST = HOST === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0';

// 扩展连接（主模式持有；附属模式为 null）
let extSocket = null;
// 扩展最近一次活动时间（收到 hello/result/pong 即刷新）
// 用于识别"WS 层面 OPEN 但对端已不响应"的陈旧/僵尸连接
let extLastSeen = 0;
const STALE_MS = 30000; // 超过此时间无活动视为陈旧
const QUICK_TIMEOUT_MS = 3000; // invoke 发出后多久无任何回包迹象即判陈旧
// 附属模式下：连到主网关的 WS client
let upstream = null;
let isPrimary = false; // startPrimary 置 true，startReplica 保持 false
export function getIsPrimary() { return isPrimary; }
const pending = new Map();     // id -> {resolve, reject, timer, quick}
const quickTimers = new Map();  // id -> quick 兜底 timer（与 pending 对齐生命周期）
let nextId = 1;
function genId() { return nextId++; }

function extAlive() {
  return extSocket && extSocket.readyState === extSocket.OPEN && Date.now() - extLastSeen < STALE_MS;
}

// 主动清理陈旧的扩展 socket，触发 offscreen 重连
function dropStaleExt(reason) {
  if (!extSocket) return;
  console.error(`[bridge] 丢弃陈旧扩展连接: ${reason}`);
  try { extSocket.close(); } catch (_) { /* ignore */ }
  extSocket = null;
  extLastSeen = 0;
  // 通知所有在途请求：扩展断了，请重试
  for (const [id, entry] of pending) {
    pending.delete(id); clearQuick(id); clearTimeout(entry.timer);
    entry.reject(new Error('扩展连接陈旧已重置，请重试'));
  }
}

// ---------- invoke：对外统一接口 ----------
export function invoke(action, args = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    const id = genId();
    const timer = setTimeout(() => {
      clearQuick(id);
      pending.delete(id);
      reject(new Error(`扩展执行超时（30s）：${action}，可能是页面加载慢或 SW 被回收，建议 wait 后重试`));
    }, 30000);
    pending.set(id, { resolve, reject, timer });

    const payload = JSON.stringify({
      type: 'invoke', id, action, args,
      frameId: opts.frameId, tabIdHint: opts.tabIdHint,
    });

    // 主模式：直接发给扩展。先判陈旧——WS 层面 OPEN 但长期无活动说明对端已不响应
    if (extSocket && extSocket.readyState === extSocket.OPEN) {
      if (!extAlive()) {
        // 陈旧：丢弃以触发 offscreen 重连，本请求按"未连接"失败，调用方重试即可
        dropStaleExt('invoke 前检测到长期无活动');
        // 落入下方未连接分支
      } else {
        extSocket.send(payload);
        // 快速兜底：发出后短时间内若仍无任何活动迹象，判陈旧并自愈
        // （正常情况下扩展回 result 会经 handleResult 清掉 pending，这里只是兜底）
        const quick = setTimeout(() => {
          const entry = pending.get(id);
          if (entry && Date.now() - extLastSeen > QUICK_TIMEOUT_MS) {
            dropStaleExt('invoke 后短期无回包迹象');
            // dropStaleExt 已 reject 所有 pending，包括本条
          }
        }, QUICK_TIMEOUT_MS);
        quickTimers.set(id, quick);
        return;
      }
    }
    // 附属模式：转发给主网关
    if (upstream && upstream.readyState === upstream.OPEN) {
      upstream.send(payload);
      return;
    }
    // 都没有
    pending.delete(id);
    clearTimeout(timer);
    reject(new Error('扩展未连接：请安装并加载 Helm 扩展，并打开 Side Panel'));
  });
}

function clearQuick(id) {
  const q = quickTimers.get(id);
  if (q) { clearTimeout(q); quickTimers.delete(id); }
}

export function isExtensionConnected() {
  if (extAlive()) return true;
  // 附属模式不乐观返回：upstream OPEN 只说明连上了主网关，不代表扩展真的连着。
  // 返回 false 让调用方走 waitForExtension（轮询 /health.ext），避免跳过检查直接 invoke 超时。
  return false;
}

// ---------- 等待扩展连接（带超时） ----------
// 打破冷启动死锁：mcp-server 在扩展未连接时不立即失败，而是短暂挂起等扩展连上来。
// 区分主/附属模式（遵循已确认设计）：
//   主模式：轮询本地 extAlive()（含陈旧检测），100ms 间隔
//   附属模式：轮询主网关 /health 的 ext 字段（绕开本地乐观误判），500ms 间隔
// 连上立即 resolve(true)；超时 reject。
export function waitForExtension(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    // 主模式：本地轮询
    if (isPrimary) {
      if (extAlive()) return resolve(true);
      const iv = setInterval(() => {
        if (extAlive()) { clearInterval(iv); clearTimeout(to); resolve(true); }
        else if (Date.now() >= deadline) { clearInterval(iv); reject(new Error('扩展未连接：请安装并加载 Helm 扩展，并打开 Side Panel')); }
      }, 100);
      const to = setTimeout(() => { clearInterval(iv); reject(new Error('扩展未连接：请安装并加载 Helm 扩展，并打开 Side Panel')); }, timeoutMs);
      return;
    }

    // 附属模式：轮询主网关 /health
    const checkHealth = () => {
      const req = http.get(`http://${HOST}:${PORT}/health`, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          let ok = false;
          try { ok = JSON.parse(body).ext === true; } catch (_) {}
          if (ok) { clearTimeout(to); resolve(true); return; }
          if (Date.now() >= deadline) { clearTimeout(to); reject(new Error('扩展未连接：请安装并加载 Helm 扩展，并打开 Side Panel')); return; }
          setTimeout(checkHealth, 500);
        });
      });
      req.on('error', () => {
        if (Date.now() >= deadline) { clearTimeout(to); reject(new Error('扩展未连接：请安装并加载 Helm 扩展，并打开 Side Panel')); return; }
        setTimeout(checkHealth, 500);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    checkHealth();
    const to = setTimeout(() => reject(new Error('扩展未连接：请安装并加载 Helm 扩展，并打开 Side Panel')), timeoutMs);
  });
}

// ---------- 结果分发（主/附属共用）----------
function handleResult(msg) {
  if (msg.type !== 'result') return;
  // 收到扩展回包，刷新活动时间
  extLastSeen = Date.now();
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  clearQuick(msg.id);
  clearTimeout(entry.timer);
  if (msg.ok) entry.resolve(msg.data);
  else entry.reject(Object.assign(new Error(msg.error || '扩展执行失败'), { fromExt: true }));
}

// ---------- 主模式：WS server + HTTP health ----------
function startPrimary() {
  isPrimary = true;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      const alive = extAlive();
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ ok: true, ext: alive, extSeenMs: extLastSeen ? Date.now() - extLastSeen : -1, port: PORT, t: Date.now() }));
      return;
    }
    res.writeHead(404); res.end('not found');
  });

  const wss = new WebSocketServer({ server });

  // 附属连接的请求中转映射：invokeId -> { clientWs, } 用于把扩展的 result 回传给附属进程
  const replicaPending = new Map();

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      // 任何来自扩展的消息都视作"活着"，刷新活动时间
      extLastSeen = Date.now();
      if (msg.type === 'hello') {
        // 防抢占：若已有 extSocket 且不是当前 ws，先不清——但允许新扩展认领。
        // 关键：记录每个连接的 role，避免探针/附属进程冒充扩展抢占。
        const isExtension = msg.role === 'extension';
        if (isExtension) {
          if (extSocket && extSocket !== ws && extSocket.readyState === extSocket.OPEN) {
            // 旧扩展还连着，先顶掉旧的（让新的真正扩展认领）
            try { extSocket.close(); } catch (_) {}
          }
          extSocket = ws;
          console.error(`[bridge] 扩展已连接 (role=${msg.role || '?'})`);
        } else {
          // 非扩展 role 的 hello 忽略，绝不抢占 extSocket
          console.error(`[bridge] 忽略非扩展 hello (role=${msg.role || '?'})`);
        }
        return;
      }
      if (msg.type === 'pong') return;
      // 附属 mcp-server 转发来的 invoke：转发给扩展，并记录来源以便回包
      if (msg.type === 'invoke') {
        if (!extSocket || extSocket.readyState !== extSocket.OPEN) {
          // 扩展未连接，直接回错
          try { ws.send(JSON.stringify({ id: msg.id, type: 'result', ok: false, error: '扩展未连接' })); } catch (_) {}
          return;
        }
        replicaPending.set(msg.id, { clientWs: ws });
        try { extSocket.send(raw.toString()); } catch (e) {
          replicaPending.delete(msg.id);
          try { ws.send(JSON.stringify({ id: msg.id, type: 'result', ok: false, error: '转发失败: ' + e.message })); } catch (_) {}
        }
        return;
      }
      // result：可能是扩展回的。先看是不是附属请求的回包
      if (msg.type === 'result') {
        const replica = replicaPending.get(msg.id);
        if (replica && replica.clientWs !== ws) {
          // 这是扩展回给附属进程的 result，转发回去
          replicaPending.delete(msg.id);
          try { replica.clientWs.send(raw.toString()); } catch (_) {}
          return;
        }
        // 否则是本进程 pending 的 result（主模式自己发的 invoke）
        handleResult(msg);
        return;
      }
    });
    ws.on('close', () => {
      if (extSocket === ws) {
        extSocket = null;
        extLastSeen = 0;
        console.error('[bridge] 扩展断开');
        for (const [id, entry] of pending) {
          pending.delete(id); clearQuick(id); clearTimeout(entry.timer);
          entry.reject(new Error('扩展连接已断开'));
        }
        // 通知其它仍连着的 ws 重新认领（重发 hello），让真正的 offscreen 夺回 extSocket
        for (const client of wss.clients) {
          if (client !== ws && client.readyState === client.OPEN) {
            try { client.send(JSON.stringify({ type: 'reclaim' })); } catch (_) {}
          }
        }
      }
    });
    const pingTimer = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 15000);
    ws.on('close', () => clearInterval(pingTimer));
  });

  server.listen(PORT, LISTEN_HOST, () => {
    console.error(`[bridge] 主模式 监听 ws://${LISTEN_HOST}:${PORT} (等待扩展连接)`);
  });

  setInterval(() => {
    console.error(`[bridge] 状态: 扩展=${extSocket ? '已连接' : '未连接'} 在途=${pending.size}`);
  }, 10000);
}

// ---------- 附属模式：作为 client 连主网关 ----------
let replicaReady = null; // Promise<true> —— 附属模式 WS 连上后 resolve
function startReplica() {
  const url = `ws://${HOST}:${PORT}`;
  replicaReady = new Promise((resolveReady) => {
    const connect = () => {
      upstream = new WebSocket(url);
      upstream.on('open', () => {
        console.error(`[bridge] 附属模式 已连主网关 ${url}`);
        resolveReady(true); // WS 连上，invoke 可用
        // 不发 hello（那是扩展的身份），主网关会直接转发我们的 invoke 给扩展
      });
    upstream.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'ping') { upstream.send(JSON.stringify({ type: 'pong', t: Date.now() })); return; }
      handleResult(msg);
    });
    upstream.on('close', () => {
      upstream = null;
      console.error('[bridge] 与主网关断开，3s 后重连');
      setTimeout(connect, 3000);
    });
    upstream.on('error', () => { /* close 会跟进 */ });
    };
    connect();
  });
}

// ---------- 启动决策 ----------
function checkPortInUse() {
  return new Promise((resolve) => {
    const tester = net.createConnection({ port: PORT, host: HOST });
    tester.once('connect', () => { tester.destroy(); resolve(true); });
    tester.once('error', () => { tester.destroy(); resolve(false); });
  });
}

export async function startOrAttach() {
  const inUse = await checkPortInUse();
  if (inUse) {
    console.error('[bridge] 检测到 8787 已被占用 → 附属模式');
    startReplica();
    // 等待 upstream WS 真正连上，避免 startOrAttach 返回后 invoke 因 WS 未 OPEN 而失败
    // 5s 超时兜底：主网关可能恰好关闭，超时后 invoke 会走到"扩展未连接"分支
    if (replicaReady) await Promise.race([
      replicaReady,
      new Promise((r) => setTimeout(() => r('timeout'), 5000)),
    ]);
  } else {
    startPrimary();
  }
}
