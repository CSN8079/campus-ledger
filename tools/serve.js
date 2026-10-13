/* ============================================================
   serve.js - 本地服务器（零依赖）
   除了提供网页应用，还负责：
     1. 访问控制：局域网访问需要口令，本机访问免口令，登录后可长期免输
     2. 数据同步：手机与电脑互相推送、按时间戳自动合并新旧数据
     3. 跨源支持：安卓 App 外壳可以直接连过来同步数据
   用法： node tools/serve.js [--port 8788] [--open] [--password 123456] [--no-auth]
   ============================================================ */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { exec } = require('node:child_process');
const dgram = require('node:dgram');

const ROOT = path.join(__dirname, '..');
const WEB_ROOT = path.join(ROOT, 'web');
const CONFIG_FILE = process.env.JZB_CONFIG_FILE || path.join(ROOT, '.server.json');
const DATA_FILE = process.env.JZB_DATA_FILE || path.join(ROOT, '.sync-data.json');
const BACKUP_DIR = process.env.JZB_BACKUP_DIR || path.join(ROOT, 'backups');
const BACKUP_KEEP = Number(process.env.JZB_BACKUP_KEEP || 30);
const BACKUP_HOURS = Number(process.env.JZB_BACKUP_HOURS || 12);

/* ---------------- 命令行参数 ---------------- */
const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const OPT = {
  port: Number(argValue('--port', process.env.PORT || 8788)),
  bind: argValue('--bind', '0.0.0.0'),
  open: argv.includes('--open'),
  noAuth: argv.includes('--no-auth'),
  authAll: argv.includes('--auth-all'),
  password: argValue('--password', '')
};

/* ---------------- 配置 ----------------
   口令与签名密钥保存在项目根的 .server.json（已被 .gitignore 排除） */
function loadConfig() {
  let cfg = {};
  try { if (fs.existsSync(CONFIG_FILE)) cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { cfg = {}; }
  let changed = false;
  if (!cfg.secret) { cfg.secret = crypto.randomBytes(24).toString('hex'); changed = true; }
  if (OPT.password) { cfg.password = String(OPT.password).trim(); changed = true; }
  if (!cfg.password) {
    cfg.password = String(Math.floor(100000 + Math.random() * 900000));  // 6 位数字
    changed = true;
  }
  if (changed) {
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); } catch (e) { /* 只读目录时忽略 */ }
  }
  return cfg;
}
const CONFIG = loadConfig();
const TOKEN = crypto.createHmac('sha256', CONFIG.secret).update('jizhangben-auth-v1').digest('hex');
const COOKIE_NAME = 'jzb_auth';

/* ---------------- 访问控制 ---------------- */
function isLocalRequest(req) {
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '';
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function isAuthenticated(req) {
  if (OPT.noAuth) return true;
  if (!OPT.authAll && isLocalRequest(req)) return true; // 电脑本机默认免口令
  const auth = req.headers.authorization || '';
  if (auth === 'Bearer ' + TOKEN) return true;           // 安卓 App 用令牌
  const cookies = parseCookies(req.headers.cookie);
  return cookies[COOKIE_NAME] === TOKEN;                 // 浏览器用 Cookie（可长期免输）
}

/* 登录失败限速：同一 IP 连续失败 8 次后锁定 5 分钟 */
const loginFails = new Map();
function loginBlocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec || rec.count < 8) return 0;
  const left = rec.until - Date.now();
  if (left > 0) return Math.ceil(left / 1000);
  loginFails.delete(ip);   // 锁定期已过，重新计数
  return 0;
}
function noteLoginFail(ip) {
  const rec = loginFails.get(ip) || { count: 0, until: 0 };
  rec.count++;
  if (rec.count >= 8) rec.until = Date.now() + 5 * 60 * 1000;
  loginFails.set(ip, rec);
}

/* ---------------- 手机自动配对 ----------------
   手机 App 点「自动找电脑」时，会往局域网广播一个探测包，
   这里回一个带地址和口令的包，手机上就不用手输任何东西。
   为了不让口令一直在校园网里飘，只在「配对窗口」打开时才回应：
   服务启动后 5 分钟内自动打开，也可以在电脑网页上点一下重新打开。 */
