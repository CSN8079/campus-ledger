const fs = require('fs');
const path = require('path');
const ROOT = __dirname + '/..';
function load(p) {
  const raw = fs.readFileSync(path.join(ROOT, p), 'utf8');
  const eol = raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  return { eol: eol, text: raw.split('\r\n').join('\n') };
}
function save(p, h, text) {
  fs.writeFileSync(path.join(ROOT, p), h.eol === '\n' ? text : text.split('\n').join('\r\n'), 'utf8');
}
function once(p, from, to) {
  const h = load(p);
  const n = h.text.split(from).length - 1;
  if (n !== 1) throw new Error('expect exactly 1 in ' + p + ' (got ' + n + '): ' + from.slice(0, 90));
  save(p, h, h.text.replace(from, () => to));
}

/* ---- 核心测试：假期 ---- */
var CORE = [
"  /* ---------- 22. 假期期间不计入统计（日期自己定） ---------- */",
"  section('22. 假期不计入统计：日期区间自己定');",
"  await Store.updateSettings({ vacationExclude: true, vacations: [] });",
"  const vacA = await Store.addVacation({ name: '寒假', start: '2026-07-01', end: '2026-07-31' });",
"  eq(Store.vacations().length, 1, '加上了 1 个假期');",
"  ok(!!Store.inVacation(U.fromISO('2026-07-15 12:00').getTime()), '7 月 15 日算在假期里');",
"  eq(Store.inVacation(U.fromISO('2026-08-01 00:00').getTime()), null, '8 月 1 日不算假期');",
"  eq(Store.inVacation(U.fromISO('2026-07-31 23:59').getTime()).name, '寒假', '假期的最后一天 23:59 仍然算在内');",
"",
"  const hExp = await mkExpAt(50, '假期里的支出', '2026-07-15 12:00');",
"  const sExp = await mkExpAt(60, '学期里的支出', '2026-06-15 12:00');",
"  eq(Stats.counted(Store.getTx(hExp.id)), 0, '假期里的支出不计入统计');",
"  eq(Stats.counted(Store.getTx(sExp.id)), 60, '不在假期里的照常计入');",
"",
"  const dH = dayStats('2026-07-15');",
"  eq(dH.parts.included.filter((t) => t.id === hExp.id).length, 0, '统计模块把它挪出了「计入」那一边');",
"  const exH = dH.parts.excluded.filter((t) => t.id === hExp.id);",
"  eq(exH.length, 1, '放进了「不计入」那边');",
"  eq(exH[0].excludeReason, '假期', '排除原因写的是「假期」');",
"",
"  /* 关掉总开关：照常计入 */",
"  await Store.updateSettings({ vacationExclude: false });",
"  eq(Stats.counted(Store.getTx(hExp.id)), 50, '关掉「假期不计入统计」后，这笔钱又计入了');",
"  await Store.updateSettings({ vacationExclude: true });",
"",
"  /* 提前回校：把结束日改早，那天之后的账目重新计入 */",
"  await Store.updateVacation(vacA.id, { end: '2026-07-10' });",
"  const lateExp = await mkExpAt(20, '提前回校后', '2026-07-20 12:00');",
"  eq(Stats.counted(Store.getTx(lateExp.id)), 20, '把假期结束日改早后，之后的支出重新计入统计');",
"  eq(Stats.counted(Store.getTx(hExp.id)), 50, '7 月 15 日已不在假期里，也重新计入');",
"  eq(Store.inVacation(U.fromISO('2026-07-20 12:00').getTime()), null, '7 月 20 日不再是假期');",
"",
"  await Store.removeVacation(vacA.id);",
"  eq(Store.vacations().length, 0, '可以删掉假期');",
"  eq(Stats.counted(Store.getTx(hExp.id)), 50, '删掉假期后照常计入');",
"",
""
].join('\n');
once('tests/core.test.js', '  /* ---------- 汇总 ---------- */\n', CORE + '  /* ---------- 汇总 ---------- */\n');

