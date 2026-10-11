/* ============================================================
   server.test.js - 服务器端测试：访问控制 + 数据同步 + 冲突合并
   运行： node tests/server.test.js
   ============================================================ */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 18899;
const BASE = 'http://127.0.0.1:' + PORT;
const PW = '135790';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jzb-srv-'));
const CFG = path.join(tmp, 'server.json');
const DATA = path.join(tmp, 'data.json');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } }
function eq(a, b, m) { ok(a === b, m + '  → 期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); }
function section(t) { console.log('\n' + t); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
let token = '';

async function api(p, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  if (cookie) headers['Cookie'] = cookie;
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + p, Object.assign({}, opts, { headers: headers, redirect: 'manual' }));
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookie && setCookie.length) cookie = setCookie[0].split(';')[0];
  return res;
}

function tx(id, amount, updatedAt, extra) {
  return Object.assign({
    id: id, type: 'expense', amount: amount, time: Date.now(),
    dateKey: '2026-10-11', categoryId: 'c1', categoryName: '餐饮',
    counterparty: '食堂', item: '午餐', account: '微信',
    excludeStat: false, hidden: false, source: 'manual',
    createdAt: updatedAt, updatedAt: updatedAt
  }, extra || {});
}

(async () => {
  /* 启动服务器（本机也要求口令，方便测试认证逻辑） */
  const proc = spawn(process.execPath,
    [path.join(ROOT, 'tools', 'serve.js'), '--port', String(PORT), '--password', PW, '--auth-all'],
    { env: Object.assign({}, process.env, { JZB_CONFIG_FILE: CFG, JZB_DATA_FILE: DATA }), stdio: 'ignore' });

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(150);
    try { const r = await fetch(BASE + '/', { redirect: 'manual' }); up = r.status > 0; } catch (e) { /* 继续等 */ }
  }
  if (!up) { console.error('服务器未能启动'); proc.kill(); process.exit(1); }

  try {
    section('1. 访问控制');
    let res = await fetch(BASE + '/', { headers: { Accept: 'text/html' } });
    let html = await res.text();
    eq(res.status, 200, '未登录访问首页返回 200');
    ok(html.indexOf('请输入口令') >= 0 || html.indexOf('访问口令') >= 0, '未登录时返回的是登录页而不是应用');

    res = await fetch(BASE + '/api/ping');
    eq(res.status, 401, '未登录调用接口返回 401');

    res = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: '000000' })
    });
    eq(res.status, 401, '口令错误时拒绝登录');

    res = await api('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PW, remember: true })
    });
    let j = await res.json();
    eq(res.status, 200, '口令正确时登录成功');
    eq(j.ok, true, '登录返回 ok');
    ok(!!j.token, '登录返回令牌（供安卓 App 使用）');
    token = j.token;
    ok(!!cookie && cookie.indexOf('jzb_auth=') === 0, '登录下发了 Cookie（供浏览器自动登录）');

    res = await api('/api/ping');
    j = await res.json();
    eq(res.status, 200, '登录后可以调用接口');
    eq(j.txCount, 0, '服务器初始没有账目');
    ok(j.serverTime > 0, '返回服务器时间');

    res = await api('/', { headers: { Accept: 'text/html' } });
    html = await res.text();
    ok(html.indexOf('大学生活记账本') >= 0 && html.indexOf('js/app.js') >= 0, '登录后返回应用首页');

    section('2. 跨源支持（安卓 App 直连）');
    res = await fetch(BASE + '/api/sync', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.local',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization'
      }
    });
    eq(res.status, 204, '预检请求返回 204');
    eq(res.headers.get('access-control-allow-origin'), 'https://app.local', '允许应用外壳的跨源请求');
    ok((res.headers.get('access-control-allow-headers') || '').toLowerCase().indexOf('authorization') >= 0, '允许携带认证请求头');

    section('3. 数据同步与冲突合并');
    const t1 = tx('tx-1', 10, 1000);
    const t2 = tx('tx-2', 20, 1000);
    res = await api('/api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: '电脑', tx: [t1, t2], categories: [], tombstones: [] })
    });
    j = await res.json();
    eq(j.stats.serverTx, 2, '首次同步写入 2 条账目');
    eq(j.stats.pushed, 2, '报告上传了 2 项');

    // 旧版本不应覆盖新版本
    res = await api('/api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx: [tx('tx-1', 999, 500)], categories: [], tombstones: [] })
    });
    j = await res.json();
    const onServer = j.tx.find((x) => x.id === 'tx-1');
    eq(onServer.amount, 10, '时间戳更旧的修改不会覆盖服务器上的新数据');

    // 新版本应覆盖
    res = await api('/api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx: [tx('tx-1', 15, 2000)], categories: [], tombstones: [] })
    });
    j = await res.json();
    eq(j.tx.find((x) => x.id === 'tx-1').amount, 15, '时间戳更新的修改会覆盖服务器数据');

    // 另一台设备拉取
    res = await api('/api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: '手机', tx: [tx('tx-3', 30, 3000)], categories: [], tombstones: [] })
    });
    j = await res.json();
    eq(j.stats.serverTx, 3, '多设备合并后共 3 条');
    ok(j.tx.some((x) => x.id === 'tx-2'), '另一台设备能拿到服务器上已有的数据');

    section('4. 删除同步（墓碑）');
    res = await api('/api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx: [], categories: [], tombstones: [{ id: 'tx-2', at: 5000 }] })
    });
    j = await res.json();
    eq(j.tx.filter((x) => x.id === 'tx-2').length, 0, '被删除的账目从服务器移除');
    eq(j.tombstones.filter((x) => x.id === 'tx-2').length, 1, '返回删除记录，避免被别的设备推回来');

    res = await api('/api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx: [tx('tx-2', 20, 1000)], categories: [], tombstones: [] })
    });
    j = await res.json();
    eq(j.tx.filter((x) => x.id === 'tx-2').length, 0, '已被删除的数据不会被旧设备重新推上来');

    section('5. 设置同步');
    res = await api('/api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tx: [], categories: [], tombstones: [],
        settings: { weekStart: 1, semesters: [{ id: 's1', name: '2026 秋季学期', start: '2026-09-01', end: '2027-01-15' }] },
        settingsUpdatedAt: 8000
      })
    });
    j = await res.json();
    eq(j.settings.weekStart, 1, '设置同步到服务器');

    res = await api('/api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx: [], categories: [], tombstones: [], settings: { weekStart: 0 }, settingsUpdatedAt: 1000 })
    });
    j = await res.json();
    eq(j.settings.weekStart, 1, '时间戳更旧的设置不会覆盖新设置');

    section('6. 登录失败限速');
    let blocked = false;
    for (let i = 0; i < 10; i++) {
      const r = await fetch(BASE + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-' + i })
      });
      if (r.status === 429) { blocked = true; break; }
    }
    ok(blocked, '连续输错口令后会被暂时锁定');

    section('7. 数据持久化');
    await sleep(600);
    ok(fs.existsSync(DATA), '服务器把数据写入了磁盘文件');
    const saved = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    ok(Object.keys(saved.tx).length === 2, '磁盘上保存了 2 条账目（共 3 条，删除 1 条）');

    section('8. 单个请求出错不会让服务退出');
    res = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{ 这不是合法的 JSON'
    });
    ok([400, 401, 429].indexOf(res.status) >= 0, '畸形请求得到正常回应（HTTP ' + res.status + '），没有把服务弄崩');

    /* 请求中途断开：最容易把服务带崩的场景 */
    for (let i = 0; i < 3; i++) {
      try {
        const ctrl = new AbortController();
        const p = fetch(BASE + '/api/sync', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
          body: JSON.stringify({
            deviceName: '断开测试',
            tx: new Array(30).fill(0).map((_, k) => tx('cut-' + i + '-' + k, 1, 1000)),
            categories: [], tombstones: []
          }),
          signal: ctrl.signal
        });
        setTimeout(() => ctrl.abort(), 1);
        await p.catch(() => {});
      } catch (e) { /* 预期内 */ }
    }

    /* 更狠一点：直接建 socket 发一半就断开 */
    await new Promise((resolve) => {
      const net = require('node:net');
      const sock = net.connect(PORT, '127.0.0.1', () => {
        sock.write('POST /api/sync HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 999999\r\n\r\n{"tx":[');
        setTimeout(() => { sock.destroy(); resolve(); }, 30);
      });
      sock.on('error', () => resolve());
    });

    await sleep(600);
    res = await api('/api/ping');
    j = await res.json();
    eq(res.status, 200, '几次中途断开之后，服务依然存活（这就是「按任意键继续」那个问题）');
    eq(j.ok, true, '接口仍然正常返回');
  } catch (e) {
    fail++;
    console.log('\n测试过程中出错：' + e.message);
    console.log(e.stack);
  } finally {
    proc.kill();
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  console.log('\n' + '='.repeat(52));
  console.log('服务器测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('='.repeat(52));
  process.exit(fail ? 1 : 0);
})();