const DISCOVER_PORT = Number(process.env.JZB_DISCOVER_PORT || 8789);
const PROBE = 'JIZHANGBEN_DISCOVER';
let pairUntil = Date.now() + 5 * 60 * 1000;

function pairWindowOpen() { return Date.now() < pairUntil; }
function openPairWindow(ms) {
  const span = ms || 120000;
  pairUntil = Date.now() + span;
  return pairUntil;
}

/* 挑一个「和手机同一个网段」的地址，手机多半能直接连上 */
function bestAddressFor(peer) {
  const list = lanAddresses().map((i) => i.address);
  const p = String(peer || '').split('.');
  if (p.length === 4) {
    const same = list.find((a) => a.split('.').slice(0, 3).join('.') === p.slice(0, 3).join('.'));
    if (same) return same;
  }
  return list[0] || '127.0.0.1';
}

let discoverSock = null;
function startDiscovery() {
  try {
    discoverSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    discoverSock.on('message', (msg, rinfo) => {
      if (String(msg).indexOf(PROBE) !== 0) return;
      if (!pairWindowOpen()) {
        console.log('  [配对] 收到探测，但配对窗口已关闭（在电脑网页上点一下「打开配对窗口」）');
        return;
      }
      const host = bestAddressFor(rinfo.address);
      const reply = JSON.stringify({
        app: 'jizhangben', v: 1, host: host, port: OPT.port,
        password: CONFIG.password, name: os.hostname()
      });
      discoverSock.send(Buffer.from(reply, 'utf8'), rinfo.port, rinfo.address);
      console.log('  [配对] 已把电脑地址 ' + host + ':' + OPT.port + ' 告诉手机（' + rinfo.address + '）');
    });
    discoverSock.on('error', (e) => console.warn('  [配对] UDP 用不了：' + e.message + '（不影响其它功能）'));
    discoverSock.bind(DISCOVER_PORT);
  } catch (e) {
    console.warn('  [配对] 启动失败：' + e.message);
  }
}

/* ---------------- 账单导入箱 ----------------
   把微信/支付宝导出的账单文件丢进这个文件夹，电脑会自动解析、去重、
   合并进数据（重复的用文件里的数据更新），手机下次同步就看到了。 */
const INBOX_DIR = process.env.JZB_INBOX_DIR || path.join(ROOT, '账单导入箱');
const INBOX_DONE = path.join(INBOX_DIR, '已导入');
const INBOX_FAIL = path.join(INBOX_DIR, '解析失败');
const INBOX_EXT = ['.csv', '.txt', '.xlsx', '.xlsm'];
const INBOX_INTERVAL = Number(process.env.JZB_INBOX_INTERVAL || 3000);
const INODE = require('./importer-node.js');
let inboxBusy = false;
let inboxReady = false;

function inboxPending() {
  try {
    if (!fs.existsSync(INBOX_DIR)) return [];
    return fs.readdirSync(INBOX_DIR).filter((f) => {
      const full = path.join(INBOX_DIR, f);
      try { return fs.statSync(full).isFile() && INBOX_EXT.indexOf(path.extname(f).toLowerCase()) >= 0; }
      catch (e) { return false; }
    });
  } catch (e) { return []; }
}

