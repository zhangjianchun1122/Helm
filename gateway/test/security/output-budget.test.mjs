import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceOutputBudget } from '../../security/output-budget.mjs';
import { redactValue } from '../../security/redact.mjs';

test('total output budget preserves structure and enforces a hard JSON limit', () => {
  const input = { ok: true, rows: Array.from({ length: 1000 }, (_, i) => ({ id: i, text: 'x'.repeat(100) })) };
  const result = enforceOutputBudget(input, 2000);
  assert.equal(result.truncated, true);
  assert.ok(JSON.stringify(result.value).length <= 2000);
  assert.equal(result.value.ok, true);
});

test('array, depth and node truncation are observable', () => {
  const array = redactValue([1, 2, 3], { maxArrayLength: 2 });
  assert.equal(array.report.truncated, 1);
  const deep = redactValue({ a: { b: { c: 1 } } }, { maxDepth: 1 });
  assert.ok(deep.report.truncated > 0);
  const nodes = redactValue({ a: 1, b: 2, c: 3 }, { maxNodes: 2 });
  assert.ok(nodes.report.truncated > 0);
});
