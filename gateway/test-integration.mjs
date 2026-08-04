/**
 * test-integration.mjs — 综合实战测试：真实站点多步闭环
 *
 * 用 Wikipedia 做目标，模拟 Agent 的"感知→规划→操作→验证"闭环，
 * 全程不靠人工。重点验证之前单测覆盖不到的组合场景：
 *   - 多步操作的 ref 时效性（中途重新 snapshot）
 *   - wait 在真实动态页面的等待
 *   - download ref 模式在真实站点（非本地服务）
 *   - save_file/read_file 落盘任务状态
 *
 * 覆盖 10 个工具的串联：navigate/snapshot/fill/press/wait/screenshot/
 *                       scroll/download(ref)/save_file/read_file
 *
 * 前提：bridge 主模式运行，扩展已连接，用 spawn mcp-server 走 MCP 协议
 *      （download/save_file 只能经 MCP tools/call）
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const GATEWAY = join(dirname(fileURLToPath(import.meta.url)), 'mcp-server.mjs');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail ? '— ' + detail : ''}`); }
}

const proc = spawn('node', [GATEWAY], { stdio: ['pipe', 'pipe', 'inherit'] });
proc.on('error', (e) => { console.error('启动失败:', e); process.exit(1); });

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
          if (msg.id === obj.id) { proc.stdout.off('data', onData); resolve(msg); return; }
        } catch {}
      }
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(JSON.stringify(obj) + '\n');
  });
}

async function call(name, args = {}, id) {
  return sendMCP({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}
function getText(r) { return r?.result?.content?.[0]?.text || ''; }
function getObj(r) { try { return JSON.parse(getText(r)); } catch { return null; } }

await new Promise((r) => setTimeout(r, 1200));
await sendMCP({ jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'integ', version: '1' } } });

let id = 1;
const next = () => id++;

console.log('\n========== 综合实战：Wikipedia 多步闭环 ==========');

// 步骤 1：navigate
console.log('\n--- 步骤 1: navigate 到 Wikipedia ---');
const nav = await call('navigate', { url: 'https://en.wikipedia.org/wiki/JavaScript' }, next());
ok('导航 Wikipedia', nav?.result?.isError !== true, getText(nav).slice(0, 100));
await new Promise((r) => setTimeout(r, 2500));

// 步骤 2：get_snapshot 找搜索框
console.log('\n--- 步骤 2: get_snapshot 找搜索框 ---');
const snap1 = await call('get_snapshot', { interactiveOnly: true }, next());
const snapObj = getObj(snap1);
ok('snapshot 返回元素', snapObj && snapObj.elements?.length > 0, `count=${snapObj?.elements?.length}`);
// Wikipedia 搜索框 id=searchInput，input type=search
const searchBox = snapObj?.elements?.find((e) =>
  e.tag === 'input' && (e.attrs?.id === 'searchInput' || e.attrs?.type === 'search'));
ok('找到搜索框', !!searchBox, `ref=${searchBox?.ref} id=${searchBox?.attrs?.id}`);
if (!searchBox) { console.log('无法继续'); proc.kill(); process.exit(1); }

// 步骤 3：fill 搜索词
console.log('\n--- 步骤 3: fill 搜索框 "TypeScript" ---');
const fillRes = await call('fill', { ref: searchBox.ref, value: 'TypeScript' }, next());
ok('fill 搜索框', fillRes?.result?.isError !== true, getText(fillRes).slice(0, 100));

// 步骤 4：press Enter 触发搜索
console.log('\n--- 步骤 4: press Enter 触发搜索 ---');
const pressRes = await call('press', { key: 'Enter' }, next());
ok('press Enter', pressRes?.result?.isError !== true, getText(pressRes).slice(0, 100));

// 步骤 5：wait 搜索结果出现（TypeScript 词条标题）
console.log('\n--- 步骤 5: wait 搜索结果出现 ---');
const waitRes = await call('wait', { text: 'TypeScript', timeoutMs: 8000, intervalMs: 300 }, next());
const waitObj = getObj(waitRes);
ok('wait 命中 TypeScript 文本', waitObj?.ok === true && waitObj?.met === true, getText(waitRes).slice(0, 100));

// 步骤 6：screenshot 留证
console.log('\n--- 步骤 6: screenshot 留证 ---');
const ssRes = await call('screenshot', { format: 'jpeg', quality: 40 }, next());
const ssObj = getObj(ssRes);
ok('screenshot 返回 base64', ssObj?.base64?.length > 100, `size=${ssObj?.base64?.length}`);
ok('screenshot 是 jpeg', ssObj?.mime === 'image/jpeg', ssObj?.mime);

// 步骤 7：scroll 下拉验证可滚
console.log('\n--- 步骤 7: scroll 下拉 600 ---');
const scrollBefore = await call('get_snapshot', { interactiveOnly: true }, next());
const markerBefore = getObj(scrollBefore)?.elements?.find((e) => e.rect?.y > 200);
const beforeY = markerBefore?.rect?.y;
const scrollRes = await call('scroll', { direction: 'down', amount: 600 }, next());
await new Promise((r) => setTimeout(r, 1200));
const scrollAfter = await call('get_snapshot', { interactiveOnly: true }, next());
const markerAfter = getObj(scrollAfter)?.elements?.find((e) => String(e.ref) === String(markerBefore?.ref));
ok('scroll 返回 ok', getObj(scrollRes)?.ok === true, getText(scrollRes).slice(0, 80));
ok('页面确实滚动（元素 rect.y 变小）', markerAfter && markerAfter.rect.y < beforeY,
  `before=${beforeY} after=${markerAfter?.rect?.y}`);

// 步骤 8：重新 snapshot 找一个 <a> 链接，download ref 模式
console.log('\n--- 步骤 8: 重新 snapshot + download ref 模式 ---');
const snap2 = await call('get_snapshot', { interactiveOnly: true }, next());
const snap2Obj = getObj(snap2);
// 找一个指向 Wikipedia 词条的 <a>（href 含 /wiki/）
const link = snap2Obj?.elements?.find((e) => e.tag === 'a' && /\/wiki\//.test(e.attrs?.href || ''));
ok('找到词条链接', !!link, `ref=${link?.ref} href=${link?.attrs?.href?.slice(0, 50)}`);
if (link) {
  const dlPath = join(os.tmpdir(), `helm-integ-${Date.now()}.html`);
  const dlRes = await call('download', { ref: link.ref, path: dlPath }, next());
  const dlObj = getObj(dlRes);
  // download url 模式靠网关 fetch，若网关进程无网络/无代理会失败（浏览器能访问但 Node fetch 不能）
  // 这是已知设计权衡（网关 fetch vs 浏览器下载各有利弊），环境问题不判为工具 bug
  if (dlObj?.ok === true) {
    ok('download ref 成功', true, getText(dlRes).slice(0, 120));
    ok('文件已落盘', fs.existsSync(dlPath), `path=${dlPath}`);
    if (fs.existsSync(dlPath)) {
      const stat = fs.statSync(dlPath);
      ok('下载内容非空（>1KB）', stat.size > 1000, `size=${stat.size}`);
      try { fs.unlinkSync(dlPath); } catch {}
    }
  } else {
    const errText = getText(dlRes);
    const isEnvIssue = /fetch failed|Connect Timeout|ENOTFOUND|ECONNREFUSED|timeout/i.test(errText);
    ok(`download ref ${isEnvIssue ? '环境受限（网关无网络访问，非工具bug）' : '失败'}`, false,
      `err=${errText.slice(0, 100)}`);
    console.log('  提示: download url 模式走网关 fetch，若网关无代理/被墙会失败。浏览器可访问但 Node fetch 不能。');
  }
}

// 步骤 9：save_file 落盘任务清单
console.log('\n--- 步骤 9: save_file 落盘任务清单 ---');
const logPath = join(os.tmpdir(), `helm-task-log-${Date.now()}.txt`);
const logContent = `Helm 综合实战任务清单
时间: ${new Date().toISOString()}
站点: Wikipedia
步骤:
1. navigate en.wikipedia.org/wiki/JavaScript ✓
2. snapshot 找搜索框 ref=${searchBox.ref} ✓
3. fill "TypeScript" ✓
4. press Enter ✓
5. wait TypeScript 文本 ${waitObj?.met ? '✓' : '✗'}
6. screenshot jpeg ${ssObj?.base64?.length || 0} bytes ✓
7. scroll down 600 ${markerAfter && markerAfter.rect.y < beforeY ? '✓' : '✗'}
8. download ref ${link ? '✓' : '✗'}
9. save_file 本清单 ✓
`;
const sfRes = await call('save_file', { path: logPath, content: logContent }, next());
const sfObj = getObj(sfRes);
ok('save_file 成功', sfObj?.ok === true, getText(sfRes).slice(0, 80));
ok('清单文件已落盘', fs.existsSync(logPath));

// 步骤 10：read_file 读回验证
console.log('\n--- 步骤 10: read_file 读回清单验证 ---');
const rfRes = await call('read_file', { path: logPath }, next());
const rfObj = getObj(rfRes);
ok('read_file 成功', rfObj?.ok === true, getText(rfRes).slice(0, 80));
ok('读回内容含任务标记', /综合实战|navigate|snapshot/.test(rfObj?.content || ''), '内容匹配');
try { fs.unlinkSync(logPath); } catch {}

// 收尾
proc.kill();
await new Promise((r) => setTimeout(r, 300));

console.log(`\n${'='.repeat(50)}`);
console.log(`综合实战结果: 通过 ${pass} / 失败 ${fail}`);
console.log(`覆盖工具: navigate/snapshot/fill/press/wait/screenshot/scroll/download(ref)/save_file/read_file`);
console.log(`${'='.repeat(50)}`);
process.exit(fail ? 1 : 0);
