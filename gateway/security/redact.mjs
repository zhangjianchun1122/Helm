import crypto from 'node:crypto';
import { detectSensitiveText } from './detectors.mjs';
import { looksLikeUrlField, sanitizeUrl } from './url-sanitizer.mjs';

const SECRET_FIELDS = new Map([
  ['password', 'PASSWORD'], ['passwd', 'PASSWORD'], ['pwd', 'PASSWORD'], ['passcode', 'PASSWORD'],
  ['token', 'TOKEN'], ['accesstoken', 'TOKEN'], ['refreshtoken', 'TOKEN'], ['idtoken', 'TOKEN'],
  ['authorization', 'AUTHORIZATION'], ['auth', 'AUTHORIZATION'], ['bearer', 'AUTHORIZATION'],
  ['apikey', 'API_KEY'], ['secret', 'SECRET'], ['clientsecret', 'SECRET'],
  ['cookie', 'COOKIE'], ['setcookie', 'COOKIE'], ['sessionid', 'SESSION'],
  ['privatekey', 'PRIVATE_KEY'], ['signingkey', 'PRIVATE_KEY'],
]);

const normalizeField = (key) => String(key).toLowerCase().replace(/[-_.\s]/g, '');
const fieldType = (key) => SECRET_FIELDS.get(normalizeField(key));

function replaceText(text, report) {
  const detections = detectSensitiveText(text);
  let output = text;
  for (const d of detections.sort((a, b) => b.start - a.start)) {
    const matched = output.slice(d.start, d.end);
    let replacement = `[REDACTED:${d.type}]`;
    if (d.type === 'PHONE') replacement = `${matched.slice(0, 3)}****${matched.slice(-4)}`;
    if (d.type === 'BANK_CARD') {
      const digits = matched.replace(/\D/g, '');
      replacement = `${digits.slice(0, 4)}********${digits.slice(-4)}`;
    }
    if (d.type === 'EMAIL') {
      const [local, domain] = matched.split('@');
      replacement = `${local.slice(0, 1)}***@${domain}`;
    }
    output = output.slice(0, d.start) + replacement + output.slice(d.end);
    report.counts[d.type] = (report.counts[d.type] || 0) + 1;
    report.redacted++;
  }
  return output;
}

export function redactValue(input, options = {}) {
  const limits = { maxDepth: 12, maxNodes: 10000, maxArrayLength: 1000, maxStringChars: 20000, ...options };
  const report = { redacted: 0, counts: {}, truncated: 0 };
  const seen = new WeakSet();
  let nodes = 0;

  function visit(value, key, depth) {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) { report.truncated++; return '[TRUNCATED]'; }
    const secretType = key == null ? null : fieldType(key);
    if (secretType && value != null) {
      report.redacted++;
      report.counts[secretType] = (report.counts[secretType] || 0) + 1;
      return `[REDACTED:${secretType}]`;
    }
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
      let output = looksLikeUrlField(key) || /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? sanitizeUrl(value) : value;
      output = output.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizeUrl(url));
      output = replaceText(output, report);
      if (output.length > limits.maxStringChars) { output = output.slice(0, limits.maxStringChars) + '[TRUNCATED]'; report.truncated++; }
      return output;
    }
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayLength) report.truncated++;
      return value.slice(0, limits.maxArrayLength).map((item) => visit(item, null, depth + 1));
    }
    const output = {};
    for (const keyName of Object.keys(value)) {
      try { output[keyName] = visit(value[keyName], keyName, depth + 1); }
      catch { output[keyName] = '[UNAVAILABLE]'; }
    }
    return output;
  }
  return { value: visit(input, null, 0), report };
}

export function sanitizeToolArgs(tool, args = {}) {
  const { value } = redactValue(args);
  for (const key of ['confirmationId', 'confirmationRequestId']) if (key in value) value[key] = '[REDACTED:CONFIRMATION]';
  if (tool === 'fill') {
    value.value = '[REDACTED:INPUT]';
    value.valueLength = typeof args.value === 'string' ? args.value.length : 0;
  }
  if (tool === 'save_file') {
    value.content = '[REDACTED:CONTENT]';
    value.contentLength = typeof args.content === 'string' ? args.content.length : 0;
    value.contentSha256 = crypto.createHash('sha256').update(String(args.content ?? '')).digest('hex');
  }
  if (tool === 'eval') {
    value.code = '[REDACTED:CODE]';
    value.codeLength = typeof args.code === 'string' ? args.code.length : 0;
    value.codeSha256 = crypto.createHash('sha256').update(String(args.code ?? '')).digest('hex');
    if ('arg' in args) value.arg = '[REDACTED:ARG]';
  }
  if (tool === 'wait') {
    for (const key of ['text', 'textGone']) if (key in args) {
      value[key] = '[REDACTED:INPUT]';
      value[`${key}Length`] = typeof args[key] === 'string' ? args[key].length : 0;
    }
  }
  return value;
}
