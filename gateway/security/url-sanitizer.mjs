export const SENSITIVE_QUERY_KEYS = new Set([
  'token', 'access_token', 'refresh_token', 'id_token', 'code', 'key', 'api_key',
  'secret', 'client_secret', 'signature', 'sig', 'password', 'passwd', 'auth', 'authorization',
]);

function isSensitiveKey(key) {
  return SENSITIVE_QUERY_KEYS.has(String(key).toLowerCase().replace(/[-.\s]/g, '_'));
}

export function sanitizeUrl(input) {
  if (typeof input !== 'string' || !input) return input;
  const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
  try {
    const url = new URL(input, absolute ? undefined : 'https://helm.invalid');
    url.username = '';
    url.password = '';
    url.hash = '';
    const sanitizedParams = new URLSearchParams();
    for (const [key, value] of url.searchParams) {
      sanitizedParams.append(key, isSensitiveKey(key) ? '[REDACTED]' : value);
    }
    url.search = sanitizedParams.toString();
    return absolute ? url.href : `${url.pathname}${url.search}`;
  } catch {
    const escapedKeys = [...SENSITIVE_QUERY_KEYS].map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const fallbackPattern = new RegExp(`([?&](?:${escapedKeys})=)[^&#]*`, 'gi');
    return input.replace(fallbackPattern, '$1%5BREDACTED%5D').split('#')[0];
  }
}

export function looksLikeUrlField(key) {
  return /(?:^|_)(?:url|uri|href|frameurl)$/i.test(String(key).replace(/[-.\s]/g, '_'));
}
