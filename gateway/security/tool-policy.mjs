import crypto from 'node:crypto';

const pending = new Map();
const approved = new Map();
export const CONFIRMATION_TTL_MS = 60 * 1000;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((k) => !['confirmationId', 'confirmationRequestId'].includes(k)).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(tool, args) {
  return crypto.createHash('sha256').update(`${tool}\n${canonical(args)}`).digest('hex');
}

function cleanup(now) {
  for (const store of [pending, approved]) for (const [id, item] of store) if (item.expiresAt <= now) store.delete(id);
}

export function evaluatePreExecutionPolicy({ name, args, config, requestId, now = Date.now() }) {
  cleanup(now);
  if (!config.ok) return { action: 'block', code: config.code || 'HELM_SECURITY_POLICY_UNAVAILABLE' };
  const mode = config.policy.tools?.[name]?.mode || 'allow';
  if (mode === 'block') return { action: 'block', code: 'HELM_TOOL_BLOCKED_BY_POLICY' };
  if (mode !== 'confirm') return { action: 'allow' };
  const token = args?.confirmationId;
  const item = token && approved.get(token);
  if (token) {
    if (!item) return { action: 'block', code: 'HELM_CONFIRMATION_INVALID_OR_EXPIRED' };
    if (item.requestId !== requestId) return { action: 'block', code: 'HELM_CONFIRMATION_REQUEST_MISMATCH' };
    if (item.tool !== name || item.digest !== digest(name, args)) return { action: 'block', code: 'HELM_CONFIRMATION_ARGUMENT_MISMATCH' };
    approved.delete(token);
    return { action: 'allow', confirmationScope: 'once', argsDigest: item.digest, expiresAt: item.expiresAt };
  }
  const confirmationId = crypto.randomUUID();
  const expiresAt = now + CONFIRMATION_TTL_MS;
  pending.set(confirmationId, { digest: digest(name, args), tool: name, requestId, expiresAt });
  return { action: 'confirm', code: 'HELM_CONFIRMATION_REQUIRED', confirmationId, confirmationRequestId: requestId, tool: name, expiresAt: new Date(expiresAt).toISOString() };
}

export function confirmExecution(confirmationId, { now = Date.now() } = {}) {
  cleanup(now);
  const item = pending.get(confirmationId);
  if (!item) throw new Error('HELM_CONFIRMATION_NOT_FOUND_OR_EXPIRED');
  pending.delete(confirmationId);
  approved.set(confirmationId, item);
  return { ok: true, tool: item.tool, confirmationId, confirmationRequestId: item.requestId, expiresAt: new Date(item.expiresAt).toISOString() };
}
