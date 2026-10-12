/* ============================================================
   holiday.js - 节假日数据与提醒（测试版）

   为什么单独一个文件：节假日要联网取，而且要按「开始前 / 结束前」
   提醒用户「这段时间要不要不计入统计」。这块逻辑独立出来，
   不影响主程序离线可用（取不到数据就什么都不提醒）。

   数据来源默认用公开的节假日接口，也可以在设置里换成别的地址，
   或者直接把 JSON 粘贴进来。取到的数据存在设置里，跟着同步走。
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U, Store = global.Store;
  const LS_KEY = 'jzb:holiday-source';
  const DEFAULT_SOURCE = 'https://timor.tech/api/holiday/year/{year}';
  const DAY = 24 * 3600 * 1000;

  const H = {};

  /* ---------------- 数据源 ---------------- */
  H.defaultSource = DEFAULT_SOURCE;
  H.source = function () {
    try {
      const v = localStorage.getItem(LS_KEY);
      if (v) return v;
    } catch (e) { /* 忽略 */ }
    return DEFAULT_SOURCE;
  };
  H.saveSource = function (url) {
    const s = String(url || '').trim() || DEFAULT_SOURCE;
    try { localStorage.setItem(LS_KEY, s); } catch (e) { /* 忽略 */ }
    return s;
  };

  /* ---------------- 取数据 ----------------
     三条路，按顺序试：
       1. 安卓外壳的原生请求（不受跨源限制）
       2. 电脑上的服务代取（浏览器受跨源限制时靠这个）
       3. 直连（服务商允许跨源时可用） */
  async function request(url) {
    if (global.AndroidApp && typeof global.AndroidApp.httpGet === 'function') {
      const res = await U.nativeHttp('GET', url);
      if (!res.status) throw new Error(res.text || '请求失败');
      if (res.status < 200 || res.status >= 300) throw new Error('返回 HTTP ' + res.status);
      return res.text;
    }

    const sameOrigin = global.location && /^https?:$/.test(global.location.protocol);
    const proxyBase = (global.Sync && global.Sync.baseUrl && global.Sync.baseUrl()) || '';
    if (sameOrigin || proxyBase) {
      try {
        const res = await fetch(proxyBase + '/api/fetch?url=' + encodeURIComponent(url), { credentials: 'include' });
        const j = await res.json();
        if (j && j.ok) {
          if (j.status >= 200 && j.status < 300) return j.body;
          throw new Error('返回 HTTP ' + j.status);
        }
        if (j && j.error) throw new Error(j.error);
      } catch (e) {
        const m = String(e && e.message ? e.message : '');
        if (/返回 HTTP|不允许|只支持|获取失败/.test(m)) throw new Error(m);
      }
    }

    const res = await fetch(url);
    if (!res.ok) throw new Error('返回 HTTP ' + res.status);
    return res.text();
  }
  H.request = request;

  /* ---------------- 解析 ----------------
     各家接口的字段名不一样，这里都认：
       - timor.tech： { holiday: { '01-01': { holiday: true, name: '元旦', date: '2027-01-01' } } }
       - apihubs：    { data: { list: [ { date: '20270101', holiday: 1, name: '元旦' } ] } }
       - 普通数组：    [ { name: '寒假', start: '2027-01-20', end: '2027-02-20' } ]
       - 普通数组：    [ { name: '元旦', date: '2027-01-01' } ] */
  function normDate(d) {
    if (!d) return '';
    const s = String(d).trim();
    let y, m, day;
    let mt = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (mt) { y = mt[1]; m = mt[2]; day = mt[3]; }
    else {
      mt = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
      if (mt) { y = mt[1]; m = mt[2]; day = mt[3]; }
      else {
        mt = /^(\d{1,2})-(\d{1,2})$/.exec(s);   // timor 的 '01-01'，年份从 date 字段补
        if (mt) return '';
        return '';
      }
    }
    return y + '-' + ('0' + m).slice(-2) + '-' + ('0' + day).slice(-2);
  }

  function isHolidayFlag(v) {
    if (v === undefined || v === null) return true;
    if (v === false || v === 0 || v === '0' || v === 'false') return false;
    return true;
  }

  H.parse = function (json) {
    const days = [];
    const push = (name, date) => {
      const d = normDate(date);
      if (!d) return;
      days.push({ name: String(name || '假期').trim() || '假期', date: d });
    };

    const walkList = (arr) => {
      arr.forEach((x) => {
        if (!x) return;
        if (typeof x === 'string') { push('假期', x); return; }
        const name = x.name || x.holidayName || x.title || x.cn || '假期';
        if (x.start || x.startDate || x.end || x.endDate) {
          push(name, x.start || x.startDate);
          if (x.end || x.endDate) { push(name + '\u0000END', x.end || x.endDate); }
          return;
        }
        if (!isHolidayFlag(x.holiday)) return;   // 调休上班日不算假期
        push(name, x.date || x.day);
      });
    };

    if (Array.isArray(json)) walkList(json);
    else if (json && Array.isArray(json.holidays)) walkList(json.holidays);
    else if (json && Array.isArray(json.list)) walkList(json.list);
    else if (json && json.data && Array.isArray(json.data.list)) walkList(json.data.list);
    else if (json && json.holiday && typeof json.holiday === 'object') {
      Object.keys(json.holiday).forEach((k) => {
        const x = json.holiday[k] || {};
        if (!isHolidayFlag(x.holiday)) return;
        push(x.name || '假期', x.date || x.day || k);
      });
    }

    /* 连续的同名日期合并成一段区间（元旦 1/1-1/3 这样） */
    const byName = new Map();
    const ends = new Map();
    days.forEach((d) => {
      if (d.name.indexOf('\u0000END') >= 0) {
        ends.set(d.name.replace('\u0000END', ''), d.date);
        return;
      }
      if (!byName.has(d.name)) byName.set(d.name, []);
      byName.get(d.name).push(d.date);
    });

    const out = [];
    byName.forEach((dates, name) => {
      const uniq = Array.from(new Set(dates)).sort();
      let start = uniq[0], prev = uniq[0];
      for (let i = 1; i <= uniq.length; i++) {
        const cur = uniq[i];
        const gap = cur ? U.daysBetween(U.fromISO(prev), U.fromISO(cur)) : 99;
        if (!cur || gap > 1) {
          const forced = ends.get(name);
          out.push({ key: name + '|' + start, name: name, start: start, end: forced && forced > prev ? forced : prev });
          if (cur) { start = cur; prev = cur; }
        } else {
          prev = cur;
        }
      }
    });
    out.sort((a, b) => (a.start < b.start ? -1 : (a.start > b.start ? 1 : 0)));
    return out;
  };

  /* ---------------- 缓存 ---------------- */
  H.cached = function () {
    const d = Store.settings.holidayData;
    return (d && Array.isArray(d.list)) ? d.list : [];
  };

  H.saveFetched = async function (list, source) {
    const old = H.cached();
    const map = new Map();
    old.concat(list || []).forEach((h) => { if (h && h.key) map.set(h.key, h); });
    const merged = Array.from(map.values()).sort((a, b) => (a.start < b.start ? -1 : 1));
    await Store.updateSettings({
      holidayData: { fetchedAt: Date.now(), source: source || H.source(), list: merged }
    });
    return merged;
  };

  H.fetchYear = async function (year) {
    const src = H.source().replace('{year}', String(year));
    const text = await request(src);
    let json;
    try { json = JSON.parse(text); }
    catch (e) { throw new Error('返回的不是 JSON，可以换个数据源或手动粘贴'); }
    const list = H.parse(json);
    if (!list.length) throw new Error('没能从数据里认出节假日（可能这个年份还没公布）');
    const merged = await H.saveFetched(list, src);
    return list.length ? merged : merged;
  };

  H.parseText = async function (text) {
    let json;
    try { json = JSON.parse(text); }
    catch (e) { throw new Error('粘贴的内容不是合法 JSON'); }
    const list = H.parse(json);
    if (!list.length) throw new Error('没能从内容里认出节假日');
    return H.saveFetched(list, '手动粘贴');
  };

  /* ---------------- 提醒 ----------------
     假期开始前几天、结束前几天各提醒一次；
     用户处理过（设为假期 / 照常计入）之后就不再提醒。 */
  H.mark = async function (key, state) {
    const map = Object.assign({}, Store.settings.holidayPrompts || {});
    map[key] = state;
    await Store.updateSettings({ holidayPrompts: map });
  };

  H.isHandled = function (key) {
    return !!(Store.settings.holidayPrompts || {})[key];
  };

  H.suggestions = function (now) {
    const list = H.cached();
    if (!list.length) return [];
    if (Store.settings.vacationExclude === false) return [];
    const days = Number(Store.settings.holidayRemindDays) || 7;
    const t = (now ? new Date(now) : new Date()).getTime();
    const out = [];
    list.forEach((h) => {
      if (!h || !h.start || !h.end) return;
      if (H.isHandled(h.key)) return;
      if (Store.vacations().some((v) => !(v.end < h.start || v.start > h.end))) return;  // 已经覆盖到了
      const start = U.startOfDay(U.fromISO(h.start)).getTime();
      const endAll = U.endOfDay(U.fromISO(h.end)).getTime();
      if (t < start) {
        const left = Math.max(0, Math.ceil((start - t) / DAY));
        if (left <= days) out.push({ holiday: h, kind: 'before', left: left });
        return;
      }
      if (t <= endAll) {
        const left = Math.max(0, Math.ceil((endAll - t) / DAY));
        if (left <= days) out.push({ holiday: h, kind: 'during', left: left });
      }
    });
    return out;
  };

  global.Holiday = H;
})(window);
