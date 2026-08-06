#!/usr/bin/env node
/**
 * http-server.mjs — OpenAI 兼容 HTTP 端点
 *
 * 让无 MCP 接入能力的智能体或自研 Agent 通过 HTTP 调用 Helm 工具。
 * 注意：ZCode / Claude Code / Qwen CLI / Hermes Agent 均已原生支持 MCP stdio，
 * 直接配 MCP 即可，本端点主要面向自研 Agent 或需 HTTP 集成的场景。
 * 智能体自己规划操作序列，直接调 POST /v1/tools/call，无需 MCP stdio。
 *
 * 端点：
 *   GET  /v1/tools         返回工具清单（JSON Schema）
 *   POST /v1/tools/call    执行工具 {name, arguments} → {ok, result|error}
 *   GET  /health           健康检查
 *
 * 鉴权：Bearer token，通过环境变量 HELM_API_KEY 或启动参数设置。
 *       未设置时默认生成随机 token 并打印到 stderr。
 *
 * 用法：node http-server.mjs [--port 8788] [--key xxx]
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { invoke, isExtensionConnected, waitForExtension, startOrAttach } from './bridge.mjs';
import { TOOLS, mapToolToAction, isLocalTool, isHighRisk } from './tools-def.mjs';

await startOrAttach();

// ---------- 配置 ----------
const PORT = Number(process.env.HELM_HTTP_PORT || process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || 8788);
// BT_HOST 支持：沙箱场景下监听 0.0.0.0，本机场景监听 127.0.0.1
const HOST = process.env.BT_HOST || '127.0.0.1';
const LISTEN_HOST = HOST === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0';
let API_KEY = process.env.HELM_API_KEY || process.argv.find(a => a.startsWith('--key='))?.split('=')[1];
if (!API_KEY) {
  API_KEY = crypto.randomBytes(12).toString('hex');
  console.error(`[http] 未设置 HELM_API_KEY，已生成随机 token: ${API_KEY}`);
}

// ---------- 审计日志 ----------
const AUDIT_LOG_PATH = path.join(process.cwd(), 'audit-log.txt');
async function auditAppend(toolName, args, ok, durationMs, dataOrError) {
  try {
    const entry = {
      time: new Date().toISOString(),
      tool: toolName, ok, durationMs,
      args: summarizeForAudit(args),
      result: typeof dataOrError === 'string' ? dataOrError.slice(0, 200) : JSON.stringify(dataOrError).slice(0, 200),
      via: 'http',
    };
    await fsp.writeFile(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n', { encoding: 'utf8', flag: 'a' });
  } catch (_) {}
}
function summarizeForAudit(args = {}) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (v == null) { out[k] = v; continue; }
    if (typeof v === 'string') out[k] = v.length > 80 ? v.slice(0, 80) + '…' : v;
    else if (typeof v === 'object') { const s = JSON.stringify(v); out[k] = s.length > 120 ? s.slice(0, 120) + '…' : s; }
    else out[k] = v;
  }
  return out;
}

// ---------- 本地 fs 工具（与 mcp-server 同逻辑）----------
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
  await fsp.writeFile(abs, String(content), { encoding, flag: append ? 'a' : 'w' });
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
      const entries = await fsp.readdir(d, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(d, e.name);
        out.push({ name: e.name, path: full, type: e.isDirectory() ? 'dir' : 'file', depth });
        if (e.isDirectory() && depth < 10) await walk(full, depth + 1);
      }
    };
    await walk(abs, 0);
  } else {
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    for (const e of entries) out.push({ name: e.name, path: path.join(abs, e.name), type: e.isDirectory() ? 'dir' : 'file' });
  }
  return { ok: true, dir: abs, count: out.length, entries: out };
}
async function doDownload({ url, ref, path: savePath, frameId } = {}) {
  let targetUrl = url;
  let pageUrl = null;
  if (!targetUrl && ref != null) {
    if (!isExtensionConnected()) await waitForExtension(10000);
    const snap = await invoke('snapshot', { options: { interactiveOnly: true } }, frameId != null ? { frameId } : {});
    if (!snap || !snap.elements) throw new Error(`download: 无法获取快照`);
    pageUrl = snap.url;
    const el = snap.elements.find((e) => String(e.ref) === String(ref));
    if (!el) throw new Error(`download: ref ${ref} 不在快照中`);
    targetUrl = el.attrs?.href;
    if (!targetUrl) throw new Error(`download: ref ${ref} 对应元素无 href 属性`);
    if (!/^https?:\/\//i.test(targetUrl)) {
      try { targetUrl = new URL(targetUrl, pageUrl).href; } catch { throw new Error(`download: 无法解析相对 URL "${targetUrl}"`); }
    }
  }
  if (!targetUrl) throw new Error('download 需要 url 或 ref 之一');
  const abs = savePath ? path.resolve(savePath) : path.resolve(path.join('downloads', targetUrl.split('/').pop().split('?')[0] || 'download.bin'));
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const filename = targetUrl.split('/').pop().split('?')[0] || 'download.bin';
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(targetUrl, { redirect: 'follow', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.writeFile(abs, buf);
    return { ok: true, url: targetUrl, path: abs, bytes: buf.length, mime: res.headers.get('content-type'), via: 'gateway' };
  } catch (e) {
    if (!isExtensionConnected()) { clearTimeout(to); throw new Error(`download 网关失败且扩展未连接：${e.message}`); }
    let dlResult;
    try { dlResult = await invoke('downloadViaBrowser', { url: targetUrl, filename }, {}); }
    catch (e2) { clearTimeout(to); throw new Error(`download 网关失败（${e.message}），扩展下载也失败（${e2.message}）`); }
    const srcPath = dlResult.path;
    if (!srcPath || !fs.existsSync(srcPath)) { clearTimeout(to); throw new Error(`扩展下载完成但找不到文件：${srcPath}`); }
    const buf = await fsp.readFile(srcPath);
    await fsp.writeFile(abs, buf);
    try { await fsp.unlink(srcPath); } catch {}
    return { ok: true, url: targetUrl, path: abs, bytes: buf.length, mime: dlResult.mime, via: 'browser' };
  } finally { clearTimeout(to); }
}

// ---------- 执行工具（统一入口）----------
async function executeTool(name, args) {
  const t0 = Date.now();
  const risk = isHighRisk(name, args);
  const finish = (ok, data) => { if (risk) auditAppend(name, args, ok, Date.now() - t0, data); };
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
    return { ok: true, result: data };
  } catch (e) {
    finish(false, String(e?.message || e).slice(0, 200));
    return { ok: false, error: String(e?.message || e) };
  }
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 鉴权（/health 不需要）
  if (req.url !== '/health') {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (token !== API_KEY) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: 需要 Bearer token' }));
      return;
    }
  }

  // 路由
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ext: isExtensionConnected(), port: PORT }));
    return;
  }

  if (req.method === 'GET' && req.url === '/v1/tools') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tools: TOOLS }));
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/tools/call') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    const { name, arguments: args } = parsed;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `未知工具: ${name}` }));
      return;
    }
    const result = await executeTool(name, args || {});
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, LISTEN_HOST, () => {
  console.error(`[http] Helm HTTP 端点已启动: http://${LISTEN_HOST}:${PORT}`);
  console.error(`[http]   GET  /v1/tools         工具清单`);
  console.error(`[http]   POST /v1/tools/call    执行工具`);
  console.error(`[http]   鉴权: Authorization: Bearer ${API_KEY}`);
});

// 保持进程不退出
setInterval(() => {}, 1 << 30);
