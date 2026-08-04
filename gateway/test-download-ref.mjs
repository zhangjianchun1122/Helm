/**
 * test-download-ref.mjs — download ref 模式真实链路测试
 *
 * 之前 download ref 模式在 example.com 被 CSP 挡住（eval 取 href 失败）。
 * 本测试起一个本地无 CSP 的 HTTP 服务，提供：
 *   - /index.html  含 <a href="/file.txt"> 的页面
 *   - /file.txt    可下载的小文件
 * 然后用扩展 eval 取 <a> 的 href，验证 ref 模式能完成 download。
 *
 * 链路：get_snapshot 拿 <a> ref → MCP download(ref) → 扩展 eval 取 href
 *      → 网关 fetch 该 href → fs 写盘 → 对比内容
 *
 * 因为 download 在 mcp-server 特判处理（不经 bridge.invoke），
 * 本脚本 spawn mcp-server 子进程走 MCP 协议。
 */

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';

const GATEWAY = join(dirname(fileURLToPath(import.meta.url)), 'mcp-server.mjs');
const TEST_FILE_CONTENT = 'Helm download ref test\nline2\n这是测试文件内容';

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail ? '— ' + detail : ''}`); }
}

// ---------- 起本地无 CSP HTTP 服务 ----------
const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); // 不设 CSP 头
    res.end(`<!DOCTYPE html><html><body>
      <h1>Download Ref Test Page</h1>
      <a href="/file.txt" id="dl">下载测试文件 file.txt</a>
      <a href="/file2.txt" id="dl2">另一个链接</a>
    </body></html>`);
    return;
  }
  if (req.url === '/file.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(TEST_FILE_CONTENT);
    return;
  }
  res.writeHead(404); res.end('not found');
});
const HTTP_PORT = 9876;
await new Promise((r) => httpServer.listen(HTTP_PORT, '127.0.0.1', r));
console.log(`本地 HTTP 服务起在 http://127.0.0.1:${HTTP_PORT}`);

// ---------- spawn mcp-server 子进程 ----------
const proc = spawn('node', [GATEWAY], { stdio: ['pipe', 'pipe', 'inherit'] });
proc.on('error', (e) => { console.error('启动 mcp-server 失败:', e); process.exit(1); });

let mcpBuf = '';
function sendMCP(obj) {
  return new Promise((resolve) => {
    const onData = (chunk) => {
      mcpBuf += chunk.toString();
      let idx;
      while ((idx = mcpBuf.indexOf('\n')) >= 0) {
        const line = mcpBuf.slice(0, idx).trim();
        mcpBuf = mcpBuf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === obj.id) {
            proc.stdout.off('data', onData);
            resolve(msg);
            return;
          }
        } catch {}
      }
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(JSON.stringify(obj) + '\n');
  });
}

await new Promise((r) => setTimeout(r, 1200));

// 等扩展连接（可能已连）
await sendMCP({ jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dltest', version: '1' } } });

console.log('\n========== download ref 模式测试 ==========');

// 1. 导航到本地测试页（无 CSP）
console.log('\n--- 1. 导航到本地无 CSP 测试页 ---');
const nav = await sendMCP({ jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name: 'navigate', arguments: { url: `http://127.0.0.1:${HTTP_PORT}/index.html` } } });
ok('导航成功', nav?.result?.isError !== true, JSON.stringify(nav?.result).slice(0, 100));
await new Promise((r) => setTimeout(r, 1500));

// 2. get_snapshot 拿 <a> 元素的 ref
console.log('\n--- 2. get_snapshot 找 <a> ref ---');
const snap = await sendMCP({ jsonrpc: '2.0', id: 2, method: 'tools/call',
  params: { name: 'get_snapshot', arguments: { interactiveOnly: true } } });
const snapText = snap?.result?.content?.[0]?.text || '';
ok('snapshot 返回元素', /elements/.test(snapText), snapText.slice(0, 100));
// 从返回 JSON 里找第一个 <a> 的 ref
let aRef = null;
try {
  const data = JSON.parse(snapText);
  const a = (data.elements || []).find((e) => e.tag === 'a');
  if (a) aRef = a.ref;
} catch {}
ok('找到 <a> ref', aRef != null, `ref=${aRef}`);

if (!aRef) {
  console.log('\n（无法继续，未找到 <a> ref）');
  httpServer.close(); proc.kill(); process.exit(1);
}

// 3. download ref 模式：传 ref，扩展应 eval 取 href 后下载
console.log('\n--- 3. download ref 模式（扩展取 href → 网关 fetch 写盘） ---');
const dlPath = join(os.tmpdir(), `helm-dl-ref-${Date.now()}.txt`);
const dl = await sendMCP({ jsonrpc: '2.0', id: 3, method: 'tools/call',
  params: { name: 'download', arguments: { ref: aRef, path: dlPath } } });
const dlText = dl?.result?.content?.[0]?.text || '';
ok('download ref 未报错', dl?.result?.isError !== true, dlText.slice(0, 200));
ok('download 返回 ok:true', /"ok"\s*:\s*true/.test(dlText), dlText.slice(0, 200));
ok('download 文件已落盘', fs.existsSync(dlPath), `应存在于 ${dlPath}`);

if (fs.existsSync(dlPath)) {
  const got = fs.readFileSync(dlPath, 'utf8');
  ok('下载内容与原文件一致', got === TEST_FILE_CONTENT, `期望 ${TEST_FILE_CONTENT.length} 字节，实际 ${got.length} 字节`);
  ok('url 是绝对 URL（http://...）', /http:\/\/127\.0\.0\.1/.test(dlText), dlText.slice(0, 200));
  try { fs.unlinkSync(dlPath); } catch {}
}

// 4. download 失效 ref 应报错
console.log('\n--- 4. download 失效 ref 报错 ---');
const dlBad = await sendMCP({ jsonrpc: '2.0', id: 4, method: 'tools/call',
  params: { name: 'download', arguments: { ref: '999999' } } });
ok('download 失效 ref 返回 isError', dlBad?.result?.isError === true, JSON.stringify(dlBad?.result).slice(0, 200));

// 5. download 无 url 无 ref 应报错
console.log('\n--- 5. download 无参数报错 ---');
const dlNone = await sendMCP({ jsonrpc: '2.0', id: 5, method: 'tools/call',
  params: { name: 'download', arguments: {} } });
ok('download 无参返回 isError', dlNone?.result?.isError === true, JSON.stringify(dlNone?.result).slice(0, 200));

// 收尾
httpServer.close();
proc.kill();
await new Promise((r) => setTimeout(r, 300));

console.log(`\n${'='.repeat(50)}`);
console.log(`验证结果: 通过 ${pass} / 失败 ${fail}`);
console.log(`${'='.repeat(50)}`);
process.exit(fail ? 1 : 0);
