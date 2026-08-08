import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { invoke, isExtensionConnected, waitForExtension } from './bridge.mjs';
import { mapToolToAction, isLocalTool } from './tools-def.mjs';
import { checkPermission, setPermission, revokePermission, getPermissions, isHighRiskTool, allowOnce } from './permissions.mjs';
import { executeToolSecure, confirmExecution, getSecurityStatus } from './security/index.mjs';

function permissionRequired(name) {
  return Object.assign(new Error(`工具 "${name}" 需要用户授权：可选择本次允许，或会话级/项目级/用户级允许。`), { code: 'HELM_PERMISSION_REQUIRED', needsPermission: true });
}

async function saveFile({ path: filePath, content, append = false, encoding = 'utf8' }) {
  if (!filePath || content == null) throw new Error('save_file 需要 path 和 content');
  const absolute = path.resolve(filePath);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.writeFile(absolute, String(content), { encoding, flag: append ? 'a' : 'w' });
  return { ok: true, path: absolute, bytes: (await fsp.stat(absolute)).size, append: !!append };
}

async function readFile({ path: filePath, encoding = 'utf8', offset = 0, maxBytes = 1048576 }) {
  if (!filePath) throw new Error('read_file 需要 path');
  const absolute = path.resolve(filePath);
  const stat = await fsp.stat(absolute);
  let start = Math.max(0, Math.min(stat.size, Number(offset) || 0));
  const limit = Math.max(1, Math.min(1048576, Number(maxBytes) || 1048576));
  const handle = await fsp.open(absolute, 'r');
  try {
    if (encoding.toLowerCase().replace('-', '') === 'utf8' && start < stat.size) {
      const probe = Buffer.alloc(Math.min(4, stat.size - start));
      const probeRead = (await handle.read(probe, 0, probe.length, start)).bytesRead;
      let skipped = 0; while (skipped < probeRead && (probe[skipped] & 0xC0) === 0x80) skipped++;
      start += skipped;
    }
    const readLimit = encoding.toLowerCase().replace('-', '') === 'utf8' ? Math.max(4, limit) : limit;
    const length = Math.max(0, Math.min(readLimit, stat.size - start));
    const buffer = Buffer.alloc(length);
    const rawBytesRead = (await handle.read(buffer, 0, length, start)).bytesRead;
    let slice = buffer.subarray(0, rawBytesRead);
    if (slice.includes(0)) throw new Error('HELM_BINARY_FILE_NOT_SUPPORTED');
    if (encoding.toLowerCase().replace('-', '') === 'utf8' && slice.length) {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      while (slice.length) {
        try { decoder.decode(slice); break; } catch { slice = slice.subarray(0, slice.length - 1); }
      }
    }
    const bytesRead = slice.length;
    const truncated = start + bytesRead < stat.size;
    return { ok: true, path: absolute, bytes: stat.size, content: slice.toString(encoding), offset: start, bytesRead, truncated, nextOffset: truncated ? start + bytesRead : null };
  } finally { await handle.close(); }
}

async function listFiles({ dir, recursive = false }) {
  if (!dir) throw new Error('list_files 需要 dir');
  const absolute = path.resolve(dir); const entries = [];
  async function walk(current, depth) {
    for (const item of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      entries.push({ name: item.name, path: full, type: item.isDirectory() ? 'dir' : 'file', depth });
      if (recursive && item.isDirectory() && depth < 10) await walk(full, depth + 1);
    }
  }
  await walk(absolute, 0);
  return { ok: true, dir: absolute, count: entries.length, entries };
}

async function download({ url, ref, path: savePath, frameId }) {
  let targetUrl = url;
  if (!targetUrl && ref != null) {
    if (!isExtensionConnected()) await waitForExtension(10000);
    const snap = await invoke('snapshot', { options: { interactiveOnly: true, maxElements: 500 } }, frameId != null ? { frameId } : {});
    const element = snap?.elements?.find((item) => String(item.ref) === String(ref));
    if (!element?.attrs?.href) throw new Error(`download: ref ${ref} 无可下载 href`);
    targetUrl = new URL(element.attrs.href, snap.url).href;
  }
  if (!targetUrl) throw new Error('download 需要 url 或 ref');
  const filename = targetUrl.split('/').pop().split('?')[0] || 'download.bin';
  const absolute = path.resolve(savePath || path.join('downloads', filename));
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  try {
    const response = await fetch(targetUrl, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fsp.writeFile(absolute, buffer);
    return { ok: true, url: targetUrl, path: absolute, bytes: buffer.length, mime: response.headers.get('content-type'), via: 'gateway' };
  } catch (gatewayError) {
    if (!isExtensionConnected()) throw gatewayError;
    const browser = await invoke('downloadViaBrowser', { url: targetUrl, filename }, {});
    if (!browser.path || !fs.existsSync(browser.path)) throw new Error('HELM_BROWSER_DOWNLOAD_MISSING');
    const buffer = await fsp.readFile(browser.path);
    await fsp.writeFile(absolute, buffer);
    try { await fsp.unlink(browser.path); } catch {}
    return { ok: true, url: targetUrl, path: absolute, bytes: buffer.length, mime: browser.mime, via: 'browser' };
  }
}

async function executeLocal(name, args) {
  switch (name) {
    case 'save_file': return saveFile(args);
    case 'read_file': return readFile(args);
    case 'list_files': return listFiles(args);
    case 'download': return download(args);
    case 'set_permission': return setPermission(args.tool, args.scope);
    case 'allow_once': return allowOnce(args.tool);
    case 'get_permissions': return getPermissions();
    case 'revoke_permission': return revokePermission(args.tool, args.scope || 'all');
    case 'confirm_execution': return confirmExecution(args.confirmationId);
    case 'get_security_status': return getSecurityStatus();
    default: throw new Error(`未知本地工具: ${name}`);
  }
}

export async function executeTool({ name, args = {}, transport, requestId, auditPath }) {
  return executeToolSecure({ name, args, transport, requestId, auditPath, executeRaw: async () => {
    const permissionTool = ['set_permission', 'allow_once', 'get_permissions', 'revoke_permission', 'confirm_execution', 'get_security_status'].includes(name);
    if (isHighRiskTool(name) && name !== 'eval' && !permissionTool && !(name === 'save_file' && args.append)) {
      const permission = await checkPermission(name);
      if (!permission.allowed) throw permissionRequired(name);
    }
    if (isLocalTool(name)) return executeLocal(name, args);
    if (!isExtensionConnected()) await waitForExtension(10000);
    const [action, actionArgs, options] = mapToolToAction(name, args);
    return invoke(action, actionArgs, options);
  }});
}