/* ---- 浏览器测试：假期面板 ---- */
var B = [
"  /* ---------- 52. 假期不计入统计 ---------- */",
"  const vacBefore52 = Store.vacations().slice();",
"  await Store.updateSettings({ vacationExclude: true });",
"  const vac52 = await Store.addVacation({ name: '测试假期', start: '2026-05-01', end: '2026-05-07' });",
"  const catV52 = (Store.categories.find((c) => c.name === '餐饮') || Store.categories[0]).id;",
"  const inVac52 = await Store.addTx({ type: 'expense', amount: 88, time: U.fromISO('2026-05-03 12:00').getTime(), categoryId: catV52, categoryName: '餐饮', account: '微信', counterparty: '假期消费测试', item: '景区门票', source: 'manual' });",
"  const outVac52 = await Store.addTx({ type: 'expense', amount: 66, time: U.fromISO('2026-06-03 12:00').getTime(), categoryId: catV52, categoryName: '餐饮', account: '微信', counterparty: '平时消费测试', item: '午饭', source: 'manual' });",
"  eq(Stats.counted(Store.getTx(inVac52.id)), 0, '假期里的那笔不计入统计');",
"  eq(Stats.counted(Store.getTx(outVac52.id)), 66, '不在假期里的照常计入');",
"",
"  UI.go('settings');",
"  await wait(420);",
"  ok($('#view-settings').textContent.indexOf('假期设置') >= 0, '设置页有「假期设置」入口');",
"  const vacBtn52 = $$('#view-settings button').filter((b) => b.textContent.indexOf('假期设置') >= 0)[0];",
"  ok(!!vacBtn52, '找得到那个按钮');",
"  if (vacBtn52) vacBtn52.click();",
"  await wait(520);",
"  ok($('#sheetRoot').textContent.indexOf('假期期间不计入统计') >= 0, '假期面板里有总开关');",
"  ok($('#sheetRoot').textContent.indexOf('测试假期') >= 0, '列出了已经加好的假期');",
"  ok($('#sheetRoot').textContent.indexOf('2026-05-01') >= 0 && $('#sheetRoot').textContent.indexOf('2026-05-07') >= 0, '显示出起止日期');",
"  const editBtn52 = $$('#sheetRoot .cat-row button').filter((b) => b.textContent === '编辑')[0];",
"  ok(!!editBtn52, '每个假期都能编辑（提前回校就把结束日改早）');",
"  if (editBtn52) editBtn52.click();",
"  await wait(360);",
"  ok($('#sheetRoot').textContent.indexOf('保存修改') >= 0, '点「编辑」进入修改状态');",
"  ok($('#sheetRoot').textContent.indexOf('取消编辑') >= 0, '也能取消编辑');",
"  UI.closeSheet();",
"  await wait(460);",
"",
"  UI.state.list = Object.assign(UI.state.list, { period: 'all', types: [], categoryIds: [], accounts: [], showHidden: true });",
"  UI.go('list');",
"  await wait(460);",
"  const listTxt52 = $('#view-list').textContent;",
"  ok(listTxt52.indexOf('假期消费测试') >= 0, '假期的账目仍然留在明细里');",
"  ok(listTxt52.indexOf('假期') >= 0, '明细里标出了「假期」');",
"  UI.state.list.period = 'month';",
"",
"  await Store.updateSettings({ vacationExclude: false });",
"  eq(Stats.counted(Store.getTx(inVac52.id)), 88, '关掉开关后，假期里的钱又计入了统计');",
"  await Store.updateSettings({ vacationExclude: true });",
"  eq(Stats.counted(Store.getTx(inVac52.id)), 0, '再打开又恢复不计入');",
"",
"  await Store.removeVacation(vac52.id);",
"  await Store.removeManyTx([inVac52.id, outVac52.id]);",
"  await Store.updateSettings({ vacations: vacBefore52 });",
"  eq(Store.vacations().length, vacBefore52.length, '收尾：假期列表恢复原样');",
"",
""
].join('\n');

const p = 'tests/browser-suite.js';
const h = load(p);
const anchor = "  UI.go('home');\n  await wait(250);\n\n  return {\n";
const n = h.text.split(anchor).length - 1;
if (n !== 1) throw new Error('anchor not found (' + n + ')');
save(p, h, h.text.replace(anchor, () => B + anchor));

console.log('r24 ok');
