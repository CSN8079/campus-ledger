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

once('tests/core.test.js',
"['util', 'defaults', 'xlsx', 'db', 'store', 'stats', 'importer', 'report', 'ai'].forEach((name) => {",
"['util', 'defaults', 'xlsx', 'db', 'store', 'stats', 'importer', 'report', 'ai', 'holiday'].forEach((name) => {");

var CORE = [
"  /* ---------- 23. 节假日数据与提醒（测试版） ---------- */",
"  section('23. 节假日数据与提醒（测试版）');",
"  const Hol = sandbox.Holiday;",
"  ok(!!Hol, '节假日模块已加载');",
"",
"  const t1 = Hol.parse({ holiday: {",
"    '01-01': { holiday: true, name: '元旦', date: '2027-01-01' },",
"    '01-02': { holiday: true, name: '元旦', date: '2027-01-02' },",
"    '01-03': { holiday: true, name: '元旦', date: '2027-01-03' },",
"    '01-05': { holiday: false, name: '上班', date: '2027-01-05' }",
"  } });",
"  eq(t1.length, 1, 'timor 那种格式：连续的几天合并成一个假期');",
"  eq(t1[0].name, '元旦', '名字认出来了');",
"  eq(t1[0].start, '2027-01-01', '开始日期正确');",
"  eq(t1[0].end, '2027-01-03', '连着三天合并成 1/1 ~ 1/3');",
"  ok(!!t1[0].key, '生成了唯一标识：' + t1[0].key);",
"",
"  const t2 = Hol.parse({ data: { list: [",
"    { date: '20270101', holiday: 1, name: '元旦' },",
"    { date: '20270102', holiday: 1, name: '元旦' }",
"  ] } });",
"  eq(t2.length, 1, '另一种常见格式也认得出');",
"  eq(t2[0].end, '2027-01-02', '合并成 1/1 ~ 1/2');",
"",
"  const t3 = Hol.parse([{ name: '寒假', start: '2027-01-20', end: '2027-02-20' }]);",
"  eq(t3.length, 1, '直接给出区间也能用');",
"  eq(t3[0].end, '2027-02-20', '结束日期保留');",
"",
"  eq(Hol.parse([{ date: '2027-05-01', holiday: 0, name: '调休上班' }]).length, 0, '调休上班日不算假期');",
"",
"  /* 提醒：开始前 / 结束前，处理完才消失 */",
"  await Store.updateSettings({ holidayData: { fetchedAt: Date.now(), source: '测试', list: t1 }, holidayPrompts: {}, vacationExclude: true });",
"  const mkNow = (s) => U.fromISO(s).getTime();",
"  eq(Hol.cached().length, 1, '数据存进设置里了');",
"  eq(Hol.suggestions(mkNow('2026-12-20 10:00')).length, 0, '离得还远（12 天）先不打扰');",
"  const s1 = Hol.suggestions(mkNow('2026-12-28 10:00'));",
"  eq(s1.length, 1, '还剩几天时提醒一次');",
"  eq(s1[0].kind, 'before', '属于「开始前」的提醒');",
"  ok(s1[0].left >= 3 && s1[0].left <= 4, '带上还剩几天：' + s1[0].left);",
"  eq(Hol.suggestions(mkNow('2027-01-02 10:00'))[0].kind, 'during', '假期当中提醒「快结束了」');",
"  eq(Hol.suggestions(mkNow('2027-02-01 10:00')).length, 0, '早就过去的不再提醒');",
"",
"  await Hol.mark(t1[0].key, 'skip');",
"  eq(Hol.suggestions(mkNow('2026-12-28 10:00')).length, 0, '选了「照常计入」后就不再提醒（这样通知才会消失）');",
"  await Store.updateSettings({ holidayPrompts: {} });",
"",
"  const hv = await Store.addVacation({ name: '元旦', start: t1[0].start, end: t1[0].end });",
"  eq(Hol.suggestions(mkNow('2026-12-28 10:00')).length, 0, '已经设为假期了，也不用再提醒');",
"  await Store.removeVacation(hv.id);",
"",
"  await Store.updateSettings({ vacationExclude: false });",
"  eq(Hol.suggestions(mkNow('2026-12-28 10:00')).length, 0, '总开关关掉后不提醒');",
"  await Store.updateSettings({ vacationExclude: true, holidayData: null, holidayPrompts: {} });",
"",
""
].join('\n');
once('tests/core.test.js', '  /* ---------- 汇总 ---------- */\n', CORE + '  /* ---------- 汇总 ---------- */\n');
console.log('r30 ok');
