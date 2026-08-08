function jsonLength(value) {
  try { return JSON.stringify(value).length; } catch { return Infinity; }
}

export function enforceOutputBudget(input, maxChars = 200000) {
  const limit = Math.max(256, Number(maxChars) || 200000);
  if (jsonLength(input) <= limit) return { value: input, truncated: false };
  let remaining = Math.max(32, limit - 256);

  function take(value) {
    if (remaining <= 16) return '[TRUNCATED]';
    if (value == null || typeof value === 'boolean' || typeof value === 'number') {
      const size = jsonLength(value); remaining -= size; return value;
    }
    if (typeof value === 'string') {
      const allowed = Math.max(0, remaining - 16);
      const output = value.length <= allowed ? value : value.slice(0, allowed) + '[TRUNCATED]';
      remaining -= jsonLength(output);
      return output;
    }
    if (Array.isArray(value)) {
      const output = []; remaining -= 2;
      for (const item of value) {
        if (remaining <= 32) { output.push('[TRUNCATED]'); break; }
        output.push(take(item)); remaining -= 1;
      }
      return output;
    }
    if (value && typeof value === 'object') {
      const output = {}; remaining -= 2;
      for (const key of Object.keys(value)) {
        const keyCost = jsonLength(key) + 2;
        if (remaining <= keyCost + 16) { output._truncated = true; break; }
        remaining -= keyCost;
        output[key] = take(value[key]);
      }
      return output;
    }
    return '[UNAVAILABLE]';
  }

  let value = take(input);
  if (jsonLength(value) > limit) value = { data: '[TRUNCATED:OUTPUT_BUDGET]', _truncated: true };
  return { value, truncated: true };
}
