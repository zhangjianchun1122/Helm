import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../../tool-executor.mjs';

test('MCP and HTTP share equivalent paged read_file execution', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-executor-'));
  const file = path.join(dir, 'fixture.txt');
  await fsp.writeFile(file, '0123456789', 'utf8');
  const args = { path: file, offset: 2, maxBytes: 4 };
  const mcp = await executeTool({ name: 'read_file', args, transport: 'mcp', requestId: 'mcp-test', auditPath: path.join(dir, 'mcp.jsonl') });
  const http = await executeTool({ name: 'read_file', args, transport: 'http', requestId: 'http-test', auditPath: path.join(dir, 'http.jsonl') });
  assert.equal(mcp.result.content, '2345');
  assert.equal(mcp.result.truncated, true);
  assert.equal(mcp.result.nextOffset, 6);
  assert.deepEqual({ ...mcp.result, path: undefined }, { ...http.result, path: undefined });
  await fsp.rm(dir, { recursive: true, force: true });
});

test('read_file rejects binary content before it reaches context', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-executor-binary-'));
  const file = path.join(dir, 'fixture.bin'); await fsp.writeFile(file, Buffer.from([1, 0, 2]));
  const result = await executeTool({ name: 'read_file', args: { path: file }, transport: 'test', auditPath: path.join(dir, 'audit.jsonl') });
  assert.equal(result.ok, false);
  assert.equal(result.error.message, 'HELM_BINARY_FILE_NOT_SUPPORTED');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('read_file keeps UTF-8 character boundaries and handles EOF offsets', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-executor-utf8-'));
  const file = path.join(dir, 'utf8.txt'); await fsp.writeFile(file, '你好世界', 'utf8');
  const first = await executeTool({ name: 'read_file', args: { path: file, maxBytes: 4 }, transport: 'test', auditPath: path.join(dir, 'audit.jsonl') });
  assert.equal(first.result.content, '你');
  assert.equal(first.result.nextOffset, 3);
  const second = await executeTool({ name: 'read_file', args: { path: file, offset: first.result.nextOffset, maxBytes: 4 }, transport: 'test', auditPath: path.join(dir, 'audit.jsonl') });
  assert.equal(second.result.content, '好');
  assert.ok(!second.result.content.includes('�'));
  const eof = await executeTool({ name: 'read_file', args: { path: file, offset: 999, maxBytes: 4 }, transport: 'test', auditPath: path.join(dir, 'audit.jsonl') });
  assert.equal(eof.result.content, '');
  assert.equal(eof.result.truncated, false);
  assert.equal(eof.result.nextOffset, null);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('get_security_status exposes only safe policy metadata and counters', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-security-status-'));
  const result = await executeTool({ name: 'get_security_status', args: {}, transport: 'test', auditPath: path.join(dir, 'audit.jsonl') });
  assert.equal(result.ok, true);
  assert.equal(result.result.ok, true);
  assert.ok(Array.isArray(result.result.detectors));
  assert.ok(result.result.detectors.includes('bank-card-luhn'));
  assert.ok(!JSON.stringify(result).includes('contentPreview'));
  await fsp.rm(dir, { recursive: true, force: true });
});
