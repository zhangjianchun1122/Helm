#!/usr/bin/env node
/**
 * bridge-daemon.mjs — 网关常驻启动器
 *
 * bridge.mjs 只导出 startOrAttach() 但不自行调用（它是模块，供 mcp-server/http-server import）。
 * 本文件是给「开机自启 / 后台常驻」场景用的独立入口：
 *   1. import 并调用 startOrAttach() —— 端口空闲则起主模式（WS server），被占则走附属模式连已有网关
 *   2. setInterval 兜底保活 —— 主模式下 server.listen 已保活，这里只是防御性兜底
 *
 * 用法：
 *   node bridge-daemon.mjs            # 前台运行（调试用）
 *   计划任务 / 服务调本文件           # 后台常驻
 *
 * 由 install/install.ps1 注册为 Windows 计划任务 HelmGateway，登录时自启。
 */

import { startOrAttach, getIsPrimary } from './bridge.mjs';

await startOrAttach();

// 主模式：startPrimary() 的 server.listen 已让事件循环保活。
// 附属模式：upstream 重连逻辑保活。
// 此 setInterval 作为兜底，确保进程不会因意外退出。
setInterval(() => {}, 1 << 30);

// 进程信号处理：优雅退出
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

console.error(`[bridge-daemon] 已启动 (模式: ${getIsPrimary() ? '主' : '附属'}) PID=${process.pid}`);
