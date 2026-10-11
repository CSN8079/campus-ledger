/* ============================================================
   report.js - 报表导出
     1. 导出 Excel（.xlsx）：明细 + 分类汇总 + 周期汇总 + 每日收支
     2. 导出图片（PNG）  ：一页纸的收支报告，适合直接发给父母看
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U, Store = global.Store, Stats = global.Stats, Xlsx = global.Xlsx;
  const Report = {};

  const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Source Han Sans SC",system-ui,sans-serif';

  function dayStr(t) { return U.toISODate(new Date(t.time)); }
  function timeStr(t) {
    const d = new Date(t.time);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  /* ============================================================
     一、Excel 导出
     ============================================================ */
  Report.buildSheets = function (list, range) {
    const full = Stats.full(list);
    const included = full.parts.included;

    /* 明细表 */
    const detail = {
      name: '账目明细',
      columns: [
        { title: '日期', width: 12 }, { title: '时间', width: 8 },
        { title: '类型', width: 7 }, { title: '金额', width: 12 },
        { title: '分类', width: 12 }, { title: '账户', width: 11 },
        { title: '来源（交易对方）', width: 22 }, { title: '用途（事项）', width: 22 },
        { title: '备注', width: 24 }, { title: '是否计入统计', width: 14 },
        { title: '排除原因', width: 12 }, { title: '报销状态', width: 11 },
        { title: '标签', width: 14 }, { title: '导入来源', width: 12 }
      ],
      rows: list.map(function (t) {
        return [
          dayStr(t), timeStr(t),
          t.type === 'income' ? '收入' : '支出',
          { v: t.type === 'income' ? t.amount : -t.amount, style: 'money' },
          t.categoryName || '未分类', t.account || '',
          t.counterparty || '', t.item || '', t.note || '',
          t.excludeStat ? '不计入' : '计入', t.excludeReason || '',
          t.reimburseStatus === 'pending' ? '待报销' : (t.reimburseStatus === 'done' ? '已报销' : ''),
          t.tags.join('、'),
          { manual: '手动记账', wechat: '微信账单', alipay: '支付宝账单', import: '账单导入' }[t.source] || t.source || ''
        ];
      })
    };

    /* 分类汇总表 */
    const catRows = [];
    ['expense', 'income'].forEach(function (type) {
      Stats.byCategory(included, type).rows.forEach(function (r) {
        catRows.push([
          type === 'expense' ? '支出' : '收入',
          r.name,
          { v: r.amount, style: 'money' },
          r.count,
          { v: Math.round(r.pct * 10) / 10 + '%' }
        ]);
      });
    });
    const cats = {
      name: '分类汇总',
      columns: [
        { title: '类型', width: 10 }, { title: '分类', width: 14 },
        { title: '金额', width: 14 }, { title: '笔数', width: 8 }, { title: '占比', width: 10 }
      ],
      rows: catRows
    };

    /* 周期汇总表 */
    const summary = {
      name: '周期汇总',
      columns: [{ title: '项目', width: 24 }, { title: '数值', width: 18 }],
      rows: [
        ['统计区间', range.label],
        ['收入', { v: full.included.income, style: 'money' }],
        ['支出', { v: full.included.expense, style: 'money' }],
        ['结余', { v: full.included.net, style: 'money' }],
        ['计入统计笔数', full.included.count],
        ['日均支出', { v: Stats.dailyAverage(full.included, range), style: 'money' }],
        ['不计入统计笔数', full.excluded.count],
        ['不计入统计金额', { v: Math.round((full.excluded.expense + full.excluded.income) * 100) / 100, style: 'money' }],
        ['已隐藏笔数', full.hidden.count],
        ['导出时间', U.fmtDateTime(new Date())]
      ]
    };

    /* 每日收支表 */
    const trend = Stats.trend(included, range);
    const daily = {
      name: trend.useMonth ? '每月收支' : '每日收支',
      columns: [
        { title: trend.useMonth ? '月份' : '日期', width: 14 },
        { title: '收入', width: 14 }, { title: '支出', width: 14 }, { title: '结余', width: 14 }
      ],
      rows: trend.buckets.map(function (b) {
        return [
          b.label,
          { v: b.income, style: 'money' },
          { v: b.expense, style: 'money' },
          { v: Math.round((b.income - b.expense) * 100) / 100, style: 'money' }
        ];
      })
    };

    return [summary, detail, cats, daily];
  };

  Report.exportExcel = function (opts) {
    opts = opts || {};
    const list = opts.list || [];
    const range = opts.range || Stats.range('month');
    const bytes = Xlsx.build(Report.buildSheets(list, range));
    const name = '记账报表-' + U.toISODate(new Date()) + '.xlsx';
    U.download(name, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return name;
  };

  /* ============================================================
     二、图片报表（给父母看 / 给自己看）
     ============================================================ */
  const HEADER_H = 240;   // 顶部横幅高度
  const CARD_Y = 250;     // 收支卡片上边
  const CARD_H = 190;     // 收支卡片高度

  const C = {
    bg: '#ffffff',
    header1: '#4f46e5',
    header2: '#8b7cff',
    text: '#16181f',
    soft: '#5b6070',
    faint: '#8d93a6',
    line: '#e6e8f2',
    expense: '#e5484d',
    income: '#12a594',
    card: '#f7f8fd'
  };

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function measure(report) {
    const expRows = report.expenseCats.length;
    const incRows = report.incomeCats.length;
    const srcRows = report.sources.length;
    let h = CARD_Y + CARD_H + 100;                 // 头部横幅 + 收支卡片 + 间距
    h += 42 + Math.max(1, expRows) * 68 + 34;      // 支出构成
    if (incRows) h += 42 + incRows * 68 + 34;      // 收入构成
    h += 42 + 140 + 100;                           // 走势
    if (srcRows) h += 42 + srcRows * 60 + 34;      // 来源
    h += 110;                                      // 页脚
    return h;
  }

  Report.buildReportData = function (list, range) {
    const full = Stats.full(list);
    const included = full.parts.included;
    const expCats = Stats.byCategory(included, 'expense').rows.slice(0, 8);
    const incCats = Stats.byCategory(included, 'income').rows.slice(0, 5);
    const sources = Stats.byCounterparty(included, 'expense', 6);
    return {
      label: range.label,
      summary: full.included,
      excluded: full.excluded,
      hidden: full.hidden,
      expenseCats: expCats,
      incomeCats: incCats,
      sources: sources,
      expenseTotal: Stats.byCategory(included, 'expense').total,
      incomeTotal: Stats.byCategory(included, 'income').total,
      trend: Stats.trend(included, range),
      daily: Stats.dailyAverage(full.included, range),
      generatedAt: new Date()
    };
  };

  Report.renderCanvas = function (report, opts) {
    opts = opts || {};
    const W = 1080;
    const PAD = 56;
    const H = measure(report);

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    /* ---- 顶部渐变横幅 ---- */
    const grad = ctx.createLinearGradient(0, 0, W, HEADER_H);
    grad.addColorStop(0, C.header1);
    grad.addColorStop(1, C.header2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, HEADER_H);

    ctx.fillStyle = 'rgba(255,255,255,.16)';
    ctx.beginPath();
    ctx.arc(W - 60, 24, 140, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 46px ' + FONT;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('大学生活记账本', PAD, 96);

    ctx.font = '28px ' + FONT;
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.fillText(report.label, PAD, 150);

    /* ---- 收支卡片 ---- */
    const cardY = CARD_Y, cardH = CARD_H;
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(20,24,50,.10)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 8;
    roundRect(ctx, 40, cardY, W - 80, cardH, 26);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    const cols = [
      { k: '收入', v: report.summary.income, c: C.income },
      { k: '支出', v: report.summary.expense, c: C.expense },
      { k: '结余', v: report.summary.net, c: C.text }
    ];
    const colW = (W - 80) / 3;
    cols.forEach(function (c, i) {
      const cx = 40 + colW * i + colW / 2;
      ctx.textAlign = 'center';
      ctx.fillStyle = C.faint;
      ctx.font = '26px ' + FONT;
      ctx.fillText(c.k, cx, cardY + 62);
      ctx.fillStyle = c.c;
      ctx.font = 'bold 44px ' + FONT;
      ctx.fillText(U.fmtMoney(c.v), cx, cardY + 122);
      if (i < 2) {
        ctx.fillStyle = C.line;
        ctx.fillRect(40 + colW * (i + 1), cardY + 40, 1, cardH - 80);
      }
    });
    ctx.textAlign = 'left';

    /* 一句话总结 */
    ctx.fillStyle = C.soft;
    ctx.font = '24px ' + FONT;
    const tip = '共记录 ' + report.summary.count + ' 笔，平均每天支出 ' + U.fmtMoney(report.daily) +
      (report.excluded.count ? '，另有 ' + report.excluded.count + ' 笔报销/代付未计入' : '');
    ctx.fillText(tip, PAD, cardY + cardH + 46);

    let y = cardY + cardH + 100;

    /* ---- 区块标题 ---- */
    function sectionTitle(text, extra) {
      ctx.fillStyle = C.text;
      ctx.font = 'bold 32px ' + FONT;
      ctx.fillText(text, PAD, y);
      if (extra) {
        ctx.textAlign = 'right';
        ctx.fillStyle = C.faint;
        ctx.font = '24px ' + FONT;
        ctx.fillText(extra, W - PAD, y);
        ctx.textAlign = 'left';
      }
      y += 42;
    }

    /* ---- 分类条形 ---- */
    function bars(rows, total, color) {
      if (!rows.length) {
        ctx.fillStyle = C.faint;
        ctx.font = '26px ' + FONT;
        ctx.fillText('暂无数据', PAD, y + 22);
        y += 68;
        return;
      }
      const trackX = PAD + 250;
      const trackW = W - PAD - trackX - 190;
      rows.forEach(function (r) {
        ctx.fillStyle = C.text;
        ctx.font = '26px ' + FONT;
        ctx.fillText((r.icon || '') + ' ' + r.name, PAD, y + 34);

        ctx.fillStyle = C.card;
        roundRect(ctx, trackX, y + 12, trackW, 26, 13);
        ctx.fill();
        const w = Math.max(10, (r.amount / (total || 1)) * trackW);
        ctx.fillStyle = r.color || color;
        roundRect(ctx, trackX, y + 12, Math.min(w, trackW), 26, 13);
        ctx.fill();

        ctx.textAlign = 'right';
        ctx.fillStyle = C.text;
        ctx.font = 'bold 26px ' + FONT;
        ctx.fillText(U.fmtMoney(r.amount), W - PAD, y + 34);
        ctx.fillStyle = C.faint;
        ctx.font = '22px ' + FONT;
        ctx.fillText(r.pct.toFixed(0) + '%', W - PAD, y + 60);
        ctx.textAlign = 'left';
        y += 68;
      });
    }

    sectionTitle('支出构成', U.fmtMoney(report.summary.expense));
    bars(report.expenseCats, report.expenseTotal || report.summary.expense, C.expense);
    y += 34;

    if (report.incomeCats.length) {
      sectionTitle('收入构成', U.fmtMoney(report.summary.income));
      bars(report.incomeCats, report.incomeTotal || report.summary.income, C.income);
      y += 34;
    }

    /* ---- 走势图 ---- */
    sectionTitle(report.trend.useMonth ? '每月收支' : '每日收支');
    const buckets = report.trend.buckets;
    const chartH = 140;
    const chartW = W - PAD * 2;
    const max = buckets.reduce(function (m, b) { return Math.max(m, b.expense, b.income); }, 0) || 1;
    const bw = Math.max(3, Math.min(28, chartW / buckets.length - 4));
    const step = chartW / Math.max(1, buckets.length);

    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD, y + chartH + 12);
    ctx.lineTo(W - PAD, y + chartH + 12);
    ctx.stroke();

    const labelStep = Math.ceil(buckets.length / 10);
    buckets.forEach(function (b, i) {
      const cx = PAD + step * i + step / 2;
      const he = (b.expense / max) * chartH;
      const hi = (b.income / max) * chartH;
      if (he > 0) {
        ctx.fillStyle = C.expense;
        roundRect(ctx, cx - bw - 1, y + chartH - he + 12, bw, Math.max(3, he), 4);
        ctx.fill();
      }
      if (hi > 0) {
        ctx.fillStyle = C.income;
        roundRect(ctx, cx + 1, y + chartH - hi + 12, bw, Math.max(3, hi), 4);
        ctx.fill();
      }
      if (i % labelStep === 0) {
        ctx.textAlign = 'center';
        ctx.fillStyle = C.faint;
        ctx.font = '20px ' + FONT;
        ctx.fillText(b.label, cx, y + chartH + 44);
        ctx.textAlign = 'left';
      }
    });
    y += chartH + 104;

    /* ---- 来源排行 ---- */
    if (report.sources.length) {
      sectionTitle('支出 TOP 来源');
      report.sources.forEach(function (s) {
        ctx.fillStyle = C.text;
        ctx.font = '26px ' + FONT;
        const name = s.name.length > 16 ? s.name.slice(0, 16) + '…' : s.name;
        ctx.fillText(name, PAD, y + 28);
        ctx.textAlign = 'right';
        ctx.fillStyle = C.soft;
        ctx.font = 'bold 26px ' + FONT;
        ctx.fillText(U.fmtMoney(s.amount) + '　' + s.count + ' 笔', W - PAD, y + 28);
        ctx.textAlign = 'left';
        y += 60;
      });
      y += 34;
    }

    /* ---- 页脚 ---- */
    ctx.fillStyle = C.line;
    ctx.fillRect(PAD, y, W - PAD * 2, 1);
    ctx.fillStyle = C.faint;
    ctx.font = '22px ' + FONT;
    ctx.fillText('生成时间：' + U.fmtDateTime(report.generatedAt), PAD, y + 40);
    ctx.fillText('数据保存在本机，不会上传到任何服务器', PAD, y + 74);

    return canvas;
  };

  Report.exportImage = function (opts) {
    opts = opts || {};
    const list = opts.list || [];
    const range = opts.range || Stats.range('month');
    const data = Report.buildReportData(list, range);
    data._list = list;
    const canvas = Report.renderCanvas(data, opts);
    const name = '收支报告-' + U.toISODate(new Date()) + '.png';

    if (canvas.toBlob) {
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) {
          U.download(name, blob, 'image/png');
          resolve(name);
        }, 'image/png');
      });
    }
    // 旧浏览器退路：直接给 dataURL
    U.download(name, canvas.toDataURL('image/png'), 'image/png');
    return Promise.resolve(name);
  };

  global.Report = Report;
  if (typeof module !== 'undefined' && module.exports) module.exports = Report;
})(typeof window !== 'undefined' ? window : globalThis);