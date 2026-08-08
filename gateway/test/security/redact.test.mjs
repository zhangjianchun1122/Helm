import test from 'node:test';
import assert from 'node:assert/strict';
import { redactValue, sanitizeToolArgs } from '../../security/redact.mjs';

test('recursively redacts sensitive fields, content and URLs without mutating input', () => {
  const secret = 'HELM_TEST_SECRET_OBJECT_4a3b2c1d';
  const input = {
    password: secret,
    nested: { authorization: `Bearer ${secret}` },
    url: `https://example.test/?access_token=${secret}#fragment`,
  };
  const before = structuredClone(input);
  const { value, report } = redactValue(input);
  assert.deepEqual(input, before);
  assert.ok(!JSON.stringify(value).includes(secret));
  assert.equal(value.password, '[REDACTED:PASSWORD]');
  assert.ok(report.redacted > 0);
});

test('handles circular objects and malicious getters', () => {
  const input = { ok: true };
  input.self = input;
  Object.defineProperty(input, 'bad', { enumerable: true, get() { throw new Error('HELM_TEST_SECRET_GETTER'); } });
  const { value } = redactValue(input);
  assert.equal(value.self, '[CIRCULAR]');
  assert.equal(value.bad, '[UNAVAILABLE]');
  assert.ok(!JSON.stringify(value).includes('HELM_TEST_SECRET_GETTER'));
});

test('tool-specific input summaries never retain payload content', () => {
  const secret = 'HELM_TEST_SECRET_INPUT_7e6d5c4b';
  assert.deepEqual(sanitizeToolArgs('fill', { ref: '12', value: secret }), {
    ref: '12', value: '[REDACTED:INPUT]', valueLength: secret.length,
  });
  const saved = sanitizeToolArgs('save_file', { path: 'x.txt', content: secret });
  assert.equal(saved.content, '[REDACTED:CONTENT]');
  assert.equal(saved.contentLength, secret.length);
  const evaluated = sanitizeToolArgs('eval', { code: `return '${secret}'`, arg: secret });
  assert.ok(!JSON.stringify(evaluated).includes(secret));
  assert.equal(evaluated.code, '[REDACTED:CODE]');
});

test('redaction is idempotent', () => {
  const input = { password: 'HELM_TEST_SECRET_IDEMPOTENT', url: 'https://example.test/?token=abc#fragment', text: 'Bearer ABCDEFGHIJKLMNOP' };
  const once = redactValue(input).value;
  const twice = redactValue(once).value;
  assert.deepEqual(twice, once);
});
