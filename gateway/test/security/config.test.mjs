import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSecurityConfig } from '../../security/config.mjs';

test('managed mode fails closed when policy is missing or invalid', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-config-'));
  const missing = await loadSecurityConfig({ policyPath: path.join(dir, 'missing.json'), requestedMode: 'managed' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'HELM_SECURITY_POLICY_MISSING');
  const invalidPath = path.join(dir, 'invalid.json');
  await fsp.writeFile(invalidPath, '{invalid', 'utf8');
  const invalid = await loadSecurityConfig({ policyPath: invalidPath, requestedMode: 'managed' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'HELM_SECURITY_POLICY_INVALID');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('managed policy forces eval block and returns a deeply frozen snapshot', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-config-valid-'));
  const policyPath = path.join(dir, 'policy.json');
  await fsp.writeFile(policyPath, JSON.stringify({ version: 1, mode: 'managed', tools: { eval: { mode: 'allow' } } }), 'utf8');
  const config = await loadSecurityConfig({ policyPath });
  assert.equal(config.ok, true);
  assert.equal(config.policy.tools.eval.mode, 'block');
  assert.ok(Object.isFrozen(config.policy.context));
  await fsp.rm(dir, { recursive: true, force: true });
});

test('an invalid file that declares managed mode does not fall back to balanced', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-config-managed-invalid-'));
  const policyPath = path.join(dir, 'policy.json');
  await fsp.writeFile(policyPath, JSON.stringify({ version: 1, mode: 'managed', context: { maxSnapshotElements: 0 } }), 'utf8');
  const config = await loadSecurityConfig({ policyPath });
  assert.equal(config.ok, false);
  assert.equal(config.mode, 'managed');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('audit settings are validated and relative policy values resolve safely', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-config-audit-'));
  const policyPath = path.join(dir, 'policy.json');
  await fsp.writeFile(policyPath, JSON.stringify({ version: 1, mode: 'balanced', audit: { enabled: false, path: path.join(dir, 'custom.jsonl'), maxFileBytes: 12345, retentionDays: 7 } }), 'utf8');
  const config = await loadSecurityConfig({ policyPath });
  assert.equal(config.policy.audit.enabled, false);
  assert.equal(config.policy.audit.path, path.join(dir, 'custom.jsonl'));
  assert.equal(config.policy.audit.maxFileBytes, 12345);
  await fsp.rm(dir, { recursive: true, force: true });
});
