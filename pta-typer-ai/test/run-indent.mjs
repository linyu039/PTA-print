/* 缩进检视与自适应：验证 PTA 自动补缩进 / 吃缩进这两种情况下，
   插件都能把最终内容对齐到目标。 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9349;
const MOCK = new URL('./mock-pta.html', import.meta.url).href;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'pta-indent-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CODE = [
  'def f(x):',
  '    if x > 0:',
  '        return x * 2',
  '    return 0'
].join('\n');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
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
    await sleep(900);

    for (let i = 0; i < 40; i++) {
      if (await evaluate(`!!window.__PTA_TYPER__`)) break;
      await sleep(200);
    }

    await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('btnPace').click()`);

    /* ---- 1. diffReport 能不能认出双倍缩进 ---- */
    const d1 = await evaluate(`window.__PTA_TYPER__.diff(
      ${JSON.stringify('if x:\n    return 1')},
      ${JSON.stringify('if x:\n        return 1')}
    )`);
    check('检视能认出缩进翻倍', d1 === false);

    const d2 = await evaluate(`window.__PTA_TYPER__.diff(
      ${JSON.stringify('if x:\n    return 1')},
      ${JSON.stringify('if x:\n    return 1')}
    )`);
    check('一致时检视返回 true', d2 === true);

    const d3 = await evaluate(`window.__PTA_TYPER__.diff(
      ${JSON.stringify('if x:\n    return 1')},
      ${JSON.stringify('if x:\nreturn 1')}
    )`);
    check('检视能认出缩进丢失', d3 === false);

    /* ---- 2. 编辑器自动补缩进（会导致翻倍）---- */
    const runOnce = async (flagExpr) => {
      await evaluate(`(() => {
        window.__MOCK_AUTO_INDENT__ = ${flagExpr};
        window.__MOCK_EAT_INDENT__ = false;
        const root = document.getElementById('pta-typer-host').shadowRoot;
        root.getElementById('code').value = ${JSON.stringify(CODE)};
        window.__MOCK.reset();
        return true;
      })()`);
      await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('btnRun').click()`);
      for (let i = 0; i < 260; i++) {
        await sleep(200);
        if (!(await evaluate(`window.__PTA_TYPER__.state().running`))) break;
      }
      return await evaluate(`window.__MOCK.text`);
    };

    const got1 = await runOnce('true');
    check('自动缩进开着时，结果没有双倍空格', got1 === CODE,
      `\n---期望---\n${CODE}\n---实际---\n${got1}`);
    if (got1 !== CODE) {
      const t = await evaluate(`window.__MOCK.trail`);
      const idx = t.findIndex(s => /KEY Enter/.test(s));
      console.log('--- 从第一次回车起的键序 ---');
      console.log(t.slice(Math.max(0, idx - 2)).join('\n'));
    }

    const trail1 = await evaluate(`window.__MOCK.trail`);
    const autoCount = trail1.filter(t => /自动缩进/.test(t)).length;
    check('仿真台确实触发过自动缩进', autoCount > 0, `autoCount=${autoCount}`);

    /* ---- 3. 关掉自动缩进，正常路径 ---- */
    const got2 = await runOnce('false');
    check('自动缩进关着时，结果同样正确', got2 === CODE,
      `\n---期望---\n${CODE}\n---实际---\n${got2}`);

    /* ---- 4. 检视按钮不报错 ---- */
    await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('btnDiff').click()`);
    await sleep(600);
    const logs = await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('log').innerText`);
    check('检视按钮正常输出', /检视缩进|\u2713 逐行比对/.test(logs));

    /* ---- 5. 编辑器吃行首空格：输入后靠「修正缩进」补回来 ---- */
    await evaluate(`(() => {
      window.__MOCK_AUTO_INDENT__ = false;
      window.__MOCK_EAT_INDENT__ = true;
      const root = document.getElementById('pta-typer-host').shadowRoot;
      root.getElementById('code').value = ${JSON.stringify(CODE)};
      window.__MOCK.reset();
      return true;
    })()`);
    await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('btnRun').click()`);
    for (let i = 0; i < 260; i++) {
      await sleep(200);
      if (!(await evaluate(`window.__PTA_TYPER__.state().running`))) break;
    }

    await evaluate(`window.__MOCK_EAT_INDENT__ = false`);
    await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('btnFixIndent').click()`);
    await sleep(1200);
    const got3 = await evaluate(`window.__MOCK.text`);
    check('吃掉行首空格后，修正缩进能补回来', got3 === CODE,
      `\n---期望---\n${CODE}\n---实际---\n${got3}`);

    const logs5 = await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('log').innerText`);
    check('日志里说清楚了是缩进被吃', /缩进|空格/.test(logs5));

    /* ---- 6. CodeMirror 的 smartHome：第一次 Home 只到第一个非空白 ---- */
    await evaluate(`(() => {
      window.__MOCK_AUTO_INDENT__ = true;
      window.__MOCK_EAT_INDENT__ = false;
      window.__MOCK_SMART_HOME__ = true;
      const root = document.getElementById('pta-typer-host').shadowRoot;
      root.getElementById('code').value = ${JSON.stringify(CODE)};
      window.__MOCK.reset();
      return true;
    })()`);
    await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('btnRun').click()`);
    for (let i = 0; i < 260; i++) {
      await sleep(200);
      if (!(await evaluate(`window.__PTA_TYPER__.state().running`))) break;
    }
    const got4 = await evaluate(`window.__MOCK.text`);
    check('smartHome 环境下缩进依然正确', got4 === CODE,
      `\n---期望---\n${CODE}\n---实际---\n${got4}`);

    /* ---- 7. smartHome 下「修正缩进」也能把错的扭回来 ---- */
    await evaluate(`(() => {
      window.__MOCK_SMART_HOME__ = true;
      window.__MOCK_AUTO_INDENT__ = false;
      const root = document.getElementById('pta-typer-host').shadowRoot;
      root.getElementById('code').value = ${JSON.stringify(CODE)};
      window.__MOCK.reset();
      return true;
    })()`);
    await evaluate(`(() => {
      const ta = document.getElementById('code');
      ta.value = ['def f(x):','if x > 0:','return x * 2','return 0'].join('\\n');
      return true;
    })()`);
    await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('btnFixIndent').click()`);
    await sleep(1500);
    const got5 = await evaluate(`window.__MOCK.text`);
    check('smartHome 下修正缩进能把丢掉的缩进补回来', got5 === CODE,
      `\n---期望---\n${CODE}\n---实际---\n${got5}`);

    const logs7 = await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('log').innerText`);
    check('修正缩进打出了每行的前后变化', /第 \d+ 行：\d+ → \d+/.test(logs7),
      logs7.split('\n').slice(-10).join('\n'));

    /* ---- 8. 行内空格被插成两个：打完当场重写这一行，不累积 ---- */
    const CODE8 = [
      'n = int(input())',
      'if n % 2 == 0:',
      '    print("even")',
      'else:',
      '    print("odd")'
    ].join('\n');
    await evaluate(`(() => {
      window.__MOCK_DOUBLE_SPACE__ = true;
      window.__MOCK_AUTO_INDENT__ = false;
      window.__MOCK_EAT_INDENT__ = false;
      window.__MOCK_SMART_HOME__ = false;
      const root = document.getElementById('pta-typer-host').shadowRoot;
      root.getElementById('code').value = ${JSON.stringify(CODE8)};
      window.__MOCK.reset();
      return true;
    })()`);
    await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('btnRun').click()`);
    for (let i = 0; i < 400; i++) {
      await sleep(200);
      if (!(await evaluate(`window.__PTA_TYPER__.state().running`))) break;
    }
    const got6 = await evaluate(`window.__MOCK.text`);
    check('空格被插成两个时，当场回删后内容正确', got6 === CODE8,
      `\n---期望---\n${CODE8}\n---实际---\n${got6}`);

    const logs8 = await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('log').innerText`);
    check('日志里报了「空格被插成两个，已回删」', /空格被插成 2 个，已回删/.test(logs8),
      logs8.split('\n').slice(-14).join('\n'));

    /* ---- 9. 回车被吞掉：else: 不能粘到上一行 ---- */
    const CODE9 = [
      'while n != 1:',
      '    if n % 2 == 0:',
      '        n //= 2',
      '    else:',
      '        n = 3 * n + 1'
    ].join('\n');
    await evaluate(`(() => {
      window.__MOCK_DOUBLE_SPACE__ = false;
      window.__MOCK_AUTO_INDENT__ = true;
      window.__MOCK_EAT_INDENT__ = false;
      window.__MOCK_SMART_HOME__ = false;
      window.__MOCK_EAT_ENTER__ = true;
      enterEaten = 0;
      const root = document.getElementById('pta-typer-host').shadowRoot;
      root.getElementById('code').value = ${JSON.stringify(CODE9)};
      window.__MOCK.reset();
      return true;
    })()`);
    await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('btnRun').click()`);
    for (let i = 0; i < 400; i++) {
      await sleep(200);
      if (!(await evaluate(`window.__PTA_TYPER__.state().running`))) break;
    }
    const got9 = await evaluate(`window.__MOCK.text`);
    check('回车被吞后自动重按，每行都分开了', got9 === CODE9,
      `\n---期望---\n${CODE9}\n---实际---\n${got9}`);

    const logs9 = await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('log').innerText`);
    check('日志里报了「回车没生效」并重按', /回车没生效（行数没变），再按一次/.test(logs9),
      logs9.split('\n').slice(-12).join('\n'));

    console.log('\n--- 面板日志尾部 ---');
    console.log(logs.split('\n').slice(-18).join('\n'));

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
