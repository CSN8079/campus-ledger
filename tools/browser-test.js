/* ============================================================
   browser-test.js - 用 Chrome DevTools 协议在真实浏览器里跑端到端测试
   用法：
     1) 先启动本地服务： node tools/serve.js
     2) 再运行：         node tools/browser-test.js
   可选环境变量：
     CHROME_PATH  浏览器可执行文件路径
     BASE_URL     被测地址，默认 http://127.0.0.1:8788/
     SHOT_DIR     截图输出目录，默认 docs/screenshots
   ============================================================ */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8788/';
const SHOT_DIR = process.env.SHOT_DIR || path.join(ROOT, 'docs', 'screenshots');
const PORT = Number(process.env.CDP_PORT || 9333);

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('找不到 Chrome/Edge，请设置环境变量 CHROME_PATH');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('等待浏览器调试端口超时');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    const events = [];

    ws.addEventListener('open', () => resolve({
      send(method, params) {
        const id = ++nextId;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
          setTimeout(() => {
            if (pending.has(id)) { pending.delete(id); rej(new Error('CDP 超时：' + method)); }
          }, 60000);
        });
      },
      events,
      close() { try { ws.close(); } catch (e) { /* ignore */ } }
    }));

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    });

    ws.addEventListener('error', () => reject(new Error('无法连接调试端口')));
  });
}

