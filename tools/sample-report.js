/* ============================================================
   sample-report.js - 用一批示例数据生成报表，检查排版效果
   用法： node tools/sample-report.js
   产物： docs/screenshots/report-image.png
          tests/out/report.xlsx
   ============================================================ */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8788/';
const PORT = Number(process.env.CDP_PORT || 9336);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const c = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium'];
  for (const p of c) if (fs.existsSync(p)) return p;
  throw new Error('找不到浏览器，请设置 CHROME_PATH');
}

/* 在页面里执行的脚本：造数据 -> 生成两种报表 -> 返回 base64 */
const EXPR = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  while (!(window.Store && window.Store.loaded) && Date.now() - t0 < 15000) await wait(60);

  await DB.clearAll();
  Store.tx = []; Store.categories = []; Store.reindex();
  await Store.applyPack('college', true);
  Store.emit('all');

  const catId = (name) => (Store.categories.find((c) => c.name === name) || {}).id;
  const now = new Date();
  const Y = now.getFullYear(), M = now.getMonth();
  const rows = [];

  // 支出：商户、用途、分类、次数、金额区间
  const patterns = [
    ['校园食堂', '午餐', '餐饮', 14, 8, 18],
    ['美团', '外卖', '餐饮', 9, 18, 42],
    ['瑞幸咖啡', '生椰拿铁', '餐饮', 6, 13, 19],
    ['上海地铁', '地铁票款', '交通', 10, 3, 6],
    ['滴滴出行', '打车', '交通', 4, 12, 35],
    ['当当网', '教材', '学习', 3, 35, 88],
    ['淘宝', '生活用品', '购物', 5, 20, 120],
    ['京东', '数据线', '数码', 2, 29, 79],
    ['屈臣氏', '洗护用品', '日用', 3, 25, 60],
    ['中国移动', '话费充值', '通讯', 1, 50, 50],
    ['美团单车', '骑行', '交通', 8, 1.5, 3],
    ['健身房', '月卡', '运动', 1, 199, 199],
    ['学校超市', '零食', '日用', 7, 8, 26],
    ['药店', '感冒药', '医疗', 1, 23, 23]
  ];
  patterns.forEach((p) => {
    for (let i = 0; i < p[3]; i++) {
      const day = 1 + Math.floor(Math.random() * Math.min(now.getDate(), 28));
      const amount = Math.round((p[4] + Math.random() * (p[5] - p[4])) * 100) / 100;
      rows.push({
        type: 'expense', amount: amount,
        time: new Date(Y, M, day, 8 + Math.floor(Math.random() * 12), Math.floor(Math.random() * 60)).getTime(),
        categoryId: catId(p[2]), categoryName: p[2],
        account: Math.random() > 0.5 ? '微信' : '支付宝',
        counterparty: p[0], item: p[1], source: 'manual'
      });
    }
  });
  // 收入
  rows.push({ type: 'income', amount: 2000, time: new Date(Y, M, 2, 10, 0).getTime(),
    categoryId: catId('生活费'), categoryName: '生活费', account: '微信', counterparty: '爸爸', item: '本月生活费', source: 'manual' });
  rows.push({ type: 'income', amount: 800, time: new Date(Y, M, 6, 15, 30).getTime(),
    categoryId: catId('兼职'), categoryName: '兼职', account: '银行卡', counterparty: '家教中心', item: '家教课时费', source: 'manual' });
  rows.push({ type: 'income', amount: 500, time: new Date(Y, M, 9, 11, 0).getTime(),
    categoryId: catId('奖学金'), categoryName: '奖学金', account: '银行卡', counterparty: '学校财务处', item: '院级奖学金', source: 'manual' });
  // 报销（不计入统计）
  const book = { type: 'expense', amount: 320, time: new Date(Y, M, 7, 14, 0).getTime(),
    categoryId: catId('学习'), categoryName: '学习', account: '现金',
    counterparty: '教务处', item: '教材费垫付', excludeStat: true, excludeReason: '报销',
    reimburseStatus: 'done', reimburseRole: 'out', source: 'manual' };
  book.reimburseGroupId = 'rg-demo';
  rows.push(book);
  rows.push({ type: 'income', amount: 320, time: new Date(Y, M, 10, 20, 0).getTime(),
    categoryId: catId('报销'), categoryName: '报销', account: '微信',
    counterparty: '爸爸', item: '报销款：教材费垫付', excludeStat: true, excludeReason: '报销',
    reimburseStatus: 'done', reimburseRole: 'in', reimburseGroupId: 'rg-demo', source: 'manual' });

  await Store.addManyTx(rows);

  const savedFiles = [];
  window.AndroidApp = { save: function (name, b64) { savedFiles.push({ name: name, b64: b64 }); } };
  const range = Stats.range('month');
  const list = Store.query({ from: range.from, to: range.to, includeExcluded: true, includeHidden: true });

  const xlsxName = Report.exportExcel({ list: list, range: range });
  const pngName = await Report.exportImage({ list: list, range: range });
  await wait(900);

  const x = savedFiles.find((f) => f.name === xlsxName);
  const p = savedFiles.find((f) => f.name === pngName);
  delete window.AndroidApp;
  return {
    txCount: Store.tx.length,
    range: range.label,
    xlsx: x ? { name: x.name, b64: x.b64 } : null,
    png: p ? { name: p.name, b64: p.b64 } : null
  };
})()`;

(async () => {
  const chrome = findChrome();
  const profile = path.join(os.tmpdir(), 'jzb-sample-' + Date.now());
  const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--hide-scrollbars', '--window-size=430,932', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

  let ws = null;
  try {
    let page = null;
    for (let i = 0; i < 100 && !page; i++) {
      await sleep(200);
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch (e) { /* 重试 */ }
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
    const send = (method, params) => new Promise((res) => {
      const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: "try{localStorage.setItem('jzb:sync',JSON.stringify({autoSync:false,url:'',token:'',deviceName:'示例',lastSyncAt:0,lastResult:null}));"
        + "localStorage.setItem('jzb:backupLastAt', String(Date.now()));}catch(e){}"
    });
    await send('Page.navigate', { url: BASE_URL });
    await sleep(2500);

    const msg = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
    const res = msg.result || {};
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 600));
    const v = res.result && res.result.value;
    if (!v) throw new Error('没有取到生成结果：' + JSON.stringify(res).slice(0, 400));

    console.log('示例数据：' + v.txCount + ' 条账目，区间 ' + v.range);
    fs.mkdirSync(path.join(ROOT, 'tests', 'out'), { recursive: true });
    if (v.xlsx) {
      const f = path.join(ROOT, 'tests', 'out', 'report.xlsx');
      fs.writeFileSync(f, Buffer.from(v.xlsx.b64, 'base64'));
      console.log('Excel：' + path.relative(ROOT, f) + '（' + fs.statSync(f).size + ' 字节）');
    }
    if (v.png) {
      const f = path.join(ROOT, 'docs', 'screenshots', 'report-image.png');
      fs.writeFileSync(f, Buffer.from(v.png.b64, 'base64'));
      console.log('图片：' + path.relative(ROOT, f) + '（' + fs.statSync(f).size + ' 字节）');
    }
  } catch (e) {
    console.error('失败：' + e.message);
    process.exitCode = 1;
  } finally {
    if (ws) { try { ws.close(); } catch (e) { /* 忽略 */ } }
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else proc.kill('SIGKILL');
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
})();