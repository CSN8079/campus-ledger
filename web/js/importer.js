/* ============================================================
   importer.js - 账单导入引擎
   支持：微信支付账单 CSV、支付宝账单 CSV（GBK）、通用 CSV
   能力：文件编码自动识别、表头自动定位、字段自动映射、
        关键词自动分类、按交易单号去重、导入前预览。
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U, D = global.DEFAULTS, Store = global.Store;
  const I = {};

  /* ---------------- 文件解码 ---------------- */
  /* 微信导出为 UTF-8，支付宝导出为 GBK，这里自动判断 */
  I.decodeBuffer = function (buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    // 去掉 BOM
    let start = 0;
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) start = 3;
    const body = bytes.subarray(start);
    try {
      const t = new TextDecoder('utf-8', { fatal: true }).decode(body);
      return { text: t, encoding: 'UTF-8' };
    } catch (e) { /* 不是合法 UTF-8，继续尝试 GBK */ }
    try {
      const t = new TextDecoder('gbk').decode(body);
      return { text: t, encoding: 'GBK' };
    } catch (e) { /* 浏览器不支持 gbk 解码 */ }
    return { text: new TextDecoder('utf-8').decode(body), encoding: 'UTF-8(可能乱码)' };
  };

  I.readFile = function (file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        try { resolve(I.decodeBuffer(fr.result)); }
        catch (e) { reject(e); }
      };
      fr.onerror = () => reject(new Error('文件读取失败'));
      fr.readAsArrayBuffer(file);
    });
  };

  /* ---------------- CSV 解析 ---------------- */
  I.parseCSV = function (text, delim) {
    const rows = [];
    let row = [], field = '', inQ = false;
    const n = text.length;
    for (let i = 0; i < n; i++) {
      const c = text.charAt(i);
      if (inQ) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else if (c === '"') {
        inQ = true;
      } else if (c === delim) {
        row.push(field); field = '';
      } else if (c === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else if (c === '\r') {
        /* 忽略，等 \n 收行 */
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
  };

  /* 猜测分隔符 */
  function guessDelim(text) {
    const head = text.slice(0, 4000);
    const cComma = (head.match(/,/g) || []).length;
    const cTab = (head.match(/\t/g) || []).length;
    const cSemi = (head.match(/;/g) || []).length;
    if (cTab > cComma && cTab > cSemi) return '\t';
    if (cSemi > cComma) return ';';
    return ',';
  }

  /* ---------------- 字段别名 ---------------- */
  const ALIASES = {
    time: ['交易时间', '交易创建时间', '创建时间', '交易日期', '时间', '日期'],
    dir: ['收/支', '收支', '收支类型', '资金流向', '收\\支'],
    amount: ['金额(元)', '金额（元）', '金额', '交易金额', '发生金额'],
    counterparty: ['交易对方', '对方', '商户名称', '交易对方名称', '对方名称'],
    item: ['商品', '商品说明', '商品名称', '商品说明 ', '交易说明'],
    status: ['当前状态', '交易状态', '状态'],
    txKind: ['交易类型', '交易分类', '类型'],
    orderNo: ['交易单号', '交易订单号', '订单号', '流水号', '交易号'],
    merchantNo: ['商户单号', '商家订单号', '商家订单号 ', '商户订单号'],
    payMethod: ['支付方式', '收/付款方式', '付款方式', '收付款方式'],
    note: ['备注', '备注 ', '备注说明', '其他'],
    alipayCat: ['交易分类']
  };

  function normHeader(s) { return String(s || '').replace(/\s|　/g, '').replace(/\(元\)|（元）/g, ''); }

  function findHeaderRow(rows) {
    const limit = Math.min(rows.length, 60);
    for (let i = 0; i < limit; i++) {
      const cells = rows[i].map(normHeader);
      const joined = cells.join('|');
      if (joined.indexOf('交易时间') >= 0 || (joined.indexOf('金额') >= 0 && joined.indexOf('收') >= 0)) return i;
    }
    return 0;
  }

  function buildIndex(headerRow) {
    const idx = {};
    const cells = headerRow.map(normHeader);
    Object.keys(ALIASES).forEach((key) => {
      const names = ALIASES[key].map(normHeader);
      for (let i = 0; i < cells.length; i++) {
        if (names.indexOf(cells[i]) >= 0) { idx[key] = i; return; }
      }
    });
    return idx;
  }

  I.detect = function (rows) {
    const hi = findHeaderRow(rows);
    const headerRow = rows[hi] || [];
    const idx = buildIndex(headerRow);
    const joined = headerRow.map(normHeader).join('|');
    let kind = 'generic';
    if (joined.indexOf('商品') >= 0 && (joined.indexOf('商户单号') >= 0 || joined.indexOf('交易单号') >= 0)) kind = 'wechat';
    else if (joined.indexOf('商品说明') >= 0 || joined.indexOf('商家订单号') >= 0 || joined.indexOf('收/付款方式') >= 0) kind = 'alipay';
    if (rows.length && String(rows[0][0] || '').indexOf('微信') >= 0) kind = 'wechat';
    if (rows.length && /支付宝/.test(String(rows.slice(0, 3).map((r) => r.join('')).join(''))) ) kind = 'alipay';
    return { headerIndex: hi, headerRow: headerRow, idx: idx, kind: kind, columns: headerRow.map((h) => String(h).trim()) };
  };

  /* ---------------- 收支方向 ---------------- */
  function normalizeDirection(s) {
    const t = String(s || '').replace(/\s/g, '');
    if (!t) return '';
    if (t.indexOf('不计') >= 0 || t.indexOf('其他') >= 0) return 'ignore';
    if (t.indexOf('收入') >= 0) return 'income';
    if (t.indexOf('支出') >= 0) return 'expense';
    if (t === '收') return 'income';
    if (t === '支') return 'expense';
    if (t.indexOf('收') >= 0) return 'income';
    if (t.indexOf('支') >= 0) return 'expense';
    return '';
  }

  /* ---------------- 「不计收支」流水的收支方向 ----------------
     这类流水在账单里不带方向信息（收/支 列写的是「不计收支」），
     必须按描述推断出来，否则余额宝收益会被当成支出、显示成负数。
     注意：这不影响「是否计入统计」—— 它们依然不计入任何合计。 */
  const INCOME_HINTS = ['收益', '利息', '转入', '收入', '退款', '退回', '发放',
    '奖励', '返现', '收款', '报销', '补贴', '进账', '退款成功'];
  const EXPENSE_HINTS = ['转出', '支出', '还款', '还花呗', '提现', '缴费', '扣款',
    '付款', '消费', '购买', '买入', '转到银行卡', '转账到银行卡', '代扣', '生活费'];

  function guessDirectionFromText(text) {
    const s = String(text || '');
    for (let i = 0; i < INCOME_HINTS.length; i++) {
      if (s.indexOf(INCOME_HINTS[i]) >= 0) return 'income';
    }
    for (let i = 0; i < EXPENSE_HINTS.length; i++) {
      if (s.indexOf(EXPENSE_HINTS[i]) >= 0) return 'expense';
    }
    return 'expense';   // 实在判断不出来时按支出处理（反正不计入统计）
  }

  /* ---------------- 支付宝自带分类 -> 我们的分类 ---------------- */
  const ALIPAY_CAT_MAP = {
    '餐饮美食': '餐饮', '交通出行': '交通', '服饰装扮': '购物', '日用百货': '日用',
    '数码电器': '数码', '文化休闲': '娱乐', '医疗健康': '医疗', '住房物业': '住宿',
    '通讯物流': '通讯', '充值缴费': '通讯', '教育培训': '学习', '人情往来': '人情',
    '运动户外': '运动', '酒店旅游': '旅行', '母婴亲子': '日用', '美容美发': '日用',
    '宠物': '其他', '商业服务': '其他', '金融保险': '其他', '投资理财': '其他',
    '转账红包': '人情', '亲友代付': '人情', '信用借还': '其他', '其他': '其他'
  };

  /* ---------------- 关键词自动分类 ---------------- */
  I.guessCategory = function (text, type) {
    const hay = String(text || '').toLowerCase();
    if (!hay.trim()) return null;
    const cats = Store.categories;

    // 1) 用户自定义规则优先
    const rules = Store.settings.rules || [];
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (r.type && r.type !== 'both' && r.type !== type) continue;
      for (let k = 0; k < r.kw.length; k++) {
        const kw = String(r.kw[k]).toLowerCase();
        if (kw && hay.indexOf(kw) >= 0) {
          const c = cats.find((x) => x.name === r.cat && (x.type === type || x.type === 'both'));
          if (c) return c;
        }
      }
    }
    // 2) 内置规则
    for (let i = 0; i < D.builtinRules.length; i++) {
      const r = D.builtinRules[i];
      if (r.type !== type) continue;
      for (let k = 0; k < r.kw.length; k++) {
        const kw = r.kw[k].toLowerCase();
        if (hay.indexOf(kw) >= 0) {
          const c = cats.find((x) => x.name === r.cat && (x.type === type || x.type === 'both'));
          if (c) return c;
        }
      }
    }
    return null;
  };

  /* ---------------- 归属账户 ---------------- */
  function guessAccount(kind, payMethod) {
    if (kind === 'wechat') return '微信';
    if (kind === 'alipay') return '支付宝';
    const m = String(payMethod || '');
    if (/支付宝|余额宝|花呗|余额/.test(m)) return '支付宝';
    if (/微信|零钱/.test(m)) return '微信';
    if (/银行|储蓄卡|信用卡/.test(m)) return '银行卡';
    if (/现金/.test(m)) return '现金';
    return '';
  }

  /* ---------------- 备注清理 ---------------- */
  function cleanText(s) {
    const t = String(s === undefined || s === null ? '' : s).trim();
    if (!t || t === '/' || t === '-' || t === '　') return '';
    return t;
  }

  /* 去重用的备用键 */
  function fallbackKey(t) {
    return [t.type, t.amount.toFixed(2), U.toISODate(t.time), t.counterparty, t.item].join('|');
  }

  /* ---------------- 主解析流程 ---------------- */
  /* opts: { includeIgnore:bool, excludeRefund:bool, autoClassify:bool, dedupe:bool } */
  /* 统一的空结果 */
  function emptyStats(dataRows) {
    return {
      dataRows: dataRows || 0, total: 0, parsed: 0,
      dup: 0, suspect: 0, ignored: 0, skipped: 0,
      skipReasons: { footer: 0, noTime: 0, noAmount: 0, closed: 0 }
    };
  }

  /* Excel 有时把日期存成「序列号」（1899-12-30 起算的天数），这里一并处理 */
  function parseTimeCell(raw) {
    const s = String(raw === null || raw === undefined ? '' : raw).trim();
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      if (n > 20000 && n < 80000) {
        const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
        return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
          d.getUTCHours(), d.getUTCMinutes()).getTime();
      }
    }
    return U.fromISO(s).getTime();
  }

  /* 解析一批已经拆分好的二维表。CSV 与 Excel(xlsx) 都走这里，
     保证两种格式的结果完全一致。 */
  I.parseRows = function (rows, opts, meta) {
    opts = Object.assign({
      includeIgnore: true,    // 默认连「不计收支」的流水一起导入（导入后标记为不计入统计）
      excludeRefund: true,    // 退款相关流水标记为不计入统计
      autoClassify: true,
      dedupe: true
    }, opts || {});
    meta = meta || {};
    rows = rows || [];

    if (!rows.length) {
      return {
        items: [], detect: null, looseIndex: new Map(),
        source: meta.source || '', sheetName: meta.sheet || '', text: meta.text || '',
        stats: emptyStats(0)
      };
    }

    const detect = I.detect(rows);
    const idx = detect.idx;
    const items = [];
    const seenKeys = new Set();
    // 已有的精确键（交易单号 / 完整字段组合）
    const existing = new Set();
    // 宽松索引：同一天 + 同方向 + 同金额 —— 用来发现"金额日期都对得上"的疑似重复
    // （常见场景：先手动记了一笔，之后又导入了包含这笔的账单）
    const looseIndex = new Map();
    const looseKeyOf = (t) => t.dateKey + '|' + t.type + '|' + (Number(t.amount) || 0).toFixed(2);
    Store.tx.forEach((t) => {
      if (t.externalId) existing.add('ext:' + t.externalId);
      existing.add('fb:' + fallbackKey(t));
      const k = looseKeyOf(t);
      if (!looseIndex.has(k)) looseIndex.set(k, []);
      looseIndex.get(k).push(t);
    });

    let dup = 0, suspect = 0, skipped = 0, ignored = 0;
    /* 每一行都要有明确归宿：导入 / 重复 / 疑似重复 / 不计收支 / 其它原因跳过。
       这样用户看到「文件里有 N 条、只导入 M 条」时，能知道差的那些去哪了。 */
    const skipReasons = { footer: 0, noTime: 0, noAmount: 0, closed: 0 };
    const dataRows = Math.max(0, rows.length - detect.headerIndex - 1);

    for (let r = detect.headerIndex + 1; r < rows.length; r++) {
      const row = rows[r];
      const cell = (k) => (idx[k] === undefined ? '' : String(row[idx[k]] === undefined ? '' : row[idx[k]]).trim());
      const rawTime = cell('time');
      if (!rawTime) { skipped++; skipReasons.noTime++; continue; }
      // 结尾的统计行 / 说明行
      if (/^[-=]+$/.test(rawTime) || /共\s*\d+\s*笔/.test(row.join(''))) { skipped++; skipReasons.footer++; continue; }

      const dir = normalizeDirection(cell('dir'));
      const amount = U.parseAmount(cell('amount'));
      if (!amount || !isFinite(amount)) { skipped++; skipReasons.noAmount++; continue; }

      const status = cell('status');
      const txKind = cell('txKind');
      const counterparty = cleanText(cell('counterparty'));
      const item = cleanText(cell('item')) || cleanText(cell('note'));
      const note = cleanText(cell('note'));
      const payMethod = cleanText(cell('payMethod'));
      const orderNo = cleanText(cell('orderNo'));
      const merchantNo = cleanText(cell('merchantNo'));
      const isRefund = /退款/.test(status) || /退款/.test(txKind) || /退款/.test(item);

      /* 判断是收入还是支出 */
      let type;
      if (dir === 'income') type = 'income';
      else if (dir === 'expense') type = 'expense';
      else if (dir === 'ignore') type = guessDirectionFromText(counterparty + ' ' + item + ' ' + txKind + ' ' + status);
      else type = /^-/.test(cell('amount')) || amount < 0 ? 'expense' : 'income';

      // 不计收支的流水按配置处理
      let forceExclude = false, excludeReason = '';
      if (dir === 'ignore') {
        if (!opts.includeIgnore) { ignored++; continue; }
        forceExclude = true; excludeReason = '不计收支';
      }
      if (isRefund && opts.excludeRefund) { forceExclude = true; excludeReason = '退款'; }
      if (/交易关闭|已关闭|已撤销|失败|已退款给|支付失败/.test(status)) { skipped++; skipReasons.closed++; continue; }

      const time = parseTimeCell(rawTime);

      // 自动分类
      let cat = null;
      if (opts.autoClassify) {
        const alipayCat = cleanText(cell('alipayCat'));
        const mapped = alipayCat && ALIPAY_CAT_MAP[alipayCat];
        cat = I.guessCategory([counterparty, item, txKind, status].join(' '), type);
        if (!cat && mapped) cat = Store.categories.find((c) => c.name === mapped && (c.type === type || c.type === 'both')) || null;
      }

      const builtNote = [];
      if (payMethod) builtNote.push('支付方式：' + payMethod);
      if (note && note !== item) builtNote.push(note);

      const tx = {
        type: type,
        amount: amount,
        time: time,
        categoryId: cat ? cat.id : '',
        categoryName: cat ? cat.name : '',
        account: guessAccount(detect.kind, payMethod),
        counterparty: counterparty,
        item: item,
        note: builtNote.join('；'),
        excludeStat: forceExclude || (cat ? !!cat.excludeByDefault : false),
        excludeReason: excludeReason || (cat && cat.excludeByDefault ? '分类默认排除' : ''),
        source: detect.kind,
        externalId: orderNo || merchantNo || '',
        tags: []
      };

      // 一级判定：严格重复（交易单号相同，或字段完全一致）
      const extKey = tx.externalId ? 'ext:' + tx.externalId : '';
      const fbKey = 'fb:' + fallbackKey(tx);
      let isDup = false, dupReason = '';
      if (opts.dedupe) {
        if (extKey && existing.has(extKey)) { isDup = true; dupReason = '交易单号已存在'; }
        else if (!extKey && existing.has(fbKey)) { isDup = true; dupReason = '同日同额同来源'; }
        else if (seenKeys.has(extKey || fbKey)) { isDup = true; dupReason = '文件内重复'; }
      }
      seenKeys.add(extKey || fbKey);
      if (isDup) dup++;

      // 二级判定：疑似重复（同一天、同方向、金额完全相同）
      let isSuspect = false, suspectReason = '';
      if (!isDup && opts.dedupe) {
        const hit = looseIndex.get(looseKeyOf(tx));
        if (hit && hit.length) {
          isSuspect = true;
          const same = hit.find((h) => h.counterparty && h.counterparty === tx.counterparty);
          suspectReason = same
            ? '同日同额：已有「' + same.counterparty + '」' + U.fmtMoney(same.amount) + '（' + same.dateKey + '）'
            : '同日同额：已有 ' + hit.length + ' 笔同日同金额记录';
        }
      }
      if (isSuspect) suspect++;

      items.push({
        ok: true,
        dup: isDup,
        dupReason: dupReason,
        suspect: isSuspect,
        suspectReason: suspectReason,
        selected: !isDup && !isSuspect,
        kind: detect.kind,
        raw: { time: rawTime, dir: cell('dir'), amount: cell('amount'), status: status, txKind: txKind, counterparty: counterparty, item: item, payMethod: payMethod, orderNo: orderNo },
        tx: tx
      });
    }

    items.sort((a, b) => b.tx.time - a.tx.time);
    return {
      items: items,
      detect: detect,
      looseIndex: looseIndex,
      source: meta.source || '',
      sheetName: meta.sheet || '',
      text: meta.text || '',
      stats: {
        dataRows: dataRows,
        total: items.length,
        parsed: items.length,
        dup: dup, suspect: suspect, ignored: ignored, skipped: skipped,
        skipReasons: skipReasons
      }
    };
  };

  /* 入口一：CSV 文本 */
  I.parse = function (text, opts) {
    const rows = I.parseCSV(text, guessDelim(text));
    const r = I.parseRows(rows, opts, { source: 'csv', text: text });
    r.text = text;
    return r;
  };

  /* 入口二：Excel（.xlsx）。微信账单默认导出的就是这种格式。 */
  I.parseXlsx = async function (arrayBuffer, opts) {
    const Xlsx = global.Xlsx;
    if (!Xlsx || typeof Xlsx.read !== 'function') throw new Error('xlsx 模块未加载');
    const book = await Xlsx.read(arrayBuffer);

    // 在多个工作表里挑一个「看起来像账单」的：能找到交易时间和金额两列
    let chosen = null;
    for (let i = 0; i < book.sheets.length; i++) {
      const d = I.detect(book.sheets[i].rows || []);
      if (d.idx.time !== undefined && d.idx.amount !== undefined) { chosen = book.sheets[i]; break; }
    }
    if (!chosen) chosen = book.sheets[0];

    const r = I.parseRows(chosen.rows || [], opts, { source: 'xlsx', sheet: chosen.name });
    r.sheets = book.sheets.map((s) => s.name);
    return r;
  };

  /* ---------------- 提交入库 ---------------- */
  I.commit = async function (items) {
    const chosen = items.filter((it) => it.selected);
    if (!chosen.length) return 0;
    // 再次按 externalId 去重，防止同批次重复勾选
    const seen = new Set();
    const finalRows = [];
    chosen.forEach((it) => {
      const key = it.tx.externalId || ('fb:' + fallbackKey(it.tx));
      if (it.tx.externalId) {
        if (seen.has(key)) return;
        seen.add(key);
      }
      finalRows.push(it.tx);
    });
    return Store.addManyTx(finalRows);
  };

  global.Importer = I;
})(window);