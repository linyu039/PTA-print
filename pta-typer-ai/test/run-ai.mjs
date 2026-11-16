/* AI 解题：验证「抓题 → 组装 prompt → 清洗模型输出 → 回填输入框」整条链。
   mock 里的 PTA_AI 分支会检查 prompt 里是否真的带上了题面内容。 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9350;
const MOCK = new URL('./mock-pta.html', import.meta.url).href;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'pta-ai-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
      return r.result.value;
    };

    const until = async (expr, timeout = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (await evaluate(expr)) return true;
        await sleep(120);
      }
      return false;
    };

    await sleep(900);

    /* ---------- 1. 面板与按钮存在 ---------- */
    console.log('\n[1] 面板渲染');
    check('面板已注入', await evaluate(`!!document.getElementById('pta-typer-host')`));
    const hasAI = await evaluate(`!!document.getElementById('pta-typer-host').shadowRoot.getElementById('btnAI')`);
    check('有「AI 解题」按钮', hasAI);
    const ver = await evaluate(`document.getElementById('pta-typer-host').shadowRoot.querySelector('.ver').textContent`);
    check('版本号是 v1.2.0', ver === 'v1.2.0', ver);

    /* ---------- 2. 抓题 ---------- */
    console.log('\n[2] 抓题');
    const prob = await evaluate(`window.__PTA_TYPER__.grabProblem()`);
    check('抓到了题面', typeof prob === 'string' && prob.length > 50, 'len=' + (prob || '').length);
    check('题面含「输入格式」', prob.includes('输入格式'));
    check('题面含「输出样例」', prob.includes('输出样例'));
    check('题面含具体数据 7385', prob.includes('7385'));
    const grabbedTitle = await evaluate(`window.__PTA_TYPER__.grabTitle()`);
    check('抓到标题', /时间转换器/.test(grabbedTitle), grabbedTitle);

    /* ---------- 3. 没 Key 时给出提示，不发请求 ---------- */
    console.log('\n[3] 没配 Key 的路径');
    await evaluate(`window.__aiCalls = 0;`);
    await evaluate(`window.__PTA_TYPER__.solve(false)`);
    await sleep(500);
    const logText1 = await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('log').innerText`);
    check('提示要填 Key', /还没填 API Key|API Key/.test(logText1));
    const cfgOpened = await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('aiCfgBox').open === true`);
    check('自动展开了 AI 设置', cfgOpened);

    /* ---------- 4. 配好 Key 后正常解题 ---------- */
    console.log('\n[4] 正常解题');
    await evaluate(`
      window.__MOCK_AI_CFG__ = { apiKey: 'sk-mock-1234567890', model: 'deepseek-chat', apiBase: 'https://api.deepseek.com/v1' };
      window.__PTA_TYPER__; true;
    `);
    // 直接改内存里的 aiCfg：走 UI 保存更真实
    await evaluate(`
      (() => {
        const r = document.getElementById('pta-typer-host').shadowRoot;
        r.getElementById('aiKey').value = 'sk-mock-1234567890';
        r.getElementById('aiModel').value = 'deepseek-chat';
        r.getElementById('aiBase').value = 'https://api.deepseek.com/v1';
        r.getElementById('btnAISave').click();
        return true;
      })()
    `);
    await sleep(200);
    const savedCfg = await evaluate(`window.__PTA_TYPER__.aiCfg()`);
    check('配置已保存进内存', savedCfg.apiKey === 'sk-mock-1234567890', JSON.stringify(savedCfg));
    check('storage 里也有', await evaluate(`(window.__MOCK_AI_CFG__||{}).apiKey === 'sk-mock-1234567890'`));

    await evaluate(`window.__aiSawProblem = false;`);
    await evaluate(`window.__PTA_TYPER__.solve(false)`);
    const solved = await until(`document.getElementById('pta-typer-host').shadowRoot.getElementById('code').value.length > 10`);
    check('代码回填进输入框', solved);

    const codeVal = await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('code').value`);
    check('没有 ``` 围栏', !codeVal.includes('```'), JSON.stringify(codeVal.slice(0, 40)));
    check('三行核心逻辑都在', /divmod\(total, 3600\)/.test(codeVal) && /print\(h, m, s\)/.test(codeVal));

    check('prompt 里带上了题面', await evaluate(`window.__aiSawProblem === true`));
    const msgBody = await evaluate(`window.__lastAI.messages[1].content`);
    check('prompt 含题面原文', msgBody.includes('输入格式') && msgBody.includes('7385'));
    check('prompt 含标题', /时间转换器/.test(msgBody));
    const sysMsg = await evaluate(`window.__lastAI.messages[0].content`);
    check('system 里要求只输出代码', /只输出 Python 代码/.test(sysMsg));
    check('system 里要求不要提示语', /不要输出任何提示语/.test(sysMsg));

    const logText2 = await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('log').innerText`);
    check('日志报告了生成成功', /生成完成/.test(logText2));

    /* ---------- 5. 失败路径 ---------- */
    console.log('\n[5] 接口报错');
    await evaluate(`window.__PTA_TYPER__.grabProblem; window.__MOCK_AI_FAIL__ = true; true;`);
    await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('code').value = '';`);
    await evaluate(`window.__PTA_TYPER__.solve(false)`);
    await until(`/调用失败/.test(document.getElementById('pta-typer-host').shadowRoot.getElementById('log').innerText)`);
    const logText3 = await evaluate(`document.getElementById('pta-typer-host').shadowRoot.getElementById('log').innerText`);
    check('报出了调用失败', /调用失败/.test(logText3));
    check('提示检查 Key', /Key 不对|检查「AI 设置」/.test(logText3));

    /* ---------- 6. cleanCode 各种脏输出 ---------- */
    console.log('\n[6] 清洗模型输出');
    const cases = [
      ['带 python 围栏', '```python\nprint(1)\n```', 'print(1)'],
      ['带裸围栏', '```\nprint(2)\n```', 'print(2)'],
      ['带开场白', '以下是代码：\nprint(3)', 'print(3)'],
      ['围栏+开场白+结尾说明', '这是实现：\n```python\nx = 1\nprint(x)\n```\n希望有帮助', 'x = 1'],
      ['纯代码原样', 'a = 1\nprint(a)', 'a = 1']
    ];
    for (const [name, input, expectHead] of cases) {
      const out = await evaluate(`window.__PTA_TYPER__.cleanCode(${JSON.stringify(input)})`);
      const head = String(out).split('\n')[0];
      const noFence = !String(out).includes('```');
      check(`${name} → 首行「${expectHead}」`, head === expectHead && noFence, `实际「${head}」`);
    }

    check('looksLikeCode 认得正常代码', await evaluate(`window.__PTA_TYPER__.looksLikeCode('n = int(input())\\nprint(n * 2)')`));
    check('looksLikeCode 拒掉纯文字', !(await evaluate(`window.__PTA_TYPER__.looksLikeCode('这题很简单，你只要把输入乘以二就可以了。')`)));

  } finally {
    try { ws && ws.close(); } catch (_) {}
    child.kill();
    await sleep(300);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch(e => { console.error('跑挂了：', e); process.exitCode = 1; });
