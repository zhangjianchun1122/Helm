/**
 * verify-tab-scope.mjs —— 标签页作用域的真实浏览器验证
 *
 * 必须连着真实 Chrome 扩展跑（以附属模式连常驻 bridge）。验证两件单测覆盖不到的事：
 *   1. screenshot 按 tabId 定位：后台 tab 走 CDP，不再静默截到前台页面。
 *      captureVisibleTab 没有 tabId 参数，这条只能在真实浏览器里验。
 *   2. frame 作用域按 tab 隔离：set_active_frame 不再泄漏到其它标签页。
 *
 * download 的 ref 模式（同属本轮修复）需要 download 授权，不在此脚本内自行授权。
 *
 * 用法：node gateway/verify-tab-scope.mjs
 * 退出码：0 全通过 / 1 有失败 / 2 扩展仍在跑旧代码（需在 chrome://extensions 重载）
 *
 * 注意：改了 extension/sw.js 后必须先重载扩展，否则脚本会以退出码 2 提前退出，
 * 而不是给出会误导人的"通过"。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 默认用已部署的网关副本；HELM_GATEWAY_DIR 可覆盖（比如想直接跑仓库版本）
const GATEWAY_DIR = process.env.HELM_GATEWAY_DIR
  || path.dirname(fileURLToPath(import.meta.url));
const EXPECTED_EXTENSION_VERSION = JSON.parse(fs.readFileSync(path.join(GATEWAY_DIR, '..', 'extension', 'manifest.json'), 'utf8')).version;
const proc = spawn('node', [path.join(GATEWAY_DIR, 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
let seq = 300;

function send(method, params) {
  const id = seq++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout id=' + id)), 40000);
    const onData = (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) { clearTimeout(timer); proc.stdout.off('data', onData); resolve(msg); return; }
        } catch { /* skip */ }
      }
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const call = (n, a = {}) => send('tools/call', { name: n, arguments: a });
const text = (r) => r?.result?.content?.[0]?.text || '';
const json = (r) => { try { return JSON.parse(text(r)); } catch { return null; } };
const isErr = (r) => r?.result?.isError === true;

// screenshot 在默认策略里是 confirm 档，直接调只会拿到 HELM_CONFIRMATION_REQUIRED。
// 完整握手：首调拿 confirmationId → confirm_execution 批准 → 带 confirmationId 与
// confirmationRequestId 重调。重调必须回传 confirmationRequestId，因为策略是按它绑定的
// （execution-guard 用 args.confirmationRequestId 覆盖传输层 requestId）；
// 参数摘要校验会忽略这两个字段，所以其余参数必须与首调完全一致。
async function callConfirmed(name, args = {}) {
  const first = json(await call(name, args));
  if (first?.code !== 'HELM_CONFIRMATION_REQUIRED') return first; // 策略放行则首调即结果
  const { confirmationId, confirmationRequestId } = first;
  const approved = json(await call('confirm_execution', { confirmationId }));
  if (approved?.ok !== true) {
    return { ok: false, error: 'confirm_execution 失败', detail: approved };
  }
  return json(await call(name, { ...args, confirmationId, confirmationRequestId }));
}

