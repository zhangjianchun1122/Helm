import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRMATION_TTL_MS, evaluatePreExecutionPolicy, confirmExecution } from '../../security/tool-policy.mjs';

const config = { ok: true, policy: { tools: { eval: { mode: 'confirm' }, screenshot: { mode: 'block' } } } };

test('confirmation binds tool, arguments and logical requestId and is consumed once', () => {
  const now = 1_000_000;
  const args = { code: 'return 1' };
  const first = evaluatePreExecutionPolicy({ name: 'eval', args, config, requestId: 'request-a', now });
  assert.equal(first.action, 'confirm');
  assert.equal(first.confirmationRequestId, 'request-a');
  const approved = confirmExecution(first.confirmationId, { now: now + 1 });
  const retryArgs = { ...args, confirmationId: approved.confirmationId, confirmationRequestId: approved.confirmationRequestId };
  assert.equal(evaluatePreExecutionPolicy({ name: 'eval', args: retryArgs, config, requestId: 'request-a', now: now + 2 }).action, 'allow');
  assert.equal(evaluatePreExecutionPolicy({ name: 'eval', args: retryArgs, config, requestId: 'request-a', now: now + 3 }).code, 'HELM_CONFIRMATION_INVALID_OR_EXPIRED');
});

test('confirmation rejects request replay and parameter tampering', () => {
  const now = 2_000_000;
  const first = evaluatePreExecutionPolicy({ name: 'eval', args: { code: 'return 1' }, config, requestId: 'request-original', now });
  const approved = confirmExecution(first.confirmationId, { now: now + 1 });
  const base = { confirmationId: approved.confirmationId, confirmationRequestId: approved.confirmationRequestId };
  assert.equal(evaluatePreExecutionPolicy({ name: 'eval', args: { code: 'return 1', ...base }, config, requestId: 'request-other', now: now + 2 }).code, 'HELM_CONFIRMATION_REQUEST_MISMATCH');
  assert.equal(evaluatePreExecutionPolicy({ name: 'eval', args: { code: 'return 2', ...base }, config, requestId: 'request-original', now: now + 2 }).code, 'HELM_CONFIRMATION_ARGUMENT_MISMATCH');
  assert.equal(evaluatePreExecutionPolicy({ name: 'screenshot', args: {}, config, requestId: 'screen', now }).action, 'block');
});

test('confirmation expires after exactly 60 seconds using a controlled clock', () => {
  const now = 3_000_000;
  assert.equal(CONFIRMATION_TTL_MS, 60_000);
  const first = evaluatePreExecutionPolicy({ name: 'eval', args: { code: 'return 1' }, config, requestId: 'expiring', now });
  assert.throws(() => confirmExecution(first.confirmationId, { now: now + CONFIRMATION_TTL_MS }), /HELM_CONFIRMATION_NOT_FOUND_OR_EXPIRED/);

  const second = evaluatePreExecutionPolicy({ name: 'eval', args: { code: 'return 1' }, config, requestId: 'expiring-2', now });
  const approved = confirmExecution(second.confirmationId, { now: now + CONFIRMATION_TTL_MS - 1 });
  const retry = { code: 'return 1', confirmationId: approved.confirmationId, confirmationRequestId: approved.confirmationRequestId };
  assert.equal(evaluatePreExecutionPolicy({ name: 'eval', args: retry, config, requestId: 'expiring-2', now: now + CONFIRMATION_TTL_MS }).code, 'HELM_CONFIRMATION_INVALID_OR_EXPIRED');
});
