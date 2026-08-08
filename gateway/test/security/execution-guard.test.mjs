import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeToolSecure } from '../../security/execution-guard.mjs';
import { confirmExecution } from '../../security/tool-policy.mjs';

test('secure execution removes canaries from returned data and audit output', async () => {
  const canary = 'HELM_TEST_SECRET_EXECUTION_91a2b3c4';
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-security-'));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    const auditPath = path.join(dir, 'audit.jsonl');
    const result = await executeToolSecure({
      name: 'read_file', args: { path: 'fixture.txt' }, transport: 'test', requestId: 'test-request',
      auditPath,
      executeRaw: async () => ({ ok: true, content: `Bearer ${canary}`, url: `https://example.test/?token=${canary}#x` }),
    });
    assert.equal(result.ok, true);
    assert.ok(!JSON.stringify(result).includes(canary));
    assert.ok(!(await fsp.readFile(auditPath, 'utf8')).includes(canary));
  } finally {
    process.chdir(previous);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('secure errors remove secrets and URL credentials', async () => {
  const canary = 'HELM_TEST_SECRET_ERROR_01f2e3d4';
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-security-error-'));
  const result = await executeToolSecure({
    name: 'navigate', args: {}, transport: 'test', requestId: 'error-request',
    auditPath: path.join(dir, 'audit.jsonl'),
    executeRaw: async () => { throw new Error(`failed https://user:${canary}@example.test/?access_token=${canary}#x`); },
  });
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes(canary));
  assert.ok(!(await fsp.readFile(path.join(dir, 'audit.jsonl'), 'utf8')).includes(canary));
  await fsp.rm(dir, { recursive: true, force: true });
});

test('snapshot guard removes input values even from a stale extension', async () => {
  const canary = 'HELM_TEST_SECRET_STALE_EXTENSION';
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-security-snapshot-'));
  const result = await executeToolSecure({
    name: 'get_snapshot', args: {}, transport: 'test', auditPath: path.join(dir, 'audit.jsonl'),
    executeRaw: async () => ({ elements: [
      { tag: 'input', attrs: { type: 'password', value: canary } },
      { tag: 'input', attrs: { type: 'text', value: canary } },
    ] }),
  });
  assert.ok(!JSON.stringify(result).includes(canary));
  await fsp.rm(dir, { recursive: true, force: true });
});

test('eval and screenshot require parameter-bound confirmation before raw execution', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-security-confirm-'));
  for (const [name, args] of [['eval', { code: 'return 1' }], ['screenshot', { format: 'png' }]]) {
    let executed = false;
    const logicalRequestId = `${name}-request`;
    const first = await executeToolSecure({ name, args, transport: 'test', requestId: logicalRequestId, auditPath: path.join(dir, `${name}.jsonl`), executeRaw: async () => { executed = true; return { ok: true }; } });
    assert.equal(first.error.code, 'HELM_CONFIRMATION_REQUIRED');
    assert.equal(executed, false);
    confirmExecution(first.error.confirmationId);
    const second = await executeToolSecure({ name, args: { ...args, confirmationId: first.error.confirmationId, confirmationRequestId: first.error.confirmationRequestId }, transport: 'test', requestId: 'transport-retry-id', auditPath: path.join(dir, `${name}.jsonl`), executeRaw: async () => { executed = true; return { ok: true }; } });
    assert.equal(second.ok, true);
    assert.equal(executed, true);
  }
  await fsp.rm(dir, { recursive: true, force: true });
});
