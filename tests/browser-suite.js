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
  const parsed = Importer.parse(csv, { autoClassify: true, dedupe: true, ignoreMode: 'skip', refundMode: 'count' });
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
  const syncTitle = Sync.isApp() ? '与电脑同步' : '与手机同步';
  ok($('#view-settings').textContent.indexOf(syncTitle) >= 0, '设置页有「' + syncTitle + '」入口（电脑上说的是与手机同步）');
  ok($('#view-settings').textContent.indexOf('与手机同步') >= 0 || Sync.isApp(), '电脑端不再写「与电脑同步」');
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

  const xp = await Importer.parseXlsx(xlsxBytes.buffer, { autoClassify: true, dedupe: true, ignoreMode: 'exclude', refundMode: 'exclude' });
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

  /* 恢复现场，并把测试用的那一笔删掉，避免污染截图 */
  await Store.importObject(snap2, 'replace');
  await wait(400);
  ok(Store.tx.length === txBefore + 1 && Store.categories.length === catBefore, '测试结束后已还原现场');
  const leftover = Store.tx.find((x) => x.counterparty === '清理测试');
  if (leftover) await Store.removeManyTx([leftover.id]);
  await wait(250);

  /* ---------- 28. 安全区不会被重复计算 ---------- */
  const rootEl = document.documentElement;
  rootEl.style.setProperty('--inset-t-px', '30px');
  rootEl.style.setProperty('--inset-b-px', '24px');
  UI.applySafeArea();
  const csRoot = getComputedStyle(rootEl);
  const safeT = parseFloat(csRoot.getPropertyValue('--safe-t-native')) || 0;
  const safeB = parseFloat(csRoot.getPropertyValue('--safe-b-native')) || 0;
  const fillsScreen = (window.screen.height - window.innerHeight) < 10;
  if (fillsScreen) {
    ok(safeT === 30 && safeB === 24, '内容铺满全屏时采用原生实测值（上 ' + safeT + ' / 下 ' + safeB + '）');
  } else {
    ok(safeT === 0 && safeB === 0, '内容未铺满全屏时不叠加原生边距，避免上下重复留白');
  }

  UI.go('stats');
  await wait(400);
  const topbarPad = parseFloat(getComputedStyle($('.topbar')).paddingTop) || 0;
  const tabbarPad = parseFloat(getComputedStyle($('.tabbar')).paddingBottom) || 0;
  ok(Math.abs(topbarPad - (safeT + 6)) < 1.5, '顶栏上边距 = 安全区 + 6px（实际 ' + topbarPad + 'px）');
  ok(Math.abs(tabbarPad - Math.max(2, safeB - 16)) < 1.5, '切换栏下边距已下压 16px（实际 ' + tabbarPad + 'px）');
  ok(topbarPad <= 60, '顶栏上边距不会过大：' + topbarPad + 'px');
  ok(tabbarPad <= 40, '切换栏下边距不会过大：' + tabbarPad + 'px');

  rootEl.style.setProperty('--inset-t-px', '0px');
  rootEl.style.setProperty('--inset-b-px', '0px');
  UI.applySafeArea();

  /* ---------- 29. 设置页两个清理按钮的宽度 ---------- */
  UI.go('settings');
  await wait(450);
  const setBtns = $$('#view-settings button');
  const btnDup = setBtns.find((b) => b.textContent === '清理重复数据');
  const btnNew = setBtns.find((b) => b.textContent === '分级清理数据');
  ok(!!btnDup && !!btnNew, '找到两个清理按钮');
  if (btnDup && btnNew) {
    const w1 = Math.round(btnDup.getBoundingClientRect().width);
    const w2 = Math.round(btnNew.getBoundingClientRect().width);
    ok(w1 > 120 && w2 > 120, '两个按钮都足够宽（' + w1 + 'px / ' + w2 + 'px）');
    ok(Math.abs(w1 - w2) <= 2, '两个按钮等宽，用满了整行空间');
    ok(btnNew.textContent.indexOf('…') < 0, '按钮文字里没有省略号');
    ok(btnNew.scrollWidth <= btnNew.clientWidth + 1,
      '按钮文字没有被裁切（scrollWidth ' + btnNew.scrollWidth + ' <= clientWidth ' + btnNew.clientWidth + '）');
  }

  /* ---------- 30. 余额宝收益在界面上显示为正数 ---------- */
  const gainCsvFixture = [
    '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注',
    '2026-08-01 00:00:00,投资理财,余额宝,,余额宝-收益发放,不计收支,0.02,余额宝,交易成功,GAIN0001,,/'
  ].join('\n');
  const gainRes = Importer.parse(gainCsvFixture, { ignoreMode: 'exclude', refundMode: 'exclude', autoClassify: true, dedupe: true });
  eq(gainRes.items.length, 1, '解析出 1 条收益流水');
  eq(gainRes.items[0].tx.type, 'income', '收益流水判定为收入方向');
  eq(gainRes.items[0].tx.excludeStat, true, '收益流水依然不计入统计');
  await Importer.commit(gainRes.items);
  const gainTx = Store.tx.find((t) => t.externalId === 'GAIN0001');
  ok(!!gainTx, '收益流水已入库');

  UI.state.list.period = 'all';
  UI.state.list.showHidden = true;
  UI.go('list');
  await wait(500);
  const listTxt = $('#view-list').textContent;
  ok(listTxt.indexOf('+0.02') >= 0, '明细页显示 +0.02（不再是 -0.02）');
  ok(listTxt.indexOf('-0.02') < 0, '明细页不再出现 -0.02');

  if (gainTx) await Store.removeManyTx([gainTx.id]);
  UI.state.list.period = 'month';
  UI.state.list.showHidden = false;   // 复位，避免影响后面的测试
  await wait(200);

  /* ---------- 31. 导入面板：排除规则由用户选 ---------- */
  UI.openImportSheet();
  await wait(650);
  const impTxt = $('#sheetRoot').textContent;
  ok(impTxt.indexOf('由你决定') >= 0, '导入面板写明排除规则由用户决定');
  ok(impTxt.indexOf('不计入合计') >= 0, '有「不计入合计」选项');
  ok(impTxt.indexOf('计入合计') >= 0, '有「计入合计」选项');
  ok(impTxt.indexOf('不导入') >= 0, '有「不导入」选项');
  const modeSegs = $$('#sheetRoot .seg');
  ok(modeSegs.length >= 2, '有两组单选控件（不计收支 / 退款）：' + modeSegs.length + ' 组');

  if (modeSegs.length) {
    const kids = Array.prototype.slice.call(modeSegs[0].children);
    const active = kids.find((b) => b.classList.contains('is-active'));
    ok(!!active && active.textContent === '计入合计',
      '默认就选中「计入合计」（什么都不排除）：' + (active ? active.textContent : '-'));
    eq(UI.state.importOpts.ignoreMode, 'count', '导入面板默认 ignoreMode=count');
    eq(UI.state.importOpts.refundMode, 'count', '导入面板默认 refundMode=count');

    const btnEx = kids.find((b) => b.textContent === '不计入合计');
    ok(!!btnEx, '找到「不计入合计」按钮');
    if (btnEx) {
      btnEx.click();
      await wait(180);
      ok(btnEx.classList.contains('is-active'), '可以切到「不计入合计」');
      eq(UI.state.importOpts.ignoreMode, 'exclude', '切换后写入 ignoreMode=exclude');
      const btnBack = Array.prototype.slice.call(modeSegs[0].children)
        .find((b) => b.textContent === '计入合计');
      if (btnBack) { btnBack.click(); await wait(150); }
      eq(UI.state.importOpts.ignoreMode, 'count', '再切回「计入合计」');
    }
  }
  UI.closeSheet();
  await wait(420);

  /* 选「计入合计」后重新解析：一条都不应被排除 */
  const segCsv = [
    '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注',
    '2026-06-01 12:00:00,餐饮美食,学校餐厅,,午餐,支出,15.00,余额宝,交易成功,SG0001,,/',
    '2026-06-02 09:00:00,投资理财,余额宝,,余额宝-收益发放,不计收支,0.02,余额宝,交易成功,SG0002,,/'
  ].join('\n');
  const segRes = Importer.parse(segCsv, { ignoreMode: 'count', refundMode: 'count', autoClassify: true, dedupe: true });
  eq(segRes.items.length, 2, '「计入合计」模式下 2 条全部导入');
  eq(segRes.items.filter((it) => it.tx.excludeStat).length, 0, '「计入合计」模式下没有任何一条被排除');
  eq(segRes.items.find((it) => it.tx.counterparty === '学校餐厅').tx.excludeStat, false, '学校餐厅照常计入');

  UI.state.importOpts.ignoreMode = 'count';
  UI.state.importOpts.refundMode = 'count';

  /* ---------- 32. 图片报告抬头可自定义 ---------- */
  UI.go('stats');
  await wait(400);
  UI.openExportSheet();
  await wait(650);
  const titleInput = $$('#sheetRoot input.input').find((el) => String(el.maxLength) === '24');
  ok(!!titleInput, '导出面板里有抬头输入框');
  if (titleInput) {
    titleInput.value = '10 月生活费账目';
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));

    const savedNames = [];
    window.AndroidApp = { save: function (name) { savedNames.push(name); } };
    const genBtn = $$('#sheetRoot button').find((b) => b.textContent.indexOf('生成图片报告') >= 0);
    ok(!!genBtn, '找到「生成图片报告」按钮');
    if (genBtn) {
      genBtn.click();
      await wait(1800);
      ok(savedNames.length === 1, '图片已生成');
      ok(savedNames.length === 1 && savedNames[0].indexOf('10 月生活费账目') >= 0,
        '导出文件名用上了自定义抬头：' + savedNames[0]);
    }
    delete window.AndroidApp;
    eq(Store.settings.reportTitle, '10 月生活费账目', '抬头被记住，下次打开会自动带上');
  }
  UI.closeSheet();
  await wait(420);

  await Store.updateSettings({ reportTitle: '大学生活记账本' });

  /* ---------- 33. 明细筛选按钮的文案 ---------- */
  UI.go('list');
  await wait(450);
  let chips = $$('#view-list .chip');
  const chipExcluded = chips.find((c) => c.textContent.indexOf('不计入统计：') >= 0);
  const chipHidden = chips.find((c) => c.textContent.indexOf('已隐藏账单：') >= 0);
  ok(!!chipExcluded, '有不计入统计的切换按钮，文案写明当前状态：' + (chipExcluded ? chipExcluded.textContent : '-'));
  ok(!!chipHidden, '有已隐藏账单的切换按钮：' + (chipHidden ? chipHidden.textContent : '-'));
  ok(!!chipExcluded && chipExcluded.textContent.indexOf('不计入统计：显示') === 0,
    '默认是「显示」不计入统计的账单，按钮如实写出「显示」');
  ok(!!chipHidden && chipHidden.textContent.indexOf('已隐藏账单：不显示') === 0,
    '默认「不显示」已隐藏账单，按钮如实写出「不显示」');
  ok(!chips.some((c) => c.textContent === '隐藏不计入统计'), '不再有容易被误解的「隐藏不计入统计」文案');
  ok(!chips.some((c) => c.textContent === '显示已隐藏账单'), '不再有容易被误解的「显示已隐藏账单」文案');

  if (chipExcluded) {
    chipExcluded.click();
    await wait(400);
    chips = $$('#view-list .chip');
    const after = chips.find((c) => c.textContent.indexOf('不计入统计：') >= 0);
    ok(!!after && after.textContent.indexOf('不显示') >= 0,
      '点一下后文案跟着变成「不显示」：' + (after ? after.textContent : '-'));
    after.click();
    await wait(400);
    chips = $$('#view-list .chip');
    const back = chips.find((c) => c.textContent.indexOf('不计入统计：') >= 0);
    ok(!!back && back.textContent.indexOf('显示') >= 0 && back.textContent.indexOf('不显示') < 0,
      '再点一下恢复成「显示」：' + (back ? back.textContent : '-'));
  }

  /* ---------- 34. 同步面板：状态卡与实时进度 ---------- */
  UI.openSyncSheet();
  await wait(600);
  ok(!!$('#sheetRoot .sync-status'), '同步面板有状态卡');
  ok($('#sheetRoot').textContent.indexOf('本机名称') >= 0, '面板显示本机名称');
  ok($('#sheetRoot').textContent.indexOf('同步规则') >= 0, '面板说明同步规则');
  ok(!$('#sheetRoot .sync-progress'), '空闲时没有进度条');

  Sync.setProgress(20, '正在上传到电脑…', '本机 5 条');
  await wait(300);
  ok(!!$('#sheetRoot .sync-progress'), '同步中会出现进度条');
  ok($('#sheetRoot').textContent.indexOf('20%') >= 0, '进度条显示百分比 20%');
  ok($('#sheetRoot').textContent.indexOf('正在上传到电脑') >= 0, '进度条显示当前步骤');

  Sync.setProgress(60, '电脑正在合并数据…', '');
  await wait(300);
  ok($('#sheetRoot').textContent.indexOf('60%') >= 0, '百分比会实时更新到 60%');
  ok($('#sheetRoot').textContent.indexOf('电脑正在合并数据') >= 0, '步骤文字实时更新');

  Sync.setProgress(100, '同步完成', '上传 2 项　下载 3 项　电脑上共 10 条');
  await wait(300);
  ok($('#sheetRoot').textContent.indexOf('100%') >= 0, '完成后显示 100%');
  ok($('#sheetRoot').textContent.indexOf('上传 2 项') >= 0, '完成后显示结果明细');
  Sync.clearProgress();
  await wait(250);
  UI.closeSheet();
  await wait(420);

  /* ---------- 35. 安卓 App：记住口令后不再要求输入 ---------- */
  window.AndroidApp = { setSyncHost: function () { /* 记录用 */ } };
  const syncUrlBefore = Sync.config.url;
  const syncTokenBefore = Sync.config.token;

  Sync.config.url = '192.168.1.7:8788';
  Sync.config.token = '';
  ok(Sync.isApp() === true, '能识别安卓 App 环境');
  ok(Sync.needsPassword() === true, '还没拿到令牌时需要输口令');
  ok(Sync.isConnected() === false, '此时不算已连接');

  UI.openSyncSheet();
  await wait(600);
  ok($('#sheetRoot').textContent.indexOf('访问口令') >= 0, '未连接时显示口令输入框');
  UI.closeSheet();
  await wait(420);

  Sync.config.token = 'test-token-abc';
  ok(Sync.needsPassword() === false, '拿到令牌后不再需要输口令');
  ok(Sync.isConnected() === true, '此时视为已连接');

  UI.openSyncSheet();
  await wait(600);
  ok($('#sheetRoot').textContent.indexOf('已连接电脑') >= 0, '面板显示「已连接电脑」');
  ok($('#sheetRoot').textContent.indexOf('访问口令') < 0, '已连接时默认不再显示口令输入框');
  ok($('#sheetRoot').textContent.indexOf('重新连接') >= 0, '提供「重新连接 / 更换口令」入口');
  ok($('#sheetRoot .sheet-actions') && $('#sheetRoot .sheet-actions').textContent.indexOf('立即同步') >= 0,
    '有「立即同步」按钮');
  UI.closeSheet();
  await wait(420);

  Sync.config.url = syncUrlBefore;
  Sync.config.token = syncTokenBefore;
  delete window.AndroidApp;

  /* ---------- 36. 同步失败时按钮不会卡住 ---------- */
  window.AndroidApp = { setSyncHost: function () {} };
  const syncUrlBefore2 = Sync.config.url;
  const syncTokenBefore2 = Sync.config.token;
  Sync.config.url = '10.255.255.1:9';   // 一个连不上的地址
  Sync.config.token = 'x';

  Sync._busy = true;
  Sync._busyAt = Date.now() - 120000;    // 假装上一次同步卡了很久
  UI.go('settings');
  await wait(400);
  const syncBtn = $$('#view-settings button').find((b) => b.textContent === '立即同步');
  ok(!!syncBtn, '设置页有「立即同步」按钮');
  if (syncBtn) {
    syncBtn.click();
    await wait(1500);
    const after = $$('#view-settings button').find((b) => b.textContent.indexOf('同步') >= 0);
    ok(!!after && after.textContent === '立即同步',
      '过期的同步锁会被自动释放，按钮不会卡在「同步中」：' + (after ? after.textContent : '-'));
    ok(after && after.disabled === false, '按钮恢复为可点击状态');
  }
  Sync._busy = false;
  Sync.config.url = syncUrlBefore2;
  Sync.config.token = syncTokenBefore2;
  delete window.AndroidApp;
  await wait(300);

  /* ---------- 37. 备份记录的按钮是「调用」 ---------- */
  await Backup.run(true);
  UI.go('settings');
  await wait(400);
  UI.openBackupSheet();
  await wait(800);
  const bkBtns = $$('#sheetRoot .cat-row button').map((b) => b.textContent);
  ok(bkBtns.indexOf('调用') >= 0, '备份记录里的按钮文字是「调用」：' + JSON.stringify(bkBtns));
  ok(bkBtns.indexOf('还原') < 0, '不再有「还原」按钮');
  UI.closeSheet();
  await wait(420);
  await Backup.clearAll();

  /* ---------- 38. 外观主题：跟随系统 / 浅色 / 深色 ---------- */
  UI.go('settings');
  await wait(400);
  const pickTheme = (name) => {
    const b = $$('#view-settings .seg button').find((x) => x.textContent === name);
    if (b) b.click();
    return !!b;
  };
  const themeNames = ['跟随系统', '浅色', '深色'];
  const themeBtns = $$('#view-settings .seg button').filter((b) => themeNames.indexOf(b.textContent) >= 0);
  eq(themeBtns.length, 3, '设置页有「跟随系统 / 浅色 / 深色」三个选项，不再只是一个开关');
  ok(pickTheme('深色'), '点得到「深色」');
  await wait(350);
  eq(Store.settings.theme, 'dark', '选「深色」后设置里存的是 dark');
  eq(document.documentElement.getAttribute('data-theme'), 'dark', '页面确实变成深色');
  ok(pickTheme('浅色'), '点得到「浅色」');
  await wait(350);
  eq(document.documentElement.getAttribute('data-theme'), 'light', '选「浅色」后页面变浅色');
  ok(pickTheme('跟随系统'), '点得到「跟随系统」');
  await wait(350);
  eq(Store.settings.theme, 'auto', '选「跟随系统」后设置里存的是 auto');
  const sysDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  eq(document.documentElement.getAttribute('data-theme'), sysDark ? 'dark' : 'light', '跟随系统时页面深浅与系统一致');
  ok($('#view-settings').textContent.indexOf('跟随系统') >= 0, '界面上能看到「跟随系统」的说法');

  /* ---------- 39. 记账时能联想以前填过的来源 ---------- */
  UI.go('list');
  await wait(300);
  $('#btnAdd').click();
  await wait(450);
  const srcField = $$('#sheetRoot .field').find((f) => f.textContent.indexOf('来源') >= 0);
  ok(!!srcField, '「记一笔」的表单里有「来源」一栏');
  const acInput = srcField.querySelector('.ac-wrap input.input') || srcField.querySelector('input.input');
  ok(!!acInput, '来源是一个会联想的输入框');
  acInput.value = '校园';
  acInput.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(300);
  const acItems = $$('#sheetRoot .ac-list .ac-item');
  ok(acItems.length >= 1, '输入两个字就列出以前填过的来源（' + acItems.length + ' 条）');
  ok(acItems[0].textContent.indexOf('校园食堂') >= 0, '列出来的正是以前填过的「校园食堂」');
  ok(acItems[0].textContent.indexOf('次') >= 0, '顺带标出以前用过几次');
  const beforePick = acInput.value;
  if (acItems.length) acItems[0].click();
  await wait(220);
  eq(beforePick, '校园', '输入过程中输入框不会被自动改掉');
  eq(acInput.value, '校园食堂', '点一下候选，就把历史记录填进输入框（自动填充）');
  ok($$('#sheetRoot .ac-list .ac-item').length === 0 || $('#sheetRoot .ac-list').style.display === 'none', '选完以后候选列表自动收起');
  UI.closeSheet();
  await wait(450);

  /* ---------- 40. 内置 AI 助手（建议 → 确认 → 执行） ---------- */
  UI.go('settings');
  await wait(400);
  ok($('#view-settings').textContent.indexOf('内置 AI 助手') >= 0, '设置页有「内置 AI 助手」入口');
  const oldAIConfig = JSON.parse(JSON.stringify(AI.config));
  AI.config.endpoint = 'https://api.deepseek.com';
  AI.config.apiKey = 'sk-test-only';
  AI.config.model = 'deepseek-chat';
  AI.save();
  const realAsk = AI.ask;
  const askedTexts = [];
  let aiExecuted = 0;
  AI.ask = async function (text) {
    askedTexts.push(text);
    return AI.parseIntent(JSON.stringify({
      reply: '好的，我把校园食堂的账目都归到餐饮',
      actions: [{ type: 'setCategory', category: '餐饮', filter: { counterparty: '校园食堂' } }]
    }));
  };
  UI.openAiSheet();
  await wait(500);
  ok($('#sheetRoot').textContent.indexOf('AI') >= 0, 'AI 助手面板可以打开');
  const aiInput = $('#sheetRoot .ai-input-row input');
  ok(!!aiInput, '面板里有可以直接说话的输入框');
  aiInput.value = '把校园食堂的账目都改成餐饮';
  aiInput.dispatchEvent(new Event('input', { bubbles: true }));
  const sendBtn = $$('#sheetRoot .ai-input-row button')[0];
  ok(!!sendBtn, '有「问 AI」按钮');
  sendBtn.click();
  const tAI = Date.now();
  while (!$$('#sheetRoot .ai-pending').length && Date.now() - tAI < 4000) await wait(80);
  eq(askedTexts.length, 1, '说的话确实交给了 AI');
  ok($('#sheetRoot').textContent.indexOf('待确认的改动') >= 0, 'AI 的建议先列成「待确认的改动」，不会直接改数据');
  const pend = $$('#sheetRoot .ai-pending')[0];
  ok(!!pend, '有一条待确认的建议卡片');
  ok(pend.textContent.indexOf('会影响') >= 0, '卡片上写清楚会影响几条账目');
  ok(pend.textContent.indexOf('餐饮') >= 0, '卡片上写清楚要改成哪个分类');
  const partyTx = Store.tx.filter((t) => t.counterparty === '校园食堂');
  ok(partyTx.length >= 1, '执行前有 ' + partyTx.length + ' 条「校园食堂」的账目');
  const beforeCat = partyTx[0].categoryName;
  ok(beforeCat !== '数码', '执行前分类不是「数码」（当前是 ' + beforeCat + '）');
  const execBtn = pend.querySelector('button');
  ok(!!execBtn, '建议卡片上有「执行这一项」按钮');
  if (execBtn) { execBtn.click(); aiExecuted++; }
  await wait(800);
  const afterTx = Store.tx.filter((t) => t.counterparty === '校园食堂');
  ok(afterTx.every((t) => t.categoryName === '餐饮'), '执行后这些账目的分类确实变成了「餐饮」');
  eq(aiExecuted, 1, '是用户点了确认才执行的');
  ok($('#sheetRoot .ai-pending').length === 0 || $('#sheetRoot').textContent.indexOf('已执行') >= 0, '执行过的建议不会再被重复执行');
  AI.ask = realAsk;
  UI.closeSheet();
  await wait(450);
  AI.config = oldAIConfig;
  AI.save();
  await wait(200);

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