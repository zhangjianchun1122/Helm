/**
 * 小工具：调用 reload_extension 让改动过的扩展代码生效。
 * 改了 extension/ 下的文件后跑一次即可，不需要手动去 chrome://extensions 点重载。
 *
 * 用法：node gateway/reload.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GATEWAY_DIR = process.env.HELM_GATEWAY_DIR
  || path.dirname(fileURLToPath(import.meta.url));
const proc = spawn('node', [path.join(GATEWAY_DIR, 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
let seq = 1;
function send(method, params, timeoutMs = 60000) {
  const id = seq++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { proc.stdout.off('data', onData); resolve({ __timeout: true }); }, timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (m.id === id) { clearTimeout(timer); proc.stdout.off('data', onData); resolve(m); return; }
        } catch { /* skip */ }
      }
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

await new Promise((r) => setTimeout(r, 1500));
await send('initialize', {
  protocolVersion: '2024-11-05', capabilities: {},
  clientInfo: { name: 'helm-reload', version: '1' },
});
const res = await send('tools/call', { name: 'reload_extension', arguments: {} });
const text = res?.result?.content?.[0]?.text || JSON.stringify(res);
console.log(text);

proc.kill();
await new Promise((r) => setTimeout(r, 300));
process.exit(res?.result?.isError ? 1 : 0);
