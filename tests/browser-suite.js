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
  const segKids = (s) => Array.prototype.slice.call(s.children);
  const findSeg = (label) => modeSegs.find((s) => segKids(s).some((b) => b.textContent === label));
  ok(modeSegs.length >= 3, '有单选控件（重复处理 / 不计收支 / 退款）：' + modeSegs.length + ' 组');

  const segDup = findSeg('保留导入的数据');
  ok(!!segDup, '导入面板有「重复的账单怎么处理」这一组');
  if (segDup) {
    const active0 = segKids(segDup).find((b) => b.classList.contains('is-active'));
    ok(!!active0 && active0.textContent === '保留导入的数据',
      '默认选中「保留导入的数据」：' + (active0 ? active0.textContent : '-'));
    eq(UI.state.importOpts.dupMode, 'overwrite', '默认 dupMode=overwrite');
    const btnSkip = segKids(segDup).find((b) => b.textContent === '跳过，保留原来的');
    ok(!!btnSkip, '可以切成「跳过，保留原来的」');
    if (btnSkip) {
      btnSkip.click();
      await wait(180);
      eq(UI.state.importOpts.dupMode, 'skip', '切换后写入 dupMode=skip');
      const btnOw = segKids(segDup).find((b) => b.textContent === '保留导入的数据');
      if (btnOw) { btnOw.click(); await wait(150); }
      eq(UI.state.importOpts.dupMode, 'overwrite', '再切回「保留导入的数据」');
    }
  }

  const segIgnore = findSeg('不计入合计');
  ok(!!segIgnore, '找到「不计收支」那一组');
  if (segIgnore) {
    const kids = segKids(segIgnore);
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
      const btnBack = segKids(segIgnore).find((b) => b.textContent === '计入合计');
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

  /* ---------- 41. 键盘弹起时输入框不会被盖住 ---------- */
  UI.go('list');
  await wait(250);
  UI.openTxSheet(null);
  await wait(500);
  const kbSheet = $('#sheetRoot .sheet');
  const kbBefore = kbSheet.getBoundingClientRect().bottom;
  const firstInput = $$('#sheetRoot .field .input')[0];
  ok(!!firstInput, '记账表单里有可以打字的输入框');
  firstInput.focus();
  await wait(120);
  UI.onNativeIme(320);          // 模拟键盘弹起 320px
  await wait(300);
  eq(getComputedStyle(document.documentElement).getPropertyValue('--kb').trim(), '320px', '键盘高度写进了 --kb');
  const kbAfter = kbSheet.getBoundingClientRect().bottom;
  ok(kbAfter <= window.innerHeight - 300,
    '整个记账面板被抬到键盘上方（底边 ' + Math.round(kbAfter) + ' ≤ ' + (window.innerHeight - 300) + '）');
  ok(kbAfter < kbBefore, '面板确实往上移了');

  /* 最下面那个输入框（备注）打字时也必须看得见 */
  const lastInput = $$('#sheetRoot .field .input').slice(-1)[0];
  lastInput.focus();
  await wait(200);
  UI.nudgeActiveInput();
  await wait(760);   // 合并 + 平滑滚动，要等它滚完
  const liRect = lastInput.getBoundingClientRect();
  const shRect = kbSheet.getBoundingClientRect();
  ok(liRect.bottom <= shRect.bottom + 2,
    '最后一个输入框被滚进可视区（底边 ' + Math.round(liRect.bottom) + ' ≤ ' + Math.round(shRect.bottom) + '）');
  ok(liRect.top >= shRect.top - 2, '也没有被顶出面板上沿');

  /* 历史联想列表也要一起露出来 */
  const srcIn = $$('#sheetRoot .ac-wrap input.input')[0];
  ok(!!srcIn, '来源是一个带联想的输入框');
  srcIn.focus();
  srcIn.value = '校园';
  srcIn.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(820);   // 同上：等平滑滚动结束
  const acList = $('#sheetRoot .ac-list');
  ok(acList && acList.offsetHeight > 0, '联想候选列表弹了出来');
  const acRect = acList.getBoundingClientRect();
  const shRect2 = kbSheet.getBoundingClientRect();
  ok(acRect.bottom <= shRect2.bottom + 2,
    '候选列表也在键盘上方看得到（底边 ' + Math.round(acRect.bottom) + ' ≤ ' + Math.round(shRect2.bottom) + '）');

  UI.onNativeIme(0);
  await wait(250);
  eq(getComputedStyle(document.documentElement).getPropertyValue('--kb').trim(), '0px', '键盘收起后高度归零，面板回到原位');
  UI.closeSheet();
  await wait(450);

  /* ---------- 42. 分钟精确到 1 分钟，且选完不跳回顶部 ---------- */
  UI.openTxSheet(null);
  await wait(500);
  const dateField2 = $('#sheetRoot .date-field');
  dateField2.click();
  await wait(500);
  const minCells = $$('#pickerRoot .dp-time-grid.min .dp-tcell');
  eq(minCells.length, 60, '分钟从 0 到 59 都能选，精确到 1 分钟');
  const m07 = minCells.filter((b) => b.textContent === '07')[0];
  ok(!!m07, '能找到「07」这个分钟');

  const pkSheet = $('#pickerRoot .sheet');
  const maxScroll = pkSheet.scrollHeight - pkSheet.clientHeight;
  ok(maxScroll > 40, '时间面板可以滚动（可滚 ' + maxScroll + 'px）');
  const target = Math.min(220, Math.max(0, maxScroll - 10));
  pkSheet.scrollTop = target;
  await wait(150);
  const keptBefore = pkSheet.scrollTop;
  ok(keptBefore > 0, '先把面板往下滚一点（' + keptBefore + '）');

  m07.click();
  await wait(320);
  ok($('#pickerRoot .dp-preview').textContent.indexOf(':07') >= 0,
    '选中的时间精确到分钟：' + $('#pickerRoot .dp-preview').textContent.trim().slice(-14));
  eq($('#pickerRoot .sheet').scrollTop, keptBefore, '点完分钟后面板停在原地，没有跳回最上面');
  $$('#pickerRoot .sheet-actions .btn')[1].click();   // 取消
  await wait(400);
  UI.closeSheet();
  await wait(420);

  /* ---------- 43. AI 真的能读到账目数据（走完整请求链路） ---------- */
  const digestNow = AI.buildDigest();
  ok(digestNow.indexOf('各周期合计') >= 0, '喂给 AI 的数据里带各周期合计');
  ok(digestNow.indexOf('账目明细') >= 0 && /\d+\.\d\d/.test(digestNow), '喂给 AI 的数据里有带金额的逐笔明细');
  ok(digestNow.indexOf('最近的一笔') >= 0, '明确告诉 AI 哪一笔是最近的');

  const newestTx = Store.tx.slice().sort((a, b) => (b.time - a.time) || (b.createdAt - a.createdAt))[0];
  const latestHit = AI.match({ latest: 1 });
  eq(latestHit.length, 1, '「最近的一笔」能精确定位');
  eq(latestHit[0].id, newestTx.id, '定位到的就是时间最近的那一笔');
  const sumCheck = AI.computeSum({});
  const expCheck = Stats.summarize(Store.tx.filter((t) => !t.excludeStat));
  eq(sumCheck.expense, expCheck.expense, '应用自己算的支出合计和统计模块完全一致');
  ok(sumCheck.text.indexOf('结余') >= 0, '结果里写清了结余：' + sumCheck.text);

  /* 用假的「系统请求」把 AI 整条链路跑通（含「算数 → 再交回模型总结」） */
  const toB64 = (s) => btoa(unescape(encodeURIComponent(s)));
  let httpCalls = 0;
  const fakeReplies = [
    JSON.stringify({ reply: '我来算一下最近 7 天的合计', actions: [{ type: 'sum', filter: { from: U.toISODate(U.addDays(new Date(), -6)), to: U.toISODate(new Date()) } }] }),
    JSON.stringify({ reply: '最近 7 天的合计见上面的结果', actions: [] })
  ];
  window.AndroidApp = {
    httpPost: function (id, url, headersJson, bodyJson) {
      httpCalls++;
      const content = fakeReplies[Math.min(httpCalls - 1, fakeReplies.length - 1)];
      setTimeout(function () {
        const cb = window.__aiCallbacks && window.__aiCallbacks[id];
        if (cb) cb(200, toB64(JSON.stringify({ choices: [{ message: { content: content } }] })));
      }, 10);
    }
  };

  const aiCfgBak = JSON.parse(JSON.stringify(AI.config));
  AI.config.endpoint = 'https://api.deepseek.com';
  AI.config.apiKey = 'sk-test-key';
  AI.config.model = 'deepseek-chat';
  AI.save();

  /* ---------- 44. 对话里直接显示算好的结果 ---------- */
  UI.go('settings');
  await wait(300);
  UI.openAiSheet();
  await wait(500);
  const aiInput2 = $('#sheetRoot .ai-input-row input');
  ok(!!aiInput2, 'AI 面板里有输入框');
  aiInput2.value = '最近 7 天花了多少';
  aiInput2.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(80);
  $$('#sheetRoot .ai-input-row button')[0].click();
  const tAI2 = Date.now();
  while (!$$('#sheetRoot .ai-msg.calc').length && Date.now() - tAI2 < 8000) await wait(100);
  eq($$('#sheetRoot .ai-msg.calc').length, 1, '算出来的结果直接出现在对话里（不用模型心算）');
  const calcText = $('#sheetRoot .ai-msg.calc').textContent;
  ok(calcText.indexOf('支出') >= 0 && calcText.indexOf('收入') >= 0, '结果里收入、支出都有：' + calcText);
  eq(httpCalls, 2, 'AI 要求算数时，应用把结果再交回模型总结（一共两次请求）');
  ok($('#sheetRoot .ai-log').textContent.indexOf('最近 7 天花了多少') >= 0, '自己说的话也显示在对话里');
  ok($('#sheetRoot .ai-log').textContent.indexOf('最近 7 天') >= 0, '最后用模型总结的话回答用户');
  UI.closeSheet();
  await wait(450);
  delete window.AndroidApp;
  AI.config = aiCfgBak;
  AI.save();
  await wait(200);

  /* ---------- 45. 报销：钱从账目里已有的收入抵消（不再手输金额） ---------- */
  const catId45 = (Store.categories.find((c) => c.name === '餐饮') || Store.categories[0]).id;
  const incCat45 = Store.categories.find((c) => c.type === 'income') || Store.categories[0];
  const exp45 = await Store.addTx({ type: 'expense', amount: 38, time: Date.now() - 5000, categoryId: catId45, categoryName: '餐饮', account: '微信', counterparty: '报销测试商家', item: '测试报销', source: 'manual' });
  const got45 = await Store.addTx({ type: 'income', amount: 20, time: Date.now() - 4000, categoryId: incCat45.id, categoryName: incCat45.name, account: '微信', counterparty: '爸爸', item: '转账', source: 'manual' });
  UI.go('list');
  await wait(320);
  UI.openTxDetail(Store.getTx(exp45.id));
  await wait(450);
  ok($('#sheetRoot').textContent.indexOf('报销/排除') >= 0, '支出详情里有「报销/排除」入口');
  UI.closeSheet();
  await wait(430);

  UI.openSettleSheet(Store.getTx(exp45.id));
  await wait(540);
  const sheet45 = $('#sheetRoot').textContent;
  ok(sheet45.indexOf('这笔钱是哪几笔收入进来的') >= 0, '面板里有「这笔钱是哪几笔收入进来的」');
  ok(sheet45.indexOf('爸爸') >= 0, '列出了账上已有的那笔收入');
  ok(sheet45.indexOf('报销到账金额') < 0, '不再让用户手输金额');
  const incomeList45 = $$('#sheetRoot .pick-list')[0];
  ok(!!incomeList45 && incomeList45.querySelectorAll('input:checked').length === 1, '默认勾上最近到账的那笔收入');
  ok(sheet45.indexOf('仍然算你自己的支出') >= 0, '实时说明：没抵消到的还算你的支出');
  $$('#sheetRoot .sheet-actions .btn')[0].click();
  await wait(780);
  const after45 = Store.getTx(exp45.id);
  eq(after45.excludeAmount, 20, '抵扣掉 20');
  eq(Stats.counted(after45), 18, '这笔支出只计入自己承担的 18');
  eq(Stats.counted(Store.getTx(got45.id)), 0, '这笔收入里垫付返还的部分不算收入');
  eq(Store.reimburseInfo(after45).incomeCount, 1, '配对信息里记着用了 1 笔收入');
  UI.go('list');
  await wait(430);
  ok($('#view-list').textContent.indexOf('自付') >= 0, '明细里写明「已报销 …，自付 18.00」');

  /* 又收到一笔钱：再配一次，之前抵掉的不会被冲掉 */
  const got45b = await Store.addTx({ type: 'income', amount: 18, time: Date.now() + 1000, categoryId: incCat45.id, categoryName: incCat45.name, account: '微信', counterparty: '爸爸', item: '又给了一些', source: 'manual' });
  UI.openSettleSheet(Store.getTx(exp45.id));
  await wait(540);
  ok($('#sheetRoot').textContent.indexOf('又给了一些') >= 0, '新到的那笔收入可以勾选');
  $$('#sheetRoot .sheet-actions .btn')[0].click();
  await wait(780);
  eq(Stats.counted(Store.getTx(exp45.id)), 0, '两笔加起来把 38 抵完了');
  eq(Stats.counted(Store.getTx(got45b.id)), 0, '第二笔收入也不算收入');
  eq(Store.tx.filter((t) => t.reimburseGroupId === Store.getTx(exp45.id).reimburseGroupId).length, 3, '一组 3 条：1 笔垫付 + 2 笔收入');

  /* 取消配对：收入记录要留着 */
  await Store.cancelReimburse(exp45.id);
  await wait(200);
  eq(!!Store.getTx(got45.id), true, '取消后原来的收入记录还在（不再被删掉）');
  eq(Stats.counted(Store.getTx(got45.id)), 20, '取消后这笔收入恢复成收入');
  eq(Stats.counted(Store.getTx(exp45.id)), 38, '取消后垫付全额恢复计入');
  await Store.removeManyTx([exp45.id, got45.id, got45b.id]);
  await wait(200);

  /* ---------- 46. 代付的钱后来收回来了 ---------- */
  const exp46 = await Store.addTx({ type: 'expense', amount: 45, time: Date.now() - 3000, categoryId: catId45, categoryName: '餐饮', account: '微信', counterparty: '代付测试同学', item: '帮买书', source: 'manual' });
  await Store.updateTx(exp46.id, { excludeStat: true, excludeReason: '代付' });
  const got46 = await Store.addTx({ type: 'income', amount: 45, time: Date.now() + 2000, categoryId: incCat45.id, categoryName: incCat45.name, account: '微信', counterparty: '同学', item: '还钱', source: 'manual' });
  UI.go('list');
  await wait(320);
  UI.openTxDetail(Store.getTx(exp46.id));
  await wait(450);
  const backBtn46 = $$('#sheetRoot .sheet-actions .btn').filter((b) => b.textContent === '收回来了')[0];
  ok(!!backBtn46, '代付的详情里有「收回来了」按钮');
  if (backBtn46) backBtn46.click();
  await wait(780);
  ok($('#sheetRoot').textContent.indexOf('收回垫付的钱') >= 0, '打开的是「收回垫付的钱」面板');
  ok($('#sheetRoot').textContent.indexOf('还钱') >= 0, '列出那笔收入的来源');
  $$('#sheetRoot .sheet-actions .btn')[0].click();
  await wait(780);
  eq(Store.getTx(exp46.id).excludeStat, true, '全部收回后这笔代付仍然不计入统计');
  eq(Stats.counted(Store.getTx(got46.id)), 0, '收回来的钱不算收入');
  UI.go('list');
  await wait(420);
  ok($('#view-list').textContent.indexOf('已收回') >= 0, '明细里显示「已收回」');
  await Store.removeManyTx([exp46.id, got46.id]);
  await wait(200);

  /* ---------- 47. 一次转账抵消多笔垫付（钱来自账上已有的收入） ---------- */
  for (const pt of Store.pendingReimburse()) { await Store.cancelReimburse(pt.id); }
  await wait(300);
  const now47 = Date.now();
  const m1 = await Store.addTx({ type: 'expense', amount: 38, time: now47 - 6000, categoryId: catId45, categoryName: '餐饮', account: '微信', counterparty: '垫付甲商家', item: '垫付', source: 'manual' });
  const m2 = await Store.addTx({ type: 'expense', amount: 60, time: now47 - 5000, categoryId: catId45, categoryName: '餐饮', account: '微信', counterparty: '垫付乙商家', item: '垫付', source: 'manual' });
  await Store.markReimburse(m1.id, '报销');
  await Store.markReimburse(m2.id, '报销');
  const inc47 = await Store.addTx({ type: 'income', amount: 150, time: Date.now(), categoryId: incCat45.id, categoryName: incCat45.name, account: '微信', counterparty: '妈妈', item: '一次转给我', source: 'manual' });
  UI.go('list');
  await wait(350);
  UI.openSettleSheet(Store.getTx(m1.id));
  await wait(560);
  const lists47 = $$('#sheetRoot .pick-list');
  eq(lists47.length, 2, '面板里有两张清单：上面的收入、下面的垫付');
  ok(lists47[0].textContent.indexOf('妈妈') >= 0, '上面列出了那笔收入');
  eq(lists47[0].querySelectorAll('input:checked').length, 1, '收入默认勾上最近到账的那一笔');
  const adv47 = Array.prototype.slice.call(lists47[1].querySelectorAll('input'));
  eq(adv47.filter((b) => b.checked).length, 2, '两笔待报销的垫付默认都勾上了');
  const txt47 = $('#sheetRoot').textContent;
  ok(txt47.indexOf('收到 ¥150.00') >= 0, '自动算出收到 150（不用手输）');
  ok(txt47.indexOf('多出来的') >= 0 && txt47.indexOf('仍算收入') >= 0, '并说明多出来的是收入');
  $$('#sheetRoot .sheet-actions .btn')[0].click();
  await wait(880);
  eq(Store.getTx(m1.id).excludeStat, true, '垫付甲被抵消，不计入统计');
  eq(Store.getTx(m2.id).excludeStat, true, '垫付乙被抵消，不计入统计');
  eq(Stats.counted(Store.getTx(inc47.id)), 52, '这笔收入里只有多出来的 52 元算收入（150 - 98）');
  eq(Store.tx.filter((t) => t.reimburseGroupId === Store.getTx(m1.id).reimburseGroupId).length, 3, '一组 3 条：2 笔垫付 + 1 笔收入');
  UI.go('list');
  await wait(420);
  ok($('#view-list').textContent.indexOf('垫付甲商家') >= 0, '被抵消的垫付仍然留在明细里');
  await Store.removeManyTx([m1.id, m2.id, inc47.id]);
  await wait(250);

  /* ---------- 48. 概览有支出走势折线图 ---------- */
  UI.go('home');
  await wait(500);
  const chart48 = $('#view-home .line-chart');
  ok(!!chart48, '概览里有折线图');
  ok($('#view-home').textContent.indexOf('支出走势') >= 0, '卡片标题是「支出走势」');
  ok(chart48.querySelectorAll('path.lc-line').length >= 1, '折线画出来了');
  ok(chart48.querySelectorAll('.lc-x').length >= 2, '横轴有日期刻度');
  ok(chart48.querySelectorAll('.lc-grid').length >= 2, '有横向参考线');
  ok(!!$('#view-home .chart-legend'), '图下面有图例');
  var homePeriods = ['week', 'month', 'all'];
  var chartOk = true;
  for (var hp = 0; hp < homePeriods.length; hp++) {
    UI.state.homePeriod = homePeriods[hp];
    UI.renderHome();
    await wait(220);
    if (!$('#view-home .line-chart')) { chartOk = false; break; }
  }
  ok(chartOk, '切到本周 / 本月 / 全部，折线图都在');
  UI.state.homePeriod = 'month';
  UI.renderHome();
  await wait(250);

  /* ---------- 49. 记一笔里可以调整分类顺序 ---------- */
  UI.go('list');
  await wait(280);
  UI.openTxSheet(null);
  await wait(520);
  const catNames = () => $$('#sheetRoot .cat-pick').map((b) => { const n = b.querySelector('.cn'); return n ? n.textContent : ''; });
  const namesBefore = catNames();
  ok(namesBefore.length >= 3, '分类格子渲染出来了（' + namesBefore.length + ' 个）');
  const sortBtn49 = $$('#sheetRoot button').filter((b) => b.textContent === '调整顺序')[0];
  ok(!!sortBtn49, '分类旁边有「调整顺序」按钮');
  if (sortBtn49) sortBtn49.click();
  await wait(320);
  ok($$('#sheetRoot .cat-pick.is-sorting').length >= 3, '进入排序模式');
  ok($$('#sheetRoot .cs-btn').length >= 4, '每格上有 ◀ ▶ 两个小按钮');
  const arrows = $$('#sheetRoot .cat-pick.is-sorting .cs-btn');
  eq(arrows[0].disabled, true, '第一格的「◀」是灰的（已经在最前面）');
  arrows[1].click();
  await wait(520);
  const namesAfter = catNames();
  eq(namesAfter[0], namesBefore[1], '第一个分类挪到了第二位');
  eq(namesAfter[1], namesBefore[0], '第二个分类挪到了第一位');
  const stored = Store.categoriesFor('expense', false).slice(0, 2).map((c) => c.name);
  eq(stored[0], namesAfter[0], '新顺序已经存下来了');
  eq(stored[1], namesAfter[1], '第二名的顺序也存下来了');
  /* 挪回去：点第二格的「◀」（第一格的 ◀ 本来就是灰的） */
  $$('#sheetRoot .cat-pick.is-sorting .cs-btn')[2].click();
  await wait(560);
  eq(catNames()[0], namesBefore[0], '再挪回来，顺序恢复');
  const doneBtn = $$('#sheetRoot button').filter((b) => b.textContent === '完成')[0];
  ok(!!doneBtn, '按钮变成「完成」');
  if (doneBtn) doneBtn.click();
  await wait(300);
  eq($$('#sheetRoot .cs-btn').length, 0, '点「完成」退出排序模式');
  UI.closeSheet();
  await wait(450);

  /* ---------- 50. 导入遇到重复：保留导入的数据 ---------- */
  UI.go('list');
  await wait(300);
  const cat50 = (Store.categories.find((c) => c.name === '餐饮') || Store.categories[0]).id;
  const man50 = await Store.addTx({
    type: 'expense', amount: 26.8, time: U.fromISO('2026-03-20 12:00').getTime(),
    categoryId: cat50, categoryName: '餐饮', account: '现金',
    counterparty: '我自己记的商家', item: '自己写的用途', note: '我的备注', source: 'manual'
  });
  const csv50 = '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注\n' +
    '2026-03-20 18:22:00,商户消费,便利店,零食,支出,¥26.80,零钱,支付成功,XL8888,M888,/';
  const parsed50 = Importer.parse(csv50, { autoClassify: true, dedupe: true, ignoreMode: 'count', refundMode: 'count' });
  const item50 = parsed50.items[0];
  ok(!!item50 && (item50.dup || item50.suspect), '认出了和手动记录重复的那一条');
  ok(item50.dupOf === man50.id, '并且认出重复的是你手动记的那一笔');
  const txBefore50 = Store.tx.length;
  item50.selected = true;
  const n50 = await Importer.commit([item50], { dupMode: 'overwrite' });
  eq(n50, 1, '更新了一条');
  eq(Store.tx.length, txBefore50, '库里没有多出新的记录');
  const upd50 = Store.getTx(man50.id);
  eq(upd50.counterparty, '便利店', '商家换成了文件里准确的');
  eq(upd50.externalId, 'XL8888', '交易单号补上了');
  eq(upd50.note, '我的备注', '你自己写的备注保留');
  eq(upd50.account, '现金', '你自己选的账户保留');
  /* 再导一次同一份文件：这次是「交易单号已存在」，依然认得出 */
  const again50 = Importer.parse(csv50, { autoClassify: true, dedupe: true, ignoreMode: 'count', refundMode: 'count' }).items[0];
  eq(again50.dup, true, '同一份账单再导入时认出「交易单号已存在」');
  eq(again50.dupOf, man50.id, '认出的还是同一笔');

  /* ---------- 51. AI 助手入口要显眼 ---------- */
  ok(!!$('#btnAI'), '顶栏有一个常驻的 AI 按钮（不用进设置里找）');
  ok($('#btnAI').textContent.indexOf('AI') >= 0, '按钮上写着 AI：' + $('#btnAI').textContent.trim());
  UI.go('home');
  await wait(380);
  ok(!!$('#view-home .ai-entry'), '概览页顶部也有一个 AI 助手入口');
  ok($('#view-home .ai-entry').textContent.indexOf('AI 助手') >= 0, '入口上写着「问问 AI 助手」');
  $('#btnAI').click();
  await wait(520);
  ok($('#sheetRoot').textContent.indexOf('内置 AI 助手') >= 0, '点顶栏按钮就能直接打开 AI 助手');
  UI.closeSheet();
  await wait(460);

  /* ---------- 52. 假期不计入统计 ---------- */
  const vacBefore52 = Store.vacations().slice();
  await Store.updateSettings({ vacationExclude: true });
  const vac52 = await Store.addVacation({ name: '测试假期', start: '2026-05-01', end: '2026-05-07' });
  const catV52 = (Store.categories.find((c) => c.name === '餐饮') || Store.categories[0]).id;
  const inVac52 = await Store.addTx({ type: 'expense', amount: 88, time: U.fromISO('2026-05-03 12:00').getTime(), categoryId: catV52, categoryName: '餐饮', account: '微信', counterparty: '假期消费测试', item: '景区门票', source: 'manual' });
  const outVac52 = await Store.addTx({ type: 'expense', amount: 66, time: U.fromISO('2026-06-03 12:00').getTime(), categoryId: catV52, categoryName: '餐饮', account: '微信', counterparty: '平时消费测试', item: '午饭', source: 'manual' });
  eq(Stats.counted(Store.getTx(inVac52.id)), 0, '假期里的那笔不计入统计');
  eq(Stats.counted(Store.getTx(outVac52.id)), 66, '不在假期里的照常计入');

  UI.go('settings');
  await wait(420);
  ok($('#view-settings').textContent.indexOf('假期设置') >= 0, '设置页有「假期设置」入口');
  const vacBtn52 = $$('#view-settings button').filter((b) => b.textContent.indexOf('假期设置') >= 0)[0];
  ok(!!vacBtn52, '找得到那个按钮');
  if (vacBtn52) vacBtn52.click();
  await wait(520);
  ok($('#sheetRoot').textContent.indexOf('假期期间不计入统计') >= 0, '假期面板里有总开关');
  ok($('#sheetRoot').textContent.indexOf('测试假期') >= 0, '列出了已经加好的假期');
  ok($('#sheetRoot').textContent.indexOf('2026-05-01') >= 0 && $('#sheetRoot').textContent.indexOf('2026-05-07') >= 0, '显示出起止日期');
  const editBtn52 = $$('#sheetRoot .cat-row button').filter((b) => b.textContent === '编辑')[0];
  ok(!!editBtn52, '每个假期都能编辑（提前回校就把结束日改早）');
  if (editBtn52) editBtn52.click();
  await wait(360);
  ok($('#sheetRoot').textContent.indexOf('保存修改') >= 0, '点「编辑」进入修改状态');
  ok($('#sheetRoot').textContent.indexOf('取消编辑') >= 0, '也能取消编辑');
  UI.closeSheet();
  await wait(460);

  UI.state.list = Object.assign(UI.state.list, { period: 'all', types: [], categoryIds: [], accounts: [], showHidden: true });
  UI.go('list');
  await wait(460);
  const listTxt52 = $('#view-list').textContent;
  ok(listTxt52.indexOf('假期消费测试') >= 0, '假期的账目仍然留在明细里');
  ok(listTxt52.indexOf('假期') >= 0, '明细里标出了「假期」');
  UI.state.list.period = 'month';

  await Store.updateSettings({ vacationExclude: false });
  eq(Stats.counted(Store.getTx(inVac52.id)), 88, '关掉开关后，假期里的钱又计入了统计');
  await Store.updateSettings({ vacationExclude: true });
  eq(Stats.counted(Store.getTx(inVac52.id)), 0, '再打开又恢复不计入');

  await Store.removeVacation(vac52.id);
  await Store.removeManyTx([inVac52.id, outVac52.id]);
  await Store.updateSettings({ vacations: vacBefore52 });
  eq(Store.vacations().length, vacBefore52.length, '收尾：假期列表恢复原样');

  /* ---------- 53. 节假日提醒与联网获取（测试版） ---------- */
  const holBak = { data: Store.settings.holidayData, prompts: Store.settings.holidayPrompts };
  const soonIso = U.toISODate(U.addDays(new Date(), 3));
  const soonEndIso = U.toISODate(U.addDays(new Date(), 6));
  const holKey = '国庆|' + soonIso;
  await Store.updateSettings({
    holidayData: { fetchedAt: Date.now(), source: '测试', list: [{ key: holKey, name: '国庆', start: soonIso, end: soonEndIso }] },
    holidayPrompts: {},
    vacationExclude: true
  });
  UI.go('home');
  await wait(520);
  ok(!!$('#view-home .holiday-card'), '概览上出现了节假日提醒');
  const hcTxt = $('#view-home .holiday-card').textContent;
  ok(hcTxt.indexOf('国庆') >= 0, '写着是哪个假期');
  ok(hcTxt.indexOf('测试版') >= 0, '标了「测试版」');
  ok(hcTxt.indexOf('还有') >= 0, '写着还剩几天');
  const hcRefuse = $$('#view-home .holiday-card button').filter((b) => b.textContent === '照常计入')[0];
  ok(!!hcRefuse, '有「照常计入」这个选择');
  if (hcRefuse) hcRefuse.click();
  await wait(560);
  ok(!$('#view-home .holiday-card'), '选过之后提醒就消失了（不会一直弹）');
  eq(Holiday.isHandled(holKey), true, '记下了已经处理过');

  /* 「设为假期」这条路 */
  await Store.updateSettings({ holidayPrompts: {} });
  UI.renderHome();
  await wait(420);
  const hcAccept = $$('#view-home .holiday-card button').filter((b) => b.textContent.indexOf('设为假期') >= 0)[0];
  ok(!!hcAccept, '有「设为假期（不计入统计）」按钮');
  if (hcAccept) hcAccept.click();
  await wait(680);
  ok(Store.vacations().some((v) => v.name === '国庆'), '一点就加进了假期列表');
  ok(!$('#view-home .holiday-card'), '提醒消失');

  /* 假期面板里的联网获取区 */
  UI.go('settings');
  await wait(420);
  ok($('#view-settings').textContent.indexOf('测试版') >= 0, '设置页也标了测试版');
  UI.openVacationSheet();
  await wait(560);
  ok($('#sheetRoot').textContent.indexOf('节假日数据') >= 0, '假期面板里有「节假日数据」一栏');
  ok($('#sheetRoot').textContent.indexOf('从网上获取') >= 0, '有联网获取按钮');
  const hSrc = $$('#sheetRoot input.input').filter((el) => String(el.value).indexOf('http') === 0)[0];
  ok(!!hSrc, '数据源地址可以自己改：' + (hSrc ? hSrc.value : '-'));
  ok($('#sheetRoot').textContent.indexOf('解析粘贴的数据') >= 0, '取不到时还能手动粘贴 JSON');
  const hPaste = $('#sheetRoot textarea');
  ok(!!hPaste, '有粘贴框');
  if (hPaste) {
    hPaste.value = JSON.stringify([{ name: '粘贴测试假', start: '2027-03-01', end: '2027-03-03' }]);
    const parseBtn = $$('#sheetRoot button').filter((b) => b.textContent === '解析粘贴的数据')[0];
    if (parseBtn) parseBtn.click();
    await wait(640);
    ok($('#sheetRoot').textContent.indexOf('粘贴测试假') >= 0, '解析出来后列在下面等着勾选');
    const addBtn = $$('#sheetRoot button').filter((b) => b.textContent.indexOf('把勾选的加进假期') >= 0)[0];
    ok(!!addBtn, '有「把勾选的加进假期」按钮');
    if (addBtn) addBtn.click();
    await wait(760);
    ok(Store.vacations().some((v) => v.name === '粘贴测试假'), '加进假期列表了');
  }
  UI.closeSheet();
  await wait(460);

  /* 收尾：把测试造的假期与数据都还原 */
  const vList53 = Store.vacations().slice();
  for (let i53 = 0; i53 < vList53.length; i53++) {
    const nm = vList53[i53].name;
    if (nm === '国庆' || nm === '粘贴测试假') await Store.removeVacation(vList53[i53].id);
  }
  await Store.updateSettings({ holidayData: holBak.data, holidayPrompts: holBak.prompts });
  eq(Store.vacations().filter((v) => v.name === '粘贴测试假').length, 0, '收尾：测试假期已清掉');
  UI.go('home');
  await wait(320);

  /* ---------- 54. 概览「去处理」直接定位到待报销那一行 ---------- */
  const catP54 = (Store.categories.find((c) => c.name === '餐饮') || Store.categories[0]).id;
  const pTx54 = await Store.addTx({ type: 'expense', amount: 33, time: Date.now(), categoryId: catP54, categoryName: '餐饮', account: '微信', counterparty: '待报销定位测试', item: '垫付', source: 'manual' });
  await Store.markReimburse(pTx54.id, '报销');
  UI.go('home');
  await wait(520);
  ok($('#view-home').textContent.indexOf('待报销') >= 0, '概览有「待报销」提醒卡片');
  const goBtn54 = $$('#view-home button').filter((b) => b.textContent === '去处理')[0];
  ok(!!goBtn54, '有「去处理」按钮');
  if (goBtn54) goBtn54.click();
  await wait(950);
  ok($('.tab[data-tab="list"]').classList.contains('is-active'), '点了会跳到明细页');
  ok($('#view-list').textContent.indexOf('只看待报销') >= 0, '并自动切到「只看待报销」');
  const rows54 = $$('#view-list .tx.is-pending');
  ok(rows54.length >= 1, '待报销的那一行就在列表里（' + rows54.length + ' 行）');
  ok($('#view-list').textContent.indexOf('待报销定位测试') >= 0, '而且是那一笔，不用自己翻');
  ok($$('#view-list .tx.is-flash').length >= 1, '这些行会闪一下，很显眼');
  UI.state.list.onlyPending = false;
  await Store.cancelReimburse(pTx54.id);
  await Store.removeManyTx([pTx54.id]);
  UI.go('home');
  await wait(320);

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