/* ============================================================
   datetime.js - 自绘的日期 / 日期时间选择器

   为什么自己画：安卓 WebView 与各家浏览器弹出的系统日期控件
   样式不统一、观感差，还会遮挡表单。这里用独立浮层实现，
   不会影响下面正在填写的记账表单。

   独立浮层：pickerRoot（比 sheetRoot 更高一层），
   因此日历弹出时，记账表单依然保留在下面，选完即回。
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U;
  const UI = global.UI;
  const $ = U.$;

  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const MONTH_CN = ['一月', '二月', '三月', '四月', '五月', '六月',
    '七月', '八月', '九月', '十月', '十一月', '十二月'];
  /* 分钟给全 0-59，这样时间能精确到 1 分钟（以前是 5 分钟一档） */
  const MINUTES = [];
  for (let i = 0; i < 60; i++) MINUTES.push(i);

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }

  /* ---------------- 浮层管理 ---------------- */
  let layerCloser = null;
  let layerCloseTimer = null;

  function layerRoot() { return document.getElementById('pickerRoot'); }

  function openLayer(title, bodyNodes) {
    const root = layerRoot();
    if (!root) return;
    // 同上：取消上一次关闭挂着的延时清理，避免把新浮层抹掉
    if (layerCloseTimer) { clearTimeout(layerCloseTimer); layerCloseTimer = null; }
    U.clear(root);
    const sheet = U.el('div', { class: 'sheet' }, [
      U.el('div', { class: 'sheet-grip' }),
      U.el('div', { class: 'sheet-head' }, [
        U.el('h3', { text: title }),
        U.el('button', { class: 'icon-btn', title: '关闭', text: '✕', onclick: () => closeLayer() })
      ])
    ]);
    U.append(sheet, bodyNodes);
    root.appendChild(U.el('div', { class: 'sheet-mask', onclick: () => closeLayer() }));
    root.appendChild(sheet);
    requestAnimationFrame(() => root.classList.add('is-open'));
  }

  function closeLayer() {
    const root = layerRoot();
    const cb = layerCloser;
    layerCloser = null;
    if (!root) { if (cb) cb(); return; }
    if (!root.classList.contains('is-open')) { if (cb) cb(); return; }
    root.classList.remove('is-open');
    if (layerCloseTimer) clearTimeout(layerCloseTimer);
    layerCloseTimer = setTimeout(() => { layerCloseTimer = null; U.clear(root); if (cb) cb(); }, 280);
  }
  UI.closePickerLayer = closeLayer;

  /* ---------------- 解析与格式化 ---------------- */
  function parseValue(v, withTime) {
    const now = new Date();
    const fb = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate(), hh: now.getHours(), mm: now.getMinutes() };
    if (!v) return withTime ? fb : { y: fb.y, m: fb.m, d: fb.d, hh: 0, mm: 0 };
    const s = String(v).replace('T', ' ').trim();
    const dp = s.slice(0, 10).split('-');
    if (dp.length < 3) return fb;
    const out = {
      y: parseInt(dp[0], 10) || fb.y,
      m: parseInt(dp[1], 10) || 1,
      d: parseInt(dp[2], 10) || 1,
      hh: 0, mm: 0
    };
    const tp = s.slice(11);
    if (tp) {
      const parts = tp.split(':');
      out.hh = parseInt(parts[0], 10) || 0;
      out.mm = parseInt(parts[1], 10) || 0;
    } else if (withTime) {
      out.hh = fb.hh; out.mm = fb.mm;
    }
    return out;
  }

  function toValue(p, withTime) {
    const base = p.y + '-' + pad2(p.m) + '-' + pad2(p.d);
    return withTime ? base + 'T' + pad2(p.hh) + ':' + pad2(p.mm) : base;
  }

  UI.fmtDateLabel = function (value, withTime) {
    if (!value) return '';
    const p = parseValue(value, withTime);
    const d = new Date(p.y, p.m - 1, p.d);
    return p.y + '年' + p.m + '月' + p.d + '日 周' + WEEK[d.getDay()] +
      (withTime ? '  ' + pad2(p.hh) + ':' + pad2(p.mm) : '');
  };

  /* ---------------- 日期选择面板 ---------------- */
  UI.openDatePicker = function (opts) {
    opts = opts || {};
    const withTime = !!opts.withTime;
    const state = parseValue(opts.value, withTime);
    let viewY = state.y, viewM = state.m;
    let mode = 'calendar';   // calendar | month

    const container = U.el('div');

    /* ---- 年月导航 ---- */
    function navBar(onLabel) {
      const nav = U.el('div', { class: 'dp-nav' }, [
        U.el('button', {
          class: 'icon-btn', text: '‹', title: '上个月',
          onclick: () => { viewM--; if (viewM < 1) { viewM = 12; viewY--; } render(); }
        }),
        U.el('button', { class: 'dp-ym', onclick: onLabel }, [
          U.el('span', { text: viewY + '年' }),
          U.el('span', { class: 'dp-ym-month', text: MONTH_CN[viewM - 1] })
        ]),
        U.el('button', {
          class: 'icon-btn', text: '›', title: '下个月',
          onclick: () => { viewM++; if (viewM > 12) { viewM = 1; viewY++; } render(); }
        })
      ]);
      return nav;
    }

    /* ---- 快捷日期 ---- */
    function quickBar() {
      const box = U.el('div', { class: 'dp-quick' });
      const now = new Date();
      [['今天', 0], ['昨天', -1], ['前天', -2], ['一周前', -7]].forEach(([name, off]) => {
        const d = U.addDays(now, off);
        box.appendChild(U.el('button', {
          class: 'chip', text: name,
          onclick: () => {
            state.y = d.getFullYear(); state.m = d.getMonth() + 1; state.d = d.getDate();
            viewY = state.y; viewM = state.m;
            render();
          }
        }));
      });
      return box;
    }

    /* ---- 日历网格 ---- */
    function calendarView() {
      const grid = U.el('div', { class: 'dp-grid' });
      WEEK.forEach((w) => grid.appendChild(U.el('div', { class: 'dp-week', text: w })));

      const lead = new Date(viewY, viewM - 1, 1).getDay();
      const total = daysInMonth(viewY, viewM);
      const prevTotal = daysInMonth(viewY, viewM === 1 ? 12 : viewM - 1);
      const today = new Date();
      const cells = [];

      for (let i = lead - 1; i >= 0; i--) cells.push({ y: viewY, m: viewM - 1, d: prevTotal - i, other: true });
      for (let d = 1; d <= total; d++) cells.push({ y: viewY, m: viewM, d: d, other: false });
      let next = 1;
      while (cells.length < 35) cells.push({ y: viewY, m: viewM + 1, d: next++, other: true });

      cells.forEach((c) => {
        let cy = c.y, cm = c.m;
        if (cm < 1) { cm = 12; cy--; }
        if (cm > 12) { cm = 1; cy++; }
        const cls = ['dp-cell'];
        if (c.other) cls.push('is-other');
        if (cy === today.getFullYear() && cm === today.getMonth() + 1 && c.d === today.getDate()) cls.push('is-today');
        if (cy === state.y && cm === state.m && c.d === state.d) cls.push('is-sel');
        grid.appendChild(U.el('button', {
          class: cls.join(' '), text: String(c.d),
          onclick: () => {
            state.y = cy; state.m = cm; state.d = c.d;
            if (c.other) { viewY = cy; viewM = cm; }
            render();
          }
        }));
      });
      return grid;
    }

    /* ---- 年月快速选择 ---- */
    function monthView(yearOnly) {
      const box = U.el('div', null, [
        U.el('div', { class: 'dp-nav' }, [
          U.el('button', { class: 'icon-btn', text: '‹', onclick: () => { viewY--; render(); } }),
          U.el('div', { class: 'dp-ym' }, [U.el('span', { text: viewY + '年' })]),
          U.el('button', { class: 'icon-btn', text: '›', onclick: () => { viewY++; render(); } })
        ])
      ]);
      const list = U.el('div', { class: 'dp-month-grid' });
      MONTH_CN.forEach((name, i) => {
        const sel = yearOnly
          ? (viewY < state.y || (viewY === state.y && i + 1 <= state.m))
          : (viewY === state.y && i + 1 === state.m);
        list.appendChild(U.el('button', {
          class: 'dp-tcell' + (sel ? ' is-sel' : ''),
          text: name,
          onclick: () => {
            viewM = i + 1;
            mode = 'calendar';
            render();
          }
        }));
      });
      box.appendChild(list);
      return box;
    }

    /* ---- 时间选择 ---- */
    function timeView() {
      const box = U.el('div', { class: 'dp-time' });
      if (!withTime) return box;

      box.appendChild(U.el('div', { class: 'section-label', text: '时间' }));
      const presetRow = U.el('div', { class: 'chips', style: { marginBottom: '10px' } });
      [['现在', null], ['08:00', 8], ['12:00', 12], ['18:00', 18], ['22:00', 22]].forEach(([name, hour]) => {
        presetRow.appendChild(U.el('button', {
          class: 'chip', text: name,
          onclick: () => {
            if (hour === null) { const n = new Date(); state.hh = n.getHours(); state.mm = n.getMinutes(); }
            else { state.hh = hour; state.mm = 0; }
            render();
          }
        }));
      });
      box.appendChild(presetRow);

      box.appendChild(U.el('div', { class: 'dp-time-label', text: '时' }));
      const hourGrid = U.el('div', { class: 'dp-time-grid' });
      for (let h = 0; h < 24; h++) {
        hourGrid.appendChild(U.el('button', {
          class: 'dp-tcell' + (h === state.hh ? ' is-sel' : ''), text: pad2(h),
          onclick: () => { state.hh = h; render(); }
        }));
      }
      box.appendChild(hourGrid);

      box.appendChild(U.el('div', { class: 'dp-time-label', text: '分' }));
      const minGrid = U.el('div', { class: 'dp-time-grid min' });
      const minutes = MINUTES.slice();
      if (minutes.indexOf(state.mm) < 0) minutes.push(state.mm);
      minutes.sort((a, b) => a - b);
      minutes.forEach((m) => {
        minGrid.appendChild(U.el('button', {
          class: 'dp-tcell' + (m === state.mm ? ' is-sel' : ''), text: pad2(m),
          onclick: () => { state.mm = m; render(); }
        }));
      });
      box.appendChild(minGrid);
      return box;
    }

    /* 重画时必须保住滚动位置。
       之前是「先清空再重建」，清空的一瞬间面板变矮、滚动位置被强行归零，
       于是点一下分钟，整个面板就跳回最上面。 */
    function render() {
      const sheetEl = container.parentNode;          // .sheet 才是滚动容器
      const keep = sheetEl ? sheetEl.scrollTop : 0;

      const next = document.createDocumentFragment();
      if (mode === 'month') {
        next.appendChild(monthView(false));
      } else {
        next.appendChild(quickBar());
        const cal = U.el('div', { class: 'dp-calendar' });
        cal.appendChild(navBar(() => { mode = 'month'; render(); }));
        cal.appendChild(calendarView());
        next.appendChild(cal);
        next.appendChild(timeView());
        next.appendChild(U.el('div', { class: 'dp-preview' }, [
          U.el('span', { text: '已选：' }),
          U.el('b', { text: UI.fmtDateLabel(toValue(state, withTime), withTime) })
        ]));
      }

      U.clear(container);
      container.appendChild(next);
      if (sheetEl && keep) {
        sheetEl.scrollTop = keep;
        requestAnimationFrame(function () { sheetEl.scrollTop = keep; });
      }
    }

    render();

    const actions = U.el('div', { class: 'sheet-actions' }, [
      U.el('button', {
        class: 'btn btn-primary', text: '确定',
        onclick: () => {
          const v = toValue(state, withTime);
          layerCloser = null;
          closeLayer();
          if (opts.onDone) opts.onDone(v);
        }
      }),
      U.el('button', { class: 'btn', text: '取消', onclick: () => closeLayer() })
    ]);

    layerCloser = null;
    openLayer(opts.title || (withTime ? '选择日期和时间' : '选择日期'), [container, actions]);
  };

  /* ---------------- 可复用的日期字段（代替原生输入框） ----------------
     opts: { value, withTime, placeholder, onChange(value) } */
  UI.dateField = function (opts) {
    opts = opts || {};
    const withTime = !!opts.withTime;
    let value = opts.value || '';

    const label = U.el('span', { class: 'df-text' });
    const node = U.el('button', {
      class: 'date-field', type: 'button',
      onclick: () => {
        UI.openDatePicker({
          value: value,
          withTime: withTime,
          onDone: (v) => {
            value = v;
            sync();
            if (opts.onChange) opts.onChange(v);
          }
        });
      }
    }, [label, U.el('span', { class: 'df-ico', text: withTime ? '🗓' : '📅' })]);

    function sync() {
      if (value) {
        label.textContent = UI.fmtDateLabel(value, withTime);
        label.classList.remove('is-empty');
      } else {
        label.textContent = opts.placeholder || (withTime ? '选择日期和时间' : '选择日期');
        label.classList.add('is-empty');
      }
    }
    sync();

    node.getValue = function () { return value; };
    node.setValue = function (v) { value = v; sync(); };
    return node;
  };

  global.UI = UI;
})(window);