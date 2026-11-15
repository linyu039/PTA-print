/* 验证 CDP 真实键盘通道：不经过扩展，直接用 DevTools Protocol 往页面发按键，
   确认字真的进得去、事件是真的、且不触发任何粘贴。 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9348;
const MOCK = new URL('./mock-pta.html', import.meta.url).href;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'pta-cdp-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
}

const VK = { a: 65, b: 66, c: 67, ' ': 32, '\n': 13 };

async function typeChar(send, ch) {
  const vk = VK[ch] || ch.toUpperCase().charCodeAt(0);
  const code = ch === '\n' ? 'Enter' : (/[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : '');
  const key = ch === '\n' ? 'Enter' : ch;
  const text = ch === '\n' ? '\r' : ch;
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    text, unmodifiedText: text
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk
  });
}

async function main() {
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    '--allow-file-access-from-files', MOCK], { stdio: 'ignore' });

  let ws, id = 0; const pend = new Map();
  try {
    let target = null;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
        if (target) break;
      } catch (_) {}
    }
    if (!target) throw new Error('连不上调试端口');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    });

    const send = (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pend.set(i, m => m.error ? rej(new Error(m.error.message)) : res(m.result));
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    };

    await send('Runtime.enable');
    await sleep(800);

    // headless 下没有真实焦点，必须开焦点模拟，否则按键事件到不了页面
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await evaluate(`document.getElementById('code').focus(); window.__MOCK.reset(); true`);
    await sleep(200);

    const focused = await evaluate(`document.activeElement === document.getElementById('code')`);
    check('编辑器拿到焦点', focused);

    // 逐字符打 "abc"，验证普通字符
    for (const ch of 'abc') { await typeChar(send, ch); await sleep(30); }
    let v = await evaluate(`window.__MOCK.text`);
    check('普通字符能打进去', v === 'abc', `实际=${JSON.stringify(v)}`);

    // 空格
    await typeChar(send, ' '); await sleep(30);
    v = await evaluate(`window.__MOCK.text`);
    check('空格能打进去', v === 'abc ', `实际=${JSON.stringify(v)}`);

    // 回车
    await typeChar(send, '\n'); await sleep(30);
    await typeChar(send, 'd'); await sleep(30);
    v = await evaluate(`window.__MOCK.text`);
    check('回车换行有效', v === 'abc \nd', `实际=${JSON.stringify(v)}`);

    // 中文走 insertText
    await send('Input.insertText', { text: '中文' });
    await sleep(60);
    v = await evaluate(`window.__MOCK.text`);
    check('中文走 insertText 能进去', v.endsWith('中文'), `实际=${JSON.stringify(v)}`);

    // 事件真实性：CDP 派发的按键，isTrusted 必须是 true
    const flags = await evaluate(`window.__trustedFlags || []`);
    check('keydown 事件 isTrusted 全为 true', flags.length > 0 && flags.every(Boolean), JSON.stringify(flags.slice(0, 5)));

    // 粘贴统计
    const paste = await evaluate(`window.__MOCK.paste`);
    const fromPaste = await evaluate(`window.__MOCK.fromPaste`);
    check('零 paste 事件', paste === 0, `paste=${paste}`);
    check('零 insertFromPaste', fromPaste === 0, `fromPaste=${fromPaste}`);

    const keys = await evaluate(`window.__stats.keys`);
    check('页面收到 keydown', keys > 0, `keys=${keys}`);

    const finalText = await evaluate(`window.__MOCK.text`);
    console.log(`\n最终内容：${JSON.stringify(finalText)}`);

    const verdict = await evaluate(`document.getElementById('verdict').innerText`);
    console.log(`检测结论：${verdict}`);
    check('仿真台判定为干净', /干净/.test(verdict), verdict);

  } finally {
    try { ws && ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await sleep(200);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('崩了：', e.message); process.exit(1); });
