import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sanitizeToolArgs } from './redact.mjs';

function safeResultSummary(tool, result) {
  if (tool === 'screenshot') {
    const base64 = result?.base64 || '';
    return { ok: result?.ok, format: result?.format, bytes: Math.ceil(base64.length * 0.75), sha256: base64 ? crypto.createHash('sha256').update(base64).digest('hex') : undefined };
  }
  if (tool === 'read_file') return { ok: result?.ok, bytes: result?.bytes, truncated: result?.truncated };
  if (tool === 'save_file') return { ok: result?.ok, bytes: result?.bytes, append: result?.append };
  if (tool === 'download') return { ok: result?.ok, bytes: result?.bytes, via: result?.via };
  return { ok: result?.ok !== false };
}

export async function writeAuditEvent({ requestId, transport, tool, outcome, durationMs, args, result, security }, auditPath = path.resolve(process.env.HELM_AUDIT_PATH || 'audit-log.jsonl'), options = {}) {
  if (options.enabled === false) return { ok: true, skipped: true };
  const entry = {
    schemaVersion: 1, time: new Date().toISOString(), requestId, transport, tool, outcome, durationMs,
    args: sanitizeToolArgs(tool, args),
    result: safeResultSummary(tool, result),
    security: { redactionCounts: security?.counts || {}, truncated: !!security?.truncated },
  };
  try {
    await fsp.mkdir(path.dirname(auditPath), { recursive: true });
    await rotateAuditIfNeeded(auditPath, Buffer.byteLength(JSON.stringify(entry) + '\n'), options);
    await fsp.writeFile(auditPath, JSON.stringify(entry) + '\n', { encoding: 'utf8', flag: 'a', mode: 0o600 });
    return { ok: true };
  } catch {
    // Never include pending audit data in an error.
    return { ok: false, code: 'HELM_AUDIT_WRITE_FAILED' };
  }
}

export async function rotateAuditIfNeeded(auditPath, incomingBytes = 0, { maxFileBytes = Number(process.env.HELM_AUDIT_MAX_BYTES) || 10485760, retentionDays = Number(process.env.HELM_AUDIT_RETENTION_DAYS) || 30 } = {}) {
  let size = 0;
  try { size = (await fsp.stat(auditPath)).size; } catch {}
  if (size + incomingBytes > maxFileBytes && size > 0) {
    const rotated = `${auditPath}.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fsp.rename(auditPath, rotated);
  }
  const cutoff = Date.now() - retentionDays * 86400000;
  const directory = path.dirname(auditPath); const prefix = `${path.basename(auditPath)}.`;
  let entries = []; try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch {}
  for (const item of entries) {
    if (!item.isFile() || !item.name.startsWith(prefix)) continue;
    const candidate = path.join(directory, item.name);
    try { if ((await fsp.stat(candidate)).mtimeMs < cutoff) await fsp.unlink(candidate); } catch {}
  }
}
