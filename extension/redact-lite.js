/* Extension-only display guard. Gateway security remains the authoritative DLP boundary. */
(function installHelmRedactLite(root) {
  function safeDisplayArgs(action, args = {}) {
    const out = {};
    for (const [key, value] of Object.entries(args)) {
      if (action === 'fill' && key === 'value') {
        out.value = '[REDACTED:INPUT]';
        out.valueLength = typeof value === 'string' ? value.length : 0;
      } else if (action === 'eval' && (key === 'code' || key === 'arg')) {
        out[key] = `[REDACTED:${key.toUpperCase()}]`;
        if (typeof value === 'string') out[`${key}Length`] = value.length;
      } else if (action === 'save_file' && key === 'content') {
        out.content = '[REDACTED:CONTENT]';
        out.contentLength = typeof value === 'string' ? value.length : 0;
      } else if (action === 'wait' && (key === 'text' || key === 'textGone')) {
        out[key] = '[REDACTED:INPUT]';
        out[`${key}Length`] = typeof value === 'string' ? value.length : 0;
      } else if (typeof value === 'string') {
        out[key] = value.length > 60 ? value.slice(0, 60) + '…' : value;
      } else if (value && typeof value === 'object') out[key] = '[OBJECT]';
      else out[key] = value;
    }
    return out;
  }
  function safeDisplayError(error) {
    return String(error || 'Unknown error')
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]{12,}/gi, '[REDACTED:AUTHORIZATION]')
      .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED:JWT]')
      .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, '[REDACTED:PRIVATE_KEY]')
      .slice(0, 200);
  }
  root.HelmRedactLite = Object.freeze({ safeDisplayArgs, safeDisplayError });
})(typeof self !== 'undefined' ? self : globalThis);
