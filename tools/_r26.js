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

/* ---------- 1. 概览：节假日提醒卡片（处理完才消失） ---------- */
once(U2,
"    /* AI 助手入口：这么重要的功能，别藏在设置里 */\n",
"    /* 节假日提醒（测试版）：开始前 / 结束前提醒，处理完才消失 */\n" +
"    const holidaySug = global.Holiday ? global.Holiday.suggestions() : [];\n" +
"    holidaySug.slice(0, 2).forEach((s) => {\n" +
"      const h = s.holiday;\n" +
"      const isBefore = s.kind === 'before';\n" +
"      view.appendChild(U.el('div', { class: 'card holiday-card' }, [\n" +
"        U.el('div', { class: 'hc-head' }, [\n" +
"          U.el('span', { class: 'hc-ico', text: '🗓️' }),\n" +
"          U.el('div', { style: { flex: '1', minWidth: '0' } }, [\n" +
"            U.el('div', { class: 'hc-t', text: h.name + (isBefore ? ' 快到了' : ' 快结束了') }),\n" +
"            U.el('div', { class: 'hc-d', text: (isBefore ? '从 ' + h.start + ' 开始' : '到 ' + h.end + ' 结束') + '（还有 ' + s.left + ' 天）' })\n" +
"          ]),\n" +
"          U.el('span', { class: 'badge warn', text: '测试版' })\n" +
"        ]),\n" +
"        U.el('p', { class: 'hc-ask', text: '这段时间要不要不计入统计？（假期里多半不在学校，算进校园生活费不太合适）' }),\n" +
"        U.el('div', { class: 'hc-actions' }, [\n" +
"          U.el('button', {\n" +
"            class: 'btn btn-sm btn-primary', text: '设为假期（不计入统计）',\n" +
"            onclick: async () => {\n" +
"              await Store.addVacation({ name: h.name, start: h.start, end: h.end });\n" +
"              await global.Holiday.mark(h.key, 'done');\n" +
"              UI.toast('已把「' + h.name + '」设为不计入统计', 'ok');\n" +
"              UI.renderSettings();\n" +
"              UI.renderHome();\n" +
"            }\n" +
"          }),\n" +
"          U.el('button', {\n" +
"            class: 'btn btn-sm', text: '自己改时间',\n" +
"            onclick: () => UI.openVacationSheet({ name: h.name, start: h.start, end: h.end })\n" +
"          }),\n" +
"          U.el('button', {\n" +
"            class: 'btn btn-sm', text: '照常计入',\n" +
"            onclick: async () => {\n" +
"              await global.Holiday.mark(h.key, 'skip');\n" +
"              UI.toast('好的，这段时间照常计入统计', '');\n" +
"              UI.renderHome();\n" +
"            }\n" +
"          })\n" +
"        ])\n" +
"      ]));\n" +
"    });\n" +
"\n" +
"    /* AI 助手入口：这么重要的功能，别藏在设置里 */\n");

/* ---------- 2. 假期面板：支持预填 + 保存后自动消掉对应提醒 ---------- */
once(U2,
"  UI.openVacationSheet = function () {\n",
"  UI.openVacationSheet = function (prefill) {\n");

once(U2,
"    let editing = null;\n" +
"    const formBox = U.el('div');\n",
"    /* 从提醒卡片点「自己改时间」进来时，把建议的日期先填好 */\n" +
"    let editing = prefill ? { id: '', name: prefill.name || '', start: prefill.start, end: prefill.end } : null;\n" +
"    const formBox = U.el('div');\n");

once(U2,
"            text: editing ? '保存修改' : '添加假期',\n",
"            text: (editing && editing.id) ? '保存修改' : '添加假期',\n");

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

/* ---------- 3. 假期面板：联网获取节假日（测试版） ---------- */
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
"          text: '联网取一次全国节假日，直接加进下面的假期列表，不用自己一天天填。数据源可以换成你信任的接口。' }),\n" +
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

/* ---------- 4. 设置页：标注测试版 ---------- */
once(U2,
"        U.el('button', { class: 'btn btn-sm', text: '周起始日：' + (Store.settings.weekStart === 0 ? '周日' : '周一'), onclick: async () => { await Store.updateSettings({ weekStart: Store.settings.weekStart === 0 ? 1 : 0 }); UI.renderSettings(); } })\n" +
"      ])\n" +
"    ]));\n",
"        U.el('button', { class: 'btn btn-sm', text: '周起始日：' + (Store.settings.weekStart === 0 ? '周日' : '周一'), onclick: async () => { await Store.updateSettings({ weekStart: Store.settings.weekStart === 0 ? 1 : 0 }); UI.renderSettings(); } })\n" +
"      ]),\n" +
"      U.el('p', { style: { fontSize: '11.5px', color: 'var(--text-faint)', marginTop: '8px', lineHeight: '1.7' },\n" +
"        text: '「假期不计入统计」和联网获取节假日还是测试版功能，遇到问题告诉我。' })\n" +
"    ]));\n");

/* ---------- 5. 样式 ---------- */
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

console.log('r26 ok');