async function main() {
  const chrome = findChrome();
  const profile = path.join(os.tmpdir(), 'jzb-cdp-' + Date.now());
  console.log('浏览器：' + chrome);
  console.log('被测地址：' + BASE_URL);

  const proc = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--window-size=430,932',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });

  let client = null;
  let exitCode = 1;
  try {
    const page = await waitForDevTools(20000);
    client = await connect(page.webSocketDebuggerUrl);
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Log.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 430, height: 932, deviceScaleFactor: 2, mobile: true
    });
    // 进入应用前先关掉自动同步，保证测试结果不受服务器上已有数据影响
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "try{localStorage.setItem('jzb:sync',JSON.stringify({autoSync:false,url:'',token:'',deviceName:'测试机',lastSyncAt:0,lastResult:null}));}catch(e){}"
    });
    await client.send('Page.navigate', { url: BASE_URL });
    await sleep(2500);

    // 生成一个「微信账单」样式的 xlsx，注入到页面里供导入测试使用
    const XlsxMod = require(path.join(ROOT, 'web', 'js', 'xlsx.js'));
    const xlsxRows = [
      ['微信支付账单明细'],
      ['微信昵称：[测试用户]'],
      ['起始时间：[2026-03-01 00:00:00] 终止时间：[2026-03-31 23:59:59]'],
      [],
      ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号', '商户单号', '备注'],
      ['2026-03-02 12:30:00', '商户消费', '校园食堂', '午餐', '支出', '¥15.01', '零钱', '支付成功', 'XL0001', 'M001', '/'],
      ['2026-03-03 19:00:00', '转账', '爸爸', '生活费', '收入', '¥2001.00', '零钱', '已存入零钱', 'XL0002', '/', '/'],
      ['2026-03-05 20:15:00', '商户消费', '美团', '外卖晚餐', '支出', '¥32.51', '零钱通', '支付成功', 'XL0003', 'M003', '/'],
      ['2026-03-08 07:00:00', '零钱提现', '零钱提现', '提现到银行卡', '不计收支', '¥500.01', '零钱', '提现成功', 'XL0004', '/', '/']
    ];
    const xlsxB64 = Buffer.from(XlsxMod.build([{ name: '账单明细', rows: xlsxRows }])).toString('base64');

    const suiteExpr = fs.readFileSync(path.join(ROOT, 'tests', 'browser-suite.js'), 'utf8')
      .replace('__XLSX_FIXTURE__', xlsxB64);

    console.log('正在运行端到端测试…\n');
    const res = await client.send('Runtime.evaluate', {
      expression: suiteExpr,
      awaitPromise: true,
      returnByValue: true,
      timeout: 120000
    });

    let suiteValue = null;
    if (res.exceptionDetails) {
      console.error('测试脚本抛出异常：');
      console.error(JSON.stringify(res.exceptionDetails, null, 2).slice(0, 2000));
      exitCode = 1;
    } else {
      const value = res.result && res.result.value;
      suiteValue = value;
      if (!value || !value.results) {
        console.error('未取得测试结果：', JSON.stringify(res).slice(0, 1000));
      } else {
        value.results.forEach((r) => console.log((r.ok ? '  \u2713 ' : '  \u2717 ') + r.msg));
        console.log('\n' + '='.repeat(54));
        console.log('端到端测试：通过 ' + value.summary.pass + ' 项，失败 ' + value.summary.fail + ' 项');
        console.log('库内账目 ' + value.summary.txCount + ' 条，分类 ' + value.summary.catCount + ' 个');
        console.log('='.repeat(54));
        exitCode = value.summary.fail ? 1 : 0;
      }
    }

    /* ---------- 保存测试中生成的报表文件，便于人工检查 ---------- */
    if (suiteValue && suiteValue.artifacts) {
      const outDir = path.join(ROOT, 'tests', 'out');
      fs.mkdirSync(outDir, { recursive: true });
      if (suiteValue.artifacts.xlsx) {
        const f = path.join(outDir, 'report.xlsx');
        fs.writeFileSync(f, Buffer.from(suiteValue.artifacts.xlsx.b64, 'base64'));
        console.log('报表文件：' + path.relative(ROOT, f) + '（' + fs.statSync(f).size + ' 字节）');
      }
      if (suiteValue.artifacts.png) {
        const f = path.join(outDir, 'report-image.png');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, Buffer.from(suiteValue.artifacts.png.b64, 'base64'));
        console.log('报告图片：' + path.relative(ROOT, f) + '（' + fs.statSync(f).size + ' 字节）');
      }
    }

    /* ---------- 截图 ---------- */
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const shots = [
      ['home', 'overview'],
      ['list', 'detail'],
      ['stats', 'statistics'],
      ['settings', 'settings']
    ];
    for (const [tab, name] of shots) {
      await client.send('Runtime.evaluate', { expression: 'UI.go("' + tab + '")' });
      await sleep(500);
      const shot = await client.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(SHOT_DIR, name + '.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log('截图已保存：' + path.relative(ROOT, file));
    }
    // 同步面板截图（展示状态卡与进度条）
    await client.send('Runtime.evaluate', {
      expression: 'window.AndroidApp={setSyncHost:function(){}};'
        + 'Sync.config.url="192.168.1.7:8788"; Sync.config.token="demo";'
        + 'Sync.config.lastSyncAt=Date.now(); Sync.config.lastResult={pushed:3,pulled:12,removed:1,serverTotal:156};'
        + 'UI.go("settings");'
        + 'setTimeout(function(){ UI.openSyncSheet();'
        + 'setTimeout(function(){ Sync.setProgress(60,"电脑正在合并数据…",""); },500); },250);'
    });
    await sleep(1700);
    const shotSync = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, 'sync-panel.png'), Buffer.from(shotSync.data, 'base64'));
    console.log('截图已保存：' + path.relative(ROOT, path.join(SHOT_DIR, 'sync-panel.png')));
    await client.send('Runtime.evaluate', {
      expression: 'Sync.clearProgress(); UI.closeSheet(); delete window.AndroidApp;'
        + 'Sync.config.url=""; Sync.config.token=""; Sync.config.lastSyncAt=0; Sync.config.lastResult=null;'
    });
    await sleep(400);

    // 导入预览截图（展示每行可切换「计入 / 不计入」）
    await client.send('Runtime.evaluate', {
      expression: '(function(){'
        + 'var csv=["交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注",'
        + '"2026-10-08 12:30:00,商户消费,校园食堂,午餐,支出,¥15.00,零钱,支付成功,PV0001,M001,/",'
        + '"2026-10-08 19:00:00,转账,爸爸,生活费,收入,¥2000.00,零钱,已存入零钱,PV0002,/,/",'
        + '"2026-10-09 07:00:00,零钱提现,零钱提现,提现到银行卡,不计收支,¥500.00,零钱,提现成功,PV0003,/,/",'
        + '"2026-10-09 20:00:00,商户消费,美团,外卖,支出,¥32.50,零钱通,支付成功,PV0004,M002,/"].join("\\n");'
        + 'UI.state.importSource={kind:"csv",text:csv,name:"示例账单.csv",encoding:"UTF-8"};'
        + 'UI.openImportSheet();'
        + 'setTimeout(function(){var b=document.querySelectorAll("#sheetRoot button");'
        + 'for(var i=0;i<b.length;i++){if(b[i].textContent.indexOf("重新解析")>=0){b[i].click();break;}}},700);'
        + '})()'
    });
    await sleep(1800);
    const shotPrev = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, 'import-preview.png'), Buffer.from(shotPrev.data, 'base64'));
    console.log('截图已保存：' + path.relative(ROOT, path.join(SHOT_DIR, 'import-preview.png')));
    await client.send('Runtime.evaluate', { expression: 'UI.closeSheet(); UI.state.importSource=null;' });
    await sleep(400);

    // 导入选项面板截图
    await client.send('Runtime.evaluate', {
      expression: 'UI.go("home"); setTimeout(function(){ UI.openImportSheet(); setTimeout(function(){ var s=document.querySelector("#sheetRoot .sheet"); if(s) s.scrollTop = 430; }, 500); }, 200);'
    });
    await sleep(1800);
    const shotImp = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, 'import-options.png'), Buffer.from(shotImp.data, 'base64'));
    console.log('截图已保存：' + path.relative(ROOT, path.join(SHOT_DIR, 'import-options.png')));
    await client.send('Runtime.evaluate', { expression: 'UI.closeSheet();' });
    await sleep(400);

    // 清理数据面板截图
    await client.send('Runtime.evaluate', { expression: 'UI.go("settings"); setTimeout(function(){ UI.openClearDataSheet(); }, 200);' });
    await sleep(1200);
    const shot4 = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, 'clear-data.png'), Buffer.from(shot4.data, 'base64'));
    console.log('截图已保存：' + path.relative(ROOT, path.join(SHOT_DIR, 'clear-data.png')));
    await client.send('Runtime.evaluate', { expression: 'UI.closeSheet();' });
    await sleep(400);

    // 记账表单截图
    await client.send('Runtime.evaluate', { expression: 'UI.go("home"); setTimeout(function(){ UI.openTxSheet(null); }, 200);' });
    await sleep(900);
    const shot2 = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, 'add-transaction.png'), Buffer.from(shot2.data, 'base64'));
    console.log('截图已保存：' + path.relative(ROOT, path.join(SHOT_DIR, 'add-transaction.png')));

    /* ---------- 控制台错误 ---------- */
    const consoleErrors = client.events
      .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      .map((e) => (e.params.args || []).map((a) => a.value || a.description || '').join(' '));
    const exceptions = client.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => (e.params.exceptionDetails && e.params.exceptionDetails.text) || '');
    if (consoleErrors.length || exceptions.length) {
      console.log('\n浏览器控制台报错：');
      consoleErrors.slice(0, 10).forEach((m) => console.log('  [console] ' + m));
      exceptions.slice(0, 10).forEach((m) => console.log('  [exception] ' + m));
      exitCode = 1;
    } else {
      console.log('\n浏览器控制台无报错。');
    }
  } catch (e) {
    console.error('运行失败：' + (e && e.message));
    exitCode = 1;
  } finally {
    if (client) client.close();
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      proc.kill('SIGKILL');
    }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  process.exit(exitCode);
}

main();