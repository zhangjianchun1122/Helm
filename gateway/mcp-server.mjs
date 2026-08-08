#!/usr/bin/env node
import { startOrAttach } from './bridge.mjs';
import { TOOLS } from './tools-def.mjs';
import { executeTool } from './tool-executor.mjs';

await startOrAttach();
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'helm', version: '0.1.0' };

process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handleMessage(line).catch(() => {});
  }
});
process.stdin.on('end', () => process.exit(0));

async function handleMessage(line) {
  let request;
  try { request = JSON.parse(line); }
  catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const { id, method, params } = request;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
  if (method === 'notifications/initialized') return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method !== 'tools/call') return send({ jsonrpc: '2.0', id, error: { code: -32601, message: '方法不存在' } });

  const { name, arguments: args = {} } = params || {};
  if (!TOOLS.some((tool) => tool.name === name)) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `未知工具: ${name}` } });
  const execution = await executeTool({ name, args, transport: 'mcp', requestId: String(id) });
  if (!execution.ok) return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(execution.error) }], isError: true } });
  const data = execution.result;
  return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] } });
}

function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
console.error('[mcp] helm MCP server 已启动 (stdio)');
