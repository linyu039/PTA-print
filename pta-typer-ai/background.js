/* PTA 键盘输入模拟 —— 后台
 *
 * 职责：用 Chrome DevTools Protocol 往页面里发真实的键盘事件。
 * 这是唯一能让页面看到 isTrusted === true 的输入方式，
 * 也是唯一能保证 inputType 是 insertText（而不是 insertFromPaste）的方式。
 *
 * 为什么不用 content script 里的 execCommand：
 *   它产生的事件 isTrusted === false，稍微像样一点的检测都能认出来。
 */

const DBG_VERSION = '1.3';

let attachedTab = null;

async function dbgAttach(tabId) {
  if (attachedTab === tabId) return;
  if (attachedTab !== null) await dbgDetach().catch(() => {});
  try {
    await chrome.debugger.attach({ tabId }, DBG_VERSION);
  } catch (e) {
    const msg = String(e && e.message || e);
    // 已经挂着（比如用户开着 F12）不算失败
    if (!/already attached/i.test(msg)) throw e;
  }
  attachedTab = tabId;
}

async function dbgDetach() {
  if (attachedTab === null) return;
  const id = attachedTab;
  attachedTab = null;
  try { await chrome.debugger.detach({ tabId: id }); } catch (_) {}
}

function dbgSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(res);
    });
  });
}

/* 可打印 ASCII 的虚拟键码。只覆盖最常用的那批，
   其余字符（中文、emoji、全角）统一走 insertText。 */
const VK = {
  ' ': 32, '!': 49, '"': 222, '#': 51, '$': 52, '%': 53, '&': 55, "'": 222,
  '(': 57, ')': 48, '*': 56, '+': 187, ',': 188, '-': 189, '.': 190, '/': 191,
  '0': 48, '1': 49, '2': 50, '3': 51, '4': 52, '5': 53, '6': 54, '7': 55, '8': 56, '9': 57,
  ':': 186, ';': 186, '<': 188, '=': 187, '>': 190, '?': 191, '@': 50,
  'A': 65, 'B': 66, 'C': 67, 'D': 68, 'E': 69, 'F': 70, 'G': 71, 'H': 72, 'I': 73,
  'J': 74, 'K': 75, 'L': 76, 'M': 77, 'N': 78, 'O': 79, 'P': 80, 'Q': 81, 'R': 82,
  'S': 83, 'T': 84, 'U': 85, 'V': 86, 'W': 87, 'X': 88, 'Y': 89, 'Z': 90,
  '[': 219, '\\': 220, ']': 221, '^': 54, '_': 189, '`': 192,
  '{': 219, '|': 220, '}': 221, '~': 192
};

const CODE = (ch) => {
  const u = ch.toUpperCase();
  if (/[A-Z]/.test(u)) return 'Key' + u;
  if (/[0-9]/.test(ch)) return 'Digit' + ch;
  return '';
};

const SHIFTED = '~!@#$%^&*()_+{}|:"<>?';

/* 单个可见字符：完整的 keyDown → keyUp 序列，和真人按一下键一模一样 */
async function typeChar(tabId, ch) {
  const vk = VK[ch] || (VK[ch.toUpperCase()] || 0);
  // 大写字母和上面那批符号都要按着 Shift 才打得出来
  const modifiers = (SHIFTED.includes(ch) || /[A-Z]/.test(ch)) ? 8 : 0;

  if (!vk) {
    // 中文、emoji、全角标点：没有对应的物理键，走输入法提交路径
    await dbgSend(tabId, 'Input.insertText', { text: ch });
    return;
  }

  await dbgSend(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: ch,
    code: CODE(ch),
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    text: ch,
    unmodifiedText: ch,
    modifiers: modifiers
  });
  await dbgSend(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: ch,
    code: CODE(ch),
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers: modifiers
  });
}

/* 换行：真实的 Enter 键 */
async function typeEnter(tabId) {
  await dbgSend(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r'
  });
  await dbgSend(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
  });
}

/* Tab：用来让编辑器自动缩进（很多编辑器按 Tab 补空格） */
async function typeTab(tabId) {
  await dbgSend(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Tab', code: 'Tab',
    windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, text: '\t'
  });
  await dbgSend(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Tab', code: 'Tab',
    windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9
  });
}

/* 光标移动与删除。修缩进全靠它们：
   行首多了空格 → Home 之后按 Delete；
   行首少了空格 → 直接补空格。 */
