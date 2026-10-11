/* ============================================================
   core.test.js - 核心逻辑测试（无需浏览器、无需依赖）
   运行： node tests/core.test.js
   覆盖：存储层降级、分类预设、微信/支付宝账单解析、
        编码识别、自动分类、去重、统计合计、报销排除、备份导入导出
   ============================================================ */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

/* ---------------- 搭建一个最小浏览器环境 ---------------- */
const store = new Map();
const sandbox = {
  console: console,
  TextDecoder: TextDecoder,
  TextEncoder: TextEncoder,
  crypto: nodeCrypto.webcrypto,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  Date: Date, Math: Math, JSON: JSON,
  indexedDB: undefined, // 强制走 localStorage 降级分支
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear()
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

['util', 'defaults', 'db', 'store', 'stats', 'importer'].forEach((name) => {
  const file = path.join(ROOT, 'web', 'js', name + '.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
});

const { U, Store, Stats, Importer, DEFAULTS } = sandbox;

/* ---------------- 断言工具 ---------------- */
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  \u2713 ' + msg); }
  else { fail++; console.log('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + '  → 期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}
function near(actual, expected, msg) {
  ok(Math.abs(actual - expected) < 0.005, msg + '  → 期望 ' + expected + '，实际 ' + actual);
}
function section(t) { console.log('\n' + t); }

function catName(tx) { return tx.categoryName || '(未分类)'; }

(async function run() {

  /* ---------- 1. 初始化 ---------- */
  section('1. 初始化与分类预设');
  const mode = await Store.init();
  eq(mode, 'local', '缺少 IndexedDB 时自动降级到 localStorage');
  eq(Store.categories.filter((c) => c.type === 'expense').length, 14, '默认支出分类数量');
  eq(Store.categories.filter((c) => c.type === 'income').length, 8, '默认收入分类数量');
  ok(Store.activeSemester() !== null, '自动创建了当前学期');

  /* ---------- 2. 编码识别 ---------- */
  section('2. 账单文件编码自动识别');
  const wechatBuf = fs.readFileSync(path.join(__dirname, 'fixtures', 'wechat-sample.csv'));
  const alipayBuf = fs.readFileSync(path.join(__dirname, 'fixtures', 'alipay-sample.csv'));
  const wDec = Importer.decodeBuffer(new Uint8Array(wechatBuf));
  const aDec = Importer.decodeBuffer(new Uint8Array(alipayBuf));
  eq(wDec.encoding, 'UTF-8', '微信账单识别为 UTF-8');
  eq(aDec.encoding, 'GBK', '支付宝账单识别为 GBK（GB2312/GBK 编码）');
  ok(aDec.text.indexOf('支付宝交易记录明细查询') === 0, 'GBK 文件解码后中文正常（无乱码）');

  /* ---------- 3. 微信账单解析 ---------- */
  section('3. 微信支付账单解析');
  const opts = { autoClassify: true, dedupe: true, includeIgnore: false, excludeRefund: true };
  const wRes = Importer.parse(wDec.text, opts);
  eq(wRes.detect.kind, 'wechat', '识别为微信支付账单');
  eq(wRes.items.length, 6, '解析出 6 条有效流水（另有 1 条「不计收支」被忽略）');
  eq(wRes.stats.ignored, 1, '「不计收支」的提现记录被跳过');

  const byCounter = (name) => wRes.items.find((it) => it.tx.counterparty === name);
  eq(catName(byCounter('校园食堂').tx), '餐饮', '「校园食堂」自动归类为餐饮');
  eq(catName(byCounter('瑞幸咖啡').tx), '餐饮', '「瑞幸咖啡」自动归类为餐饮');
  eq(catName(byCounter('老碗面').tx), '餐饮', '「老碗面 / 牛肉面」自动归类为餐饮');
  eq(catName(byCounter('爸爸').tx), '生活费', '「爸爸 转账」自动归类为生活费（收入）');
  eq(byCounter('爸爸').tx.type, 'income', '爸爸转账识别为收入');
  near(byCounter('爸爸').tx.amount, 2000, '爸爸转账金额正确');
  eq(byCounter('校园食堂').tx.account, '微信', '账户自动填为微信');

  const refundOut = wRes.items.find((it) => it.tx.counterparty === '美团' && it.tx.type === 'expense');
  eq(refundOut.tx.excludeStat, true, '已全额退款的支出自动标记为不计入统计');
  eq(refundOut.tx.excludeReason, '退款', '退款排除原因正确');

  const n = await Importer.commit(wRes.items);
  eq(n, 6, '导入 6 条微信账单');

  /* ---------- 4. 重复导入 ---------- */
  section('4. 重复导入去重');
  const wRes2 = Importer.parse(wDec.text, opts);
  eq(wRes2.items.filter((it) => it.dup).length, 6, '同一份账单再次导入时全部识别为重复');
  const n2 = await Importer.commit(wRes2.items);
  eq(n2, 0, '重复账单不会被写入');
  eq(Store.tx.length, 6, '库中仍是 6 条');

  /* ---------- 5. 支付宝账单解析 ---------- */
  section('5. 支付宝账单解析');
  const aRes = Importer.parse(aDec.text, opts);
  eq(aRes.detect.kind, 'alipay', '识别为支付宝账单');
  eq(aRes.items.length, 4, '解析出 4 条流水（另有 1 条「不计收支」被忽略）');
  eq(aRes.stats.ignored, 1, '余额宝收益（不计收支）被跳过');
  const aBy = (name) => aRes.items.find((it) => it.tx.counterparty === name);
  eq(catName(aBy('上海地铁').tx), '交通', '「上海地铁」归类为交通');
  eq(catName(aBy('肯德基').tx), '餐饮', '「肯德基」归类为餐饮');
  eq(catName(aBy('妈妈').tx), '生活费', '「妈妈」归类为生活费（收入）');
  eq(catName(aBy('京东').tx), '数码', '「京东 / 耳机」归类为数码');
  eq(aBy('上海地铁').tx.account, '支付宝', '账户自动填为支付宝');
  ok(aBy('上海地铁').tx.note.indexOf('支付方式') >= 0, '付款方式写入备注（保留来源信息）');
  const n3 = await Importer.commit(aRes.items);
  eq(n3, 4, '导入 4 条支付宝账单');
  eq(Store.tx.length, 10, '库中共 10 条');

  /* ---------- 6. 统计合计 ---------- */
  section('6. 周/月/学期统计合计（不计入统计的账单被排除）');
  const range = Stats.range('custom', { from: '2026-09-01', to: '2026-09-30' });
  const list = Store.query({ from: range.from, to: range.to, includeExcluded: true, includeHidden: true });
  const nowD = new Date();
  eq(Stats.range('month').label, nowD.getFullYear() + '年' + (nowD.getMonth() + 1) + '月', '「本月」周期标签正确（不是「全部记录」）');
  eq(U.toISODate(Stats.range('month').from), U.toISODate(new Date(nowD.getFullYear(), nowD.getMonth(), 1)), '「本月」起点是本月 1 号');
  eq(Stats.range('all').label, '全部记录', '「全部」周期标签正确');
  eq(U.toISODate(Stats.range('week').from), U.toISODate(U.startOfWeek(nowD, 1)), '「本周」起点是周一');
  ok(Stats.range('semester').label.length > 0, '「本学期」周期可计算');

  eq(list.length, 10, '9 月共 10 条流水');
  const full = Stats.full(list);
  near(full.included.income, 3500, '计入统计的收入 3500');
  near(full.included.expense, 379.5, '计入统计的支出 379.50');
  near(full.included.net, 3120.5, '结余 3120.50');
  eq(full.included.count, 8, '计入统计 8 笔');
  eq(full.excluded.count, 2, '排除 2 笔（退款）');

  const catStat = Stats.byCategory(full.parts.included, 'expense');
  const foodRow = catStat.rows.find((r) => r.name === '餐饮');
  near(foodRow.amount, 76.5, '餐饮支出合计 76.50（18+6.5+16+36）');
  ok(catStat.rows[0].name === '数码', '支出占比第一名是数码 299');

  const trend = Stats.trend(full.parts.included, range);
  eq(trend.buckets.length, 30, '9 月趋势图 30 天');

  /* ---------- 7. 报销 / 不计入统计 ---------- */
  section('7. 报销流程（收入与支出都不计入统计）');
  const bookTx = await Store.addTx({
    type: 'expense', amount: 320, time: U.fromISO('2026-09-18 10:00').getTime(),
    categoryId: (Store.categories.find((c) => c.name === '学习') || {}).id,
    categoryName: '学习', account: '现金', counterparty: '教务处', item: '教材费'
  });
  await Store.markReimburse(bookTx.id, '报销');
  eq(Store.pendingReimburse().length, 1, '产生 1 笔「待报销」');

  const incomeTx = await Store.settleReimburse(bookTx.id, { amount: 320, time: '2026-09-20', account: '微信', counterparty: '爸爸' });
  eq(Store.pendingReimburse().length, 0, '配对后不再显示待报销');
  eq(Store.getTx(bookTx.id).reimburseStatus, 'done', '支出已标记为已报销');
  eq(Store.getTx(bookTx.id).excludeStat, true, '报销支出不计入统计');
  eq(incomeTx.excludeStat, true, '报销收入也不计入统计');
  eq(incomeTx.type, 'income', '自动生成的是收入记录');
  ok(Store.getTx(bookTx.id).reimburseGroupId === incomeTx.reimburseGroupId, '两笔通过同一个报销组关联');

  const list2 = Store.query({ from: range.from, to: range.to, includeExcluded: true, includeHidden: true });
  const full2 = Stats.full(list2);
  near(full2.included.expense, 379.5, '报销后计入统计的支出仍是 379.50（320 已被排除）');
  near(full2.included.income, 3500, '报销后计入统计的收入仍是 3500');
  eq(full2.excluded.count, 4, '排除 4 笔（2 退款 + 1 报销支出 + 1 报销收入）');

  const withoutExcluded = Store.query({ from: range.from, to: range.to, includeExcluded: false });
  eq(withoutExcluded.length, 8, '默认查询会过滤掉不计入统计的账单');

  /* ---------- 8. 取消报销恢复统计 ---------- */
  section('8. 取消报销');
  await Store.cancelReimburse(bookTx.id);
  eq(Store.getTx(bookTx.id).excludeStat, false, '取消报销后恢复计入统计');
  ok(Store.getTx(incomeTx.id) === null, '配对的报销收入已被删除');
  const full3 = Stats.full(Store.query({ from: range.from, to: range.to, includeExcluded: true }));
  near(full3.included.expense, 699.5, '恢复后支出为 699.50（379.5 + 320）');

  /* ---------- 9. 隐藏账单 ---------- */
  section('9. 隐藏账单');
  await Store.updateTx(bookTx.id, { hidden: true });
  const vis = Store.query({ from: range.from, to: range.to, includeExcluded: true, includeHidden: false });
  eq(vis.length, 10, '隐藏后默认查询看不到该笔（11 条中隐藏 1 条）');
  const vis2 = Store.query({ from: range.from, to: range.to, includeExcluded: true, includeHidden: true });
  eq(vis2.length, 11, '打开「显示已隐藏」后可见（11 条）');

  /* ---------- 10. 备份导出与恢复 ---------- */
  section('10. 备份导出与恢复');
  const json = Store.exportJSON();
  const obj = JSON.parse(json);
  eq(obj.tx.length, 11, '备份包含 11 条账目');
  eq(obj.categories.length, Store.categories.length, '备份包含全部分类');
  const csv = Store.exportCSV();
  ok(csv.indexOf('来源(交易对方)') > 0, 'CSV 导出包含来源列');
  ok(csv.indexOf('是否计入统计') > 0, 'CSV 导出包含统计状态列');
  ok(csv.charCodeAt(0) === 0xFEFF, 'CSV 带 BOM（Excel 打开不乱码）');

  await Store.importObject(obj, 'merge');
  eq(Store.tx.length, 11, '合并导入同一备份不会产生重复');

  await sandbox.DB.clearAll();
  Store.tx = []; Store.categories = []; Store.reindex();
  const r = await Store.importObject(obj, 'merge');
  eq(r.tx, 11, '清空后可完整恢复 11 条账目');

  /* ---------- 汇总 ---------- */
  console.log('\n' + '='.repeat(52));
  console.log('测试完成：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('='.repeat(52));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试运行出错：');
  console.error(e);
  process.exit(1);
});