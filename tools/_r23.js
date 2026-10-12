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

/* ============ 1. 默认设置 ============ */
once('web/js/defaults.js',
"    theme: 'auto',              // auto | light | dark\n",
"    theme: 'auto',              // auto | light | dark\n" +
"    vacationExclude: true,      // 假期期间不计入统计（假期在设置里自己加）\n" +
"    vacations: [],              // [{ id, name, start, end }]\n");

/* ============ 2. store：假期的增删改查 + 判断某笔是不是假期 ============ */
once('web/js/store.js',
"  const SYNC_SETTING_KEYS = ['semesters', 'activeSemesterId', 'weekStart', 'rules',\n" +
"    'autoClassifyOnImport', 'dedupeOnImport', 'lastAccount'];\n",
"  const SYNC_SETTING_KEYS = ['semesters', 'activeSemesterId', 'weekStart', 'rules',\n" +
"    'autoClassifyOnImport', 'dedupeOnImport', 'lastAccount',\n" +
"    'vacations', 'vacationExclude'];\n");

once('web/js/store.js',
"  /* ---------------- 备份 / 导出 ---------------- */\n",
"  /* ---------------- 假期 ----------------\n" +
"     寒暑假、国庆这些时间人在家，校园里的花销口径对不上，\n" +
"     所以可以让这段时间的账目不计入周/月/学期合计（明细里照常保留）。 */\n" +
"  Store.vacations = function () { return Store.settings.vacations || []; };\n" +
"\n" +
"  /* 这段时间落在哪个假期里（没有就返回 null） */\n" +
"  Store.inVacation = function (time) {\n" +
"    const t = Number(time) || 0;\n" +
"    const list = Store.vacations();\n" +
"    for (let i = 0; i < list.length; i++) {\n" +
"      const v = list[i];\n" +
"      if (!v || !v.start || !v.end) continue;\n" +
"      const from = U.startOfDay(U.fromISO(v.start)).getTime();\n" +
"      const to = U.endOfDay(U.fromISO(v.end)).getTime();\n" +
"      if (t >= from && t <= to) return v;\n" +
"    }\n" +
"    return null;\n" +
"  };\n" +
"\n" +
"  Store.addVacation = async function (v) {\n" +
"    const item = Object.assign({ id: U.uuid(), name: '假期' }, v);\n" +
"    Store.settings.vacations = Store.vacations().concat([item]);\n" +
"    await Store.saveSettings();\n" +
"    Store.emit('settings');\n" +
"    return item;\n" +
"  };\n" +
"\n" +
"  Store.updateVacation = async function (id, patch) {\n" +
"    const list = Store.vacations();\n" +
"    const item = list.find((x) => x.id === id);\n" +
"    if (!item) return null;\n" +
"    Object.assign(item, patch);\n" +
"    await Store.saveSettings();\n" +
"    Store.emit('settings');\n" +
"    return item;\n" +
"  };\n" +
"\n" +
"  Store.removeVacation = async function (id) {\n" +
"    Store.settings.vacations = Store.vacations().filter((x) => x.id !== id);\n" +
"    await Store.saveSettings();\n" +
"    Store.emit('settings');\n" +
"  };\n" +
"\n" +
"  /* ---------------- 备份 / 导出 ---------------- */\n");

/* ============ 3. stats：假期里的账目不计入统计 ============ */
once('web/js/stats.js',
"  /* 一笔账实际计入统计的钱 */\n" +
"  S.counted = function (t) {\n" +
"    if (!t || t.excludeStat || t.hidden) return 0;\n" +
"    return U.round2(Math.max(0, t.amount - S.excludedPart(t)));\n" +
"  };\n",
"  /* 这笔账是不是落在「假期」里（用户在设置里自己加的日期区间） */\n" +
"  S.isVacation = function (t) {\n" +
"    if (!t) return false;\n" +
"    if (Store.settings && Store.settings.vacationExclude === false) return false;\n" +
"    return !!(Store.inVacation && Store.inVacation(t.time));\n" +
"  };\n" +
"\n" +
"  /* 一笔账实际计入统计的钱 */\n" +
"  S.counted = function (t) {\n" +
"    if (!t || t.excludeStat || t.hidden) return 0;\n" +
"    if (S.isVacation(t)) return 0;\n" +
"    return U.round2(Math.max(0, t.amount - S.excludedPart(t)));\n" +
"  };\n");

