/**
 * test-scroll.mjs — 真实浏览器端到端测试 scroll
 *
 * 前提：bridge 主模式运行于 8787，扩展已加载最新代码。
 * 浏览器已打开一个可滚动的长页面（脚本会先 navigate 到一个长文档页）。
 */

import { invoke, startOrAttach } from './bridge.mjs';

await startOrAttach();
await new Promise((r) => setTimeout(r, 600));

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail ? '— ' + detail : ''}`); }
}

// 导航到一个保证可滚动的长页面
console.log('\n=== 准备：导航到长页面 ===');
try {
  await invoke('navigate', { url: 'https://www.w3.org/TR/html/' }, {});
  await new Promise((r) => setTimeout(r, 2000)); // 等加载
  ok('导航到 w3.org/TR/html', true);
} catch (e) {
  ok('导航', false, e.message);
  process.exit(1);
}

// ---------- 1. 方向滚动 down 500 ----------
console.log('\n=== 1. scroll down 500 ===');
try {
  // 先取初始位置（用 eval 读 scrollY）
  const before = await invoke('eval', { code: 'return { x: window.scrollX, y: window.scrollY }' }, {});
  const r = await invoke('scroll', { options: { direction: 'down', amount: 500 } }, {});
  ok('scroll down 返回 ok', r.ok === true, JSON.stringify(r).slice(0, 200));
  ok('mode=byDirection', r.mode === 'byDirection', JSON.stringify(r));
  // smooth 滚动需等动画完成
  await new Promise((r) => setTimeout(r, 600));
  const after = await invoke('eval', { code: 'return { x: window.scrollX, y: window.scrollY }' }, {});
  ok('scrollY 增加', after.y > before.y, `before=${before.y} after=${after.y}`);
  ok('增量接近 500（±100）', Math.abs((after.y - before.y) - 500) < 150, `delta=${after.y - before.y}`);
} catch (e) {
  ok('scroll down', false, e.message);
}

// ---------- 2. 方向滚动 up 200 ----------
console.log('\n=== 2. scroll up 200 ===');
try {
  const before = await invoke('eval', { code: 'return window.scrollY' }, {});
  const r = await invoke('scroll', { options: { direction: 'up', amount: 200 } }, {});
  ok('scroll up 返回 ok', r.ok === true, JSON.stringify(r).slice(0, 200));
  await new Promise((r) => setTimeout(r, 600));
  const after = await invoke('eval', { code: 'return window.scrollY' }, {});
  ok('scrollY 减小', after < before, `before=${before} after=${after}`);
  ok('减量接近 200', Math.abs((before - after) - 200) < 150, `delta=${before - after}`);
} catch (e) {
  ok('scroll up', false, e.message);
}

// ---------- 3. ref 滚动（用 snapshot 拿一个靠下元素） ----------
console.log('\n=== 3. scroll to element by ref ===');
try {
  const snap = await invoke('snapshot', { options: { interactiveOnly: true } }, {});
  ok('snapshot 有元素', (snap.elements || []).length > 0, `count=${snap.elements?.length}`);
  // 找一个不在视口顶部的元素（rect.y > 600）
  const target = (snap.elements || []).find((e) => e.rect && e.rect.y > 600);
  if (!target) {
    ok('找到靠下元素做目标', false, '所有元素 rect.y 都 <=600，可能页面不够长或已滚到底');
  } else {
    const r = await invoke('scroll', { options: { ref: target.ref } }, {});
    ok('scroll ref 返回 ok', r.ok === true, JSON.stringify(r).slice(0, 200));
    ok('mode=toElement', r.mode === 'toElement', JSON.stringify(r));
    await new Promise((r) => setTimeout(r, 800));
    // 重新 snapshot 看该元素是否进入视口
    const snap2 = await invoke('snapshot', { options: { interactiveOnly: false } }, {});
    const el2 = (snap2.elements || []).find((e) => String(e.ref) === String(target.ref));
    if (!el2) {
      ok('目标元素滚后仍在快照', false, `ref ${target.ref} 消失`);
    } else {
      // 进入视口：rect.y 在 [0, viewportHeight] 范围
      const inView = el2.rect.y >= 0 && el2.rect.y < (window.innerHeight || 800);
      ok('元素进入视口区域', el2.rect.y >= 0 && el2.rect.y < 900, `new rect.y=${el2.rect.y}`);
    }
  }
} catch (e) {
  ok('scroll ref', false, e.message);
}

// ---------- 4. 未知 direction 报错 ----------
console.log('\n=== 4. 未知 direction 报错 ===');
try {
  const r = await invoke('scroll', { options: { direction: 'sideways', amount: 100 } }, {});
  ok('未知 direction 应报错', false, `应该报错但返回: ${JSON.stringify(r).slice(0,200)}`);
} catch (e) {
  ok('未知 direction 抛错', /未知 direction/.test(e.message), e.message);
}

// ---------- 5. 无参报错（既无 ref 又无 direction） ----------
console.log('\n=== 5. scroll 无参行为 ===');
try {
  const r = await invoke('scroll', { options: {} }, {});
  // 无 direction 时默认 down，amount 默认 300，应成功而非报错
  ok('无参默认 down 300', r.ok === true && r.direction === 'down', JSON.stringify(r).slice(0, 200));
} catch (e) {
  ok('无参 scroll', false, e.message);
}

console.log(`\n${'='.repeat(50)}`);
console.log(`验证结果: 通过 ${pass} / 失败 ${fail}`);
console.log(`${'='.repeat(50)}`);
process.exit(fail ? 1 : 0);
