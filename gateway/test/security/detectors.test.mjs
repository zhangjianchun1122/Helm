import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSensitiveText } from '../../security/detectors.mjs';

test('detects deterministic S3 secret formats without returning source text', () => {
  const samples = [
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'],
    ['AUTHORIZATION', 'Bearer HELM_TEST_SECRET_BEARER_9f1d8c7b6a5e4d3c'],
    ['PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nSEVMTV9URVNUX1NFQ1JFVA==\n-----END PRIVATE KEY-----'],
    ['API_KEY', 'ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD'],
    ['SECRET', 'client_secret=HELM_TEST_SECRET_NAMED_12345678'],
  ];
  for (const [type, value] of samples) {
    const found = detectSensitiveText(value);
    assert.ok(found.some((d) => d.type === type), `missing ${type}`);
    assert.ok(found.every((d) => !('value' in d) && !('match' in d)));
  }
});

test('does not classify ordinary business identifiers as secrets', () => {
  assert.deepEqual(detectSensitiveText('order-2026-08-08 customer-1042'), []);
});

test('detectors remain bounded on 200 KB adversarial near-matches', { timeout: 2000 }, () => {
  const input = `${'eyJ'.repeat(60000)}.${'A'.repeat(20000)}!`;
  const started = performance.now();
  detectSensitiveText(input);
  assert.ok(performance.now() - started < 1000);
});

test('detects planned personal data with bounded false positives', () => {
  const found = detectSensitiveText('联系 test.user@example.com 或 13812345678，身份证 11010519491231002X，卡号 4111 1111 1111 1111');
  assert.ok(found.some((item) => item.type === 'EMAIL'));
  assert.ok(found.some((item) => item.type === 'PHONE'));
  assert.ok(found.some((item) => item.type === 'NATIONAL_ID'));
  assert.ok(found.some((item) => item.type === 'BANK_CARD'));
  assert.ok(!detectSensitiveText('12345678901 order@example').some((item) => ['PHONE', 'EMAIL'].includes(item.type)));
  assert.ok(!detectSensitiveText('无效身份证 110105194912310021，无效卡号 4111 1111 1111 1112').some((item) => ['NATIONAL_ID', 'BANK_CARD'].includes(item.type)));
});
