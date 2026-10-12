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

once('web/js/ui.js',
"      U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)' }, text: sem ? '当前学期：' + sem.name + '（' + sem.start + ' ~ ' + sem.end + '）' : '尚未设置学期' }),\n",
"      U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)' }, text: sem ? '当前学期：' + sem.name + '（' + sem.start + ' ~ ' + sem.end + '）' : '尚未设置学期' }),\n" +
"      U.el('p', { style: { fontSize: '11.5px', color: 'var(--text-faint)', marginTop: '8px', lineHeight: '1.7' },\n" +
"        text: '「假期不计入统计」和联网获取节假日还是测试版功能，遇到问题告诉我。' }),\n");

once('web/css/app.css',
"/* ---------- AI 助手入口（要显眼） ---------- */\n",
"/* ---------- 节假日提醒 ---------- */\n" +
".holiday-card { border-color: var(--warn); background: var(--warn-soft); }\n" +
".holiday-card .hc-head { display: flex; align-items: center; gap: 10px; }\n" +
".holiday-card .hc-ico { font-size: 22px; }\n" +
".holiday-card .hc-t { font-size: 15px; font-weight: 700; }\n" +
".holiday-card .hc-d { font-size: 12px; color: var(--text-soft); margin-top: 2px; }\n" +
".holiday-card .hc-ask { font-size: 12.5px; color: var(--text-soft); line-height: 1.7; margin: 10px 0 0; }\n" +
".holiday-card .hc-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }\n" +
"\n" +
"/* ---------- AI 助手入口（要显眼） ---------- */\n");

console.log('r29 ok');
