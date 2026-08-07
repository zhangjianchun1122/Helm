/**
 * content/dom-agent.js
 *
 * 注入到每个 frame（all_frames:true）。职责：
 * 1. 接收 service worker 经 runtime.sendMessage 下发的 DOM 操作指令
 * 2. 为可交互元素生成稳定的 ref（data-bt-ref）
 * 3. 执行 snapshot / click / fill / press / eval 等原子操作
 * 4. 回传结果
 *
 * 设计要点：ref 是在 frame 内唯一的整数 id，绑定到元素 data 属性上。
 * service worker 负责把 (frameId, ref) 的组合作为全局 id 透传给网关/Agent。
 */

(() => {
  if (window.__browserToolInjected) return; // 防重复注入
  window.__browserToolInjected = true;

  const REF_ATTR = 'data-bt-ref';
  let nextRef = 1;
  // ref -> WeakRef(element)，避免持有元素阻止 GC；操作时 deref 取出
  const refRegistry = new Map();

  // ---------- ref 管理 ----------
  function ensureRef(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    let ref = el.getAttribute(REF_ATTR);
    if (ref == null) {
      ref = String(nextRef++);
      el.setAttribute(REF_ATTR, ref);
      refRegistry.set(ref, new WeakRef(el));
    } else if (!refRegistry.has(ref)) {
      refRegistry.set(ref, new WeakRef(el));
    }
    return ref;
  }

  function resolveRef(ref) {
    const key = String(ref);
    const entry = refRegistry.get(key);
    if (entry) {
      const el = entry.deref();
      if (el && el.isConnected) return el;
      // WeakRef 被 GC 或元素脱离 DOM
      refRegistry.delete(key);
    }
    // 自愈：元素的 data-bt-ref 属性还在 DOM 上（只是 refRegistry 的 WeakRef 失效），
    // 用属性选择器重新查找并重新注册，避免 ref 失效
    const el = document.querySelector(`[data-bt-ref="${key}"]`);
    if (el && el.isConnected) {
      refRegistry.set(key, new WeakRef(el));
      return el;
    }
    return null;
  }

  // ---------- 可交互元素判定 ----------
  const INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="tab"]',
    '[role="menuitem"]', '[role="option"]', '[role="switch"]',
    '[contenteditable=""]', '[contenteditable="true"]', '[tabindex]'
  ].join(',');

  function isInteractive(el) {
    if (el.matches && el.matches(INTERACTIVE_SELECTOR)) return true;
    // 有 onclick 的也算
    if (el.onclick) return true;
    return false;
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return true;
  }

  // ---------- 智能过滤：广告/装饰元素识别 ----------
  // 广告元素常见命名模式（类名/ID）
  const AD_PATTERNS = [
    /ad[s]?[-_]?/i, /advert/i, /banner/i, /sponsor/i,
    /promo/i, /affiliate/i, /tracking/i, /analytics/i,
    /cookie[-_]?consent/i, /cookie[-_]?banner/i,
  ];

  const AD_CLASSNAMES = [
    'google-ad', 'adsbygoogle', 'ad-container', 'ad-wrapper',
    'sponsor-content', 'promoted-content', 'native-ad',
    'cookie-banner', 'cookie-consent', 'cookie-notice',
  ];

  // 站点特定广告模式
  // containerSelectors: 广告容器选择器（整个广告块）
  // labelSelectors: 广告标签选择器（"广告"文字的小元素）
  // textPatterns: 广告文本模式
  // adLabelInParent: 如果子元素包含广告文本，则父容器是广告
  const SITE_SPECIFIC_RULES = {
    'baidu.com': {
      containerSelectors: ['.EC_result', '[data-lp]'],
      labelSelectors: ['.ec-tuiguang', '.ecfc-tuiguang'],
      textPatterns: [/^广告$/, /^推广$/],
    },
    'taobao.com': {
      // 淘宝使用动态类名，依赖文本匹配
      containerSelectors: [],
      labelSelectors: [],
      textPatterns: [/^广告$/, /^推广$/],
      adLabelInParent: true, // 子元素有"广告"文本 → 父容器是广告
    },
    'tmall.com': {
      containerSelectors: [],
      labelSelectors: [],
      textPatterns: [/^广告$/, /^推广$/],
      adLabelInParent: true,
    },
    'jd.com': {
      // 京东广告标签类名动态生成（如 _ad_xxx），但"广告"文本稳定
      containerSelectors: [],
      labelSelectors: [],
      textPatterns: [/^广告$/],
      adLabelInParent: true,
    },
    'zhihu.com': {
      // 知乎使用动态类名
      containerSelectors: ['.AdblockBanner', '.is-promotion'],
      labelSelectors: [],
      textPatterns: [/^广告$/, /^推广$/, /^知乎精选$/],
      adLabelInParent: true,
    },
    'weibo.com': {
      // 微博使用 CSS-in-JS 动态类名
      containerSelectors: [],
      labelSelectors: [],
      textPatterns: [/^推荐$/, /^广告$/, /^推广$/],
      adLabelInParent: true,
    },
    'google.com': {
      containerSelectors: ['[data-text-ad]', '.commercial-unit-desktop-top', '.commercial-unit-desktop-side'],
      labelSelectors: [],
      textPatterns: [/^Sponsored$/, /^Ad$/, /^广告$/],
    },
    'youtube.com': {
      containerSelectors: ['.video-ads', '.ad-showing', '.ytp-ad-module', '.ytp-ad-overlay-container'],
      labelSelectors: [],
      textPatterns: [/^Ad$/, /^Advertisement$/, /^跳过广告$/],
    },
  };

  // 通用广告属性
  const AD_ATTRIBUTES = [
    'data-promotion', 'data-ad', 'data-ad-client', 'data-ad-slot',
    'data-tuiguang', 'data-za-detail-view-path-module',
  ];

  // 通用广告文本模式（中英文）
  const AD_TEXT_PATTERNS = [
    /^广告$/, /^推广$/, /^赞助$/, /^推荐$/,
    /^Ad$/, /^Sponsored$/, /^Promoted$/, /^Advertisement$/,
  ];

  function getSiteRules() {
    const hostname = location.hostname;
    for (const [domain, rules] of Object.entries(SITE_SPECIFIC_RULES)) {
      if (hostname.includes(domain)) {
        return rules;
      }
    }
    return null;
  }

  function isAdElement(el) {
    const id = el.id || '';
    const className = typeof el.className === 'string' ? el.className : '';
    const combined = `${id} ${className}`;

    // 检查类名/ID 模式
    for (const pattern of AD_PATTERNS) {
      if (pattern.test(combined)) return true;
    }

    // 检查精确类名
    for (const name of AD_CLASSNAMES) {
      if (combined.includes(name)) return true;
    }

    // 检查 Google Ad iframe
    if (el.tagName === 'IFRAME') {
      const src = el.getAttribute('src') || '';
      if (src.includes('google.com/ads') || src.includes('doubleclick.net')) return true;
    }

    // 检查通用广告属性
    for (const attr of AD_ATTRIBUTES) {
      if (el.hasAttribute(attr)) return true;
    }

    // 检查站点特定规则
    const siteRules = getSiteRules();
    if (siteRules) {
      // 检查容器选择器（整个广告块）
      for (const selector of siteRules.containerSelectors || []) {
        try {
          if (el.matches(selector)) return true;
          // 检查是否在广告容器内部
          if (el.closest(selector)) return true;
        } catch (e) {
          // 选择器语法错误，跳过
        }
      }

      // 检查标签选择器（广告标签如"广告"文字）
      for (const selector of siteRules.labelSelectors || []) {
        try {
          if (el.matches(selector)) return true;
        } catch (e) {
          // 选择器语法错误，跳过
        }
      }

      // 检查站点特定文本模式
      const text = (el.innerText || el.textContent || '').trim();
      for (const pattern of siteRules.textPatterns) {
        if (pattern.test(text)) return true;
      }

      // adLabelInParent: 如果子元素包含广告文本，则当前元素是广告容器
      // 适用于京东/淘宝/微博等使用动态类名的网站
      if (siteRules.adLabelInParent) {
        const rect = el.getBoundingClientRect();
        // 只检查合理大小的容器（商品卡片通常 150-400px）
        if (rect.width >= 100 && rect.width <= 500 && rect.height >= 100 && rect.height <= 500) {
          // 查找直接子元素中是否有广告标签
          const children = el.querySelectorAll('*');
          for (const child of children) {
            const childRect = child.getBoundingClientRect();
            // 广告标签通常很小（< 60px 宽，< 30px 高）
            if (childRect.width > 0 && childRect.width < 60 && childRect.height > 0 && childRect.height < 30) {
              const childText = (child.innerText || child.textContent || '').trim();
              for (const pattern of siteRules.textPatterns) {
                if (pattern.test(childText)) return true;
              }
            }
          }
        }
      }
    }

    // 检查通用广告文本（只检查小元素，避免误判大容器）
    const rect = el.getBoundingClientRect();
    if (rect.height < 50 && rect.width < 200) {
      const text = (el.innerText || el.textContent || '').trim();
      for (const pattern of AD_TEXT_PATTERNS) {
        if (pattern.test(text)) return true;
      }
    }

    return false;
  }

  function isDecorative(el) {
    // aria-hidden 元素（明确标记为装饰）
    if (el.getAttribute('aria-hidden') === 'true') return true;

    // 纯装饰性图标/SVG（无文本、无 aria-label）
    if (el.tagName === 'SVG' || el.tagName === 'IMG') {
      const text = (el.innerText || '').trim();
      const ariaLabel = el.getAttribute('aria-label');
      const title = el.getAttribute('title');
      if (!text && !ariaLabel && !title) return true;
    }

    // 固定定位的浮层（cookie 提示、通知栏），但保留导航栏
    const style = getComputedStyle(el);
    if (style.position === 'fixed' || style.position === 'sticky') {
      const role = el.getAttribute('role');
      const tagName = el.tagName.toLowerCase();
      // 保留 nav、header、footer 等语义化标签
      if (!role && !['nav', 'header', 'footer', 'main'].includes(tagName)) {
        // 检查是否在顶部/底部（通常是 cookie banner）
        const rect = el.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        if (rect.top < 50 || rect.bottom > viewportHeight - 50) {
          // 高度较小的浮层更可能是提示条
          if (rect.height < 100) return true;
        }
      }
    }

    return false;
  }

  function smartFilter(elements) {
    const seen = new Map();
    const result = [];

    for (const el of elements) {
      // 基于文本+标签+垂直位置的去重（每 100px 一个区间）
      const textKey = (el.text || '').slice(0, 50);
      const key = `${el.tag}|${textKey}|${Math.floor(el.rect.y / 100)}`;

      if (seen.has(key)) {
        continue; // 跳过重复项
      }

      seen.set(key, true);

      // 精简属性：移除空值
      const cleanAttrs = {};
      for (const [k, v] of Object.entries(el.attrs)) {
        if (v != null && v !== '') cleanAttrs[k] = v;
      }
      el.attrs = cleanAttrs;

      result.push(el);
    }

    return result;
  }

  // ---------- snapshot：把页面简化成 ref 树 ----------
  function buildSnapshot(options = {}) {
    const { interactiveOnly = true, filterLevel = 'basic' } = options;
    const root = document.body || document.documentElement;
    const out = [];
    const stack = [[root, 0]];
    let filteredCount = 0;

    while (stack.length) {
      const [el, depth] = stack.pop();
      if (!el || el.nodeType !== Node.ELEMENT_NODE) continue;

      const include = interactiveOnly ? isInteractive(el) : true;
      if (include && isVisible(el)) {
        // 智能过滤：basic 和 smart 模式过滤广告/装饰元素
        if (filterLevel !== 'none') {
          if (isAdElement(el) || isDecorative(el)) {
            filteredCount++;
            continue;
          }
        }

        const ref = ensureRef(el);
        out.push(describe(el, ref, depth));
      }

      // 子节点逆序入栈以保持文档顺序
      const children = el.children;
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push([children[i], depth + 1]);
      }
    }

    // smart 模式：后处理去重和精简
    const finalElements = filterLevel === 'smart' ? smartFilter(out) : out;

    return {
      url: location.href,
      title: document.title,
      frameUrl: location.href,
      elementCount: finalElements.length,
      elements: finalElements,
      filterLevel,
      filteredCount, // 被过滤的元素数量（不含 smart 去重）
    };
  }

  function describe(el, ref, depth) {
    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || el.textContent || '').trim().slice(0, 160);
    const attrs = {};
    // 只收对定位有用的属性
    for (const key of ['id', 'name', 'type', 'href', 'value', 'placeholder', 'role', 'aria-label']) {
      const v = el.getAttribute(key);
      if (v != null) attrs[key] = v;
    }
    return {
      ref,
      tag,
      text,
      attrs,
      depth,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    };
  }

  // ---------- 原子操作 ----------
  function scrollIntoViewIfNeeded(el) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch (_) { /* ignore */ }
  }

  function doClick(ref, button = 'left') {
    const el = resolveRef(ref);
    if (!el) return { ok: false, error: `ref ${ref} 失效或已脱离 DOM，请重新 get_snapshot 刷新 ref 后重试` };
    scrollIntoViewIfNeeded(el);
    const rect = el.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    // 用真实 PointerEvent 序列，比 .click() 更能触发站点自定义交互
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y,
      button: button === 'right' ? 2 : 0,
      buttons: button === 'right' ? 2 : 1,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    if (button === 'right') {
      // 右键：只发 contextmenu，不发 click（click 是左键专属，发了会触发链接跳转）
      el.dispatchEvent(new MouseEvent('contextmenu', opts));
    } else {
      // 左键：发 click 事件
      const clickOpts = { ...opts, button: 0, buttons: 0 };
      el.dispatchEvent(new MouseEvent('click', clickOpts));
    }
    return { ok: true };
  }

  function doFill(ref, value) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, error: `ref ${ref} 失效，请重新 get_snapshot 刷新 ref 后重试` };
    scrollIntoViewIfNeeded(el);
    el.focus();
    // 清空再输入，触发 input/change 事件
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    // 模拟逐字符输入对 React/Vue 受控组件更友好
    const setter = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value'
    )?.set;
    const proto = el.isContentEditable ? HTMLElement.prototype : null;
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
      return { ok: true };
    }
    const nativeSetter = setter || (proto && Object.getOwnPropertyDescriptor(proto, 'textContent')?.set);
    if (nativeSetter) nativeSetter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  function doPress(key) {
    // key 用 KeyEvent key 名：Enter / Escape / Tab / ArrowDown 等
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    document.activeElement?.dispatchEvent(ev);
    document.activeElement?.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    return { ok: true };
  }

  // ---------- 悬停 ----------
  // 触发 pointerover/mouseenter/pointermove/mouseover/mousemove 序列，
  // 用于触发依赖 hover 的下拉菜单、tooltip、CSS :hover 状态。
  // 不发 click / mousedown，纯悬停语义。
  function doHover(ref) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, error: `ref ${ref} 失效或已脱离 DOM，请重新 get_snapshot 刷新 ref 后重试` };
    scrollIntoViewIfNeeded(el);
    const rect = el.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y,
      button: 0, buttons: 0, // 悬停不按键
    };
    // 找父链用于 mouseenter（不可冒泡，但对每个进入的元素触发）
    // 这里简化：直接在目标元素上发 pointerover/mouseover/mousemove，
    // 大多数站点的 hover 菜单靠 mouseover/mousemove 冒泡即可触发。
    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
    el.dispatchEvent(new PointerEvent('pointermove', opts));
    el.dispatchEvent(new MouseEvent('mousemove', opts));
    return { ok: true, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
  }

  // ---------- 拖拽 ----------
  // 同时模拟两种拖拽语义以兼容各类 UI 实现：
  //  A. 鼠标拖拽序列：mousedown → 插值 mousemove → mouseup
  //     覆盖自定义拖拽（SortableJS、React DnD 等）
  //  B. 原生 HTML5 DnD：dragstart → drag → dragenter/dragover → drop/dragend
  //     覆盖 draggable=true 元素
  // fromRef/toRef 必须在同一 frame（调用方保证）
  function doDrag(fromRef, toRef, opts = {}) {
    const from = resolveRef(fromRef);
    const to = resolveRef(toRef);
    if (!from) return { ok: false, error: `fromRef ${fromRef} 失效` };
    if (!to) return { ok: false, error: `toRef ${toRef} 失效` };
    scrollIntoViewIfNeeded(from);
    scrollIntoViewIfNeeded(to);

    const fromRect = from.getBoundingClientRect();
    const toRect = to.getBoundingClientRect();
    const x1 = fromRect.x + fromRect.width / 2;
    const y1 = fromRect.y + fromRect.height / 2;
    const x2 = toRect.x + toRect.width / 2;
    const y2 = toRect.y + toRect.height / 2;
    const steps = Math.max(5, Number(opts.steps) || 10);

    const fireMouse = (type, x, y, isDown) => {
      const ev = new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y,
        button: 0,
        buttons: isDown ? 1 : 0,
      });
      document.elementFromPoint(x, y)?.dispatchEvent(ev) || from.dispatchEvent(ev);
    };
    const firePointer = (type, x, y, isDown) => {
      const ev = new PointerEvent(type, {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y,
        button: 0,
        buttons: isDown ? 1 : 0,
        pointerId: 1, pointerType: 'mouse',
      });
      document.elementFromPoint(x, y)?.dispatchEvent(ev) || from.dispatchEvent(ev);
    };

    // 等待 DOM 在 scrollIntoView 后稳定
    const r1 = from.getBoundingClientRect();
    const r2 = to.getBoundingClientRect();
    const sx1 = r1.x + r1.width / 2, sy1 = r1.y + r1.height / 2;
    const sx2 = r2.x + r2.width / 2, sy2 = r2.y + r2.height / 2;

    // A. 鼠标拖拽序列
    firePointer('pointerdown', sx1, sy1, true);
    fireMouse('mousedown', sx1, sy1, true);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = sx1 + (sx2 - sx1) * t;
      const y = sy1 + (sy2 - sy1) * t;
      firePointer('pointermove', x, y, true);
      fireMouse('mousemove', x, y, true);
    }
    firePointer('pointerup', sx2, sy2, false);
    fireMouse('mouseup', sx2, sy2, false);

    // B. 原生 HTML5 DnD（draggable 元素才生效，非 draggable 发了也是 no-op）
    try {
      const dt = new DataTransfer();
      const dtOpts = { bubbles: true, cancelable: true, view: window, clientX: sx1, clientY: sy1, dataTransfer: dt };
      from.dispatchEvent(new DragEvent('dragstart', dtOpts));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = sx1 + (sx2 - sx1) * t;
        const y = sy1 + (sy2 - sy1) * t;
        const ev = new DragEvent('drag', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, dataTransfer: dt });
        document.elementFromPoint(x, y)?.dispatchEvent(ev) || from.dispatchEvent(ev);
      }
      to.dispatchEvent(new DragEvent('dragenter', { ...dtOpts, clientX: sx2, clientY: sy2 }));
      to.dispatchEvent(new DragEvent('dragover', { ...dtOpts, clientX: sx2, clientY: sy2 }));
      to.dispatchEvent(new DragEvent('drop', { ...dtOpts, clientX: sx2, clientY: sy2 }));
      from.dispatchEvent(new DragEvent('dragend', { ...dtOpts, clientX: sx2, clientY: sy2 }));
    } catch (e) {
      // DataTransfer/DragEvent 在某些环境受限，鼠标序列已足够覆盖大多数场景
    }

    return { ok: true, from: { ref: fromRef, x: sx1, y: sy1 }, to: { ref: toRef, x: sx2, y: sy2 }, steps };
  }

  function doEval(code, arg) {
    // 在 MAIN world 等价：直接 eval，可读取页面全局
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('arg', code);
      const result = fn(arg);
      return { ok: true, result: safeSerialize(result) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // ---------- 页面高亮：四边发光边框，标注当前被操作的页面 ----------
  // 动作进行中显示琥珀色发光边框 + 脉冲动画，结束后淡出移除。
  // 设计：fixed 定位、inset:0、pointer-events:none、最高 z-index，不挡页面交互。
  const HIGHLIGHT_ID = '__helm_highlight__';
  const HIGHLIGHT_STYLE_ID = '__helm_highlight_style__';

  function showHighlight(label) {
    // 幂等：若边框已存在，只更新标签内容（常亮模式，不重新创建避免闪烁）
    const existing = document.getElementById(HIGHLIGHT_ID);
    if (existing) {
      const tag = document.getElementById(HIGHLIGHT_ID + '_tag');
      if (tag) tag.textContent = '⚓ ' + (label || '');
      return { ok: true };
    }

    // 注入样式（含脉冲动画）
    const style = document.createElement('style');
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = `
      @keyframes __helm_pulse {
        0%, 100% { box-shadow: inset 0 0 0 3px #F59E0B, 0 0 12px 2px rgba(245,158,11,0.5); opacity: 1; }
        50% { box-shadow: inset 0 0 0 4px #FCD34D, 0 0 20px 4px rgba(245,158,11,0.8); opacity: 0.85; }
      }
      @keyframes __helm_fadeout {
        from { opacity: 1; }
        to { opacity: 0; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);

    // 边框 div
    const div = document.createElement('div');
    div.id = HIGHLIGHT_ID;
    div.style.cssText = [
      'position:fixed', 'inset:0', 'pointer-events:none',
      'z-index:2147483647',
      'box-sizing:border-box',
      'animation:__helm_pulse 1s ease-in-out infinite',
      'border-radius:0',
    ].join(';');
    (document.body || document.documentElement).appendChild(div);

    // 可选标签（右上角显示动作名）
    if (label) {
      const tag = document.createElement('div');
      tag.id = HIGHLIGHT_ID + '_tag';
      tag.textContent = '⚓ ' + label;
      tag.style.cssText = [
        'position:fixed', 'top:10px', 'right:10px',
        'z-index:2147483647', 'pointer-events:none',
        'background:#0F766E', 'color:#fff',
        'padding:4px 10px', 'border-radius:14px',
        'font:600 12px/1.4 system-ui,sans-serif',
        'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
      ].join(';');
      (document.body || document.documentElement).appendChild(tag);
    }
    return { ok: true };
  }

  function hideHighlightInternal() {
    const old = document.getElementById(HIGHLIGHT_ID);
    if (old) old.remove();
    const oldTag = document.getElementById(HIGHLIGHT_ID + '_tag');
    if (oldTag) oldTag.remove();
    const oldStyle = document.getElementById(HIGHLIGHT_STYLE_ID);
    if (oldStyle) oldStyle.remove();
  }

  function hideHighlight() {
    // 淡出动画后移除
    const div = document.getElementById(HIGHLIGHT_ID);
    if (div) {
      div.style.animation = '__helm_fadeout 0.8s ease-out forwards';
      setTimeout(() => hideHighlightInternal(), 850);
    } else {
      hideHighlightInternal();
    }
    return { ok: true };
  }

  function safeSerialize(v, seen = new Set()) {
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t === 'function') return `[fn:${v.name || 'anonymous'}]`;
    if (t !== 'object') return v;
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map((x) => safeSerialize(x, seen));
    const out = {};
    for (const k of Object.keys(v).slice(0, 50)) {
      try { out[k] = safeSerialize(v[k], seen); } catch (_) { /* skip */ }
    }
    return out;
  }

  function getText(ref) {
    const el = resolveRef(ref);
    if (!el) return { ok: false, error: `ref ${ref} 失效，请重新 get_snapshot 刷新 ref 后重试` };
    return { ok: true, text: (el.innerText || el.textContent || '').trim() };
  }

  // ---------- 滚动 ----------
  // 两种模式二选一：ref（滚动到元素）/ direction+amount（方向滚动）
  function doScroll(opts = {}) {
    const { ref, direction, amount } = opts;
    if (ref != null) {
      const el = resolveRef(ref);
      if (!el) return { ok: false, error: `ref ${ref} 失效，请重新 get_snapshot 刷新 ref 后重试` };
      try {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      } catch (_) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
      }
      return { ok: true, mode: 'toElement', ref };
    }
    // 方向滚动
    const dir = direction || 'down';
    const px = Math.max(0, Number(amount) || 300);
    let dx = 0, dy = 0;
    if (dir === 'down') dy = px;
    else if (dir === 'up') dy = -px;
    else if (dir === 'right') dx = px;
    else if (dir === 'left') dx = -px;
    else return { ok: false, error: `未知 direction: ${dir}，合法值：up/down/left/right` };
    window.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
    return { ok: true, mode: 'byDirection', direction: dir, amount: px };
  }

  // ---------- 条件探测（供 SW 的 wait 轮询调用，同步返回 met=true/false）----------
  // 设计：不在 dom-agent 里长等待，而是暴露同步 checkCondition，由 SW 反复调用。
  // 这样 dom-agent 仍走同步 sendResponse，规避 Chrome 150 异步回包不可靠的问题。
  // idleMs：返回最近一次 DOM 变化距今的毫秒，SW 侧判断是否 >= idleMs。
  let lastMutationAt = Date.now();
  try {
    const mo = new MutationObserver(() => { lastMutationAt = Date.now(); });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  } catch (_) { /* ignore */ }

  function checkCondition(cond) {
    const bodyText = (document.body && (document.body.innerText || document.body.textContent)) || '';
    if (cond.text != null) {
      if (!bodyText.includes(cond.text)) return { met: false, reason: `text 未出现: "${cond.text}"` };
    }
    if (cond.textGone != null) {
      if (bodyText.includes(cond.textGone)) return { met: false, reason: `text 仍存在: "${cond.textGone}"` };
    }
    if (cond.selector != null) {
      let matched = false;
      try { matched = !!document.querySelector(cond.selector); } catch (e) { return { met: false, reason: `selector 非法: ${e.message}` }; }
      if (!matched) return { met: false, reason: `selector 未匹配: "${cond.selector}"` };
    }
    if (cond.selectorGone != null) {
      let matched = false;
      try { matched = !!document.querySelector(cond.selectorGone); } catch (e) { return { met: false, reason: `selectorGone 非法: ${e.message}` }; }
      if (matched) return { met: false, reason: `selectorGone 仍匹配: "${cond.selectorGone}"` };
    }
    if (cond.idleMs != null) {
      const idleFor = Date.now() - lastMutationAt;
      if (idleFor < cond.idleMs) return { met: false, reason: `DOM 仍变动中，静止 ${idleFor}/${cond.idleMs}ms` };
    }
    return { met: true };
  }

  // ---------- 消息入口 ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== 'dom-agent') return;

    let result;
    try {
      switch (msg.action) {
        case 'snapshot':
          result = buildSnapshot(msg.options || {});
          break;
        case 'click':
          result = doClick(msg.ref, msg.button);
          break;
        case 'fill':
          result = doFill(msg.ref, msg.value);
          break;
        case 'press':
          result = doPress(msg.key);
          break;
        case 'hover':
          result = doHover(msg.ref);
          break;
        case 'drag':
          result = doDrag(msg.fromRef, msg.toRef, msg.options || {});
          break;
        case 'getText':
          result = getText(msg.ref);
          break;
        case 'scroll':
          result = doScroll(msg.options || {});
          break;
        case 'checkCondition':
          result = checkCondition(msg.cond);
          break;
        case 'eval':
          result = doEval(msg.code, msg.arg);
          break;
        case 'showHighlight':
          result = showHighlight(msg.label);
          break;
        case 'hideHighlight':
          result = hideHighlight();
          break;
        default:
          result = { ok: false, error: `未知操作: ${msg.action}` };
      }
    } catch (e) {
      result = { ok: false, error: String(e && e.stack || e) };
    }
    // 同步回包：Chrome 150 下异步 sendResponse（return true + setTimeout）不可靠，
    // 会导致 SW 端 await 一直挂起、误判为"连接不存在"触发重新注入、清空 refRegistry。
    // 改为同步回包（return undefined/不 return true），sendResponse 在同步流内完成。
    sendResponse({ ok: true, data: result });
    return false; // 同步回包，无需保持通道
  });

  // 调试钩子
  window.__browserTool = { snapshot: () => buildSnapshot({ interactiveOnly: true }) };
})();
