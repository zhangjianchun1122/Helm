/**
 * test-cold-start.mjs — 冷启动自愈链路验证
 *
 * 核心设计承诺：mcp-server 的 tools/call 在扩展未连接时不立即报错，
 * 而是 await waitForExtension(10000) 等扩展连上来，打破"报错→进程被回收→
 * 扩展来不及重连"的死锁。
 *
 * 本脚本验证：
 *   1. 扩展已连接时：invoke 立即成功（baseline）
 *   2. waitForExtension 的行为：
 *      - 已连接：立即 resolve(true)
 *      - 超时短等待：能在超时后 reject 带友好文案
 *   3. bridge /health 端点的 ext 字段反映真实连接状态
 *
 * 注意：真实"断线→重连"需要手动卸载/重载扩展，脚本无法自动模拟。
 *      这里测的是"等待机制"本身是否按设计工作。
 */

import { invoke, isExtensionConnected, waitForExtension, startOrAttach, getIsPrimary } from './bridge.mjs';
import http from 'node:http';

await startOrAttach();
await new Promise((r) => setTimeout(r, 600));

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail ? '— ' + detail : ''}`); }
}

const PORT = Number(process.env.BT_PORT || 8787);

// 取 /health 的 ext 字段（附属模式也能查主网关状态）
function getHealth() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

console.log('========== 冷启动自愈链路 ==========');

// 1. 当前连接状态（baseline）
console.log('\n--- 1. 当前连接状态探测 ---');
const connected = isExtensionConnected();
const health = await getHealth();
ok('isExtensionConnected 返回布尔', typeof connected === 'boolean');
ok('/health 返回 ext 字段', health && typeof health.ext === 'boolean', JSON.stringify(health).slice(0, 100));
ok('isExtensionConnected 与 /health.ext 一致', connected === health?.ext, `invoke=${connected} health=${health?.ext}`);

if (connected) {
  console.log('  （扩展已连接，走"已连接"路径验证）');

  console.log('\n--- 2. 已连接时 invoke 立即成功 ---');
  try {
    const r = await invoke('listTabs', {}, {});
    ok('已连接 invoke 立即返回数据', Array.isArray(r) && r.length >= 0, `返回 ${r?.length} 个标签`);
  } catch (e) {
    ok('已连接 invoke', false, e.message);
  }

  console.log('\n--- 3. 已连接时 waitForExtension 立即 resolve(true) ---');
  const t0 = Date.now();
  try {
    const r = await waitForExtension(5000);
    const elapsed = Date.now() - t0;
    ok('waitForExtension 返回 true', r === true);
    ok('立即返回（<500ms）', elapsed < 500, `elapsed=${elapsed}ms`);
  } catch (e) {
    ok('waitForExtension 已连接', false, e.message);
  }

  console.log('\n--- 4. /health 的 extSeenMs 反映活动时间 ---');
  ok('extSeenMs 为合理值', health.extSeenMs >= 0 && health.extSeenMs < 30000, `extSeenMs=${health.extSeenMs}ms`);
} else {
  console.log('  （扩展未连接，走"未连接"路径验证）');

  console.log('\n--- 2. 未连接时 invoke 友好报错 ---');
  try {
    await invoke('listTabs', {}, {});
    ok('未连接 invoke 应失败', false, '应该报错');
  } catch (e) {
    ok('未连接 invoke 抛友好错', /扩展未连接|未连接/.test(e.message), e.message.slice(0, 80));
  }

  console.log('\n--- 3. 未连接时 waitForExtension 短超时后 reject ---');
  const t0 = Date.now();
  try {
    await waitForExtension(800); // 短超时，避免脚本跑太久
    ok('未连接 waitForExtension 应 reject', false, '未 reject');
  } catch (e) {
    const elapsed = Date.now() - t0;
    ok('waitForExtension reject 带友好文案', /扩展未连接/.test(e.message), e.message.slice(0, 80));
    ok('reject 在超时后发生（>=600ms）', elapsed >= 600, `elapsed=${elapsed}ms（预期约800ms）`);
  }
}

console.log('\n--- 5. bridge 模式自检 ---');
ok('getIsPrimary 返回布尔', typeof getIsPrimary() === 'boolean', `isPrimary=${getIsPrimary()}`);
// 附属模式下 /health 仍可查（查的是主网关）
ok('/health 在附属模式也可查', health !== null, 'health 为 null');

console.log('\n--- 6. 真实断线场景说明 ---');
console.log('  真实"断线→重连"自愈需手动验证：');
console.log('    a) 卸载/重载扩展 → invoke 应等待而非立即崩');
console.log('    b) 关闭浏览器再开 → offscreen 重发 hello 夺回 extSocket');
console.log('    c) 杀 bridge 主进程 → 附属进程应 3s 后重连主网关');
console.log('  这些场景脚本无法自动模拟，依赖 waitForExtension 的等待逻辑兜底。');

console.log(`\n${'='.repeat(50)}`);
console.log(`验证结果: 通过 ${pass} / 失败 ${fail}`);
console.log(`${'='.repeat(50)}`);
process.exit(fail ? 1 : 0);
