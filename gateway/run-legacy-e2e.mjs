#!/usr/bin/env node
/**
 * 隔离运行旧版真实 E2E：不读取或写入用户权限/策略文件。
 * 默认运行功能型脚本；加 --all 才包含安全专项 test-browser-security.mjs。
 * 直接 bridge 脚本只验证 SW/bridge 链路，不代表 MCP 安全门禁。
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MCP_OPEN_SCRIPTS = ['verify-e2e.mjs', 'test-integration.mjs', 'test-download-ref.mjs'];
const DIRECT_SCRIPTS = [
  'test-cold-start.mjs',
  'test-download-fallback.mjs',
  'test-error-propagation.mjs',
  'test-scroll.mjs',
  'test-stage1-batch.mjs',
  'test-wait-screenshot.mjs',
];
const SECURITY_SCRIPTS = ['test-browser-security.mjs'];
const FUNCTIONAL_SCRIPTS = [...MCP_OPEN_SCRIPTS, ...DIRECT_SCRIPTS];

function usage() {
  console.log(`用法:
  node run-legacy-e2e.mjs [脚本名 ...]
  node run-legacy-e2e.mjs --all

默认脚本（隔离 open 策略 + 临时项目权限）：
  ${FUNCTIONAL_SCRIPTS.join(', ')}

安全专项：
  test-browser-security.mjs（balanced + confirmation，使用 --all 或显式指定）`);
}

const requested = process.argv.slice(2);
if (requested.includes('--help') || requested.includes('-h')) {
  usage();
  process.exit(0);
}
const selectedNames = requested.includes('--all')
  ? [...FUNCTIONAL_SCRIPTS, ...SECURITY_SCRIPTS]
  : requested.filter((name) => !name.startsWith('--'));
const scripts = selectedNames.length ? selectedNames : FUNCTIONAL_SCRIPTS;
const known = new Set([...FUNCTIONAL_SCRIPTS, ...SECURITY_SCRIPTS]);
for (const name of scripts) {
  if (!known.has(name)) {
    console.error(`未知 legacy 脚本: ${name}`);
    usage();
    process.exit(2);
  }
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-legacy-e2e-'));
const permissionDir = path.join(tempRoot, '.zcode');
const permissionPath = path.join(permissionDir, 'helm-permissions.json');
const policyPath = path.join(tempRoot, 'security-policy.json');
const auditPath = path.join(tempRoot, 'audit.jsonl');
await fsp.mkdir(permissionDir, { recursive: true });
await fsp.writeFile(permissionPath, JSON.stringify({
  version: 1,
  allowed: { download: true, save_file: true },
}, null, 2), 'utf8');
await fsp.writeFile(policyPath, JSON.stringify({
  version: 1,
  mode: 'open',
  audit: { enabled: true },
}, null, 2), 'utf8');

function runScript(name) {
  const security = SECURITY_SCRIPTS.includes(name);
  const env = { ...process.env, HELM_AUDIT_PATH: auditPath };
  if (security) {
    delete env.HELM_SECURITY_POLICY;
    delete env.HELM_SECURITY_MODE;
  } else {
    env.HELM_SECURITY_POLICY = policyPath;
    delete env.HELM_SECURITY_MODE;
  }
  return new Promise((resolve) => {
    console.log(`\n=== ${name} (${security ? 'balanced confirmation' : 'isolated open + project permissions'}) ===`);
    const child = spawn(process.execPath, [path.join(ROOT, name)], {
      cwd: tempRoot,
      env,
      stdio: 'inherit',
    });
    child.on('error', (error) => resolve({ name, code: null, signal: null, error }));
    child.on('exit', (code, signal) => resolve({ name, code, signal }));
  });
}

let failures = 0;
const results = [];
try {
  for (const name of scripts) {
    const result = await runScript(name);
    results.push(result);
    if (result.code !== 0) failures++;
  }
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(60)}`);
console.log(`legacy E2E 汇总：通过 ${scripts.length - failures} / 失败 ${failures}`);
for (const result of results) {
  console.log(`  ${result.code === 0 ? '✓' : '✗'} ${result.name}: ${result.code == null ? result.error?.message : `exit ${result.code}${result.signal ? ` (${result.signal})` : ''}`}`);
}
console.log(`临时策略、项目权限和审计目录已清理`);
console.log(`${'='.repeat(60)}`);
process.exit(failures ? 1 : 0);