async function inboxScanOnce() {
  if (inboxBusy) return;
  const names = inboxPending();
  if (!names.length) return;
  inboxBusy = true;
  try {
    const files = names.map((f) => ({ name: f, buffer: fs.readFileSync(path.join(INBOX_DIR, f)) }));
    console.log('  [导入箱] 发现 ' + names.length + ' 个账单文件，开始解析…');
    const state = {
      tx: Object.keys(SYNC.tx).map((k) => SYNC.tx[k]),
      categories: Object.keys(SYNC.categories).map((k) => SYNC.categories[k]),
      settings: SYNC.settings
    };
    const out = await INODE.applyFiles(state, files);
    if (out.changed.length) {
      mergePayload({ tx: out.changed, categories: out.categories, deviceName: '电脑导入箱' });
      maybeServerBackup('inbox');
    }
    out.summary.files.forEach((f) => {
      console.log('  [导入箱] ' + f.name + '（' + (f.kind || '账单') + '）：入库 ' + f.count +
        ' 条，其中重复 ' + f.dup + ' 条、疑似重复 ' + f.suspect + ' 条');
    });
    out.summary.failed.forEach((f) => console.log('  [导入箱] ' + f.name + ' 解析失败：' + f.error));
    console.log('  [导入箱] 完成：新增 ' + out.summary.added + ' 条，更新 ' + out.summary.updated +
      ' 条，电脑上现在共 ' + Object.keys(SYNC.tx).length + ' 条账目');

    fs.mkdirSync(INBOX_DONE, { recursive: true });
    fs.mkdirSync(INBOX_FAIL, { recursive: true });
    const failedNames = out.summary.failed.map((f) => f.name);
    names.forEach((f) => {
      const dest = path.join(failedNames.indexOf(f) >= 0 ? INBOX_FAIL : INBOX_DONE, f);
      try { fs.renameSync(path.join(INBOX_DIR, f), dest); } catch (e) { /* 忽略 */ }
    });
    console.log('  [导入箱] 原文件已挪到 ' + path.relative(ROOT, INBOX_DONE) + '/');
  } catch (e) {
    console.warn('  [导入箱] 处理失败：' + (e && e.message ? e.message : e));
  } finally {
    inboxBusy = false;
  }
}

function startInboxWatch() {
  if (inboxReady) return;
  inboxReady = true;
  try { fs.mkdirSync(INBOX_DIR, { recursive: true }); } catch (e) { /* 忽略 */ }
  setInterval(() => { inboxScanOnce(); }, INBOX_INTERVAL);
  console.log('  账单导入箱：' + path.relative(ROOT, INBOX_DIR) + '/　（把导出的账单丢进去，自动记账）');
}

/* ---------------- 同步数据仓库 ---------------- */
let SYNC = { tx: {}, categories: {}, settings: {}, settingsUpdatedAt: 0, tombstones: {}, updatedAt: 0 };
try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    SYNC = Object.assign(SYNC, raw);
  }
} catch (e) { console.warn('同步数据文件读取失败，将从空数据开始：' + e.message); }

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      SYNC.updatedAt = Date.now();
      fs.writeFileSync(DATA_FILE, JSON.stringify(SYNC), 'utf8');
    } catch (e) { console.warn('同步数据写入失败：' + e.message); }
  }, 300);
}

/* 冲突解决：同一 id 取 updatedAt 更大的一方（后改的胜出） */
function mergePayload(body) {
  const now = Date.now();
  const incomingTx = Array.isArray(body.tx) ? body.tx : [];
  const incomingCats = Array.isArray(body.categories) ? body.categories : [];
  const incomingTombs = Array.isArray(body.tombstones) ? body.tombstones : [];

  let pushed = 0;

  incomingTx.forEach((item) => {
    if (!item || !item.id) return;
    const cur = SYNC.tx[item.id];
    if (!cur || (item.updatedAt || 0) > (cur.updatedAt || 0)) { SYNC.tx[item.id] = item; pushed++; }
  });
  incomingCats.forEach((item) => {
    if (!item || !item.id) return;
    const cur = SYNC.categories[item.id];
    if (!cur || (item.updatedAt || 0) > (cur.updatedAt || 0)) { SYNC.categories[item.id] = item; pushed++; }
  });

  /* 删除记录（墓碑）：只保留最晚的删除时间 */
  incomingTombs.forEach((t) => {
    if (!t || !t.id) return;
    if ((t.at || 0) > (SYNC.tombstones[t.id] || 0)) { SYNC.tombstones[t.id] = t.at || 0; pushed++; }
  });
  Object.keys(SYNC.tombstones).forEach((id) => {
    if (SYNC.tx[id]) delete SYNC.tx[id];
    if (SYNC.categories[id]) delete SYNC.categories[id];
  });

  /* 设置整体按时间戳取新 */
  if (body.settings && (body.settingsUpdatedAt || 0) > (SYNC.settingsUpdatedAt || 0)) {
    SYNC.settings = body.settings;
    SYNC.settingsUpdatedAt = body.settingsUpdatedAt || 0;
    pushed++;
  }

  SYNC.updatedAt = now;
  scheduleSave();

  const tombstones = Object.keys(SYNC.tombstones).map((id) => ({ id: id, at: SYNC.tombstones[id] }));
  return {
    ok: true,
    serverTime: now,
    tx: Object.keys(SYNC.tx).map((k) => SYNC.tx[k]),
    categories: Object.keys(SYNC.categories).map((k) => SYNC.categories[k]),
    settings: SYNC.settings,
    settingsUpdatedAt: SYNC.settingsUpdatedAt,
    tombstones: tombstones,
    stats: { pushed: pushed, serverTx: Object.keys(SYNC.tx).length }
  };
}

