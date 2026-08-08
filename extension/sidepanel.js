/**
 * sidepanel.js — Helm 动作流可视化
 *
 * 接收 sw.js 广播的 bt-action 消息，渲染动作流卡片：
 *   - 进行中（琥珀边）：⏳ action + 参数
 *   - 成功（绿边）：✅ action + 耗时 + 结果摘要
 *   - 失败（红边）：❌ action + 耗时 + 错误信息
 * screenshot 动作显示缩略图，点击放大。
 *
 * 仅 UI：不参与实际执行链路。
 */

const $status = document.getElementById('status');
const $flow = document.getElementById('flow');
const $empty = document.getElementById('empty');
const $clear = document.getElementById('clear');
const $pause = document.getElementById('pause');
const $count = document.getElementById('count');
const $okCount = document.getElementById('okCount');
const $errCount = document.getElementById('errCount');

let totalCount = 0, okCount = 0, errCount = 0;
let autoScroll = true;
const pending = new Map(); // 动作 key -> 卡片元素（start 阶段创建，end 阶段更新）
let actionSeq = 0;

function updateStat() {
  $count.textContent = totalCount;
  $okCount.textContent = okCount;
  $errCount.textContent = errCount;
}

function setStatus(text, cls) {
  $status.textContent = text;
  $status.className = 'status ' + (cls || '');
}

function fmtArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (v == null) parts.push(`${k}`);
    else parts.push(`${k}=${v}`);
  }
  return parts.join(' ');
}

function fmtResult(summary) {
  if (summary == null) return '';
  if (typeof summary === 'string') return summary;
  try { return JSON.stringify(summary); } catch { return '[unserializable]'; }
}

// 动作图标
const ICONS = {
  navigate: '🧭', listTabs: '📑', listFrames: '🪟', snapshot: '👁',
  click: '👆', rightClick: '🖱', fill: '⌨', press: '⌨',
  getText: '📖', scroll: '↕', hover: '👁‍🗨', drag: '✊',
  eval: '⚡', wait: '⏱', screenshot: '📷', setActiveFrame: '🎯',
  getActiveFrame: '🎯', downloadViaBrowser: '⬇',
};

function createActionCard(action, args) {
  const id = ++actionSeq;
  const key = `${action}#${id}`;
  pending.set(key, { id, action });

  const card = document.createElement('div');
  card.className = 'card running';
  card.dataset.key = key;

  const icon = ICONS[action] || '▪';
  const head = document.createElement('div');
  head.className = 'card-head';
  head.innerHTML = `<span class="icon">${icon}</span><span class="action-name">${action}</span><span class="duration">…</span>`;
  card.appendChild(head);

  if (args && Object.keys(args).length > 0) {
    const a = document.createElement('div');
    a.className = 'args';
    a.textContent = fmtArgs(args);
    card.appendChild(a);
  }

  $flow.appendChild(card);
  if ($empty) $empty.style.display = 'none';
  if (autoScroll) $flow.scrollTop = $flow.scrollHeight;
  return { key, card };
}

function completeAction(action, ok, durationMs, summary) {
  // 找到该 action 的 pending 卡片（最后一个匹配的 running 卡片）
  let found = null;
  for (const [key, entry] of pending) {
    if (entry.action === action) found = { key, ...entry };
  }
  if (!found) {
    // 没有 start 卡片（可能是重载后残留），直接创建已完成卡片
    const c = createActionCard(action, {});
    completeCard(c.card, action, ok, durationMs, summary);
    return;
  }
  pending.delete(found.key);
  completeCard(found.card, action, ok, durationMs, summary);
}

function completeCard(card, action, ok, durationMs, summary) {
  card.classList.remove('running');
  card.classList.add(ok ? 'ok' : 'err');

  // 更新图标和耗时
  const head = card.querySelector('.card-head');
  const iconEl = head.querySelector('.icon');
  const durEl = head.querySelector('.duration');
  iconEl.textContent = ok ? '✅' : '❌';
  durEl.textContent = durationMs != null ? `${durationMs}ms` : '';

  // 结果摘要
  if (summary != null) {
    const r = document.createElement('div');
    r.className = 'result' + (ok ? '' : ' err');
    // screenshot 显示缩略图
    if (action === 'screenshot' && summary.hasImage) {
      // 从 SW 的 broadcastAction 拿不到 base64（summary 只有 hasImage），
      // 缩略图需要单独获取——暂用占位，真实 base64 可后续加 broadcast
      r.textContent = `📷 ${fmtResult(summary)}`;
    } else {
      r.textContent = ok ? fmtResult(summary) : fmtResult(summary);
    }
    card.appendChild(r);
  }

  totalCount++;
  if (ok) okCount++; else errCount++;
  updateStat();
  if (autoScroll) $flow.scrollTop = $flow.scrollHeight;
}

// 监听 sw 广播的动作
chrome.runtime.onMessage.addListener((m) => {
  if (!m) return;
  if (m.type === 'bt-action') {
    if (m.phase === 'start') {
      createActionCard(m.action, m.args);
    } else if (m.phase === 'end') {
      completeAction(m.action, m.ok, m.durationMs, m.summary || m.error);
    }
  }
});

// 清空
$clear.addEventListener('click', () => {
  $flow.textContent = '';
  pending.clear();
  totalCount = okCount = errCount = 0;
  updateStat();
  if ($empty) $empty.style.display = '';
});

// 暂停/恢复自动滚动
$pause.addEventListener('click', () => {
  autoScroll = !autoScroll;
  $pause.textContent = autoScroll ? '暂停滚动' : '恢复滚动';
});

// 手动滚动时不自动跟随
$flow.addEventListener('scroll', () => {
  const atBottom = $flow.scrollHeight - $flow.scrollTop - $flow.clientHeight < 30;
  if (!atBottom && autoScroll) {
    autoScroll = false;
    $pause.textContent = '恢复滚动';
  }
});

// 网关连通性探测
async function checkGateway() {
  try {
    const r = await fetch('http://127.0.0.1:8787/health', { method: 'GET' });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      setStatus(j.ext ? '已连接网关 ✓' : '网关已连·扩展未连', j.ext ? 'ok' : 'err');
    } else {
      setStatus(`网关 ${r.status}`, 'err');
    }
  } catch (e) {
    setStatus('未连接网关', 'err');
  }
}

checkGateway();
setInterval(checkGateway, 5000);
