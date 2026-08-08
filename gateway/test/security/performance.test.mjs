import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { redactValue } from '../../security/redact.mjs';

function percentile95(values) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
}

test('complete 200 KB DLP stays within the documented P95 budget', () => {
  const input = { text: `${'public business text '.repeat(10000)} Bearer HELM_PERF_SECRET_1234567890` };
  for (let i = 0; i < 3; i++) redactValue(input);
  const samples = [];
  for (let i = 0; i < 20; i++) { const start = performance.now(); redactValue(input); samples.push(performance.now() - start); }
  assert.ok(percentile95(samples) < 30, `200 KB redactValue P95 was ${percentile95(samples).toFixed(2)}ms`);
});

test('500-element snapshot DLP stays within the documented P95 budget', () => {
  const snapshot = { elements: Array.from({ length: 500 }, (_, i) => ({ ref: String(i), tag: 'button', text: `Public action ${i}`, attrs: { id: `item-${i}` } })) };
  for (let i = 0; i < 3; i++) redactValue(snapshot);
  const samples = [];
  for (let i = 0; i < 20; i++) { const start = performance.now(); redactValue(snapshot); samples.push(performance.now() - start); }
  assert.ok(percentile95(samples) < 50, `500-element snapshot P95 was ${percentile95(samples).toFixed(2)}ms`);
});
