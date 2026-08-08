#!/usr/bin/env node
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-browser-e2e-'));
const auditPath = path.join(temp, 'audit.jsonl');
const privateKeyPath = path.join(temp, 'private.pem');
await fsp.writeFile(privateKeyPath, '-----BEGIN PRIVATE KEY-----\nHELM_E2E_FILE_CANARY_72ac91\n-----END PRIVATE KEY-----', 'utf8');
const fixture = await fsp.readFile(path.join(root, 'test/fixtures/sensitive-data.html'));
const web = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(fixture); });
await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
const port = web.address().port;
const probe = http.createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const httpPort = probe.address().port; await new Promise((resolve) => probe.close(resolve));
const environment = { ...process.env, HELM_AUDIT_PATH: auditPath };
const child = spawn(process.execPath, [path.join(root, 'mcp-server.mjs')], { cwd: root, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
const httpChild = spawn(process.execPath, [path.join(root, 'http-server.mjs'), `--port=${httpPort}`, '--key=e2e-key'], { cwd: root, env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.resume(); httpChild.stderr.resume();
let buffer = ''; const waiting = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk; let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line); const pending = waiting.get(message.id);
    if (pending) { clearTimeout(pending.timer); pending.resolve(message); waiting.delete(message.id); }
  }
});
let nextId = 1;
function call(name, args = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`timeout: ${name}`)); }, 15000);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}
function text(response) { return response?.result?.content?.[0]?.text || ''; }
async function httpCall(name, args = {}) {
  const response = await fetch(`http://127.0.0.1:${httpPort}/v1/tools/call`, { method: 'POST', headers: { authorization: 'Bearer e2e-key', 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
  return response.json();
}
async function waitForHttp() {
  for (let i = 0; i < 30; i++) {
    try { const response = await fetch(`http://127.0.0.1:${httpPort}/health`); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('HTTP gateway did not start');
}
const canaries = ['HELM_E2E_PASSWORD_CANARY_83f19a', 'HELM_E2E_NORMAL_INPUT_CANARY_4c27de', 'HELM_E2E_HIDDEN_TOKEN_CANARY_f03a21', 'HELM_E2E_OMIT_CANARY_d5412e', 'HELM_E2E_URL_CANARY_79ab31', 'HELM_E2E_IFRAME_PASSWORD_CANARY_02ce8b', 'HELM_E2E_FILE_CANARY_72ac91'];
function assertNoCanary(value, location) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const canary of canaries) if (serialized.includes(canary)) throw new Error(`${location} leaked ${canary}`);
}

try {
  await waitForHttp();
  const target = `http://127.0.0.1:${port}/?access_token=HELM_E2E_URL_CANARY_79ab31#private`;
  const navigate = await call('navigate', { url: target });
  const snapshot = await call('get_snapshot', { interactiveOnly: false, maxElements: 500 });
  assertNoCanary(text(navigate) + text(snapshot), 'MCP main frame');
  const parsed = JSON.parse(text(snapshot));
  if (parsed.elements.length > 500) throw new Error('snapshot maxElements exceeded');
  const long = parsed.elements.find((item) => item.attrs?.id === 'long-text');
  if (long) {
    const first = JSON.parse(text(await call('get_text', { ref: long.ref, maxChars: 1000 })));
    const second = JSON.parse(text(await call('get_text', { ref: long.ref, offset: first.nextOffset, maxChars: 1000 })));
    if (first.text.length > 1000 || !first.truncated || second.offset !== 1000) throw new Error('get_text pagination not enforced');
    const far = JSON.parse(text(await call('get_text', { ref: long.ref, offset: 210000, maxChars: 1000 })));
    if (far.text.length !== 1000 || far.offset !== 210000 || !far.truncated) throw new Error('get_text large-offset streaming pagination not active; reload the Helm extension');
  }

  const frames = JSON.parse(text(await call('list_frames')));
  const iframe = (Array.isArray(frames) ? frames : frames.frames || []).find((frame) => frame.frameId !== 0);
  if (!iframe) throw new Error('iframe fixture was not discovered');
  assertNoCanary(text(await call('get_snapshot', { frameId: iframe.frameId, interactiveOnly: false })), 'MCP iframe');

  for (const [name, args] of [['eval', { code: 'return "public-e2e"' }], ['screenshot', { format: 'jpeg', quality: 20 }]]) {
    const blocked = JSON.parse(text(await call(name, args)));
    if (blocked.code !== 'HELM_CONFIRMATION_REQUIRED') throw new Error(`${name} did not require confirmation`);
    const approval = JSON.parse(text(await call('confirm_execution', { confirmationId: blocked.confirmationId })));
    const executed = await call(name, { ...args, confirmationId: approval.confirmationId, confirmationRequestId: approval.confirmationRequestId });
    if (executed?.result?.isError) throw new Error(`${name} failed after confirmation`);
  }

  const httpNavigate = await httpCall('navigate', { url: target });
  assertNoCanary(httpNavigate, 'HTTP navigate');
  const httpSnapshot = await httpCall('get_snapshot', { interactiveOnly: false, maxElements: 500 });
  assertNoCanary(httpSnapshot, 'HTTP snapshot');
  if (!Array.isArray(httpSnapshot.result.elements) || httpSnapshot.result.elements.length > 500) throw new Error('HTTP snapshot budget differs from MCP');
  if (!parsed.elements.some((item) => item.attrs?.id === 'public-button') || !httpSnapshot.result.elements.some((item) => item.attrs?.id === 'public-button')) throw new Error('MCP/HTTP snapshots do not expose the same public fixture element');
  const httpFile = await httpCall('read_file', { path: privateKeyPath, maxBytes: 4096 });
  assertNoCanary(httpFile, 'HTTP read_file');
  if (!JSON.stringify(httpFile).includes('[REDACTED:PRIVATE_KEY]')) throw new Error('HTTP private key was not redacted');

  const audit = await fsp.readFile(auditPath, 'utf8');
  assertNoCanary(audit, 'audit');
  console.log('browser security MCP+HTTP E2E passed');
} finally {
  for (const pending of waiting.values()) clearTimeout(pending.timer);
  child.stdin.end(); child.kill(); httpChild.kill();
  if (typeof web.closeAllConnections === 'function') web.closeAllConnections();
  await new Promise((resolve) => web.close(resolve));
  await fsp.rm(temp, { recursive: true, force: true });
}
