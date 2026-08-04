/**
 * verify-e2e.mjs — 端到端链路验证
 *
 * 用一个进程同时扮演：
 *  1. 模拟 MCP 客户端：spawn 网关进程 mcp-server.mjs，通过 stdin 发 JSON-RPC
 *  2. 模拟扩展 offscreen：连网关 WS（127.0.0.1:8787），接收 invoke 并回假数据
 *
 * 验证项：
 *  A. MCP initialize 握手
 *  B. tools/list 返回 9 个工具
 *  C. 扩展未连接时 tools/call 返回友好错误
 *  D. 扩展连上后，tools/call -> bridge -> offscreen -> 回程 全链路往返
 *  E. get_snapshot 走全链路并拿到模拟数据
 *  F. navigate（不需要扩展真实操作，验证路由分发）
 */

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const GATEWAY = join(dirname(fileURLToPath(import.meta.url)), 'mcp-server.mjs');
const WS_URL = 'ws://127.0.0.1:8787';

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail ? '— ' + detail : ''}`); }
}

// ---------- 启动网关进程（= MCP server，内部起 bridge）----------
const proc = spawn('node', [GATEWAY], { stdio: ['pipe', 'pipe', 'inherit'] });
proc.on('error', (e) => { console.error('启动网关失败:', e); process.exit(1); });

let mcpBuffer = '';
function sendMCP(obj) {
  return new Promise((resolve) => {
    const id = obj.id;
    const onData = (chunk) => {
      mcpBuffer += chunk.toString();
      let idx;
      while ((idx = mcpBuffer.indexOf('\n')) >= 0) {
        const line = mcpBuffer.slice(0, idx).trim();
        mcpBuffer = mcpBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            proc.stdout.off('data', onData);
            resolve(msg);
            return;
          }
        } catch { /* skip */ }
      }
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(JSON.stringify(obj) + '\n');
  });
}

// 等 bridge 起来
await new Promise((r) => setTimeout(r, 1200));

console.log('\n=== A. MCP initialize 握手 ===');
const init = await sendMCP({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1' } },
});
ok('返回 protocolVersion', init?.result?.protocolVersion === '2024-11-05', JSON.stringify(init?.result));
ok('返回 serverInfo', init?.result?.serverInfo?.name === 'browser-tool');

console.log('\n=== B. tools/list ===');
const list = await sendMCP({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const toolNames = (list?.result?.tools || []).map((t) => t.name);
ok('返回 21 个工具', toolNames.length === 21, `实际 ${toolNames.length}: ${toolNames.join(',')}`);
ok('含核心工具 navigate/get_snapshot/click/fill/eval',
  ['navigate', 'get_snapshot', 'click', 'fill', 'eval'].every((n) => toolNames.includes(n)));
ok('含 wait/screenshot/scroll/hover/set_active_frame/drag/save_file/download',
  ['wait', 'screenshot', 'scroll', 'hover', 'set_active_frame', 'drag', 'save_file', 'download'].every((n) => toolNames.includes(n)));

console.log('\n=== C. 扩展未连接时 tools/call 友好报错 ===');
const noExt = await sendMCP({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_tabs', arguments: {} } });
// 真实环境扩展可能已连上，此时 list_tabs 会成功返回数据；只有未连接时才该报错
if (noExt?.result?.isError) {
  ok('未连接时返回 isError=true', true);
  ok('错误文案含提示', /扩展未连接/.test(noExt?.result?.content?.[0]?.text || ''));
} else {
  ok('扩展已连接，list_tabs 返回数据（跳过报错断言）', noExt?.result?.content?.[0]?.text?.length > 0);
}

// ---------- 连模拟扩展 ----------
console.log('\n=== D. 模拟扩展 offscreen 连网关 WS ===');
const extWs = new WebSocket(WS_URL);
let extConnected = false;
const pendingExt = new Map(); // id -> resolve
let extId = 1;

extWs.on('open', () => {
  extConnected = true;
  extWs.send(JSON.stringify({ type: 'hello', role: 'extension' }));
});
extWs.on('message', (raw) => {
  let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.type === 'ping') { extWs.send(JSON.stringify({ type: 'pong', t: Date.now() })); return; }
  if (msg.type === 'invoke') {
    // 模拟扩展响应：按 action 返回假数据
    let data;
    switch (msg.action) {
      case 'listTabs':
        data = [{ id: 1, url: 'https://example.com', title: '示例', active: true }];
        break;
      case 'snapshot':
        data = { url: 'https://example.com', title: '示例页', elementCount: 1,
          elements: [{ ref: '1', tag: 'a', text: '登录', attrs: { href: '/login' } }] };
        break;
      case 'navigate':
        data = { ok: true, url: msg.args?.url, tabId: 1 };
        break;
      case 'click':
        data = { ok: true };
        break;
      case 'checkCondition':
        // 模拟条件探测：text 条件返回 met=true，让 wait 立即满足
        data = { met: true };
        break;
      case 'screenshot':
        data = { ok: true, format: 'png', mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', size: 70 };
        break;
      case 'scroll': {
        // 真实 SW 把 options 包在 args.options 里透传给 dom-agent；mock 同样从 args.options 取
        const opt = msg.args?.options || {};
        data = { ok: true, mode: opt.ref != null ? 'toElement' : 'byDirection', echoed: opt };
        break;
      }
      case 'hover':
        data = { ok: true, hoveredRef: msg.args?.ref };
        break;
      case 'downloadViaBrowser':
        // fallback 路径 mock：网关 fetch 失败时调扩展浏览器下载
        data = { ok: true, downloadId: 1, path: '/mock/downloads/' + (msg.args?.filename || 'file.bin'), url: msg.args?.url, mime: 'application/octet-stream' };
        break;
      case 'setActiveFrame':
        data = { ok: true, activeFrameId: msg.args?.frameId ?? null, echoed: msg.args };
        break;
      case 'getActiveFrame':
        data = { ok: true, activeFrameId: null, note: 'mock' };
        break;
      case 'drag':
        data = { ok: true, from: { ref: msg.args?.fromRef }, to: { ref: msg.args?.toRef }, steps: msg.args?.options?.steps };
        break;
      case 'wait':
        // 真实 SW 会把 wait 编排成多次 checkCondition 轮询；这里模拟扩展不重复 SW 逻辑，
        // 仅回显收到的参数，验证 MCP→bridge→扩展 的参数映射正确。
        data = { ok: true, mocked: true, echoedArgs: msg.args };
        break;
      default:
        data = { ok: true, mocked: true, action: msg.action };
    }
    extWs.send(JSON.stringify({ id: msg.id, type: 'result', ok: true, data }));
  }
});

await new Promise((r) => setTimeout(r, 800));
ok('扩展 WS 已连接', extConnected);

console.log('\n=== E. get_snapshot 全链路往返 ===');
const snap = await sendMCP({ jsonrpc: '2.0', id: 4, method: 'tools/call',
  params: { name: 'get_snapshot', arguments: {} } });
const snapText = snap?.result?.content?.[0]?.text || '';
ok('无 isError', snap?.result?.isError !== true);
ok('含模拟数据 elementCount', /elementCount/.test(snapText), snapText.slice(0, 200));
ok('含 ref=1 登录链接', /ref[\s\S]*1[\s\S]*登录/.test(snapText), snapText.slice(0, 200));

console.log('\n=== F. navigate 全链路路由 ===');
const nav = await sendMCP({ jsonrpc: '2.0', id: 5, method: 'tools/call',
  params: { name: 'navigate', arguments: { url: 'https://target.example.com' } } });
const navText = nav?.result?.content?.[0]?.text || '';
ok('navigate 到达扩展', /target\.example\.com/.test(navText), navText.slice(0, 200));

console.log('\n=== G. click 带 frameId 透传 ===');
const clk = await sendMCP({ jsonrpc: '2.0', id: 6, method: 'tools/call',
  params: { name: 'click', arguments: { ref: '1', button: 'right', frameId: 5 } } });
ok('click 成功回执', clk?.result?.isError !== true, JSON.stringify(clk?.result).slice(0, 200));

console.log('\n=== H. wait 参数映射与链路 ===');
// 真实 SW 会把 wait 编排成多次 checkCondition 轮询，此处仅验证 MCP→bridge→扩展 参数透传
const wt = await sendMCP({ jsonrpc: '2.0', id: 7, method: 'tools/call',
  params: { name: 'wait', arguments: { text: '登录成功', timeoutMs: 2000, intervalMs: 100 } } });
const wtText = wt?.result?.content?.[0]?.text || '';
ok('wait 未报错', wt?.result?.isError !== true, JSON.stringify(wt?.result).slice(0, 200));
ok('wait 参数正确透传', /登录成功/.test(wtText) && /timeoutMs/.test(wtText), wtText.slice(0, 200));

console.log('\n=== I. screenshot 全链路 ===');
const ss = await sendMCP({ jsonrpc: '2.0', id: 8, method: 'tools/call',
  params: { name: 'screenshot', arguments: { format: 'png' } } });
const ssText = ss?.result?.content?.[0]?.text || '';
ok('screenshot 未报错', ss?.result?.isError !== true, JSON.stringify(ss?.result).slice(0, 200));
ok('screenshot 返回 base64', /base64/.test(ssText) && /iVBORw0KGgo/.test(ssText), ssText.slice(0, 200));

console.log('\n=== J. scroll 参数映射与链路 ===');
const sc1 = await sendMCP({ jsonrpc: '2.0', id: 9, method: 'tools/call',
  params: { name: 'scroll', arguments: { direction: 'down', amount: 500 } } });
const sc1Text = sc1?.result?.content?.[0]?.text || '';
ok('scroll 方向模式未报错', sc1?.result?.isError !== true, JSON.stringify(sc1?.result).slice(0, 200));
ok('scroll 透传 direction/amount', /down/.test(sc1Text) && /500/.test(sc1Text), sc1Text.slice(0, 200));

const sc2 = await sendMCP({ jsonrpc: '2.0', id: 10, method: 'tools/call',
  params: { name: 'scroll', arguments: { ref: '5' } } });
const sc2Text = sc2?.result?.content?.[0]?.text || '';
ok('scroll ref 模式未报错', sc2?.result?.isError !== true, JSON.stringify(sc2?.result).slice(0, 200));
ok('scroll ref 模式识别为 toElement', /toElement/.test(sc2Text), sc2Text.slice(0, 200));

console.log('\n=== K. hover 参数映射与链路 ===');
const hv = await sendMCP({ jsonrpc: '2.0', id: 11, method: 'tools/call',
  params: { name: 'hover', arguments: { ref: '7' } } });
const hvText = hv?.result?.content?.[0]?.text || '';
ok('hover 未报错', hv?.result?.isError !== true, JSON.stringify(hv?.result).slice(0, 200));
ok('hover ref 透传', /"7"/.test(hvText), hvText.slice(0, 200));

console.log('\n=== L. set_active_frame / get_active_frame 参数映射 ===');
// 关键验证：set_active_frame 的 frameId 是"要设定的值"，不能被 mapToolToAction 剥进 opts 当作用域
const sf = await sendMCP({ jsonrpc: '2.0', id: 12, method: 'tools/call',
  params: { name: 'set_active_frame', arguments: { frameId: 5 } } });
const sfText = sf?.result?.content?.[0]?.text || '';
ok('set_active_frame 未报错', sf?.result?.isError !== true, JSON.stringify(sf?.result).slice(0, 200));
ok('frameId=5 作为设定值透传到 args（非 opts 作用域）', /"frameId"\s*:\s*5/.test(sfText) && /5/.test(sfText), sfText.slice(0, 200));

const gf = await sendMCP({ jsonrpc: '2.0', id: 13, method: 'tools/call',
  params: { name: 'get_active_frame', arguments: {} } });
ok('get_active_frame 未报错', gf?.result?.isError !== true, JSON.stringify(gf?.result).slice(0, 200));

// 回到主文档：frameId 不传
const sf2 = await sendMCP({ jsonrpc: '2.0', id: 14, method: 'tools/call',
  params: { name: 'set_active_frame', arguments: {} } });
const sf2Text = sf2?.result?.content?.[0]?.text || '';
ok('set_active_frame 无参回到主文档', /null/.test(sf2Text) || /"activeFrameId"\s*:\s*null/.test(sf2Text), sf2Text.slice(0, 200));

console.log('\n=== M. drag 参数映射与链路 ===');
const dg = await sendMCP({ jsonrpc: '2.0', id: 15, method: 'tools/call',
  params: { name: 'drag', arguments: { fromRef: '3', toRef: '8', steps: 20 } } });
const dgText = dg?.result?.content?.[0]?.text || '';
ok('drag 未报错', dg?.result?.isError !== true, JSON.stringify(dg?.result).slice(0, 200));
ok('drag fromRef/toRef 透传', /"3"/.test(dgText) && /"8"/.test(dgText), dgText.slice(0, 200));
ok('drag steps 透传', /20/.test(dgText), dgText.slice(0, 200));

// ---------- N. 本地 fs 工具真实测试（不经扩展，网关子进程直接 fs） ----------
console.log('\n=== N. save_file / read_file / list_files 真实 fs ===');
const tmpDir = join(os.tmpdir(), `bt-e2e-${Date.now()}`);
const tmpFile = join(tmpDir, 'test.txt');

// N1. save_file 写入
const sv = await sendMCP({ jsonrpc: '2.0', id: 16, method: 'tools/call',
  params: { name: 'save_file', arguments: { path: tmpFile, content: 'hello browser-tool\nline2' } } });
const svText = sv?.result?.content?.[0]?.text || '';
ok('save_file 未报错', sv?.result?.isError !== true, svText.slice(0, 200));
ok('save_file 返回 ok:true', /"ok"\s*:\s*true/.test(svText), svText.slice(0, 200));
ok('save_file 自动建父目录', fs.existsSync(tmpFile), `文件应存在于 ${tmpFile}`);
ok('save_file 字节数正确', /"bytes"\s*:\s*\d+/.test(svText), svText.slice(0, 200));

// N2. read_file 读回
const rf = await sendMCP({ jsonrpc: '2.0', id: 17, method: 'tools/call',
  params: { name: 'read_file', arguments: { path: tmpFile } } });
const rfText = rf?.result?.content?.[0]?.text || '';
ok('read_file 未报错', rf?.result?.isError !== true, rfText.slice(0, 200));
ok('read_file 内容一致', /hello browser-tool/.test(rfText) && /line2/.test(rfText), rfText.slice(0, 200));

// N3. save_file append 追加
const sv2 = await sendMCP({ jsonrpc: '2.0', id: 18, method: 'tools/call',
  params: { name: 'save_file', arguments: { path: tmpFile, content: '\nappended', append: true } } });
ok('save_file append 未报错', sv2?.result?.isError !== true, JSON.stringify(sv2?.result).slice(0, 200));
const rf2 = await sendMCP({ jsonrpc: '2.0', id: 19, method: 'tools/call',
  params: { name: 'read_file', arguments: { path: tmpFile } } });
ok('append 后含旧+新内容', /hello browser-tool/.test(rf2?.result?.content?.[0]?.text || '') && /appended/.test(rf2?.result?.content?.[0]?.text || ''), (rf2?.result?.content?.[0]?.text || '').slice(0, 200));

// N4. list_files 列目录
// 多建一个子目录文件验证 recursive
const subDir = join(tmpDir, 'sub');
await fs.promises.mkdir(subDir, { recursive: true });
await fs.promises.writeFile(join(subDir, 'a.txt'), 'a');
const lf = await sendMCP({ jsonrpc: '2.0', id: 20, method: 'tools/call',
  params: { name: 'list_files', arguments: { dir: tmpDir, recursive: true } } });
const lfText = lf?.result?.content?.[0]?.text || '';
ok('list_files 未报错', lf?.result?.isError !== true, lfText.slice(0, 200));
ok('list_files 含 test.txt', /test\.txt/.test(lfText), lfText.slice(0, 200));
ok('list_files recursive 含 sub/a.txt', /sub/.test(lfText) && /a\.txt/.test(lfText), lfText.slice(0, 200));

// N5. read_file 不存在文件报错
const rf3 = await sendMCP({ jsonrpc: '2.0', id: 21, method: 'tools/call',
  params: { name: 'read_file', arguments: { path: join(tmpDir, 'nope.txt') } } });
ok('read_file 不存在文件返回 isError', rf3?.result?.isError === true, JSON.stringify(rf3?.result).slice(0, 200));

// N6. download url 模式（下个小文件，纯网关 fetch+fs）
console.log('\n=== O. download url 模式（网关 fetch+fs） ===');
const dlPath = join(tmpDir, 'logo.png');
const dl = await sendMCP({ jsonrpc: '2.0', id: 22, method: 'tools/call',
  params: { name: 'download', arguments: { url: 'https://www.w3.org/Icons/w3c_main.png', path: dlPath } } });
const dlText = dl?.result?.content?.[0]?.text || '';
ok('download 未报错', dl?.result?.isError !== true, dlText.slice(0, 200));
ok('download 返回 ok:true', /"ok"\s*:\s*true/.test(dlText), dlText.slice(0, 200));
ok('download 文件已落盘', fs.existsSync(dlPath), `应存在于 ${dlPath}`);
const dlStat = fs.statSync(dlPath);
ok('download 文件非空', dlStat.size > 0, `size=${dlStat.size}`);

// 清理临时目录
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

// ---------- 收尾 ----------
extWs.close();
proc.kill();

await new Promise((r) => setTimeout(r, 300));

console.log(`\n${'='.repeat(50)}`);
console.log(`验证结果: 通过 ${pass} / 失败 ${fail}`);
console.log(`${'='.repeat(50)}`);
process.exit(fail ? 1 : 0);
