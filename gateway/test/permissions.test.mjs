import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  allowOnce,
  checkPermission,
  getPermissions,
  revokePermission,
  setPermission,
} from '../permissions.mjs';

async function withTempProject(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-permissions-test-'));
  const previous = process.cwd();
  process.chdir(dir);
  try { return await fn(dir); } finally {
    process.chdir(previous);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('allow_once grants exactly one execution and revoke(all) clears it', async () => {
  await withTempProject(async () => {
    await allowOnce('download');
    assert.deepEqual(await checkPermission('download'), { allowed: true, scope: 'once' });
    assert.deepEqual(await checkPermission('download'), { allowed: false, scope: null });
    await allowOnce('download');
    const revoked = await revokePermission('download', 'all');
    assert.ok(revoked.revoked.includes('once'));
    assert.deepEqual(await checkPermission('download'), { allowed: false, scope: null });
  });
});

test('session permission takes precedence and project permission stays isolated', async () => {
  await withTempProject(async (dir) => {
    await setPermission('save_file', 'project');
    assert.deepEqual(await checkPermission('save_file'), { allowed: true, scope: 'project' });
    await setPermission('save_file', 'session');
    assert.deepEqual(await checkPermission('save_file'), { allowed: true, scope: 'session' });
    const state = await getPermissions();
    assert.equal(state.permissions.save_file.session, true);
    assert.equal(state.permissions.save_file.project, true);
    assert.ok(state.projectConfigPath.startsWith(dir));
    assert.equal(state.userConfigPath.includes('.zcode'), true);
    await revokePermission('save_file', 'session');
    assert.deepEqual(await checkPermission('save_file'), { allowed: true, scope: 'project' });
    await revokePermission('save_file', 'project');
    assert.deepEqual(await checkPermission('save_file'), { allowed: false, scope: null });
  });
});

test('permission APIs reject non-high-risk tools and invalid scopes', async () => {
  await assert.rejects(() => allowOnce('click'), /不是高危工具/);
  await assert.rejects(() => setPermission('download', 'invalid'), /无效的权限级别/);
});
