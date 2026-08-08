(function installHelmSourceGuard(root) {
  const SECRET_HINT = /(?:password|passwd|pwd|passcode|token|api[-_. ]?key|secret|authorization|cookie|session[-_. ]?id|private[-_. ]?key|one[-_. ]?time[-_. ]?code)/i;
  function descriptor(el) {
    return [el.type, el.autocomplete, el.name, el.id, el.getAttribute?.('aria-label'), el.placeholder].filter(Boolean).join(' ');
  }
  function sensitivity(el) {
    for (let node = el; node; node = node.parentElement) {
      const explicit = node.getAttribute?.('data-helm-sensitive');
      if (explicit === 'omit') return 'omit';
      if (explicit === 'redact' || explicit === 'mask') return explicit;
    }
    if (el.matches?.('input[type="password"]')) return 'password';
    if (SECRET_HINT.test(descriptor(el))) return 'secret';
    return null;
  }
  function safeText(el, maxChars = 160) {
    const ownSensitivity = sensitivity(el);
    if (ownSensitivity) return `[REDACTED:${ownSensitivity.toUpperCase()}]`;
    const limit = Math.max(1, Number(maxChars) || 160);
    const chunks = [];
    let length = 0;
    const stack = [...el.childNodes].reverse();
    while (stack.length && length < limit) {
      const node = stack.pop();
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.nodeValue || '';
        chunks.push(value.slice(0, limit - length));
        length += value.length;
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const explicit = node.getAttribute('data-helm-sensitive');
      if (explicit === 'omit') continue;
      if (explicit === 'redact' || explicit === 'mask') {
        const marker = `[REDACTED:${explicit.toUpperCase()}]`;
        chunks.push(marker.slice(0, limit - length)); length += marker.length;
        continue;
      }
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
    return chunks.join('').replace(/\s+/g, ' ').trim().slice(0, limit);
  }
  function safeTextRange(el, offset = 0, maxChars = 20000) {
    const ownSensitivity = sensitivity(el);
    if (ownSensitivity) {
      const marker = `[REDACTED:${ownSensitivity.toUpperCase()}]`;
      const text = marker.slice(offset, offset + maxChars);
      return { text, totalChars: marker.length, hasMore: offset + text.length < marker.length };
    }
    const start = Math.max(0, Number(offset) || 0);
    const limit = Math.max(1, Number(maxChars) || 20000);
    let logicalLength = 0; let previousWhitespace = true; let output = ''; let stopped = false;
    function append(raw) {
      for (const char of String(raw || '')) {
        const whitespace = /\s/u.test(char);
        if (whitespace && previousWhitespace) continue;
        previousWhitespace = whitespace;
        const normalized = whitespace ? ' ' : char;
        if (logicalLength >= start && output.length < limit + 1) output += normalized;
        logicalLength++;
        if (output.length >= limit + 1) { stopped = true; return; }
      }
    }
    const stack = [...el.childNodes].reverse();
    while (stack.length && !stopped) {
      const node = stack.pop();
      if (node.nodeType === Node.TEXT_NODE) { append(node.nodeValue); continue; }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const explicit = node.getAttribute('data-helm-sensitive');
      if (explicit === 'omit') continue;
      if (explicit === 'redact' || explicit === 'mask') { append(`[REDACTED:${explicit.toUpperCase()}]`); continue; }
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
    const hasMore = output.length > limit || stopped;
    return { text: output.slice(0, limit).replace(/\s+$/u, ''), totalChars: hasMore ? null : logicalLength, hasMore };
  }
  root.HelmSourceGuard = Object.freeze({ sensitivity, safeText, safeTextRange });
})(window);
