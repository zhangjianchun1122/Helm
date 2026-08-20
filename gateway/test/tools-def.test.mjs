import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, mapToolToAction, isLocalTool } from '../tools-def.mjs';

const opts = (name, args) => mapToolToAction(name, args)[2];
const argsOf = (name, args) => mapToolToAction(name, args)[1];

test('tabId 映射成 tabIdHint，固定单次调用的目标标签页', () => {
  // HelmFlow 依赖此映射：运行前 create_tab 拿到 tabId，之后每次调用都显式携带，
  // 不依赖全局 pendingTabId（用户切标签会触发 onActivated 重置它）
  assert.deepEqual(opts('click', { ref: '1', tabId: 123 }), { tabIdHint: 123 });
  assert.deepEqual(opts('navigate', { url: 'https://a.test', tabId: 123 }), { tabIdHint: 123 });
  assert.deepEqual(opts('get_text', { ref: '2', tabId: 7 }), { tabIdHint: 7 });
});

test('tabId 与 frameId 可共存且互不干扰', () => {
  assert.deepEqual(opts('get_snapshot', { tabId: 123, frameId: 5 }), { frameId: 5, tabIdHint: 123 });
  assert.deepEqual(opts('click', { ref: '1', frameId: 0, tabId: 9 }), { frameId: 0, tabIdHint: 9 });
});

test('未传 tabId/frameId 时 opts 为空对象，不注入 undefined', () => {
  assert.deepEqual(opts('click', { ref: '1' }), {});
  assert.deepEqual(opts('list_tabs', {}), {});
  assert.deepEqual(opts('click', { ref: '1', tabId: null }), {});
});

test('tabId 不泄漏进 action 的 args', () => {
  for (const name of ['click', 'navigate', 'fill', 'get_snapshot', 'wait', 'scroll']) {
    const a = argsOf(name, { ref: '1', url: 'https://a.test', value: 'v', tabId: 123 });
    assert.ok(!('tabId' in a), `${name} 的 args 不应含 tabId`);
  }
});

test('set_active_frame 的 frameId 是设定值，不能被当作用域剥进 opts', () => {
  const [action, args, o] = mapToolToAction('set_active_frame', { frameId: 5 });
  assert.equal(action, 'setActiveFrame');
  assert.equal(args.frameId, 5);
  assert.deepEqual(o, {});
});

test('frame 工具的 tabId 走 args 而非 opts（frame 作用域按 tab 存，需知道设给谁）', () => {
  const [, setArgs, setOpts] = mapToolToAction('set_active_frame', { frameId: 3, tabId: 5 });
  assert.deepEqual(setArgs, { frameId: 3, tabId: 5 });
  assert.deepEqual(setOpts, {}, 'tabId 不能被剥进 opts，否则 sw 侧拿不到要设给哪个 tab');

  const [, getArgs, getOpts] = mapToolToAction('get_active_frame', { tabId: 5 });
  assert.deepEqual(getArgs, { tabId: 5 });
  assert.deepEqual(getOpts, {});
});

test('screenshot 的 tabId 走 opts.tabIdHint，供 sw 侧定位目标 tab', () => {
  // 早前 sw.js 的 screenshot 分支丢掉 tabIdHint，且 captureVisibleTab 无 tabId 参数，
  // 导致后台 tab 被操作时截到的是前台页面（静默错图）
  assert.deepEqual(opts('screenshot', { format: 'png', tabId: 5 }), { tabIdHint: 5 });
  assert.deepEqual(argsOf('screenshot', { format: 'png', tabId: 5 }), { format: 'png', quality: undefined });
});

test('声明了 tabId 的工具其 schema 类型为 integer', () => {
  const declared = TOOLS.filter((t) => t.inputSchema?.properties?.tabId);
  assert.ok(declared.length >= 4, `应至少有 4 个工具声明 tabId，实际 ${declared.length}`);
  for (const t of declared) {
    assert.equal(t.inputSchema.properties.tabId.type, 'integer', `${t.name} 的 tabId 应为 integer`);
  }
  // download 是本地工具，tabId 只在 ref 模式下用于定位取 href 的标签页
  assert.ok(declared.some((t) => t.name === 'download'));
  assert.ok(declared.some((t) => t.name === 'screenshot'));
});

test('create_tab 映射透传 url 与 active（含 active:false）', () => {
  assert.deepEqual(argsOf('create_tab', { url: 'https://a.test' }), { url: 'https://a.test', active: undefined });
  assert.deepEqual(argsOf('create_tab', { url: 'https://a.test', active: false }), { url: 'https://a.test', active: false });
  assert.equal(mapToolToAction('create_tab', {})[0], 'createTab');
});

test('每个非本地工具都有 action 映射，未知工具抛错', () => {
  for (const t of TOOLS) {
    if (isLocalTool(t.name)) continue;
    assert.doesNotThrow(() => mapToolToAction(t.name, {}), `${t.name} 应有映射`);
  }
  assert.throws(() => mapToolToAction('no_such_tool', {}), /未知工具/);
});

test('reload_extension 走本地编排而非单次 invoke', () => {
  // 重载会把 WS 连接一起带走，单次 invoke 拿不到结果，
  // 必须由网关侧编排"断开→重连→bootId 变化"，所以它是本地工具
  assert.ok(isLocalTool('reload_extension'));
  assert.ok(TOOLS.some((t) => t.name === 'reload_extension'));
  // 它不是高危工具（不外传数据、不删东西），但会中断进行中的操作，描述里须讲清
  const tool = TOOLS.find((t) => t.name === 'reload_extension');
  assert.match(tool.description, /中断/);
});

test('工具定义的 schema 结构完整且名称唯一', () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, '工具名不应重复');
  for (const t of TOOLS) {
    assert.equal(typeof t.description, 'string');
    assert.ok(t.description.length > 0, `${t.name} 需要描述`);
    assert.equal(t.inputSchema?.type, 'object', `${t.name} 的 inputSchema.type 应为 object`);
  }
});
