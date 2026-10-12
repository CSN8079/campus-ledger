/* ============================================================
   util.js - 通用工具函数（无依赖）
   ============================================================ */
(function (global) {
  'use strict';

  const U = {};

  /* ---------- 选择器 ---------- */
  U.$ = (sel, root) => (root || document).querySelector(sel);
  U.$$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  /* ---------- DOM 构建 ----------
     用法： el('div', {class:'a', onclick:fn}, ['文本', el('b')])  */
  U.el = function (tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    U.append(node, children);
    return node;
  };

  U.append = function (node, children) {
    if (children === null || children === undefined || children === false) return node;
    if (Array.isArray(children)) { children.forEach((c) => U.append(node, c)); return node; }
    node.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
    return node;
  };

  U.clear = function (node) { while (node.firstChild) node.removeChild(node.firstChild); return node; };

  U.esc = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /* ---------- 数值 ---------- */
  U.round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  U.parseAmount = function (raw) {
    if (typeof raw === 'number') return U.round2(raw);
    let s = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!s) return 0;
    s = s.replace(/[¥￥$,\s]/g, '').replace(/元$/, '');
    const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
    s = s.replace(/[()]/g, '').replace(/^[-+]/, '');
    const v = parseFloat(s);
    if (!isFinite(v)) return 0;
    return U.round2(neg ? -v : v);
  };

  U.fmtMoney = function (n, opts) {
    opts = opts || {};
    const num = Number(n) || 0;
    const fixed = opts.fixed === undefined ? 2 : opts.fixed;
    const body = Math.abs(num).toFixed(fixed).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const sym = opts.noSymbol ? '' : '¥';
    if (opts.sign) return (num > 0 ? '+' : num < 0 ? '-' : '') + sym + body;
    return (num < 0 ? '-' : '') + sym + body;
  };

  /* 紧凑金额：12345 -> 1.23万 */
  U.fmtCompact = function (n) {
    const v = Number(n) || 0;
    const a = Math.abs(v);
    if (a >= 100000000) return (v / 100000000).toFixed(2) + '亿';
    if (a >= 10000) return (v / 10000).toFixed(a >= 100000 ? 1 : 2) + '万';
    return v.toFixed(a >= 1000 ? 0 : 2);
  };

  U.pct = (part, total) => (total ? (part / total) * 100 : 0);

  /* ---------- 日期 ---------- */
  const pad = (n) => (n < 10 ? '0' + n : '' + n);

  U.startOfDay = function (d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  U.endOfDay = function (d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };

  /* weekStart: 0=周日 1=周一 */
  U.startOfWeek = function (d, weekStart) {
    const ws = weekStart === 0 ? 0 : 1;
    const x = U.startOfDay(d);
    const diff = (x.getDay() - ws + 7) % 7;
    x.setDate(x.getDate() - diff);
    return x;
  };
  U.endOfWeek = function (d, weekStart) { const x = U.startOfWeek(d, weekStart); x.setDate(x.getDate() + 6); return U.endOfDay(x); };

  U.startOfMonth = function (d) { const x = new Date(d); x.setDate(1); return U.startOfDay(x); };
  U.endOfMonth = function (d) { const x = new Date(d); x.setMonth(x.getMonth() + 1, 1); x.setDate(0); return U.endOfDay(x); };

  U.addDays = function (d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  U.addMonths = function (d, n) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };

  U.toISODate = function (d) { const x = new Date(d); return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()); };
  U.toISODateTimeLocal = function (d) { const x = new Date(d); return U.toISODate(x) + 'T' + pad(x.getHours()) + ':' + pad(x.getMinutes()); };
  U.fromISO = function (s) {
    if (!s) return new Date();
    if (s instanceof Date) return s;
    const t = Date.parse(String(s).replace(' ', 'T'));
    return isNaN(t) ? new Date() : new Date(t);
  };
  U.todayISO = () => U.toISODate(new Date());

  U.fmtDate = function (d, style) {
    const x = new Date(d);
    const y = x.getFullYear(), m = pad(x.getMonth() + 1), day = pad(x.getDate());
    if (style === 'md') return m + '-' + day;
    if (style === 'ymd') return y + '-' + m + '-' + day;
    if (style === 'cn') return y + '年' + (x.getMonth() + 1) + '月' + x.getDate() + '日';
    return m + '-' + day;
  };
  U.fmtDateTime = function (d) {
    const x = new Date(d);
    return U.fmtDate(x, 'ymd') + ' ' + pad(x.getHours()) + ':' + pad(x.getMinutes());
  };

  const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  U.weekdayCN = (d) => WEEK_CN[new Date(d).getDay()];

  /* 相对日期描述：今天 / 昨天 / 前天 / 07-12 周二 */
  U.fmtDayLabel = function (d) {
    const x = U.startOfDay(d);
    const today = U.startOfDay(new Date());
    const diff = Math.round((today - x) / 86400000);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff === 2) return '前天';
    const y = new Date();
    const opts = { month: '2-digit', day: '2-digit' };
    const base = (x.getMonth() + 1) + '月' + x.getDate() + '日';
    return base + (x.getFullYear() === y.getFullYear() ? '' : ' ' + x.getFullYear()) + ' ' + U.weekdayCN(x);
  };

  U.daysBetween = function (a, b) {
    const x = U.startOfDay(a), y = U.startOfDay(b);
    return Math.round((y - x) / 86400000);
  };

  /* 生成 [start, end] 之间每一天 */
  U.eachDay = function (start, end) {
    const out = []; let cur = U.startOfDay(start);
    const last = U.startOfDay(end);
    let guard = 0;
    while (cur <= last && guard++ < 2000) { out.push(new Date(cur)); cur = U.addDays(cur, 1); }
    return out;
  };

  U.eachMonth = function (start, end) {
    const out = []; let cur = U.startOfMonth(start);
    const last = U.startOfMonth(end);
    let guard = 0;
    while (cur <= last && guard++ < 600) { out.push(new Date(cur)); cur = U.addMonths(cur, 1); }
    return out;
  };

  /* ---------- 杂项 ---------- */
  U.uuid = function () {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  };

  U.debounce = function (fn, wait) {
    let t = null;
    return function () {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, args), wait || 220);
    };
  };

  /* 简单 LRU 无关；用于浅比较对象字段是否变化 */
  U.pick = function (obj, keys) {
    const o = {};
    keys.forEach((k) => { o[k] = obj ? obj[k] : undefined; });
    return o;
  };

  U.clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  U.groupBy = function (arr, keyFn) {
    const map = new Map();
    arr.forEach((item) => {
      const k = keyFn(item);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(item);
    });
    return map;
  };

  U.sumBy = (arr, fn) => arr.reduce((s, x) => s + (Number(fn(x)) || 0), 0);

  U.sortBy = function (arr, fn, desc) {
    return arr.slice().sort((a, b) => {
      const va = fn(a), vb = fn(b);
      if (va === vb) return 0;
      return (va < vb ? -1 : 1) * (desc ? -1 : 1);
    });
  };

  /* 下载文本/二进制为文件
     在安卓 App（WebView）内改走原生接口，保存到系统的「下载」目录；
     在浏览器里则用标准的 Blob 下载。 */
  /* 在安卓外壳里发起一次网络请求，彻底绕开网页的跨源限制。
     外壳会把结果通过 window.__aiCallbacks[id](状态码, base64 正文) 回传。 */
  U.nativeHttp = function (method, url, headers, body) {
    return new Promise(function (resolve, reject) {
      const A = global.AndroidApp;
      const canGet = A && typeof A.httpGet === 'function';
      const canPost = A && typeof A.httpPost === 'function';
      if ((method === 'GET' && !canGet) || (method !== 'GET' && !canPost)) {
        reject(new Error('这台设备没有原生请求能力'));
        return;
      }
      const id = 'nh' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      global.__aiCallbacks = global.__aiCallbacks || {};
      const timer = setTimeout(function () {
        delete global.__aiCallbacks[id];
        reject(new Error('请求超时'));
      }, 25000);
      global.__aiCallbacks[id] = function (status, b64) {
        clearTimeout(timer);
        delete global.__aiCallbacks[id];
        let text = '';
        try {
          const bin = atob(String(b64 || ''));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          text = new TextDecoder('utf-8').decode(bytes);
        } catch (e) { text = ''; }
        resolve({ status: Number(status) || 0, text: text });
      };
      try {
        if (method === 'GET') A.httpGet(id, url, JSON.stringify(headers || {}));
        else A.httpPost(id, url, JSON.stringify(headers || {}), JSON.stringify(body || {}));
      } catch (e) {
        clearTimeout(timer);
        delete global.__aiCallbacks[id];
        reject(new Error('调用系统请求失败：' + e.message));
      }
    });
  };

  U.download = function (filename, data, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'text/plain;charset=utf-8' });

    if (global.AndroidApp && typeof global.AndroidApp.save === 'function') {
      const fr = new FileReader();
      fr.onload = function () {
        const s = String(fr.result || '');
        const comma = s.indexOf(',');
        try { global.AndroidApp.save(filename, comma >= 0 ? s.slice(comma + 1) : s); }
        catch (e) { console.error('保存失败', e); }
      };
      fr.readAsDataURL(blob);
      return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 400);
  };

  /* CSV 生成（含 BOM，Excel 打开中文不乱码） */
  U.toCSV = function (rows) {
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return '\ufeff' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
  };

  /* 颜色工具：十六进制 -> rgba */
  U.hexToRgba = function (hex, alpha) {
    let h = String(hex || '#888888').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  };

  const PALETTE = ['#4f46e5', '#e5484d', '#12a594', '#f59e0b', '#8b5cf6', '#ec4899',
    '#0ea5e9', '#84cc16', '#f97316', '#14b8a6', '#6366f1', '#a855f7', '#ef4444', '#22c55e', '#0891b2'];
  U.PALETTE = PALETTE;
  U.colorFromString = function (s) {
    let h = 0;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  };

  global.U = U;
})(window);