import { redactValue } from './redact.mjs';

export function sanitizeError(error, tool = 'unknown') {
  const raw = String(error?.message || error || 'Unknown error');
  const { value } = redactValue(raw, { maxStringChars: 1000 });
  return { code: error?.code || 'HELM_TOOL_EXECUTION_FAILED', tool, message: value, ...(error?.needsPermission ? { needsPermission: true } : {}) };
}
