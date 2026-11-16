/* PTA 键盘输入模拟 —— 页面脚本
 *
 * 把一段代码按真人的打字节奏逐字符敲进 PTA 的编辑器。
 * 页面拿到的每个字符都是 isTrusted === true 的真实键盘事件，
 * 全程不产生 paste / insertFromPaste，也不碰剪贴板。
 */

(function () {
  'use strict';

  const VERSION = '1.2.0';
  const HOST_ID = 'pta-typer-host';

  const S = {
    running: false,
    stopFlag: false,
    speed: 1,
    lastText: '',
    typed: 0,
    total: 0
  };

  /* ---------- 小工具 ---------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  const rand = (a, b) => a + Math.random() * (b - a);

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) resolve({ ok: false, error: err.message });
          else resolve(res || { ok: false, error: '没有响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  /* ---------- 编辑器定位 ---------- */

  /* PTA 的代码区在不同版本里换过实现，这里按可能性从高到低排。
     注意 CodeMirror 的 textarea 是视觉上隐藏的（宽高 1px），
     所以不能用「可见」来筛，只能看它在不在文档里。 */
  const EDITOR_SELS = [
    '.CodeMirror textarea',
    '.CodeMirror-code',
    '.cm-editor [contenteditable="true"]',
    '.monaco-editor textarea',
    'textarea.ace_text-input',
    '.ace_content',
    'textarea.inputarea',
    'textarea'
  ];

  function findEditor() {
    for (const sel of EDITOR_SELS) {
      const list = Array.from(document.querySelectorAll(sel));
      for (const el of list) {
        if (!el.isConnected) continue;
        if (el.closest('#pta-typer-host')) continue;
        if (el.disabled) continue;
        return el;
      }
    }
    return null;
  }

  /* 真正要 focus 的元素。CodeMirror 5 的 textarea 才是事件接收方，
     外层 .CodeMirror 只是个 div。 */
  function focusTarget(el) {
    if (!el) return null;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el;
    if (el.isContentEditable) return el;
    const ta = el.querySelector && el.querySelector('textarea');
    if (ta) return ta;
    const cm = el.closest && el.closest('.CodeMirror');
    if (cm) {
      const t = cm.querySelector('textarea');
      if (t) return t;
    }
    return el;
  }

  /* 读编辑器里的完整内容。CodeMirror 有实例就直接 getValue，
     那是唯一准确的方式 —— 它的 textarea 里永远只有一行。 */
  function editorText(el) {
    if (!el) return '';
    try {
      const wrap = el.closest && el.closest('.CodeMirror');
      if (wrap && wrap.CodeMirror && typeof wrap.CodeMirror.getValue === 'function') {
        return wrap.CodeMirror.getValue();
      }
      const cmEl = document.querySelector('.CodeMirror');
      if (cmEl && cmEl.CodeMirror && typeof cmEl.CodeMirror.getValue === 'function') {
        return cmEl.CodeMirror.getValue();
      }
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
      if (el.isContentEditable) return el.innerText || '';
      const inner = el.querySelector && el.querySelector('[contenteditable="true"]');
      if (inner) return inner.innerText || '';
      return el.innerText || '';
    } catch (_) {
      return '';
    }
  }

  function describe(el) {
    if (!el) return '（没找到）';
    const bits = [`<${el.tagName.toLowerCase()}>`];
    if (el.className) bits.push('.' + String(el.className).split(/\s+/).filter(Boolean).slice(0, 2).join('.'));
    if (el.id) bits.push('#' + el.id);
    const r = el.getBoundingClientRect();
    bits.push(`${Math.round(r.width)}x${Math.round(r.height)}`);
    const wrap = el.closest && el.closest('.CodeMirror');
    if (wrap) bits.push('在 CodeMirror 里');
    return bits.join(' ');
  }

  /* ---------- 聚焦 ---------- */

  async function ensureFocus(raw) {
    const target = focusTarget(raw);
    if (!target) return false;

    for (let i = 0; i < 6; i++) {
      try {
        const r = target.getBoundingClientRect();
        const x = r.left + Math.max(1, Math.min(r.width - 1, r.width / 2));
        const y = r.top + Math.max(1, Math.min(r.height - 1, r.height / 2));
        const opt = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
        target.dispatchEvent(new MouseEvent('mousedown', opt));
        target.dispatchEvent(new MouseEvent('mouseup', opt));
        target.dispatchEvent(new MouseEvent('click', opt));
      } catch (_) {}

      try { target.focus(); } catch (_) {}

      await sleep(60 + i * 40);

      const ae = document.activeElement;
      if (ae === target || (target.contains && target.contains(ae))) return true;
    }
    return false;
  }

  /* ---------- 打字节奏 ---------- */

  /* 节奏设计的目标不是「快」，是「像人」：
     - 常规字符 45-110ms
     - 连续空格（缩进）加速到 25-50ms，人会顺手带过
     - 换行后停顿一下，这一下最难伪装也最值得做
     - 每 40 字符左右来一次 300-700ms 的长停，像在想下一行 */
  function charDelay(ch, state) {
    let base;

    if (ch === '\n') {
      base = rand(180, 420);
    } else if (ch === ' ') {
      base = state.spaceRun > 1 ? rand(22, 48) : rand(55, 95);
    } else if (/[(){}\[\]:,]/.test(ch)) {
      base = rand(60, 130);
    } else {
      base = rand(45, 110);
    }

    if (state.sinceBreath > 40) {
      base += rand(280, 700);
      state.sinceBreath = 0;
    }
    state.sinceBreath++;

    return base * S.speed;
  }

  /* ---------- 缩进相关 ----------
   *
   * PTA 的编辑器经常会自己动手：
   *   按回车时自动补上上一行的缩进（smartIndent），
   *   或者把行首空格吃掉。
   * 结果是「我们发的缩进 + 编辑器自己补的」叠在一起变成双倍空格，
   * 或者我们的缩进被它吃掉变成没有空格。
   *
   * 所以不能傻乎乎地照发全量空格。做法是：每行开头先看编辑器当前
   * 这一行已经有多少个前导空格，再补差值 —— 它补多了就删，补少了就加。
   */

  function indentOf(line) {
    const m = /^[ \t]*/.exec(line || '');
    return m ? m[0].length : 0;
  }

  /* 读光标所在那一行的完整文字 */
  function cursorLine(raw) {
    try {
      const wrap = raw && raw.closest && raw.closest('.CodeMirror');
      const cm = (wrap && wrap.CodeMirror) || (document.querySelector('.CodeMirror') || {}).CodeMirror;
      if (cm && typeof cm.getCursor === 'function' && typeof cm.getLine === 'function') {
        const cur = cm.getCursor();
        return cm.getLine(cur.line) || '';
      }
      const t = focusTarget(raw);
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) {
        const v = t.value || '';
        const pos = typeof t.selectionStart === 'number' ? t.selectionStart : v.length;
        const before = v.slice(0, pos);
        const idx = before.lastIndexOf('\n');
        return idx < 0 ? before : before.slice(idx + 1);
      }
    } catch (_) {}
    return '';
  }

  /* 按行号读一整行。CodeMirror 有实例就精确读；否则从全文里切。
     绝不依赖隐藏 textarea 的 selectionStart —— CodeMirror 那个镜像
     只同步视口附近的内容，位置跟真实文档对不上。 */
  function lineAt(raw, i) {
    try {
      const wrap = raw && raw.closest && raw.closest('.CodeMirror');
      const cm = (wrap && wrap.CodeMirror) || (document.querySelector('.CodeMirror') || {}).CodeMirror;
      if (cm && typeof cm.getLine === 'function' && typeof i === 'number') {
        const v = cm.getLine(i);
        if (typeof v === 'string') return v;
      }
    } catch (_) {}
    if (typeof i === 'number') {
      const arr = editorText(raw).replace(/\r/g, '').split('\n');
      return arr[i] == null ? '' : arr[i];
    }
    return cursorLine(raw);
  }

  /* 按一次回车，并且确认真的换行了。
     CodeMirror 在自动补全、自动补括号的时候会把 Enter 吞掉 ——
     结果就是 else: 粘到上一行末尾变成 `n //= 2  else:`。
     判据很简单：整篇的行数有没有 +1。没有就再按一次。 */
  async function pressEnter(raw) {
    const count = () => editorText(raw).split('\n').length;
    const before = count();
    for (let i = 0; i < 3; i++) {
      const r = await send({ type: 'PTA_KEY', key: 'Enter' });
      if (r && r.ok === false) return r;
      await sleep(Math.max(150, rand(110, 240) * S.speed));
      if (count() > before) return { ok: true };
      log('  ⚠ 回车没生效（行数没变），再按一次');
    }
    return { ok: false, error: '按了三次回车都没换行' };
  }

  /* 把第 li 行整行改成 want。用于打完一行发现对不上时当场修，
     不让错误累积到后面的行。
     删的时候用 Shift+End 选中到行尾再按 Delete —— 一次删干净，
     而且不会像连按 Delete 那样把下一行并上来。
     重写同样逐字符打。整串插入会被 PTA 当成粘贴，弹「禁止复制粘贴」。 */
  async function rewriteLine(raw, li, want) {
    const cur0 = lineAt(raw, li);
    if (cur0 === want) return true;

    await send({ type: 'PTA_KEY', key: 'CtrlHome' });
    await sleep(70);
    // 走到第 li 行
    for (let i = 0; i < li; i++) {
      await send({ type: 'PTA_KEY', key: 'End' });
      await sleep(22);
      await send({ type: 'PTA_KEY', key: 'ArrowRight' });
      await sleep(22);
    }
    // 选中整行到行尾
    await send({ type: 'PTA_KEY', key: 'Home', times: 2 });
    await sleep(70);
    await send({ type: 'PTA_KEY', key: 'ShiftEnd' });
    await sleep(60);
    await send({ type: 'PTA_KEY', key: 'Delete' });
    await sleep(90);

    // 逐字符重打。不能用整串插入：PTA 会把「一次进来一整行」当成粘贴，
    // 弹「禁止复制粘贴」。
    const ind = indentOf(want);
    if (ind > 0) {
      await send({ type: 'PTA_KEY', ch: ' '.repeat(ind) });
      await sleep(60 + ind * 12);
    }
    const body = want.slice(ind);
    for (let k = 0; k < body.length; k++) {
      if (S.stopFlag) return false;
      await send({ type: 'PTA_KEY', ch: body[k] });
      await sleep(rand(10, 26));
    }
    await sleep(110);
    return lineAt(raw, li) === want;
  }

  /* 把指定行的行首缩进调整成 target 个空格。返回净补的字符数。
     传了 lineIndex 就按行号读，不传就按光标读。 */
  async function fixIndent(raw, target, lineIndex) {
    let cur = indentOf(lineAt(raw, lineIndex));
    const start = cur;
    if (cur === target) return 0;

    if (cur < target) {
      const need = target - cur;
      await send({ type: 'PTA_KEY', ch: ' '.repeat(need) });
      await sleep(40 + need * 9);
    } else {
      // 编辑器补多了：回到行首，先跨过要保留的那几个空格，再把后面的删掉
      // 注意 CodeMirror 的 Home 是 smartHome：第一次跳到第一个非空白字符，
      // 再按一次才到真正的行首，所以要连按两次。
      await send({ type: 'PTA_KEY', key: 'Home', times: 2 });
      await sleep(90);
      if (target > 0) {
        await send({ type: 'PTA_KEY', key: 'ArrowRight', times: target });
        await sleep(35 + target * 9);
      }
      await send({ type: 'PTA_KEY', key: 'Delete', times: cur - target });
      await sleep(70 + (cur - target) * 12);
    }

    cur = indentOf(lineAt(raw, lineIndex));
    // 补的空格可能和编辑器自己的自动缩进撞上，变成两倍。
    // 这里再量一次，多了就删掉多出来的那部分。
    if (cur > target) {
      await send({ type: 'PTA_KEY', key: 'Home', times: 2 });
      await sleep(90);
      if (target > 0) {
        await send({ type: 'PTA_KEY', key: 'ArrowRight', times: target });
        await sleep(35 + target * 9);
      }
      await send({ type: 'PTA_KEY', key: 'Delete', times: cur - target });
      await sleep(80 + (cur - target) * 12);
      cur = indentOf(lineAt(raw, lineIndex));
    }
    if (cur !== target) {
      log(`  ⚠ 缩进没调过来（想要 ${target} 个空格，实际 ${cur} 个）`);
    }
    return cur - start;
  }

  /* ---------- 输入主流程 ---------- */

  async function typeCode(raw, code) {
    const target = focusTarget(raw);
    if (!target) { log('✗ 找不到可以打字的元素'); return false; }

    const ok = await ensureFocus(raw);
    if (!ok) {
      log('⚠ 点不进编辑器（focus 失败），先手动点一下代码区，再点开始');
      return false;
    }
    log('✓ 已经聚焦到编辑器');

    const clean = code.replace(/\r/g, '');
    const lines = clean.split('\n');
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();

    const state = { spaceRun: 0, sinceBreath: 0 };
    let sent = 0;
    let autoIndentSeen = 0;
    let indentFixed = 0;
    let lineFixes = 0;
    let spaceFixed = 0;

    for (let li = 0; li < lines.length; li++) {
      if (S.stopFlag) { log(`⏹ 手动停止，已输入 ${S.typed} / ${S.total} 字`); return false; }

      const line = lines[li];
      const indent = indentOf(line);
      const body = line.slice(indent);

      // 换行
      if (li > 0) {
        const r = await pressEnter(raw);
        if (r && r.ok === false) {
          log(`✗ ${r.error || '回车发不出去'}`);
          failKey(r, sent);
          return false;
        }
        sent++;
        S.typed = sent; updateProgress();
        state.spaceRun = 0;
        state.sinceBreath++;
      }

      // 行首缩进自适应
      if (indent > 0 || li > 0) {
        const have = indentOf(lineAt(raw, li));
        if (li > 0 && have > 0) autoIndentSeen++;
        const delta = await fixIndent(raw, indent, li);
        if (delta !== 0) { indentFixed++; sent += delta; S.typed = sent; updateProgress(); }
      }

      // 正文
      for (let k = 0; k < body.length; k++) {
        if (S.stopFlag) { log(`⏹ 手动停止，已输入 ${S.typed} / ${S.total} 字`); return false; }
        const ch = body[k];
        if (ch === ' ') state.spaceRun++; else state.spaceRun = 0;

        if (ch === ' ') {
          // 空格照样逐按键打（整串插入会被 PTA 当成粘贴），
          // 但打完立刻量这一行的长度：正常只多 1 个字符，
          // 多 2 个就是被编辑器插成两个了，当场按 Backspace 删回去。
          const before = lineAt(raw, li).length;
          const r = await send({ type: 'PTA_KEY', ch: ' ' });
          if (r && r.ok === false) { failKey(r, sent); return false; }
          await sleep(34);

          const extra = lineAt(raw, li).length - before - 1;
          if (extra > 0 && extra <= 3) {
            for (let j = 0; j < extra; j++) {
              await send({ type: 'PTA_KEY', key: 'Backspace' });
              await sleep(14);
            }
            spaceFixed += extra;
            log(`  空格被插成 ${extra + 1} 个，已回删 ${extra} 个`);
          }
        } else {
          const r = await send({ type: 'PTA_KEY', ch });
          if (r && r.ok === false) { failKey(r, sent); return false; }
        }

        sent++;
        S.typed = sent;
        updateProgress();
        await sleep(charDelay(ch, state));
      }

      // 这一行打完当场校验：内容和缩进都要对。不对就整行重写，
      // 免得错位一路带到后面几十行去。
      await sleep(120);
      if (lineAt(raw, li) !== line) {
        const got = lineAt(raw, li);
        log(`  ⚠ 第 ${li + 1} 行不对，整行重写`);
        log(`    期望 │${visualize(line)}│`);
        log(`    实际 │${visualize(got)}│`);
        const fixedLine = await rewriteLine(raw, li, line);
        lineFixes++;
        if (!fixedLine) {
          const after = lineAt(raw, li);
          log(`  ✗ 重写后还是不对 │${visualize(after)}│ —— 后面的行可能跟着错位`);
        } else {
          log(`  ✓ 第 ${li + 1} 行重写成功`);
        }
      }
    }

    await sleep(200);
    const finalText = editorText(raw).replace(/\r/g, '');
    log(`✓ 输入完成，编辑器里 ${finalText.trimEnd().length} 字（目标 ${clean.trimEnd().length} 字）`);
    if (autoIndentSeen > 0) {
      log(`  编辑器自动补缩进 ${autoIndentSeen} 次${indentFixed ? `，已当场校正 ${indentFixed} 行` : '，没有需要校正的'}`);
    }
    if (lineFixes > 0) log(`  有 ${lineFixes} 行打完当场对不上，已逐行重写修正`);
    if (spaceFixed > 0) log(`  有 ${spaceFixed} 个空格被编辑器插成两个，已当场回删`);
    return true;
  }

  function failKey(r, sent) {
    log(`✗ 第 ${sent + 1} 个字符发不出去：${r.error}`);
    if (/debugger/i.test(r.error || '')) {
      log('  → 调试权限被拒绝了。关掉 F12 开发者工具再点开始');
    }
  }

  /* ---------- 空格检视 ---------- */

  /* 空格用 · 显示，Tab 用 → 显示，行尾空格单独标出来 ——
     不然在日志里全是空白，根本看不出差在哪。 */
  function visualize(s) {
    return String(s)
      .replace(/ /g, '·')
      .replace(/\t/g, '→');
  }

  function diffReport(expected, actual) {
    const exp = String(expected).replace(/\r/g, '').split('\n');
    const act = String(actual).replace(/\r/g, '').split('\n');

    // 末尾的空行不算差异
    while (exp.length && exp[exp.length - 1].trim() === '') exp.pop();
    while (act.length && act[act.length - 1].trim() === '') act.pop();

    if (exp.join('\n') === act.join('\n')) {
      log('✓ 逐行比对通过：内容和缩进都对得上');
      return true;
    }

    log(`— 逐行对照（目标 ${exp.length} 行 / 实际 ${act.length} 行）—`);
    const n = Math.max(exp.length, act.length);
    let bad = 0;
    const reasons = { indentMore: 0, indentLess: 0, content: 0, missing: 0, extra: 0 };

    for (let i = 0; i < n; i++) {
      const e = exp[i] === undefined ? null : exp[i];
      const a = act[i] === undefined ? null : act[i];
      if (e === a) continue;

      bad++;
      if (e === null) { reasons.extra++; }
      else if (a === null) { reasons.missing++; }
      else if (indentOf(e) !== indentOf(a)) {
        if (indentOf(a) > indentOf(e)) reasons.indentMore++;
        else reasons.indentLess++;
      } else reasons.content++;

      if (bad > 10) continue;

      const ei = e === null ? '-' : indentOf(e);
      const ai = a === null ? '-' : indentOf(a);
      if (e !== null && a !== null && ei !== ai) {
        const d = ai - ei;
        log(`  第 ${i + 1} 行：缩进 ${ai} 个空格（应为 ${ei}，${d > 0 ? '多了 ' + d : '少了 ' + (-d)}）`);
      } else if (e === null) {
        log(`  第 ${i + 1} 行：多出来的行`);
      } else if (a === null) {
        log(`  第 ${i + 1} 行：缺了这行`);
      } else {
        log(`  第 ${i + 1} 行：内容不同`);
      }
      log(`    目标 │${visualize(e === null ? '' : e)}│`);
      log(`    实际 │${visualize(a === null ? '' : a)}│`);
    }

    if (bad > 10) log(`  …（共 ${bad} 行有差异，只列了前 10 行）`);

    const parts = [];
    if (reasons.indentMore) parts.push(`缩进多了 ${reasons.indentMore} 行`);
    if (reasons.indentLess) parts.push(`缩进少了 ${reasons.indentLess} 行`);
    if (reasons.content) parts.push(`内容不同 ${reasons.content} 行`);
    if (reasons.missing) parts.push(`缺行 ${reasons.missing}`);
    if (reasons.extra) parts.push(`多行 ${reasons.extra}`);
    log(`  → 汇总：${parts.join('，')}`);

    if (reasons.indentMore) log('  → 这是编辑器自动缩进叠上去的，点「修正缩进」可以一键抹平');
    if (reasons.indentLess) log('  → 行首空格被编辑器吃掉了，点「修正缩进」可以补回来');
    return false;
  }

  /* 只修缩进，不动内容。逐行走，每行把行首调成目标值。 */
  async function fixIndentOnly(raw, code) {
    const clean = code.replace(/\r/g, '');
    const lines = clean.split('\n');
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();

    await ensureFocus(raw);
    // 全选之后光标停在选区末尾，用 Ctrl+Home 跳回文档第一个字符
    await send({ type: 'PTA_KEY', key: 'CtrlA' });
    await sleep(90);
    await send({ type: 'PTA_KEY', key: 'CtrlHome' });
    await sleep(110);

    const cur0 = indentOf(lineAt(raw, 0));
    if (cur0 < 0) { log('✗ 读不到第一行，先手动点一下代码区再试'); return; }

    let fixed = 0;
    const report = [];
    for (let li = 0; li < lines.length; li++) {
      if (S.stopFlag) { log('⏹ 已停止'); break; }
      const want = indentOf(lines[li]);
      const before = indentOf(lineAt(raw, li));
      const delta = await fixIndent(raw, want, li);
      const after = indentOf(lineAt(raw, li));
      if (delta !== 0) {
        fixed++;
        report.push(`    第 ${li + 1} 行：${before} → ${after}`);
      }
      if (after !== want) report.push(`    第 ${li + 1} 行：还是 ${after}（想要 ${want}）`);
      if (li < lines.length - 1) {
        await send({ type: 'PTA_KEY', key: 'End' });
        await sleep(45);
        await send({ type: 'PTA_KEY', key: 'ArrowRight' });
        await sleep(35);
      }
    }

    if (report.length) log(report.slice(0, 14).join('\n'));
    log(`  缩进修正完成，动了 ${fixed} 行`);

    const got = editorText(raw);
    if (got.replace(/\r/g, '') !== clean) {
      log('  ⚠ 修完之后还是和框里的代码不一致，看上面的「检视缩进」');
    }
  }

  /* 面板「检视缩进」按钮：拿编辑器里实际的内容跟框里的代码对一遍 */
  function inspectIndent() {
    const ed = findEditor();
    if (!ed) { log('✗ 找不到编辑器'); return false; }
    const want = ui.code.value;
    if (!want.trim()) { log('先把代码贴进上面的框里，才能跟编辑器里的对'); return false; }
    const got = editorText(ed);
    log('— 检视缩进 —');
    log(`  目标 ${want.trimEnd().split('\n').length} 行 / 实际 ${got.trimEnd().split('\n').length} 行`);
    return diffReport(want, got);
  }

  /* ---------- 清空 ---------- */

  async function clearEditor(raw) {
    const target = focusTarget(raw);
    if (!target) { log('✗ 找不到编辑器'); return; }
    await ensureFocus(raw);

    const before = editorText(raw).length;
    if (!before) { log('编辑器本来就是空的'); return; }

    await send({ type: 'PTA_KEY', key: 'CtrlA' });
    await sleep(rand(90, 160));
    await send({ type: 'PTA_KEY', key: 'Backspace' });
    await sleep(rand(180, 320));

    let after = editorText(raw).length;
    let guard = 0;
    while (after > 0 && guard < 5) {
      guard++;
      await send({ type: 'PTA_KEY', key: 'CtrlA' });
      await sleep(70);
      await send({ type: 'PTA_KEY', key: 'Backspace' });
      await sleep(200);
      after = editorText(raw).length;
    }

    log(after === 0 ? `✓ 清空了（原来 ${before} 字）` : `⚠ 没清干净，还剩 ${after} 字，手动按 Ctrl+A 再 Delete`);
  }

  /* ---------- 体检 ---------- */

  function inspect() {
    log('— 页面结构 —');
    log(`  地址：${location.href.slice(0, 90)}`);
    log(`  标题：${(document.title || '').slice(0, 60)}`);

    const cm = document.querySelector('.CodeMirror');
    if (cm) {
      const hasInst = !!(cm.CodeMirror && typeof cm.CodeMirror.getValue === 'function');
      log(`  CodeMirror：有，实例${hasInst ? '可用（能准确读到全文）' : '拿不到（只能读 textarea）'}`);
    } else {
      log('  CodeMirror：没有');
    }
    if (document.querySelector('.cm-editor')) log('  新版 CodeMirror 6：有');
    if (document.querySelector('.monaco-editor')) log('  Monaco：有');
    if (document.querySelector('.ace_content')) log('  Ace：有');

    const ed = findEditor();
    log(`  选中的编辑器：${describe(ed)}`);

    if (ed) {
      const t = focusTarget(ed);
      log(`  实际接收键盘的元素：${describe(t)}`);
      log(`  当前内容：${editorText(ed).length} 字`);
    }

    const tas = document.querySelectorAll('textarea').length;
    log(`  页面上 textarea 共 ${tas} 个`);

    log('— 输入通道 —');
    log('  走 CDP 真实键盘事件：isTrusted=true，inputType=insertText，无 paste');
  }

  /* ---------- AI 解题 ---------- */

  const AI_DEFAULT = {
    apiBase: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.2
  };

  let aiCfg = Object.assign({}, AI_DEFAULT);

  function loadAICfg() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('ai', (v) => {
          const saved = (v && v.ai) || {};
          aiCfg = Object.assign({}, AI_DEFAULT, saved);
          resolve(aiCfg);
        });
      } catch (_) {
        resolve(aiCfg);
      }
    });
  }

  function saveAICfg(patch) {
    aiCfg = Object.assign({}, aiCfg, patch || {});
    try { chrome.storage.local.set({ ai: aiCfg }); } catch (_) {}
    return aiCfg;
  }

  /* 题面关键词。命中越多，容器越可能是完整的题面块。 */
  const PROBLEM_KW = [
    '输入格式', '输出格式', '输入样例', '输出样例',
    '样例输入', '样例输出', '题目描述', '输入样例:', '输出样例:',
    '限制', '题目', '输入：', '输出：'
  ];

  function grabTitle() {
    const h1 = document.querySelector('h1');
    if (h1 && h1.innerText && h1.innerText.trim()) return h1.innerText.trim();
    const h = document.querySelector('[class*="problemTitle"], [class*="title"]');
    if (h && h.innerText && h.innerText.trim().length < 120) return h.innerText.trim();
    return String(document.title || '').replace(/\s*[-–|].*$/, '').trim();
  }

  /* 找题面：在所有可见容器里挑「关键词命中最多」的，
     命中数相同时取最短的那个 —— 最短的那个才最贴近题面本身，
     不会把侧栏、讨论区一起带进来。 */
  function grabProblemText() {
    const nodes = document.querySelectorAll('div, section, article, main, form');
    let best = null;

    for (const el of nodes) {
      if (el.closest('#' + HOST_ID)) continue;
      const t = (el.innerText || '').trim();
      if (t.length < 40 || t.length > 14000) continue;
      if (!el.getClientRects().length) continue;   // 不可见

      let hit = 0;
      for (const k of PROBLEM_KW) {
        if (t.indexOf(k) >= 0) hit++;
      }
      if (hit < 2) continue;

      if (!best || hit > best.hit || (hit === best.hit && t.length < best.t.length)) {
        best = { t, hit };
      }
    }

    if (best) return best.t;

    // 兜底：整页正文，掐掉尾部
    const body = String(document.body && document.body.innerText || '').trim();
    return body.length > 8000 ? body.slice(0, 8000) : body;
  }

  function buildSolveMessages(problemText, title) {
    const sys = [
      '你是正在参加编程竞赛的选手，现在要做 PTA 平台上的一道 Python 3 编程题。',
      '你的任务是给出可以直接提交、并且能通过全部测试点的完整代码。',
      '',
      '硬性要求：',
      '1. 只输出 Python 代码本身。不要解释，不要 ``` 代码块标记，不要「以下是代码」之类的开场白。',
      '2. 严格按题目给的输入格式读数据：一行一个值、一行多个值、还是多行，都要按题意来。',
      '3. 输出必须和题目要求的格式逐字符一致 —— 空格数量、换行位置、大小写、标点都不能错。',
      '4. 绝对不要输出任何提示语，比如「请输入」「结果是」。题目要求「不输出其他提示文字」时这条最要紧。',
      '5. 只用标准库，不要 import 第三方包。',
      '6. 注意边界：空输入、单个元素、极值、0、负数、重复元素。',
      '7. 题目里如果写了「使用循环」「不能用公式」这类约束，必须遵守，判题器可能会检查源码。',
      '8. 变量名用正常英文，不要用拼音。'
    ].join('\n');

    const user = [
      '题目名称：' + (title || '（未识别）'),
      '',
      '题目内容：',
      problemText,
      '',
      '请给出完整、可直接提交的 Python 代码。'
    ].join('\n');

    return [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ];
  }

  /* 模型经常忍不住加 markdown 围栏或开场白，这里统一扒掉 */
  function cleanCode(s) {
    let t = String(s || '').replace(/\r\n/g, '\n').trim();

    const fence = t.match(/```(?:python|py|python3)?\s*\n([\s\S]*?)```/i);
    if (fence) t = fence[1];

    t = t.replace(/^\s*```[a-zA-Z0-9]*\s*$/gm, '');
    t = t.replace(/```\s*$/g, '');

    // 去掉明显的开场白行（只在代码之前，且不像代码的行）
    const lines = t.split('\n');
    while (lines.length) {
      const head = lines[0].trim();
      const looksCode = /^(#|import |from |def |class |if |for |while |print\(|n\s*=|s\s*=|a\s*,|try:|with )/.test(head) || head === '';
      const looksTalk = /^(以下|下面|这是|代码|说明|解释|注意|希望|如果).{0,40}$/.test(head);
      if (looksTalk && !looksCode) { lines.shift(); continue; }
      break;
    }

    t = lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
    return t ? t + '\n' : '';
  }

  function looksLikeCode(code) {
    if (!code || code.length < 20) return false;
    const hits = [
      /input\s*\(/, /sys\.stdin/, /print\s*\(/,
      /def\s+\w+\s*\(/, /for\s+.+\s+in\s+/, /while\s+.+:/
    ];
    return hits.filter((re) => re.test(code)).length >= 2;
  }

  async function solveProblem(autoType) {
    if (S.running) { log('正在输入中，先等它跑完'); return; }

    if (!aiCfg.apiKey) {
      log('✗ 还没填 API Key');
      log('  → 展开下面的「AI 设置」，填 DeepSeek 的 sk-... 再点保存');
      if (ui && ui.cfgBox) ui.cfgBox.open = true;
      return;
    }

    const problem = grabProblemText();
    if (!problem || problem.length < 40) {
      log('✗ 抓不到题面');
      log('  → 确认你停在题目页（地址里有 /problems/），题面已经完全显示出来');
      return;
    }

    const title = grabTitle();
    log(`— AI 解题 · ${title || '未命名'} · 题面 ${problem.length} 字 —`);
    log(`  模型 ${aiCfg.model} · ${aiCfg.apiBase}`);

    if (ui) ui.btnAI.disabled = true;
    const t0 = Date.now();

    try {
      const res = await send({
        type: 'PTA_AI',
        cfg: aiCfg,
        messages: buildSolveMessages(problem, title)
      });

      if (!res || !res.ok) {
        const err = String((res && res.error) || '未知错误');
        log('✗ 调用失败：' + err);
        if (/401|403|Unauthorized|invalid.*api.*key/i.test(err)) {
          log('  → Key 不对、没余额、或者端点填错了，检查「AI 设置」');
        } else if (/404/.test(err)) {
          log('  → 404 一般是接口地址不对，DeepSeek 填 https://api.deepseek.com/v1');
        }
        return;
      }

      const code = cleanCode(res.data);
      if (!code) { log('✗ 模型返回了空内容，再点一次试试'); return; }

      ui.code.value = code;
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      log(`✓ 生成完成（${secs}s，${code.split('\n').length} 行，${code.length} 字）`);

      if (!looksLikeCode(code)) {
        log('⚠ 生成的内容不太像完整代码，先自己看一眼再输入');
      }

      diffPreview(code);

      if (autoType) {
        log('  → 接着自动输入');
        await startRun();
      } else {
        log('  代码已放进上面的框，检查没问题就点「开始输入」');
      }
    } catch (e) {
      log('✗ 出错：' + String(e && e.message || e));
    } finally {
      if (ui) ui.btnAI.disabled = false;
    }
  }

  /* 生成后立刻在日志里过一遍关键行，省得用户滚上滚下去看 */
  function diffPreview(code) {
    const lines = code.replace(/\n+$/, '').split('\n');
    log(`  首行：${lines[0] || '（空）'}`);
    if (lines.length > 1) log(`  末行：${lines[lines.length - 1]}`);
    const hasInput = /\binput\s*\(|sys\.stdin/.test(code);
    const hasPrint = /\bprint\s*\(/.test(code);
    if (!hasInput) log('  ⚠ 没有看到 input()/sys.stdin —— 这题可能确实不用读输入，也可能漏了');
    if (!hasPrint) log('  ⚠ 没有看到 print() —— 确认一下这题是不是真的不用输出');
  }

  /* 用一条最短的请求验证 Key / 端点 / 模型三件套 */
  async function testAI() {
    const cfgNow = {
      apiBase: (ui.aiBase.value.trim() || AI_DEFAULT.apiBase),
      apiKey: ui.aiKey.value.trim(),
      model: (ui.aiModel.value.trim() || AI_DEFAULT.model),
      temperature: 0
    };
    if (!cfgNow.apiKey) { log('✗ 先填 API Key 再点测试'); return; }

    log(`— 测试接口 · ${cfgNow.model} —`);
    if (ui) ui.btnAITest_ = true;
    const t0 = Date.now();

    const res = await send({
      type: 'PTA_AI',
      cfg: cfgNow,
      messages: [
        { role: 'system', content: '只回一个词。' },
        { role: 'user', content: '说“通了”。' }
      ]
    });

    if (res && res.ok) {
      log(`✓ 接口通了（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      log(`  模型回了：${String(res.data).slice(0, 40).replace(/\n/g, ' ')}`);
      saveAICfg(cfgNow);
      log('  配置已自动保存');
    } else {
      log('✗ 失败：' + String((res && res.error) || '未知错误'));
      log('  → 逐项检查：Key 有没有复制全、余额够不够、模型名对不对、地址末尾有没有多加 /');
    }
  }

  function fillAIForm() {
    if (!ui) return;
    ui.aiBase.value = aiCfg.apiBase || AI_DEFAULT.apiBase;
    ui.aiKey.value = aiCfg.apiKey || '';
    ui.aiModel.value = aiCfg.model || AI_DEFAULT.model;
    ui.aiTemp.value = (aiCfg.temperature === undefined ? AI_DEFAULT.temperature : aiCfg.temperature);
  }

  /* ---------- 面板 ---------- */

  let ui = null;

  function panelCSS() {
    return `
      :host { all: initial; }
      .wrap {
        position: fixed; right: 16px; bottom: 16px; width: 380px;
        max-height: calc(100vh - 32px);
        background: #16181d; color: #e7e9ee; border: 1px solid #2b2f38;
        border-radius: 12px; font: 13px/1.5 "Segoe UI", system-ui, sans-serif;
        box-shadow: 0 12px 40px rgba(0,0,0,.5); z-index: 2147483647;
        overflow: hidden; user-select: none;
        display: flex; flex-direction: column;
      }
      .head {
        display: flex; align-items: center; gap: 8px; padding: 9px 12px;
        background: #1c1f26; border-bottom: 1px solid #2b2f38; cursor: default;
      }
      .title { font-weight: 600; font-size: 12.5px; }
      .ver { opacity: .4; font-weight: 400; font-size: 11px; }
      .grow { flex: 1; }
      .mini {
        background: transparent; border: 0; color: #8b93a3; cursor: pointer;
        font-size: 15px; line-height: 1; padding: 2px 4px; border-radius: 4px;
      }
      .mini:hover { background: #2b2f38; color: #e7e9ee; }
      .body { padding: 10px 12px 12px; overflow-y: auto; }
      textarea {
        width: 100%; height: 150px; resize: vertical; box-sizing: border-box;
        background: #0f1116; color: #d7dbe3; border: 1px solid #2b2f38;
        border-radius: 8px; padding: 8px 9px; font: 12px/1.55 Consolas, "Cascadia Mono", monospace;
        outline: none; user-select: text;
      }
      textarea:focus { border-color: #3d6ff5; }
      .row { display: flex; gap: 7px; margin-top: 8px; }
      .btn {
        flex: 1; border: 0; border-radius: 7px; padding: 8px 10px; cursor: pointer;
        font-size: 12.5px; font-weight: 500; background: #3d6ff5; color: #fff;
      }
      .btn:hover { filter: brightness(1.1); }
      .btn:disabled { opacity: .45; cursor: default; filter: none; }
      .btn.ghost { background: #262a33; color: #c5cbd6; }
      .btn.ghost:hover { background: #2f3540; }
      .btn.warn { background: #4a2b2b; color: #f0b4b4; }
      .stat { display: flex; gap: 12px; margin-top: 8px; font-size: 11.5px; color: #8b93a3; }
      .stat b { color: #e7e9ee; font-weight: 600; }
      .bar { height: 3px; background: #23262e; border-radius: 2px; margin-top: 6px; overflow: hidden; }
      .bar > i { display: block; height: 100%; width: 0; background: #3d6ff5; transition: width .15s; }
      .log {
        margin-top: 9px; max-height: 132px; overflow-y: auto; background: #0c0e12;
        border: 1px solid #23262e; border-radius: 7px; padding: 7px 8px;
        font: 11px/1.6 Consolas, monospace; color: #97a0b0; white-space: pre-wrap;
        word-break: break-all; user-select: text;
      }
      .log div:last-child { color: #cfd6e3; }
      .hint { margin-top: 7px; font-size: 11px; color: #6b7383; line-height: 1.5; }
      .collapsed .body { display: none; }
      .btn.ai { background: linear-gradient(135deg, #6b4bf5, #3d6ff5); }
      details.cfg {
        margin-top: 8px; border: 1px solid #2b2f38; border-radius: 8px;
        background: #12141a; overflow: hidden;
      }
      details.cfg > summary {
        padding: 6px 9px; cursor: pointer; font-size: 11.5px; color: #9aa3b2;
        list-style: none; user-select: none;
      }
      details.cfg > summary::-webkit-details-marker { display: none; }
      details.cfg > summary::before { content: '▸ '; }
      details.cfg[open] > summary::before { content: '▾ '; }
      details.cfg > summary:hover { color: #e7e9ee; background: #1a1d24; }
      .cfg-body { padding: 4px 9px 9px; }
      .cfg-row { display: flex; align-items: center; gap: 7px; margin-top: 6px; }
      .cfg-row > span {
        width: 58px; flex: none; font-size: 11px; color: #7c8494;
      }
      .cfg-row > input {
        flex: 1; min-width: 0; background: #0f1116; color: #d7dbe3;
        border: 1px solid #2b2f38; border-radius: 6px; padding: 5px 7px;
        font: 11.5px/1.4 Consolas, monospace; outline: none;
      }
      .cfg-row > input:focus { border-color: #3d6ff5; }
      .cfg-tip { margin-top: 7px; font-size: 10.5px; color: #666e7d; line-height: 1.5; }
    `;
  }

  function buildPanel() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${panelCSS()}</style>
      <div class="wrap">
        <div class="head">
          <span class="title">PTA 键盘模拟 <span class="ver">v${VERSION}</span></span>
          <span class="grow"></span>
          <button class="mini" id="btnFold" title="收起">—</button>
        </div>
        <div class="body">
          <textarea id="code" placeholder="把要提交的代码贴到这里（贴到这里不会被 PTA 看到），或者点下面的「AI 解题」自动生成"></textarea>
          <div class="row">
            <button class="btn ai" id="btnAI">AI 解题</button>
            <button class="btn ghost" id="btnAIType">解题并输入</button>
          </div>
          <div class="row">
            <button class="btn" id="btnRun">开始输入</button>
            <button class="btn ghost" id="btnStop">停止</button>
          </div>
          <div class="bar"><i id="bar"></i></div>
          <div class="stat">
            <span>已输入 <b id="sTyped">0</b></span>
            <span>共 <b id="sTotal">0</b></span>
            <span>速度 <b id="sSpeed">标准</b></span>
          </div>
          <div class="row">
            <button class="btn ghost" id="btnInspect">体检</button>
            <button class="btn ghost" id="btnDiff">检视缩进</button>
            <button class="btn ghost" id="btnFixIndent">修正缩进</button>
          </div>
          <div class="row">
            <button class="btn ghost" id="btnClear">清空代码区</button>
            <button class="btn ghost" id="btnPace">节奏</button>
          </div>
          <details class="cfg" id="aiCfgBox">
            <summary>AI 设置</summary>
            <div class="cfg-body">
              <div class="cfg-row"><span>接口地址</span><input id="aiBase" spellcheck="false"></div>
              <div class="cfg-row"><span>API Key</span><input id="aiKey" type="password" spellcheck="false"></div>
              <div class="cfg-row"><span>模型</span><input id="aiModel" spellcheck="false"></div>
              <div class="cfg-row"><span>温度</span><input id="aiTemp" type="number" step="0.1" min="0" max="2"></div>
              <div class="row">
                <button class="btn" id="btnAISave">保存</button>
                <button class="btn ghost" id="btnAITest">测试</button>
              </div>
              <div class="cfg-tip">DeepSeek：地址 https://api.deepseek.com/v1，模型 deepseek-chat 或 deepseek-reasoner。Key 只存在本机浏览器里。</div>
            </div>
          </details>
          <div class="log" id="log"></div>
          <div class="hint">逐字符模拟真实按键，不触发粘贴检测。保持这个标签页在前台。</div>
        </div>
      </div>
    `;
    document.documentElement.appendChild(host);

    const $ = (id) => root.getElementById(id);
    ui = {
      host, root,
      code: $('code'),
      btnRun: $('btnRun'), btnStop: $('btnStop'),
      btnInspect: $('btnInspect'), btnClear: $('btnClear'), btnPace: $('btnPace'),
      btnDiff: $('btnDiff'), btnFixIndent: $('btnFixIndent'),
      btnFold: $('btnFold'),
      btnAI: $('btnAI'), btnAIType: $('btnAIType'),
      cfgBox: $('aiCfgBox'),
      aiBase: $('aiBase'), aiKey: $('aiKey'), aiModel: $('aiModel'), aiTemp: $('aiTemp'),
      sTyped: $('sTyped'), sTotal: $('sTotal'), sSpeed: $('sSpeed'),
      bar: $('bar'), logBox: $('log')
    };

    $('btnRun').addEventListener('click', startRun);
    $('btnStop').addEventListener('click', () => { S.stopFlag = true; });
    $('btnAI').addEventListener('click', () => solveProblem(false));
    $('btnAIType').addEventListener('click', () => solveProblem(true));
    $('btnAISave').addEventListener('click', () => {
      const cfg = saveAICfg({
        apiBase: ui.aiBase.value.trim() || AI_DEFAULT.apiBase,
        apiKey: ui.aiKey.value.trim(),
        model: ui.aiModel.value.trim() || AI_DEFAULT.model,
        temperature: Number(ui.aiTemp.value)
      });
      log(`✓ AI 设置已保存 · ${cfg.model} · ${cfg.apiBase}`);
      if (!cfg.apiKey) log('  提醒：Key 还是空的，解题会失败');
      else log('  提示：Key 前 6 位 ' + cfg.apiKey.slice(0, 6) + '…，长度 ' + cfg.apiKey.length);
    });
    $('btnAITest').addEventListener('click', testAI);
    $('btnInspect').addEventListener('click', inspect);
    $('btnDiff').addEventListener('click', inspectIndent);
    $('btnFixIndent').addEventListener('click', async () => {
      const ed = findEditor();
      if (!ed) { log('✗ 找不到编辑器'); return; }
      const want = ui.code.value;
      if (!want.trim()) { log('先把代码贴进上面的框里'); return; }
      log('— 开始修正缩进 —');
      await fixIndentOnly(ed, want);
      diffReport(want, editorText(ed));
    });
    $('btnClear').addEventListener('click', async () => {
      const ed = findEditor();
      if (ed) await clearEditor(ed);
    });
    $('btnPace').addEventListener('click', cycleSpeed);
    $('btnFold').addEventListener('click', () => {
      const w = root.querySelector('.wrap');
      w.classList.toggle('collapsed');
      ui.btnFold.textContent = w.classList.contains('collapsed') ? '+' : '—';
    });

    log(`PTA 键盘模拟 v${VERSION} 已就绪`);
    if (!aiCfg.apiKey) {
      log('AI 解题需要 API Key —— 展开「AI 设置」填一个，填一次就记住了');
    } else {
      log(`AI 已配置：${aiCfg.model} · Key ****${String(aiCfg.apiKey).slice(-4)}`);
    }
    log('用法：点「AI 解题」自动生成代码 → 点「开始输入」敲进编辑器');
  }

  function log(msg) {
    if (!ui) return;
    const line = document.createElement('div');
    line.textContent = msg;
    ui.logBox.appendChild(line);
    const kids = ui.logBox.children;
    while (kids.length > 60) ui.logBox.removeChild(kids[0]);
    ui.logBox.scrollTop = ui.logBox.scrollHeight;
  }

  function updateProgress() {
    if (!ui) return;
    ui.sTyped.textContent = S.typed;
    ui.sTotal.textContent = S.total;
    const pct = S.total ? Math.min(100, (S.typed / S.total) * 100) : 0;
    ui.bar.style.width = pct + '%';
  }

  const SPEEDS = [
    { k: 1, name: '标准' },
    { k: 0.45, name: '快速' },
    { k: 2.1, name: '慢速' }
  ];
  let speedIdx = 0;

  function cycleSpeed() {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    S.speed = SPEEDS[speedIdx].k;
    ui.sSpeed.textContent = SPEEDS[speedIdx].name;
    log(`打字速度：${SPEEDS[speedIdx].name}（基准间隔 ×${S.speed}）`);
  }

  async function startRun() {
    if (S.running) { log('正在输入中，先停止'); return; }

    const code = ui.code.value;
    if (!code.trim()) { log('先把代码贴进上面的框里'); return; }

    const ed = findEditor();
    if (!ed) {
      log('✗ 页面上找不到代码编辑器');
      log('  → 确认你停在「代码提交」那一页，代码区已经加载出来');
      return;
    }

    S.running = true;
    S.stopFlag = false;
    S.typed = 0;
    S.total = code.replace(/\r/g, '').length;
    ui.btnRun.disabled = true;
    updateProgress();

    log(`— 开始 · 共 ${S.total} 字 · ${SPEEDS[speedIdx].name} —`);
    log(`  目标编辑器：${describe(ed)}`);

    try {
      const ok = await typeCode(ed, code);
      if (ok) {
        // 输完立刻对一遍。PTA 的自动缩进只在某些行触发，
        // 光看字数是查不出来的，必须逐行比。
        // 不管对不对都不清空 —— 打完就留着，改哪行由你决定。
        const same = diffReport(code, editorText(ed));
        if (same) {
          log('🎉 全部输入完成，内容和缩进都对得上，现在点「提交本题作答」');
        } else {
          log('↑ 上面标出来的行和框里的代码不一致');
          log('  内容留着不动了。想自动对齐就点「修正缩进」，想自己改就手工改那几行');
        }
      }
    } catch (e) {
      log(`✗ 出错：${String(e && e.message || e)}`);
    } finally {
      S.running = false;
      ui.btnRun.disabled = false;
      updateProgress();
    }
  }

  /* ---------- 启动 ---------- */

  async function boot() {
    if (document.getElementById(HOST_ID)) return;
    const res = await send({ type: 'PTA_PING' });
    if (!res || !res.ok) {
      console.warn('[pta-typer] 后台没起来，扩展可能没加载好');
    }
    await loadAICfg();
    buildPanel();
    fillAIForm();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  window.__PTA_TYPER__ = {
    start: startRun,
    stop: () => { S.stopFlag = true; },
    state: () => ({ ...S }),
    inspect,
    findEditor,
    editorText: () => editorText(findEditor()),
    diff: (want, got) => diffReport(want, got === undefined ? editorText(findEditor()) : got),
    cursorLine: () => cursorLine(findEditor()),
    indentOf,
    solve: (autoType) => solveProblem(autoType === true),
    testAI,
    aiCfg: () => ({ ...aiCfg }),
    grabProblem: grabProblemText,
    grabTitle,
    cleanCode,
    looksLikeCode,
    buildSolveMessages
  };
})();