once('web/js/stats.js',
"    list.forEach((t) => {\n" +
"      if (t.hidden) { hidden.push(t); return; }\n" +
"      if (t.excludeStat) { excluded.push(t); return; }\n" +
"      const cut = S.excludedPart(t);\n",
"    list.forEach((t) => {\n" +
"      if (t.hidden) { hidden.push(t); return; }\n" +
"      if (t.excludeStat) { excluded.push(t); return; }\n" +
"      /* 假期里的账目：留在明细里，但不参与任何合计 */\n" +
"      if (S.isVacation(t)) { excluded.push(Object.assign({}, t, { excludeReason: '假期' })); return; }\n" +
"      const cut = S.excludedPart(t);\n");

/* ============ 4. ui：设置里的假期入口 + 假期面板 ============ */
once('web/js/ui.js',
"      U.el('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } }, [\n" +
"        U.el('button', { class: 'btn btn-sm', text: '管理学期', onclick: () => UI.openSemesterSheet() }),\n",
"      U.el('div', { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } }, [\n" +
"        U.el('button', { class: 'btn btn-sm', text: '管理学期', onclick: () => UI.openSemesterSheet() }),\n" +
"        U.el('button', { class: 'btn btn-sm' + (Store.vacations().length ? ' btn-primary' : ''),\n" +
"          text: '假期设置（' + Store.vacations().length + '）', onclick: () => UI.openVacationSheet() }),\n");

once('web/js/ui.js',
"  /* ---------------- 分类编辑 ---------------- */\n",
"  /* ---------------- 假期设置 ---------------- */\n" +
"  UI.openVacationSheet = function () {\n" +
"    const body = U.el('div');\n" +
"\n" +
"    const sw = U.el('button', {\n" +
"      class: 'switch' + (Store.settings.vacationExclude !== false ? ' is-on' : ''),\n" +
"      onclick: async (e) => {\n" +
"        await Store.updateSettings({ vacationExclude: Store.settings.vacationExclude === false });\n" +
"        e.target.classList.toggle('is-on', Store.settings.vacationExclude !== false);\n" +
"      }\n" +
"    });\n" +
"    body.appendChild(U.el('div', { class: 'switch-row' }, [\n" +
"      U.el('div', { class: 'sr-body' }, [\n" +
"        U.el('div', { class: 'sr-title', text: '假期期间不计入统计' }),\n" +
"        U.el('div', { class: 'sr-desc', text: '下面这些日期里的账目会留在明细，但不参与周/月/学期的合计' })\n" +
"      ]),\n" +
"      sw\n" +
"    ]));\n" +
"\n" +
"    const listBox = U.el('div', { style: { marginTop: '6px' } });\n" +
"    function renderList() {\n" +
"      U.clear(listBox);\n" +
"      const vs = Store.vacations().slice().sort((a, b) => String(a.start).localeCompare(String(b.start)));\n" +
"      if (!vs.length) {\n" +
"        listBox.appendChild(U.el('div', { class: 'sheet-note', text: '还没有假期。在下面加一个寒暑假或国庆的日期区间即可。' }));\n" +
"        return;\n" +
"      }\n" +
"      vs.forEach((v) => {\n" +
"        listBox.appendChild(U.el('div', { class: 'cat-row' }, [\n" +
"          U.el('div', { class: 'ci', text: '🏖️' }),\n" +
"          U.el('div', { class: 'cn' }, [U.el('b', { text: v.name || '假期' }), U.el('small', { text: v.start + ' ~ ' + v.end })]),\n" +
"          U.el('button', { class: 'btn btn-sm', text: '编辑', onclick: () => { editing = v; renderForm(); } }),\n" +
"          U.el('button', {\n" +
"            class: 'btn btn-sm btn-danger', text: '删除',\n" +
"            onclick: async () => {\n" +
"              const ok = await UI.confirm({ title: '删除假期', message: '确定删除「' + (v.name || '假期') + '」吗？账目不受影响，只是这段时间重新计入统计。', okText: '删除', danger: true });\n" +
"              if (ok) { await Store.removeVacation(v.id); editing = null; renderList(); renderForm(); UI.renderSettings(); }\n" +
"            }\n" +
"          })\n" +
"        ]));\n" +
"      });\n" +
"    }\n" +
"\n" +
"    let editing = null;\n" +
"    const formBox = U.el('div');\n" +
"    function renderForm() {\n" +
"      U.clear(formBox);\n" +
"      const v = editing || { name: '', start: U.todayISO(), end: U.toISODate(U.addDays(new Date(), 7)) };\n" +
"      const nameIn = U.el('input', { class: 'input', placeholder: '例如：寒假、暑假、国庆', value: v.name || '' });\n" +
"      const startF = UI.dateField({ value: v.start, withTime: false });\n" +
"      const endF = UI.dateField({ value: v.end, withTime: false });\n" +
"      formBox.appendChild(U.el('div', { class: 'card tight', style: { marginTop: '12px' } }, [\n" +
"        U.el('div', { class: 'field' }, [U.el('label', { text: '叫什么' }), nameIn]),\n" +
"        U.el('div', { class: 'row row-split' }, [\n" +
"          U.el('div', { class: 'field' }, [U.el('label', { text: '从' }), startF]),\n" +
"          U.el('div', { class: 'field' }, [U.el('label', { text: '到' }), endF])\n" +
"        ]),\n" +
"        U.el('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } }, [\n" +
"          U.el('button', {\n" +
"            class: 'btn btn-sm btn-primary', text: editing ? '保存修改' : '添加假期',\n" +
"            onclick: async () => {\n" +
"              const start = startF.getValue();\n" +
"              const end = endF.getValue();\n" +
"              if (!start || !end) { UI.toast('请选择起止日期', 'err'); return; }\n" +
"              if (end < start) { UI.toast('结束日期不能早于开始日期', 'err'); return; }\n" +
"              const name = nameIn.value.trim() || '假期';\n" +
"              if (editing) await Store.updateVacation(editing.id, { name: name, start: start, end: end });\n" +
"              else await Store.addVacation({ name: name, start: start, end: end });\n" +
"              editing = null;\n" +
"              renderForm();\n" +
"              renderList();\n" +
"              UI.renderSettings();\n" +
"              UI.toast('已保存「' + name + '」', 'ok');\n" +
"            }\n" +
"          }),\n" +
"          editing ? U.el('button', { class: 'btn btn-sm', text: '取消编辑', onclick: () => { editing = null; renderForm(); } }) : null\n" +
"        ])\n" +
"      ]));\n" +
"    }\n" +
"\n" +
"    renderList();\n" +
"    renderForm();\n" +
"    body.appendChild(listBox);\n" +
"    body.appendChild(formBox);\n" +
"\n" +
"    UI.openSheet({\n" +
"      title: '假期设置',\n" +
"      body: body,\n" +
"      note: '提前回校、晚走几天都行，日期完全由你定。假期里的账目在明细里照常看得到。'\n" +
"    });\n" +
"  };\n" +
"\n" +
"  /* ---------------- 分类编辑 ---------------- */\n");

