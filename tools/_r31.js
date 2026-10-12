const fs = require('fs');
const path = require('path');
const ROOT = __dirname + '/..';
const p = 'tests/core.test.js';
const full = path.join(ROOT, p);
const raw = fs.readFileSync(full, 'utf8');
const eol = raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
let text = raw.split('\r\n').join('\n');

const startMark = "  /* ---------- 23. 节假日数据与提醒";
const endMark = "  /* ---------- 汇总 ---------- */";
const a = text.indexOf(startMark);
const b = text.indexOf(endMark);
if (a < 0 || b < 0 || b < a) throw new Error('marks not found');

var NEW = [
"  /* ---------- 23. 节假日数据与提醒（测试版） ---------- */",
"  section('23. 节假日数据与提醒（测试版）');",
"  const Hol = sandbox.Holiday;",
"  ok(!!Hol, '节假日模块已加载');",
"",
"  const hT1 = Hol.parse({ holiday: {",
"    '01-01': { holiday: true, name: '元旦', date: '2027-01-01' },",
"    '01-02': { holiday: true, name: '元旦', date: '2027-01-02' },",
"    '01-03': { holiday: true, name: '元旦', date: '2027-01-03' },",
"    '01-05': { holiday: false, name: '上班', date: '2027-01-05' }",
"  } });",
"  eq(hT1.length, 1, 'timor 那种格式：连续的几天合并成一个假期');",
"  eq(hT1[0].name, '元旦', '名字认出来了');",
"  eq(hT1[0].start, '2027-01-01', '开始日期正确');",
"  eq(hT1[0].end, '2027-01-03', '连着三天合并成 1/1 ~ 1/3');",
"  ok(!!hT1[0].key, '生成了唯一标识：' + hT1[0].key);",
"",
"  const hT2 = Hol.parse({ data: { list: [",
"    { date: '20270101', holiday: 1, name: '元旦' },",
"    { date: '20270102', holiday: 1, name: '元旦' }",
"  ] } });",
"  eq(hT2.length, 1, '另一种常见格式也认得出');",
"  eq(hT2[0].end, '2027-01-02', '合并成 1/1 ~ 1/2');",
"",
"  const hT3 = Hol.parse([{ name: '寒假', start: '2027-01-20', end: '2027-02-20' }]);",
"  eq(hT3.length, 1, '直接给出区间也能用');",
"  eq(hT3[0].end, '2027-02-20', '结束日期保留');",
"",
"  eq(Hol.parse([{ date: '2027-05-01', holiday: 0, name: '调休上班' }]).length, 0, '调休上班日不算假期');",
"",
"  await Store.updateSettings({ holidayData: { fetchedAt: Date.now(), source: '测试', list: hT1 }, holidayPrompts: {}, vacationExclude: true });",
"  const hNow = (s) => U.fromISO(s).getTime();",
"  eq(Hol.cached().length, 1, '数据存进设置里了');",
"  eq(Hol.suggestions(hNow('2026-12-20 10:00')).length, 0, '离得还远（12 天）先不打扰');",
"  const hS1 = Hol.suggestions(hNow('2026-12-28 10:00'));",
"  eq(hS1.length, 1, '还剩几天时提醒一次');",
"  eq(hS1[0].kind, 'before', '属于「开始前」的提醒');",
"  ok(hS1[0].left >= 3 && hS1[0].left <= 4, '带上还剩几天：' + hS1[0].left);",
"  eq(Hol.suggestions(hNow('2027-01-02 10:00'))[0].kind, 'during', '假期当中提醒「快结束了」');",
"  eq(Hol.suggestions(hNow('2027-02-01 10:00')).length, 0, '早就过去的不再提醒');",
"",
"  await Hol.mark(hT1[0].key, 'skip');",
"  eq(Hol.suggestions(hNow('2026-12-28 10:00')).length, 0, '选了「照常计入」后就不再提醒（通知才会消失）');",
"  await Store.updateSettings({ holidayPrompts: {} });",
"",
"  const hVac = await Store.addVacation({ name: '元旦', start: hT1[0].start, end: hT1[0].end });",
"  eq(Hol.suggestions(hNow('2026-12-28 10:00')).length, 0, '已经设为假期了，也不用再提醒');",
"  await Store.removeVacation(hVac.id);",
"",
"  await Store.updateSettings({ vacationExclude: false });",
"  eq(Hol.suggestions(hNow('2026-12-28 10:00')).length, 0, '总开关关掉后不提醒');",
"  await Store.updateSettings({ vacationExclude: true, holidayData: null, holidayPrompts: {} });",
"",
""
].join('\n');

text = text.slice(0, a) + NEW + text.slice(b);
fs.writeFileSync(full, eol === '\n' ? text : text.split('\n').join('\r\n'), 'utf8');
console.log('r31 ok');
