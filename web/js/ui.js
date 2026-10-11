/* ============================================================
   ui.js - 界面渲染与交互（第一部分：框架 / 概览 / 明细）
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U, Store = global.Store, Stats = global.Stats, D = global.DEFAULTS;
  const UI = {};
  const $ = U.$, $$ = U.$$;

  /* ---------------- 界面状态 ---------------- */
  UI.state = {
    tab: 'home',
    homePeriod: 'month',
    list: {
      period: 'month',
      types: ['expense', 'income'],
      q: '',
      hideExcluded: false,
      showHidden: false,
      categoryIds: [],
      accounts: [],
      custom: null
    },
    stats: { period: 'month', type: 'expense', custom: null },
    selected: new Set(),
    selectMode: false,
    importResult: null
  };

  /* ---------------- 提示 ---------------- */
  UI.toast = function (msg, kind) {
    const root = $('#toastRoot');
    if (!root) return;
    const t = U.el('div', { class: 'toast ' + (kind || ''), text: msg });
    root.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .25s, transform .25s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(8px)';
      setTimeout(() => t.remove(), 260);
    }, kind === 'err' ? 3200 : 2100);
  };

  /* ---------------- 底部弹层 ---------------- */
  let sheetCloser = null;
  let sheetCloseTimer = null;

  UI.openSheet = function (opts) {
    // 关键：取消上一次关闭时挂着的延时清理。
    // 否则「关掉 A 后立刻打开 B」时，A 的清理会把 B 的内容抹掉，
    // 而 is-open 还留着，于是出现一层看不见却挡住所有点击的遮罩。
    if (sheetCloseTimer) { clearTimeout(sheetCloseTimer); sheetCloseTimer = null; }

    const root = $('#sheetRoot');
    U.clear(root);
    const sheet = U.el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
    const mask = U.el('div', { class: 'sheet-mask', onclick: () => UI.closeSheet() });
    const grip = U.el('div', { class: 'sheet-grip' });

    const head = U.el('div', { class: 'sheet-head' }, [
      U.el('h3', { text: opts.title || '' }),
      U.el('button', { class: 'icon-btn', title: '关闭', onclick: () => UI.closeSheet(), text: '✕' })
    ]);

    sheet.appendChild(grip);
    sheet.appendChild(head);
    if (opts.body) U.append(sheet, opts.body);

    if (opts.actions && opts.actions.length) {
      const bar = U.el('div', { class: 'sheet-actions' });
      opts.actions.forEach((a) => {
        bar.appendChild(U.el('button', {
          class: 'btn ' + (a.primary ? 'btn-primary' : '') + ' ' + (a.danger ? 'btn-danger' : '') + (a.block ? ' btn-block' : ''),
          text: a.label,
          disabled: a.disabled,
          onclick: () => a.onClick && a.onClick()
        }));
      });
      sheet.appendChild(bar);
    }
    if (opts.note) sheet.appendChild(U.el('p', { class: 'sheet-note', text: opts.note }));

    root.appendChild(mask);
    root.appendChild(sheet);
    requestAnimationFrame(() => root.classList.add('is-open'));
    sheetCloser = opts.onClose || null;
  };

  UI.closeSheet = function () {
    const root = $('#sheetRoot');
    if (!root.classList.contains('is-open')) return;
    root.classList.remove('is-open');
    const cb = sheetCloser; sheetCloser = null;
    if (sheetCloseTimer) clearTimeout(sheetCloseTimer);
    sheetCloseTimer = setTimeout(() => {
      sheetCloseTimer = null;
      U.clear(root);
      if (cb) cb();
    }, 300);
  };

  /* ---------------- 确认框 ---------------- */
  UI.confirm = function (opts) {
    return new Promise((resolve) => {
      const body = U.el('div', null, [
        U.el('p', { style: { fontSize: '14px', lineHeight: '1.7', color: 'var(--text-soft)' }, text: opts.message || '' })
      ]);
      let done = false;
      const finish = (v) => { if (done) return; done = true; UI.closeSheet(); setTimeout(() => resolve(v), 260); };
      UI.openSheet({
        title: opts.title || '请确认',
        body: body,
        actions: [
          { label: opts.cancelText || '取消', onClick: () => finish(false) },
          { label: opts.okText || '确定', danger: opts.danger, primary: !opts.danger, onClick: () => finish(true) }
        ],
        onClose: () => finish(false)
      });
    });
  };

  /* ---------------- 小组件 ---------------- */
  function seg(items, active, onPick) {
    const wrap = U.el('div', { class: 'seg' });
    items.forEach((it) => {
      wrap.appendChild(U.el('button', {
        class: it.id === active ? 'is-active' : '',
        text: it.name,
        onclick: () => onPick(it.id)
      }));
    });
    return wrap;
  }

  function chips(items, activeSet, onToggle) {
    const wrap = U.el('div', { class: 'chips' });
    items.forEach((it) => {
      wrap.appendChild(U.el('button', {
        class: 'chip' + (activeSet.has(it.id) ? ' is-active' : ''),
        text: it.name,
        onclick: () => onToggle(it.id)
      }));
    });
    return wrap;
  }

  function emptyBox(icon, text) {
    return U.el('div', { class: 'empty' }, [
      U.el('span', { class: 'big', text: icon }),
      U.el('span', { text: text })
    ]);
  }

  function amountClass(t) { return t.type === 'income' ? 'income' : 'expense'; }

  function amountText(t) {
    return (t.type === 'income' ? '+' : '-') + U.fmtMoney(t.amount).slice(1);
  }

  /* 一条账目的行 */
  function txRow(t, opts) {
    opts = opts || {};
    const cat = t.categoryId ? Store.getCategory(t.categoryId) : null;
    const icon = cat ? cat.icon : (t.type === 'income' ? '💰' : '📦');
    const title = t.counterparty || t.item || t.categoryName || (t.type === 'income' ? '收入' : '支出');
    const metaBits = [];
    metaBits.push(t.categoryName || '未分类');
    if (t.account) metaBits.push(t.account);
    if (t.item && t.item !== title) metaBits.push(t.item);
    if (t.reimburseStatus === 'pending') metaBits.push('待报销');
    else if (t.reimburseStatus === 'done') metaBits.push('已报销');
    else if (t.excludeStat) metaBits.push(t.excludeReason || '不计入');

    const cls = ['tx'];
    if (t.excludeStat) cls.push('is-excluded');
    if (opts.selected) cls.push('is-selected');

    return U.el('div', {
      class: cls.join(' '),
      onclick: () => opts.onClick ? opts.onClick(t) : UI.openTxDetail(t),
      oncontextmenu: (e) => { e.preventDefault(); UI.openTxDetail(t); }
    }, [
      U.el('div', { class: 'tx-ico', text: icon, style: { background: U.hexToRgba(cat ? cat.color : '#94a3b8', 0.14) } }),
      U.el('div', { class: 'tx-body' }, [
        U.el('div', { class: 'tx-top' }, [
          U.el('span', { class: 'tx-name', text: title }),
          U.el('span', { class: 'tx-amt amount ' + amountClass(t), text: amountText(t) })
        ]),
        U.el('div', { class: 'tx-meta', html: metaBits.map((m) => '<span>' + U.esc(m) + '</span>').join('<span class="dot">·</span>') })
      ])
    ]);
  }

  /* 按日期分组的账目列表 */
  function txGroups(list, opts) {
    opts = opts || {};
    if (!list.length) return emptyBox('🍃', opts.emptyText || '这里还没有记录');
    const wrap = U.el('div');
    const groups = U.groupBy(list, (t) => t.dateKey);
    const keys = Array.from(groups.keys()).sort().reverse();
    keys.forEach((k) => {
      const rows = groups.get(k).slice().sort((a, b) => b.time - a.time);
      const inc = rows.filter((r) => r.type === 'income' && !r.excludeStat).reduce((s, r) => s + r.amount, 0);
      const exp = rows.filter((r) => r.type === 'expense' && !r.excludeStat).reduce((s, r) => s + r.amount, 0);
      const sumTxt = [];
      if (inc) sumTxt.push('收 ¥' + U.fmtMoney(inc).slice(1));
      if (exp) sumTxt.push('支 ¥' + U.fmtMoney(exp).slice(1));

      const group = U.el('div', { class: 'day-group' }, [
        U.el('div', { class: 'day-head' }, [
          U.el('span', { text: U.fmtDayLabel(U.fromISO(k)) }),
          U.el('span', { class: 'day-sum', text: sumTxt.join('  ') })
        ])
      ]);
      const listBox = U.el('div', { class: 'tx-list' });
      rows.forEach((t) => listBox.appendChild(txRow(t, opts)));
      group.appendChild(listBox);
      wrap.appendChild(group);
    });
    return wrap;
  }

  /* ---------------- 概览 ---------------- */
  UI.renderHome = function () {
    const view = $('#view-home');
    U.clear(view);
    const period = UI.state.homePeriod;
    const range = Stats.range(period);
    const list = Store.query({ from: range.from, to: range.to, includeExcluded: true, includeHidden: true });
    const full = Stats.full(list);
    const inc = full.included, exc = full.excluded;

    /* 主卡片 */
    const hero = U.el('div', { class: 'hero' }, [
      U.el('div', { class: 'hero-label' }, [
        U.el('span', { text: range.label }),
        U.el('span', { text: Store.settings.weekStart === 0 ? '周日起' : '周一起' })
      ]),
      U.el('div', { class: 'hero-balance', text: U.fmtMoney(inc.net) }),
      U.el('div', { class: 'hero-split' }, [
        U.el('div', null, [U.el('div', { class: 'k', text: '收入' }), U.el('div', { class: 'v', text: U.fmtMoney(inc.income) })]),
        U.el('div', null, [U.el('div', { class: 'k', text: '支出' }), U.el('div', { class: 'v', text: U.fmtMoney(inc.expense) })])
      ]),
      U.el('div', { class: 'hero-sub', style: { marginTop: '10px' }, text: '共 ' + inc.count + ' 笔计入统计' + (exc.count ? '，另有 ' + exc.count + ' 笔已排除' : '') })
    ]);
    view.appendChild(hero);

    view.appendChild(seg(
      [{ id: 'week', name: '本周' }, { id: 'month', name: '本月' }, { id: 'semester', name: '本学期' }, { id: 'lastMonth', name: '上月' }, { id: 'all', name: '全部' }],
      period,
      (id) => { UI.state.homePeriod = id; UI.renderHome(); }
    ));

    /* 待报销提醒 */
    const pending = Store.pendingReimburse();
    if (pending.length) {
      const amt = pending.reduce((s, t) => s + t.amount, 0);
      view.appendChild(U.el('div', { class: 'card', style: { borderColor: 'var(--warn)', background: 'var(--warn-soft)' } }, [
        U.el('div', { class: 'card-title' }, [
          U.el('h3', { text: '⏳ 待报销 ' + pending.length + ' 笔' }),
          U.el('span', { class: 'hint', text: U.fmtMoney(amt) })
        ]),
        U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)', marginBottom: '10px' }, text: '这些支出已从统计中排除。收到报销款后点一下即可配对入账。' }),
        U.el('button', {
          class: 'btn btn-sm', text: '去处理',
          onclick: () => { UI.state.list = Object.assign(UI.state.list, { period: 'all', types: ['expense'] }); UI.go('list'); }
        })
      ]));
    }

    /* 小卡片 */
    const todayRange = Stats.range('today');
    const todayList = Store.query({ from: todayRange.from, to: todayRange.to });
    const todaySum = Stats.summarize(todayList);
    const weekRange = Stats.range('week');
    const weekSum = Stats.summarize(Store.query({ from: weekRange.from, to: weekRange.to }));

    view.appendChild(U.el('div', { class: 'stat-grid three', style: { marginBottom: '12px' } }, [
      U.el('div', { class: 'stat-card' }, [U.el('div', { class: 'k', text: '今日支出' }), U.el('div', { class: 'v', text: U.fmtMoney(todaySum.expense) })]),
      U.el('div', { class: 'stat-card' }, [U.el('div', { class: 'k', text: '本周支出' }), U.el('div', { class: 'v', text: U.fmtMoney(weekSum.expense) })]),
      U.el('div', { class: 'stat-card' }, [U.el('div', { class: 'k', text: '本区间日均' }), U.el('div', { class: 'v', text: U.fmtMoney(Stats.dailyAverage(inc, range)) })])
    ]));

    /* 支出分类 Top */
    const byCat = Stats.byCategory(full.parts.included, 'expense');
    if (byCat.rows.length) {
      const card = U.el('div', { class: 'card' }, [U.el('div', { class: 'card-title' }, [U.el('h3', { text: '支出构成' }), U.el('span', { class: 'hint', text: U.fmtMoney(byCat.total) })])]);
      const bars = U.el('div', { class: 'bars' });
      byCat.rows.slice(0, 6).forEach((r) => {
        bars.appendChild(U.el('div', { class: 'bar-item' }, [
          U.el('span', { class: 'bl', text: r.icon + ' ' + r.name }),
          U.el('div', { class: 'bar-track' }, [U.el('div', { class: 'bar-fill', style: { width: Math.max(2, r.pct) + '%', background: r.color } })]),
          U.el('span', { class: 'bv', text: U.fmtMoney(r.amount) })
        ]));
      });
      card.appendChild(bars);
      view.appendChild(card);
    }

    /* 最近记录 */
    const recent = Store.query({ from: range.from, to: range.to, includeExcluded: true }).slice(0, 8);
    const recentCard = U.el('div', { class: 'card' }, [
      U.el('div', { class: 'card-title' }, [
        U.el('h3', { text: '最近记录' }),
        U.el('button', { class: 'chip', text: '查看全部', onclick: () => UI.go('list') })
      ])
    ]);
    recentCard.appendChild(txGroups(recent, { emptyText: '还没有记录，点右下角 ＋ 记一笔，或右上角导入账单' }));
    view.appendChild(recentCard);
  };

  /* ---------------- 明细 ---------------- */
  UI.renderList = function () {
    const view = $('#view-list');
    U.clear(view);
    const f = UI.state.list;
    const range = Stats.range(f.period, f.custom);

    view.appendChild(seg(
      [{ id: 'week', name: '本周' }, { id: 'month', name: '本月' }, { id: 'semester', name: '本学期' }, { id: 'year', name: '今年' }, { id: 'all', name: '全部' }, { id: 'custom', name: '自定义' }],
      f.period,
      (id) => {
        if (id === 'custom') { UI.pickCustomRange((r) => { f.custom = r; f.period = 'custom'; UI.renderList(); }); return; }
        f.period = id; UI.renderList();
      }
    ));

    /* 搜索框 */
    const search = U.el('input', {
      class: 'input', type: 'search', placeholder: '搜索来源、用途、备注、分类…', value: f.q,
      style: { marginBottom: '10px' },
      oninput: U.debounce((e) => { f.q = e.target.value; UI.renderListBody(); }, 250)
    });
    view.appendChild(search);

    /* 类型切换 */
    const typeSeg = U.el('div', { class: 'seg' });
    [{ id: 'all', name: '全部' }, { id: 'expense', name: '支出' }, { id: 'income', name: '收入' }].forEach((it) => {
      const active = it.id === 'all' ? f.types.length === 2 : (f.types.length === 1 && f.types[0] === it.id);
      typeSeg.appendChild(U.el('button', {
        class: active ? 'is-active' : '', text: it.name,
        onclick: () => {
          f.types = it.id === 'all' ? ['expense', 'income'] : [it.id];
          UI.renderList();
        }
      }));
    });
    view.appendChild(typeSeg);

    /* 过滤开关 */
    const filterRow = U.el('div', { class: 'chips', style: { marginBottom: '12px' } }, [
      /* 这两个按钮的文字始终写「当前是什么状态」，避免被误解成「点了才会怎样」 */
      U.el('button', {
        class: 'chip' + (f.hideExcluded ? '' : ' is-active'),
        text: '不计入统计：' + (f.hideExcluded ? '不显示' : '显示'),
        title: '点一下切换：报销、代付等「不计入统计」的账单，是否显示在列表里',
        onclick: () => {
          f.hideExcluded = !f.hideExcluded;
          Store.updateSettings({ hideExcludedInList: f.hideExcluded });
          UI.renderList();
        }
      }),
      U.el('button', {
        class: 'chip' + (f.showHidden ? ' is-active' : ''),
        text: '已隐藏账单：' + (f.showHidden ? '显示' : '不显示'),
        title: '点一下切换：你手动隐藏的账单，是否显示在列表里',
        onclick: () => { f.showHidden = !f.showHidden; UI.renderList(); }
      }),
      U.el('button', {
        class: 'chip' + (f.categoryIds.length ? ' is-active' : ''), text: '按分类' + (f.categoryIds.length ? '（' + f.categoryIds.length + '）' : ''),
        onclick: () => UI.openCategoryFilter()
      }),
      U.el('button', {
        class: 'chip' + (f.accounts.length ? ' is-active' : ''), text: '按账户' + (f.accounts.length ? '（' + f.accounts.length + '）' : ''),
        onclick: () => UI.openAccountFilter()
      })
    ]);
    view.appendChild(filterRow);

    const body = U.el('div', { id: 'listBody' });
    view.appendChild(body);
    UI.renderListBody();
  };

  UI.renderListBody = function () {
    const body = $('#listBody');
    if (!body) return;
    U.clear(body);
    const f = UI.state.list;
    const range = Stats.range(f.period, f.custom);
    const list = Store.query({
      from: range.from, to: range.to,
      types: f.types, q: f.q,
      includeExcluded: !f.hideExcluded,
      includeHidden: f.showHidden,
      categoryIds: f.categoryIds,
      accounts: f.accounts
    });
    const full = Stats.full(list);

    const sumBar = U.el('div', { class: 'card tight', style: { display: 'flex', gap: '14px', fontSize: '12.5px', flexWrap: 'wrap', alignItems: 'center' } }, [
      U.el('span', { html: '收入 <b class="amount income" style="font-size:13px">' + U.esc(U.fmtMoney(full.included.income)) + '</b>' }),
      U.el('span', { html: '支出 <b class="amount expense" style="font-size:13px">' + U.esc(U.fmtMoney(full.included.expense)) + '</b>' }),
      U.el('span', { html: '结余 <b class="amount" style="font-size:13px">' + U.esc(U.fmtMoney(full.included.net)) + '</b>' }),
      U.el('span', { class: 'hint', style: { marginLeft: 'auto' }, text: '共 ' + list.length + ' 条' })
    ]);
    body.appendChild(sumBar);

    if (full.excluded.count) {
      body.appendChild(U.el('p', { class: 'sheet-note', style: { marginTop: '8px' }, text: '已有 ' + full.excluded.count + ' 笔（' + U.fmtMoney(full.excluded.expense + full.excluded.income) + '）标记为不计入统计，未包含在上方合计中。' }));
    }

    body.appendChild(U.el('div', { style: { height: '8px' } }));
    body.appendChild(txGroups(list, { emptyText: '这个范围内没有符合条件的账单' }));
  };

  /* ---------------- 带历史联想的输入框 ----------------
     opts: { field: 'counterparty'|'item', value, placeholder, onChange, onPick } */
  UI.autocompleteField = function (opts) {
    opts = opts || {};
    const field = opts.field || 'counterparty';
    const wrap = U.el('div', { class: 'ac-wrap' });
    const input = U.el('input', {
      class: 'input', type: 'text', autocomplete: 'off',
      placeholder: opts.placeholder || '', value: opts.value || '',
      oninput: () => { if (opts.onChange) opts.onChange(input.value); renderList(); },
      onfocus: () => renderList()
    });
    const listBox = U.el('div', { class: 'ac-list', style: { display: 'none' } });
    wrap.appendChild(input);
    wrap.appendChild(listBox);

    function renderList() {
      const q = input.value.trim();
      const items = Store.suggest(field, q, 6).filter(function (r) { return !q || r.value !== q; });
      U.clear(listBox);
      if (!items.length) { listBox.style.display = 'none'; return; }
      listBox.style.display = '';
      items.forEach(function (r) {
        const cat = Store.commonCategoryFor(field, r.value);
        listBox.appendChild(U.el('div', {
          class: 'ac-item',
          onclick: () => {
            input.value = r.value;
            if (opts.onChange) opts.onChange(r.value);
            listBox.style.display = 'none';
            if (opts.onPick) opts.onPick(r.value, cat);
          }
        }, [
          U.el('span', { class: 'ac-main', text: r.value }),
          cat ? U.el('span', { class: 'ac-sub', text: '常记作 ' + cat.name }) : null,
          U.el('span', { class: 'ac-count', text: r.count + ' 次' })
        ]));
      });
    }

    input.addEventListener('blur', function () {
      setTimeout(function () { listBox.style.display = 'none'; }, 200);
    });

    return { el: wrap, input: input, getValue: function () { return input.value; } };
  };

  /* ---------------- 分类 / 账户 筛选 ---------------- */
  UI.openCategoryFilter = function () {
    const f = UI.state.list;
    const active = new Set(f.categoryIds);
    const cats = Store.categories.slice().sort((a, b) => a.order - b.order);
    const body = U.el('div');
    if (!cats.length) body.appendChild(emptyBox('📂', '还没有分类'));
    cats.forEach((c) => {
      body.appendChild(U.el('div', { class: 'cat-row' }, [
        U.el('div', { class: 'ci', text: c.icon, style: { background: U.hexToRgba(c.color, 0.16) } }),
        U.el('div', { class: 'cn' }, [U.el('b', { text: c.name }), U.el('small', { text: (c.type === 'income' ? '收入' : c.type === 'both' ? '通用' : '支出') + (c.hidden ? ' · 已隐藏' : '') })]),
        U.el('button', {
          class: 'chip' + (active.has(c.id) ? ' is-active' : ''), text: active.has(c.id) ? '已选' : '选择',
          onclick: () => {
            if (active.has(c.id)) active.delete(c.id); else active.add(c.id);
            f.categoryIds = Array.from(active);
            UI.closeSheet(); UI.renderList();
          }
        })
      ]));
    });
    UI.openSheet({
      title: '按分类筛选',
      body: body,
      actions: [
        { label: '清空筛选', onClick: () => { f.categoryIds = []; UI.closeSheet(); UI.renderList(); } },
        { label: '确定', primary: true, onClick: () => { UI.closeSheet(); UI.renderList(); } }
      ]
    });
  };

  UI.openAccountFilter = function () {
    const f = UI.state.list;
    const active = new Set(f.accounts);
    const used = new Set(Store.tx.map((t) => t.account).filter(Boolean));
    const accounts = D.accounts.concat(Array.from(used).filter((a) => D.accounts.indexOf(a) < 0));
    const body = U.el('div', { class: 'chips' });
    accounts.forEach((a) => {
      body.appendChild(U.el('button', {
        class: 'chip' + (active.has(a) ? ' is-active' : ''), text: a,
        onclick: (e) => {
          if (active.has(a)) active.delete(a); else active.add(a);
          e.target.classList.toggle('is-active');
          f.accounts = Array.from(active);
        }
      }));
    });
    UI.openSheet({
      title: '按账户筛选',
      body: body,
      actions: [
        { label: '清空', onClick: () => { f.accounts = []; UI.closeSheet(); UI.renderList(); } },
        { label: '应用', primary: true, onClick: () => { UI.closeSheet(); UI.renderList(); } }
      ]
    });
  };

  /* ---------------- 自定义区间 ---------------- */
  UI.pickCustomRange = function (onDone) {
    const now = new Date();
    const fromField = UI.dateField({ value: U.toISODate(U.addMonths(now, -1)), withTime: false });
    const toField = UI.dateField({ value: U.toISODate(now), withTime: false });
    const body = U.el('div', null, [
      U.el('div', { class: 'field' }, [U.el('label', { text: '开始日期' }), fromField]),
      U.el('div', { class: 'field' }, [U.el('label', { text: '结束日期' }), toField])
    ]);
    UI.openSheet({
      title: '选择日期范围',
      body: body,
      actions: [{
        label: '确定', primary: true, onClick: () => {
          const from = fromField.getValue(), to = toField.getValue();
          if (!from || !to) { UI.toast('请选择完整日期', 'err'); return; }
          if (from > to) { UI.toast('开始日期不能晚于结束日期', 'err'); return; }
          UI.closeSheet();
          onDone({ from: from, to: to });
        }
      }]
    });
  };

  global.UI = UI;
})(window);
/* ============================================================
   ui.js - 界面渲染与交互（第二部分：统计 / 设置）
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U, Store = global.Store, Stats = global.Stats, D = global.DEFAULTS;
  const UI = global.UI;
  const $ = U.$, $$ = U.$$;

  function seg(items, active, onPick) {
    const wrap = U.el('div', { class: 'seg' });
    items.forEach((it) => {
      wrap.appendChild(U.el('button', { class: it.id === active ? 'is-active' : '', text: it.name, onclick: () => onPick(it.id) }));
    });
    return wrap;
  }
  function emptyBox(icon, text) {
    return U.el('div', { class: 'empty' }, [U.el('span', { class: 'big', text: icon }), U.el('span', { text: text })]);
  }

  /* ---------------- 环形图 ---------------- */
  function donut(rows, total, centerLabel) {
    const R = 54, C = 2 * Math.PI * R;
    let acc = 0;
    let inner = '';
    if (!total || !rows.length) {
      inner = '<circle r="' + R + '" cx="66" cy="66" fill="none" stroke="var(--bg-sunken)" stroke-width="16" />';
    } else {
      rows.forEach((r) => {
        const len = (r.amount / total) * C;
        inner += '<circle r="' + R + '" cx="66" cy="66" fill="none" stroke="' + r.color + '" stroke-width="16" ' +
          'stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-acc).toFixed(2) + '" />';
        acc += len;
      });
    }
    const wrap = U.el('div', { class: 'donut' }, [
      U.el('div', { html: '<svg width="132" height="132" viewBox="0 0 132 132">' + inner + '</svg>' }),
      U.el('div', { class: 'center' }, [
        U.el('div', null, [
          U.el('div', { class: 'k', text: centerLabel || '合计' }),
          U.el('div', { class: 'v', text: U.fmtMoney(total || 0) })
        ])
      ])
    ]);
    return wrap;
  }

  /* ---------------- 趋势图 ---------------- */
  /* 走势图。monthly=true 时按月份展示（标签横排），否则按天（标签斜 45 度） */
  function trendChart(buckets, monthly) {
    const BAR_H = 110;
    const max = buckets.reduce((m, b) => Math.max(m, b.expense, b.income), 0) || 1;
    const wrap = U.el('div', { class: 'trend' + (monthly ? '' : ' is-daily') });
    // 标签太密就隔几个显示一个，保证斜排后不会挤在一起
    const step = Math.max(1, Math.ceil(buckets.length / (monthly ? 12 : 10)));

    buckets.forEach((b, i) => {
      const col = U.el('div', {
        class: 'trend-col',
        title: b.label + '　支出 ¥' + b.expense.toFixed(2) + '　收入 ¥' + b.income.toFixed(2)
      });

      const bars = U.el('div', { class: 'trend-bars' });
      bars.appendChild(U.el('div', { class: 'trend-bar', style: { height: Math.max(2, (b.expense / max) * BAR_H) + 'px' } }));
      if (b.income > 0) {
        bars.appendChild(U.el('div', { class: 'trend-bar income', style: { height: Math.max(2, (b.income / max) * BAR_H) + 'px' } }));
      }
      col.appendChild(bars);

      const labels = U.el('div', { class: 'trend-labels' });
      if (i % step === 0) labels.appendChild(U.el('div', { class: 'trend-x', text: b.label }));
      col.appendChild(labels);

      wrap.appendChild(col);
    });
    return wrap;
  }

  /* ---------------- 统计页 ---------------- */
  UI.renderStats = function () {
    const view = $('#view-stats');
    U.clear(view);
    const st = UI.state.stats;
    const range = Stats.range(st.period, st.custom);

    view.appendChild(seg(
      [{ id: 'week', name: '本周' }, { id: 'month', name: '本月' }, { id: 'lastMonth', name: '上月' },
       { id: 'semester', name: '本学期' }, { id: 'year', name: '今年' }, { id: 'all', name: '全部' }, { id: 'custom', name: '自定义' }],
      st.period,
      (id) => {
        if (id === 'custom') { UI.pickCustomRange((r) => { st.custom = r; st.period = 'custom'; UI.renderStats(); }); return; }
        st.period = id; UI.renderStats();
      }
    ));

    const list = Store.query({ from: range.from, to: range.to, includeExcluded: true, includeHidden: true });
    const full = Stats.full(list);
    const inc = full.included;

    view.appendChild(U.el('div', { class: 'card tight', style: { textAlign: 'center', fontSize: '12.5px', color: 'var(--text-faint)' }, text: range.label }));

    view.appendChild(U.el('div', { class: 'stat-grid', style: { marginBottom: '12px' } }, [
      U.el('div', { class: 'stat-card' }, [U.el('div', { class: 'k', text: '收入' }), U.el('div', { class: 'v amount income', text: U.fmtMoney(inc.income) })]),
      U.el('div', { class: 'stat-card' }, [U.el('div', { class: 'k', text: '支出' }), U.el('div', { class: 'v amount expense', text: U.fmtMoney(inc.expense) })]),
      U.el('div', { class: 'stat-card' }, [U.el('div', { class: 'k', text: '结余' }), U.el('div', { class: 'v', text: U.fmtMoney(inc.net) })]),
      U.el('div', { class: 'stat-card' }, [U.el('div', { class: 'k', text: '日均支出' }), U.el('div', { class: 'v', text: U.fmtMoney(Stats.dailyAverage(inc, range)) })])
    ]));

    if (full.excluded.count || full.hidden.count) {
      const bits = [];
      if (full.excluded.count) bits.push('不计入统计 ' + full.excluded.count + ' 笔（' + U.fmtMoney(full.excluded.expense + full.excluded.income) + '）');
      if (full.hidden.count) bits.push('已隐藏 ' + full.hidden.count + ' 笔（' + U.fmtMoney(full.hidden.expense + full.hidden.income) + '）');
      view.appendChild(U.el('div', { class: 'card tight', style: { background: 'var(--warn-soft)', borderColor: 'var(--warn)' } }, [
        U.el('div', { style: { fontSize: '12px', color: 'var(--text-soft)', lineHeight: '1.7' }, text: '已从上方合计中排除：' + bits.join('；') })
      ]));
    }

    /* 导出当前区间的报表 */
    view.appendChild(U.el('div', { class: 'chips', style: { marginBottom: '12px' } }, [
      U.el('button', { class: 'chip', text: '📊 导出 Excel', onclick: () => {
        const R = global.Report;
        const name = R.exportExcel({ list: list, range: range });
        UI.toast('已导出 ' + name, 'ok');
      } }),
      U.el('button', { class: 'chip', text: '🖼 生成图片报告', onclick: () => UI.openExportSheet() })
    ]));

    if (!inc.count) {
      view.appendChild(U.el('div', { class: 'card' }, [emptyBox('📊', '这个区间还没有计入统计的账单')]));
      return;
    }

    /* 分类占比 */
    const typeSeg = U.el('div', { class: 'seg' });
    [{ id: 'expense', name: '支出构成' }, { id: 'income', name: '收入构成' }].forEach((it) => {
      typeSeg.appendChild(U.el('button', {
        class: st.type === it.id ? 'is-active' : '', text: it.name,
        onclick: () => { st.type = it.id; UI.renderStats(); }
      }));
    });
    view.appendChild(typeSeg);

    const byCat = Stats.byCategory(full.parts.included, st.type);
    const catCard = U.el('div', { class: 'card' }, [
      U.el('div', { class: 'card-title' }, [
        U.el('h3', { text: st.type === 'expense' ? '支出分类占比' : '收入分类占比' }),
        U.el('span', { class: 'hint', text: byCat.rows.length + ' 个分类' })
      ])
    ]);
    if (byCat.rows.length) {
      const dw = U.el('div', { class: 'donut-wrap' });
      dw.appendChild(donut(byCat.rows, byCat.total, st.type === 'expense' ? '总支出' : '总收入'));
      const legend = U.el('div', { class: 'legend' });
      byCat.rows.slice(0, 10).forEach((r) => {
        legend.appendChild(U.el('div', { class: 'legend-item' }, [
          U.el('span', { class: 'legend-swatch', style: { background: r.color } }),
          U.el('span', { text: r.icon + ' ' + r.name }),
          U.el('span', { class: 'lv', text: U.fmtMoney(r.amount) + ' · ' + r.pct.toFixed(0) + '%' })
        ]));
      });
      dw.appendChild(legend);
      catCard.appendChild(dw);
    } else {
      catCard.appendChild(emptyBox('🍃', '暂无数据'));
    }
    view.appendChild(catCard);

    /* 趋势 */
    const trend = Stats.trend(full.parts.included, range);
    const trendCard = U.el('div', { class: 'card' }, [
      U.el('div', { class: 'card-title' }, [
        U.el('h3', { text: trend.useMonth ? '每月走势' : '每日走势' }),
        U.el('span', { class: 'hint', style: { display: 'flex', gap: '10px' } , html: '<span style="color:var(--expense)">■ 支出</span><span style="color:var(--income)">■ 收入</span>' })
      ])
    ]);
    trendCard.appendChild(trendChart(trend.buckets, trend.useMonth));
    view.appendChild(trendCard);

    /* 来源排行 */
    const src = Stats.byCounterparty(full.parts.included, 'expense', 10);
    if (src.length) {
      const c = U.el('div', { class: 'card' }, [U.el('div', { class: 'card-title' }, [U.el('h3', { text: '支出 TOP 来源' })])]);
      const bars = U.el('div', { class: 'bars' });
      const max = src[0].amount || 1;
      src.forEach((r) => {
        bars.appendChild(U.el('div', { class: 'bar-item' }, [
          U.el('span', { class: 'bl', text: r.name, title: r.name }),
          U.el('div', { class: 'bar-track' }, [U.el('div', { class: 'bar-fill', style: { width: Math.max(2, (r.amount / max) * 100) + '%', background: 'var(--expense)' } })]),
          U.el('span', { class: 'bv', text: U.fmtMoney(r.amount) })
        ]));
      });
      c.appendChild(bars);
      view.appendChild(c);
    }

    /* 账户分布 */
    const acc = Stats.byAccount(full.parts.included, 'expense');
    if (acc.length) {
      const c = U.el('div', { class: 'card' }, [U.el('div', { class: 'card-title' }, [U.el('h3', { text: '支出账户分布' })])]);
      const bars = U.el('div', { class: 'bars' });
      const max = acc[0].amount || 1;
      acc.forEach((r) => {
        bars.appendChild(U.el('div', { class: 'bar-item' }, [
          U.el('span', { class: 'bl', text: r.name }),
          U.el('div', { class: 'bar-track' }, [U.el('div', { class: 'bar-fill', style: { width: Math.max(2, (r.amount / max) * 100) + '%', background: 'var(--primary)' } })]),
          U.el('span', { class: 'bv', text: U.fmtMoney(r.amount) })
        ]));
      });
      c.appendChild(bars);
      view.appendChild(c);
    }
  };

  /* ---------------- 内置 AI 助手 ---------------- */
  UI.openAiSheet = function (opts) {
    opts = opts || {};
    const AI = global.AI;
    if (!AI) { UI.toast('AI 模块没有加载', 'err'); return; }
    AI.load();

    let showConfig = !!opts.focusConfig || !AI.available();
    let busy = false;
    let resolved = [];

    const body = U.el('div');
    const configBox = U.el('div');
    const logBox = U.el('div', { class: 'ai-log' });
    const pendingBox = U.el('div');
    const noteBox = U.el('div', { class: 'sheet-note', style: { margin: '10px 0 0' } });
    const input = U.el('input', {
      class: 'input', placeholder: '例如：把杭州深度求索的充值都改成「数码」',
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }
    });
    const sendBtn = U.el('button', { class: 'btn btn-primary', text: '问 AI', onclick: () => send() });
    const epInput = U.el('input', { class: 'input', value: AI.config.endpoint || '', placeholder: 'https://api.deepseek.com' });
    const keyInput = U.el('input', { class: 'input', type: 'password', value: AI.config.apiKey || '', placeholder: 'sk-...' });
    const modelInput = U.el('input', { class: 'input', value: AI.config.model || 'deepseek-chat', placeholder: 'deepseek-chat' });

    function say(msg, kind) {
      noteBox.textContent = msg || '';
      noteBox.style.color = kind === 'err' ? 'var(--expense)' : (kind === 'ok' ? 'var(--income)' : '');
    }

    function renderSend() { sendBtn.disabled = busy; sendBtn.textContent = busy ? '思考中…' : '问 AI'; }

    function renderConfig() {
      U.clear(configBox);
      if (!showConfig) {
        configBox.appendChild(U.el('div', { class: 'ai-cfg-line' }, [
          U.el('span', { text: '接口：' + (AI.config.endpoint || '未填') + '　模型：' + (AI.config.model || '未填') }),
          U.el('button', { class: 'btn btn-sm', text: '修改', onclick: () => { showConfig = true; renderConfig(); } })
        ]));
        return;
      }
      configBox.appendChild(U.el('div', { class: 'card tight', style: { marginBottom: '10px' } }, [
        U.el('div', { class: 'field' }, [U.el('label', { text: '接口地址' }), epInput]),
        U.el('div', { class: 'field' }, [U.el('label', { text: 'API 密钥' }), keyInput]),
        U.el('div', { class: 'field' }, [U.el('label', { text: '模型名称' }), modelInput]),
        U.el('button', {
          class: 'btn btn-sm btn-primary btn-block', text: '保存',
          onclick: () => {
            AI.config.endpoint = String(epInput.value || '').trim();
            AI.config.apiKey = String(keyInput.value || '').trim();
            AI.config.model = String(modelInput.value || '').trim();
            AI.save();
            showConfig = !AI.available();
            renderConfig();
            say(AI.available() ? '已保存，可以开始提问了' : '接口地址、密钥、模型都要填', AI.available() ? 'ok' : 'err');
          }
        })
      ]));
    }

    function bubble(role, text) {
      logBox.appendChild(U.el('div', { class: 'ai-msg ' + role }, [U.el('div', { class: 'ai-text', text: text })]));
    }

    function renderPending() {
      U.clear(pendingBox);
      if (!resolved.length) return;
      pendingBox.appendChild(U.el('div', { class: 'ai-pending-title', text: '待确认的改动（' + resolved.length + '）' }));
      resolved.forEach((r) => {
        const card = U.el('div', { class: 'ai-pending' + (r.ok ? '' : ' bad') });
        card.appendChild(U.el('div', { class: 'ap-title', text: r.title }));
        const why = r.reason || r.desc;
        if (why) card.appendChild(U.el('div', { class: 'ap-desc', text: why }));
        if (r.ok && r.count) card.appendChild(U.el('div', { class: 'ap-count', text: '会影响 ' + r.count + ' 条账目' }));
        if (r.sample && r.sample.length) card.appendChild(U.el('div', { class: 'ap-sample', text: r.sample.join('　') }));
        if (r.ok) {
          card.appendChild(U.el('button', {
            class: 'btn btn-sm btn-primary', text: r.done ? '已执行' : '执行这一项', disabled: !!r.done,
            onclick: async (e) => {
              e.target.disabled = true;
              const out = await AI.execute([r]);
              const one = out[0] || {};
              UI.toast(one.msg || '已完成', one.ok ? 'ok' : 'err');
              r.done = true;
              renderPending();
              UI.renderSettings();
            }
          }));
        }
        pendingBox.appendChild(card);
      });
      const todo = resolved.filter((r) => r.ok && !r.done);
      if (todo.length > 1) {
        pendingBox.appendChild(U.el('button', {
          class: 'btn btn-primary btn-block', style: { marginTop: '10px' }, text: '全部执行（' + todo.length + ' 项）',
          onclick: async (e) => {
            e.target.disabled = true;
            const out = await AI.execute(todo);
            const okN = out.filter((o) => o.ok).length;
            UI.toast('完成 ' + okN + ' / ' + out.length + ' 项', okN === out.length ? 'ok' : 'err');
            todo.forEach((r) => { r.done = true; });
            renderPending();
            UI.renderSettings();
          }
        }));
      }
    }

    async function send() {
      const text = String(input.value || '').trim();
      if (!text || busy) return;
      if (!AI.available()) { showConfig = true; renderConfig(); say('请先填写 AI 接口、密钥和模型', 'err'); return; }
      input.value = '';
      bubble('me', text);
      busy = true; renderSend();
      const wait = U.el('div', { class: 'ai-msg ai' }, [U.el('div', { class: 'ai-text', text: '正在思考…' })]);
      logBox.appendChild(wait);
      try {
        const parsed = await AI.ask(text);
        wait.remove();
        bubble('ai', parsed.reply || '（AI 没有给出说明）');
        resolved = AI.resolve(parsed.actions || []);
        say(resolved.length ? 'AI 想改动 ' + resolved.length + ' 项，确认之后才会生效' : '');
      } catch (e) {
        wait.remove();
        bubble('err', (e && e.message) ? e.message : '出错了');
      } finally {
        busy = false; renderSend(); renderPending();
      }
    }

    renderConfig();
    renderSend();
    say(AI.available() ? '' : '第一次使用：先把 AI 接口地址、密钥、模型填好并保存');

    body.appendChild(configBox);
    body.appendChild(logBox);
    body.appendChild(pendingBox);
    body.appendChild(U.el('div', { class: 'ai-input-row' }, [input, sendBtn]));
    body.appendChild(noteBox);
    body.appendChild(U.el('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } }, [
      U.el('button', { class: 'btn btn-sm', text: '清空对话', onclick: () => { AI.reset(); U.clear(logBox); resolved = []; renderPending(); say('对话已清空'); } }),
      U.el('button', { class: 'btn btn-sm', text: '关闭', onclick: () => UI.closeSheet() })
    ]));

    UI.openSheet({ title: '内置 AI 助手', body: body, note: 'AI 只给出建议，改动要你点确认才写入；密钥只保存在本机。' });
  };

  /* ---------------- 设置页 ---------------- */
  UI.renderSettings = function () {
    const view = $('#view-settings');
    U.clear(view);

    const pending = Store.pendingReimburse();
    const usage = Stats.categoryUsage();

    /* 分类 */
    const catCard = U.el('div', { class: 'card' }, [
      U.el('div', { class: 'card-title' }, [
        U.el('h3', { text: '账单分类' }),
        U.el('span', { class: 'hint', text: Store.categories.length + ' 个' })
      ]),
      U.el('div', { class: 'stat-grid', style: { marginBottom: '10px' } }, [
        U.el('div', { class: 'stat-card' }, [U.el('div', { class: 'k', text: '支出分类' }), U.el('div', { class: 'v small', text: Store.allCategoriesFor('expense').length + ' 个' })]),
        U.el('div', { class: 'stat-card' }, [U.el('div', { class: 'k', text: '收入分类' }), U.el('div', { class: 'v small', text: Store.allCategoriesFor('income').length + ' 个' })])
      ]),
      U.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
        U.el('button', { class: 'btn btn-sm btn-primary', text: '管理支出分类', onclick: () => UI.openCategoryManager('expense') }),
        U.el('button', { class: 'btn btn-sm', text: '管理收入分类', onclick: () => UI.openCategoryManager('income') }),
        U.el('button', { class: 'btn btn-sm', text: '套用预设包', onclick: () => UI.openPackSheet() })
      ]),
      U.el('div', { class: 'sheet-note', text: '分类可以自定义名称、图标、颜色，也可以整类隐藏，或设为默认不计入统计（例如「报销」类）。' })
    ]);
    view.appendChild(catCard);

    /* 报销与排除 */
    view.appendChild(U.el('div', { class: 'card' }, [
      U.el('div', { class: 'card-title' }, [U.el('h3', { text: '报销与「不计入统计」' }), U.el('span', { class: 'hint', text: pending.length + ' 笔待报销' })]),
      U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)', lineHeight: '1.8' } ,
        text: '把爸爸妈妈或同学报销、代付、借还款、账户互转的账单标记为「不计入统计」后，它们不会进入任何周/月/学期合计，但仍完整保留在明细里。' }),
      U.el('div', { style: { marginTop: '10px' } }, [
        U.el('button', {
          class: 'btn btn-sm', text: pending.length ? '查看待报销（' + pending.length + '）' : '查看报销记录',
          onclick: () => {
            UI.state.list = Object.assign(UI.state.list, { period: 'all', types: ['expense', 'income'], showHidden: true, categoryIds: [], accounts: [] });
            UI.go('list');
          }
        })
      ])
    ]));

    /* 学期 */
    const sem = Store.activeSemester();
    view.appendChild(U.el('div', { class: 'card' }, [
      U.el('div', { class: 'card-title' }, [U.el('h3', { text: '学期设置' }), U.el('span', { class: 'hint', text: Store.semesters().length + ' 个学期' })]),
      U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)' }, text: sem ? '当前学期：' + sem.name + '（' + sem.start + ' ~ ' + sem.end + '）' : '尚未设置学期' }),
      U.el('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } }, [
        U.el('button', { class: 'btn btn-sm', text: '管理学期', onclick: () => UI.openSemesterSheet() }),
        U.el('button', { class: 'btn btn-sm', text: '周起始日：' + (Store.settings.weekStart === 0 ? '周日' : '周一'), onclick: async () => { await Store.updateSettings({ weekStart: Store.settings.weekStart === 0 ? 1 : 0 }); UI.renderSettings(); } })
      ])
    ]));

    /* 导入导出 */
    view.appendChild(U.el('div', { class: 'card' }, [
      U.el('div', { class: 'card-title' }, [U.el('h3', { text: '账单导入 / 导出' })]),
      U.el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } }, [
        U.el('button', { class: 'btn btn-sm btn-primary', text: '导入微信/支付宝账单', onclick: () => UI.openImportSheet() }),
        U.el('button', { class: 'btn btn-sm', text: '导出 CSV', onclick: () => { U.download('记账明细-' + U.todayISO() + '.csv', Store.exportCSV(), 'text/csv;charset=utf-8'); UI.toast('已导出 CSV'); } }),
        U.el('button', { class: 'btn btn-sm', text: '导出备份 JSON', onclick: () => { U.download('记账备份-' + U.todayISO() + '.json', Store.exportJSON(), 'application/json'); UI.toast('已导出备份'); } }),
        U.el('button', { class: 'btn btn-sm', text: '从备份恢复', onclick: () => UI.openRestoreSheet() })
      ]),
      U.el('p', { class: 'sheet-note', text: '自动分类规则：内置 ' + D.builtinRules.length + ' 组关键词，自定义 ' + (Store.settings.rules || []).length + ' 条。' }),
      U.el('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } }, [
        U.el('button', { class: 'btn btn-sm', text: '管理自动分类规则', onclick: () => UI.openRulesSheet() })
      ])
    ]));

    /* 显示与主题 */
    view.appendChild(U.el('div', { class: 'card' }, [
      U.el('div', { class: 'card-title' }, [U.el('h3', { text: '显示与偏好' })]),
      U.el('div', { class: 'switch-row' }, [
        U.el('div', { class: 'sr-body' }, [U.el('div', { class: 'sr-title', text: '明细默认不显示「不计入统计」的账单' }), U.el('div', { class: 'sr-desc', text: '开启后，报销、代付等账单默认从明细列表里藏起来（在明细页也能随时切换）' })]),
        U.el('button', { class: 'switch' + (Store.settings.hideExcludedInList ? ' is-on' : ''), onclick: async (e) => { await Store.updateSettings({ hideExcludedInList: !Store.settings.hideExcludedInList }); e.target.classList.toggle('is-on'); UI.state.list.hideExcluded = Store.settings.hideExcludedInList; } })
      ]),
      U.el('div', { class: 'switch-row' }, [
        U.el('div', { class: 'sr-body' }, [U.el('div', { class: 'sr-title', text: '导入时自动分类' }), U.el('div', { class: 'sr-desc', text: '根据商家名和商品关键词自动归类' })]),
        U.el('button', { class: 'switch' + (Store.settings.autoClassifyOnImport ? ' is-on' : ''), onclick: async (e) => { await Store.updateSettings({ autoClassifyOnImport: !Store.settings.autoClassifyOnImport }); e.target.classList.toggle('is-on'); } })
      ]),
      U.el('div', { class: 'switch-row' }, [
        U.el('div', { class: 'sr-body' }, [U.el('div', { class: 'sr-title', text: '导入时自动去重' }), U.el('div', { class: 'sr-desc', text: '按交易单号识别已经导入过的账单' })]),
        U.el('button', { class: 'switch' + (Store.settings.dedupeOnImport ? ' is-on' : ''), onclick: async (e) => { await Store.updateSettings({ dedupeOnImport: !Store.settings.dedupeOnImport }); e.target.classList.toggle('is-on'); } })
      ]),
      (function () {
        const seg = U.el('div', { class: 'seg', style: { marginBottom: '0' } });
        [{ v: 'auto', n: '跟随系统' }, { v: 'light', n: '浅色' }, { v: 'dark', n: '深色' }].forEach(function (o) {
          seg.appendChild(U.el('button', {
            class: (Store.settings.theme || 'auto') === o.v ? 'is-active' : '',
            text: o.n,
            onclick: async function () {
              await Store.updateSettings({ theme: o.v });
              UI.applyTheme();
              Array.prototype.forEach.call(seg.children, function (b) {
                b.classList.toggle('is-active', b.textContent === o.n);
              });
            }
          }));
        });
        return U.el('div', { class: 'field' }, [
          U.el('label', { text: '外观主题' }),
          seg,
          U.el('div', { class: 'sheet-note', style: { margin: '6px 0 0' }, text: '选「跟随系统」时，手机切到深色模式应用也会跟着变' })
        ]);
      })()
    ]));

    /* 数据 */
    view.appendChild(U.el('div', { class: 'card' }, [
      U.el('div', { class: 'card-title' }, [U.el('h3', { text: '数据与存储' })]),
      U.el('div', { class: 'stat-grid three' }, [
        U.el('div', { class: 'stat-card' }, [U.el('div', { class: 'k', text: '账目总数' }), U.el('div', { class: 'v small', text: String(Store.tx.length) })]),
        U.el('div', { class: 'stat-card' }, [U.el('div', { class: 'k', text: '分类数' }), U.el('div', { class: 'v small', text: String(Store.categories.length) })]),
        U.el('div', { class: 'stat-card' }, [U.el('div', { class: 'k', text: '存储方式' }), U.el('div', { class: 'v small', text: global.DB.mode() === 'idb' ? 'IndexedDB' : 'localStorage' })])
      ]),
      U.el('div', { style: { display: 'flex', gap: '8px', marginTop: '12px' } }, [
        U.el('button', { class: 'btn btn-sm', style: { flex: '1 1 0%' }, text: '清理重复数据', onclick: () => UI.openCleanupSheet() }),
        U.el('button', { class: 'btn btn-sm', style: { flex: '1 1 0%' }, text: '分级清理数据', onclick: () => UI.openClearDataSheet() })
      ])
    ]));

    /* 导出报表 */
    view.appendChild(U.el('div', { class: 'card' }, [
      U.el('div', { class: 'card-title' }, [U.el('h3', { text: '导出报表给家人看' })]),
      U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)', lineHeight: '1.8', margin: '0 0 10px' },
        text: '导出 Excel 表格（含明细、分类汇总、周期汇总），或生成一张收支报告图片，直接发微信给爸妈看。' }),
      U.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
        U.el('button', { class: 'btn btn-sm btn-primary', text: '导出报表', onclick: () => UI.openExportSheet() })
      ])
    ]));

    /* 自动备份 */
    if (global.Backup) {
      const bk = global.Backup;
      const bkCard = U.el('div', { class: 'card' });
      bkCard.appendChild(U.el('div', { class: 'card-title' }, [
        U.el('h3', { text: '自动备份' }),
        U.el('span', { class: 'hint', text: Store.settings.autoBackup !== false ? '已开启' : '已关闭' })
      ]));
      bkCard.appendChild(U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)', lineHeight: '1.8', margin: '0 0 10px' }, text:
        '自动把整份数据在本机存一份快照，随时可以还原到某个时间点。' +
        (global.AndroidApp ? '安卓版还会同时把备份文件写进手机的「下载」目录。' : '电脑上运行的服务也会自动在 backups 目录留档。') }));
      bkCard.appendChild(U.el('div', { style: { fontSize: '12.5px', color: 'var(--text-soft)', marginBottom: '10px' }, text:
        '上次备份：' + (bk.lastAt() ? bk.timeText(bk.lastAt()) : '还没有备份过') }));
      bkCard.appendChild(U.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
        U.el('button', { class: 'btn btn-sm btn-primary', text: '立即备份', onclick: async (e) => {
          e.target.disabled = true;
          try {
            const info = await bk.run(true);
            UI.toast(info ? '已备份 ' + info.txCount + ' 条账目' : '没有可备份的数据', info ? 'ok' : '');
          } catch (err) { UI.toast('备份失败：' + err.message, 'err'); }
          e.target.disabled = false;
          UI.renderSettings();
        } }),
        U.el('button', { class: 'btn btn-sm', text: '备份管理', onclick: () => UI.openBackupSheet() })
      ]));
      view.appendChild(bkCard);
    }

    /* 与电脑同步 */
    const Sync = global.Sync;
    if (Sync) {
      const syncCard = U.el('div', { class: 'card' });
      syncCard.appendChild(U.el('div', { class: 'card-title' }, [
        U.el('h3', { text: Sync.isApp() ? '与电脑同步' : '与手机同步' }),
        U.el('span', { class: 'hint', text: Sync.statusText() })
      ]));

      const desc = Sync.isApp()
        ? (Sync.config.url
          ? '已连接电脑：' + Sync.config.url
          : '还没有填写电脑地址。填好之后，手机不用打开浏览器就能把账目同步到电脑，也能把电脑上的账目取回来。')
        : '这个页面由电脑上的服务提供，可以直接同步：两边都会自动比较每一条的修改时间，把新的那一份保留下来。';
      syncCard.appendChild(U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)', lineHeight: '1.8', margin: '0 0 8px' }, text: desc }));

      syncCard.appendChild(U.el('div', { style: { fontSize: '12.5px', color: 'var(--text-soft)', lineHeight: '1.9' }, html:
        '上次同步：<b>' + U.esc(Sync.lastSyncText()) + '</b>' +
        (Sync.config.lastResult ? '　上传 ' + Sync.config.lastResult.pushed + ' 项 / 下载 ' + Sync.config.lastResult.pulled + ' 项' : '') +
        '<br>本机名称：<b>' + U.esc(Sync.config.deviceName || Sync.guessDeviceName()) + '</b>' }));

      syncCard.appendChild(U.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' } }, [
        U.el('button', {
          class: 'btn btn-sm btn-primary', text: '立即同步',
          onclick: async (e) => {
            const btn = e.target;
            if (btn.disabled) return;
            btn.disabled = true;
            btn.textContent = '同步中…';
            // 按钮上直接显示百分比，点完就能看到做到哪一步了
            const tick = setInterval(function () {
              if (!btn.isConnected) return;
              btn.textContent = Sync.progress.running
                ? '同步中 ' + Sync.progress.percent + '%'
                : '同步中…';
            }, 200);
            try {
              const r = await Sync.sync();
              if (r) UI.toast('同步完成：上传 ' + r.pushed + ' 项，下载 ' + r.pulled + ' 项', 'ok');
              else UI.toast('同步正在进行中，请稍候', '');
            } catch (err) {
              UI.toast('同步失败：' + err.message, 'err');
            } finally {
              // 不管成功还是失败都要恢复按钮，绝不留在「同步中」点不动
              clearInterval(tick);
              if (btn.isConnected) { btn.disabled = false; btn.textContent = '立即同步'; }
              UI.renderSettings();
            }
          }
        }),
        U.el('button', { class: 'btn btn-sm', text: '同步设置 / 看进度', onclick: () => UI.openSyncSheet() })
      ]));
      view.appendChild(syncCard);
    }

    /* 内置 AI 助手 */
    if (global.AI) {
      const AI = global.AI;
      view.appendChild(U.el('div', { class: 'card' }, [
        U.el('div', { class: 'card-title' }, [
          U.el('h3', { text: '内置 AI 助手' }),
          U.el('span', { class: 'hint', text: AI.available() ? '已配置' : '未配置' })
        ]),
        U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)', lineHeight: '1.8', margin: '0 0 10px' },
          text: '填一个 AI 接口（例如 DeepSeek），就能用说话的方式批量整理账目：「把杭州深度求索的充值从其他改成数码」。AI 只给建议，改不改由你点确认。' }),
        U.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
          U.el('button', { class: 'btn btn-sm btn-primary', text: '打开 AI 助手', onclick: () => UI.openAiSheet() }),
          U.el('button', { class: 'btn btn-sm', text: 'AI 接口设置', onclick: () => UI.openAiSheet({ focusConfig: true }) })
        ]),
        U.el('div', { class: 'sheet-note', text: '接口地址和密钥只保存在这台设备上；发给 AI 的只有分类与来源的统计概况，不会上传每笔账目。' })
      ]));
    }

    /* 关于 */
    view.appendChild(U.el('div', { class: 'card' }, [
      U.el('div', { class: 'card-title' }, [U.el('h3', { text: '关于' })]),
      U.el('div', { class: 'sheet-note', style: { marginTop: '0' }, html:
        '大学生活记账本 v' + (D.APP_VERSION || '2.0.0') + '<br>' +
        '纯离线单文件应用，数据只保存在你自己的设备上，不联网、不上传。<br>' +
        '手机：浏览器打开后「添加到主屏幕」，即可像 App 一样使用；<br>' +
        '电脑：双击项目里的「启动记账本.bat」即可打开。' }),
      U.el('div', { class: 'sheet-note', style: { marginTop: '8px', fontSize: '11px', opacity: '.75' }, text: UI.screenInfoText() })
    ]));
  };

  global.UI = UI;
})(window);
/* ============================================================
   ui.js - 界面渲染与交互（第三部分：记账表单 / 详情 / 报销 / 分类 / 学期 / 规则）
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U, Store = global.Store, Stats = global.Stats, D = global.DEFAULTS;
  const UI = global.UI;
  const $ = U.$, $$ = U.$$;

  const EMOJIS = ['🍚', '🍜', '🍔', '🧋', '☕', '🍎', '🚌', '🚇', '🚕', '🚲', '✈️', '🚗',
    '📚', '✏️', '🎓', '🖨️', '🛍️', '👕', '👟', '💄', '🎮', '🎬', '🎧', '🎤',
    '🏠', '🛏️', '💡', '💧', '🧴', '🧻', '💊', '🏥', '📱', '🌐', '💻', '⌨️',
    '🎁', '🧧', '💐', '🏀', '⚽', '🏊', '🧘', '🐱', '🐶', '🎫', '🏆', '💰',
    '💵', '💼', '↩️', '↪️', '📦', '🏷️', '🔁', '💪', '🧖', '🍺', '🔌', '🚿'];

  /* ---------------- 记账表单 ---------------- */
  /* tx 为空表示新增；defaults 可预设类型 */
  UI.openTxSheet = function (tx, defaults) {
    const isEdit = !!tx;
    const model = {
      type: tx ? tx.type : ((defaults && defaults.type) || 'expense'),
      amount: tx ? tx.amount : '',
      time: tx ? U.toISODateTimeLocal(tx.time) : U.toISODateTimeLocal(new Date()),
      categoryId: tx ? tx.categoryId : '',
      counterparty: tx ? tx.counterparty : '',
      item: tx ? tx.item : '',
      account: tx ? tx.account : (Store.settings.lastAccount || ''),
      note: tx ? tx.note : '',
      excludeStat: tx ? tx.excludeStat : false,
      excludeReason: tx ? tx.excludeReason : '',
      hidden: tx ? tx.hidden : false
    };
    if (!isEdit) {
      const cats = Store.categoriesFor(model.type, false);
      if (cats.length) model.categoryId = cats[0].id;
    }

    const amountInput = U.el('input', {
      type: 'text', inputmode: 'decimal', placeholder: '0.00', value: model.amount === '' ? '' : String(model.amount),
      oninput: (e) => { model.amount = e.target.value; }
    });
    const amountBox = U.el('div', { class: 'amount-input' }, [U.el('span', { class: 'cur', text: '¥' }), amountInput]);

    const typeToggle = U.el('div', { class: 'seg-toggle' });
    ['expense', 'income'].forEach((tp) => {
      typeToggle.appendChild(U.el('button', {
        class: (model.type === tp ? 'is-active' : ''), 'data-type': tp, text: tp === 'expense' ? '支出' : '收入',
        onclick: () => {
          model.type = tp;
          $$('.seg-toggle button', typeToggle).forEach((b) => b.classList.toggle('is-active', b.dataset.type === tp));
          const cats = Store.categoriesFor(tp, false);
          if (!cats.find((c) => c.id === model.categoryId)) model.categoryId = cats.length ? cats[0].id : '';
          renderCatGrid();
        }
      }));
    });

    const catGrid = U.el('div', { class: 'cat-grid', id: 'txCatGrid' });

    /* 用户如果手动点过分类，就不再自动改；否则套用历史来源的常用分类 */
    let categoryTouched = false;

    const srcField = UI.autocompleteField({
      field: 'counterparty', value: model.counterparty,
      placeholder: '例如：食堂、美团、爸爸',
      onChange: (v) => { model.counterparty = v; },
      onPick: (v, cat) => {
        model.counterparty = v;
        if (cat && !categoryTouched) {
          const c = Store.categories.find((x) => x.name === cat.name);
          if (c) { model.categoryId = c.id; renderCatGrid(); }
        }
      }
    });

    const itemField = UI.autocompleteField({
      field: 'item', value: model.item,
      placeholder: '例如：午餐、教材费、地铁',
      onChange: (v) => { model.item = v; }
    });

    function renderCatGrid() {
      U.clear(catGrid);
      const cats = Store.categoriesFor(model.type, false);
      if (!cats.length) {
        catGrid.appendChild(U.el('p', { class: 'sheet-note', text: '还没有分类，请先到「设置 → 账单分类」添加。' }));
        return;
      }
      cats.forEach((c) => {
        catGrid.appendChild(U.el('button', {
          class: 'cat-pick' + (c.id === model.categoryId ? ' is-active' : ''),
          onclick: () => { categoryTouched = true; model.categoryId = c.id; renderCatGrid(); }
        }, [
          U.el('span', { class: 'ci', text: c.icon }),
          U.el('span', { class: 'cn', text: c.name })
        ]));
      });
    }
    renderCatGrid();

    const accountSel = U.el('select', { class: 'select', onchange: (e) => { model.account = e.target.value; } });
    ['', ...D.accounts].forEach((a) => {
      accountSel.appendChild(U.el('option', { value: a, text: a || '不指定', selected: a === model.account }));
    });

    const reasonSel = U.el('select', {
      class: 'select', onchange: (e) => { model.excludeReason = e.target.value; }
    });
    D.excludeReasons.forEach((r) => {
      reasonSel.appendChild(U.el('option', { value: r.name, text: r.name + ' — ' + r.desc, selected: r.name === model.excludeReason }));
    });

    const excludeSwitch = U.el('button', {
      class: 'switch' + (model.excludeStat ? ' is-on' : ''),
      onclick: (e) => {
        model.excludeStat = !model.excludeStat;
        e.target.classList.toggle('is-on');
        reasonWrap.style.display = model.excludeStat ? '' : 'none';
        if (model.excludeStat && !model.excludeReason) { model.excludeReason = '报销'; reasonSel.value = '报销'; }
      }
    });
    const reasonWrap = U.el('div', { class: 'field', style: { display: model.excludeStat ? '' : 'none' } }, [
      U.el('label', { text: '排除原因' }), reasonSel
    ]);

    const hideSwitch = U.el('button', {
      class: 'switch' + (model.hidden ? ' is-on' : ''),
      onclick: (e) => { model.hidden = !model.hidden; e.target.classList.toggle('is-on'); }
    });

    const body = U.el('div', null, [
      typeToggle,
      U.el('div', { style: { margin: '16px 0 6px', textAlign: 'center' } }, [amountBox]),

      U.el('div', { class: 'field' }, [U.el('label', { text: '分类' }), catGrid]),

      U.el('div', { class: 'row row-split' }, [
        U.el('div', { class: 'field' }, [U.el('label', { text: '时间' }), UI.dateField({ value: model.time, withTime: true, onChange: (v) => { model.time = v; } })]),
        U.el('div', { class: 'field' }, [U.el('label', { text: '账户' }), accountSel])
      ]),

      U.el('div', { class: 'field' }, [
        U.el('label', { text: '来源（交易对方 / 商家）' }),
        srcField.el,
        U.el('div', { class: 'sheet-note', style: { margin: '4px 0 0' }, text: '输入几个字就会列出以前填过的来源，点一下即可套用' })
      ]),
      U.el('div', { class: 'field' }, [
        U.el('label', { text: '用途（买了什么 / 做什么）' }),
        itemField.el
      ]),
      U.el('div', { class: 'field' }, [
        U.el('label', { text: '备注' }),
        U.el('textarea', { class: 'textarea', placeholder: '可留空', oninput: (e) => { model.note = e.target.value; } }, [document.createTextNode(model.note)])
      ]),

      U.el('div', { class: 'switch-row' }, [
        U.el('div', { class: 'sr-body' }, [
          U.el('div', { class: 'sr-title', text: '不计入统计' }),
          U.el('div', { class: 'sr-desc', text: '报销、代付、借还款、账户互转等，保留记录但不算进任何合计' })
        ]),
        excludeSwitch
      ]),
      reasonWrap,
      U.el('div', { class: 'switch-row' }, [
        U.el('div', { class: 'sr-body' }, [
          U.el('div', { class: 'sr-title', text: '隐藏这笔账单' }),
          U.el('div', { class: 'sr-desc', text: '默认不在明细中显示（可在明细页打开「显示已隐藏账单」查看）' })
        ]),
        hideSwitch
      ])
    ]);

    const actions = [{
      label: '保存', primary: true, onClick: async () => {
        const amt = U.parseAmount(model.amount);
        if (!amt) { UI.toast('请填写金额', 'err'); amountInput.focus(); return; }
        const cat = Store.getCategory(model.categoryId);
        const payload = {
          type: model.type,
          amount: amt,
          time: U.fromISO(model.time).getTime(),
          categoryId: model.categoryId,
          categoryName: cat ? cat.name : '',
          account: model.account,
          counterparty: model.counterparty.trim(),
          item: model.item.trim(),
          note: model.note.trim(),
          excludeStat: model.excludeStat,
          excludeReason: model.excludeStat ? (model.excludeReason || '不计收支') : '',
          hidden: model.hidden
        };
        if (model.account) await Store.updateSettings({ lastAccount: model.account });
        if (isEdit) {
          if (tx.reimburseStatus) payload.reimburseStatus = tx.reimburseStatus;
          await Store.updateTx(tx.id, payload);
          UI.toast('已保存修改', 'ok');
        } else {
          await Store.addTx(payload);
          UI.toast('记账成功', 'ok');
        }
        UI.closeSheet();
      }
    }, { label: '取消', onClick: () => UI.closeSheet() }];

    UI.openSheet({ title: isEdit ? '编辑账单' : '记一笔', body: body, actions: actions });
    // 触屏设备不自动弹出键盘，避免遮挡表单
    const isTouch = !!(global.matchMedia && matchMedia('(hover: none)').matches);
    setTimeout(() => { if (!isEdit && !isTouch) amountInput.focus({ preventScroll: true }); }, 320);
  };

  /* ---------------- 账单详情 ---------------- */
  UI.openTxDetail = function (tx) {
    const cat = tx.categoryId ? Store.getCategory(tx.categoryId) : null;
    const rows = [];
    const addRow = (k, v) => { if (v) rows.push(U.el('div', { class: 'switch-row' }, [U.el('div', { class: 'sr-body' }, [U.el('div', { class: 'sr-title', text: k })]), U.el('div', { style: { textAlign: 'right', fontSize: '13.5px', color: 'var(--text-soft)' }, text: v })])); };

    addRow('类型', tx.type === 'income' ? '收入' : '支出');
    addRow('分类', (cat ? cat.icon + ' ' : '') + (tx.categoryName || '未分类'));
    addRow('来源（交易对方）', tx.counterparty || '—');
    addRow('用途（事项）', tx.item || '—');
    addRow('账户', tx.account || '—');
    addRow('时间', U.fmtDateTime(tx.time));
    addRow('备注', tx.note || '—');
    if (tx.tags.length) addRow('标签', tx.tags.join('、'));
    addRow('统计', tx.excludeStat ? '不计入（' + (tx.excludeReason || '未注明') + '）' : '计入统计');
    if (tx.reimburseStatus) addRow('报销状态', tx.reimburseStatus === 'pending' ? '待报销' : '已报销');
    if (tx.source && tx.source !== 'manual') addRow('导入来源', { wechat: '微信支付账单', alipay: '支付宝账单', import: '账单导入' }[tx.source] || tx.source);
    if (tx.externalId) addRow('交易单号', tx.externalId);

    const head = U.el('div', { style: { textAlign: 'center', margin: '4px 0 14px' } }, [
      U.el('div', { class: 'amount ' + (tx.type === 'income' ? 'income' : 'expense'), style: { fontSize: '32px', fontWeight: '800' }, text: (tx.type === 'income' ? '+' : '-') + U.fmtMoney(tx.amount).slice(1) }),
      U.el('div', { style: { fontSize: '13px', color: 'var(--text-faint)', marginTop: '2px' }, text: U.fmtDayLabel(tx.time) + ' · ' + (tx.counterparty || tx.item || tx.categoryName || '') })
    ]);

    const body = U.el('div', null, [head, U.el('div', { class: 'card' }, rows)]);

    const actions = [
      { label: '编辑', onClick: () => { UI.closeSheet(); setTimeout(() => UI.openTxSheet(tx), 320); } },
      { label: tx.hidden ? '取消隐藏' : '隐藏', onClick: async () => { await Store.updateTx(tx.id, { hidden: !tx.hidden }); UI.closeSheet(); UI.toast(tx.hidden ? '已取消隐藏' : '已隐藏这笔账单'); } },
      { label: '删除', danger: true, onClick: async () => { UI.closeSheet(); const ok = await UI.confirm({ title: '删除账单', message: '确定要删除这笔「' + (tx.counterparty || tx.item || tx.categoryName) + '」吗？此操作不可撤销。', okText: '删除', danger: true }); if (ok) { await Store.removeTx(tx.id); UI.toast('已删除'); } } }
    ];

    if (tx.type === 'expense' && !tx.excludeStat) {
      actions.unshift({ label: '报销/排除', primary: true, onClick: () => { UI.closeSheet(); setTimeout(() => UI.openExcludeSheet(tx), 320); } });
    } else if (tx.reimburseStatus === 'pending') {
      actions.unshift({ label: '收到报销款', primary: true, onClick: () => { UI.closeSheet(); setTimeout(() => UI.openSettleSheet(tx), 320); } });
    } else if (tx.reimburseGroupId) {
      actions.unshift({ label: '取消报销并恢复统计', onClick: async () => {
        const ok = await UI.confirm({ title: '取消报销', message: '将删除配对的报销收入，并把这笔支出恢复为「计入统计」。', okText: '确定' });
        UI.closeSheet();
        if (ok) { await Store.cancelReimburse(tx.id); UI.toast('已恢复计入统计', 'ok'); }
      } });
    } else if (tx.excludeStat) {
      actions.unshift({ label: '恢复计入统计', primary: true, onClick: async () => { await Store.updateTx(tx.id, { excludeStat: false, excludeReason: '' }); UI.closeSheet(); UI.toast('已恢复计入统计', 'ok'); } });
    }

    UI.openSheet({ title: '账单详情', body: body, actions: actions });
  };

  /* ---------------- 报销 / 排除原因 ---------------- */
  UI.openExcludeSheet = function (tx) {
    const body = U.el('div', null, [
      U.el('p', { style: { fontSize: '13px', color: 'var(--text-soft)', marginBottom: '12px', lineHeight: '1.8' },
        text: '这笔支出将保留在明细里，但从本周/本月/本学期等所有合计中排除。适合：爸妈报销、帮同学代付、借还款、账户互转。' })
    ]);
    D.excludeReasons.filter((r) => ['报销', '代付', '借还款', '账户互转', '不计收支'].indexOf(r.name) >= 0).forEach((r) => {
      body.appendChild(U.el('div', { class: 'cat-row' }, [
        U.el('div', { class: 'ci', text: '🚫' }),
        U.el('div', { class: 'cn' }, [U.el('b', { text: r.name }), U.el('small', { text: r.desc })]),
        U.el('button', {
          class: 'btn btn-sm', text: '选择', onclick: async () => {
            if (r.name === '报销') { UI.closeSheet(); setTimeout(() => UI.openSettleSheet(tx, true), 320); }
            else { await Store.updateTx(tx.id, { excludeStat: true, excludeReason: r.name, reimburseStatus: '' }); UI.closeSheet(); UI.toast('已标记为「' + r.name + '」，不计入统计', 'ok'); }
          }
        })
      ]));
    });
    UI.openSheet({ title: '标记为不计入统计', body: body });
  };

  /* 待报销 -> 收到报销款 */
  UI.openSettleSheet = function (tx, asMarkOnly) {
    const body = U.el('div');
    const amountInput = U.el('input', { class: 'input', type: 'text', inputmode: 'decimal', value: String(tx.amount) });
    const who = U.el('input', { class: 'input', placeholder: '例如：爸爸、妈妈、宿舍同学', value: tx.counterparty ? '' : '' });
    const when = UI.dateField({ value: U.toISODate(new Date()), withTime: false });
    const accSel = U.el('select', { class: 'select' });
    ['微信', '支付宝', '银行卡', '现金', '其他'].forEach((a) => accSel.appendChild(U.el('option', { value: a, text: a, selected: a === '微信' })));

    body.appendChild(U.el('p', { style: { fontSize: '13px', color: 'var(--text-soft)', marginBottom: '12px', lineHeight: '1.8' },
      text: asMarkOnly
        ? '先把这笔支出标记为「待报销」，它会立刻从统计中排除。等收到钱时再来配对入账。'
        : '登记收到的报销款。系统会自动生成一笔「报销」收入，并与原支出配对，两者都不计入统计。' }));

    if (!asMarkOnly) {
      body.appendChild(U.el('div', { class: 'field' }, [U.el('label', { text: '报销到账金额' }), amountInput]));
      body.appendChild(U.el('div', { class: 'field' }, [U.el('label', { text: '谁报销的（可选）' }), who]));
      body.appendChild(U.el('div', { class: 'row row-split' }, [
        U.el('div', { class: 'field' }, [U.el('label', { text: '到账日期' }), when]),
        U.el('div', { class: 'field' }, [U.el('label', { text: '到账账户' }), accSel])
      ]));
    }

    UI.openSheet({
      title: asMarkOnly ? '标记为待报销' : '收到报销款',
      body: body,
      note: '报销的收入和支出都不会计入本月账单，但仍可在明细中查看。',
      actions: [{
        label: asMarkOnly ? '标记待报销' : '确认入账', primary: true, onClick: async () => {
          if (asMarkOnly) {
            await Store.markReimburse(tx.id, '报销');
            UI.closeSheet();
            UI.toast('已标记为待报销', 'ok');
          } else {
            const amt = U.parseAmount(amountInput.value);
            if (!amt) { UI.toast('请填写金额', 'err'); return; }
            await Store.settleReimburse(tx.id, {
              amount: amt,
              time: when.getValue(),
              account: accSel.value,
              counterparty: who.value.trim() || '报销',
              note: '报销款到账'
            });
            UI.closeSheet();
            UI.toast('已生成报销收入并配对', 'ok');
          }
        }
      }, { label: '取消', onClick: () => UI.closeSheet() }]
    });
  };

  /* ---------------- 分类编辑 ---------------- */
  UI.openCategoryEditSheet = async function (cat, type) {
    const isEdit = !!cat;
    const model = {
      name: cat ? cat.name : '',
      icon: cat ? cat.icon : '🏷️',
      color: cat ? cat.color : U.PALETTE[0],
      type: cat ? cat.type : (type || 'expense'),
      hidden: cat ? cat.hidden : false,
      excludeByDefault: cat ? cat.excludeByDefault : false
    };

    const nameInput = U.el('input', { class: 'input', placeholder: '例如：咖啡奶茶', value: model.name, oninput: (e) => { model.name = e.target.value; } });
    const iconGrid = U.el('div', { class: 'chips', style: { maxHeight: '132px', overflowY: 'auto' } });
    EMOJIS.forEach((em) => {
      iconGrid.appendChild(U.el('button', {
        class: 'chip' + (em === model.icon ? ' is-active' : ''), text: em, style: { fontSize: '17px', padding: '4px 9px' },
        onclick: () => { model.icon = em; $$('.chip', iconGrid).forEach((b) => b.classList.toggle('is-active', b.textContent === em)); }
      }));
    });
    const colorGrid = U.el('div', { class: 'chips' });
    U.PALETTE.forEach((col) => {
      colorGrid.appendChild(U.el('button', {
        class: 'chip', style: { background: col, width: '26px', height: '26px', padding: '0', borderColor: col === model.color ? 'var(--text)' : 'transparent' },
        title: col, onclick: () => { model.color = col; $$('.chip', colorGrid).forEach((b) => { b.style.borderColor = 'transparent'; }); }
      }));
    });

    const typeSeg = U.el('div', { class: 'seg' });
    [{ id: 'expense', name: '支出' }, { id: 'income', name: '收入' }, { id: 'both', name: '通用' }].forEach((it) => {
      typeSeg.appendChild(U.el('button', {
        class: model.type === it.id ? 'is-active' : '', text: it.name,
        onclick: (e) => { model.type = it.id; $$('button', typeSeg).forEach((b) => b.classList.toggle('is-active', b.textContent === it.name)); }
      }));
    });

    const body = U.el('div', null, [
      U.el('div', { class: 'field' }, [U.el('label', { text: '分类名称' }), nameInput]),
      U.el('div', { class: 'field' }, [U.el('label', { text: '图标' }), iconGrid]),
      U.el('div', { class: 'field' }, [U.el('label', { text: '颜色' }), colorGrid]),
      U.el('div', { class: 'field' }, [U.el('label', { text: '适用类型' }), typeSeg]),
      U.el('div', { class: 'switch-row' }, [
        U.el('div', { class: 'sr-body' }, [U.el('div', { class: 'sr-title', text: '隐藏该分类' }), U.el('div', { class: 'sr-desc', text: '不出现在分类选择器和列表筛选里' })]),
        U.el('button', { class: 'switch' + (model.hidden ? ' is-on' : ''), onclick: (e) => { model.hidden = !model.hidden; e.target.classList.toggle('is-on'); } })
      ]),
      U.el('div', { class: 'switch-row' }, [
        U.el('div', { class: 'sr-body' }, [U.el('div', { class: 'sr-title', text: '该分类默认不计入统计' }), U.el('div', { class: 'sr-desc', text: '导入或记账时自动套用，例如「报销」类' })]),
        U.el('button', { class: 'switch' + (model.excludeByDefault ? ' is-on' : ''), onclick: (e) => { model.excludeByDefault = !model.excludeByDefault; e.target.classList.toggle('is-on'); } })
      ])
    ]);

    const actions = [{
      label: '保存', primary: true, onClick: async () => {
        if (!model.name.trim()) { UI.toast('请填写分类名称', 'err'); return; }
        const dup = Store.categories.find((c) => c.name === model.name.trim() && c.type === model.type && (!isEdit || c.id !== cat.id));
        if (dup) { UI.toast('同类型下已存在同名分类', 'err'); return; }
        if (isEdit) await Store.updateCategory(cat.id, model);
        else await Store.addCategory(model);
        UI.closeSheet();
        UI.toast(isEdit ? '已保存' : '已添加分类', 'ok');
      }
    }];
    if (isEdit) {
      actions.push({
        label: '删除', danger: true, onClick: async () => {
          const used = Store.tx.filter((t) => t.categoryId === cat.id).length;
          UI.closeSheet();
          const ok = await UI.confirm({
            title: '删除分类',
            message: used ? '该分类下还有 ' + used + ' 笔账单，删除后它们会变成「未分类」，账单本身不会丢失。确定删除吗？' : '确定删除分类「' + cat.name + '」吗？',
            okText: '删除', danger: true
          });
          if (ok) { await Store.removeCategory(cat.id); UI.toast('已删除分类'); }
        }
      });
    }
    actions.push({ label: '取消', onClick: () => UI.closeSheet() });
    UI.openSheet({ title: isEdit ? '编辑分类' : '新建分类', body: body, actions: actions });
  };

  /* ---------------- 分类预设包 ---------------- */
  UI.openPackSheet = function () {
    const body = U.el('div');
    body.appendChild(U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)', marginBottom: '12px', lineHeight: '1.8' },
      text: '一键补齐整套分类。已存在的同名分类会被跳过，不会重复添加。' }));
    D.categoryPacks.forEach((p) => {
      body.appendChild(U.el('div', { class: 'cat-row' }, [
        U.el('div', { class: 'ci', text: '📦' }),
        U.el('div', { class: 'cn' }, [
          U.el('b', { text: p.name }),
          U.el('small', { text: p.desc + '（' + p.expense.length + ' 支出 / ' + p.income.length + ' 收入）' })
        ]),
        U.el('button', {
          class: 'btn btn-sm', text: '套用', onclick: async () => {
            const n = await Store.applyPack(p.id);
            UI.closeSheet();
            UI.renderSettings();
            UI.toast(n ? '已添加 ' + n + ' 个分类' : '这些分类都已经存在了', n ? 'ok' : '');
          }
        })
      ]));
    });
    UI.openSheet({ title: '分类预设包', body: body });
  };

  /* ---------------- 学期管理 ---------------- */
  UI.openSemesterSheet = function () {
    const body = U.el('div');
    Store.semesters().forEach((s) => {
      const isActive = s.id === Store.settings.activeSemesterId;
      body.appendChild(U.el('div', { class: 'card tight' }, [
        U.el('div', { class: 'card-title' }, [
          U.el('h3', { text: s.name + (isActive ? ' ✅' : '') }),
          U.el('span', { class: 'hint', text: s.start + ' ~ ' + s.end })
        ]),
        U.el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [
          U.el('button', { class: 'btn btn-sm', text: '设为当前', onclick: async () => { await Store.updateSettings({ activeSemesterId: s.id }); UI.closeSheet(); UI.renderSettings(); UI.toast('已切换当前学期', 'ok'); } }),
          U.el('button', { class: 'btn btn-sm', text: '编辑', onclick: () => UI.openSemesterEdit(s) }),
          U.el('button', { class: 'btn btn-sm btn-danger', text: '删除', onclick: async () => { const ok = await UI.confirm({ title: '删除学期', message: '确定删除「' + s.name + '」吗？账单数据不受影响。', okText: '删除', danger: true }); if (ok) { await Store.removeSemester(s.id); UI.closeSheet(); UI.renderSettings(); } } })
        ])
      ]));
    });
    body.appendChild(U.el('button', { class: 'btn btn-block btn-primary', text: '＋ 新增学期', onclick: () => UI.openSemesterEdit(null) }));
    UI.openSheet({ title: '学期设置', body: body, note: '统计页的「本学期」以这里设置的日期范围为准。' });
  };

  UI.openSemesterEdit = function (sem) {
    const g = D.guessSemester(new Date());
    const model = {
      name: sem ? sem.name : g.name,
      start: sem ? sem.start : g.start,
      end: sem ? sem.end : g.end
    };
    const body = U.el('div', null, [
      U.el('div', { class: 'field' }, [U.el('label', { text: '学期名称' }), U.el('input', { class: 'input', value: model.name, oninput: (e) => { model.name = e.target.value; } })]),
      U.el('div', { class: 'row row-split' }, [
        U.el('div', { class: 'field' }, [U.el('label', { text: '开学日期' }), UI.dateField({ value: model.start, withTime: false, onChange: (v) => { model.start = v; } })]),
        U.el('div', { class: 'field' }, [U.el('label', { text: '结束日期' }), UI.dateField({ value: model.end, withTime: false, onChange: (v) => { model.end = v; } })])
      ])
    ]);
    UI.openSheet({
      title: sem ? '编辑学期' : '新增学期',
      body: body,
      actions: [{
        label: '保存', primary: true, onClick: async () => {
          if (!model.name.trim() || !model.start || !model.end) { UI.toast('请填写完整', 'err'); return; }
          if (model.start > model.end) { UI.toast('开学日期不能晚于结束日期', 'err'); return; }
          if (sem) await Store.updateSemester(sem.id, model);
          else {
            const s = await Store.addSemester(model);
            if (!Store.settings.activeSemesterId) await Store.updateSettings({ activeSemesterId: s.id });
          }
          UI.closeSheet();
          UI.renderSettings();
          UI.toast('已保存学期', 'ok');
        }
      }, { label: '返回', onClick: () => UI.openSemesterSheet() }]
    });
  };

  /* ---------------- 自动分类规则 ---------------- */
  UI.openRulesSheet = function () {
    const body = U.el('div');
    const rules = Store.settings.rules || [];
    body.appendChild(U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)', marginBottom: '12px', lineHeight: '1.8' },
      text: '导入账单时，会用这些关键词匹配「交易对方 + 商品说明」，自动归类。自定义规则优先于内置规则。' }));

    rules.forEach((r) => {
      body.appendChild(U.el('div', { class: 'cat-row' }, [
        U.el('div', { class: 'ci', text: '🔧' }),
        U.el('div', { class: 'cn' }, [U.el('b', { text: r.cat }), U.el('small', { text: r.kw.join('、') })]),
        U.el('button', { class: 'btn btn-sm btn-danger', text: '删除', onclick: async () => { await Store.removeRule(r.id); UI.closeSheet(); UI.openRulesSheet(); } })
      ]));
    });

    const kwInput = U.el('input', { class: 'input', placeholder: '关键词，用逗号分隔，如：瑞幸,星巴克' });
    const catSel = U.el('select', { class: 'select' });
    Store.categories.filter((c) => !c.hidden).sort((a, b) => a.order - b.order).forEach((c) => {
      catSel.appendChild(U.el('option', { value: c.id, text: (c.type === 'income' ? '[收] ' : '[支] ') + c.name }));
    });

    body.appendChild(U.el('div', { class: 'section-label', text: '新增规则' }));
    body.appendChild(U.el('div', { class: 'field' }, [kwInput]));
    body.appendChild(U.el('div', { class: 'field' }, [catSel]));
    body.appendChild(U.el('button', {
      class: 'btn btn-block', text: '添加规则', onclick: async () => {
        const kws = kwInput.value.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
        if (!kws.length) { UI.toast('请填写关键词', 'err'); return; }
        const cat = Store.getCategory(catSel.value);
        if (!cat) { UI.toast('请选择分类', 'err'); return; }
        await Store.addRule({ kw: kws, cat: cat.name, type: cat.type === 'both' ? 'both' : cat.type });
        UI.closeSheet();
        UI.openRulesSheet();
        UI.toast('已添加规则', 'ok');
      }
    }));

    body.appendChild(U.el('div', { class: 'section-label', text: '内置关键词规则（只读）' }));
    D.builtinRules.forEach((r) => {
      body.appendChild(U.el('div', { class: 'cat-row' }, [
        U.el('div', { class: 'ci', text: '📌' }),
        U.el('div', { class: 'cn' }, [U.el('b', { text: r.cat + (r.type === 'income' ? '（收入）' : '') }), U.el('small', { text: r.kw.slice(0, 12).join('、') + (r.kw.length > 12 ? ' …' : '') })])
      ]));
    });

    UI.openSheet({ title: '自动分类规则', body: body });
  };

  global.UI = UI;
})(window);
/* ============================================================
   ui.js - 界面渲染与交互（第四部分：账单导入向导 / 备份恢复 / 数据清理）
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U, Store = global.Store, D = global.DEFAULTS, Importer = global.Importer;
  const UI = global.UI;
  const $ = U.$, $$ = U.$$;

  const PAGE_SIZE = 150;

  /* ---------------- 导入入口 ---------------- */
  UI.openImportSheet = function () {
    const opts = UI.state.importOpts = UI.state.importOpts || {
      autoClassify: Store.settings.autoClassifyOnImport,
      dedupe: Store.settings.dedupeOnImport,
      // 默认什么都不排除：导入的每一条都计入合计，要排除哪条由用户自己决定
      ignoreMode: 'count',
      refundMode: 'count'
    };

    const drop = U.el('div', { class: 'drop' }, [
      U.el('span', { class: 'big', text: '📥' }),
      U.el('div', { text: '点击选择账单文件，或把文件拖到这里' }),
      U.el('div', { style: { fontSize: '11.5px', marginTop: '6px' }, text: '支持：微信支付账单（.xlsx 或 .csv）、支付宝账单（.csv，自动识别编码）' })
    ]);

    function pickFile() {
      const fi = $('#fileInput');
      fi.value = '';
      fi.accept = '.csv,.txt,.xlsx,.xlsm';
      fi.onchange = async () => {
        if (!fi.files || !fi.files[0]) return;
        await handleFile(fi.files[0]);
      };
      fi.click();
    }

    drop.addEventListener('click', pickFile);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault(); drop.classList.remove('is-over');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) await handleFile(f);
    });

    /* 按当前选项，把上次选的文件重新解析一遍 */
    async function resolveSource(o) {
      const src = UI.state.importSource;
      if (!src) throw new Error('请先选择账单文件');
      let r;
      if (src.kind === 'xlsx') r = await Importer.parseXlsx(src.buffer, o);
      else r = Importer.parse(src.text, o);
      r.fileName = src.name;
      r.encoding = src.encoding;
      return r;
    }

    /* 重新解析；可顺带改掉某个选项（例如把「不计收支」也导进来） */
    async function reparse(patch) {
      if (patch) Object.assign(opts, patch);
      const r = await resolveSource(opts);
      UI.state.importResult = r;
      showPreview(r, reparse);
    }

    async function handleFile(file) {
      try {
        const name = String(file.name || '');
        const lower = name.toLowerCase();
        UI.toast('正在解析账单…');

        if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
          // 微信账单默认导出的就是 Excel 文件
          const buffer = await file.arrayBuffer();
          UI.state.importSource = { kind: 'xlsx', buffer: buffer, name: name, encoding: 'Excel 工作簿' };
        } else if (lower.endsWith('.xls')) {
          throw new Error('不支持老式 .xls 格式，请在 Excel 里另存为 .xlsx 或 .csv 后再导入');
        } else {
          const decoded = await Importer.readFile(file);
          UI.state.importSource = { kind: 'csv', text: decoded.text, name: name, encoding: decoded.encoding };
        }

        const result = await resolveSource(opts);
        UI.state.importResult = result;
        showPreview(result, reparse);
      } catch (err) {
        console.error(err);
        UI.toast('解析失败：' + (err && err.message ? err.message : '未知错误'), 'err');
      }
    }

    const optRow = (key, title, desc) => U.el('div', { class: 'switch-row' }, [
      U.el('div', { class: 'sr-body' }, [U.el('div', { class: 'sr-title', text: title }), U.el('div', { class: 'sr-desc', text: desc })]),
      U.el('button', {
        class: 'switch' + (opts[key] ? ' is-on' : ''),
        onclick: (e) => { opts[key] = !opts[key]; e.target.classList.toggle('is-on'); }
      })
    ]);

    const body = U.el('div', null, [drop]);
    if (UI.state.importSource) {
      body.appendChild(U.el('button', {
        class: 'btn btn-block', style: { marginTop: '10px' },
        text: '用下面的选项重新解析：' + (UI.state.importSource.name || '上次选择的文件'),
        onclick: async () => {
          try { await reparse(); }
          catch (e) { UI.toast('解析失败：' + e.message, 'err'); }
        }
      }));
    }
    /* 三档／两档选择器 */
    function modeField(key, label, options, desc) {
      const seg = U.el('div', { class: 'seg', style: { marginBottom: '0' } });
      options.forEach(function (o) {
        seg.appendChild(U.el('button', {
          class: opts[key] === o.v ? 'is-active' : '',
          text: o.n,
          onclick: function () {
            opts[key] = o.v;
            Array.prototype.forEach.call(seg.children, function (b) {
              b.classList.toggle('is-active', b.textContent === o.n);
            });
          }
        }));
      });
      const box = U.el('div', { class: 'field' }, [U.el('label', { text: label }), seg]);
      if (desc) box.appendChild(U.el('div', { class: 'sheet-note', style: { margin: '6px 0 0' }, text: desc }));
      return box;
    }

    U.append(body, [
      U.el('div', { class: 'section-label', text: '基础选项' }),
      U.el('div', { class: 'card tight' }, [
        optRow('autoClassify', '自动分类', '根据交易对方与商品说明自动归类'),
        optRow('dedupe', '自动去重', '交易单号已存在时标记为重复，默认不导入')
      ]),

      U.el('div', { class: 'section-label', text: '不计入合计的流水（由你决定）' }),
      U.el('p', { style: { fontSize: '12px', color: 'var(--text-soft)', lineHeight: '1.75', margin: '0 0 8px' },
        text: '默认什么都不排除，导入的每一条都计入合计。想少算某些流水时再自己选，应用不会擅自替你决定。' }),
      U.el('div', { class: 'card tight' }, [
        modeField('ignoreMode', '账单里标记「不计收支」的流水', [
          { v: 'exclude', n: '不计入合计' },
          { v: 'count', n: '计入合计' },
          { v: 'skip', n: '不导入' }
        ], '默认「计入合计」，一条都不会被排除。想少算这些（余额宝转入转出、花呗还款、提现等）就选「不计入合计」，它们会留在明细里但不参与合计。'),
        modeField('refundMode', '退款流水', [
          { v: 'exclude', n: '不计入合计' },
          { v: 'count', n: '计入合计' }
        ], '默认「计入合计」：退款和原始支出会各自入账，净额正好抵消。想彻底排除退款再选「不计入合计」。')
      ]),
      U.el('div', { class: 'section-label', text: '怎么导出账单？' }),
      U.el('div', { class: 'card tight', style: { fontSize: '12.5px', color: 'var(--text-soft)', lineHeight: '1.9' }, html:
        '<b>微信：</b>我 → 服务 → 钱包 → 账单 → 常见问题 → 下载账单 → 用于个人对账 → 选择月份 → 邮箱收到压缩包，解压得到 csv。<br>' +
        '<b>支付宝：</b>我的 → 账单 → 右上角 ··· → 开具交易流水证明 → 用于个人对账 → 选择月份 → 邮箱收到压缩包，解压得到 csv。' })
    ]);

    UI.openSheet({ title: '导入账单', body: body, note: '账单文件只在你本机解析，不会上传到任何服务器。' });
  };

  /* ---------------- 导入预览 ---------------- */
  function showPreview(result, onReparse) {
    const items = result.items;
    let shown = PAGE_SIZE;

    const stat = U.el('div', { class: 'card tight', style: { fontSize: '12.5px', lineHeight: '1.9' } });
    const tableWrap = U.el('div', { class: 'table-wrap' });
    const table = U.el('table', { class: 'prev' });
    const tbody = U.el('tbody');

    const selCount = () => items.filter((it) => it.selected && !it.dup).length;
    function refreshStat() {
      const picked = selCount();
      const sum = items.filter((it) => it.selected).reduce((s, it) => {
        return s + (it.tx.type === 'expense' ? -it.tx.amount : it.tx.amount);
      }, 0);
      U.clear(stat);
      const kindName = { wechat: '微信支付账单', alipay: '支付宝账单', generic: '通用账单' }[result.detect && result.detect.kind] || '账单';
      /* 把「文件里有多少行、每行的归宿」算清楚，避免误以为数据丢了 */
      const st = result.stats || {};
      const excluded = items.filter((it) => it.tx.excludeStat).length;
      const normal = Math.max(0, items.length - (st.dup || 0) - (st.suspect || 0) - excluded);
      const reasons = st.skipReasons || {};
      const reasonBits = [];
      if (reasons.footer) reasonBits.push('账单结尾的汇总行 ' + reasons.footer);
      if (reasons.closed) reasonBits.push('交易已关闭或失败 ' + reasons.closed);
      if (reasons.noAmount) reasonBits.push('缺少金额 ' + reasons.noAmount);
      if (reasons.noTime) reasonBits.push('缺少时间 ' + reasons.noTime);

      const formatName = result.source === 'xlsx' ? 'Excel 工作簿' : (result.encoding || '-');

      U.append(stat, [
        U.el('div', { html: '<b>' + U.esc(result.fileName || '') + '</b>　识别为「' + U.esc(kindName) + '」，格式 ' + U.esc(formatName) +
          (result.sheetName ? '　工作表「' + U.esc(result.sheetName) + '」' : '') }),
        U.el('div', { html: '文件里共 <b>' + (st.dataRows || 0) + '</b> 行数据　→　生成 <b>' + items.length + '</b> 条记录' +
          (st.skipped ? '，其中 <b>' + st.skipped + '</b> 行无法识别' : '') }),
        U.el('div', { html: '新增 <b>' + normal + '</b>　·　重复 <b>' + (st.dup || 0) + '</b>　·　疑似重复 <b>' + (st.suspect || 0) +
          '</b>　·　不计入统计 <b>' + excluded + '</b>' }),
        U.el('div', { html: '已勾选 <b>' + picked + '</b> 条，净额 <b>' + U.esc(U.fmtMoney(sum)) + '</b>' }),
        reasonBits.length ? U.el('div', { style: { fontSize: '11.5px', color: 'var(--text-faint)' }, text: '无法识别的行：' + reasonBits.join('、') }) : null,

        (excluded && Object.keys(st.excludeBreakdown || {}).length
          ? U.el('div', { style: { fontSize: '11.5px', color: 'var(--text-faint)' },
              text: '其中不计入合计的构成：' + Object.keys(st.excludeBreakdown).map(function (k) {
                return k + ' ' + st.excludeBreakdown[k] + ' 条';
              }).join('、') })
          : null),

        (excluded ? U.el('div', { class: 'imp-warn' }, [
          U.el('div', { html: '有 <b>' + excluded + '</b> 条被标记为「不计入合计」。排除规则是你自己选的，如果这不是你想要的结果，可以一键改成全部计入。' }),
          U.el('button', {
            class: 'btn btn-sm', style: { marginTop: '8px' },
            text: '全部计入合计',
            onclick: () => { if (onReparse) onReparse({ ignoreMode: 'count', refundMode: 'count' }); }
          })
        ]) : null),

        (st.ignored ? U.el('div', { class: 'imp-warn' }, [
          U.el('div', { html: '有 <b>' + st.ignored + '</b> 条「不计收支」流水被跳过了（余额宝转入转出、花呗还款、提现、转账等）。' }),
          U.el('div', { style: { marginTop: '6px' }, text: '这是你在导入选项里选了「不导入」的结果。想保留它们，点下面的按钮重新解析即可。' }),
          U.el('button', {
            class: 'btn btn-sm', style: { marginTop: '8px' },
            text: '保留这些流水（不计入合计）',
            onclick: () => { if (onReparse) onReparse({ ignoreMode: 'exclude' }); }
          })
        ]) : null),

        (st.suspect ? U.el('div', {
          class: 'imp-warn',
          html: '⚠️ 有 <b>' + st.suspect + '</b> 条与已有记录「同一天、同金额」，已自动取消勾选以免重复记账。' +
            '如果确实是两笔不同的消费，把鼠标移到「疑似重复」上可以看到原因，再手动勾选即可。'
        }) : null)
      ]);
    }

    function buildCatSelect(it) {
      const sel = U.el('select', { class: 'select', style: { padding: '4px 6px', fontSize: '12px', minWidth: '104px' } });
      sel.appendChild(U.el('option', { value: '', text: '未分类' }));
      Store.categoriesFor(it.tx.type, false).forEach((c) => {
        sel.appendChild(U.el('option', { value: c.id, text: c.name, selected: c.id === it.tx.categoryId }));
      });
      sel.addEventListener('change', () => {
        const c = Store.getCategory(sel.value);
        it.tx.categoryId = sel.value;
        it.tx.categoryName = c ? c.name : '';
        if (c) {
          it.tx.excludeStat = !!c.excludeByDefault || it.tx.excludeStat;
          if (c.excludeByDefault) it.tx.excludeReason = it.tx.excludeReason || '分类默认排除';
        }
        renderRowStatus(it);
      });
      return sel;
    }

    /* 状态列：重复 / 疑似重复只做标记；其余每一行都能直接点着切换「计入 / 不计入」，
       这样哪一条不计入统计，完全由你逐条决定 */
    function renderRowStatus(it) {
      const cell = it._statusCell;
      if (!cell) return;
      U.clear(cell);

      if (it.dup) {
        cell.appendChild(U.el('span', { class: 'badge warn', title: it.dupReason || '', text: '重复' }));
        return;
      }
      if (it.suspect) {
        cell.appendChild(U.el('span', { class: 'badge warn', title: it.suspectReason || '', text: '疑似重复' }));
        return;
      }

      cell.appendChild(U.el('button', {
        class: 'badge ' + (it.tx.excludeStat ? 'mute' : 'primary'),
        style: { border: '0', cursor: 'pointer', fontFamily: 'inherit' },
        title: it.tx.excludeStat
          ? '当前不计入合计（' + (it.tx.excludeReason || '未注明') + '），点一下改成计入'
          : '当前计入合计，点一下改成不计入',
        text: it.tx.excludeStat ? '不计入' : '计入',
        onclick: () => {
          it.tx.excludeStat = !it.tx.excludeStat;
          it.tx.excludeReason = it.tx.excludeStat ? (it.tx.excludeReason || '手动标记') : '';
          renderRowStatus(it);
          refreshStat();
        }
      }));
    }

    /* 行样式：重复=红底、疑似重复=黄底、未勾选=淡化 */
    function rowClass(it) {
      if (it.dup) return 'is-dup';
      if (it.suspect) return 'is-suspect';
      return it.selected ? '' : 'is-skip';
    }

    function renderRows() {
      U.clear(tbody);
      items.slice(0, shown).forEach((it) => {
        const d = new Date(it.tx.time);
        const tr = U.el('tr', { class: rowClass(it) });
        const cb = U.el('input', {
          type: 'checkbox', checked: it.selected,
          onchange: (e) => {
            it.selected = e.target.checked;
            tr.className = rowClass(it);
            refreshStat();
          }
        });
        tr.appendChild(U.el('td', null, [cb]));
        tr.appendChild(U.el('td', { text: U.toISODate(d) }));
        tr.appendChild(U.el('td', { text: it.tx.type === 'income' ? '收入' : '支出' }));
        tr.appendChild(U.el('td', { class: 'amt', text: U.fmtMoney(it.tx.amount) }));
        tr.appendChild(U.el('td', { text: it.tx.counterparty || '—' }));
        tr.appendChild(U.el('td', { text: it.tx.item || '—' }));
        tr.appendChild(U.el('td', null, [buildCatSelect(it)]));
        const statusCell = U.el('td');
        it._statusCell = statusCell;
        tr.appendChild(statusCell);
        renderRowStatus(it);
        tbody.appendChild(tr);
      });
      refreshStat();
    }

    const thead = U.el('thead', null, [
      U.el('tr', null, [
        U.el('th', { text: '选' }), U.el('th', { text: '日期' }), U.el('th', { text: '类型' }), U.el('th', { text: '金额' }),
        U.el('th', { text: '来源（交易对方）' }), U.el('th', { text: '用途（商品）' }), U.el('th', { text: '分类' }), U.el('th', { text: '状态' })
      ])
    ]);
    table.appendChild(thead);
    table.appendChild(tbody);
    tableWrap.appendChild(table);

    const moreBtn = U.el('button', {
      class: 'btn btn-sm btn-block', style: { marginTop: '10px' },
      text: items.length > shown ? '显示更多（还有 ' + (items.length - shown) + ' 条）' : '已显示全部',
      onclick: () => { shown += PAGE_SIZE; renderRows(); moreBtn.textContent = items.length > shown ? '显示更多（还有 ' + (items.length - shown) + ' 条）' : '已显示全部'; }
    });

    const toggleToolbar = U.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '10px 0' } }, [
      U.el('button', { class: 'btn btn-sm', text: '全选', onclick: () => { items.forEach((it) => { it.selected = true; }); renderRows(); } }),
      U.el('button', { class: 'btn btn-sm', text: '全不选', onclick: () => { items.forEach((it) => { it.selected = false; }); renderRows(); } }),
      U.el('button', { class: 'btn btn-sm', text: '反选', onclick: () => { items.forEach((it) => { it.selected = !it.selected; }); renderRows(); } }),
      U.el('button', { class: 'btn btn-sm', text: '仅选非重复', onclick: () => { items.forEach((it) => { it.selected = !it.dup && !it.suspect; }); renderRows(); } }),
      U.el('button', { class: 'btn btn-sm', text: '连疑似重复一起选', onclick: () => { items.forEach((it) => { it.selected = !it.dup; }); renderRows(); } })
    ]);

    const body = U.el('div', null, [stat, toggleToolbar, tableWrap, moreBtn]);
    renderRows();

    UI.openSheet({
      title: '确认导入',
      body: body,
      actions: [
        { label: '导入所选', primary: true, onClick: async () => {
          const n = await Importer.commit(items);
          UI.closeSheet();
          if (n) { UI.toast('已导入 ' + n + ' 笔账单', 'ok'); UI.go('list'); }
          else UI.toast('没有可导入的账单', 'err');
        } },
        { label: '重新选择文件', onClick: () => UI.openImportSheet() }
      ],
      note: '重复与疑似重复的账单默认都不勾选。导入后可在「明细」里逐条调整分类或标记为不计入统计。'
    });
  }

  /* ---------------- 从备份恢复 ---------------- */
  UI.openRestoreSheet = function () {
    const body = U.el('div');
    body.appendChild(U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)', lineHeight: '1.9' },
      text: '选择之前导出的 JSON 备份文件。合并模式会按账目 ID 去重，同一笔不会重复导入；覆盖模式会清空当前数据后再还原。' }));

    const modeSeg = U.el('div', { class: 'seg' });
    let mode = 'merge';
    [{ id: 'merge', name: '合并（推荐）' }, { id: 'replace', name: '覆盖当前数据' }].forEach((it) => {
      modeSeg.appendChild(U.el('button', {
        class: it.id === 'merge' ? 'is-active' : '', text: it.name,
        onclick: () => { mode = it.id; $$('button', modeSeg).forEach((b) => b.classList.toggle('is-active', b.textContent === it.name)); }
      }));
    });
    body.appendChild(modeSeg);
    body.appendChild(U.el('button', {
      class: 'btn btn-block btn-primary', text: '选择备份文件',
      onclick: () => {
        const fi = $('#fileInput');
        fi.value = ''; fi.accept = '.json';
        fi.onchange = async () => {
          const f = fi.files && fi.files[0];
          if (!f) return;
          try {
            const text = await f.text();
            const obj = JSON.parse(text);
            if (mode === 'replace') {
              const ok = await UI.confirm({ title: '覆盖确认', message: '这会清空当前全部账目后再导入备份，确定继续吗？', okText: '确定覆盖', danger: true });
              if (!ok) return;
            }
            const r = await Store.importObject(obj, mode);
            UI.closeSheet();
            UI.toast('已恢复：账目 ' + r.tx + ' 条，分类 ' + r.categories + ' 个', 'ok');
          } catch (err) {
            console.error(err);
            UI.toast('恢复失败：' + (err && err.message ? err.message : '文件格式不正确'), 'err');
          }
        };
        fi.click();
      }
    }));
    UI.openSheet({ title: '从备份恢复', body: body });
  };

  /* ---------------- 清理重复 ---------------- */
  UI.openCleanupSheet = function () {
    const seen = new Map();
    const dups = [];
    Store.tx.slice().sort((a, b) => a.createdAt - b.createdAt).forEach((t) => {
      const key = t.externalId ? 'ext:' + t.externalId
        : ['fb', t.type, t.amount.toFixed(2), t.dateKey, t.counterparty, t.item].join('|');
      if (seen.has(key)) dups.push(t); else seen.set(key, t);
    });

    const body = U.el('div', null, [
      U.el('p', { style: { fontSize: '13px', color: 'var(--text-soft)', lineHeight: '1.9' },
        text: dups.length ? '检测到 ' + dups.length + ' 条疑似重复的账单（同一交易单号，或时间、金额、来源完全相同）。' : '很好，没有检测到重复的账单。' })
    ]);

    if (dups.length) {
      const box = U.el('div', { class: 'tx-list', style: { maxHeight: '320px', overflowY: 'auto' } });
      dups.slice(0, 60).forEach((t) => {
        box.appendChild(U.el('div', { class: 'tx', onclick: () => UI.openTxDetail(t) }, [
          U.el('div', { class: 'tx-ico', text: '♻️' }),
          U.el('div', { class: 'tx-body' }, [
            U.el('div', { class: 'tx-top' }, [
              U.el('span', { class: 'tx-name', text: t.counterparty || t.item || t.categoryName || '—' }),
              U.el('span', { class: 'tx-amt amount ' + (t.type === 'income' ? 'income' : 'expense'), text: U.fmtMoney(t.amount) })
            ]),
            U.el('div', { class: 'tx-meta' }, [U.el('span', { text: U.fmtDateTime(t.time) + ' · ' + (t.categoryName || '未分类') })])
          ])
        ]));
      });
      body.appendChild(box);
      body.appendChild(U.el('button', {
        class: 'btn btn-block btn-danger', style: { marginTop: '12px' }, text: '删除这 ' + dups.length + ' 条重复账单',
        onclick: async () => {
          const ok = await UI.confirm({ title: '删除重复项', message: '将删除 ' + dups.length + ' 条重复账单（保留最早的一条）。确定吗？', okText: '删除', danger: true });
          if (!ok) return;
          await Store.removeManyTx(dups.map((t) => t.id));
          UI.closeSheet();
          UI.toast('已清理 ' + dups.length + ' 条重复账单', 'ok');
        }
      }));
    }

    UI.openSheet({ title: '清理重复数据', body: body });
  };

  /* ---------------- 清空全部数据 ---------------- */
  /* 兼容旧入口：统一改为打开分级清理面板 */
  UI.confirmClear = function () { UI.openClearDataSheet(); };

  global.UI = UI;
})(window);
/* ============================================================
   ui.js - 界面渲染与交互（第五部分：分类管理面板）
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U, Store = global.Store, Stats = global.Stats, D = global.DEFAULTS;
  const UI = global.UI;
  const $ = U.$, $$ = U.$$;

  /* 分类管理：支出 / 收入 */
  UI.openCategoryManager = function (type) {
    const usage = Stats.categoryUsage();
    const body = U.el('div');
    const cats = Store.allCategoriesFor(type);

    body.appendChild(U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)', marginBottom: '10px', lineHeight: '1.8' },
      text: '隐藏的分类不会出现在记账和筛选的选择器里，但历史账单仍然保留；「默认不计入统计」适合报销、代付这类分类。' }));

    if (!cats.length) {
      body.appendChild(U.el('div', { class: 'empty' }, [U.el('span', { class: 'big', text: '📂' }), U.el('span', { text: '还没有分类' })]));
    }

    cats.forEach((c) => {
      const n = usage.get(c.id) || 0;
      const tags = [];
      if (c.hidden) tags.push('已隐藏');
      if (c.excludeByDefault) tags.push('默认不计入统计');
      body.appendChild(U.el('div', { class: 'cat-row' }, [
        U.el('div', { class: 'ci', text: c.icon, style: { background: U.hexToRgba(c.color, 0.16) } }),
        U.el('div', { class: 'cn' }, [
          U.el('b', { text: c.name + (c.hidden ? '  🚫' : '') }),
          U.el('small', { text: n + ' 笔' + (tags.length ? ' · ' + tags.join(' · ') : '') })
        ]),
        U.el('div', { class: 'ops' }, [
          U.el('button', { class: 'btn btn-sm', text: '改', title: '编辑分类', onclick: () => UI.openCategoryEditSheet(c, type) }),
          U.el('button', { class: 'btn btn-sm', text: c.hidden ? '显示' : '隐藏', onclick: async () => {
            await Store.updateCategory(c.id, { hidden: !c.hidden });
            UI.closeSheet();
            setTimeout(() => UI.openCategoryManager(type), 320);
            UI.toast(c.hidden ? '已显示该分类' : '已隐藏该分类', 'ok');
          } })
        ])
      ]));
    });

    body.appendChild(U.el('div', { style: { display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' } }, [
      U.el('button', { class: 'btn btn-primary', text: '＋ 新建' + (type === 'expense' ? '支出' : '收入') + '分类', onclick: () => UI.openCategoryEditSheet(null, type) }),
      U.el('button', { class: 'btn', text: '套用预设包', onclick: () => UI.openPackSheet() })
    ]));

    UI.openSheet({
      title: (type === 'expense' ? '支出分类' : '收入分类') + '管理（' + cats.length + '）',
      body: body,
      actions: [{ label: '完成', primary: true, onClick: () => UI.closeSheet() }]
    });
  };

  global.UI = UI;
})(window);
/* ============================================================
   ui.js - 界面渲染与交互（第六部分：与电脑同步的设置面板）
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U, Store = global.Store, Sync = global.Sync;
  const UI = global.UI;

  UI.openSyncSheet = function () {
    const isApp = Sync.isApp();
    let url = Sync.config.url || '';
    let pwd = '';
    let autoSync = !!Sync.config.autoSync;
    let deviceName = Sync.config.deviceName || Sync.guessDeviceName();
    let showConn = !Sync.isConnected();   // 已经连上就不展开表单
    let testing = false;
    let note = '';
    let noteKind = '';

    /* ---------------- 状态判定 ---------------- */
    function statusInfo() {
      if (!Sync.available()) {
        return { t: '未配置', cls: 'muted', d: isApp ? '还没有填写电脑地址' : '当前页面不是通过电脑上的服务打开的' };
      }
      if (Sync.progress.running) return { t: '正在同步', cls: 'busy', d: Sync.progress.step };
      if (Sync.status === 'auth') return { t: '需要口令', cls: 'warn', d: '口令已失效，请重新输入' };
      if (Sync.status === 'error') return { t: '上次同步失败', cls: 'err', d: Sync.message };
      if (Sync.config.lastSyncAt) return { t: '已连接电脑', cls: 'ok', d: '上次同步：' + Sync.lastSyncText() };
      if (Sync.isConnected()) return { t: '已连接电脑', cls: 'ok', d: '还没有同步过' };
      return { t: '未连接', cls: 'muted', d: '请填写电脑地址和访问口令' };
    }

    /* ---------------- 元素 ---------------- */
    const statusBox = U.el('div');
    const connBox = U.el('div');
    const noteBox = U.el('div', { class: 'sheet-note' });
    const btnRow = U.el('div', { class: 'sheet-actions' });

    const urlInput = U.el('input', {
      class: 'input', placeholder: '例如 192.168.1.7:8788', value: url, autocomplete: 'off',
      oninput: (e) => { url = e.target.value; }
    });
    const pwdInput = U.el('input', {
      class: 'input', type: 'password', inputmode: 'numeric', autocomplete: 'off',
      placeholder: '电脑窗口里显示的 6 位口令', oninput: (e) => { pwd = e.target.value; }
    });
    const nameInput = U.el('input', {
      class: 'input', value: deviceName, oninput: (e) => { deviceName = e.target.value; }
    });
    const autoSwitch = U.el('button', {
      class: 'switch' + (autoSync ? ' is-on' : ''),
      onclick: (e) => { autoSync = !autoSync; e.target.classList.toggle('is-on'); }
    });

    function commitConfig() {
      Sync.config.url = Sync.normalizeUrl(url);
      Sync.config.deviceName = deviceName.trim() || Sync.guessDeviceName();
      Sync.config.autoSync = autoSync;
      Sync.save();
      if (Sync.syncHostToNative) Sync.syncHostToNative();
    }

    /* ---------------- 渲染 ---------------- */
    function say(msg, kind) { note = msg || ''; noteKind = kind || ''; renderNote(); }

    function renderNote() {
      noteBox.textContent = note || '';
      noteBox.style.color = noteKind === 'err' ? 'var(--expense)' : (noteKind === 'ok' ? 'var(--income)' : '');
    }

    function renderStatus() {
      U.clear(statusBox);
      const st = statusInfo();
      const p = Sync.progress;

      statusBox.appendChild(U.el('div', { class: 'sync-status ' + st.cls }, [
        U.el('div', { class: 'ss-head' }, [
          U.el('span', { class: 'ss-dot' }),
          U.el('span', { class: 'ss-title', text: st.t }),
          U.el('span', { class: 'ss-time', text: Sync.config.lastSyncAt ? Sync.lastSyncText() : '' })
        ]),
        st.d ? U.el('div', { class: 'ss-desc', text: st.d }) : null
      ]));

      /* 进度条：同步过程中实时更新 */
      if (p.running || (p.percent === 100 && p.step)) {
        statusBox.appendChild(U.el('div', { class: 'sync-progress' }, [
          U.el('div', { class: 'sp-track' }, [
            U.el('div', { class: 'sp-fill', style: { width: p.percent + '%' } })
          ]),
          U.el('div', { class: 'sp-row' }, [
            U.el('span', { class: 'sp-pct', text: p.percent + '%' }),
            U.el('span', { class: 'sp-step', text: p.step })
          ]),
          p.detail ? U.el('div', { class: 'sp-detail', text: p.detail }) : null
        ]));
      }

      const lr = Sync.config.lastResult;
      if (lr && Sync.config.lastSyncAt) {
        statusBox.appendChild(U.el('div', { class: 'ss-result', text:
          '上传 ' + lr.pushed + ' 项　下载 ' + lr.pulled + ' 项　删除 ' + lr.removed +
          ' 项　电脑上共 ' + lr.serverTotal + ' 条' }));
      }

      statusBox.appendChild(U.el('div', { class: 'ss-meta', text:
        '本机名称：' + deviceName + (isApp ? '　电脑地址：' + (Sync.config.url || '未填写') : '') }));

      renderButtons();
    }

    function busy() { return Sync.progress.running || testing; }

    function renderButtons() {
      U.clear(btnRow);
      if (isApp) {
        btnRow.appendChild(U.el('button', {
          class: 'btn', text: testing ? '测试中…' : '测试连接', disabled: busy(),
          onclick: () => doTest()
        }));
      }
      btnRow.appendChild(U.el('button', {
        class: 'btn btn-primary', text: Sync.progress.running ? '同步中…' : '立即同步',
        disabled: busy(), onclick: () => doSync()
      }));
      btnRow.appendChild(U.el('button', { class: 'btn', text: '关闭', onclick: () => UI.closeSheet() }));
    }

    let connRendered = null;
    function renderConn() {
      if (connRendered === showConn) return;   // 状态没变就不重建，避免打断输入
      connRendered = showConn;
      U.clear(connBox);
      if (!isApp) return;

      if (!showConn) {
        connBox.appendChild(U.el('button', {
          class: 'btn btn-sm btn-block', style: { marginBottom: '12px' },
          text: '重新连接 / 更换口令',
          onclick: () => { showConn = true; renderConn(); }
        }));
        return;
      }

      const card = U.el('div', { class: 'card tight', style: { marginBottom: '12px' } });
      card.appendChild(U.el('div', { class: 'field' }, [U.el('label', { text: '电脑地址' }), urlInput]));
      card.appendChild(U.el('div', { class: 'field' }, [
        U.el('label', { text: '访问口令' + (Sync.config.token ? '（已记住，留空即可）' : '') }),
        pwdInput
      ]));
      if (Sync.config.token) {
        card.appendChild(U.el('div', { class: 'sheet-note', style: { margin: '0' },
          text: '这台设备已经记住口令了，平时不用再输；只有换了电脑或改了口令时才需要重新填。' }));
      }
      connBox.appendChild(card);
    }

    function refresh() { renderStatus(); renderNote(); renderConn(); }
    function rerenderConn() { connRendered = null; renderConn(); }

    /* ---------------- 操作 ---------------- */
    async function doTest() {
      if (!url.trim()) { say('请先填写电脑地址', 'err'); return; }
      commitConfig();
      testing = true; say('正在测试连接…'); renderStatus();
      try {
        if (pwd) { await Sync.login(pwd); pwd = ''; pwdInput.value = ''; }
        const info = await Sync.test();
        say('连接成功：电脑上已有 ' + info.txCount + ' 条账目（' + info.app + '）', 'ok');
        showConn = !Sync.isConnected();
        rerenderConn();
      } catch (e) {
        say('连接失败：' + e.message, 'err');
        showConn = true; rerenderConn();
      } finally {
        testing = false; renderStatus();
      }
    }

    async function doSync() {
      if (isApp && !url.trim()) { say('请先填写电脑地址', 'err'); showConn = true; rerenderConn(); return; }
      commitConfig();
      say('');
      try {
        if (isApp && pwd) { await Sync.login(pwd); pwd = ''; pwdInput.value = ''; }
        const r = await Sync.sync();
        if (!r) { say('同步正在进行中，请稍候…'); return; }
        say('同步完成：上传 ' + r.pushed + ' 项，下载 ' + r.pulled + ' 项', 'ok');
        showConn = !Sync.isConnected();
        rerenderConn();
      } catch (e) {
        say('同步失败：' + e.message, 'err');
      } finally {
        renderStatus();
      }
    }

    /* ---------------- 组装 ---------------- */
    const body = U.el('div');
    body.appendChild(U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)', lineHeight: '1.85', margin: '0 0 12px' }, html: isApp
      ? '在电脑上运行 <b>启动记账本.bat</b>，窗口里会显示一个「手机地址」和一个 6 位口令。填一次之后就不用再填了。'
      : '当前页面就是电脑上的服务提供的，可以直接同步。' }));

    body.appendChild(statusBox);
    body.appendChild(connBox);
    body.appendChild(U.el('div', { class: 'section-label', text: '本机' }));
    body.appendChild(U.el('div', { class: 'field' }, [nameInput]));
    body.appendChild(U.el('div', { class: 'switch-row' }, [
      U.el('div', { class: 'sr-body' }, [
        U.el('div', { class: 'sr-title', text: '自动同步' }),
        U.el('div', { class: 'sr-desc', text: '打开应用时、以及记账之后，自动和电脑同步一次' })
      ]),
      autoSwitch
    ]));

    body.appendChild(U.el('div', { class: 'section-label', text: '同步规则' }));
    body.appendChild(U.el('div', {
      style: { fontSize: '12.5px', color: 'var(--text-soft)', lineHeight: '1.9' },
      html: '・两边各自保存一份数据，同步时逐条比较「最后修改时间」，新的那份胜出<br>' +
        '・删除也会同步过去，被删掉的账目不会从另一台设备跑回来<br>' +
        '・同一时刻两边都改了同一条时，保留后改的那一份'
    }));
    body.appendChild(noteBox);
    body.appendChild(btnRow);

    refresh();

    /* 同步过程中的进度会通过这里实时刷新 */
    const unsub = Sync.subscribe(() => { renderStatus(); });

    UI.openSheet({
      title: '与电脑同步',
      body: body,
      onClose: () => { if (unsub) unsub(); },
      note: '同步只在你自己的电脑和手机之间进行，数据不会经过任何第三方服务器。'
    });
  };
  global.UI = UI;
})(window);
/* ============================================================
   ui.js - 界面渲染与交互（第七部分：报表导出 / 自动备份）
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U, Store = global.Store, Stats = global.Stats, Report = global.Report, Backup = global.Backup;
  const UI = global.UI;

  /* ============================================================
     一、导出报表
     ============================================================ */
  UI.openExportSheet = function () {
    let period = 'month';
    let custom = null;
    let title = Store.settings.reportTitle || '大学生活记账本';

    const seg = U.el('div', { class: 'seg' });
    const preview = U.el('div', { class: 'dp-preview' });

    const PERIODS = [
      { id: 'week', name: '本周' }, { id: 'month', name: '本月' },
      { id: 'lastMonth', name: '上月' }, { id: 'semester', name: '本学期' },
      { id: 'year', name: '今年' }, { id: 'all', name: '全部' },
      { id: 'custom', name: '自定义' }
    ];

    function range() { return Stats.range(period, custom); }
    function dataList() {
      const r = range();
      return Store.query({ from: r.from, to: r.to, includeExcluded: true, includeHidden: true });
    }

    function refresh() {
      const r = range();
      const list = dataList();
      const full = Stats.full(list);
      U.clear(preview);
      U.append(preview, [
        U.el('div', { text: r.label }),
        U.el('div', { html: '收入 <b>' + U.esc(U.fmtMoney(full.included.income)) + '</b>　' +
          '支出 <b>' + U.esc(U.fmtMoney(full.included.expense)) + '</b>　共 ' + list.length + ' 条记录' })
      ]);
    }

    function renderSeg() {
      U.clear(seg);
      PERIODS.forEach(function (it) {
        seg.appendChild(U.el('button', {
          class: it.id === period ? 'is-active' : '',
          text: it.name,
          onclick: function () {
            if (it.id === 'custom') {
              UI.pickCustomRange(function (r) { custom = r; period = 'custom'; renderSeg(); refresh(); });
              return;
            }
            period = it.id;
            renderSeg();
            refresh();
          }
        }));
      });
    }

    renderSeg();
    refresh();

    const body = U.el('div', null, [
      U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)', lineHeight: '1.85', margin: '0 0 12px' },
        text: '先选好时间范围，再选导出成表格还是图片。图片是一页纸的收支报告，直接发微信给爸妈看最合适。' }),
      seg,
      preview,
      U.el('div', { class: 'section-label', text: '图片报告的抬头' }),
      U.el('div', { class: 'field' }, [
        U.el('input', {
          class: 'input', value: title, maxlength: '24',
          placeholder: '例如：10 月生活费账目',
          oninput: (e) => { title = e.target.value; }
        }),
        U.el('div', { class: 'sheet-note', style: { margin: '6px 0 0' },
          text: '显示在图片最上方。可以写「10 月生活费账目」「给爸妈看的账」之类；留空就用「大学生活记账本」。' })
      ]),

      U.el('div', { class: 'section-label', text: '导出格式' }),
      U.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
        U.el('button', {
          class: 'btn btn-primary', text: '📊 导出 Excel 表格',
          onclick: function () {
            try {
              const name = Report.exportExcel({ list: dataList(), range: range() });
              UI.toast('已导出 ' + name + '，可用 Excel / WPS 打开', 'ok');
            } catch (e) { UI.toast('导出失败：' + e.message, 'err'); }
          }
        }),
        U.el('button', {
          class: 'btn', text: '🖼 生成图片报告',
          onclick: async function (e) {
            e.target.disabled = true;
            const oldLabel = e.target.textContent;
            e.target.textContent = '生成中…';
            try {
              const finalTitle = String(title || '').trim() || '大学生活记账本';
              await Store.updateSettings({ reportTitle: finalTitle });
              const name = await Report.exportImage({ list: dataList(), range: range(), title: finalTitle });
              UI.toast('已生成 ' + name, 'ok');
            } catch (err) { UI.toast('生成失败：' + err.message, 'err'); }
            e.target.disabled = false;
            e.target.textContent = oldLabel;
          }
        })
      ]),
      U.el('div', { class: 'sheet-note', html:
        '・Excel 表格含 4 个工作表：周期汇总、账目明细、分类汇总、每日收支<br>' +
        '・图片是浅色配色，适合直接发给家人<br>' +
        '・导出文件在本机生成，不会上传' })
    ]);

    UI.openSheet({ title: '导出报表', body: body, actions: [{ label: '关闭', onClick: function () { UI.closeSheet(); } }] });
  };

  /* ============================================================
     二、自动备份
     ============================================================ */
  UI.openBackupSheet = function () {
    const listBox = U.el('div');
    let enabled = Store.settings.autoBackup !== false;
    let interval = Store.settings.backupIntervalHours || 24;
    let keep = Store.settings.backupKeep || 10;

    async function refreshList() {
      U.clear(listBox);
      const list = (await Backup.list()).slice().sort(function (a, b) { return b.at - a.at; });
      if (!list.length) {
        listBox.appendChild(U.el('div', { class: 'empty' }, [
          U.el('span', { class: 'big', text: '💾' }),
          U.el('span', { text: '还没有备份，点上面的「立即备份」试试' })
        ]));
        return;
      }
      list.forEach(function (item) {
        listBox.appendChild(U.el('div', { class: 'cat-row' }, [
          U.el('div', { class: 'ci', text: '💾' }),
          U.el('div', { class: 'cn' }, [
            U.el('b', { text: Backup.timeText(item.at) + (item.reason === 'manual' ? '（手动）' : '') }),
            U.el('small', { text: item.txCount + ' 条账目 · ' + (item.catCount || 0) + ' 个分类 · ' + Backup.sizeText(item.size) })
          ]),
          U.el('div', { class: 'ops' }, [
            U.el('button', {
              class: 'btn btn-sm', text: '调用',
              onclick: async function () {
                const ok = await UI.confirm({
                  title: '调用这份备份',
                  message: '将用 ' + Backup.timeText(item.at) + ' 的快照覆盖当前全部账目。' +
                    '系统会先自动备份一份当前数据，所以不用怕点错。',
                  okText: '还原', danger: true
                });
                if (!ok) return;
                try {
                  await Backup.create('before-restore');
                  const r = await Backup.restore(item.key);
                  UI.closeSheet();
                  UI.toast('已还原 ' + r.tx + ' 条账目', 'ok');
                } catch (e) { UI.toast('还原失败：' + e.message, 'err'); }
              }
            }),
            U.el('button', {
              class: 'btn btn-sm', text: '导出',
              onclick: async function () {
                try {
                  const json = await Backup.read(item.key);
                  U.download('记账备份-' + U.toISODate(new Date(item.at)) + '.json', json, 'application/json');
                  UI.toast('已导出备份文件', 'ok');
                } catch (e) { UI.toast('导出失败：' + e.message, 'err'); }
              }
            }),
            U.el('button', {
              class: 'btn btn-sm btn-danger', text: '删除',
              onclick: async function () {
                await Backup.remove(item.key);
                refreshList();
                UI.renderSettings();
              }
            })
          ])
        ]));
      });
    }

    const intervalSeg = U.el('div', { class: 'seg' });
    [{ v: 12, n: '12 小时' }, { v: 24, n: '每天' }, { v: 72, n: '3 天' }, { v: 168, n: '每周' }].forEach(function (it) {
      intervalSeg.appendChild(U.el('button', {
        class: interval === it.v ? 'is-active' : '',
        text: it.n,
        onclick: async function () {
          interval = it.v;
          await Store.updateSettings({ backupIntervalHours: it.v });
          Array.prototype.forEach.call(intervalSeg.children, function (b) {
            b.classList.toggle('is-active', b.textContent === it.n);
          });
        }
      }));
    });

    const keepSeg = U.el('div', { class: 'seg' });
    [5, 10, 20, 30].forEach(function (v) {
      keepSeg.appendChild(U.el('button', {
        class: (keep === v ? 'is-active' : ''),
        text: v + ' 份',
        onclick: async function () {
          keep = v;
          await Store.updateSettings({ backupKeep: v });
          Array.prototype.forEach.call(keepSeg.children, function (b) {
            b.classList.toggle('is-active', b.textContent === v + ' 份');
          });
        }
      }));
    });

    const body = U.el('div', null, [
      U.el('p', { style: { fontSize: '12.5px', color: 'var(--text-soft)', lineHeight: '1.85', margin: '0 0 12px' }, text:
        '自动把整份数据在本机存一份快照，可以还原到过去某个时间点。' +
        (global.AndroidApp
          ? '安卓版还会同时把备份文件写进手机的「下载」目录，即使应用被卸载也还在。'
          : '电脑上运行的服务也会自动在 backups 目录留档。') }),

      U.el('div', { class: 'switch-row' }, [
        U.el('div', { class: 'sr-body' }, [
          U.el('div', { class: 'sr-title', text: '开启自动备份' }),
          U.el('div', { class: 'sr-desc', text: '打开应用时、以及记账之后，按下面的间隔自动备份' })
        ]),
        U.el('button', {
          class: 'switch' + (enabled ? ' is-on' : ''),
          onclick: async function (e) {
            enabled = !enabled;
            e.target.classList.toggle('is-on');
            await Store.updateSettings({ autoBackup: enabled });
            UI.renderSettings();
          }
        })
      ]),

      U.el('div', { class: 'section-label', text: '备份间隔' }),
      intervalSeg,
      U.el('div', { class: 'section-label', text: '最多保留' }),
      keepSeg,

      U.el('div', { style: { display: 'flex', gap: '8px', marginTop: '14px' } }, [
        U.el('button', {
          class: 'btn btn-primary', text: '立即备份',
          onclick: async function (e) {
            e.target.disabled = true;
            try {
              const info = await Backup.run(true);
              UI.toast(info ? '已备份 ' + info.txCount + ' 条账目' : '没有可备份的数据', info ? 'ok' : '');
              refreshList();
              UI.renderSettings();
            } catch (err) { UI.toast('备份失败：' + err.message, 'err'); }
            e.target.disabled = false;
          }
        })
      ]),

      U.el('div', { class: 'section-label', text: '备份记录' }),
      listBox
    ]);

    refreshList();
    UI.openSheet({
      title: '自动备份',
      body: body,
      actions: [{ label: '完成', primary: true, onClick: function () { UI.closeSheet(); } }]
    });
  };

  global.UI = UI;
})(window);
/* ============================================================
   ui.js - 界面渲染与交互（第八部分：分级清理数据）
   把原来笼统的「清空全部数据」拆成几档，每一项只清掉指定的那部分。
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U, Store = global.Store, Backup = global.Backup;
  const UI = global.UI;

  UI.openClearDataSheet = async function (opts) {
    opts = opts || {};

    let backupCount = 0;
    try { backupCount = (await Backup.list()).length; } catch (e) { /* 忽略 */ }

    const txCount = Store.tx.length;
    const catCount = Store.categories.length;

    function row(cfg) {
      return U.el('div', { class: 'clear-row' }, [
        U.el('div', { class: 'cr-head' }, [
          U.el('div', { class: 'cr-title', text: cfg.title }),
          U.el('div', { class: 'cr-desc', text: cfg.desc })
        ]),
        U.el('button', {
          class: 'btn btn-sm' + (cfg.danger ? ' btn-danger' : ''),
          text: cfg.button,
          disabled: cfg.disabled,
          onclick: async function () {
            const ok = await UI.confirm({
              title: cfg.title,
              message: cfg.message,
              okText: cfg.okText || cfg.button,
              danger: true
            });
            if (!ok) { UI.openClearDataSheet(opts); return; }

            let msg = '';
            try {
              msg = await cfg.run();
            } catch (e) {
              UI.toast('操作失败：' + (e && e.message ? e.message : '未知错误'), 'err');
              UI.openClearDataSheet(opts);
              return;
            }
            UI.toast(msg, 'ok');
            UI.renderSettings();
            UI.openClearDataSheet({ note: msg });
          }
        })
      ]);
    }

    const body = U.el('div');
    body.appendChild(U.el('p', {
      style: { fontSize: '12.5px', color: 'var(--text-soft)', lineHeight: '1.85', margin: '0 0 12px' },
      text: '下面每一项只清掉你选的那一部分，其余内容原样保留，不用再担心一次清过头。'
    }));

    if (opts.note) body.appendChild(U.el('div', { class: 'dp-preview', text: opts.note }));

    body.appendChild(U.el('div', { class: 'section-label', text: '分开清理' }));

    body.appendChild(row({
      title: '仅清空账单',
      desc: txCount
        ? '删除全部 ' + txCount + ' 条账目记录。分类、设置、备份都保留。'
        : '目前没有账目记录。',
      button: '清空账单',
      disabled: !txCount,
      message: '将删除全部 ' + txCount + ' 条账目记录，分类和设置会保留。此操作不可撤销。',
      okText: '清空账单',
      run: async function () {
        const n = await Store.clearTransactions();
        return '已清空 ' + n + ' 条账目记录';
      }
    }));

    body.appendChild(row({
      title: '仅清空分类',
      desc: catCount
        ? '删除全部 ' + catCount + ' 个分类，然后装回一套默认分类。已记录的账目会保留，仍然显示原来的分类名。'
        : '目前没有分类。',
      button: '清空分类',
      disabled: !catCount,
      message: '将删除 ' + catCount + ' 个分类，并恢复一套默认分类。账目记录不受影响。',
      okText: '清空分类',
      run: async function () {
        const r = await Store.clearCategories();
        return '已清空 ' + r.removed + ' 个分类，恢复 ' + r.added + ' 个默认分类';
      }
    }));

    body.appendChild(row({
      title: '仅清空设置',
      desc: '学期、自动分类规则、显示偏好等恢复默认值。账目和分类都保留。',
      button: '恢复默认',
      message: '将把学期、自动分类规则、显示偏好等设置恢复为默认值。账目和分类不受影响。',
      okText: '恢复默认',
      run: async function () {
        await Store.resetSettings();
        return '设置已恢复默认';
      }
    }));

    body.appendChild(row({
      title: '清空备份快照',
      desc: backupCount
        ? '删除本机保存的 ' + backupCount + ' 份自动备份快照。账目、分类、设置都不受影响。'
        : '目前没有备份快照。',
      button: '清空备份',
      disabled: !backupCount,
      message: '将删除本机的 ' + backupCount + ' 份自动备份快照，删除后无法再还原到这些时间点。',
      okText: '清空备份',
      run: async function () {
        const n = await Backup.clearAll();
        return '已删除 ' + n + ' 份备份快照';
      }
    }));

    const dangerBox = U.el('div', { class: 'clear-danger' });
    dangerBox.appendChild(U.el('div', { class: 'section-label', text: '全部清除' }));
    dangerBox.appendChild(row({
      title: '⚠️ 清除所有数据',
      desc: '账目、分类、设置、备份快照全部删除，且无法恢复。' +
        (txCount || catCount ? '（当前有 ' + txCount + ' 条账目、' + catCount + ' 个分类）' : ''),
      button: '清除所有',
      danger: true,
      message: '账目、分类、设置、应用内备份快照将全部删除，无法恢复。确定要继续吗？',
      okText: '我已备份，继续',
      run: async function () {
        const r = await Store.wipeAll();
        return '已清除全部数据（账目 ' + r.tx + ' 条、分类 ' + r.categories + ' 个）';
      }
    }));
    body.appendChild(dangerBox);

    body.appendChild(U.el('div', { class: 'sheet-note', html:
      '・以上操作只作用于本机；如果其它设备还连着同步，删除会在下次同步时一并同步过去，不会倒灌回来。<br>' +
      '・「清空备份快照」删掉之后就再也还原不回那些时间点了，请谨慎。' }));

    UI.openSheet({
      title: '清理数据',
      body: body,
      actions: [{ label: '关闭', primary: true, onClick: function () { UI.closeSheet(); } }]
    });
  };

  global.UI = UI;
})(window);