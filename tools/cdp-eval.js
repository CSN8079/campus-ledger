/* ============================================================
   cdp-eval.js - 在真实浏览器里执行一段 JS 并打印结果（调试用）
   用法： node tools/cdp-eval.js "表达式" [--url http://127.0.0.1:8788/]
   ============================================================ */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const URL_ = urlIdx >= 0 ? args[urlIdx + 1] : 'http://127.0.0.1:8788/';
const expr = args.filter((a, i) => (urlIdx < 0 ? true : (i !== urlIdx && i !== urlIdx + 1))).join(' ');
const PORT = Number(process.env.CDP_PORT || 9334);
const WIDTH = Number(process.env.VIEW_WIDTH || 430);
const HEIGHT = Number(process.env.VIEW_HEIGHT || 932);

if (!expr) { console.error('用法： node tools/cdp-eval.js "JS表达式"'); process.exit(2); }

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const c = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium'];
  for (const p of c) if (fs.existsSync(p)) return p;
  throw new Error('找不到浏览器');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chrome = findChrome();
  const profile = path.join(os.tmpdir(), 'jzb-eval-' + Date.now());
  const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--window-size=' + WIDTH + ',' + HEIGHT, '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, URL_], { stdio: 'ignore' });

  let ws = null;
  try {
    let page = null;
    for (let i = 0; i < 100 && !page; i++) {
      await sleep(200);
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch (e) { /* retry */ }
    }
    if (!page) throw new Error('调试端口未就绪');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });

    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: true });
    await sleep(2500);

    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) console.error('异常：', JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    else if (r.result && r.result.result) console.log(JSON.stringify(r.result.result.value !== undefined ? r.result.result.value : r.result.result.description, null, 2));
    else console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error('失败：' + e.message);
  } finally {
    if (ws) { try { ws.close(); } catch (e) {} }
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else proc.kill('SIGKILL');
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
  process.exit(0);
})();