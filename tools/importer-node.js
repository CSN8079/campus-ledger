/* ============================================================
   importer-node.js - 在电脑端复用浏览器那套账单导入器

   为什么这么做：解析微信/支付宝账单的逻辑已经写在 web/js/importer.js
   里，而且有上百项测试覆盖。这里用一个最小沙箱把它跑在 Node 里，
   不重写一遍，就不会出现「手机导入能认、电脑自动导入认不出」的情况。

   用法：
     const INode = require('./importer-node');
     const out = await INode.applyFiles(state, [{ name, text, buffer }]);
     // out.changed  → 需要合并进服务器数据的账目
     // out.summary  → 给控制台看的统计
   ============================================================ */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const MODULES = ['util', 'defaults', 'xlsx', 'db', 'store', 'stats', 'importer', 'ai'];

/* 和 tests/core.test.js 同一套最小浏览器环境 */
function makeSandbox() {
  const mem = new Map();
  const sandbox = {
    console: { log: function () {}, warn: function () {}, error: function () {} },
    TextDecoder: TextDecoder,
    TextEncoder: TextEncoder,
    crypto: nodeCrypto.webcrypto,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: setInterval, clearInterval: clearInterval,
    Date: Date, Math: Math, JSON: JSON,
    indexedDB: undefined,
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(k, String(v)); },
      removeItem: (k) => { mem.delete(k); },
      clear: () => mem.clear()
    },
    navigator: {},
    document: {
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {} }),
      createTextNode: (t) => ({ text: t })
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  MODULES.forEach((name) => {
    const file = path.join(ROOT, 'web', 'js', name + '.js');
    if (!fs.existsSync(file)) return;
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  });
  return sandbox;
}

/* 把电脑上的真实数据装进沙箱，这样去重/覆盖的判断和在手机上完全一致 */
function primeSandbox(sandbox, state) {
  const Store = sandbox.Store;
  /* 先按默认初始化（会建默认分类），再用电脑上的数据覆盖 */
  sandbox.localStorage.setItem('jzb:db', JSON.stringify({ version: 1 }));
  return Store.init().then(() => {
    Store.tx = (state.tx || []).map((t) => Object.assign({}, t));
    Store.categories = (state.categories || []).map((c) => Object.assign({}, c));
    if (state.settings) Store.settings = Object.assign({}, Store.settings, state.settings);
    Store.reindex();
    return Store;
  });
}

const OPTS = { autoClassify: true, dedupe: true, ignoreMode: 'count', refundMode: 'count' };

/* 解析一个文件（csv 文本 或 xlsx 二进制） */
async function parseFile(sandbox, file) {
  const Importer = sandbox.Importer;
  const name = String(file.name || '').toLowerCase();
  const buf = file.buffer || Buffer.from(String(file.text || ''), 'utf8');
  if (/\.xlsx?$|\.xlsm$/.test(name)) return Importer.parseXlsx(new Uint8Array(buf), OPTS);
  /* CSV：微信是 UTF-8、支付宝是 GBK，交给导入器自己判断编码 */
  const dec = Importer.decodeBuffer(new Uint8Array(buf));
  return Importer.parse(dec.text, OPTS);
}

/* 把一批文件应用到一个「服务器数据快照」上，返回需要写回的账目 */
async function applyFiles(state, files) {
  const sandbox = makeSandbox();
  const Store = await primeSandbox(sandbox, state);
  const Importer = sandbox.Importer;
  const before = new Map();
  Store.tx.forEach((t) => before.set(t.id, t.updatedAt || 0));

  const summary = { files: [], added: 0, updated: 0, dup: 0, suspect: 0, failed: [] };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let res;
    try {
      res = await parseFile(sandbox, file);
    } catch (e) {
      summary.failed.push({ name: file.name, error: e && e.message ? e.message : '解析失败' });
      continue;
    }
    const items = res.items || [];
    const dupN = items.filter((it) => it.dup).length;
    const susN = items.filter((it) => it.suspect).length;
    summary.dup += dupN;
    summary.suspect += susN;

    /* 和手机上一样：重复的用文件里的数据就地更新，不新增一条 */
    items.forEach((it) => { it.selected = true; });
    const n = await Importer.commit(items, { dupMode: 'overwrite' });
    summary.files.push({ name: file.name, kind: res.detect && res.detect.kind, count: n, dup: dupN, suspect: susN });
  }

  /* 找出新增的与改动过的 */
  const changed = [];
  Store.tx.forEach((t) => {
    const was = before.get(t.id);
    if (was === undefined) { summary.added++; changed.push(t); return; }
    if ((t.updatedAt || 0) > was) { summary.updated++; changed.push(t); }
  });
  const cats = Store.categories.slice();

  return { changed: changed, categories: cats, summary: summary };
}

module.exports = { applyFiles: applyFiles, makeSandbox: makeSandbox };
