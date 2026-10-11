/* ============================================================
   browser-suite.js - 在真实浏览器中执行的端到端测试脚本
   由 tools/browser-test.js 通过 Chrome DevTools 协议注入执行。
   这是一个表达式，求值后返回 { results, errors, summary }。
   ============================================================ */
(async () => {
  const results = [];
  const errors = [];
  const ok = (cond, msg) => results.push({ ok: !!cond, msg: String(msg) });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

  window.addEventListener('error', (e) => errors.push('error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + ((e.reason && e.reason.message) || e.reason)));

  /* ---------- 1. 启动 ---------- */
  const t0 = Date.now();
  while (!(window.Store && window.Store.loaded) && Date.now() - t0 < 15000) await wait(60);
  ok(window.Store && window.Store.loaded, '应用启动完成，数据层就绪');
  if (!(window.Store && window.Store.loaded)) return { results, errors, summary: {} };

  ok(Store.categories.length >= 20, '默认分类已生成（' + Store.categories.length + ' 个）');
  ok(!!Stats.range('semester').label, '学期周期可计算：' + Stats.range('semester').label);
  ok(!!Stats.range('week').label, '周周期可计算：' + Stats.range('week').label);
  ok(!!Stats.range('month').label, '月周期可计算：' + Stats.range('month').label);

  /* ---------- 重置，保证自检可重复 ---------- */
  await DB.clearAll();
  Store.tx = []; Store.categories = []; Store.reindex();
  await Store.applyPack('college', true);
  Store.emit('all');
  await wait(250);

  /* ---------- 2. 四个标签页渲染 ---------- */
  const NAMES = { home: '概览', list: '明细', stats: '统计', settings: '设置' };
  for (const t of ['home', 'list', 'stats', 'settings']) {
    $('.tab[data-tab="' + t + '"]').click();
    await wait(180);
    const v = $('#view-' + t);
    ok(v.classList.contains('is-active') && v.innerHTML.length > 150, '「' + NAMES[t] + '」页面渲染正常');
  }
  ok($('.tab[data-tab="settings"]').classList.contains('is-active'), '标签栏高亮切换正确');

  /* ---------- 3. 通过界面新增一笔支出 ---------- */
  UI.go('list');
  $('#btnAdd').click();
  await wait(400);
  const amt = $('#sheetRoot .amount-input input');
  ok(!!amt, '「记一笔」表单可以打开');
  amt.value = '25.50';
  amt.dispatchEvent(new Event('input', { bubbles: true }));
  const fields = $$('#sheetRoot .field .input');
  fields[1].value = '校园食堂';
  fields[1].dispatchEvent(new Event('input', { bubbles: true }));
  fields[2].value = '午餐';
  fields[2].dispatchEvent(new Event('input', { bubbles: true }));
  $$('#sheetRoot .sheet-actions .btn')[0].click();
  const t1 = Date.now();
  while (Store.tx.length < 1 && Date.now() - t1 < 3000) await wait(60);
  ok(Store.tx.length === 1, '界面上记账成功写入 1 笔');
  ok(Store.tx[0].amount === 25.5, '金额记录正确（25.50）');
  ok(Store.tx[0].counterparty === '校园食堂', '来源（交易对方）记录正确');
  ok(Store.tx[0].item === '午餐', '用途记录正确');
  ok(!!Store.tx[0].categoryId, '自动选中了分类：' + Store.tx[0].categoryName);

  /* ---------- 4. 明细页展示 ---------- */
  UI.go('list');
  await wait(250);
  const listText = $('#view-list').textContent;
  ok(listText.indexOf('校园食堂') >= 0, '明细页显示来源');
  ok(listText.indexOf('25.50') >= 0, '明细页显示金额');
  ok(listText.indexOf('餐饮') >= 0, '明细页显示分类');

  /* ---------- 5. 报销：收入与支出都不计入统计 ---------- */
  const tx = Store.tx[0];
  await Store.markReimburse(tx.id, '报销');
  await wait(200);
  const r = Stats.range('month');
  let f = Stats.full(Store.query({ from: r.from, to: r.to, includeExcluded: true }));
  ok(f.included.expense === 0, '标记报销后支出不计入本月合计');
  ok(f.excluded.count === 1, '被排除的账目单独统计');

  UI.go('list');
  await wait(300);
  const rowEl = $('#view-list .tx.is-excluded');
  ok(!!rowEl, '不计入统计的账单在明细中有视觉区分');
  ok(rowEl && parseFloat(getComputedStyle(rowEl).opacity) < 1, '不计入统计的账单显示为淡化样式（opacity ' + (rowEl ? getComputedStyle(rowEl).opacity : '-') + '）');

  UI.go('home');
  await wait(200);
  ok($('#view-home').textContent.indexOf('待报销') >= 0, '概览页出现「待报销」提醒');

  const inc = await Store.settleReimburse(tx.id, { amount: 25.5, time: U.todayISO(), account: '微信', counterparty: '爸爸' });
  await wait(250);
  ok(inc.type === 'income' && inc.excludeStat === true, '报销款配对方生成不计入统计的收入');
  ok(!!Store.getTx(tx.id).reimburseGroupId && Store.getTx(tx.id).reimburseGroupId === inc.reimburseGroupId, '两笔通过报销组关联');
  f = Stats.full(Store.query({ from: r.from, to: r.to, includeExcluded: true }));
  ok(f.included.expense === 0 && f.included.income === 0, '报销的收入和支出都不计入本月账单');
  ok(f.excluded.count === 2, '报销的收支两笔都被排除');

  /* ---------- 6. 隐藏账单 ---------- */
  await Store.updateTx(inc.id, { hidden: true });
  await wait(200);
  ok(Store.query({ from: r.from, to: r.to, includeExcluded: true }).length === 1, '隐藏后默认查询看不到该笔');
  ok(Store.query({ from: r.from, to: r.to, includeExcluded: true, includeHidden: true }).length === 2, '打开开关后可见');

  /* ---------- 7. 导入引擎（真实 CSV 文本） ---------- */
  const csv = [
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
    '2026-10-02 12:30:00,商户消费,美团,外卖午餐,支出,\u00a528.00,零钱,支付成功,TEST0001,M0001,/',
    '2026-10-03 09:00:00,转账,妈妈,生活费,收入,\u00a51000.00,零钱,已存入零钱,TEST0002,/,/',
    '2026-10-04 08:00:00,商户消费,上海地铁,地铁票款,支出,\u00a54.00,零钱,支付成功,TEST0003,M0003,/'
  ].join('\n');
  const parsed = Importer.parse(csv, { autoClassify: true, dedupe: true, includeIgnore: false, excludeRefund: true });
  ok(parsed.items.length === 3, '导入引擎解析出 3 条');
  ok(parsed.detect.kind === 'wechat', '导入引擎识别为微信支付账单');
  ok(parsed.items.find((i) => i.tx.counterparty === '美团').tx.categoryName === '餐饮', '自动分类：美团 → 餐饮');
  ok(parsed.items.find((i) => i.tx.counterparty === '上海地铁').tx.categoryName === '交通', '自动分类：地铁 → 交通');
  ok(parsed.items.find((i) => i.tx.counterparty === '妈妈').tx.categoryName === '生活费', '自动分类：妈妈 → 生活费');

  UI.state.importText = csv;
  UI.state.importFileName = '自检样例.csv';
  UI.state.importEncoding = 'UTF-8';
  const n = await Importer.commit(parsed.items);
  ok(n === 3, '导入写入 3 条账单');
  const again = Importer.parse(csv, { autoClassify: true, dedupe: true });
  ok(again.items.filter((i) => i.dup).length === 3, '再次导入同一文件全部识别为重复');
  ok((await Importer.commit(again.items)) === 0, '重复账单不会被写入');

  /* ---------- 8. 导入面板可以打开 ---------- */
  UI.openImportSheet();
  await wait(400);
  ok(!!$('#sheetRoot .drop'), '导入面板可以打开');
  ok(!!$('#sheetRoot .switch'), '导入面板含选项开关');
  UI.closeSheet();
  await wait(320);

  /* ---------- 9. 统计页图表 ---------- */
  UI.go('stats');
  await wait(300);
  const sv = $('#view-stats');
  ok(!!sv.querySelector('.donut svg'), '统计页渲染出环形图');
  ok(sv.querySelectorAll('.stat-card').length >= 4, '统计页显示收支卡片');
  ok(sv.querySelectorAll('.bar-item').length >= 1, '统计页显示分类/来源排行');
  ok(!!sv.querySelector('.trend'), '统计页渲染出趋势图');

  const st = Store.query({ from: Stats.range('month').from, to: Stats.range('month').to });
  const sum = Stats.summarize(st);
  ok(sum.income > 0 && sum.expense > 0, '本月有收入与支出数据用于统计（收 ' + sum.income + ' / 支 ' + sum.expense + '）');

  /* ---------- 10. 设置页 ---------- */
  UI.go('settings');
  await wait(300);
  const setv = $('#view-settings');
  ok(setv.textContent.indexOf('管理支出分类') >= 0, '设置页有分类管理入口');
  ok(setv.textContent.indexOf('报销') >= 0, '设置页包含报销说明');
  ok(setv.textContent.indexOf('账单导入') >= 0 && setv.textContent.indexOf('学期设置') >= 0, '设置页包含导入导出与学期设置');
  ok(!!setv.querySelector('.switch'), '设置页含开关控件');
  UI.openCategoryManager('expense');
  await wait(420);
  ok($('#sheetRoot').querySelectorAll('.cat-row').length >= 14, '分类管理面板列出全部支出分类');
  ok($('#sheetRoot').textContent.indexOf('新建支出分类') >= 0, '分类管理面板有新建入口');
  UI.closeSheet();
  await wait(360);

  /* ---------- 11. 分类与学期管理面板 ---------- */
  UI.openCategoryEditSheet(null, 'expense');
  await wait(350);
  ok(!!$('#sheetRoot .cat-grid, #sheetRoot .chips'), '新建分类面板可以打开');
  UI.closeSheet();
  await wait(320);
  UI.openSemesterSheet();
  await wait(350);
  ok($('#sheetRoot').textContent.indexOf('当前学期') >= 0 || $('#sheetRoot').textContent.indexOf('学期') >= 0, '学期管理面板可以打开');
  UI.closeSheet();
  await wait(320);

  /* ---------- 12. 导出 ---------- */
  ok(Store.exportCSV().indexOf('校园食堂') > 0, 'CSV 导出包含账单数据');
  ok(JSON.parse(Store.exportJSON()).tx.length === Store.tx.length, 'JSON 备份条数与库内一致');

  /* ---------- 13. 主题切换 ---------- */
  const before = document.documentElement.getAttribute('data-theme');
  $('#btnTheme').click();
  await wait(250);
  ok(document.documentElement.getAttribute('data-theme') !== before, '深色/浅色主题可以切换');
  $('#btnTheme').click();
  await wait(250);

  /* ---------- 14. 运行期无报错 ---------- */
  ok(errors.length === 0, '运行期无 JavaScript 报错' + (errors.length ? '：' + errors.slice(0, 3).join(' | ') : ''));

  /* ---------- 15. 周期标签与表单布局回归 ---------- */
  UI.go('home');
  await wait(250);
  const nowD = new Date();
  const monthLabel = nowD.getFullYear() + '年' + (nowD.getMonth() + 1) + '月';
  ok(Stats.range('month').label === monthLabel, '「本月」周期标签正确：' + Stats.range('month').label);
  ok(Stats.range('all').label === '全部记录', '「全部」周期标签正确');
  const heroLabel = $('#view-home .hero-label span');
  ok(heroLabel && heroLabel.textContent !== '全部记录', '概览主卡片按所选周期显示（' + (heroLabel ? heroLabel.textContent : '-') + '）');

  UI.openTxSheet(null);
  await wait(700);
  const sheetEl = $('#sheetRoot .sheet');
  ok(sheetEl.scrollLeft === 0, '记账表单无横向位移（scrollLeft=' + sheetEl.scrollLeft + '）');
  ok(document.documentElement.scrollWidth <= window.innerWidth + 1, '页面无横向溢出');
  let over = 0;
  $$('#sheetRoot *').forEach((n) => {
    const rr = n.getBoundingClientRect();
    if (rr.width > 0 && (rr.left < -1 || rr.right > window.innerWidth + 1)) over++;
  });
  ok(over === 0, '记账表单内没有元素超出屏幕（溢出 ' + over + ' 个）');
  UI.closeSheet();
  await wait(340);

  UI.go('home');
  await wait(250);

  return {
    results: results,
    errors: errors,
    summary: {
      pass: results.filter((r) => r.ok).length,
      fail: results.filter((r) => !r.ok).length,
      txCount: Store.tx.length,
      catCount: Store.categories.length
    }
  };
})()