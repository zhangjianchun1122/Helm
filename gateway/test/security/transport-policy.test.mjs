import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GATEWAY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(GATEWAY, '..', '..');
const MCP = path.join(ROOT, 'mcp-server.mjs');
const HTTP = path.join(ROOT, 'http-server.mjs');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForJsonLine(child, id, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error(`timeout waiting for MCP response ${id}`));
    }, timeoutMs);
    function onData(chunk) {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== id) continue;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(message);
        return;
      }
    }
    child.stdout.on('data', onData);
  });
}

async function waitForHttp(url) {
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(url);
      if (response.status === 503 || response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`HTTP server did not start: ${url}`);
}

test('managed policy failure has stable MCP JSON-RPC and HTTP 503 contracts', async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-policy-transport-'));
  const missingPolicy = path.join(temp, 'missing-policy.json');
  const env = {
    ...process.env,
    HELM_SECURITY_MODE: 'managed',
    HELM_SECURITY_POLICY: missingPolicy,
    HELM_AUDIT_PATH: path.join(temp, 'audit.jsonl'),
  };
  const mcp = spawn(process.execPath, [MCP], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'ignore'] });
  const httpPort = await freePort();
  const http = spawn(process.execPath, [HTTP, `--port=${httpPort}`, '--key=policy-test-key'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    await new Promise((resolve) => setTimeout(resolve, 700));
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
    const initialized = await waitForJsonLine(mcp, 1);
    assert.equal(initialized.result?.serverInfo?.name, 'helm');
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'click', arguments: { ref: '1' } } }) + '\n');
    const denied = await waitForJsonLine(mcp, 2);
    assert.equal(denied.error?.code, -32003);
    assert.equal(denied.error?.data?.code, 'HELM_POLICY_NOT_LOADED');

    const healthUrl = `http://127.0.0.1:${httpPort}/health`;
    await waitForHttp(healthUrl);
    const response = await fetch(`http://127.0.0.1:${httpPort}/v1/tools/call`, {
      method: 'POST',
      headers: { authorization: 'Bearer policy-test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'click', arguments: { ref: '1' } }),
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error?.code, 'HELM_POLICY_NOT_LOADED');
  } finally {
    mcp.stdin.end();
    mcp.kill();
    http.kill();
    await fsp.rm(temp, { recursive: true, force: true });
  }
});
