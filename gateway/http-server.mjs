#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startOrAttach, isExtensionConnected } from './bridge.mjs';
import { TOOLS } from './tools-def.mjs';
import { executeTool } from './tool-executor.mjs';
import { loadSecurityConfig } from './security/index.mjs';

await startOrAttach();
const PORT = Number(process.env.HELM_HTTP_PORT || process.argv.find((arg) => arg.startsWith('--port='))?.split('=')[1] || 8788);
const LISTEN_HOST = (process.env.BT_HOST || '127.0.0.1') === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0';
let API_KEY = process.env.HELM_API_KEY || process.argv.find((arg) => arg.startsWith('--key='))?.split('=')[1];
if (!API_KEY) {
  API_KEY = crypto.randomBytes(12).toString('hex');
  const directory = path.join(process.env.APPDATA || os.homedir(), 'Helm');
  const keyPath = path.join(directory, 'http-api-key');
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(keyPath, API_KEY + '\n', { encoding: 'utf8', mode: 0o600 });
  console.error(`[http] 随机 token 已保存到 ${keyPath}（末四位 ${API_KEY.slice(-4)}）`);
}
const securityConfig = await loadSecurityConfig();

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return end(res, 204, null);
  if (req.url !== '/health' && req.headers.authorization?.replace(/^Bearer\s+/i, '') !== API_KEY) return end(res, 401, { error: 'Unauthorized' });
  if (req.method === 'GET' && req.url === '/health') return end(res, securityConfig.ok ? 200 : 503, { ok: securityConfig.ok, ext: isExtensionConnected(), security: securityConfig.ok ? { mode: securityConfig.policy.mode, version: securityConfig.policy.version, hash: securityConfig.hash } : { mode: securityConfig.mode, code: securityConfig.code } });
  if (req.method === 'GET' && req.url === '/v1/tools') return end(res, 200, { tools: TOOLS });
  if (req.method === 'POST' && req.url === '/v1/tools/call') {
    let body = ''; for await (const chunk of req) body += chunk;
    let parsed; try { parsed = JSON.parse(body); } catch { return end(res, 400, { error: 'Invalid JSON body' }); }
    if (!TOOLS.some((tool) => tool.name === parsed.name)) return end(res, 404, { error: `未知工具: ${parsed.name}` });
    return end(res, 200, await executeTool({ name: parsed.name, args: parsed.arguments || {}, transport: 'http', requestId: crypto.randomUUID() }));
  }
  return end(res, 404, { error: 'Not found' });
});

function end(res, status, data) { res.writeHead(status, data == null ? {} : { 'content-type': 'application/json' }); res.end(data == null ? '' : JSON.stringify(data)); }
server.listen(PORT, LISTEN_HOST, () => console.error(`[http] Helm HTTP 端点: http://${LISTEN_HOST}:${PORT}，token 末四位 ${API_KEY.slice(-4)}`));
