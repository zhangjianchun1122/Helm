/**
 * test-error-propagation.mjs — 回归测试：验证 dispatchToFrame 修复后，
 * 所有依赖 ref 的工具在传失效 ref 时都正确抛错（而非静默返回 ok）。
 *
 * 背景：之前 dispatchToFrame 只检查外层 res.ok，dom-agent 内部 {ok:false} 被当成功返回。
 * 修复后应解包 data 再查 data.ok。本测试遍历所有 ref 工具验证错误传播。
 *
 * 前提：bridge 主模式运行，扩展已加载，已打开一个普通页面。
 */

import { invoke, startOrAttach } from './bridge.mjs';

await startOrAttach();
await new Promise((r) => setTimeout(r, 600));

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail ? '— ' + detail : ''}`); }
}

// 失效 ref（999999 几乎不可能存在）
const BAD_REF = '999999';

// 先导航到 example.com 确保有可操作的普通页面
console.log('导航到 example.com...');
try {
  await invoke('navigate', { url: 'https://example.com' }, {});
  await new Promise((r) => setTimeout(r, 2000));
  ok('导航完成', true);
} catch (e) { ok('导航', false, e.message); process.exit(1); }

console.log('\n========== 回归：失效 ref 必须抛错 ==========');

// 所有依赖 ref 的工具，传 BAD_REF 应抛错
// 注意：invoke 直调用 SW 的 action 名（驼峰）和参数结构，非 MCP 工具名
//   - action 名：getText 非 get_text；scroll 的 ref 要包在 options 里
//   - 这与 MCP tools/call 经 mapToolToAction 的路径不同，但测的是 SW 路由的错误传播
const refTools = [
  ['click',       { ref: BAD_REF }],
  ['click',       { ref: BAD_REF, button: 'right' }],
  ['fill',        { ref: BAD_REF, value: 'x' }],
  ['getText',     { ref: BAD_REF }],  // action 名是 getText 非 get_text
  ['hover',       { ref: BAD_REF }],
  ['scroll',      { options: { ref: BAD_REF } }],  // ref 包在 options 里
  ['drag',        { fromRef: BAD_REF, toRef: '1' }], // fromRef 失效
  ['drag',        { fromRef: '1', toRef: BAD_REF }], // toRef 失效（需先有有效 ref）
];

for (const [action, args] of refTools) {
  const label = `${action} ${JSON.stringify(args)}`;
  try {
    const r = await invoke(action, args, {});
    // 检查是否真的抛错——如果返回了带 ok:false 的对象而不抛，说明 bug 仍在
    if (r && r.ok === false && r.error) {
      ok(`${label} 正确抛错（带 error）`, true, r.error);
    } else {
      ok(`${label} 应抛错但返回了结果`, false, JSON.stringify(r).slice(0, 150));
    }
  } catch (e) {
    ok(`${label} 正确抛错`, true, e.message.slice(0, 80));
  }
}

console.log('\n========== 非 ref 工具的错误路径 ==========');

// scroll 未知 direction（不依赖 ref，走 doScroll 的分支错误）
try {
  await invoke('scroll', { options: { direction: 'sideways' } }, {});
  ok('scroll 未知 direction 应抛错', false, '未抛错');
} catch (e) {
  ok('scroll 未知 direction 抛错', /未知 direction/.test(e.message), e.message.slice(0, 80));
}

// scroll 无参（默认 down，应成功，不报错）
try {
  const r = await invoke('scroll', { options: {} }, {});
  ok('scroll 无参默认 down 成功', r.ok === true, JSON.stringify(r).slice(0, 80));
} catch (e) {
  ok('scroll 无参默认 down', false, e.message);
}

console.log('\n========== 对照组：有效 ref 应成功（验证不是误报） ==========');
try {
  const snap = await invoke('snapshot', { options: { interactiveOnly: true } }, {});
  const a = (snap.elements || []).find((e) => e.tag === 'a');
  if (!a) {
    ok('找到有效 <a> 元素做对照', false, 'example.com 无 <a>');
  } else {
    const r = await invoke('getText', { ref: a.ref }, {});
    ok('有效 ref getText 成功', r.ok === true, JSON.stringify(r).slice(0, 80));
    const h = await invoke('hover', { ref: a.ref }, {});
    ok('有效 ref hover 成功', h.ok === true, JSON.stringify(h).slice(0, 80));
  }
} catch (e) {
  ok('对照组有效 ref', false, e.message);
}

console.log(`\n${'='.repeat(50)}`);
console.log(`验证结果: 通过 ${pass} / 失败 ${fail}`);
console.log(`${'='.repeat(50)}`);
process.exit(fail ? 1 : 0);
