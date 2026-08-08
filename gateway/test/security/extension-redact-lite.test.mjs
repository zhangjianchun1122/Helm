import test from 'node:test';
import assert from 'node:assert/strict';

await import('../../../extension/redact-lite.js');

test('extension display summaries never retain sensitive action payloads', () => {
  const canary = 'HELM_UI_CANARY_52bd91';
  const cases = [
    ['fill', { ref: '1', value: canary }],
    ['eval', { code: `return '${canary}'`, arg: canary }],
    ['save_file', { path: 'x', content: canary }],
    ['wait', { text: canary, textGone: canary }],
  ];
  for (const [action, args] of cases) assert.ok(!JSON.stringify(globalThis.HelmRedactLite.safeDisplayArgs(action, args)).includes(canary));
});

test('extension display errors redact deterministic secrets', () => {
  const error = globalThis.HelmRedactLite.safeDisplayError('failed Bearer HELM_UI_ERROR_CANARY_1234567890');
  assert.ok(!error.includes('HELM_UI_ERROR_CANARY'));
});
