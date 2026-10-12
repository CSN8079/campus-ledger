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
var U2 = 'web/js/ui.js';
console.log('入口已加：', load(U2).text.indexOf('假期 快到了') >= 0);
console.log('预填已加：', load(U2).text.indexOf('UI.openVacationSheet = function (prefill)') >= 0);

once(U2,
"            class: 'btn btn-sm btn-primary', text: editing ? '保存修改' : '添加假期',\n",
"            class: 'btn btn-sm btn-primary', text: (editing && editing.id) ? '保存修改' : '添加假期',\n");

once(U2,
"              if (editing) await Store.updateVacation(editing.id, { name: name, start: start, end: end });\n" +
"              else await Store.addVacation({ name: name, start: start, end: end });\n" +
"              editing = null;\n",
"              const saved = (editing && editing.id)\n" +
"                ? await Store.updateVacation(editing.id, { name: name, start: start, end: end })\n" +
"                : await Store.addVacation({ name: name, start: start, end: end });\n" +
"              editing = null;\n" +
"              /* 手动加的这一段如果覆盖了某个节假日提醒，就把它消掉 */\n" +
"              if (global.Holiday && saved) {\n" +
"                const pending = global.Holiday.suggestions();\n" +
"                for (let i = 0; i < pending.length; i++) {\n" +
"                  const hh = pending[i].holiday;\n" +
"                  if (!(saved.end < hh.start || saved.start > hh.end)) await global.Holiday.mark(hh.key, 'done');\n" +
"                }\n" +
"              }\n");

console.log('r27 step1 ok');