/* ---------------- 电脑端自动备份 ----------------
   每次同步后检查一次：距上次备份超过若干小时就把当前全部数据
   写一份到 backups/ 目录，并只保留最近若干份。 */
let lastBackupAt = 0;

function listBackupFiles() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^sync-.*\.json$/.test(f))
      .sort()
      .map((f) => {
        const full = path.join(BACKUP_DIR, f);
        let st = { size: 0, mtime: new Date(0) };
        try { st = fs.statSync(full); } catch (e) { /* 忽略 */ }
        return { name: f, size: st.size, mtime: st.mtime };
      });
  } catch (e) { return []; }
}

function pruneBackups() {
  try {
    const files = listBackupFiles();
    const extra = files.length - BACKUP_KEEP;
    for (let i = 0; i < extra; i++) fs.unlinkSync(path.join(BACKUP_DIR, files[i].name));
    return Math.max(0, extra);
  } catch (e) { return 0; }
}

function writeServerBackup(reason) {
  try {
    if (!Object.keys(SYNC.tx).length) return null;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date();
    const p2 = (n) => ('0' + n).slice(-2);
    const stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' +
      p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
    const file = path.join(BACKUP_DIR, 'sync-' + stamp + '.json');
    fs.writeFileSync(file, JSON.stringify({
      app: '大学生活记账本',
      kind: 'server-backup',
      reason: reason || 'auto',
      at: d.toISOString(),
      settings: SYNC.settings,
      settingsUpdatedAt: SYNC.settingsUpdatedAt,
      categories: Object.keys(SYNC.categories).map((k) => SYNC.categories[k]),
      tx: Object.keys(SYNC.tx).map((k) => SYNC.tx[k]),
      tombstones: SYNC.tombstones
    }, null, 0), 'utf8');
    lastBackupAt = Date.now();
    const pruned = pruneBackups();
    console.log('  [备份] 已生成 ' + path.relative(ROOT, file) +
      '（' + Object.keys(SYNC.tx).length + ' 条账目）' + (pruned ? '，清理旧备份 ' + pruned + ' 份' : ''));
    return file;
  } catch (e) {
    console.warn('  [备份] 失败：' + e.message);
    return null;
  }
}

function maybeServerBackup(reason) {
  if (reason !== 'manual' && Date.now() - lastBackupAt < BACKUP_HOURS * 3600 * 1000) return null;
  return writeServerBackup(reason);
}

/* 启动时：以最近一份备份的时间为基准，避免重启就立刻再备份一份 */
(function initBackupClock() {
  const files = listBackupFiles();
  if (files.length) {
    const last = files[files.length - 1];
    lastBackupAt = last.mtime.getTime();
  }
})();

/* ---------------- 工具 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
};

function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 32 * 1024 * 1024)) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ---------------- 跨源支持（供安卓 App 直接连过来） ---------------- */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const priv = /^https:\/\/app\.local(:\d+)?$/;
  const any = /^(https?):\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;
  if (priv.test(origin) || any.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
  }
}