const NAV = {
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ShiftEnd: { key: 'End', code: 'End', vk: 35, modifiers: 8 },
  ShiftHome: { key: 'Home', code: 'Home', vk: 36, modifiers: 8 },
  CtrlA: { key: 'a', code: 'KeyA', vk: 65, modifiers: 2 },
  CtrlHome: { key: 'Home', code: 'Home', vk: 36, modifiers: 2 },
  CtrlEnd: { key: 'End', code: 'End', vk: 35, modifiers: 2 }
};

async function pressNav(tabId, name, times) {
  const k = NAV[name];
  if (!k) return;
  const n = Math.max(1, times | 0);
  const base = {
    key: k.key, code: k.code,
    windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
    modifiers: k.modifiers || 0
  };
  for (let i = 0; i < n; i++) {
    await dbgSend(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, base));
    await dbgSend(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  }
}

/* 退格：打错字时用 */
async function typeBackspace(tabId, times) {
  const n = Math.max(1, times | 0);
  for (let i = 0; i < n; i++) {
    await dbgSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Backspace', code: 'Backspace',
      windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
    });
    await dbgSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace',
      windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
    });
  }
}

/* 全选：清空整段代码时用 */
async function selectAll(tabId) {
  const base = { code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 };
  await dbgSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', text: '', ...base });
  await dbgSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', ...base });
}

async function handleKey(tabId, msg) {
  await dbgAttach(tabId);
  // 整串一次插入：等价于输入法上屏，inputType 是 insertText，
  // 不产生 paste。逐字符打会被编辑器的自动行为放大（空格变两个），
  // 修错行的时候用这条路最稳。
  if (typeof msg.text === 'string') {
    await dbgSend(tabId, 'Input.insertText', { text: msg.text });
    return;
  }
  if (msg.key === 'Enter') return typeEnter(tabId);
  if (msg.key === 'Tab') return typeTab(tabId);
  if (msg.key === 'Backspace') return typeBackspace(tabId, msg.times || 1);
  if (msg.key === 'CtrlA') return selectAll(tabId);
  if (NAV[msg.key]) return pressNav(tabId, msg.key, msg.times || 1);
  const ch = String(msg.ch || '');
  for (const c of ch) await typeChar(tabId, c);
}

/* ---------- AI 解题 ----------
 *
 * 放在后台而不是页面里，理由有两条：
 *   1. 页面脚本发 fetch 会被 PTA 的 CSP 拦掉；
 *   2. API Key 只在后台内存里过一遍，不会出现在页面上下文。
 */

const AI_DEFAULT_BASE = 'https://api.deepseek.com/v1';

function normalizeBase(base) {
  let b = String(base || AI_DEFAULT_BASE).trim();
  if (!b) b = AI_DEFAULT_BASE;
  b = b.replace(/\/+$/, '');
  if (!/\/chat\/completions$/i.test(b)) {
    if (/\/v\d+$/i.test(b)) b += '/chat/completions';
    else b += '/v1/chat/completions';
  }
  return b;
}

async function callAI(cfg, messages) {
  const url = normalizeBase(cfg.apiBase);
  const body = {
    model: cfg.model || 'deepseek-chat',
    messages: messages || [],
    stream: false
  };
  const t = Number(cfg.temperature);
  if (Number.isFinite(t)) body.temperature = t;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + String(cfg.apiKey || '')
      },
      body: JSON.stringify(body),
      signal: ctl.signal
    });

    const raw = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        error: 'HTTP ' + res.status + '：' + String(raw).slice(0, 400)
      };
    }

    let data;
    try { data = JSON.parse(raw); }
    catch (_) { return { ok: false, error: '返回不是 JSON：' + String(raw).slice(0, 200) }; }

    const choice = data && data.choices && data.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (!content) {
      const reason = (data && data.error && data.error.message) || '模型返回空内容';
      return { ok: false, error: reason };
    }
    return { ok: true, data: content, model: body.model };
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/abort/i.test(msg)) return { ok: false, error: '请求超时（120 秒没返回）' };
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/* 调试器被外部关掉（用户点「取消」）时清理状态 */
chrome.debugger.onDetach.addListener((src) => {
  if (attachedTab !== null && src.tabId === attachedTab) attachedTab = null;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;

  if (msg && msg.type === 'PTA_PING') {
    sendResponse({ ok: true, data: 'pong' });
    return false;
  }

  if (msg && msg.type === 'PTA_AI') {
    callAI(msg.cfg || {}, msg.messages || [])
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  if (msg && msg.type === 'PTA_KEY') {
    if (tabId == null) { sendResponse({ ok: false, error: '拿不到标签页 ID' }); return false; }
    handleKey(tabId, msg)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  if (msg && msg.type === 'PTA_DETACH') {
    dbgDetach().then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});
