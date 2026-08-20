/**
 * verify-reload.mjs —— reload_extension 的真实浏览器验证
 *
 * 必须连着真实 Chrome 扩展跑（以附属模式连常驻 bridge）。验证三件事：
 *   1. bootId 变化。只看"能连上"会把没重载当成已重载——重载前后连接都是通的。
 *      bootId 存在 storage.session 里，SW 空闲回收再重建时不变，扩展重新加载才换新值。
 *   2. 扩展加载的 manifest 版本等于磁盘上的版本，证明确实重读了磁盘文件、
 *      而不只是重启了 Service Worker。这是"改动能自动生效"的判据。
 *   3. 连续两次重载不互相干扰，且重载后扩展立即可用、无需重试。
 *
 * 用法：node gateway/verify-reload.mjs
 * 退出码：0 全通过 / 1 有失败
 *
 * 注意：本脚本会重载扩展 3 次，会中断该扩展上进行中的操作。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 默认用已部署的网关副本；HELM_GATEWAY_DIR 可覆盖
const GATEWAY_DIR = process.env.HELM_GATEWAY_DIR
  || path.dirname(fileURLToPath(import.meta.url));
// 磁盘上的 manifest 版本，作为"改动是否生效"的对照
const MANIFEST_PATH = path.join(GATEWAY_DIR, '..', 'extension', 'manifest.json');
let diskVersion = null;
try {
  diskVersion = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')).version;
} catch (_) { /* 拿不到就跳过该断言 */ }

const proc = spawn('node', [path.join(GATEWAY_DIR, 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
let seq = 1100;

function send(method, params, timeoutMs = 60000) {
  const id = seq++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { proc.stdout.off('data', onData); resolve({ __timeout: true }); }, timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (m.id === id) { clearTimeout(timer); proc.stdout.off('data', onData); resolve(m); return; }
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

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  \u2713 ${n}`); } else { fail++; console.log(`  \u2717 ${n}${d ? ' \u2014 ' + d : ''}`); } };

await new Promise((r) => setTimeout(r, 1500));
await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reload-verify', version: '1' } });

const list = await send('tools/list');
const names = (list?.result?.tools || []).map((t) => t.name);
ok('工具清单含 reload_extension', names.includes('reload_extension'), `共 ${names.length} 个`);

console.log('\n=== 重载前：确认扩展已装上 bootId 能力 ===');
// 先做一次普通调用，确认扩展在线
const before = json(await call('list_tabs', {}));
ok('扩展在线（list_tabs 可用）', Array.isArray(before), JSON.stringify(before).slice(0, 120));

// 顺便记录一个可观测状态，用于判断重载是否真的重置了会话态
const tabForFrame = before?.find?.((t) => t.active)?.id;
if (tabForFrame != null) {
  await call('set_active_frame', { frameId: 12345, tabId: tabForFrame });
  const g = json(await call('get_active_frame', { tabId: tabForFrame }));
  ok('重载前已设 frame 作用域 12345', g?.activeFrameId === 12345, JSON.stringify(g));
}

console.log('\n=== 执行 reload_extension ===');
const t0 = Date.now();
const r = await call('reload_extension', {});
const out = json(r);
const wall = Date.now() - t0;
if (r.__timeout) {
  ok('reload_extension 返回', false, '脚本侧超时');
} else {
  ok('reload_extension 未报错', out?.ok === true, JSON.stringify(out).slice(0, 300));
  ok('bootId 发生变化（证明确实重新加载，而不只是重连）',
    !!out?.bootId && !!out?.previousBootId && out.bootId !== out.previousBootId,
    `previous=${out?.previousBootId} now=${out?.bootId}`);
  ok('verified 为 true（重载前取到了基线 bootId）', out?.verified === true, JSON.stringify(out?.note));
  // 最关键的一条：版本号只可能来自磁盘上的 manifest.json。
  // 报告的版本等于磁盘上的版本，才说明"改动能自动生效"，而不只是 SW 重启了一次。
  if (diskVersion) {
    ok(`扩展加载的是磁盘上的 manifest 版本 ${diskVersion}`, out?.version === diskVersion,
      `扩展报告 ${out?.version}，磁盘 ${diskVersion}`);
  } else {
    console.log('  - 跳过版本对照（读不到磁盘 manifest.json）');
  }
  console.log(`    网关报告 ${out?.elapsedMs}ms，脚本侧墙钟 ${wall}ms`);
}

console.log('\n=== 重载后：扩展立即可用 ===');
const after = json(await call('list_tabs', {}));
ok('重载后 list_tabs 立即可用（无需等待/重试）', Array.isArray(after), JSON.stringify(after).slice(0, 120));

if (tabForFrame != null) {
  const g2 = json(await call('get_active_frame', { tabId: tabForFrame }));
  // storage.session 在扩展重载时清空，frame 作用域应已重置
  ok('重载重置了 frame 作用域（storage.session 已清空）', g2?.activeFrameId === null, JSON.stringify(g2));
}

console.log('\n=== 连续两次重载不互相干扰 ===');
const r2 = json(await call('reload_extension', {}));
ok('第二次重载成功', r2?.ok === true, JSON.stringify(r2).slice(0, 200));
ok('第二次 bootId 又变了', !!r2?.bootId && r2.bootId !== out?.bootId,
  `上次=${out?.bootId} 这次=${r2?.bootId}`);
const after2 = json(await call('list_tabs', {}));
ok('第二次重载后仍可用', Array.isArray(after2));

console.log(`\n${'='.repeat(50)}`);
console.log(`reload_extension 验证: 通过 ${pass} / 失败 ${fail}`);
console.log(`${'='.repeat(50)}`);

proc.kill();
await new Promise((r) => setTimeout(r, 300));
process.exit(fail ? 1 : 0);
