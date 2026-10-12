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

once(U2,
"    renderList();\n" +
"    renderForm();\n" +
"    body.appendChild(listBox);\n" +
"    body.appendChild(formBox);\n",
"    /* ---- 从网上获取节假日（测试版）---- */\n" +
"    const dataBox = U.el('div');\n" +
"    if (global.Holiday) {\n" +
"      const H = global.Holiday;\n" +
"      const srcIn = U.el('input', { class: 'input', value: H.source() });\n" +
"      const dataNote = U.el('div', { class: 'sheet-note', style: { margin: '8px 0 0' } });\n" +
"      const setNote = (t, kind) => {\n" +
"        dataNote.textContent = t || '';\n" +
"        dataNote.style.color = kind === 'err' ? 'var(--expense)' : (kind === 'ok' ? 'var(--income)' : '');\n" +
"      };\n" +
"      const cachedN = H.cached().length;\n" +
"      setNote(cachedN\n" +
"        ? '本机已经存了 ' + cachedN + ' 个节假日，跟着设置一起同步，不用每次重取。'\n" +
"        : '还没有节假日数据，点下面按钮联网取一次（取不到也可以手动粘贴）。');\n" +
"\n" +
"      const pickedBox = U.el('div');\n" +
"      let fetched = [];\n" +
"      const picked = new Set();\n" +
"      function renderFetched() {\n" +
"        U.clear(pickedBox);\n" +
"        if (!fetched.length) return;\n" +
"        const list = U.el('div', { class: 'pick-list', style: { marginTop: '8px' } });\n" +
"        fetched.forEach((h) => {\n" +
"          const on = picked.has(h.key);\n" +
"          const box = U.el('input', { type: 'checkbox', checked: on });\n" +
"          const row = U.el('label', { class: 'pick-row' + (on ? ' is-on' : '') }, [\n" +
"            box,\n" +
"            U.el('span', { class: 'pr-main', text: h.name + '　' + h.start + ' ~ ' + h.end })\n" +
"          ]);\n" +
"          box.addEventListener('change', () => {\n" +
"            if (box.checked) picked.add(h.key); else picked.delete(h.key);\n" +
"            row.classList.toggle('is-on', box.checked);\n" +
"          });\n" +
"          list.appendChild(row);\n" +
"        });\n" +
"        pickedBox.appendChild(list);\n" +
"        pickedBox.appendChild(U.el('button', {\n" +
"          class: 'btn btn-sm btn-primary btn-block', style: { marginTop: '8px' },\n" +
"          text: '把勾选的加进假期',\n" +
"          onclick: async () => {\n" +
"            let n = 0;\n" +
"            for (let i = 0; i < fetched.length; i++) {\n" +
"              const h = fetched[i];\n" +
"              if (!picked.has(h.key)) continue;\n" +
"              if (Store.vacations().some((v) => v.start === h.start && v.end === h.end && v.name === h.name)) continue;\n" +
"              await Store.addVacation({ name: h.name, start: h.start, end: h.end });\n" +
"              await H.mark(h.key, 'done');\n" +
"              n++;\n" +
"            }\n" +
"            fetched = [];\n" +
"            picked.clear();\n" +
"            renderFetched();\n" +
"            renderList();\n" +
"            UI.renderSettings();\n" +
"            UI.renderHome();\n" +
"            setNote(n ? '已加入 ' + n + ' 个假期' : '这些都已经加过了', n ? 'ok' : '');\n" +
"          }\n" +
"        }));\n" +
"      }\n" +
"\n" +
"      const doFetch = async () => {\n" +
"        H.saveSource(srcIn.value);\n" +
"        const y = new Date().getFullYear();\n" +
"        setNote('正在获取 ' + y + ' / ' + (y + 1) + ' 年的节假日…');\n" +
"        try {\n" +
"          const a = await H.fetchYear(y);\n" +
"          let b = [];\n" +
"          try { b = await H.fetchYear(y + 1); } catch (e) { b = []; }\n" +
"          fetched = (a || []).concat(b || []);\n" +
"          picked.clear();\n" +
"          fetched.forEach((h) => picked.add(h.key));\n" +
"          renderFetched();\n" +
"          setNote('取到 ' + fetched.length + ' 个假期，确认无误后点下面的按钮加入。', 'ok');\n" +
"        } catch (e) {\n" +
"          setNote('获取失败：' + e.message + '　可以换个数据源，或者把 JSON 粘贴到下面那一栏。', 'err');\n" +
"        }\n" +
"      };\n" +
"\n" +
"      const pasteIn = U.el('textarea', {\n" +
"        class: 'input', rows: 3,\n" +
"        style: { marginTop: '8px', fontFamily: 'monospace', fontSize: '12px' },\n" +
"        placeholder: '取不到时可以把节假日 JSON 粘贴到这里'\n" +
"      });\n" +
"\n" +
"      dataBox.appendChild(U.el('div', { class: 'card tight', style: { marginTop: '12px' } }, [\n" +
"        U.el('div', { class: 'card-title' }, [\n" +
"          U.el('h3', { text: '节假日数据' }),\n" +
"          U.el('span', { class: 'badge warn', text: '测试版' })\n" +
"        ]),\n" +
"        U.el('p', { style: { fontSize: '12px', color: 'var(--text-soft)', lineHeight: '1.75', margin: '0 0 8px' },\n" +
"          text: '联网取一次全国节假日，直接加进下面的假期列表，不用自己一天天填。数据源也可以换成你信任的接口。' }),\n" +
"        U.el('div', { class: 'field' }, [U.el('label', { text: '数据源（{year} 会换成具体年份）' }), srcIn]),\n" +
"        U.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [\n" +
"          U.el('button', { class: 'btn btn-sm btn-primary', text: '从网上获取', onclick: doFetch }),\n" +
"          U.el('button', {\n" +
"            class: 'btn btn-sm', text: '恢复默认地址',\n" +
"            onclick: () => { srcIn.value = H.defaultSource; H.saveSource(H.defaultSource); setNote('已恢复默认数据源'); }\n" +
"          }),\n" +
"          U.el('button', {\n" +
"            class: 'btn btn-sm', text: '解析粘贴的数据',\n" +
"            onclick: async () => {\n" +
"              try {\n" +
"                const merged = await H.parseText(pasteIn.value);\n" +
"                fetched = H.cached();\n" +
"                picked.clear();\n" +
"                fetched.forEach((h) => picked.add(h.key));\n" +
"                renderFetched();\n" +
"                setNote('解析成功，共 ' + merged.length + ' 个假期，勾选后加入。', 'ok');\n" +
"              } catch (e) { setNote('解析失败：' + e.message, 'err'); }\n" +
"            }\n" +
"          })\n" +
"        ]),\n" +
"        dataNote,\n" +
"        pasteIn,\n" +
"        pickedBox\n" +
"      ]));\n" +
"    }\n" +
"\n" +
"    renderList();\n" +
"    renderForm();\n" +
"    body.appendChild(listBox);\n" +
"    body.appendChild(dataBox);\n" +
"    body.appendChild(formBox);\n");

