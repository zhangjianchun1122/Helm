import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeUrl } from '../../security/url-sanitizer.mjs';

test('removes userinfo and fragment and redacts repeated sensitive query values', () => {
  const input = 'https://user:pass@example.com/path?token=HELM_TEST_SECRET_URL&ok=1&token=second#private';
  const output = sanitizeUrl(input);
  assert.equal(output, 'https://example.com/path?token=%5BREDACTED%5D&ok=1&token=%5BREDACTED%5D');
  assert.ok(!output.includes('HELM_TEST_SECRET_URL'));
  assert.ok(!output.includes('user:pass'));
});

test('leaves relative and non-url text usable while sanitizing URL-like query values', () => {
  assert.equal(sanitizeUrl('/download?signature=abc&name=report'), '/download?signature=%5BREDACTED%5D&name=report');
});

test('preserves schemes that have no // while still redacting their query values', () => {
  // create_tab 默认返回 about:blank；早前实现把它当相对路径，只剩 pathname "blank"
  assert.equal(sanitizeUrl('about:blank'), 'about:blank');
  assert.equal(sanitizeUrl('mailto:dev@example.com'), 'mailto:dev@example.com');
  assert.equal(sanitizeUrl('data:text/plain,hello'), 'data:text/plain,hello');
  assert.equal(
    sanitizeUrl('mailto:dev@example.com?subject=hi&token=HELM_TEST_SECRET_OPAQUE'),
    'mailto:dev@example.com?subject=hi&token=%5BREDACTED%5D',
  );
  // Windows 盘符不是 scheme，不能被当绝对 URL
  assert.equal(sanitizeUrl('/reports/q3?key=abc'), '/reports/q3?key=%5BREDACTED%5D');
});

test('fallback covers the complete shared sensitive key set', () => {
  const malformed = 'http://[invalid/path?id_token=a&client_secret=b&passwd=c&authorization=d#x';
  const output = sanitizeUrl(malformed);
  for (const secret of ['=a', '=b', '=c', '=d']) assert.ok(!output.includes(secret));
  assert.ok(!output.includes('#x'));
});
