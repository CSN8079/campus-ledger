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

['util', 'defaults', 'xlsx', 'db', 'store', 'stats', 'importer', 'report', 'ai', 'holiday'].forEach((name) => {
  const file = path.join(ROOT, 'web', 'js', name + '.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
});

const { U, Store, Stats, Importer, Report, DEFAULTS } = sandbox;

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
  const opts = { autoClassify: true, dedupe: true, ignoreMode: 'skip', refundMode: 'exclude' };
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

  /* ---------- 11. 导入行数核对 ---------- */
  section('11. 导入行数核对：文件里的每一行都要有归宿');
  const HEAD = '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注';
  const lines = [
    '支付宝交易记录明细查询',
    '账号:[test@example.com]',
    '起始日期:[2026-09-01 00:00:00]    终止日期:[2026-09-30 23:59:59]',
    '---------------------------------交易记录明细列表------------------------------------',
    HEAD
  ];
  let seqNo = 0;
  const mkRow = (time, dir, amount, status) =>
    [time, '其他', '商户' + (seqNo), '', '消费', dir, amount, '余额宝', status,
      'X' + (String(++seqNo)).padStart(20, '0'), '', '/'].join(',');

  for (let i = 0; i < 60; i++) {
    lines.push(mkRow('2026-09-0' + (1 + (i % 9)) + ' 12:00:00', i % 10 === 0 ? '收入' : '支出', (10 + i) + '.00', '交易成功'));
  }
  for (let i = 0; i < 70; i++) {
    lines.push(mkRow('2026-09-1' + (i % 9) + ' 09:00:00', '不计收支', (100 + i) + '.00', '交易成功'));
  }
  for (let i = 0; i < 4; i++) lines.push(mkRow('2026-09-05 10:00:00', '支出', '88.00', '交易关闭'));
  for (let i = 0; i < 3; i++) lines.push(mkRow('2026-09-06 10:00:00', '支出', '', '交易成功'));
  lines.push('------------------------------------------------------------------------------------');
  lines.push('共 137 笔记录');
  const bigText = lines.join('\n');

  const base = { refundMode: 'exclude', autoClassify: true, dedupe: true };
  const r1 = Importer.parse(bigText, Object.assign({ ignoreMode: 'skip' }, base));
  const s1 = r1.stats;
  console.log('    文件 ' + s1.dataRows + ' 行 = 导入 ' + r1.items.length + ' + 忽略 ' + s1.ignored + ' + 跳过 ' + s1.skipped);
  eq(s1.dataRows, 139, '文件里共 139 行数据（137 笔流水 + 结尾 2 行说明）');
  eq(r1.items.length, 60, '关闭选项时导入 60 条');
  eq(s1.ignored, 70, '70 条「不计收支」被跳过');
  eq(s1.skipped, 9, '9 行跳过（4 条已关闭 + 3 条无金额 + 2 行说明）');
  eq(r1.items.length + s1.ignored + s1.skipped, s1.dataRows, '每一行都有归宿：导入 + 忽略 + 跳过 = 文件行数');
  eq(s1.skipReasons.closed, 4, '跳过原因里「交易已关闭」4 条');
  eq(s1.skipReasons.noAmount, 3, '跳过原因里「缺少金额」3 条');
  eq(s1.skipReasons.footer, 2, '跳过原因里「结尾说明行」2 条');
  eq(s1.dup + s1.suspect, 0, '这批数据里没有重复');

  const r2 = Importer.parse(bigText, Object.assign({ ignoreMode: 'exclude' }, base));
  const s2 = r2.stats;
  eq(r2.items.length, 130, '打开选项后导入 130 条');
  eq(s2.ignored, 0, '不再有被忽略的行');
  eq(r2.items.length + s2.ignored + s2.skipped, s2.dataRows, '打开选项后依然每一行都有归宿');
  eq(r2.items.filter((it) => it.tx.excludeStat).length, 70, '70 条「不计收支」被标记为不计入统计');
  const counted = Stats.summarize(r2.items.filter((it) => !it.tx.excludeStat).map((it) => it.tx));
  eq(counted.count, 60, '计入统计的仍是 60 条，合计不受影响');

  /* ---------- 12. Excel 日期序列号 ---------- */
  section('12. Excel 里的日期序列号也能正确解析');
  const serial = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
  const xlsxLike = [
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
    serial(2026, 9, 2) + ',商户消费,校园食堂,午餐,支出,¥15.00,零钱,支付成功,XS0001,M01,/'
  ].join('\n');
  const rSerial = Importer.parse(xlsxLike, {});
  eq(rSerial.items.length, 1, '解析出 1 条');
  eq(U.toISODate(new Date(rSerial.items[0].tx.time)), '2026-09-02', '日期序列号被正确还原成 2026-09-02');
  near(rSerial.items[0].tx.amount, 15, '金额正确');

  /* ---------- 13. 「不计收支」流水的收支方向 ---------- */
  section('13. 「不计收支」流水的收支方向（余额宝收益不能显示成负数）');
  const hintCsv = [
    '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注',
    '2026-09-01 00:00:00,投资理财,余额宝,,余额宝-收益发放,不计收支,0.02,余额宝,交易成功,AT0001,,/',
    '2026-09-02 00:00:00,转账红包,余额宝,,余额宝-单次转入,不计收支,200.00,余额,交易成功,AT0002,,/',
    '2026-09-03 00:00:00,转账红包,余额宝,,余额宝-单次转出,不计收支,150.00,余额宝,交易成功,AT0003,,/',
    '2026-09-04 00:00:00,信用借还,花呗,,花呗-还款,不计收支,500.00,余额宝,交易成功,AT0004,,/',
    '2026-09-05 00:00:00,转账,银行卡,,转账-转账到银行卡,不计收支,300.00,余额宝,交易成功,AT0005,,/',
    '2026-09-06 00:00:00,其他,零钱通,,零钱提现,不计收支,100.00,零钱,提现成功,AT0006,,/'
  ].join('\n');
  const hintRes = Importer.parse(hintCsv, { ignoreMode: 'exclude', refundMode: 'exclude', autoClassify: true, dedupe: true });
  eq(hintRes.items.length, 6, '解析出 6 条「不计收支」流水');
  const typeOf = (kw) => {
    const it = hintRes.items.find((x) => (x.tx.item + ' ' + x.tx.counterparty).indexOf(kw) >= 0);
    return it ? it.tx.type : '(未找到)';
  };
  eq(typeOf('收益发放'), 'income', '余额宝收益 → 收入方向（显示 +0.02 而不是 -0.02）');
  eq(typeOf('单次转入'), 'income', '余额宝转入 → 收入方向');
  eq(typeOf('单次转出'), 'expense', '余额宝转出 → 支出方向');
  eq(typeOf('还款'), 'expense', '花呗还款 → 支出方向');
  eq(typeOf('转账到银行卡'), 'expense', '转账到银行卡 → 支出方向');
  eq(typeOf('提现'), 'expense', '零钱提现 → 支出方向');
  ok(hintRes.items.every((x) => x.tx.excludeStat === true), '这些流水依然全部标记为「不计入统计」');
  const gain = hintRes.items.find((x) => x.tx.item.indexOf('收益发放') >= 0);
  near(gain.tx.amount, 0.02, '收益金额解析为 0.02');
  eq(U.fmtMoney(gain.tx.amount), '¥0.02', '金额显示为 ¥0.02');
  eq(gain.tx.type === 'income' ? '+' + U.fmtMoney(gain.tx.amount).slice(1) : '', '+0.02',
    '界面上会显示成 +0.02（不再是 -0.02）');

  /* ---------- 14. 排除规则由用户决定 ---------- */
  section('14. 「不计入合计」由用户自己决定');
  const modeCsv = [
    '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注',
    '2026-07-01 12:00:00,餐饮美食,学校餐厅,,午餐,支出,15.00,余额宝,交易成功,M0001,,/',
    '2026-07-02 09:00:00,投资理财,余额宝,,余额宝-收益发放,不计收支,0.02,余额宝,交易成功,M0002,,/',
    '2026-07-03 10:00:00,数码电器,杭州深度求索,,API 充值,支出,100.00,余额宝,交易成功,M0003,,/',
    '2026-07-04 11:00:00,转账红包,余额宝,,余额宝-单次转入,不计收支,500.00,余额,交易成功,M0004,,/'
  ].join('\n');
  const mBase = { autoClassify: true, dedupe: true };

  const mA = Importer.parse(modeCsv, Object.assign({ ignoreMode: 'count', refundMode: 'count' }, mBase));
  eq(mA.items.length, 4, '「计入合计」模式：4 条全部导入');
  eq(mA.items.filter((it) => it.tx.excludeStat).length, 0, '「计入合计」模式：一条都没有被排除');

  const mB = Importer.parse(modeCsv, Object.assign({ ignoreMode: 'exclude', refundMode: 'exclude' }, mBase));
  eq(mB.items.length, 4, '「不计入合计」模式：4 条全部导入');
  eq(mB.items.filter((it) => it.tx.excludeStat).length, 2, '其中只有 2 条余额宝流水被排除');
  eq(mB.items.find((it) => it.tx.counterparty === '学校餐厅').tx.excludeStat, false,
    '学校餐厅正常计入（不会被误排除）');
  eq(mB.items.find((it) => it.tx.counterparty === '杭州深度求索').tx.excludeStat, false,
    'DeepSeek 的消费正常计入（不会被误排除）');
  eq(mB.stats.excludeBreakdown['账单标记「不计收支」'], 2, '预览页能列出排除构成：账单标记 2 条');

  const mC = Importer.parse(modeCsv, Object.assign({ ignoreMode: 'skip', refundMode: 'count' }, mBase));
  eq(mC.items.length, 2, '「不导入」模式：只导入 2 条普通收支');
  eq(mC.stats.ignored, 2, '另外 2 条「不计收支」被跳过');

  const mD = Importer.parse(modeCsv, mBase);
  eq(mD.items.length, 4, '不传任何排除选项时：4 条全部导入');
  eq(mD.items.filter((it) => it.tx.excludeStat).length, 0, '默认（什么都不传）：一条都不排除');

  /* ---------- 15. 图片报告的抬头 ---------- */
  section('15. 图片报告的抬头可以自定义');
  eq(Report.normalizeTitle(''), '大学生活记账本', '留空时用默认抬头');
  eq(Report.normalizeTitle('   '), '大学生活记账本', '只有空白也用默认抬头');
  eq(Report.normalizeTitle('10 月生活费账目'), '10 月生活费账目', '自定义抬头原样保留');
  eq(Report.normalizeTitle('  给爸妈看的账  '), '给爸妈看的账', '去掉首尾空白');
  eq(Report.normalizeTitle('第一行\n第二行'), '第一行 第二行', '换行折成空格');
  eq(Report.normalizeTitle(null), '大学生活记账本', 'null 也用默认抬头');

  const rd1 = Report.buildReportData([], Stats.range('month'), '我的账本');
  eq(rd1.title, '我的账本', '生成报告数据时带上自定义抬头');
  const rd2 = Report.buildReportData([], Stats.range('month'));
  eq(rd2.title, '大学生活记账本', '不传抬头时用默认值');
  const rd3 = Report.buildReportData([], Stats.range('month'), '  ');
  eq(rd3.title, '大学生活记账本', '只传空白仍用默认抬头');

  /* ---------- 16. 分类重复（手机和电脑各生成一套） ---------- */
  section('16. 分类重复：两台设备各生成一套同名分类时要自动合并');
  const catA = await Store.addCategory({ name: '同步测试类', type: 'expense' });
  const catB = await Store.addCategory({ name: '同步测试类', type: 'expense' });
  eq(catA.id, catB.id, '同名同类型的新分类，两台设备算出来的 id 完全一样');
  eq(Store.normalizeCategories === undefined ? false : true, true, '有专门的分类整理方法');

  Store.categories = Store.categories.filter((c) => c.name !== '去重测试类目');
  Store.categories.push(
    { id: 'cat_legacy_a', name: '去重测试类目', type: 'expense', icon: '🏷️', color: '#888', order: 900, builtin: true, updatedAt: Date.now() },
    { id: 'cat_legacy_b', name: '去重测试类目', type: 'expense', icon: '🏷️', color: '#888', order: 900, builtin: true, updatedAt: Date.now() }
  );
  Store.reindex();
  const dupTx = await Store.addTx({
    type: 'expense', amount: 9.9, time: Date.now(),
    categoryId: 'cat_legacy_b', categoryName: '去重测试类目',
    account: '微信', counterparty: '食堂', item: '午饭'
  });
  const fixedRes = await Store.normalizeCategories();
  ok(fixedRes.changed > 0, '整理后确实合并掉了重复项（改了 ' + fixedRes.changed + ' 处）');
  eq(Store.categories.filter((c) => c.name === '去重测试类目' && c.type === 'expense').length, 1, '「去重测试类目」只剩一个');
  const keptCat = Store.categories.find((c) => c.name === '去重测试类目' && c.type === 'expense');
  eq(Store.getTx(dupTx.id).categoryId, keptCat.id, '原来指向旧 id 的账单改成指向保留下来的分类');
  eq(Store.getTx(dupTx.id).categoryName, '去重测试类目', '账单上显示的类目名没错');
  ok(Store.isTombstoned ? Store.isTombstoned('cat_legacy_b') : true, '被合并掉的旧分类留下了删除标记，另一台设备也会跟着合并');

  /* ---------- 17. 记账时的历史联想 ---------- */
  section('17. 历史联想：输入几个字就能套用以前填过的来源');
  const catId = (Store.categories.find((c) => c.name === '餐饮') || Store.categories[0]).id;
  await Store.addTx({ type: 'expense', amount: 12, time: Date.now(), categoryId: catId, categoryName: '餐饮', account: '微信', counterparty: '第一食堂', item: '午饭' });
  await Store.addTx({ type: 'expense', amount: 13, time: Date.now(), categoryId: catId, categoryName: '餐饮', account: '微信', counterparty: '第一食堂', item: '晚饭' });
  await Store.addTx({ type: 'expense', amount: 5, time: Date.now(), categoryId: catId, categoryName: '餐饮', account: '微信', counterparty: '图书馆打印店', item: '打印' });
  const sug1 = Store.suggest('counterparty', '第一', 6);
  eq(sug1.length, 1, '输入「第一」只联想出相关的历史来源');
  eq(sug1[0].value, '第一食堂', '联想出来的正是以前填过的写法');
  eq(sug1[0].count, 2, '带上这个来源以前用过几次');
  eq(Store.suggest('counterparty', '第一食堂', 6)[0].value, '第一食堂', '完整输入也能匹配到这条历史来源（界面上会自动去掉它这一条候选）');
  const sugAll = Store.suggest('counterparty', '', 3);
  ok(sugAll.length >= 2, '不输入时给出最常用的几个来源（' + sugAll.length + ' 个）');
  ok(sugAll[0].count >= sugAll[sugAll.length - 1].count, '按常用程度从多到少排');
  eq(Store.suggest('counterparty', 'ZZZ不存在ZZZ', 6).length, 0, '没有匹配时返回空列表');
  const sugItem = Store.suggest('item', '晚', 6);
  ok(sugItem.some((r) => r.value === '晚饭'), '用途同样能联想（「晚」→ 晚饭）');
  const ccf = Store.commonCategoryFor('counterparty', '第一食堂');
  ok(ccf && ccf.name === '餐饮', '能推荐这个来源历史上最常记的分类（餐饮）');
  eq(Store.commonCategoryFor('counterparty', '从未出现过的商家'), null, '没见过的来源不给推荐');

  /* ---------- 18. 内置 AI：看得见金额、能算数、能定位最近一笔 ---------- */
  section('18. 内置 AI 助手：数据摘要、精确合计、定位「最近的一笔」');
  const AImod = sandbox.AI;
  ok(!!AImod, 'AI 模块已加载');

  const digest = AImod.buildDigest();
  ok(digest.indexOf('各周期合计') >= 0, '喂给 AI 的数据里带着各周期合计（不用它自己心算）');
  ok(digest.indexOf('账目明细') >= 0, '喂给 AI 的数据里带着逐笔明细');
  ok(/\d+\.\d\d/.test(digest), '明细里能看到具体金额');
  ok(digest.indexOf('最近的一笔') >= 0, '明确告诉 AI 哪一笔是最近的');
  ok(digest.indexOf('餐饮') >= 0, '明细里带着分类名');

  /* 「最近的一笔」能精确定位 */
  const newest = Store.tx.slice().sort((a, b) => (b.time - a.time) || (b.createdAt - a.createdAt))[0];
  const m1 = AImod.match({ latest: 1 });
  eq(m1.length, 1, 'latest:1 只命中一笔');
  eq(m1[0].id, newest.id, '命中的正是时间最近的那一笔');
  const m3 = AImod.match({ limit: 3 });
  eq(m3.length, 3, 'limit:3 命中最近三笔');
  ok(m3[0].time >= m3[1].time && m3[1].time >= m3[2].time, '结果按时间从新到旧');
  ok(AImod.match({ latest: 2, txType: 'expense' }).every((t) => t.type === 'expense'), '「最近 N 笔」能和收支类型叠加');
  ok(AImod.describeFilter({ latest: 1 }).indexOf('最近') >= 0, '条件说明会写成人话：' + AImod.describeFilter({ latest: 1 }));

  /* 精确合计：和应用自己的统计模块完全一致 */
  const sumAll = AImod.computeSum({});
  const expectAll = Stats.summarize(Store.tx.filter((t) => !t.excludeStat));
  eq(sumAll.income, expectAll.income, '全部收入合计与统计模块一致');
  eq(sumAll.expense, expectAll.expense, '全部支出合计与统计模块一致');
  eq(sumAll.balance, expectAll.net, '结余也对得上');
  ok(sumAll.text.indexOf('收入') >= 0 && sumAll.text.indexOf('支出') >= 0 && sumAll.text.indexOf('结余') >= 0,
    '给用户看的文字写清了收入 / 支出 / 结余：' + sumAll.text);

  const day = U.toISODate(new Date(newest.time));
  const sumDay = AImod.computeSum({ from: day, to: day });
  const dayList = Store.tx.filter((t) => t.dateKey === day && !t.excludeStat);
  eq(sumDay.count, dayList.length, '按某一天算合计，笔数对得上');
  eq(sumDay.expense, Stats.summarize(dayList).expense, '按某一天算合计，金额对得上');

  /* 改「最近的一笔」分类：走完整的「建议 → 确认 → 执行」 */
  const target = Store.categories.find((c) => c.type === newest.type && c.name !== newest.categoryName);
  ok(!!target, '找到一个可以用来改的分类：' + (target ? target.name : '-'));
  const cards = AImod.resolve([{ type: 'setCategory', category: target.name, filter: { latest: 1 } }]);
  eq(cards.length, 1, '生成一条待确认的改动');
  eq(cards[0].ok, true, '这条改动可以执行');
  eq(cards[0].count, 1, '只影响时间最近的那一笔');
  ok(cards[0].sample.length === 1 && /\d+\.\d\d/.test(cards[0].sample[0]), '卡片上写明是哪一笔（带金额）：' + cards[0].sample[0]);
  await cards[0].run();
  eq(Store.getTx(newest.id).categoryName, target.name, '执行后最近那一笔的分类改成了「' + target.name + '」');
  eq(Store.getTx(newest.id).id, newest.id, '改的确实是最近那一笔');

  /* ---------- 19. 只报销一部分 / 报多了 / 代付的钱收回来 ---------- */
  section('19. 报销只报一部分、报多了、代付的钱后来收回来');
  const bid = (Store.categories.find((c) => c.name === '餐饮') || Store.categories[0]).id;
  async function mkExp(amount, name, day) {
    return Store.addTx({
      type: 'expense', amount: amount, time: U.fromISO(day + ' 12:00').getTime(),
      categoryId: bid, categoryName: '餐饮', account: '微信',
      counterparty: name, item: '报销测试', source: 'manual'
    });
  }
  function dayStats(day) {
    const d = U.fromISO(day);
    return Stats.full(Store.query({ from: d, to: d, includeExcluded: true, includeHidden: true }));
  }

  /* --- 只报销一部分：花 38，父母给了 20 --- */
  const e1 = await mkExp(38, '部分报销测试', '2026-10-01');
  const got1 = await Store.settleReimburse(e1.id, { amount: 20, time: '2026-10-02', counterparty: '爸爸', reason: '报销' });
  eq(Store.getTx(e1.id).excludeStat, false, '只报一部分时，这笔支出没有整笔排除');
  eq(Store.getTx(e1.id).excludeAmount, 20, '记账里记住「抵扣掉 20」');
  eq(Stats.counted(Store.getTx(e1.id)), 18, '自己承担的 18 元仍然算支出');
  eq(got1.excludeStat, true, '报销到账的 20 元不算收入');
  eq(Stats.counted(got1), 0, '这 20 元一点收入都不计入');
  const i1 = Store.reimburseInfo(Store.getTx(e1.id));
  eq(i1.selfPay, 18, '配对信息里算出自己承担 18');
  eq(i1.covered, 20, '配对信息里算出抵扣 20');
  eq(i1.extra, 0, '没有多出来的钱');

  const d1 = dayStats('2026-10-01');
  const in1 = d1.parts.included.filter((t) => t.id === e1.id);
  eq(in1.length, 1, '统计模块把「自付部分」算进了计入统计的列表');
  eq(in1[0].amount, 18, '统计模块算出来是 18 元，不是 38');
  ok(d1.partialTotal >= 20, '统计模块也记下了被抵扣的 20 元');

  /* --- 报多了：花 30，父母给了 50 --- */
  const e2 = await mkExp(30, '报多了测试', '2026-10-03');
  const got2 = await Store.settleReimburse(e2.id, { amount: 50, time: '2026-10-03', counterparty: '妈妈', reason: '报销' });
  eq(Store.getTx(e2.id).excludeStat, true, '报多了：原支出全额不计入统计');
  eq(Stats.counted(Store.getTx(e2.id)), 0, '这笔支出一点都不计入');
  eq(got2.excludeStat, false, '多出来的部分要算收入');
  eq(Stats.counted(got2), 20, '多出来的 20 元（50 - 30）计入收入');
  const got2b = await Store.settleReimburse(e2.id, { amount: 50, time: '2026-10-03', counterparty: '妈妈', reason: '报销', countExtra: false });
  eq(got2b.id, got2.id, '再点一次是更新原来那笔，不会多出一条收入');
  eq(Stats.counted(got2b), 0, '关掉开关后，多出来的 20 元也不算收入');
  eq(Store.tx.filter((t) => t.reimburseGroupId === Store.getTx(e2.id).reimburseGroupId).length, 2, '这一组始终只有两笔');
  await Store.settleReimburse(e2.id, { amount: 50, time: '2026-10-03', counterparty: '妈妈', reason: '报销' });
  eq(Stats.counted(Store.getTx(got2.id)), 20, '再打开开关，又多计入 20 元收入');

  /* --- 代付：先垫钱，后来对方把 45 全还了 --- */
  const e3 = await mkExp(45, '代付收回测试', '2026-10-05');
  await Store.updateTx(e3.id, { excludeStat: true, excludeReason: '代付' });
  eq(Stats.counted(Store.getTx(e3.id)), 0, '代付的钱先是不计入统计的');
  const back3 = await Store.settleReimburse(e3.id, { amount: 45, time: '2026-10-06', counterparty: '同学', reason: '代付' });
  eq(Store.getTx(e3.id).excludeStat, true, '全部收回后，这笔代付仍然不计入统计');
  eq(back3.excludeStat, true, '收回来的 45 元不算收入');
  eq(back3.categoryName, '收回代付', '收入归到「收回代付」这个分类');
  ok(back3.item.indexOf('收回代付') === 0, '用途写的是「收回代付：…」：' + back3.item);
  eq(Store.reimburseInfo(Store.getTx(e3.id)).reason, '代付', '配对信息里记着这是代付');
  eq(Store.pairWords('代付').done, '已收回', '代付用「已收回」的说法');
  eq(Store.pairWords('报销').done, '已报销', '报销还是用「已报销」');

  /* --- 代付只收回来一部分：垫了 100，只还了 60 --- */
  const e4 = await mkExp(100, '代付部分收回', '2026-10-07');
  await Store.updateTx(e4.id, { excludeStat: true, excludeReason: '代付' });
  await Store.settleReimburse(e4.id, { amount: 60, time: '2026-10-08', counterparty: '同学', reason: '代付' });
  eq(Store.getTx(e4.id).excludeStat, false, '只收回一部分时，这笔垫付重新计入统计');
  eq(Stats.counted(Store.getTx(e4.id)), 40, '还没收回来的 40 元算自己的支出');
  const d4 = dayStats('2026-10-07');
  const in4 = d4.parts.included.filter((t) => t.id === e4.id);
  eq(in4.length, 1, '统计模块把这 40 元放进了计入统计的列表');
  eq(in4[0].amount, 40, '金额是 40');

  /* --- 取消配对后要恢复原样 --- */
  await Store.cancelReimburse(e1.id);
  eq(Stats.counted(Store.getTx(e1.id)), 38, '取消配对后 38 元全额恢复计入统计');
  eq(Store.getTx(e1.id).excludeAmount, 0, '抵扣金额清零');
  eq(Store.getTx(e1.id).reimburseAmount, 0, '收到金额也清零');
  ok(!Store.tx.some((t) => t.reimburseGroupId === i1.group && t.reimburseRole === 'in'), '配对的收入被删掉了');

  /* ---------- 20. 多次垫付，一次性转给我（可能多给） ---------- */
  section('20. 一次转账抵消多笔垫付：只有多出来的钱才算收入');
  async function mkExpAt(amount, name, when) {
    return Store.addTx({
      type: 'expense', amount: amount, time: U.fromISO(when).getTime(),
      categoryId: bid, categoryName: '餐饮', account: '微信',
      counterparty: name, item: '垫付测试', source: 'manual'
    });
  }

  const a1 = await mkExpAt(38, '垫付甲', '2026-10-09 08:00');
  const a2 = await mkExpAt(60, '垫付乙', '2026-10-09 12:00');
  const a3 = await mkExpAt(20, '垫付丙', '2026-10-09 18:00');
  await Store.updateTx(a1.id, { excludeStat: true, excludeReason: '代付' });
  await Store.updateTx(a2.id, { excludeStat: true, excludeReason: '代付' });
  await Store.updateTx(a3.id, { excludeStat: true, excludeReason: '代付' });

  const cands = Store.reimburseCandidates(a1.id);
  ok(cands.some((c) => c.id === a1.id) && cands.some((c) => c.id === a2.id) && cands.some((c) => c.id === a3.id),
    '三笔垫付都在可勾选的清单里');
  ok(cands.every((c) => c.type === 'expense'), '清单里只有支出（自己先垫的钱）');

  /* 一次性给 150，比实际垫的 118 多（故意打乱顺序，验证「先垫先抵」） */
  const back = await Store.settleReimburse([a3.id, a1.id, a2.id],
    { amount: 150, time: '2026-10-10', counterparty: '爸爸', reason: '报销' });
  eq(Store.getTx(a1.id).excludeStat, true, '垫付甲被抵消 → 不计入统计');
  eq(Store.getTx(a2.id).excludeStat, true, '垫付乙被抵消 → 不计入统计');
  eq(Store.getTx(a3.id).excludeStat, true, '垫付丙被抵消 → 不计入统计');
  eq(Stats.counted(Store.getTx(a1.id)) + Stats.counted(Store.getTx(a2.id)) + Stats.counted(Store.getTx(a3.id)), 0,
    '三笔垫付一共 0 元计入统计');
  eq(back.amount, 150, '到账记录是一笔 150');
  eq(Stats.counted(back), 32, '只有多出来的 32 元（150 - 118）计入收入');
  const info20 = Store.reimburseInfo(Store.getTx(a2.id));
  eq(info20.count, 3, '一组里关联着三笔垫付');
  eq(info20.spent, 118, '这一组垫付合计 118');
  eq(info20.got, 150, '这一组收到 150');
  eq(info20.extra, 32, '多出 32');
  eq(Store.tx.filter((t) => t.reimburseGroupId === info20.group).length, 4, '一组总共 4 条：3 笔垫付 + 1 笔到账');

  const d20 = dayStats('2026-10-09');
  const in20 = d20.parts.included.filter((t) => [a1.id, a2.id, a3.id].indexOf(t.id) >= 0);
  eq(in20.length, 0, '被抵消的三笔都不在「计入统计」里');

  /* 只给 100（不够）：先垫的先生效，剩下 18 还是自己花的 */
  const b1 = await mkExpAt(38, '垫付丁', '2026-10-11 08:00');
  const b2 = await mkExpAt(60, '垫付戊', '2026-10-11 12:00');
  const b3 = await mkExpAt(20, '垫付己', '2026-10-11 18:00');
  await Store.settleReimburse([b1.id, b2.id, b3.id], { amount: 100, time: '2026-10-11', counterparty: '妈妈', reason: '报销' });
  eq(Store.getTx(b1.id).excludeStat, true, '先垫的 38 被抵消');
  eq(Store.getTx(b2.id).excludeStat, true, '第二笔 60 也被抵消');
  eq(Store.getTx(b3.id).excludeStat, false, '只给 100 时，最后一笔没能全部抵消');
  eq(Store.getTx(b3.id).reimburseAmount, 2, '最后一笔只被抵消了 2 元（100-38-60）');
  eq(Stats.counted(Store.getTx(b3.id)), 18, '没抵消到的 18 元仍然算自己的支出');
  eq(Stats.counted(Store.getTx(b3.id)) + Stats.counted(Store.getTx(b1.id)) + Stats.counted(Store.getTx(b2.id)), 18,
    '这一组只计入自己承担的 18 元');

  /* 取消：整组一起恢复 */
  await Store.cancelReimburse(b1.id);
  eq(Stats.counted(Store.getTx(b1.id)), 38, '取消后第一笔全额恢复计入统计');
  eq(Stats.counted(Store.getTx(b3.id)), 20, '取消后第三笔也恢复成 20');
  eq(Store.getTx(b1.id).reimburseGroupId, '', '配对关系被清掉了');

  /* ---------- 21. 导入遇到重复：按你的选择保留导入的数据 ---------- */
  section('21. 导入遇到重复：可以保留导入的数据（手动记的也能被更新）');
  const CSV_HEAD = '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注';
  const dupOpts = { autoClassify: true, dedupe: true, ignoreMode: 'count', refundMode: 'count' };
  const mkCsvRow = (row) => CSV_HEAD + '\n' + row;
  const manCatId = (Store.categories.find((c) => c.name === '餐饮') || Store.categories[0]).id;

  /* --- 情况一：先手动记一笔，再导入同一天同金额的账单 --- */
  const manTx = await Store.addTx({
    type: 'expense', amount: 26.8, time: U.fromISO('2026-03-20 12:00').getTime(),
    categoryId: manCatId, categoryName: '餐饮', account: '现金',
    counterparty: '我自己记的商家', item: '自己写的用途', note: '我的备注', source: 'manual'
  });
  const csvA = mkCsvRow('2026-03-20 18:22:00,商户消费,便利店,零食,支出,¥26.80,零钱,支付成功,XL9999,M999,/');
  const hitA = Importer.parse(csvA, dupOpts).items[0];
  ok(!!hitA, '解析出那一条流水');
  eq(hitA.suspect, true, '和手动记的那笔「同日同额」，被认成疑似重复');
  eq(hitA.dupOf, manTx.id, '并且认出重复的就是你手动记的那一笔');
  ok(hitA.dupOfLabel.indexOf('手动') >= 0, '还说明了那是你手动记的：' + hitA.dupOfLabel);

  const beforeA = Store.tx.length;
  hitA.selected = true;
  const nA = await Importer.commit([hitA], { dupMode: 'overwrite' });
  eq(nA, 1, '「保留导入的数据」时更新了一条');
  eq(Store.tx.length, beforeA, '没有新增记录（是就地更新）');
  const updA = Store.getTx(manTx.id);
  eq(updA.counterparty, '便利店', '商家换成了文件里准确的写法');
  eq(updA.externalId, 'XL9999', '交易单号补上了（以后同一份账单不会再重复）');
  eq(U.toISODateTimeLocal(new Date(updA.time)), '2026-03-20T18:22', '时间换成文件里的准确时间');
  eq(updA.note, '我的备注', '你自己写的备注保留');
  eq(updA.account, '现金', '你自己选的账户保留');
  ok(!!updA.categoryName, '分类仍在：' + updA.categoryName);
  eq(updA.id, manTx.id, '更新的就是原来那一笔（id 没变）');

  const againA = Importer.parse(csvA, dupOpts).items[0];
  eq(againA.dup, true, '同一份文件再导入时认出「交易单号已存在」');
  eq(againA.dupOf, manTx.id, '认出的还是那一笔');

  /* --- 情况二：选「跳过」时，原来那笔一个字都不动 --- */
  const manB = await Store.addTx({
    type: 'expense', amount: 31.5, time: U.fromISO('2026-03-22 09:00').getTime(),
    categoryId: manCatId, categoryName: '餐饮', account: '微信',
    counterparty: '手动记的早餐店', item: '早饭', source: 'manual'
  });
  const csvB = mkCsvRow('2026-03-22 09:14:00,商户消费,包子铺,早餐,支出,¥31.50,零钱,支付成功,XL7777,M777,/');
  const hitB = Importer.parse(csvB, dupOpts).items[0];
  eq(hitB.suspect, true, '第二笔也认出了同日同额');
  eq(hitB.dupOf, manB.id, '认出的还是手动记的那一笔');
  const beforeB = Store.tx.length;
  hitB.selected = true;
  const nB = await Importer.commit([hitB], { dupMode: 'skip' });
  eq(nB, 1, '「跳过」时照常新导入一条');
  eq(Store.tx.length, beforeB + 1, '库里多了一条');
  eq(Store.getTx(manB.id).counterparty, '手动记的早餐店', '原来那笔一个字都没动');

  /* ---------- 22. 假期期间不计入统计（日期自己定） ---------- */
  section('22. 假期不计入统计：日期区间自己定');
  await Store.updateSettings({ vacationExclude: true, vacations: [] });
  const vacA = await Store.addVacation({ name: '寒假', start: '2026-07-01', end: '2026-07-31' });
  eq(Store.vacations().length, 1, '加上了 1 个假期');
  ok(!!Store.inVacation(U.fromISO('2026-07-15 12:00').getTime()), '7 月 15 日算在假期里');
  eq(Store.inVacation(U.fromISO('2026-08-01 00:00').getTime()), null, '8 月 1 日不算假期');
  eq(Store.inVacation(U.fromISO('2026-07-31 23:59').getTime()).name, '寒假', '假期的最后一天 23:59 仍然算在内');

  const hExp = await mkExpAt(50, '假期里的支出', '2026-07-15 12:00');
  const sExp = await mkExpAt(60, '学期里的支出', '2026-06-15 12:00');
  eq(Stats.counted(Store.getTx(hExp.id)), 0, '假期里的支出不计入统计');
  eq(Stats.counted(Store.getTx(sExp.id)), 60, '不在假期里的照常计入');

  const dH = dayStats('2026-07-15');
  eq(dH.parts.included.filter((t) => t.id === hExp.id).length, 0, '统计模块把它挪出了「计入」那一边');
  const exH = dH.parts.excluded.filter((t) => t.id === hExp.id);
  eq(exH.length, 1, '放进了「不计入」那边');
  eq(exH[0].excludeReason, '假期', '排除原因写的是「假期」');

  /* 关掉总开关：照常计入 */
  await Store.updateSettings({ vacationExclude: false });
  eq(Stats.counted(Store.getTx(hExp.id)), 50, '关掉「假期不计入统计」后，这笔钱又计入了');
  await Store.updateSettings({ vacationExclude: true });

  /* 提前回校：把结束日改早，那天之后的账目重新计入 */
  await Store.updateVacation(vacA.id, { end: '2026-07-10' });
  const lateExp = await mkExpAt(20, '提前回校后', '2026-07-20 12:00');
  eq(Stats.counted(Store.getTx(lateExp.id)), 20, '把假期结束日改早后，之后的支出重新计入统计');
  eq(Stats.counted(Store.getTx(hExp.id)), 50, '7 月 15 日已不在假期里，也重新计入');
  eq(Store.inVacation(U.fromISO('2026-07-20 12:00').getTime()), null, '7 月 20 日不再是假期');

  await Store.removeVacation(vacA.id);
  eq(Store.vacations().length, 0, '可以删掉假期');
  eq(Stats.counted(Store.getTx(hExp.id)), 50, '删掉假期后照常计入');

  /* ---------- 23. 节假日数据与提醒（测试版） ---------- */
  section('23. 节假日数据与提醒（测试版）');
  const Hol = sandbox.Holiday;
  ok(!!Hol, '节假日模块已加载');

  const hT1 = Hol.parse({ holiday: {
    '01-01': { holiday: true, name: '元旦', date: '2027-01-01' },
    '01-02': { holiday: true, name: '元旦', date: '2027-01-02' },
    '01-03': { holiday: true, name: '元旦', date: '2027-01-03' },
    '01-05': { holiday: false, name: '上班', date: '2027-01-05' }
  } });
  eq(hT1.length, 1, 'timor 那种格式：连续的几天合并成一个假期');
  eq(hT1[0].name, '元旦', '名字认出来了');
  eq(hT1[0].start, '2027-01-01', '开始日期正确');
  eq(hT1[0].end, '2027-01-03', '连着三天合并成 1/1 ~ 1/3');
  ok(!!hT1[0].key, '生成了唯一标识：' + hT1[0].key);

  const hT2 = Hol.parse({ data: { list: [
    { date: '20270101', holiday: 1, name: '元旦' },
    { date: '20270102', holiday: 1, name: '元旦' }
  ] } });
  eq(hT2.length, 1, '另一种常见格式也认得出');
  eq(hT2[0].end, '2027-01-02', '合并成 1/1 ~ 1/2');

  const hT3 = Hol.parse([{ name: '寒假', start: '2027-01-20', end: '2027-02-20' }]);
  eq(hT3.length, 1, '直接给出区间也能用');
  eq(hT3[0].end, '2027-02-20', '结束日期保留');

  eq(Hol.parse([{ date: '2027-05-01', holiday: 0, name: '调休上班' }]).length, 0, '调休上班日不算假期');

  await Store.updateSettings({ holidayData: { fetchedAt: Date.now(), source: '测试', list: hT1 }, holidayPrompts: {}, vacationExclude: true });
  const hNow = (s) => U.fromISO(s).getTime();
  eq(Hol.cached().length, 1, '数据存进设置里了');
  eq(Hol.suggestions(hNow('2026-12-20 10:00')).length, 0, '离得还远（12 天）先不打扰');
  const hS1 = Hol.suggestions(hNow('2026-12-28 10:00'));
  eq(hS1.length, 1, '还剩几天时提醒一次');
  eq(hS1[0].kind, 'before', '属于「开始前」的提醒');
  ok(hS1[0].left >= 3 && hS1[0].left <= 4, '带上还剩几天：' + hS1[0].left);
  eq(Hol.suggestions(hNow('2027-01-02 10:00'))[0].kind, 'during', '假期当中提醒「快结束了」');
  eq(Hol.suggestions(hNow('2027-02-01 10:00')).length, 0, '早就过去的不再提醒');

  await Hol.mark(hT1[0].key, 'skip');
  eq(Hol.suggestions(hNow('2026-12-28 10:00')).length, 0, '选了「照常计入」后就不再提醒（通知才会消失）');
  await Store.updateSettings({ holidayPrompts: {} });

  const hVac = await Store.addVacation({ name: '元旦', start: hT1[0].start, end: hT1[0].end });
  eq(Hol.suggestions(hNow('2026-12-28 10:00')).length, 0, '已经设为假期了，也不用再提醒');
  await Store.removeVacation(hVac.id);

  await Store.updateSettings({ vacationExclude: false });
  eq(Hol.suggestions(hNow('2026-12-28 10:00')).length, 0, '总开关关掉后不提醒');
  await Store.updateSettings({ vacationExclude: true, holidayData: null, holidayPrompts: {} });

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