/* ============================================================
   browser-suite.js - 在真实浏览器中执行的端到端测试脚本
   由 tools/browser-test.js 通过 Chrome DevTools 协议注入执行。
   这是一个表达式，求值后返回 { results, errors, summary }。
   ============================================================ */
(async () => {
  const XLSX_FIXTURE_B64 = '__XLSX_FIXTURE__';
  function near2(a, b, msg) { ok(Math.abs(a - b) < 0.005, msg + '（期望 ' + b + '，实际 ' + a + '）'); }
  function eq(a, b, msg) { ok(a === b, msg + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }

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
  // 日期字段已经换成自绘控件，这里按占位文字定位输入框，避免顺序变化导致错位
  const inputs = $$('#sheetRoot .field .input');
  const srcInput = inputs.find((el) => (el.placeholder || '').indexOf('食堂') >= 0) || inputs[0];
  const itemInput = inputs.find((el) => (el.placeholder || '').indexOf('午餐') >= 0) || inputs[1];
  srcInput.value = '校园食堂';
  srcInput.dispatchEvent(new Event('input', { bubbles: true }));
  itemInput.value = '午餐';
  itemInput.dispatchEvent(new Event('input', { bubbles: true }));
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

  /* ---------- 16. 自绘日期选择器（不使用系统原生控件） ---------- */
  UI.go('list');
  UI.openTxSheet(null);
  await wait(500);
  ok(!$('#sheetRoot').querySelector('input[type="datetime-local"], input[type="date"]'),
    '记账表单里没有系统原生日期控件');
  const df = $('#sheetRoot .date-field');
  ok(!!df, '记账表单使用自绘的日期字段：' + (df ? df.textContent.trim() : '-'));
  if (df) {
    df.click();
    await wait(500);
    ok(!!$('#pickerRoot .dp-grid'), '点击后弹出自绘日历面板');
    ok($('#pickerRoot').querySelectorAll('.dp-cell').length >= 28,
      '日历渲染出日期格子（' + $('#pickerRoot').querySelectorAll('.dp-cell').length + ' 个）');
    ok(!!$('#pickerRoot .dp-time-grid'), '面板里可以选择具体时间');
    const cells = $$('#pickerRoot .dp-cell');
    cells[3].click();
    await wait(220);
    ok($('#pickerRoot .dp-preview').textContent.indexOf('已选') >= 0, '面板底部显示已选日期预览');
    ok(!!$('#pickerRoot .dp-tcell'), '时间选项渲染正常');
    const before = df.textContent;
    $$('#pickerRoot .sheet-actions .btn')[0].click();
    await wait(500);
    ok(df.textContent.trim().length > 0 && df.textContent !== before,
      '选中的日期回填到表单：' + df.textContent.trim());
    ok(!!$('#sheetRoot .date-field'), '日期面板关闭后记账表单依然存在（独立浮层，不覆盖表单）');
  }
  UI.closeSheet();
  await wait(400);

  /* ---------- 17. 与电脑同步 ---------- */
  UI.go('settings');
  await wait(320);
  ok($('#view-settings').textContent.indexOf('与电脑同步') >= 0, '设置页有「与电脑同步」入口');
  UI.openSyncSheet();
  await wait(450);
  ok($('#sheetRoot').textContent.indexOf('自动同步') >= 0, '同步面板里有自动同步开关');
  ok($('#sheetRoot').textContent.indexOf('同步规则') >= 0, '同步面板说明了合并规则');
  UI.closeSheet();
  await wait(380);

  /* ---------- 18. 安卓 App 环境适配 ---------- */
  const saved = [];
  window.AndroidApp = { save: function (name, b64) { saved.push({ name: name, len: (b64 || '').length }); } };
  U.download('备份测试.json', '{"ok":1}', 'application/json');
  await wait(500);
  ok(saved.length === 1, '在安卓 App 环境中导出会走原生保存接口');
  ok(saved.length === 1 && saved[0].name === '备份测试.json', '传给原生的文件名正确');
  ok(saved.length === 1 && saved[0].len > 0, '传给原生的内容非空');
  delete window.AndroidApp;

  /* ---------- 19. 导出 Excel 与图片报告 ---------- */
  const savedFiles = [];
  window.AndroidApp = { save: function (name, b64) { savedFiles.push({ name: name, b64: b64 }); } };

  const exportRange = Stats.range('all');
  const exportList = Store.query({ from: exportRange.from, to: exportRange.to, includeExcluded: true, includeHidden: true });

  const xlsxName = Report.exportExcel({ list: exportList, range: exportRange });
  await wait(800);
  const xlsxFile = savedFiles.find((f) => f.name === xlsxName);
  ok(!!xlsxFile, 'Excel 导出成功：' + xlsxName);
  if (xlsxFile) {
    const bin = atob(xlsxFile.b64);
    ok(bin.charCodeAt(0) === 0x50 && bin.charCodeAt(1) === 0x4b, 'Excel 文件是合法的 ZIP（PK 魔数）');
    ok(bin.indexOf('[Content_Types].xml') >= 0, 'Excel 内含内容类型定义');
    ok(bin.indexOf('xl/worksheets/sheet1.xml') >= 0, 'Excel 内含工作表');
    // ZIP 条目未压缩，把字节按 UTF-8 解码后即可直接看到里面的中文
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const inner = new TextDecoder('utf-8').decode(bytes);
    ok(inner.indexOf('账目明细') >= 0, 'Excel 内含「账目明细」工作表名');
    ok(inner.indexOf('分类汇总') >= 0, 'Excel 内含「分类汇总」工作表名');
    ok(inner.indexOf('校园食堂') >= 0, 'Excel 明细里能看到账目内容');
    ok(inner.indexOf('周期汇总') >= 0, 'Excel 内含「周期汇总」工作表名');
  }

  const imgName = await Report.exportImage({ list: exportList, range: exportRange });
  await wait(900);
  const imgFile = savedFiles.find((f) => f.name === imgName);
  ok(!!imgFile, '图片报告导出成功：' + imgName);
  let pngB64 = '';
  if (imgFile) {
    const ib = atob(imgFile.b64);
    pngB64 = imgFile.b64;
    ok(ib.charCodeAt(0) === 0x89 && ib.slice(1, 4) === 'PNG', '图片是合法的 PNG 文件');
    ok(imgFile.b64.length > 20000, '图片内容非空（' + Math.round(imgFile.b64.length / 1024) + ' KB base64）');
  }

  const canvas = Report.renderCanvas((function () {
    const d = Report.buildReportData(exportList, exportRange);
    d._list = exportList;
    return d;
  })(), {});
  ok(canvas.width === 1080, '报告图片宽度 1080');
  ok(canvas.height > 800, '报告图片高度自适应内容：' + canvas.height);

  delete window.AndroidApp;

  /* ---------- 20. 自动备份 ---------- */
  const bkInfo = await Backup.run(true);
  ok(!!bkInfo && bkInfo.txCount === Store.tx.length, '可以手动创建备份快照（' + (bkInfo ? bkInfo.txCount : 0) + ' 条）');
  const bkList = await Backup.list();
  ok(bkList.length >= 1, '备份列表里有快照（' + bkList.length + ' 份）');

  const cntBefore = Store.tx.length;
  await Store.removeTx(Store.tx[0].id);
  await wait(200);
  ok(Store.tx.length === cntBefore - 1, '删除一笔后条数减少');

  await Backup.restore(bkInfo.key);
  await wait(400);
  ok(Store.tx.length === cntBefore, '还原备份后数据恢复（' + Store.tx.length + ' 条）');
  ok((await Backup.list()).length >= 1, '还原操作不会把备份快照本身删掉');

  /* ---------- 21. 导出设置面板可打开 ---------- */
  UI.openExportSheet();
  await wait(400);
  ok($('#sheetRoot').textContent.indexOf('导出 Excel') >= 0, '导出面板可以打开');
  ok($('#sheetRoot').textContent.indexOf('图片报告') >= 0, '导出面板含图片报告选项');
  UI.closeSheet();
  await wait(350);
  UI.openBackupSheet();
  await wait(500);
  ok($('#sheetRoot').textContent.indexOf('自动备份') >= 0, '备份面板可以打开');
  ok($('#sheetRoot').textContent.indexOf('备份记录') >= 0, '备份面板列出备份记录');
  UI.closeSheet();
  await wait(350);

  /* ---------- 22. 安卓 App 默认完全独立，不依赖电脑 ---------- */
  window.AndroidApp = { save: function () { /* 仅用于识别环境 */ } };
  ok(Sync.isApp() === true, '能识别出处于安卓 App 环境');
  const savedUrl = Sync.config.url;
  Sync.config.url = '';
  ok(Sync.available() === false, '没填电脑地址时同步功能关闭');
  ok(Sync.statusText() === '未配置', '同步状态显示为「未配置」');
  ok(Sync.isApp() && !Sync.available(), 'App 不依赖电脑也能正常使用');

  const beforeCount = Store.tx.length;
  const offlineTx = await Store.addTx({ type: 'expense', amount: 1.23, time: Date.now(), categoryName: '其他', counterparty: '离线测试' });
  ok(Store.tx.length === beforeCount + 1, '断网状态下依然可以正常记账');
  const backRange = Stats.range('all');
  ok(Store.query({ from: backRange.from, to: backRange.to }).some((x) => x.id === offlineTx.id),
    '新记的账目立刻出现在明细查询里');
  await Store.removeTx(offlineTx.id);
  ok(Store.tx.length === beforeCount, '删除也完全在本地完成');

  Sync.config.url = savedUrl;
  delete window.AndroidApp;

  /* ---------- 23. 微信 xlsx 账单导入 ---------- */
  const xlsxBytes = Uint8Array.from(atob(XLSX_FIXTURE_B64), (c) => c.charCodeAt(0));
  const book = await Xlsx.read(xlsxBytes.buffer);
  ok(book.sheets.length >= 1, 'xlsx 读取成功，共 ' + book.sheets.length + ' 个工作表');
  ok(book.sheets[0].rows.length >= 6, '读到 ' + book.sheets[0].rows.length + ' 行数据');

  const xp = await Importer.parseXlsx(xlsxBytes.buffer, { autoClassify: true, dedupe: true, includeIgnore: true, excludeRefund: true });
  ok(xp.source === 'xlsx', '识别为 Excel 来源');
  eq(xp.items.length, 4, '从 xlsx 里解析出 4 条流水');
  const findParty = (n) => xp.items.find((it) => it.tx.counterparty === n);
  ok(!!findParty('校园食堂'), '读到「校园食堂」');
  near2(findParty('校园食堂').tx.amount, 15.01, '金额含小数也正确');
  eq(findParty('校园食堂').tx.categoryName, '餐饮', 'xlsx 导入也会自动分类');
  eq(findParty('爸爸').tx.type, 'income', '「爸爸 转账」识别为收入');
  eq(findParty('爸爸').tx.categoryName, '生活费', '「爸爸」归类为生活费');
  eq(findParty('零钱提现').tx.excludeStat, true, '「不计收支」被标记为不计入统计');
  eq(xp.stats.dataRows, xp.items.length + xp.stats.ignored + xp.stats.skipped, 'xlsx 的每一行也都有归宿');

  /* ---------- 24. 走势图：柱子基线统一 + 日期斜排 ---------- */
  UI.go('stats');
  await wait(450);
  const trendEl = $('#view-stats .trend');
  ok(!!trendEl, '统计页有走势图');
  if (trendEl) {
    ok(trendEl.classList.contains('is-daily'), '按天展示时启用斜排标签');
    const cols = $$('#view-stats .trend-col');
    const bars = $$('#view-stats .trend-bars');
    const labs = $$('#view-stats .trend-labels');
    ok(cols.length > 0, '走势图共 ' + cols.length + ' 列');
    eq(bars.length, cols.length, '每一列都有独立的柱区');
    eq(labs.length, cols.length, '每一列都有独立的标签区');

    const bh = bars.map((b) => Math.round(b.getBoundingClientRect().height));
    ok(bh.every((h) => h === bh[0]), '所有柱区高度一致（' + bh[0] + 'px），柱子起点因此统一');
    const lbh = labs.map((b) => Math.round(b.getBoundingClientRect().height));
    ok(lbh.every((h) => h === lbh[0]), '所有标签区高度一致（' + lbh[0] + 'px）');

    const bottoms = bars.map((b) => b.getBoundingClientRect().bottom);
    const spread = Math.max.apply(null, bottoms) - Math.min.apply(null, bottoms);
    ok(spread <= 1, '所有柱子的基线对齐（最大偏差 ' + spread.toFixed(2) + 'px）');

    const xEl = $('#view-stats .trend-x');
    ok(!!xEl, '渲染出日期标签');
    if (xEl) {
      const cs = getComputedStyle(xEl);
      ok(cs.transform.indexOf('matrix') === 0, '日期标签已旋转 45°：' + cs.transform);
      ok(cs.fontVariantNumeric === 'tabular-nums', '数字使用等宽数字（font-variant-numeric=' + cs.fontVariantNumeric + '）');
      ok(cs.fontFamily.toLowerCase().indexOf('mono') >= 0, '日期标签使用等宽字体，每个字符宽度一致');
    }
  }

  /* ---------- 25. 滚到底部时悬浮按钮不遮挡内容 ---------- */
  UI.go('stats');
  await wait(350);
  window.scrollTo(0, document.body.scrollHeight);
  await wait(500);
  const fabRect = $('#btnAdd').getBoundingClientRect();
  const cards = $$('#view-stats .card');
  const lastCard = cards[cards.length - 1];
  const lastRect = lastCard.getBoundingClientRect();
  ok(lastRect.bottom <= fabRect.top + 1,
    '滚到底部时最后一张卡片在悬浮按钮上方（卡片底 ' + Math.round(lastRect.bottom) + 'px，按钮顶 ' + Math.round(fabRect.top) + 'px）');
  window.scrollTo(0, 0);
  await wait(200);

  /* ---------- 26. 连续弹层不会卡住（回归测试） ---------- */
  UI.openSheet({ title: '第一个', body: U.el('div', { text: 'A' }), actions: [{ label: '关闭', onClick: function () { UI.closeSheet(); } }] });
  await wait(200);
  UI.closeSheet();
  await wait(120);   // 故意在旧弹层的 300ms 延时清理之前打开新弹层
  UI.openSheet({ title: '第二个', body: U.el('div', { text: 'B' }), actions: [{ label: '确定', onClick: function () { UI.closeSheet(); } }] });
  await wait(600);   // 越过旧清理本该触发的时刻
  const h3 = $('#sheetRoot .sheet-head h3');
  ok(!!h3 && h3.textContent === '第二个',
    '新弹层没有被旧的延时清理抹掉（实际：' + (h3 ? h3.textContent : '空') + '）');
  ok($('#sheetRoot').classList.contains('is-open'), '弹层仍处于打开状态');
  let sheetClicked = false;
  const sBtn = $('#sheetRoot .sheet-actions .btn');
  ok(!!sBtn, '弹层里还有可点的按钮');
  if (sBtn) { sBtn.addEventListener('click', function () { sheetClicked = true; }); sBtn.click(); }
  await wait(150);
  ok(sheetClicked, '弹层里的按钮可以正常点击（页面没有被看不见的遮罩挡住）');
  await wait(500);
  ok(!$('#sheetRoot').classList.contains('is-open'), '全部关闭后弹层不再拦截点击');

  /* ---------- 27. 分级清理数据 ---------- */
  const snapshot = Store.exportObject();          // 先存档，测完还原
  const txBefore = Store.tx.length;
  const catBefore = Store.categories.length;
  await Store.addTx({ type: 'expense', amount: 9.99, time: Date.now(), categoryName: '其他', counterparty: '清理测试' });
  ok(Store.tx.length === txBefore + 1, '先记一笔用于测试（' + Store.tx.length + ' 条）');

  await UI.openClearDataSheet();
  await wait(600);
  const clearRows = $$('#sheetRoot .clear-row');
  eq(clearRows.length, 5, '清理面板有 5 个分级选项');
  ['仅清空账单', '仅清空分类', '仅清空设置', '清空备份快照', '清除所有数据'].forEach(function (name) {
    ok($('#sheetRoot').textContent.indexOf(name) >= 0, '面板里有「' + name + '」');
  });

  /* 只清账单：分类必须留着 */
  clearRows[0].querySelector('button').click();
  await wait(550);
  ok($('#sheetRoot').textContent.indexOf('将删除全部') >= 0, '弹出确认框');
  $$('#sheetRoot .sheet-actions .btn')[1].click();
  await wait(1100);
  eq(Store.tx.length, 0, '仅清空账单：账目已清空');
  eq(Store.categories.length, catBefore, '仅清空账单：分类完好（' + Store.categories.length + ' 个）');
  ok($('#sheetRoot').textContent.indexOf('已清空') >= 0, '面板回到清理界面并显示结果');
  ok($('#sheetRoot').querySelectorAll('.clear-row').length === 5, '清理面板依然完好可用');

  /* 清完还能继续操作（这正是之前卡死的场景） */
  let afterClearClickable = false;
  const nextBtn = $$('#sheetRoot .clear-row')[2].querySelector('button');
  if (nextBtn) { nextBtn.addEventListener('click', function () { afterClearClickable = true; }); nextBtn.click(); }
  await wait(450);
  ok(afterClearClickable, '清空之后面板里的按钮依然可以点击');
  if ($('#sheetRoot').classList.contains('is-open')) UI.closeSheet();
  await wait(450);

  /* 还原现场 */
  await Store.importObject(snapshot, 'replace');
  await wait(400);
  ok(Store.tx.length === txBefore + 1, '还原后数据恢复（' + Store.tx.length + ' 条）');
  ok(Store.categories.length === catBefore, '分类也恢复（' + Store.categories.length + ' 个）');

  /* 清除所有：连备份快照一起清掉 */
  const bkN = (await Backup.list()).length;
  const snap2 = Store.exportObject();
  const wiped = await Store.wipeAll();
  ok(wiped.tx > 0, '清除所有：清掉了 ' + wiped.tx + ' 条账目');
  eq(Store.tx.length, 0, '清除所有：账目为空');
  eq(Store.categories.length, 0, '清除所有：分类为空');
  eq((await Backup.list()).length, 0, '清除所有：备份快照也为空（原本 ' + bkN + ' 份）');
  ok(Store.settings.autoBackup === true, '清除所有：设置恢复默认');

  /* 恢复现场，避免影响后面的截图 */
  await Store.importObject(snap2, 'replace');
  await wait(400);
  ok(Store.tx.length === txBefore + 1 && Store.categories.length === catBefore, '测试结束后已还原现场');

  UI.go('home');
  await wait(250);

  return {
    results: results,
    errors: errors,
    artifacts: {
      xlsx: xlsxFile ? { name: xlsxName, b64: xlsxFile.b64 } : null,
      png: pngB64 ? { name: imgName, b64: pngB64 } : null
    },
    summary: {
      pass: results.filter((r) => r.ok).length,
      fail: results.filter((r) => !r.ok).length,
      txCount: Store.tx.length,
      catCount: Store.categories.length
    }
  };
})()