once(U2,
"      ]),\n" +
"      U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)' }, text: sem ? '当前学期：' + sem.name + '（' + sem.start + ' ~ ' + sem.end + '）' : '尚未设置学期' }),\n",
"      ]),\n" +
"      U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)' }, text: sem ? '当前学期：' + sem.name + '（' + sem.start + ' ~ ' + sem.end + '）' : '尚未设置学期' }),\n" +
"      U.el('p', { style: { fontSize: '11.5px', color: 'var(--text-faint)', marginTop: '8px', lineHeight: '1.7' },\n" +
"        text: '「假期不计入统计」和联网获取节假日还是测试版功能，遇到问题告诉我。' }),\n" +
"      U.el('div', { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } }, [\n" +
"        U.el('button', { class: 'btn btn-sm', text: '管理学期', onclick: () => UI.openSemesterSheet() }),\n" +
"        U.el('button', { class: 'btn btn-sm' + (Store.vacations().length ? ' btn-primary' : ''),\n" +
"          text: '假期设置（' + Store.vacations().length + '）', onclick: () => UI.openVacationSheet() }),\n" +
"        U.el('button', { class: 'btn btn-sm', text: '周起始日：' + (Store.settings.weekStart === 0 ? '周日' : '周一'), onclick: async () => { await Store.updateSettings({ weekStart: Store.settings.weekStart === 0 ? 1 : 0 }); UI.renderSettings(); } })\n" +
"      ])\n" +
"    ]));\n");

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

console.log('r28 ok');
