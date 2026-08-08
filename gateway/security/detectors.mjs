const PATTERNS = [
  ['PRIVATE_KEY', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, 'pem-private-key', 'S3'],
  ['AUTHORIZATION', /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]{12,}/gi, 'authorization', 'S3'],
  ['JWT', /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}\b/g, 'jwt', 'S3'],
  ['API_KEY', /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,80})\b/g, 'known-key-prefix', 'S3'],
  ['SECRET', /\b(?:api[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|password|passwd|cookie|session[_-]?id)\s*[:=]\s*["']?[A-Za-z0-9+/_=.:-]{8,255}["']?/gi, 'named-secret-assignment', 'S3'],
  ['EMAIL', /(?<![\w.+-])[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,190}\.[A-Z]{2,24}(?![\w.-])/gi, 'email', 'S1'],
  ['PHONE', /(?<!\d)1[3-9]\d{9}(?!\d)/g, 'cn-mobile', 'S2'],
  ['NATIONAL_ID', /(?<!\d)\d{6}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?!\d)/g, 'cn-national-id', 'S3'],
  ['BANK_CARD', /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, 'bank-card-luhn', 'S3'],
];

function validLuhn(value) {
  const digits = value.replace(/[^\d]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0; let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit; double = !double;
  }
  return sum % 10 === 0;
}

function validChineseNationalId(value) {
  const id = value.toUpperCase();
  if (!/^\d{17}[0-9X]$/.test(id)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = '10X98765432';
  const sum = weights.reduce((total, weight, index) => total + Number(id[index]) * weight, 0);
  return checks[sum % 11] === id[17];
}

export function detectSensitiveText(input) {
  if (typeof input !== 'string' || !input) return [];
  const detections = [];
  for (const [type, pattern, detector, severity] of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of input.matchAll(pattern)) {
      if (type === 'BANK_CARD' && !validLuhn(match[0])) continue;
      if (type === 'NATIONAL_ID' && !validChineseNationalId(match[0])) continue;
      detections.push({ type, start: match.index, end: match.index + match[0].length, severity, detector });
    }
  }
  return mergeDetections(detections);
}

function mergeDetections(items) {
  const sorted = items.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const item of sorted) {
    const previous = out.at(-1);
    if (previous && item.start < previous.end) {
      if (item.end > previous.end) previous.end = item.end;
      continue;
    }
    out.push({ ...item });
  }
  return out;
}

export const DETECTOR_NAMES = Object.freeze(PATTERNS.map(([, , name]) => name));
export { validLuhn, validChineseNationalId };
