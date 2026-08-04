#!/usr/bin/env node
/**
 * mcp-server.mjs — MCP Server (stdio transport)
 *
 * 把扩展的浏览器操作能力以 MCP tools 形式暴露给 Agent。
 * Claude Desktop / Codex / Cursor 等通过 stdio 启动本进程即可接入。
 *
 * 协议：MCP (JSON-RPC 2.0 over stdio)
 *   - initialize          握手
 *   - tools/list          返回工具清单 + JSON Schema
 *   - tools/call          执行某工具，转发给扩展
 *
 * 同时随进程启动 bridge（WebSocket server），等待扩展连接。
 */

import { invoke, isExtensionConnected, waitForExtension, startOrAttach, getIsPrimary } from './bridge.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TOOLS, mapToolToAction, isLocalTool, isHighRisk } from './tools-def.mjs';

// 启动/挂联网关（端口被占则自动作为附属模式连已有网关）
await startOrAttach();

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'browser-tool', version: '0.1.0' };

// TOOLS / mapToolToAction / isLocalTool / isHighRisk 从 tools-def.mjs import（与 http-server 共享）

// ---------- 高危动作判定 + 审计日志 ----------
// 高危清单：download/eval/save_file(覆盖)。工具 description 里也标注了风险。
// 审计日志始终记录高危操作（不论 confirm 开关），追加到 audit-log.txt

const AUDIT_LOG_PATH = path.join(process.cwd(), 'audit-log.txt');
async function auditAppend(toolName, args, ok, durationMs, dataOrError) {
  try {
    const entry = {
      time: new Date().toISOString(),
      tool: toolName,
      ok,
      durationMs,
      args: summarizeForAudit(args),
      result: typeof dataOrError === 'string' ? dataOrError.slice(0, 200) : JSON.stringify(dataOrError).slice(0, 200),
    };
    const line = JSON.stringify(entry) + '\n';
    await fsp.mkdir(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    await fsp.writeFile(AUDIT_LOG_PATH, line, { encoding: 'utf8', flag: 'a' });
  } catch (_) { /* 审计失败不影响主流程 */ }
}

function summarizeForAudit(args = {}) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (v == null) { out[k] = v; continue; }
    if (typeof v === 'string') out[k] = v.length > 80 ? v.slice(0, 80) + '…' : v;
    else if (typeof v === 'object') {
      const s = JSON.stringify(v);
      out[k] = s.length > 120 ? s.slice(0, 120) + '…' : s;
    } else out[k] = v;
  }
  return out;
}

// ---------- 本地 fs 工具（不经扩展，网关进程直接完成）----------
// save_file / read_file / list_files / download
// 设计：网关本来就在用户本地跑，直接用 Node fs 写盘，零注册、零权限申请。
// 缺点：只能写网关进程有权限的路径（通常用户目录，足够覆盖清单/产物场景）。
// native messaging host（任意路径、跨用户权限）留到阶段 3 生产化。

// 工具名 -> 是否走本地 fs（不走扩展 invoke）

async function handleLocalTool(name, args) {
  switch (name) {
    case 'save_file':  return doSaveFile(args || {});
    case 'read_file':  return doReadFile(args || {});
    case 'list_files': return doListFiles(args || {});
    case 'download':   return doDownload(args || {});
    default: throw new Error(`未知本地工具: ${name}`);
  }
}

async function doSaveFile({ path: p, content, append = false, encoding = 'utf8' }) {
  if (!p) throw new Error('save_file 需要 path');
  if (content == null) throw new Error('save_file 需要 content');
  const abs = path.resolve(p);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const flag = append ? 'a' : 'w';
  await fsp.writeFile(abs, String(content), { encoding, flag });
  const stat = await fsp.stat(abs);
  return { ok: true, path: abs, bytes: stat.size, append: !!append };
}

async function doReadFile({ path: p, encoding = 'utf8' }) {
  if (!p) throw new Error('read_file 需要 path');
  const abs = path.resolve(p);
  const content = await fsp.readFile(abs, { encoding });
  const stat = await fsp.stat(abs);
  return { ok: true, path: abs, bytes: stat.size, content };
}

async function doListFiles({ dir, recursive = false }) {
  if (!dir) throw new Error('list_files 需要 dir');
  const abs = path.resolve(dir);
  const out = [];
  if (recursive) {
    const walk = async (d, depth) => {
      let entries;
      try { entries = await fsp.readdir(d, { withFileTypes: true }); }
      catch (e) { throw new Error(`无法读取目录 ${d}: ${e.message}`); }
      for (const e of entries) {
        const full = path.join(d, e.name);
        out.push({ name: e.name, path: full, type: e.isDirectory() ? 'dir' : 'file', depth });
        if (e.isDirectory() && depth < 10) await walk(full, depth + 1); // 防止无限递归
      }
    };
    await walk(abs, 0);
  } else {
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      out.push({ name: e.name, path: path.join(abs, e.name), type: e.isDirectory() ? 'dir' : 'file' });
    }
  }
  return { ok: true, dir: abs, count: out.length, entries: out };
}