/* ---------------- 登录页 ---------------- */
const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>记账本 · 请输入访问口令</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background:linear-gradient(150deg,#4f46e5,#9d7bff);color:#fff}
  .card{width:100%;max-width:360px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);
    border-radius:22px;padding:26px 22px;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
  .logo{width:52px;height:52px;border-radius:16px;background:#fff;color:#4f46e5;display:grid;place-items:center;
    font-size:26px;font-weight:800;margin-bottom:16px}
  h1{font-size:19px;margin:0 0 6px}
  p{margin:0 0 18px;font-size:13px;opacity:.85;line-height:1.6}
  input[type=password]{width:100%;padding:13px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.35);
    background:rgba(0,0,0,.18);color:#fff;font-size:20px;letter-spacing:6px;text-align:center;outline:none;font-variant-numeric:tabular-nums}
  input[type=password]::placeholder{letter-spacing:normal;font-size:14px;opacity:.7}
  input[type=password]:focus{border-color:#fff;box-shadow:0 0 0 3px rgba(255,255,255,.2)}
  button{width:100%;margin-top:12px;padding:13px;border-radius:12px;border:0;background:#fff;color:#4f46e5;
    font-size:15px;font-weight:700;cursor:pointer}
  button:disabled{opacity:.6}
  .remember{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:12.5px;opacity:.9}
  .msg{margin-top:12px;font-size:13px;min-height:18px;color:#ffe08a}
  .tip{margin-top:16px;font-size:11.5px;line-height:1.7;opacity:.75}
</style></head>
<body>
<form class="card" id="f">
  <div class="logo">¥</div>
  <h1>大学生活记账本</h1>
  <p>这台设备需要输入访问口令才能打开（口令显示在电脑上运行服务的窗口里）。</p>
  <input id="pwd" type="password" inputmode="numeric" autocomplete="current-password" placeholder="请输入口令" autofocus>
  <label class="remember"><input type="checkbox" id="remember" checked> 记住这台设备，下次自动登录</label>
  <button type="submit" id="go">进入</button>
  <div class="msg" id="msg"></div>
  <div class="tip">口令保存在电脑上的 .server.json 文件里，可以随时修改。<br>忘记了就删掉这个文件重启服务，会生成新的口令。</div>
</form>
<script>
  var f = document.getElementById('f');
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var pwd = document.getElementById('pwd').value.trim();
    var msg = document.getElementById('msg');
    if (!pwd) { msg.textContent = '请输入口令'; return; }
    document.getElementById('go').disabled = true;
    msg.textContent = '正在验证…';
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd, remember: document.getElementById('remember').checked })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.ok) { location.reload(); }
      else { msg.textContent = j.error || '口令不正确'; document.getElementById('go').disabled = false; }
    }).catch(function () {
      msg.textContent = '连接失败，请重试';
      document.getElementById('go').disabled = false;
    });
  });
