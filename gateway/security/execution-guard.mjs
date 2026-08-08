import crypto from 'node:crypto';
import { redactValue } from './redact.mjs';
import { sanitizeError } from './errors.mjs';
import { writeAuditEvent } from './audit.mjs';
import { loadSecurityConfig } from './config.mjs';
import { evaluatePreExecutionPolicy } from './tool-policy.mjs';
import { enforceOutputBudget } from './output-budget.mjs';
import { recordSecurityReport, getSecurityStats } from './stats.mjs';
import { DETECTOR_NAMES } from './detectors.mjs';

const securityConfigPromise = loadSecurityConfig();

export async function executeToolSecure({ name, args = {}, transport, executeRaw, requestId = crypto.randomUUID(), auditPath }) {
  const started = Date.now();
  const config = await securityConfigPromise;
  const resolvedAuditPath = auditPath || (config.ok ? config.policy.audit.path : undefined);
  const auditOptions = config.ok ? config.policy.audit : {};
  const audit = (event) => writeAuditEvent(event, resolvedAuditPath, auditOptions);
  try {
    if (name !== 'confirm_execution') {
      const logicalRequestId = args?.confirmationRequestId || requestId;
      const decision = evaluatePreExecutionPolicy({ name, args, config, requestId: logicalRequestId });
      if (decision.action === 'block') {
        await audit({ requestId, transport, tool: name, outcome: 'blocked', durationMs: Date.now() - started, args, result: { ok: false }, security: {} });
        return { ok: false, error: { code: decision.code, tool: name, message: 'Tool execution blocked by security policy' } };
      }
      if (decision.action === 'confirm') {
        await audit({ requestId, transport, tool: name, outcome: 'confirmation_required', durationMs: Date.now() - started, args, result: { ok: false }, security: {} });
        return { ok: false, error: { ...decision, message: 'Explicit user confirmation is required before this tool can execute' } };
      }
    }
    const raw = await executeRaw();
    let boundedRaw = raw;
    if (name === 'get_snapshot' && raw && Array.isArray(raw.elements)) {
      const max = config.ok ? config.policy.context.maxSnapshotElements : 500;
      const limited = raw.elements.slice(0, max).map((element) => {
        if (!element?.attrs || !Object.prototype.hasOwnProperty.call(element.attrs, 'value')) return element;
        const descriptor = [element.attrs.type, element.attrs.name, element.attrs.id, element.attrs.autocomplete, element.attrs['aria-label'], element.attrs.placeholder].filter(Boolean).join(' ');
        const secret = /password|passwd|pwd|passcode|token|secret|one[-_. ]?time[-_. ]?code/i.test(descriptor);
        return { ...element, attrs: { ...element.attrs, value: secret ? '[REDACTED:SECRET_INPUT]' : '[REDACTED:INPUT]' } };
      });
      boundedRaw = { ...raw, elements: limited, elementCount: limited.length, truncated: raw.elements.length > max || !!raw.truncated };
    }
    if (name === 'get_text' && raw && typeof raw.text === 'string') {
      const max = config.ok ? config.policy.context.maxTextChars : 20000;
      if (raw.text.length > max) boundedRaw = { ...raw, text: raw.text.slice(0, max), charsRead: max, truncated: true, nextOffset: (raw.offset || 0) + max };
    }
    const redacted = redactValue(boundedRaw, config.ok ? { maxStringChars: config.policy.context.maxStringChars } : {});
    const budgeted = enforceOutputBudget(redacted.value, config.ok ? config.policy.context.maxToolResultChars : 200000);
    const value = budgeted.value;
    recordSecurityReport({ counts: redacted.report.counts, truncated: redacted.report.truncated > 0 || budgeted.truncated || !!boundedRaw?.truncated });
    if (value && typeof value === 'object' && (redacted.report.redacted || redacted.report.truncated || budgeted.truncated || boundedRaw?.truncated)) {
      value._helmSecurity = { redacted: redacted.report.redacted > 0, counts: redacted.report.counts, truncated: redacted.report.truncated > 0 || budgeted.truncated || !!boundedRaw?.truncated, policyVersion: 1 };
    }
    await audit({ requestId, transport, tool: name, outcome: 'success', durationMs: Date.now() - started, args, result: value, security: { ...redacted.report, truncated: redacted.report.truncated || budgeted.truncated } });
    return { ok: true, result: value };
  } catch (error) {
    const safeError = sanitizeError(error, name);
    await audit({ requestId, transport, tool: name, outcome: 'error', durationMs: Date.now() - started, args, result: { ok: false }, security: {} });
    return { ok: false, error: safeError };
  }
}

export async function getSecurityStatus() {
  const config = await securityConfigPromise;
  if (!config.ok) return { ok: false, mode: config.mode, code: config.code };
  return { ok: true, mode: config.policy.mode, version: config.policy.version, configHash: config.hash, source: config.source, detectors: DETECTOR_NAMES, stats: getSecurityStats() };
}
