/* ============================================================
   ai.js - 内置 AI 助手
   用途：用自然语言让 AI 帮你批量整理账目，例如
        「把杭州深度求索的 API 充值从其他改成数码」

   三种请求通道，自动降级：
     1. 安卓 App：走原生 httpPost，完全不受跨源限制（推荐）
     2. 浏览器 + 电脑服务在线：由电脑上的服务代为转发
     3. 直接请求：部分服务商允许跨源时可用

   安全：动作不会自己执行。AI 只提出建议，界面上先展示「会影响 N 条」，
        用户点确认之后才真正改动。
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U, Store = global.Store, Stats = global.Stats;
  const LS_KEY = 'jzb:ai';
  const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const AI = {
    config: {
      endpoint: 'https://api.deepseek.com',
      apiKey: '',
      model: 'deepseek-chat',
      enabled: false
    },
    messages: [],     // 对话记录，只放在内存里，不落盘
    busy: false,
    lastError: ''
  };

  /* ---------------- 配置 ---------------- */
  AI.load = function () {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) Object.assign(AI.config, JSON.parse(raw));
    AI.updateNativeHosts();
    } catch (e) { /* 忽略 */ }
  };

  AI.save = function () {
    try { localStorage.setItem(LS_KEY, JSON.stringify(AI.config)); } catch (e) { /* 忽略 */ }
    AI.updateNativeHosts();
  };

  AI.available = function () {
    return !!(String(AI.config.endpoint || '').trim() && String(AI.config.apiKey || '').trim() && String(AI.config.model || '').trim());
  };

  AI.endpointUrl = function () {
    const base = String(AI.config.endpoint || '').trim().replace(/\/+$/, '');
    if (!base) return '';
    return /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  };

  /* 把 AI 接口的主机名报给安卓外壳，否则请求会被外壳拦掉 */
  AI.syncHostToNative = function () {
    if (!global.AndroidApp || typeof global.AndroidApp.setAiHost !== 'function') return;
    let host = '';
    try {
      const u = AI.endpointUrl();
      if (u && typeof URL !== 'undefined') host = new URL(u).hostname;
    } catch (e) { host = ''; }
    try { global.AndroidApp.setAiHost(host || ''); } catch (e) { /* 忽略 */ }
  };

  /* 电脑地址和 AI 地址一起报上去（外壳会两个都放行） */
  AI.updateNativeHosts = function () {
    if (!global.AndroidApp) return;
    if (typeof global.updateNativeHosts === 'function') global.updateNativeHosts();
    else AI.syncHostToNative();
  };

  /* ---------------- 数据摘要 ----------------
     把账目喂给模型，让它能真正「看见」数据：
       1. 有哪些分类、来源、用途（理解「杭州深度求索」这类说法）
       2. 各周期的收入/支出/结余（应用自己算的，绝对准确）
       3. 逐笔明细，含金额、时间、分类、来源、用途
     这样它才能回答「这周花了多少」，也才能定位「最近的一笔」。 */
  AI.buildDigest = function (maxNames) {
    const limit = maxNames || 40;
    const tx = Store.tx;

    const cats = Store.categories
      .slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); })
      .map(function (c) { return (c.type === 'income' ? '[收入] ' : c.type === 'both' ? '[通用] ' : '[支出] ') + c.name; });

    const byName = function (field) {
      const map = new Map();
      tx.forEach(function (t) {
        const v = String(t[field] || '').trim();
        if (!v) return;
        const rec = map.get(v) || { name: v, count: 0, last: 0, cats: new Map() };
        rec.count++;
        if (t.time > rec.last) rec.last = t.time;
        if (t.categoryName) rec.cats.set(t.categoryName, (rec.cats.get(t.categoryName) || 0) + 1);
        map.set(v, rec);
      });
      return Array.from(map.values()).sort(function (a, b) {
        return b.count - a.count || b.last - a.last;
      }).slice(0, limit);
    };

    const line = function (rec) {
      const cat = Array.from(rec.cats.entries()).sort(function (a, b) { return b[1] - a[1]; })[0];
      return rec.name + '（' + rec.count + ' 笔' + (cat ? '，多为「' + cat[0] + '」' : '') + '）';
    };

    const times = tx.map(function (t) { return t.time; }).sort(function (a, b) { return a - b; });
    const range = times.length ? (U.toISODate(new Date(times[0])) + ' ~ ' + U.toISODate(new Date(times[times.length - 1]))) : '（暂无账目）';

    const now = new Date();
    const parts = [];
    parts.push('今天是 ' + U.toISODate(now) + ' ' + WEEK_CN[now.getDay()] + '。');
    parts.push('账目总数：' + tx.length + ' 笔，时间范围：' + range);
    parts.push('现有分类：' + (cats.length ? cats.join('、') : '（无）'));

    /* 各周期合计：这些数字是应用自己算的，直接用，不用自己加减 */
    const sumLines = [];
    ['today', 'week', 'lastWeek', 'month', 'lastMonth', 'semester', 'year', 'all']
      .forEach(function (id) {
        const r = Stats.range(id);
        const s = Stats.full(Store.query({ from: r.from, to: r.to, includeExcluded: true, includeHidden: false }));
        sumLines.push('  ' + r.label + '：收入 ' + U.fmtMoney(s.included.income) +
          '，支出 ' + U.fmtMoney(s.included.expense) +
          '，结余 ' + U.fmtMoney(s.included.net) +
          '（' + s.included.count + ' 笔计入统计' +
          (s.excluded.count ? '，另有 ' + s.excluded.count + ' 笔不计入统计' : '') + '）');
      });
    parts.push('【各周期合计】（已排除「不计入统计」的账目）\n' + sumLines.join('\n'));

    const src = byName('counterparty');
    if (src.length) parts.push('【出现最多的来源（交易对方）】\n  ' + src.map(line).join('\n  '));
    const items = byName('item');
    if (items.length) parts.push('【出现最多的用途】\n  ' + items.map(line).join('\n  '));

    /* 逐笔明细：让 AI 能自己算任意区间、能精确定位某一笔 */
    const all = tx.slice().sort(function (a, b) {
      return (b.time - a.time) || (b.createdAt - a.createdAt);
    });
    const cap = 300;
    if (!all.length) {
      parts.push('【账目明细】（当前没有任何账目）');
    } else {
      parts.push('【账目明细（从新到旧）】共 ' + all.length + ' 笔' +
        (all.length > cap ? '，下面只列最近 ' + cap + ' 笔' : '') + '：');
      parts.push(all.slice(0, cap).map(function (t, i) {
        return (i + 1) + '. ' + U.fmtDateTime(new Date(t.time)) +
          ' ' + (t.type === 'income' ? '收入' : '支出') + ' ' + U.fmtMoney(t.amount) +
          ' 分类=' + (t.categoryName || '未分类') +
          ' 来源=' + (t.counterparty || '—') +
          ' 用途=' + (t.item || '—') +
          (t.account ? ' 账户=' + t.account : '') +
          (t.excludeStat ? '［不计入统计' + (t.excludeReason ? '：' + t.excludeReason : '') + '］' : '') +
          (Stats.isVacation(t) ? '［假期，不计入统计］' : '') +
          (t.reimburseGroupId ? '［已配对：收到 ' + U.fmtMoney(t.reimburseAmount || 0) +
            '，实际计入 ' + U.fmtMoney(Stats.counted(t)) + '］' : '') +
          (t.hidden ? '［已隐藏］' : '');
      }).join('\n'));
      parts.push('上面第 1 条就是「最近的一笔」。用户说「最近的一笔」「刚刚那笔」时指的就是它。');
    }
    return parts.join('\n');
  };

  /* ---------------- 系统提示词 ---------------- */
  const SYSTEM_PROMPT = [
    '你是一个记账应用的整理助手。你能看到用户的全部账目明细（含金额、时间、分类、来源、用途），',
    '也能看到应用算好的各周期合计，所以「这周花了多少」「总收入多少」这类问题要直接回答，',
    '绝不要说「我看不到金额」「我无法定位某一笔」。用户还会让你批量整理账目。',
    '',
    '【字段说明】',
    '- 每笔账目有：类型（收入/支出）、金额、时间、分类、账户、来源、用途、备注',
    '- 「来源」= 交易对方/商家（字段 counterparty）；「用途」= 买了什么（字段 item）',
    '- 「计入统计」为否时，这笔不计入任何合计（报销、代付等）',
    '- 只报销/只收回一部分的账目：只有自己承担的那部分计入统计（明细里标了「实际计入」是多少）',
    '- 报销款、收回的垫付或借款本身不算收入；只有对方多给、多出来的那部分才算收入',
    '- 用户可能设置了「假期」日期区间，这段时间的账目一律不计入统计；回答合计时要按这个口径',
    '',
    '【输出格式】',
    '你只能输出一个 JSON 对象，不要输出任何其它文字，也不要用 markdown 代码块：',
    '{ "reply": "给用户看的中文说明", "actions": [ ] }',
    '',
    '【可用动作】',
    '1) 批量改分类',
    '   { "type": "setCategory", "category": "数码", "filter": { "counterparty": "杭州深度求索" } }',
    '2) 批量设为「不计入统计」或恢复',
    '   { "type": "setExclude", "exclude": true, "reason": "报销", "filter": { "query": "教材" } }',
    '3) 重命名分类',
    '   { "type": "renameCategory", "from": "其他", "to": "数码" }',
    '',
    '【filter 可用条件，全部可选，省略表示不限制】',
    '- counterparty / item / query：模糊匹配，包含即算命中',
    '- category：必须是上面列出的现有分类名',
    '- txType：expense 或 income',
    '- account：账户名',
    '- from / to：YYYY-MM-DD',
    '- latest / limit：只要最近的一笔 / 最近 N 笔（用户说「最近的一笔」时用 latest: 1）',
    '',
    '【动作 4：算合计】（不用用户确认，应用会立刻精确算好）',
    '   { "type": "sum", "filter": { "from": "2026-10-05", "to": "2026-10-11" } }',
    '   概况里已有的周期合计直接用，不要重复调用；只有用户问的区间/条件概况里没有时才用它。',
    '',
    '【怎么理解「最近的一笔」】',
    '- 概况里「账目明细」的第 1 条就是最近的一笔，可以用它回答，也可以直接用 { "latest": 1 } 精确操作那一笔',
    '- 例如「把最近的一次账目的分类改为交通」→ setCategory + { "latest": 1 }',
    '',
    '【规则】',
    '- 只输出 JSON，一个字都不要多说',
    '- 用户只是问问题、不需要改数据时，actions 用空数组，把答案写在 reply 里',
    '- 不确定用户指的是哪一批账目时，别猜，在 reply 里说明还需要什么信息，actions 留空',
    '- 动作不会立刻执行，用户会再确认一次，所以可以放心给建议'
  ].join('\n');

  /* ---------------- 请求通道 ---------------- */
  function shortErr(text) {
    const s = String(text || '').replace(/\s+/g, ' ');
    return s.length > 160 ? s.slice(0, 160) + '…' : s;
  }

  function fetchTimeout(url, options, ms) {
    const limit = ms || 60000;
    const opts = Object.assign({}, options || {});
    let timer = null;
    if (typeof AbortController !== 'undefined') {
      const ctrl = new AbortController();
      opts.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, limit);
    }
    return fetch(url, opts).then(function (r) { return r; }, function (e) {
      if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
        throw new Error('等待 AI 响应超时（' + Math.round(limit / 1000) + ' 秒）。可能是网络不通，或服务商响应太慢');
      }
      throw new Error('请求 AI 失败：' + (e && e.message ? e.message : '网络错误'));
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  /* 走安卓原生请求，彻底绕开跨源限制 */
  function nativePost(url, headers, payload) {
    return new Promise(function (resolve, reject) {
      const id = 'ai' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      global.__aiCallbacks = global.__aiCallbacks || {};
      const timer = setTimeout(function () {
        delete global.__aiCallbacks[id];
        reject(new Error('等待 AI 响应超时（60 秒）'));
      }, 62000);

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
        global.AndroidApp.httpPost(id, url, JSON.stringify(headers), JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        delete global.__aiCallbacks[id];
        reject(new Error('调用系统请求失败：' + e.message));
      }
    });
  }

  /* 从响应里取出正文 */
  function extractContent(text) {
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error('AI 返回的内容不是合法 JSON：' + shortErr(text)); }
    if (data.error) throw new Error('AI 服务报错：' + (data.error.message || JSON.stringify(data.error)));
    const choice = (data.choices || [])[0];
    const content = choice && choice.message && choice.message.content;
    if (!content) throw new Error('AI 没有返回内容：' + shortErr(text));
    return content;
  }

  async function callModel(messages) {
    const url = AI.endpointUrl();
    if (!url) throw new Error('还没有填写 AI 接口地址');

    const payload = { model: AI.config.model, messages: messages, temperature: 0.2, stream: false };
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI.config.apiKey };

    /* 1) 安卓 App：原生请求 */
    if (global.AndroidApp && typeof global.AndroidApp.httpPost === 'function') {
      const res = await nativePost(url, headers, payload);
      if (!res.status) throw new Error(res.text || '请求 AI 失败，请检查网络');
      if (res.status < 200 || res.status >= 300) throw new Error('AI 接口返回 HTTP ' + res.status + '：' + shortErr(res.text));
      return extractContent(res.text);
    }

    /* 2) 浏览器 + 电脑服务在线：让本地服务代为转发 */
    const Sync = global.Sync;
    if (Sync && Sync.available && Sync.available() && Sync.isConnected && Sync.isConnected()) {
      try {
        const res = await fetchTimeout(Sync.apiUrl('/api/ai'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ url: url, headers: headers, payload: payload })
        }, 70000);
        const j = await res.json();
        if (j && j.ok) {
          if (j.status >= 200 && j.status < 300) return extractContent(j.body);
          throw new Error('AI 接口返回 HTTP ' + j.status + '：' + shortErr(j.body));
        }
      } catch (e) {
        if (/AI 接口返回/.test(e.message)) throw e;   // 服务商的错误，直接透出
        // 转发不可用，继续尝试直连
      }
    }

    /* 3) 直接请求 */
    const res = await fetchTimeout(url, { method: 'POST', headers: headers, body: JSON.stringify(payload) }, 60000);
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new Error('AI 接口返回 HTTP ' + res.status + '：' + shortErr(text));
    return extractContent(text);
  }

  /* ---------------- 解析模型的回复 ---------------- */
  AI.parseIntent = function (text) {
    let s = String(text === null || text === undefined ? '' : text).trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
    try {
      const obj = JSON.parse(s);
      return {
        reply: String(obj.reply || obj.message || '').trim(),
        actions: Array.isArray(obj.actions) ? obj.actions : []
      };
    } catch (e) {
      // 解析不了就当作纯文字回复，至少不会丢内容
      return { reply: String(text || '').trim(), actions: [] };
    }
  };

  /* ---------------- 动作匹配 ---------------- */
  AI.match = function (filter) {
    filter = filter || {};
    let list = Store.query({
      from: filter.from || null,
      to: filter.to || null,
      types: filter.txType ? [filter.txType] : null,
      q: filter.query || '',
      includeExcluded: true,
      includeHidden: true
    });
    list = list.filter(function (t) {
      if (filter.counterparty && String(t.counterparty || '').indexOf(filter.counterparty) < 0) return false;
      if (filter.item && String(t.item || '').indexOf(filter.item) < 0) return false;
      if (filter.account && String(t.account || '') !== filter.account) return false;
      if (filter.category && String(t.categoryName || '') !== filter.category) return false;
      return true;
    });

    /* 「最近的一笔 / N 笔」：先按时间从新到旧排，再截取 */
    const n = Number(filter.latest || filter.limit || 0);
    if (n > 0) {
      list = list.slice().sort(function (a, b) {
        return (b.time - a.time) || (b.createdAt - a.createdAt);
      });
      list = list.slice(0, Math.min(200, Math.max(1, Math.floor(n))));
    }
    return list;
  };

  AI.describeFilter = function (filter) {
    filter = filter || {};
    const bits = [];
    if (filter.counterparty) bits.push('来源包含「' + filter.counterparty + '」');
    if (filter.item) bits.push('用途包含「' + filter.item + '」');
    if (filter.query) bits.push('任意字段包含「' + filter.query + '」');
    if (filter.category) bits.push('当前分类是「' + filter.category + '」');
    if (filter.txType) bits.push(filter.txType === 'income' ? '只看收入' : '只看支出');
    if (filter.account) bits.push('账户是「' + filter.account + '」');
    if (filter.from) bits.push('从 ' + filter.from);
    if (filter.to) bits.push('到 ' + filter.to);
    const n = Number(filter.latest || filter.limit || 0);
    if (n === 1) bits.push('时间最近的那一笔');
    else if (n > 1) bits.push('时间最近的 ' + n + ' 笔');
    return bits.length ? bits.join('，') : '全部账目';
  };

  /* 一笔账目的简短说明，用来让用户看清「到底改的是哪一笔」 */
  AI.txLabel = function (t) {
    return U.fmtDateTime(new Date(t.time)) + '　' + (t.counterparty || t.item || '无来源') +
      '　' + (t.type === 'income' ? '收入' : '支出') + ' ' + U.fmtMoney(t.amount);
  };

  /* 精确合计：应用自己算，绝不交给模型心算 */
  AI.computeSum = function (filter) {
    filter = filter || {};
    const list = AI.match(filter);
    let income = 0, expense = 0, excluded = 0;
    list.forEach(function (t) {
      if (t.excludeStat) { excluded++; return; }
      if (t.type === 'income') income += t.amount; else expense += t.amount;
    });
    income = U.round2(income); expense = U.round2(expense);
    return {
      count: list.length,
      income: income,
      expense: expense,
      balance: U.round2(income - expense),
      text: AI.describeFilter(filter) + '：收入 ' + U.fmtMoney(income) +
        '，支出 ' + U.fmtMoney(expense) +
        '，结余 ' + U.fmtMoney(U.round2(income - expense)) +
        '（共 ' + list.length + ' 笔' +
        (excluded ? '，其中 ' + excluded + ' 笔不计入统计' : '') + '）'
    };
  };

  /* 把 AI 给的动作翻译成「能做什么、会影响几条」，等人确认 */
  AI.resolve = function (actions) {
    const out = [];
    (actions || []).forEach(function (a) {
      if (!a || !a.type) return;

      if (a.type === 'setCategory') {
        const cat = Store.categories.find(function (c) { return c.name === a.category; });
        if (!cat) {
          out.push({ ok: false, title: '改分类 → ' + (a.category || '（未指定）'), reason: '没有找到这个分类' });
          return;
        }
        const list = AI.match(a.filter);
        out.push({
          ok: list.length > 0,
          title: '把分类改成「' + cat.name + '」',
          desc: AI.describeFilter(a.filter),
          count: list.length,
          reason: list.length ? '' : '没有账目符合条件',
          sample: list.slice(0, 3).map(function (t) { return AI.txLabel(t); }),
          run: async function () {
            const n = await Store.reassignCategory(list.map(function (t) { return t.id; }), cat.id);
            return '已把 ' + n + ' 条账目的分类改成「' + cat.name + '」';
          }
        });
        return;
      }

      if (a.type === 'setExclude') {
        const list = AI.match(a.filter);
        const exclude = a.exclude !== false;
        const reason = a.reason || '不计收支';
        out.push({
          ok: list.length > 0,
          title: exclude ? '设为「不计入统计」' : '恢复「计入统计」',
          desc: AI.describeFilter(a.filter),
          count: list.length,
          reason: list.length ? '' : '没有账目符合条件',
          sample: list.slice(0, 3).map(function (t) { return AI.txLabel(t); }),
          run: async function () {
            let n = 0;
            for (let i = 0; i < list.length; i++) {
              await Store.updateTx(list[i].id, {
                excludeStat: exclude,
                excludeReason: exclude ? reason : ''
              });
              n++;
            }
            return (exclude ? '已把 ' : '已恢复 ') + n + ' 条账目';
          }
        });
        return;
      }

      if (a.type === 'renameCategory') {
        const cat = Store.categories.find(function (c) { return c.name === a.from; });
        const dup = Store.categories.find(function (c) { return c.name === a.to; });
        if (!cat) {
          out.push({ ok: false, title: '重命名分类', reason: '没有找到分类「' + (a.from || '') + '」' });
          return;
        }
        if (dup) {
          out.push({ ok: false, title: '重命名分类', reason: '已经存在叫「' + a.to + '」的分类了' });
          return;
        }
        const used = Store.tx.filter(function (t) { return t.categoryId === cat.id; }).length;
        out.push({
          ok: true,
          title: '把分类「' + cat.name + '」改名为「' + a.to + '」',
          desc: '该分类下有 ' + used + ' 条账目，分类名会一起更新',
          count: used,
          sample: [],
          reason: '',
          run: async function () {
            await Store.updateCategory(cat.id, { name: a.to });
            return '分类已改名为「' + a.to + '」';
          }
        });
        return;
      }

      out.push({ ok: false, title: '不认识的动作：' + a.type, reason: '这个版本还不支持' });
    });
    return out;
  };

  AI.execute = async function (resolved) {
    const results = [];
    for (let i = 0; i < resolved.length; i++) {
      if (!resolved[i].ok) continue;
      try {
        const msg = await resolved[i].run();
        results.push({ ok: true, msg: msg });
      } catch (e) {
        results.push({ ok: false, msg: '执行失败：' + (e && e.message ? e.message : '未知错误') });
      }
    }
    return results;
  };

  /* ---------------- 主入口 ---------------- */
  AI.ask = async function (userText) {
    const text = String(userText || '').trim();
    if (!text) throw new Error('请先说点什么');
    if (!AI.available()) throw new Error('还没有配置 AI 接口，请先到「设置 → AI 助手」填写');

    AI.busy = true;
    AI.lastError = '';
    try {
      AI.messages.push({ role: 'user', content: text });
      // 只保留最近几轮，附带最新数据摘要
      const history = AI.messages.slice(-8).map(function (m) { return { role: m.role, content: m.content }; });
      const messages = [{ role: 'system', content: SYSTEM_PROMPT }]
        .concat([{ role: 'system', content: '【当前账目概况】\n' + AI.buildDigest() }])
        .concat(history);

      const raw = await callModel(messages);
      let parsed = AI.parseIntent(raw);
      AI.messages.push({ role: 'assistant', content: raw });

      /* 需要精确数字的：应用自己算，再把结果交回模型，由它用自然语言总结 */
      const sums = (parsed.actions || []).filter(function (a) { return a.type === 'sum'; });
      const rest = (parsed.actions || []).filter(function (a) { return a.type !== 'sum'; });
      if (sums.length) {
        const results = sums.map(function (a) { return AI.computeSum(a.filter || a); });
        parsed = { reply: parsed.reply, actions: rest, sums: results };
        try {
          const back = '（应用已经按你的要求把数字精确算好了，结果如下。请直接用中文简洁地把结果告诉用户，'
            + '不要再调用 sum）\n' + results.map(function (r) { return r.text; }).join('\n');
          const again = [{ role: 'system', content: SYSTEM_PROMPT }]
            .concat([{ role: 'system', content: '【当前账目概况】\n' + AI.buildDigest() }])
            .concat(AI.messages.slice(-8))
            .concat([{ role: 'user', content: back }]);
          const raw2 = await callModel(again);
          const parsed2 = AI.parseIntent(raw2);
          AI.messages.push({ role: 'assistant', content: raw2 });
          parsed = {
            reply: parsed2.reply || parsed.reply,
            actions: rest.concat((parsed2.actions || []).filter(function (a) { return a.type !== 'sum'; })),
            sums: results
          };
        } catch (e) {
          /* 第二次问失败也没关系，算好的数字照样给用户看 */
          parsed.reply = parsed.reply || '（数字已经算好，见下面）';
        }
      }

      if (AI.messages.length > 16) AI.messages = AI.messages.slice(-16);
      return parsed;
    } catch (e) {
      AI.lastError = e && e.message ? e.message : '未知错误';
      AI.messages.pop();   // 失败的这一轮不进历史
      throw e;
    } finally {
      AI.busy = false;
    }
  };

  AI.reset = function () { AI.messages = []; };

  global.AI = AI;
})(window);