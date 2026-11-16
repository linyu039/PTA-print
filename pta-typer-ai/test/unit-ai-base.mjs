/* normalizeBase：把用户随手填的接口地址补成完整端点。
   四种写法都要能落到 .../chat/completions。 */

import vm from 'node:vm';
import fs from 'node:fs';

const code = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const ctx = {
  chrome: {
    debugger: { onDetach: { addListener() {} }, attach: async () => {}, detach: async () => {}, sendCommand() {} },
    runtime: { onMessage: { addListener() {} }, lastError: null }
  },
  fetch: async () => {},
  console,
  setTimeout,
  clearTimeout,
  AbortController
};
vm.createContext(ctx);
vm.runInContext(code, ctx);

const { normalizeBase } = ctx;
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
}

const cases = [
  ['空值走默认', '', 'https://api.deepseek.com/v1/chat/completions'],
  ['只有域名', 'https://api.deepseek.com', 'https://api.deepseek.com/v1/chat/completions'],
  ['带 /v1', 'https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/chat/completions'],
  ['带 /v1/ 尾斜杠', 'https://api.deepseek.com/v1/', 'https://api.deepseek.com/v1/chat/completions'],
  ['完整端点原样', 'https://api.deepseek.com/v1/chat/completions', 'https://api.deepseek.com/v1/chat/completions'],
  ['第三方中转带 /v1', 'https://relay.example.com/v1', 'https://relay.example.com/v1/chat/completions'],
  ['第三方中转裸域名', 'https://relay.example.com', 'https://relay.example.com/v1/chat/completions'],
  ['带空格', '  https://api.deepseek.com/v1  ', 'https://api.deepseek.com/v1/chat/completions'],
  ['自定义端口', 'http://127.0.0.1:8080/v1', 'http://127.0.0.1:8080/v1/chat/completions']
];

for (const [name, input, expect] of cases) {
  const got = normalizeBase(input);
  check(name, got === expect, `得到 ${got}`);
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exitCode = 1;
