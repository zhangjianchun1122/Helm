import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rotateAuditIfNeeded, writeAuditEvent } from '../../security/audit.mjs';

test('rotates oversized audit logs and only cleans matching expired rotations', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-audit-'));
  const audit = path.join(dir, 'audit-log.jsonl');
  await fsp.writeFile(audit, 'x'.repeat(20));
  const unrelated = path.join(dir, 'keep.txt'); await fsp.writeFile(unrelated, 'keep');
  const expired = `${audit}.expired`; await fsp.writeFile(expired, 'old');
  const old = new Date(Date.now() - 40 * 86400000); await fsp.utimes(expired, old, old);
  await rotateAuditIfNeeded(audit, 10, { maxFileBytes: 25, retentionDays: 30 });
  assert.equal(await fsp.readFile(unrelated, 'utf8'), 'keep');
  const names = await fsp.readdir(dir);
  assert.ok(names.some((name) => name.startsWith('audit-log.jsonl.')));
  assert.ok(!names.includes('audit-log.jsonl.expired'));
  await fsp.rm(dir, { recursive: true, force: true });
});

test('audit policy can disable writes and never stores confirmation capabilities', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-audit-policy-'));
  const audit = path.join(dir, 'audit.jsonl');
  const skipped = await writeAuditEvent({ requestId: 'r', transport: 'test', tool: 'eval', outcome: 'blocked', durationMs: 1, args: { confirmationId: 'capability-secret', confirmationRequestId: 'logical-secret', code: 'return 1' }, result: {}, security: {} }, audit, { enabled: false });
  assert.equal(skipped.skipped, true);
  await assert.rejects(() => fsp.stat(audit));
  await writeAuditEvent({ requestId: 'r', transport: 'test', tool: 'eval', outcome: 'blocked', durationMs: 1, args: { confirmationId: 'capability-secret', confirmationRequestId: 'logical-secret', code: 'return 1' }, result: {}, security: {} }, audit, { enabled: true, maxFileBytes: 10000, retentionDays: 30 });
  const content = await fsp.readFile(audit, 'utf8');
  assert.ok(!content.includes('capability-secret'));
  assert.ok(!content.includes('logical-secret'));
  await fsp.rm(dir, { recursive: true, force: true });
});
