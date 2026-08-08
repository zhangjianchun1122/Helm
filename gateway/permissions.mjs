/**
 * permissions.mjs — Helm 工具权限管理
 *
 * 三级权限模型：
 *   - session: 会话级（内存，MCP server 进程内）
 *   - project: 项目级（<项目>/.zcode/helm-permissions.json）
 *   - user:    用户级（~/.zcode/helm-permissions.json）
 *
 * 检查优先级：session → project → user，任一层允许即放行。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ---------- 高危工具清单 ----------
export const HIGH_RISK_TOOLS = new Set(['eval', 'download', 'save_file']);

// ---------- 会话级权限（内存）----------
const sessionPermissions = new Set();

// ---------- 单次允许（内存，用完即销）----------
const onceAllowed = new Set();

// ---------- 配置文件路径 ----------
function getUserConfigPath() {
  return path.join(os.homedir(), '.zcode', 'helm-permissions.json');
}

function getProjectConfigPath() {
  // 项目级配置在当前工作目录的 .zcode 子目录
  return path.join(process.cwd(), '.zcode', 'helm-permissions.json');
}

// ---------- 文件读写 ----------
async function readConfigFile(filePath) {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    const data = JSON.parse(content);
    if (data.version === 1 && data.allowed && typeof data.allowed === 'object') {
      return data;
    }
  } catch (_) {
    // 文件不存在或格式错误，返回空配置
  }
  return { version: 1, allowed: {} };
}

async function writeConfigFile(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ---------- 公开 API ----------

/**
 * 检查工具是否已授权
 * @param {string} tool - 工具名
 * @returns {Promise<{allowed: boolean, scope: string|null}>}
 */
export async function checkPermission(tool) {
  // 0. 单次允许（最高优先级，用完即销）
  if (onceAllowed.has(tool)) {
    onceAllowed.delete(tool);
    return { allowed: true, scope: 'once' };
  }

  // 1. 会话级
  if (sessionPermissions.has(tool)) {
    return { allowed: true, scope: 'session' };
  }

  // 2. 项目级
  const projectConfig = await readConfigFile(getProjectConfigPath());
  if (projectConfig.allowed[tool]) {
    return { allowed: true, scope: 'project' };
  }

  // 3. 用户级
  const userConfig = await readConfigFile(getUserConfigPath());
  if (userConfig.allowed[tool]) {
    return { allowed: true, scope: 'user' };
  }

  return { allowed: false, scope: null };
}

/**
 * 设置工具权限
 * @param {string} tool - 工具名
 * @param {'session'|'project'|'user'} scope - 权限级别
 */
export async function setPermission(tool, scope) {
  if (!HIGH_RISK_TOOLS.has(tool)) {
    throw new Error(`工具 ${tool} 不是高危工具，无需授权`);
  }
  if (!['session', 'project', 'user'].includes(scope)) {
    throw new Error(`无效的权限级别: ${scope}，必须是 session/project/user`);
  }

  if (scope === 'session') {
    sessionPermissions.add(tool);
    return { ok: true, tool, scope };
  }

  const configPath = scope === 'project' ? getProjectConfigPath() : getUserConfigPath();
  const config = await readConfigFile(configPath);
  config.allowed[tool] = true;
  await writeConfigFile(configPath, config);
  return { ok: true, tool, scope, path: configPath };
}

/**
 * 允许工具单次执行（用完即销）
 * @param {string} tool - 工具名
 */
export async function allowOnce(tool) {
  if (!HIGH_RISK_TOOLS.has(tool)) {
    throw new Error(`工具 ${tool} 不是高危工具，无需授权`);
  }
  onceAllowed.add(tool);
  return { ok: true, tool, scope: 'once' };
}

/**
 * 撤销工具权限
 * @param {string} tool - 工具名
 * @param {'session'|'project'|'user'|'all'} scope - 权限级别，'all' 撤销所有级别
 */
export async function revokePermission(tool, scope = 'all') {
  if (!['session', 'project', 'user', 'all'].includes(scope)) {
    throw new Error(`无效的权限级别: ${scope}`);
  }

  const revoked = [];

  if (scope === 'session' || scope === 'all') {
    if (sessionPermissions.has(tool)) {
      sessionPermissions.delete(tool);
      revoked.push('session');
    }
  }

  if (scope === 'project' || scope === 'all') {
    const configPath = getProjectConfigPath();
    const config = await readConfigFile(configPath);
    if (config.allowed[tool]) {
      delete config.allowed[tool];
      await writeConfigFile(configPath, config);
      revoked.push('project');
    }
  }

  if (scope === 'user' || scope === 'all') {
    const configPath = getUserConfigPath();
    const config = await readConfigFile(configPath);
    if (config.allowed[tool]) {
      delete config.allowed[tool];
      await writeConfigFile(configPath, config);
      revoked.push('user');
    }
  }

  return { ok: true, tool, revoked };
}

/**
 * 获取所有权限状态
 */
export async function getPermissions() {
  const projectConfig = await readConfigFile(getProjectConfigPath());
  const userConfig = await readConfigFile(getUserConfigPath());

  const permissions = {};
  for (const tool of HIGH_RISK_TOOLS) {
    permissions[tool] = {
      once: onceAllowed.has(tool),
      session: sessionPermissions.has(tool),
      project: !!projectConfig.allowed[tool],
      user: !!userConfig.allowed[tool],
    };
  }

  return {
    permissions,
    projectConfigPath: getProjectConfigPath(),
    userConfigPath: getUserConfigPath(),
  };
}

/**
 * 判断工具是否为高危工具
 */
export function isHighRiskTool(tool) {
  return HIGH_RISK_TOOLS.has(tool);
}
