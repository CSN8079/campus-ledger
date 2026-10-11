/* ============================================================
   stats.js - 统计计算
   周期区间、收支合计、分类占比、趋势、来源排行。
   所有汇总默认排除「不计入统计」的账单（报销/代付/转账等），
   并把被排除的部分单独统计出来，避免账目失真。
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U, Store = global.Store;
  const S = {};

  /* ---------------- 周期定义 ---------------- */
  S.periods = [
    { id: 'week', name: '本周' },
    { id: 'month', name: '本月' },
    { id: 'lastMonth', name: '上月' },
    { id: 'semester', name: '本学期' },
    { id: 'year', name: '今年' },
    { id: 'all', name: '全部' },
    { id: 'custom', name: '自定义' }
  ];

  function weekStart() {
    return Store.settings.weekStart === 0 ? 0 : 1;
  }

  /* 返回 {from:Date, to:Date, label:string} */
  S.range = function (periodId, custom) {
    const now = new Date();
    const ws = weekStart();
    let from, to, label;

    switch (periodId) {
      case 'today':
        from = U.startOfDay(now); to = U.endOfDay(now); label = '今天';
        break;
      case 'week': {
        from = U.startOfWeek(now, ws); to = U.endOfWeek(now, ws);
        label = '本周 ' + U.fmtDate(from, 'md') + ' - ' + U.fmtDate(to, 'md');
        break;
      }
      case 'lastWeek': {
        const d = U.addDays(now, -7);
        from = U.startOfWeek(d, ws); to = U.endOfWeek(d, ws);
        label = '上周 ' + U.fmtDate(from, 'md') + ' - ' + U.fmtDate(to, 'md');
        break;
      }
      case 'month': {
        from = U.startOfMonth(now); to = U.endOfMonth(now);
        label = now.getFullYear() + '年' + (now.getMonth() + 1) + '月';
        break;
      }
      case 'lastMonth': {
        const d = U.addMonths(now, -1);
        from = U.startOfMonth(d); to = U.endOfMonth(d);
        label = (from.getFullYear()) + '年' + (from.getMonth() + 1) + '月';
        break;
      }
      case 'semester': {
        const sem = Store.activeSemester();
        if (sem) {
          from = U.startOfDay(U.fromISO(sem.start));
          to = U.endOfDay(U.fromISO(sem.end));
          label = sem.name;
        } else {
          from = U.startOfMonth(now); to = U.endOfMonth(now); label = '本月';
        }
        break;
      }
      case 'year': {
        from = new Date(now.getFullYear(), 0, 1); to = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
        label = now.getFullYear() + '年';
        break;
      }
      case 'custom': {
        from = custom && custom.from ? U.startOfDay(U.fromISO(custom.from)) : U.startOfMonth(now);
        to = custom && custom.to ? U.endOfDay(U.fromISO(custom.to)) : U.endOfMonth(now);
        label = U.fmtDate(from, 'ymd') + ' ~ ' + U.fmtDate(to, 'ymd');
        break;
      }
      case 'all':
      default: {
        let min = Infinity;
        Store.tx.forEach((t) => { if (t.time < min) min = t.time; });
        from = isFinite(min) ? U.startOfDay(new Date(min)) : U.startOfMonth(now);
        to = U.endOfDay(now);
        label = '全部记录';
        break;
      }
    }
    return { from: from, to: to, label: label, id: periodId };
  };

  /* ---------------- 数据拆分 ---------------- */
  /* 把一批账单拆成「计入统计」与「不计入统计」两部分 */
  S.split = function (list) {
    const included = [], excluded = [], hidden = [];
    list.forEach((t) => {
      if (t.hidden) hidden.push(t);
      else if (t.excludeStat) excluded.push(t);
      else included.push(t);
    });
    return { included: included, excluded: excluded, hidden: hidden };
  };

  /* ---------------- 汇总 ---------------- */
  S.summarize = function (list) {
    let income = 0, expense = 0, count = 0;
    list.forEach((t) => {
      count++;
      if (t.type === 'income') income += t.amount; else expense += t.amount;
    });
    income = U.round2(income); expense = U.round2(expense);
    return { income: income, expense: expense, net: U.round2(income - expense), count: count };
  };

  /* 完整统计：计入 + 被排除 + 被隐藏 */
  S.full = function (list) {
    const parts = S.split(list);
    return {
      parts: parts,
      included: S.summarize(parts.included),
      excluded: S.summarize(parts.excluded),
      hidden: S.summarize(parts.hidden),
      raw: S.summarize(list)
    };
  };

  /* ---------------- 分类占比 ---------------- */
  S.byCategory = function (list, type) {
    const map = new Map();
    list.forEach((t) => {
      if (type && t.type !== type) return;
      const key = t.categoryId || ('name:' + (t.categoryName || '未分类'));
      if (!map.has(key)) {
        const c = t.categoryId ? Store.getCategory(t.categoryId) : null;
        map.set(key, {
          key: key,
          categoryId: t.categoryId,
          name: (c && c.name) || t.categoryName || '未分类',
          icon: (c && c.icon) || '🏷️',
          color: (c && c.color) || U.colorFromString(t.categoryName || '未分类'),
          amount: 0,
          count: 0
        });
      }
      const row = map.get(key);
      row.amount += t.amount;
      row.count++;
    });
    const total = Array.from(map.values()).reduce((s, r) => s + r.amount, 0);
    const arr = Array.from(map.values()).map((r) => {
      r.amount = U.round2(r.amount);
      r.pct = total ? (r.amount / total) * 100 : 0;
      return r;
    });
    arr.sort((a, b) => b.amount - a.amount);
    return { rows: arr, total: U.round2(total) };
  };

  /* ---------------- 来源（交易对方）排行 ---------------- */
  S.byCounterparty = function (list, type, limit) {
    const map = new Map();
    list.forEach((t) => {
      if (type && t.type !== type) return;
      const name = (t.counterparty || t.item || '未标注来源').trim();
      if (!map.has(name)) map.set(name, { name: name, amount: 0, count: 0 });
      const r = map.get(name);
      r.amount += t.amount; r.count++;
    });
    const arr = Array.from(map.values()).map((r) => { r.amount = U.round2(r.amount); return r; });
    arr.sort((a, b) => b.amount - a.amount);
    return limit ? arr.slice(0, limit) : arr;
  };

  /* ---------------- 账户分布 ---------------- */
  S.byAccount = function (list, type) {
    const map = new Map();
    list.forEach((t) => {
      if (type && t.type !== type) return;
      const name = t.account || '未指定';
      if (!map.has(name)) map.set(name, { name: name, amount: 0, count: 0 });
      map.get(name).amount += t.amount;
      map.get(name).count++;
    });
    const arr = Array.from(map.values()).map((r) => { r.amount = U.round2(r.amount); return r; });
    arr.sort((a, b) => b.amount - a.amount);
    return arr;
  };

  /* ---------------- 时间趋势 ---------------- */
  /* 返回 [{label, expense, income}] —— 粒度按区间长度自动选择 */
  S.trend = function (list, range) {
    const span = U.daysBetween(range.from, range.to);
    const useMonth = span > 62;
    const buckets = [];
    const index = new Map();

    if (useMonth) {
      U.eachMonth(range.from, range.to).forEach((d) => {
        const key = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
        const item = { key: key, label: (d.getMonth() + 1) + '月', expense: 0, income: 0 };
        index.set(key, item); buckets.push(item);
      });
    } else {
      U.eachDay(range.from, range.to).forEach((d) => {
        const key = U.toISODate(d);
        const item = { key: key, label: (d.getMonth() + 1) + '/' + d.getDate(), expense: 0, income: 0 };
        index.set(key, item); buckets.push(item);
      });
    }

    list.forEach((t) => {
      const d = new Date(t.time);
      const key = useMonth
        ? d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2)
        : U.toISODate(d);
      const b = index.get(key);
      if (!b) return;
      if (t.type === 'income') b.income += t.amount; else b.expense += t.amount;
    });

    buckets.forEach((b) => { b.expense = U.round2(b.expense); b.income = U.round2(b.income); });
    return { buckets: buckets, useMonth: useMonth };
  };

  /* ---------------- 每日平均 ---------------- */
  S.dailyAverage = function (summary, range) {
    const days = Math.max(1, U.daysBetween(range.from, range.to) + 1);
    return U.round2(summary.expense / days);
  };

  /* ---------------- 环比文字 ---------------- */
  S.deltaText = function (cur, prev) {
    if (!prev) return cur ? '新增' : '';
    const d = ((cur - prev) / prev) * 100;
    const sign = d > 0 ? '+' : '';
    return sign + d.toFixed(1) + '%';
  };

  /* ---------------- 分类统计（供设置页显示用量） ---------------- */
  S.categoryUsage = function () {
    const map = new Map();
    Store.tx.forEach((t) => {
      if (!t.categoryId) return;
      map.set(t.categoryId, (map.get(t.categoryId) || 0) + 1);
    });
    return map;
  };

  global.Stats = S;
})(window);