</script>
</body></html>`;

/* ---------------- HTTP 服务 ---------------- */

/* 兜底：任何未捕获的异常都不应该让服务退出。
   否则手机上同步失败一次，电脑上运行服务的窗口就会直接关掉。 */
process.on('uncaughtException', function (e) {
  console.error('\n  [未捕获的异常] ' + (e && e.stack ? e.stack : e));
  console.error('  服务会继续运行；如果反复出现，请把这段报错发出来。\n');
});
process.on('unhandledRejection', function (e) {
  console.error('\n  [未处理的异步异常] ' + (e && e.stack ? e.stack : e));
  console.error('  服务会继续运行。\n');
});

/* ---------------- AI 转发 ----------------
   手机不方便直连 AI 服务商时，由电脑上的服务代为请求。
   只允许转发到公网 http/https 地址，避免这个接口被用来探测内网。 */
function isPrivateHostname(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h.indexOf(':') >= 0) return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false;
  const p = h.split('.').map(Number);
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  return false;
}

/* 简单的 GET（用于代取节假日这类只读数据） */
function fetchGet(url) {
  return new Promise(function (resolve, reject) {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('地址不合法')); return; }
    const mod = u.protocol === 'https:' ? require('node:https') : require('node:http');
    const r2 = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: { 'Accept': 'application/json,text/plain,*/*', 'User-Agent': 'jizhangben/1.0' },
      timeout: 20000
    }, function (r3) {
      const chunks = [];
      let size = 0;
      r3.on('data', function (c) {
        size += c.length;
        if (size > 2 * 1024 * 1024) { r3.destroy(); return; }
        chunks.push(c);
      });
      r3.on('end', function () {
        resolve({ status: r3.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    r2.on('timeout', function () { r2.destroy(new Error('等待响应超时')); });
    r2.on('error', function (e) { reject(e); });
    r2.end();
  });
}

function forwardRequest(url, headers, payload) {
  return new Promise(function (resolve, reject) {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('地址不合法')); return; }
    const mod = u.protocol === 'https:' ? require('node:https') : require('node:http');
    const bag = Object.assign({}, headers || {});
    bag['Content-Length'] = Buffer.byteLength(payload);
    const r2 = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: bag,
      timeout: 90000
    }, function (r3) {
      const chunks = [];
      let size = 0;
      r3.on('data', function (c) {
        size += c.length;
        if (size > 4 * 1024 * 1024) { r3.destroy(); return; }
        chunks.push(c);
      });
      r3.on('end', function () {
        resolve({ status: r3.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    r2.on('timeout', function () { r2.destroy(new Error('等待 AI 服务响应超时')); });
    r2.on('error', function (e) { reject(e); });
    r2.end(payload);
  });
}

async function handleRequest(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch (e) { res.writeHead(400); res.end('Bad Request'); return; }

  /* ---- 登录 ---- */
  if (urlPath === '/api/login' && req.method === 'POST') {
    const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
    const blocked = loginBlocked(ip);
    if (blocked) return sendJSON(res, 429, { ok: false, error: '尝试次数过多，请 ' + blocked + ' 秒后再试' });
    let body = {};
    try { body = JSON.parse(await readBody(req, 64 * 1024) || '{}'); } catch (e) { body = {}; }
    if (String(body.password || '').trim() !== String(CONFIG.password)) {
      noteLoginFail(ip);
      return sendJSON(res, 401, { ok: false, error: '口令不正确' });
    }
    loginFails.delete(ip);
    const maxAge = body.remember === false ? '' : '; Max-Age=31536000';
    res.setHeader('Set-Cookie',
      COOKIE_NAME + '=' + TOKEN + '; Path=/' + maxAge + '; SameSite=Lax; HttpOnly');
    return sendJSON(res, 200, { ok: true, token: TOKEN });
  }

  /* ---- 需要登录的接口 ---- */
  if (urlPath.indexOf('/api/') === 0) {
    // 打一行日志：能直观看到手机的请求有没有到达电脑
    console.log('  [接口] ' + req.method + ' ' + urlPath + '  来自 ' +
      (req.socket.remoteAddress || '').replace('::ffff:', ''));
    if (!isAuthenticated(req)) {
      return sendJSON(res, 401, { ok: false, error: '未登录', needLogin: true });
    }
    if (urlPath === '/api/ping') {
      return sendJSON(res, 200, {
        ok: true, app: '大学生活记账本', version: '1.0.0',
        serverTime: Date.now(), txCount: Object.keys(SYNC.tx).length
      });
    }
    if (urlPath === '/api/sync' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); }
      catch (e) { return sendJSON(res, 400, { ok: false, error: '数据格式不正确：' + e.message }); }
      try {
        const result = mergePayload(body);
        console.log('  [同步] 来自 ' + (body.deviceName || '未知设备') +
          '：本地 ' + (body.tx || []).length + ' 条，服务器合计 ' + result.stats.serverTx + ' 条，更新 ' + result.stats.pushed + ' 项');
        maybeServerBackup('auto');
        return sendJSON(res, 200, result);
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: '合并失败：' + e.message });
      }
    }
    /* AI 转发：手机 App 把请求交给电脑，由电脑去请求 AI 服务商 */
    if (urlPath === '/api/ai' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req, 512 * 1024) || '{}'); }
      catch (e) { return sendJSON(res, 400, { ok: false, error: '请求格式不正确：' + e.message }); }
      const target = String(body.url || '');
      let parsed = null;
      try { parsed = new URL(target); } catch (e) { parsed = null; }
      if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
        return sendJSON(res, 400, { ok: false, error: '只支持 http/https 地址' });
      }
      if (isPrivateHostname(parsed.hostname)) {
        return sendJSON(res, 403, { ok: false, error: '不允许转发到内网地址' });
      }
      try {
        const out = await forwardRequest(target, body.headers || {}, JSON.stringify(body.payload || {}));
        console.log('  [AI] 已转发到 ' + parsed.hostname + '，返回 ' + out.status);
        return sendJSON(res, 200, { ok: true, status: out.status, body: out.body });
      } catch (e) {
        return sendJSON(res, 502, { ok: false, error: '转发失败：' + (e && e.message ? e.message : '未知错误') });
      }
    }
    if (urlPath === '/api/backups') {
      const files = listBackupFiles().reverse().map((f) => ({
        name: f.name, size: f.size, at: f.mtime.getTime()
      }));
      return sendJSON(res, 200, { ok: true, dir: path.relative(ROOT, BACKUP_DIR), keep: BACKUP_KEEP, files: files });
    }
    if (urlPath === '/api/backup' && req.method === 'POST') {
      const file = writeServerBackup('manual');
      return sendJSON(res, 200, { ok: !!file, file: file ? path.basename(file) : '' });
    }
    /* 代取节假日数据：浏览器受跨源限制时，由电脑上的服务去取。
       和 AI 转发一样，只允许公网地址，避免变成内网探测工具。 */
    if (urlPath === '/api/fetch' && req.method === 'GET') {
      const q = new URL(req.url, 'http://localhost').searchParams.get('url') || '';
      let parsed = null;
      try { parsed = new URL(q); } catch (e) { parsed = null; }
      if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
        return sendJSON(res, 400, { ok: false, error: '只支持 http/https 地址' });
      }
      if (isPrivateHostname(parsed.hostname)) {
        return sendJSON(res, 403, { ok: false, error: '不允许访问内网地址' });
      }
      try {
        const out = await fetchGet(q);
        console.log('  [代取] ' + parsed.hostname + ' 返回 ' + out.status);
        return sendJSON(res, 200, { ok: true, status: out.status, body: out.body });
      } catch (e) {
        return sendJSON(res, 502, { ok: false, error: '获取失败：' + (e && e.message ? e.message : '未知错误') });
      }
    }
    /* 打开配对窗口：电脑上点一下，手机就能自动找到这台电脑 */
    if (urlPath === '/api/pair-open') {
      const until = openPairWindow(120000);
      console.log('  [配对] 配对窗口已打开（2 分钟），手机可以点「自动找电脑」了');
      return sendJSON(res, 200, { ok: true, until: until, port: OPT.port, discoverPort: DISCOVER_PORT });
    }
    if (urlPath === '/api/logout') {
      res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; Max-Age=0');
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 404, { ok: false, error: '接口不存在' });
  }

  /* ---- 静态资源：需要登录 ---- */
  if (!isAuthenticated(req)) {
    const accept = String(req.headers.accept || '');
    if (accept.indexOf('text/html') < 0 && urlPath !== '/') {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('需要登录');
      return;
    }
    const body = Buffer.from(LOGIN_PAGE, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const resolved = path.resolve(path.join(WEB_ROOT, urlPath));
  if (!resolved.startsWith(path.resolve(WEB_ROOT))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(resolved, (err, st) => {
    if (err || !st.isFile()) {
      fs.readFile(path.join(WEB_ROOT, 'index.html'), (e2, data) => {
        if (e2) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(data);
      });
      return;
    }
    fs.readFile(resolved, (e2, data) => {
      if (e2) { res.writeHead(500); res.end('Read Error'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    });
  });
}

const server = http.createServer(function (req, res) {
  // 手机中途断开、连接被重置等情况都会触发 error 事件；
  // 没有监听者的话 Node 会直接抛出，把整个服务带崩。
  req.on('error', function (e) { console.error('  [连接出错] ' + (e && e.message ? e.message : e)); });
  res.on('error', function (e) { console.error('  [响应出错] ' + (e && e.message ? e.message : e)); });

  handleRequest(req, res).catch(function (e) {
    console.error('\n  [请求处理出错] ' + req.method + ' ' + req.url);
    console.error('  ' + (e && e.stack ? e.stack : e));
    try {
      if (!res.headersSent) sendJSON(res, 500, { ok: false, error: '服务器内部错误：' + (e && e.message) });
    } catch (e2) { /* 已经没法回应了，忽略 */ }
  });
});

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((name) => {
    (ifaces[name] || []).forEach((info) => {
      if (info.family === 'IPv4' && !info.internal) out.push({ name: name, address: info.address });
    });
  });
  return out;
}

/* 端口被占用时自动往后找一个能用的。
   Windows 上 8788 经常被别的程序当作「临时端口」占着（看着没程序在跑，却提示被占用），
   所以这里不折腾用户，自己往后试：8789、8790… 试到能用为止。 */
let bindTries = 0;
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE' && bindTries < 15) {
    bindTries++;
    const busy = OPT.port;
    OPT.port = busy + 1;
    console.log('  端口 ' + busy + ' 被占用（很可能是别的程序临时占着），自动改用 ' + OPT.port + ' …');
    setTimeout(function () { server.listen(OPT.port, OPT.bind); }, 250);
    return;
  }
  console.error('启动失败：' + (err && err.message ? err.message : err));
  process.exit(1);
});

server.listen(OPT.port, OPT.bind, () => {
  const local = 'http://127.0.0.1:' + OPT.port + '/';
  const lan = lanAddresses();
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │        大学生活记账本  已启动                 │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
  console.log('  电脑上打开：' + local + '   （本机免口令）');
  if (lan.length) {
    console.log('');
    console.log('  手机上打开（需与电脑在同一 WiFi）：');
    lan.forEach((i) => console.log('    http://' + i.address + ':' + OPT.port + '/    (' + i.name + ')'));
  }
  console.log('');
  if (OPT.noAuth) {
    console.log('  访问控制：已关闭（--no-auth），同一网络内的任何人都能访问');
  } else {
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log('  │   手机首次访问需要输入访问口令                │');
    console.log('  │       口  令 ： ' + CONFIG.password + '                        │');
    console.log('  └──────────────────────────────────────────────┘');
    console.log('  勾选「记住这台设备」后，以后打开就不用再输了。');
    console.log('  口令保存在 ' + path.relative(ROOT, CONFIG_FILE) + '，改口令直接编辑该文件后重启。');
  }
  console.log('');
  console.log('  数据同步：手机 App 里填上面这个手机地址，即可与电脑互相同步数据。');
  console.log('  自动备份：每次同步后会自动在 ' + path.relative(ROOT, BACKUP_DIR) + '/ 留档，最多保留 ' + BACKUP_KEEP + ' 份。');
  console.log('  自动记账：把微信/支付宝导出的账单丢进「账单导入箱」文件夹，电脑会自动入库。');
  console.log('  自动配对：手机 App 里点「自动找电脑」即可（启动后 5 分钟内有效，网页上可重新打开窗口）。');
  startInboxWatch();
  startDiscovery();
  maybeServerBackup('auto');
  console.log('  按 Ctrl + C 停止服务。');
  console.log('');

  if (OPT.open) {
    const cmd = process.platform === 'win32' ? 'start "" "' + local + '"'
      : process.platform === 'darwin' ? 'open "' + local + '"' : 'xdg-open "' + local + '"';
    exec(cmd, () => {});
  }
});