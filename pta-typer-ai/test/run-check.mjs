/* 端到端检查：headless Chrome 打开仿真台，让 content.js 真的跑一遍输入流程，
   然后断言「代码完全一致」且「零粘贴事件」。 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9346;
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MOCK = new URL('./mock-pta.html', import.meta.url).href;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'pta-typer-'));

const CODE = [
  'n = int(input())',
  'total = 0',
  'for i in range(1, n + 1):',
  '    total += i',
  'print(total)'
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
}

async function main() {
  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    '--allow-file-access-from-files',
    MOCK
  ], { stdio: 'ignore' });

  let ws = null;
  let msgId = 0;
  const pending = new Map();

  try {
    // 等 CDP 端口起来
    let target = null;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        const list = await res.json();
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (target) break;
      } catch (_) {}
    }
    if (!target) throw new Error('连不上 Chrome 调试端口');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });

    const sendRaw = (method, params) => new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, (m) => m.error ? reject(new Error(m.error.message)) : resolve(m.result));
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });

    const evaluate = async (expr) => {
      const r = await sendRaw('Runtime.evaluate', {
        expression: expr, awaitPromise: true, returnByValue: true
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
      return r.result.value;
    };

    await sendRaw('Runtime.enable');
    await sleep(800);

    // 等面板与编辑器就绪
    let ready = false;
    for (let i = 0; i < 40; i++) {
      ready = await evaluate(`!!(document.getElementById('pta-typer-host') && window.__PTA_TYPER__)`);
      if (ready) break;
      await sleep(200);
    }
    check('面板已注入', ready);
    if (!ready) throw new Error('面板没出来');

    const edInfo = await evaluate(`(() => {
      const ed = window.__PTA_TYPER__.findEditor();
      return ed ? ed.tagName + '|' + (ed.className || '') : null;
    })()`);
    check('能找到编辑器', !!edInfo, String(edInfo));
    console.log(`    选中的编辑器：${edInfo}`);

    // 切到快速档，缩短测试时间
    await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('btnPace').click()`);

    // 塞代码并开始
    await evaluate(`(() => {
      const root = document.getElementById('pta-typer-host').shadowRoot;
      root.getElementById('code').value = ${JSON.stringify(CODE)};
      window.__MOCK.reset();
      root.getElementById('btnRun').click();
      return true;
    })()`);

    // 等跑完
    let running = true;
    for (let i = 0; i < 200; i++) {
      await sleep(200);
      running = await evaluate(`window.__PTA_TYPER__.state().running`);
      if (!running) break;
    }
    check('输入流程结束', !running);

    const typed = await evaluate(`window.__PTA_TYPER__.state().typed`);
    check('输入字符数匹配', typed === CODE.replace(/\r/g, '').length, `typed=${typed} 期望=${CODE.length}`);

    const got = await evaluate(`window.__MOCK.text`);
    check('编辑器内容完全一致', got === CODE, `\n---期望---\n${CODE}\n---实际---\n${got}`);

    const paste = await evaluate(`window.__MOCK.paste`);
    check('零 paste 事件', paste === 0, `paste=${paste}`);

    const fromPaste = await evaluate(`window.__MOCK.fromPaste`);
    check('零 insertFromPaste', fromPaste === 0, `fromPaste=${fromPaste}`);

    const keys = await evaluate(`window.__STATS_KEYS__ || window.__stats.keys`);
    check('产生过真实按键', keys > 50, `keys=${keys}`);

    // 再测一次清空
    await evaluate(`(() => {
      const root = document.getElementById('pta-typer-host').shadowRoot;
      root.getElementById('btnClear').click();
      return true;
    })()`);
    await sleep(1400);
    const afterClear = await evaluate(`window.__MOCK.text`);
    check('清空代码区有效', afterClear === '', `还剩 ${afterClear.length} 字`);

    const logs = await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('log').innerText`);
    check('日志里没有致命错误', !/✗ 出错/.test(logs), logs.split('\n').filter(l => l.includes('✗')).join(' / '));
    console.log('\n--- 面板日志 ---');
    console.log(logs);

  } finally {
    try { ws && ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await sleep(300);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试崩了：', e.message);
  process.exit(1);
});