let pass = 0, fail = 0;
const testTabIds = new Set();
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  \u2713 ${n}`); } else { fail++; console.log(`  \u2717 ${n}${d ? ' \u2014 ' + d : ''}`); } };

async function cleanupTestTabs() {
  for (const tabId of [...testTabIds].reverse()) {
    try {
      const tabs = json(await call('list_tabs', {})) || [];
      if (tabs.some((tab) => tab.id === tabId)) await call('close_tab', { tabId });
    } catch (_) { /* best effort cleanup */ }
  }
}

await new Promise((r) => setTimeout(r, 1500));
await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p0-verify', version: '1' } });

// 探测扩展代码版本。改了 sw.js 必须重载扩展，否则跑的还是上一版，
// 断言失败会被误读成"改动没生效"。这里逐项检查特征，而不是只看一个字段。
const probe = json(await call('get_active_frame', {}));
if (!probe || !('tabId' in probe)) {
  console.log('\n[扩展] 跑的是 frame 作用域按 tab 隔离之前的版本');
  console.log('       请在 chrome://extensions 点 Helm 的「重新加载」后重跑');
  console.log('       get_active_frame 返回:', JSON.stringify(probe));
  proc.kill();
  process.exit(2);
}
const reloadProbe = json(await call('reload_extension', {}));
if (reloadProbe?.version && reloadProbe.version !== EXPECTED_EXTENSION_VERSION) {
  console.log(`\n[扩展] 实际加载版本 ${reloadProbe.version}，磁盘版本 ${EXPECTED_EXTENSION_VERSION}`);
  console.log('       当前浏览器仍加载旧部署目录，请安装/加载最新 extension/ 后重跑');
  proc.kill();
  process.exit(2);
}

// 截图实现换过方案：早前用 CDP（已证实在 Chrome 150 上行不通），现在用临时激活。
// 若还能看到 CDP 的痕迹，说明扩展仍是上一版。
let staleHintShown = false;
function hintIfStaleOrMinimized(res) {
  if (staleHintShown) return;
  const msg = typeof res?.message === 'string' ? res.message : JSON.stringify(res ?? '');
  if (res?.via === 'cdp' || /from surface|captureScreenshot|已被其它调试器占用/.test(msg)) {
    console.log('\n  ⚠ 扩展仍在跑基于 CDP 的上一版截图实现（Chrome 150 已证实该方案不可用）。');
    console.log('    请在 chrome://extensions 点 Helm 的「重新加载」后重跑本脚本。\n');
    staleHintShown = true;
  } else if (/captureVisibleTab 超时/.test(msg)) {
    console.log('\n  ⚠ 截图超时通常意味着 Chrome 窗口处于最小化状态。');
    console.log('    Chrome 无法截取未在渲染的窗口，请还原窗口后重跑本脚本。\n');
    staleHintShown = true;
  }
}

console.log('[扩展] frame 作用域已按 tab 隔离，继续验证\n');

let runError = null;
try {
console.log('=== 准备：前台 tab F 与后台 tab G ===');
const f = json(await call('create_tab', { url: 'https://example.com/' }));
const tabF = f?.tabId;
if (typeof tabF === 'number') testTabIds.add(tabF);
ok('前台 tab F 创建', typeof tabF === 'number', JSON.stringify(f));

// active:false 后台打开，但按既有设计它会成为操作目标
const g = json(await call('create_tab', { url: 'https://example.org/', active: false }));
const tabG = g?.tabId;
if (typeof tabG === 'number') testTabIds.add(tabG);
ok('后台 tab G 创建', typeof tabG === 'number', JSON.stringify(g));

const tabs = json(await call('list_tabs', {})) || [];
const activeTab = tabs.find((t) => t.active);
ok('F 是当前前台 tab', activeTab?.id === tabF, `前台实为 ${activeTab?.id}`);
console.log(`    tabF=${tabF}(前台 example.com)  tabG=${tabG}(后台 example.org)`);

console.log('\n=== P0-1: screenshot 按 tabId 定位 ===');
// G 是操作目标但在后台。旧实现会截前台 F。
const shotG = await callConfirmed('screenshot', { format: 'png', tabId: tabG });
hintIfStaleOrMinimized(shotG);
ok('截后台 G 未报错', shotG?.ok === true, JSON.stringify(shotG).slice(0, 200));
ok('截后台 G 返回的 tabId 是 G', shotG?.tabId === tabG, `实为 ${shotG?.tabId}`);
ok('截后台 G 走临时激活路径', shotG?.via === 'activate+captureVisibleTab', `实为 ${shotG?.via}`);

const shotF = await callConfirmed('screenshot', { format: 'png', tabId: tabF });
hintIfStaleOrMinimized(shotF);
ok('截前台 F 未报错', shotF?.ok === true, JSON.stringify(shotF).slice(0, 200));
ok('截前台 F 走直截快路径', shotF?.via === 'captureVisibleTab', `实为 ${shotF?.via}`);

// 临时激活必须切回：截完后前台仍应是 F
const tabsAfterShot = json(await call('list_tabs', {})) || [];
ok('临时激活后已切回原前台 F', tabsAfterShot.find((t) => t.active)?.id === tabF,
  `当前前台为 ${tabsAfterShot.find((t) => t.active)?.id}`);

// 关键判据：两张图必须不同。旧实现两次都截前台，会得到几乎相同的图。
const hashG = shotG?.base64 ? crypto.createHash('sha256').update(shotG.base64).digest('hex') : null;
const hashF = shotF?.base64 ? crypto.createHash('sha256').update(shotF.base64).digest('hex') : null;
ok('后台图与前台图内容不同（证明确实截了不同 tab）', hashG && hashF && hashG !== hashF,
  `G=${hashG?.slice(0, 12)} F=${hashF?.slice(0, 12)}`);
console.log(`    G 图 ${shotG?.size} 字节 via=${shotG?.via} | F 图 ${shotF?.size} 字节 via=${shotF?.via}`);

// 不传 tabId 时应跟随当前操作目标（G，后台），而非前台
const shotDefault = await callConfirmed('screenshot', { format: 'png' });
hintIfStaleOrMinimized(shotDefault);
ok('不传 tabId 时跟随当前操作目标 G（而非前台 F）', shotDefault?.tabId === tabG,
  `实为 ${shotDefault?.tabId}，原始返回 ${JSON.stringify(shotDefault).slice(0, 240)}`);

console.log('\n=== P0-3: frame 作用域按 tab 隔离 ===');
// 给 F 设一个不存在的 frameId。旧实现是全局值，会连带影响 G。
const setF = json(await call('set_active_frame', { frameId: 99999, tabId: tabF }));
ok('给 F 设 frameId=99999 成功', setF?.ok === true, JSON.stringify(setF));
ok('set_active_frame 回执标明作用于 F', setF?.tabId === tabF, JSON.stringify(setF));

const getF = json(await call('get_active_frame', { tabId: tabF }));
ok('查询 F 得到 99999', getF?.activeFrameId === 99999, JSON.stringify(getF));

const getG = json(await call('get_active_frame', { tabId: tabG }));
ok('查询 G 得到 null（未被 F 的设定污染）', getG?.activeFrameId === null, JSON.stringify(getG));

// 功能判据：F 上操作应失败（frame 不存在），G 上操作应成功（走主文档）
const snapF = await call('get_snapshot', { tabId: tabF });
ok('F 上 get_snapshot 失败（frame 99999 不存在，符合预期）', isErr(snapF),
  text(snapF).slice(0, 120));

const snapG = await call('get_snapshot', { tabId: tabG });
ok('G 上 get_snapshot 成功（未继承 F 的 frame 作用域）', !isErr(snapG),
  text(snapG).slice(0, 160));
ok('G 的快照确实来自 example.org', /example\.org/.test(text(snapG)), text(snapG).slice(0, 160));

// 复位 F
const resetF = json(await call('set_active_frame', { tabId: tabF }));
ok('F 的 frame 作用域可复位为主文档', resetF?.activeFrameId === null, JSON.stringify(resetF));
const snapFAfter = await call('get_snapshot', { tabId: tabF });
ok('复位后 F 上 get_snapshot 恢复正常', !isErr(snapFAfter), text(snapFAfter).slice(0, 120));

console.log('\n=== P1：激活、关闭、回退与错误语义 ===');
const activateG = json(await call('activate_tab', { tabId: tabG }));
ok('显式激活 G 成功', activateG?.ok === true && activateG?.tabId === tabG, JSON.stringify(activateG));
const activeAfterActivate = (json(await call('list_tabs', {})) || []).find((tab) => tab.active);
ok('显式激活后 G 为前台', activeAfterActivate?.id === tabG, `前台实为 ${activeAfterActivate?.id}`);
const returnToF = json(await call('activate_tab', { tabId: tabF }));
const activeBeforeHighlight = (json(await call('list_tabs', {})) || []).find((tab) => tab.active);
ok('切回 F 后 F 为前台', returnToF?.tabId === tabF && activeBeforeHighlight?.id === tabF, JSON.stringify(activeBeforeHighlight));

// 让显式 tabId 操作产生高亮，再检查后台目标 G 上的高亮。
// 若高亮错误地跟随 pendingTabId，它会留在活动页 F，G 上的读取会返回 false。
const snapForHighlight = await call('get_snapshot', { tabId: tabG });
ok('显式 G 操作成功（高亮前置）', !isErr(snapForHighlight), text(snapForHighlight).slice(0, 120));
await new Promise((r) => setTimeout(r, 250));
const highlightG = await callConfirmed('eval', { tabId: tabG, code: "return !!document.getElementById('__helm_highlight__')" });
ok('高亮跟随显式目标 G', highlightG?.result === true || highlightG === true, JSON.stringify(highlightG));

const setGTarget = json(await call('get_active_frame', { tabId: tabG }));
ok('关闭前 G 仍是默认目标候选', setGTarget?.tabId === tabG, JSON.stringify(setGTarget));
const staleId = 2147483647;
const stale = await call('get_snapshot', { tabId: staleId });
ok('陈旧 tabId 返回友好错误', isErr(stale) && /已关闭或不存在|新建标签页/.test(text(stale)) && !/No tab with id/i.test(text(stale)), text(stale).slice(0, 180));
const zeroId = await call('get_snapshot', { tabId: 0 });
ok('tabId=0 不静默回退', isErr(zeroId) && /已关闭或不存在|新建标签页/.test(text(zeroId)), text(zeroId).slice(0, 180));

const closedG = json(await call('close_tab', { tabId: tabG }));
testTabIds.delete(tabG);
ok('显式关闭 G 成功', closedG?.ok === true && closedG?.closedTabId === tabG, JSON.stringify(closedG));
const afterCloseTabs = json(await call('list_tabs', {})) || [];
ok('关闭 G 后 F 仍存在且为前台', afterCloseTabs.some((tab) => tab.id === tabF) && afterCloseTabs.find((tab) => tab.active)?.id === tabF, JSON.stringify(afterCloseTabs));
const closedFrame = json(await call('get_active_frame', { tabId: tabG }));
ok('关闭 G 后 frame scope 已清理', closedFrame?.code === 'HELM_TAB_NOT_FOUND' || /已关闭或不存在/.test(JSON.stringify(closedFrame)), JSON.stringify(closedFrame));

// active:false 的 H 会成为默认操作目标但保持 F 在前台；不传 tabId 关闭它，
// 才能验证 close_tab 关闭当前目标后的 pendingTabId 回退。
const h = json(await call('create_tab', { url: 'https://example.net/', active: false }));
const tabH = h?.tabId;
if (typeof tabH === 'number') testTabIds.add(tabH);
ok('后台 tab H 创建为默认目标', typeof tabH === 'number', JSON.stringify(h));
const closedH = json(await call('close_tab', {}));
testTabIds.delete(tabH);
ok('不传 tabId 关闭当前目标 H 成功', closedH?.ok === true && closedH?.closedTabId === tabH, JSON.stringify(closedH));
const afterDefaultCloseTabs = json(await call('list_tabs', {})) || [];
ok('关闭当前目标 H 后 F 仍为前台', afterDefaultCloseTabs.find((tab) => tab.active)?.id === tabF, JSON.stringify(afterDefaultCloseTabs));
const defaultAfterClose = json(await call('get_active_frame', {}));
ok('关闭当前目标后默认目标回退到 F', defaultAfterClose?.tabId === tabF, JSON.stringify(defaultAfterClose));

} catch (error) {
  runError = error;
  console.error('\nP1 回归脚本异常:', error?.message || error);
} finally {
  await cleanupTestTabs();
}
console.log(`\n${'='.repeat(54)}`);
console.log(`P1 验证: 通过 ${pass} / 失败 ${fail}`);
console.log('测试创建的标签页已清理');
console.log(`${'='.repeat(54)}`);

proc.kill();
await new Promise((r) => setTimeout(r, 300));
process.exit(runError || fail ? 1 : 0);
