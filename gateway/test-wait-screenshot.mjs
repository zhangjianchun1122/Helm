/**
 * test-wait-screenshot.mjs — 真实浏览器端到端测试 wait / screenshot
 *
 * 前提：bridge 已在 8787 主模式运行，扩展已加载最新代码（含 wait/screenshot action）。
 * 本脚本作为附属模式连入主网关，直接调 invoke，验证真实 SW + dom-agent 行为。
 *
 * 用法：node test-wait-screenshot.mjs
 * 前置：浏览器已打开一个普通 http(s) 页面（example.com 即可）。
 */

import { invoke, startOrAttach } from './bridge.mjs';

await startOrAttach();
// 等附属模式连上主网关
await new Promise((r) => setTimeout(r, 600));

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail ? '— ' + detail : ''}`); }
}

// ---------- 1. screenshot 基本可用 ----------
console.log('\n=== 1. screenshot 基本可用 ===');
try {
  const r = await invoke('screenshot', { format: 'png' }, {});
  ok('返回 ok:true', r.ok === true, JSON.stringify(r).slice(0, 200));
  ok('返回 mime', r.mime === 'image/png', r.mime);
  ok('返回 base64 数据', typeof r.base64 === 'string' && r.base64.length > 100, `len=${r.base64?.length}`);
  ok('base64 是合法 PNG 头', r.base64?.startsWith('iVBORw0KGgo'), r.base64?.slice(0, 20));
} catch (e) {
  ok('screenshot 执行', false, e.message);
}

// ---------- 2. screenshot jpeg + quality ----------
console.log('\n=== 2. screenshot jpeg + quality ===');
try {
  const r = await invoke('screenshot', { format: 'jpeg', quality: 50 }, {});
  ok('返回 jpeg mime', r.mime === 'image/jpeg', r.mime);
  ok('jpeg base64 以 /9j/ 开头', r.base64?.startsWith('/9j/'), r.base64?.slice(0, 10));
} catch (e) {
  ok('screenshot jpeg', false, e.message);
}

// ---------- 3. wait 等文本出现（应立即命中，因为 example.com 含 "Example Domain"） ----------
console.log('\n=== 3. wait 等文本出现（应命中） ===');
try {
  const r = await invoke('wait', { text: 'Example Domain', timeoutMs: 3000, intervalMs: 200 }, {});
  ok('返回 ok:true', r.ok === true, JSON.stringify(r).slice(0, 200));
  ok('返回 met:true', r.met === true, JSON.stringify(r));
  ok('waitedMs < timeoutMs（提前命中）', r.waitedMs < 3000, `waitedMs=${r.waitedMs}`);
} catch (e) {
  ok('wait 命中', false, e.message);
}

// ---------- 4. wait 等不存在的文本（应超时，ok:false 不抛错） ----------
console.log('\n=== 4. wait 等不存在的文本（超时） ===');
const t0 = Date.now();
try {
  const r = await invoke('wait', { text: '这段文本绝对不会出现ZZZ', timeoutMs: 1500, intervalMs: 200 }, {});
  const elapsed = Date.now() - t0;
  ok('返回 ok:false（非抛错）', r.ok === false, JSON.stringify(r).slice(0, 200));
  ok('返回 met:false', r.met === false, JSON.stringify(r));
  ok('耗时接近 timeoutMs', elapsed >= 1400 && elapsed < 3000, `elapsed=${elapsed}ms`);
  ok('reason 含提示', typeof r.reason === 'string' && r.reason.length > 0, r.reason);
} catch (e) {
  ok('wait 超时不抛错', false, `抛了异常: ${e.message}`);
}

// ---------- 5. wait textGone（等文本消失，example.com 一直含 "Example Domain"，应超时） ----------
console.log('\n=== 5. wait textGone（应超时） ===');
try {
  const r = await invoke('wait', { textGone: 'Example Domain', timeoutMs: 1000, intervalMs: 200 }, {});
  ok('textGone 超时返回 ok:false', r.ok === false, JSON.stringify(r).slice(0, 200));
} catch (e) {
  ok('wait textGone', false, e.message);
}

// ---------- 6. wait selector（example.com 有 <a> 元素，应命中） ----------
console.log('\n=== 6. wait selector 命中 ===');
try {
  const r = await invoke('wait', { selector: 'a', timeoutMs: 2000, intervalMs: 200 }, {});
  ok('selector 命中 ok:true', r.ok === true, JSON.stringify(r).slice(0, 200));
  ok('selector 命中 met:true', r.met === true, JSON.stringify(r));
} catch (e) {
  ok('wait selector', false, e.message);
}

// ---------- 7. wait selectorGone（等 <a> 消失，应超时） ----------
console.log('\n=== 7. wait selectorGone（应超时） ===');
try {
  const r = await invoke('wait', { selectorGone: 'a', timeoutMs: 1000, intervalMs: 200 }, {});
  ok('selectorGone 超时 ok:false', r.ok === false, JSON.stringify(r).slice(0, 200));
} catch (e) {
  ok('wait selectorGone', false, e.message);
}

// ---------- 8. wait 无条件应报错 ----------
console.log('\n=== 8. wait 无条件应报错 ===');
try {
  const r = await invoke('wait', { timeoutMs: 500 }, {});
  ok('无条件返回错误', false, `应该报错但返回: ${JSON.stringify(r).slice(0,200)}`);
} catch (e) {
  ok('无条件抛错', /至少指定/.test(e.message), e.message);
}

console.log(`\n${'='.repeat(50)}`);
console.log(`验证结果: 通过 ${pass} / 失败 ${fail}`);
console.log(`${'='.repeat(50)}`);
process.exit(fail ? 1 : 0);