/* 明细行上标出「假期」 */
once('web/js/ui.js',
"    if (t.reimburseStatus === 'pending') metaBits.push('待报销');\n",
"    if (Stats.isVacation(t)) metaBits.push('假期');\n" +
"    if (t.reimburseStatus === 'pending') metaBits.push('待报销');\n");

/* 账单详情里说明 */
once('web/js/ui.js',
"    if (tx.excludeStat) addRow('统计', '不计入（' + (tx.excludeReason || '未注明') + '）');\n" +
"    else if (rbInfo && rbInfo.selfPay > 0) addRow('统计', '只把自己承担的 ' + U.fmtMoney(rbInfo.selfPay) + ' 算进去');\n" +
"    else addRow('统计', '计入统计');\n",
"    if (tx.excludeStat) addRow('统计', '不计入（' + (tx.excludeReason || '未注明') + '）');\n" +
"    else if (Stats.isVacation(tx)) addRow('统计', '假期期间，不计入合计');\n" +
"    else if (rbInfo && rbInfo.selfPay > 0) addRow('统计', '只把自己承担的 ' + U.fmtMoney(rbInfo.selfPay) + ' 算进去');\n" +
"    else addRow('统计', '计入统计');\n");

/* ============ 5. AI 也知道假期这件事 ============ */
once('web/js/ai.js',
"          (t.excludeStat ? '［不计入统计' + (t.excludeReason ? '：' + t.excludeReason : '') + '］' : '') +\n",
"          (t.excludeStat ? '［不计入统计' + (t.excludeReason ? '：' + t.excludeReason : '') + '］' : '') +\n" +
"          (Stats.isVacation(t) ? '［假期，不计入统计］' : '') +\n");

once('web/js/ai.js',
"    '- 报销款、收回的垫付或借款本身不算收入；只有对方多给、多出来的那部分才算收入',\n",
"    '- 报销款、收回的垫付或借款本身不算收入；只有对方多给、多出来的那部分才算收入',\n" +
"    '- 用户可能设置了「假期」日期区间，这段时间的账目一律不计入统计；回答合计时要按这个口径',\n");

console.log('r23 ok');