async function doDownload({ url, ref, path: savePath, frameId } = {}) {
  let targetUrl = url;
  let pageUrl = null; // 用于解析相对 href
  // ref 模式：从扩展 snapshot 取元素的 href（不用 eval，因 MV3 扩展 CSP 禁止 unsafe-eval，
  // eval 在所有页面都不可用，而 snapshot 的 attrs.href 由 dom-agent 的 describe 收集，无 CSP 问题）
  if (!targetUrl && ref != null) {
    if (!isExtensionConnected()) {
      await waitForExtension(10000);
    }
    // snapshot 返回 url 字段（当前页 URL）+ elements 数组（每个含 attrs.href）
    const snap = await invoke('snapshot', { options: { interactiveOnly: true } },
      frameId != null ? { frameId } : {});
    if (!snap || !snap.elements) {
      throw new Error(`download: 无法获取快照（扩展未连接或 frame ${frameId} 不存在）`);
    }
    pageUrl = snap.url;
    const el = snap.elements.find((e) => String(e.ref) === String(ref));
    if (!el) {
      throw new Error(`download: ref ${ref} 不在快照中（可能已失效，请重新 get_snapshot）`);
    }
    targetUrl = el.attrs?.href;
    if (!targetUrl) {
      throw new Error(`download: ref ${ref} 对应元素（${el.tag}）无 href 属性，无法下载`);
    }
    // 解析相对 URL：用当前页 URL 作 base
    if (!/^https?:\/\//i.test(targetUrl)) {
      try {
        targetUrl = new URL(targetUrl, pageUrl).href;
      } catch (_) {
        throw new Error(`download: 无法解析相对 URL "${targetUrl}"（base=${pageUrl}）`);
      }
    }
  }
  if (!targetUrl) throw new Error('download 需要 url 或 ref 之一');

  // 解析保存路径
  const abs = savePath
    ? path.resolve(savePath)
    : path.resolve(path.join('downloads', targetUrl.split('/').pop().split('?')[0] || 'download.bin'));
  await fsp.mkdir(path.dirname(abs), { recursive: true });

  // 文件名（给 chrome.downloads 用，相对下载目录）
  const filename = targetUrl.split('/').pop().split('?')[0] || 'download.bin';

  // 第一级：网关 fetch（绕过 Chrome 下载安全策略，可写任意路径，但依赖网关网络）
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 120000); // 2 分钟超时
  try {
    const res = await fetch(targetUrl, { redirect: 'follow', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.writeFile(abs, buf);
    return { ok: true, url: targetUrl, path: abs, bytes: buf.length, mime: res.headers.get('content-type'), via: 'gateway' };
  } catch (e) {
    // 第二级 fallback：扩展 chrome.downloads（用浏览器网络：代理/登录态/绕墙）
    // 场景：网关无代理或被墙，但浏览器能访问。
    // chrome.downloads 不受"不安全下载"拦截，下载到 Chrome 下载目录，网关再搬到目标路径。
    if (!isExtensionConnected()) {
      clearTimeout(to);
      throw new Error(`download 网关失败且扩展未连接：${e.message}`);
    }
    let dlResult;
    try {
      dlResult = await invoke('downloadViaBrowser', { url: targetUrl, filename }, {});
    } catch (e2) {
      clearTimeout(to);
      throw new Error(`download 网关 fetch 失败（${e.message}），扩展下载也失败（${e2.message}）`);
    }
    // 扩展下载完成，dlResult.path 是 Chrome 下载目录里的绝对路径，搬到目标路径
    const srcPath = dlResult.path;
    if (!srcPath || !fs.existsSync(srcPath)) {
      clearTimeout(to);
      throw new Error(`扩展下载完成但找不到文件：${srcPath}`);
    }
    const buf = await fsp.readFile(srcPath);
    await fsp.writeFile(abs, buf);
    // 删除 Chrome 下载目录的原文件（避免累积）
    try { await fsp.unlink(srcPath); } catch (_) {}
    return { ok: true, url: targetUrl, path: abs, bytes: buf.length, mime: dlResult.mime, via: 'browser' };
  } finally {
    clearTimeout(to);
  }
}

// ---------- MCP 工具 -> 扩展 action 映射 ----------
// mapToolToAction 已从 tools-def.mjs import

// ---------- stdio JSON-RPC ----------
process.stdin.setEncoding('utf8');
let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) handleMessage(line);
  }
});

process.stdin.on('end', () => process.exit(0));

async function handleMessage(line) {
  let req;
  try { req = JSON.parse(line); }
  catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }

  const { id, method, params } = req;
  try {
    switch (method) {
      case 'initialize':
        return send({ jsonrpc: '2.0', id, result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        } });

      case 'notifications/initialized':
        return;

      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });

      case 'tools/call': {
        const { name, arguments: args } = params || {};
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return sendRpcError(id, -32602, `未知工具: ${name}`);

        // 审计日志
        const risk = isHighRisk(name, args);
        const t0 = Date.now();
        const finish = (ok, dataOrError) => {
          if (risk) auditAppend(name, args, ok, Date.now() - t0, dataOrError);
        };

        try {
          let data;
          if (isLocalTool(name)) {
            if (name === 'download' && args?.ref != null && !args?.url) {
              if (!isExtensionConnected()) await waitForExtension(10000);
            }
            data = await handleLocalTool(name, args);
          } else {
            if (!isExtensionConnected()) await waitForExtension(10000);
            const [action, actionArgs, opts] = mapToolToAction(name, args);
            data = await invoke(action, actionArgs, opts);
          }
          finish(true, data);
          return send({ jsonrpc: '2.0', id, result: {
            content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
          } });
        } catch (e) {
          finish(false, String(e?.message || e).slice(0, 200));
          return send({ jsonrpc: '2.0', id, result: {
            content: [{ type: 'text', text: `执行失败: ${e?.message || e}` }],
            isError: true,
          } });
        }
      }

      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });

      default:
        return sendRpcError(id, -32601, `方法不存在: ${method}`);
    }
  } catch (e) {
    return send({ jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: `执行失败: ${e?.message || e}` }],
      isError: true,
    } });
  }
}

function sendRpcError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

console.error('[mcp] browser-tool MCP server 已启动 (stdio)，等待 Agent 连接…');
console.error('[mcp] 网关模式由 startOrAttach 自动决定（主/附属）');
