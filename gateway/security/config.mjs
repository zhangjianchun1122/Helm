import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MODES = new Set(['open', 'balanced', 'managed']);
const TOOL_MODES = new Set(['allow', 'sanitize', 'confirm', 'block']);

const DEFAULT_POLICY = {
  version: 1,
  mode: 'balanced',
  context: { maxStringChars: 20000, maxToolResultChars: 200000, maxSnapshotElements: 500, maxTextChars: 20000 },
  tools: {
    eval: { mode: 'confirm' }, screenshot: { mode: 'confirm' },
    get_snapshot: { mode: 'sanitize' }, get_text: { mode: 'sanitize' }, read_file: { mode: 'sanitize', maxBytes: 1048576 },
  },
  audit: { enabled: true, path: null, maxFileBytes: 10485760, retentionDays: 30 },
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && base?.[key] && typeof base[key] === 'object'
      ? deepMerge(base[key], value) : structuredClone(value);
  }
  return out;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validate(policy) {
  if (policy.version !== 1) throw new Error('HELM_SECURITY_POLICY_VERSION_UNSUPPORTED');
  if (!MODES.has(policy.mode)) throw new Error('HELM_SECURITY_POLICY_MODE_INVALID');
  for (const rule of Object.values(policy.tools || {})) if (!TOOL_MODES.has(rule?.mode)) throw new Error('HELM_SECURITY_TOOL_MODE_INVALID');
  for (const key of ['maxStringChars', 'maxToolResultChars', 'maxSnapshotElements', 'maxTextChars']) {
    if (!Number.isSafeInteger(policy.context?.[key]) || policy.context[key] <= 0) throw new Error(`HELM_SECURITY_LIMIT_INVALID_${key}`);
  }
  if (typeof policy.audit?.enabled !== 'boolean' || !Number.isSafeInteger(policy.audit?.maxFileBytes) || policy.audit.maxFileBytes <= 0 || !Number.isSafeInteger(policy.audit?.retentionDays) || policy.audit.retentionDays < 0) throw new Error('HELM_SECURITY_AUDIT_CONFIG_INVALID');
}

function finalizePolicy(policy, defaultAuditPath) {
  if (!policy.audit.path) policy.audit.path = defaultAuditPath;
  else policy.audit.path = path.resolve(String(policy.audit.path).replace(/%APPDATA%/gi, process.env.APPDATA || os.homedir()));
  return policy;
}

export async function loadSecurityConfig({ policyPath = process.env.HELM_SECURITY_POLICY, requestedMode = process.env.HELM_SECURITY_MODE } = {}) {
  const defaultPath = path.join(process.env.APPDATA || os.homedir(), 'Helm', 'security-policy.json');
  const defaultAuditPath = path.resolve(process.env.HELM_AUDIT_PATH || path.join(process.env.APPDATA || os.homedir(), 'Helm', 'audit-log.jsonl'));
  const resolvedPath = path.resolve(policyPath || defaultPath);
  let raw = null;
  try { raw = await fsp.readFile(resolvedPath, 'utf8'); }
  catch (error) {
    if (requestedMode === 'managed') return deepFreeze({ ok: false, mode: 'managed', code: 'HELM_SECURITY_POLICY_MISSING', path: resolvedPath });
    const policy = finalizePolicy(deepMerge(DEFAULT_POLICY, requestedMode ? { mode: requestedMode } : {}), defaultAuditPath);
    validate(policy);
    return deepFreeze({ ok: true, source: 'builtin', path: resolvedPath, hash: null, policy });
  }
  let parsedMode = requestedMode;
  try {
    const parsed = JSON.parse(raw);
    parsedMode = requestedMode || parsed?.mode;
    const policy = finalizePolicy(deepMerge(DEFAULT_POLICY, parsed), defaultAuditPath);
    if (requestedMode) policy.mode = requestedMode;
    validate(policy);
    if (policy.mode === 'managed') {
      policy.tools.eval = { mode: 'block' };
      if (policy.tools.screenshot?.mode === 'allow') policy.tools.screenshot = { mode: 'confirm' };
    }
    return deepFreeze({ ok: true, source: 'file', path: resolvedPath, hash: crypto.createHash('sha256').update(raw).digest('hex'), policy });
  } catch (error) {
    const mode = parsedMode === 'managed' ? 'managed' : 'balanced';
    if (mode === 'managed') return deepFreeze({ ok: false, mode, code: 'HELM_SECURITY_POLICY_INVALID', path: resolvedPath });
    return deepFreeze({ ok: true, source: 'builtin-fallback', warning: 'HELM_SECURITY_POLICY_INVALID', path: resolvedPath, hash: null, policy: finalizePolicy(deepMerge(DEFAULT_POLICY, {}), defaultAuditPath) });
  }
}

export { DEFAULT_POLICY };
