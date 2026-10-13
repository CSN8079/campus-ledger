/* ============================================================
   store.js - 应用状态层
   负责：加载/保存、账目与分类的增删改查、报销配对、
        学期管理、备份与导出、查询过滤。
   说明：数据量在个人记账场景下很小（万条以内），
        因此采取“全量载入内存 + 变更即写库”的简单策略。
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U, D = global.DEFAULTS, DB = global.DB;

  const Store = {
    tx: [],
    categories: [],
    settings: {},
    tombstones: {},          // 删除记录：{ id: 删除时间 }，用于设备之间同步删除操作
    settingsUpdatedAt: 0,    // 设置的最近修改时间，同步时用于比较新旧
    loaded: false,
    _listeners: [],
    _txMap: new Map(),
    _catMap: new Map()
  };

  /* 需要参与同步的设置项（主题这类每台设备各不相同的设置不参与） */
  const SYNC_SETTING_KEYS = ['semesters', 'activeSemesterId', 'weekStart', 'rules',
    'autoClassifyOnImport', 'dedupeOnImport', 'lastAccount',
    'vacations', 'vacationExclude', 'holidayData', 'holidayPrompts', 'holidayRemindDays'];

  /* 墓碑保留时长：超过这个时间的删除记录可以丢弃（默认 180 天） */
  const TOMBSTONE_TTL = 180 * 24 * 3600 * 1000;

  let tombTimer = null;
  function saveTombstonesSoon() {
    if (tombTimer) clearTimeout(tombTimer);
    tombTimer = setTimeout(() => {
      tombTimer = null;
      DB.put('meta', { key: 'tombstones', value: Store.tombstones }).catch(() => {});
    }, 400);
  }

  /* ---------------- 事件 ---------------- */
  Store.subscribe = function (fn) { Store._listeners.push(fn); return () => { Store._listeners = Store._listeners.filter((f) => f !== fn); }; };
  Store.emit = function (reason) { Store._listeners.forEach((fn) => { try { fn(reason); } catch (e) { console.error(e); } }); };

  /* ---------------- 归一化 ---------------- */
  function normalizeTx(t) {
    const raw = (t && typeof t.time === 'number') ? t.time : U.fromISO(t && t.time).getTime();
    const time = isNaN(raw) ? Date.now() : raw;
    const d = new Date(time);
    return {
      id: t.id || U.uuid(),
      type: t.type === 'income' ? 'income' : 'expense',
      amount: U.round2(Math.abs(U.parseAmount(t.amount))),
      time: time,
      dateKey: U.toISODate(d),
      categoryId: t.categoryId || '',
      categoryName: t.categoryName || '',
      account: t.account || '',
      counterparty: t.counterparty || '',
      item: t.item || '',
      note: t.note || '',
      tags: Array.isArray(t.tags) ? t.tags.slice() : [],
      excludeStat: !!t.excludeStat,
      /* 金额里有多少不计入统计（只报销了一部分时，抵扣掉的那部分） */
      excludeAmount: (function (raw) {
        const v = Math.abs(U.parseAmount(raw));
        return (isFinite(v) && v > 0) ? U.round2(v) : 0;
      })(t.excludeAmount),
      excludeReason: t.excludeReason || '',
      reimburseGroupId: t.reimburseGroupId || '',
      reimburseAuto: !!t.reimburseAuto,
      reimburseStatus: t.reimburseStatus || '',
      reimburseRole: t.reimburseRole || '',
      /* 这次报销实际到账多少（用来在明细里说明「报销了多少、自付多少」） */
      reimburseAmount: (function (raw) {
        const v = Math.abs(U.parseAmount(raw));
        return (isFinite(v) && v > 0) ? U.round2(v) : 0;
      })(t.reimburseAmount),
      hidden: !!t.hidden,
      source: t.source || 'manual',
      externalId: t.externalId || '',
      createdAt: t.createdAt || Date.now(),
      updatedAt: t.updatedAt || Date.now()
    };
  }

  /* 分类 id 由「类型 + 名称」决定，两台设备算出来完全一样。
     之前用随机 id，手机和电脑各自生成的默认分类 id 不同，
     一同步就变成「所有分类都出现两个」。 */
  function categoryIdOf(type, name) {
    const tag = type === 'income' ? 'in' : (type === 'both' ? 'both' : 'ex');
    return 'cat_' + tag + '_' + String(name || '').trim();
  }

  function normalizeCategory(c, i) {
    return {
      id: c.id || categoryIdOf(c.type, c.name),
      name: c.name || '未命名',
      type: c.type === 'income' ? 'income' : (c.type === 'both' ? 'both' : 'expense'),
      icon: c.icon || '🏷️',
      color: c.color || U.colorFromString(c.name),
      hidden: !!c.hidden,
      excludeByDefault: !!c.excludeByDefault,
      builtin: !!c.builtin,
      order: typeof c.order === 'number' ? c.order : (i || 0) * 10,
      idMigrated: !!c.idMigrated,
      updatedAt: c.updatedAt || Date.now()
    };
  }

  /* ---------------- 初始化 ---------------- */
  Store.init = async function () {
    const mode = await DB.init();

    const [txRows, catRows, setRow, tombRow] = await Promise.all([
      DB.all('tx'), DB.all('categories'), DB.get('meta', 'settings'), DB.get('meta', 'tombstones')
    ]);

    Store.tx = (txRows || []).map(normalizeTx);
    Store.categories = (catRows || []).map(normalizeCategory);
    Store.settings = Object.assign({}, D.settings, setRow ? setRow.value : {});
    Store.settingsUpdatedAt = (setRow && setRow.settingsUpdatedAt) || 0;
    Store.tombstones = (tombRow && tombRow.value) || {};
    // 丢弃过期的删除记录
    const expire = Date.now() - TOMBSTONE_TTL;
    Object.keys(Store.tombstones).forEach((k) => { if (Store.tombstones[k] < expire) delete Store.tombstones[k]; });

    // 首次使用：自动装一套分类
    if (!Store.categories.length) {
      await Store.applyPack('college', true);
    }
    // 首次使用：自动补一个学期
    if (!Store.settings.semesters || !Store.settings.semesters.length) {
      const g = D.guessSemester(new Date());
      const sem = { id: U.uuid(), name: g.name, start: g.start, end: g.end };
      Store.settings.semesters = [sem];
      Store.settings.activeSemesterId = sem.id;
      await Store.saveSettings();
    }

    Store.reindex();
    await Store.normalizeCategories();   // 合并历史遗留的重复分类
    Store.loaded = true;
    return mode;
  };

  Store.reindex = function () {
    Store._txMap = new Map(Store.tx.map((t) => [t.id, t]));
    Store._catMap = new Map(Store.categories.map((c) => [c.id, c]));
  };

  /* ---------------- 设置 ---------------- */
  Store.saveSettings = async function (opts) {
    if (!opts || opts.touch !== false) Store.settingsUpdatedAt = Date.now();
    await DB.put('meta', {
      key: 'settings', value: Store.settings, settingsUpdatedAt: Store.settingsUpdatedAt
    });
  };
  Store.updateSettings = async function (patch) {
    Object.assign(Store.settings, patch);
    await Store.saveSettings();
    Store.emit('settings');
  };

  /* ---------------- 分类 ---------------- */
  Store.getCategory = function (id) { return Store._catMap.get(id) || null; };

  /* 可选分类：排除隐藏项；type 为 expense / income */
  Store.categoriesFor = function (type, includeHidden) {
    return Store.categories
      .filter((c) => (includeHidden || !c.hidden) && (c.type === type || c.type === 'both'))
      .sort((a, b) => a.order - b.order);
  };

  /* 在同一个视图里往前/往后挪一格（「记一笔」里的「调整顺序」用）。
     scopeList 是当前看得见的那个列表，保证换的是有意义的相邻两格。 */
  Store.moveCategoryIn = async function (id, dir, scopeList) {
    const arr = (scopeList || Store.categoriesFor(null, false)).slice();
    const i = arr.findIndex(function (c) { return c.id === id; });
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return false;
    const a = Store.getCategory(arr[i].id);
    const b = Store.getCategory(arr[j].id);
    if (!a || !b) return false;

    if (a.order === b.order) {
      /* 两笔的顺序值撞在一起时换不出来，就把这个视图整体重排一遍再换 */
      const rows = [];
      arr.forEach(function (c, idx) {
        const cc = Store.getCategory(c.id);
        if (!cc) return;
        cc.order = 1000 + (idx + 1) * 10;
        rows.push(cc);
      });
      const ra = rows.find(function (r) { return r.id === a.id; });
      const rb = rows.find(function (r) { return r.id === b.id; });
      const tmp0 = ra.order; ra.order = rb.order; rb.order = tmp0;
      await DB.putMany('categories', rows);
    } else {
      const tmp = a.order; a.order = b.order; b.order = tmp;
      await DB.putMany('categories', [a, b]);
    }
    Store.reindex();
    Store.emit('categories');
    return true;
  };

  Store.allCategoriesFor = function (type) {
    return Store.categories
      .filter((c) => !type || c.type === type || c.type === 'both')
      .sort((a, b) => a.order - b.order);
  };

  Store.addCategory = async function (data) {
    const maxOrder = Store.categories.reduce((m, c) => Math.max(m, c.order || 0), 0);
    const type = data.type === 'income' ? 'income' : (data.type === 'both' ? 'both' : 'expense');
    const cat = normalizeCategory(Object.assign({
      order: maxOrder + 10,
      id: data.id || categoryIdOf(type, data.name)
    }, data, { type: type, idMigrated: true }));
    Store.categories.push(cat);
    await DB.put('categories', cat);
    Store.reindex();
    Store.emit('categories');
    return cat;
  };

  Store.updateCategory = async function (id, patch) {
    const cat = Store.getCategory(id);
    if (!cat) return null;
    Object.assign(cat, patch);
    cat.updatedAt = Date.now();
    await DB.put('categories', cat);
    // 同步账单上冗余的分类名/图标，保证历史记录显示一致
    const affected = Store.tx.filter((t) => t.categoryId === id);
    if (affected.length) {
      affected.forEach((t) => { t.categoryName = cat.name; t.updatedAt = Date.now(); });
      await DB.putMany('tx', affected);
    }
    Store.reindex();
    Store.emit('categories');
    return cat;
  };

  Store.removeCategory = async function (id) {
    const cat = Store.getCategory(id);
    if (!cat) return;
    const used = Store.tx.filter((t) => t.categoryId === id).length;
    Store.categories = Store.categories.filter((c) => c.id !== id);
    Store.addTombstone(id);
    await DB.remove('categories', id);
    Store.reindex();
    Store.emit('categories');
    return used;
  };

  Store.moveCategory = async function (id, dir) {
    const list = Store.allCategoriesFor(null);
    const idx = list.findIndex((c) => c.id === id);
    const swap = list[idx + dir];
    if (!swap) return;
    const a = list[idx];
    const tmp = a.order;
    a.order = swap.order; swap.order = tmp;
    await DB.putMany('categories', [a, swap]);
    Store.reindex();
    Store.emit('categories');
  };

  /* 应用分类预设包 */
  Store.applyPack = async function (packId, silent) {
    const pack = D.categoryPacks.find((p) => p.id === packId);
    if (!pack) return 0;
    const byName = new Map(Store.categories.map((c) => [c.type + '|' + c.name, c]));
    const expenseDefs = D.expenseCategories.concat(pack.extraExpense || []);
    const incomeDefs = D.incomeCategories;
    const created = [];
    let order = Store.categories.reduce((m, c) => Math.max(m, c.order || 0), 0);

    pack.expense.forEach((name) => {
      if (byName.has('expense|' + name)) return;
      const def = expenseDefs.find((d) => d.name === name) || { name: name, icon: '🏷️', color: U.colorFromString(name) };
      order += 10;
      created.push(normalizeCategory({ id: categoryIdOf('expense', name), name: name, icon: def.icon, color: def.color, type: 'expense', builtin: true, order: order, idMigrated: true }));
    });
    pack.income.forEach((name) => {
      if (byName.has('income|' + name)) return;
      const def = incomeDefs.find((d) => d.name === name) || { name: name, icon: '🏷️', color: U.colorFromString(name) };
      order += 10;
      created.push(normalizeCategory({ id: categoryIdOf('income', name), name: name, icon: def.icon, color: def.color, type: 'income', builtin: true, order: order, idMigrated: true }));
    });

    if (created.length) {
      Store.categories.push.apply(Store.categories, created);
      await DB.putMany('categories', created);
      Store.reindex();
      if (!silent) Store.emit('categories');
    }
    return created.length;
  };

  /* ---------------- 账目 ---------------- */
  Store.getTx = function (id) { return Store._txMap.get(id) || null; };

  Store.addTx = async function (data) {
    const t = normalizeTx(data);
    if (!t.categoryId && t.categoryName) {
      const found = Store.categories.find((c) => c.name === t.categoryName && (c.type === t.type || c.type === 'both'));
      if (found) t.categoryId = found.id;
    }
    if (t.categoryId && !t.categoryName) {
      const c = Store.getCategory(t.categoryId);
      if (c) t.categoryName = c.name;
    }
    Store.tx.push(t);
    Store._txMap.set(t.id, t);
    await DB.put('tx', t);
    Store.emit('tx');
    return t;
  };

  Store.addManyTx = async function (list) {
    if (!list || !list.length) return 0;
    const rows = list.map(normalizeTx);
    Store.tx = Store.tx.concat(rows);
    Store.reindex();
    await DB.putMany('tx', rows);
    Store.emit('tx');
    return rows.length;
  };

  Store.updateTx = async function (id, patch) {
    const t = Store.getTx(id);
    if (!t) return null;
    Object.assign(t, patch);
    const norm = normalizeTx(t);
    Object.assign(t, norm);
    t.updatedAt = Date.now();
    await DB.put('tx', t);
    Store.emit('tx');
    return t;
  };

  Store.removeTx = async function (id) {
    Store.tx = Store.tx.filter((t) => t.id !== id);
    Store._txMap.delete(id);
    Store.addTombstone(id);
    await DB.remove('tx', id);
    Store.emit('tx');
  };

  Store.removeManyTx = async function (ids) {
    const set = new Set(ids);
    Store.tx = Store.tx.filter((t) => !set.has(t.id));
    ids.forEach((id) => Store.addTombstone(id));
    Store.reindex();
    await DB.removeMany('tx', ids);
    Store.emit('tx');
  };

  /* 批量改分类 */
  Store.reassignCategory = async function (ids, categoryId) {
    const cat = Store.getCategory(categoryId);
    const rows = [];
    ids.forEach((id) => {
      const t = Store.getTx(id);
      if (!t) return;
      t.categoryId = categoryId;
      t.categoryName = cat ? cat.name : '';
      t.updatedAt = Date.now();
      rows.push(t);
    });
    if (rows.length) await DB.putMany('tx', rows);
    Store.emit('tx');
    return rows.length;
  };

  /* ---------------- 报销 / 不计入统计 ---------------- */
  /* 把一笔支出标记为「待报销」：立即从统计中排除 */
  Store.markReimburse = async function (id, reasonName) {
    return Store.updateTx(id, {
      excludeStat: true,
      excludeReason: reasonName || '报销',
      reimburseStatus: 'pending',
      reimburseRole: 'out'
    });
  };

  /* 标记为其他「不计入统计」原因（代付/借还款/账户互转等） */
  Store.markExcluded = async function (id, reasonName, excluded) {
    return Store.updateTx(id, {
      excludeStat: excluded !== false,
      excludeReason: excluded === false ? '' : (reasonName || '不计收支'),
      reimburseStatus: excluded === false ? '' : ''
    });
  };

  /* 报销 / 收回垫付，用词不一样，这里统一决定 */
  Store.pairWords = function (reason) {
    const r = String(reason || '');
    if (r.indexOf('代付') >= 0 || r.indexOf('代垫') >= 0) {
      return { act: '收回来了', done: '已收回', amount: '收回金额', cat: '收回代付', item: '收回代付', title: '收回垫付的钱' };
    }
    if (r.indexOf('借') >= 0) {
      return { act: '收回来了', done: '已收回', amount: '收回金额', cat: '收回借款', item: '收回借款', title: '收回借出去的钱' };
    }
    return { act: '收到报销款', done: '已报销', amount: '报销到账金额', cat: '报销', item: '报销款', title: '收到报销款' };
  };

  /* 收到报销款 / 收回垫付：生成（或更新）一笔关联的对方记录，并和原支出配对。
     报销、代付、借出去的钱，用的是同一套配对机制，只是用词不同。
     三种情况都支持：
       - 正好抵完：两笔都不计入统计
       - 只还了一部分：收回的钱不算收入，抵扣掉的部分不计入；
         剩下自己承担的那部分，仍然算你自己的支出
       - 还多了：原支出全额不计入；多出来的那部分默认算收入
         （想当礼物、不当收入的话，传 opts.countExtra = false）
     已经配过对的再进来一次，是「改金额 / 对方又还了一部分」，
     会更新原来那笔，不会多出一条。 */
  Store.settleReimburse = async function (expenseIds, opts) {
    opts = opts || {};
    const ids = (Array.isArray(expenseIds) ? expenseIds : [expenseIds]).filter(Boolean);
    const exps = ids.map(function (id) { return Store.getTx(id); })
      .filter(Boolean)
      /* 按时间从早到晚抵消：先垫的先生效，和父母还钱的习惯一致 */
      .sort(function (a, b) { return a.time - b.time; });
    if (!exps.length) throw new Error('找不到要配对的支出');
    const first = exps[0];
    const reason = String(opts.reason || first.excludeReason || '报销').trim() || '报销';
    const words = Store.pairWords(reason);
    /* 从某一笔进来再改金额时，沿用原来那一组；一次抵消多笔时开新的一组 */
    const groupId = (exps.length === 1 && first.reimburseGroupId) || U.uuid();
    const countExtra = opts.countExtra !== false;

    /* ---- 收到的钱：优先用账目里已有的收入记录 ---- */
    const incomeIds = (Array.isArray(opts.incomeIds) ? opts.incomeIds
      : (opts.incomeIds ? [opts.incomeIds] : [])).filter(Boolean);
    let incomes = incomeIds.map(function (id) { return Store.getTx(id); })
      .filter(function (t) { return t && t.type === 'income'; })
      .sort(function (a, b) { return a.time - b.time; });
    let got = U.round2(incomes.reduce(function (s, t) { return s + t.amount; }, 0));

    if (!incomes.length) {
      /* 兼容旧用法：没有现成收入记录时，自己补一笔（手机上已经不走这条路） */
      if (opts.amount === undefined) throw new Error('请先选「这笔钱是哪几笔收入进来的」');
      const catName = opts.categoryName || words.cat;
      let cat = Store.categories.find(function (c) { return c.name === catName && c.type === 'income'; });
      if (!cat) cat = await Store.addCategory({ name: catName, type: 'income', icon: '🎫', color: '#8b5cf6' });
      got = U.round2(Math.abs(U.parseAmount(opts.amount)));
      /* 这一组之前已经自动补过一笔收入的话就改它，别再多出一条 */
      const existed = Store.tx.find((x) => x.reimburseGroupId === groupId && x.reimburseRole === 'in' && x.reimburseAuto);
      if (existed) {
        await Store.updateTx(existed.id, {
          amount: got,
          time: opts.time ? U.fromISO(opts.time).getTime() : existed.time,
          account: opts.account || existed.account,
          counterparty: opts.counterparty || existed.counterparty,
          excludeReason: reason,
          reimburseAmount: got
        });
        incomes = [Store.getTx(existed.id)];
      } else {
      const made = await Store.addTx({
        type: 'income',
        amount: got,
        time: opts.time ? U.fromISO(opts.time).getTime() : Date.now(),
        categoryId: cat.id,
        categoryName: cat.name,
        account: opts.account || first.account,
        counterparty: opts.counterparty || '',
        item: (opts.item || words.item) + '：' + (first.item || first.categoryName || '支出'),
        note: opts.note || '',
        excludeStat: true,
        excludeReason: reason,
        reimburseGroupId: groupId,
        reimburseStatus: 'done',
        reimburseRole: 'in',
        reimburseAmount: got,
        reimburseAuto: true,
        source: 'manual'
      });
      incomes = [made];
      }
    }

    /* ---- 整组一起重算 ----
         把「这一组里已有的成员」和「这次新勾的」合到一起，再统一分配。
         这样再进来补一笔钱（又还了一部分）时，之前抵掉的部分不会被冲掉。 */
    const seenIn = {};
    const allIns = Store.tx
      .filter(function (x) { return x.reimburseGroupId === groupId && x.reimburseRole === 'in'; })
      .concat(incomes)
      .filter(function (x) { if (seenIn[x.id]) return false; seenIn[x.id] = 1; return true; })
      .sort(function (p, q) { return p.time - q.time; });
    const seenOut = {};
    const allOuts = Store.tx
      .filter(function (x) { return x.reimburseGroupId === groupId && x.reimburseRole === 'out'; })
      .concat(exps)
      .filter(function (x) { if (seenOut[x.id]) return false; seenOut[x.id] = 1; return true; })
      .sort(function (p, q) { return p.time - q.time; });

    got = U.round2(allIns.reduce(function (s, t) { return s + t.amount; }, 0));

    /* 钱按「先垫先抵」分给垫付：分到的从统计里抵扣掉，没分到的仍算自己花的钱 */
    let remaining = got;
    for (let i = 0; i < allOuts.length; i++) {
      const exp = allOuts[i];
      const amount = U.round2(exp.amount);
      const covered = U.round2(Math.max(0, Math.min(remaining, amount)));
      remaining = U.round2(remaining - covered);
      const selfPay = U.round2(amount - covered);
      await Store.updateTx(exp.id, {
        excludeStat: selfPay <= 0 && covered > 0,
        excludeAmount: covered,
        excludeReason: covered > 0 ? reason : (exp.excludeReason || reason),
        reimburseGroupId: groupId,
        reimburseStatus: 'done',
        reimburseRole: 'out',
        reimburseAmount: covered,
        reimburseAuto: false
      });
    }

    /* 再把这笔钱里「垫付返还」的部分分摊到这几笔收入上：
         分摊掉的不是收入，剩下的（对方多给的）仍然算收入 */
    let coveredTotal = U.round2(allOuts.reduce(function (s, x) { return s + (Store.getTx(x.id).reimburseAmount || 0); }, 0));
    let rest = countExtra ? coveredTotal : coveredTotal + got + 1;   // 关掉开关时，这几笔收入一律不算收入
    for (let i = 0; i < allIns.length; i++) {
      const inc = allIns[i];
      const amount = U.round2(inc.amount);
      const excl = U.round2(Math.max(0, Math.min(rest, amount)));
      rest = U.round2(rest - excl);
      const full = excl >= amount - 0.005;
      await Store.updateTx(inc.id, {
        excludeStat: full,
        excludeAmount: full ? 0 : excl,
        excludeReason: reason,
        reimburseGroupId: groupId,
        reimburseStatus: 'done',
        reimburseRole: 'in',
        reimburseAmount: amount
      });
    }
    return Store.getTx(allIns[0] ? allIns[0].id : incomes[0].id);
  };

  /* 一笔报销的相关数字：垫了多少、报了多少、抵掉多少、自付多少、多给多少。
     一次转账可以抵消好几笔垫付，所以这里把整组一起算。 */
  Store.reimburseInfo = function (t) {
    if (!t || !t.reimburseGroupId) return null;
    const group = t.reimburseGroupId;
    const outs = Store.tx.filter(function (x) { return x.reimburseGroupId === group && x.reimburseRole === 'out'; });
    const ins = Store.tx.filter(function (x) { return x.reimburseGroupId === group && x.reimburseRole === 'in'; });
    const spent = U.round2(outs.reduce(function (s, x) { return s + x.amount; }, 0));
    const covered = U.round2(outs.reduce(function (s, x) { return s + (x.reimburseAmount || 0); }, 0));
    const got = U.round2(ins.reduce(function (s, x) { return s + x.amount; }, 0));
    const reason = (outs[0] && outs[0].excludeReason) || (ins[0] && ins[0].excludeReason) || '报销';
    return {
      group: group,
      reason: reason,
      words: Store.pairWords(reason),
      outs: outs,
      ins: ins,
      out: outs[0] || null,
      income: ins[0] || null,
      count: outs.length,
      incomeCount: ins.length,
      spent: spent,
      got: got,
      covered: U.round2(Math.min(covered, spent)),
      selfPay: U.round2(Math.max(0, spent - covered)),
      extra: U.round2(Math.max(0, got - covered))
    };
  };

  /* 取消配对：整组（可能有好几笔垫付 + 一笔到账）全部恢复计入统计，
     自动生成的那笔到账记录删掉。 */
  Store.cancelReimburse = async function (id) {
    const t = Store.getTx(id);
    if (!t) return;
    const group = t.reimburseGroupId;
    const restore = {
      excludeStat: false,
      excludeAmount: 0,
      excludeReason: '',
      reimburseGroupId: '',
      reimburseStatus: '',
      reimburseRole: '',
      reimburseAmount: 0
    };
    if (!group) {
      await Store.updateTx(id, restore);
      return true;
    }
    const members = Store.tx.filter((x) => x.reimburseGroupId === group);
    /* 只有「配对时自动补的那笔收入」才删掉；你自己账上的收入只解除配对 */
    const autoIds = members.filter((x) => x.reimburseRole === 'in' && x.reimburseAuto).map((x) => x.id);
    const keepIds = members.filter((x) => autoIds.indexOf(x.id) < 0).map((x) => x.id);
    for (let i = 0; i < keepIds.length; i++) await Store.updateTx(keepIds[i], restore);
    if (autoIds.length) await Store.removeManyTx(autoIds);
    if (Store._catMap.size === 0) Store.reindex();
    return true;
  };

  /* 配对时可以勾选的收入记录：账上的收入，且还没被别的配对用过 */
  Store.incomeCandidates = function (currentId) {
    return Store.tx
      .filter(function (t) {
        if (t.type !== 'income') return false;
        if (t.hidden) return false;
        if (t.reimburseGroupId && t.id !== currentId) return false;
        return true;
      })
      .sort(function (a, b) { return b.time - a.time; })
      .slice(0, 60);
  };

  /* 一次报销时，可以让用户勾选「这笔钱抵消哪些垫付」。
     待报销的排最前，其次是被标记为代付/借还款的，最后是最近的其它支出。 */
  Store.reimburseCandidates = function (currentId) {
    const rank = function (t) {
      if (t.reimburseStatus === 'pending') return 0;
      if (t.excludeStat && !t.reimburseGroupId) return 1;
      return 2;
    };
    return Store.tx
      .filter(function (t) {
        if (t.type !== 'expense') return false;
        if (t.reimburseGroupId && t.id !== currentId) return false;   // 已经配过对的不用再选
        return true;
      })
      .sort(function (a, b) {
        const ra = rank(a); const rb = rank(b);
        if (ra !== rb) return ra - rb;
        return b.time - a.time;
      })
      .slice(0, 60);
  };

  /* 待报销清单 */
  Store.pendingReimburse = function () {
    return Store.tx.filter((t) => t.reimburseStatus === 'pending');
  };

  /* ---------------- 查询 ---------------- */
  /* filter: {from,to,types,categoryIds,accounts,q,includeExcluded,includeHidden,tag,amountMin,amountMax,reimburseStatus} */
  Store.query = function (filter) {
    filter = filter || {};
    const from = filter.from ? U.startOfDay(filter.from).getTime() : -Infinity;
    const to = filter.to ? U.endOfDay(filter.to).getTime() : Infinity;
    const types = filter.types && filter.types.length ? filter.types : null;
    const cats = filter.categoryIds && filter.categoryIds.length ? new Set(filter.categoryIds) : null;
    const accounts = filter.accounts && filter.accounts.length ? new Set(filter.accounts) : null;
    const q = filter.q ? String(filter.q).trim().toLowerCase() : '';
    const includeExcluded = !!filter.includeExcluded;
    const includeHidden = !!filter.includeHidden;

    const out = [];
    for (let i = 0; i < Store.tx.length; i++) {
      const t = Store.tx[i];
      if (t.time < from || t.time > to) continue;
      if (!includeHidden && t.hidden) continue;
      if (!includeExcluded && t.excludeStat) continue;
      if (types && types.indexOf(t.type) < 0) continue;
      if (cats && !cats.has(t.categoryId)) continue;
      if (accounts && !accounts.has(t.account)) continue;
      if (filter.reimburseStatus && t.reimburseStatus !== filter.reimburseStatus) continue;
      if (filter.onlyReimburse && !t.reimburseGroupId) continue;
      if (q) {
        const hay = (t.counterparty + ' ' + t.item + ' ' + t.note + ' ' + t.categoryName + ' ' + t.account + ' ' + t.tags.join(' ')).toLowerCase();
        if (hay.indexOf(q) < 0) continue;
      }
      out.push(t);
    }
    out.sort((a, b) => (b.time - a.time) || (b.createdAt - a.createdAt));
    return out;
  };

  /* 全部标签 */
  Store.allTags = function () {
    const set = new Set();
    Store.tx.forEach((t) => t.tags.forEach((x) => set.add(x)));
    return Array.from(set).sort();
  };

  /* ---------------- 历史联想 ----------------
     从已有账目里找「以前填过的来源 / 用途」，按「出现次数 + 最近使用」排序，
     前缀相同的排前面。这样记账时能对齐以前的写法，统计才准。 */
  Store.suggest = function (field, query, limit) {
    const q = String(query || '').trim().toLowerCase();
    const map = new Map();

    Store.tx.forEach(function (t) {
      const v = String(t[field] || '').trim();
      if (!v) return;
      let rec = map.get(v);
      if (!rec) { rec = { value: v, count: 0, last: 0, cats: new Map() }; map.set(v, rec); }
      rec.count++;
      if (t.time > rec.last) rec.last = t.time;
      if (t.categoryName) rec.cats.set(t.categoryName, (rec.cats.get(t.categoryName) || 0) + 1);
    });

    let list = Array.from(map.values());
    if (q) list = list.filter(function (r) { return r.value.toLowerCase().indexOf(q) >= 0; });

    list.sort(function (a, b) {
      const ap = q && a.value.toLowerCase().indexOf(q) === 0 ? 0 : 1;
      const bp = q && b.value.toLowerCase().indexOf(q) === 0 ? 0 : 1;
      if (ap !== bp) return ap - bp;
      if (b.count !== a.count) return b.count - a.count;
      return b.last - a.last;
    });

    return limit ? list.slice(0, limit) : list;
  };

  /* 这个来源 / 用途历史上最常记成哪个分类 */
  Store.commonCategoryFor = function (field, value) {
    const v = String(value || '').trim();
    if (!v) return null;
    const rec = Store.suggest(field, '', 0).find(function (r) { return r.value === v; });
    if (!rec) return null;
    let best = null;
    rec.cats.forEach(function (n, name) {
      if (!best || n > best.count) best = { name: name, count: n };
    });
    return best;
  };

  /* ---------------- 导入规则 ---------------- */
  Store.addRule = async function (rule) {
    const r = { id: U.uuid(), kw: rule.kw || [], cat: rule.cat || '', type: rule.type || 'expense' };
    Store.settings.rules = Store.settings.rules || [];
    Store.settings.rules.unshift(r);
    await Store.saveSettings();
    Store.emit('settings');
    return r;
  };

  Store.removeRule = async function (id) {
    Store.settings.rules = (Store.settings.rules || []).filter((r) => r.id !== id);
    await Store.saveSettings();
    Store.emit('settings');
  };

  /* ---------------- 学期 ---------------- */
  Store.semesters = function () { return Store.settings.semesters || []; };
  Store.activeSemester = function () {
    const list = Store.semesters();
    return list.find((s) => s.id === Store.settings.activeSemesterId) || list[0] || null;
  };
  Store.addSemester = async function (sem) {
    const s = Object.assign({ id: U.uuid() }, sem);
    Store.settings.semesters = Store.semesters().concat([s]);
    if (!Store.settings.activeSemesterId) Store.settings.activeSemesterId = s.id;
    await Store.saveSettings();
    Store.emit('settings');
    return s;
  };
  Store.updateSemester = async function (id, patch) {
    const list = Store.semesters();
    const s = list.find((x) => x.id === id);
    if (!s) return null;
    Object.assign(s, patch);
    await Store.saveSettings();
    Store.emit('settings');
    return s;
  };
  Store.removeSemester = async function (id) {
    Store.settings.semesters = Store.semesters().filter((s) => s.id !== id);
    if (Store.settings.activeSemesterId === id) {
      Store.settings.activeSemesterId = (Store.semesters()[0] || {}).id || '';
    }
    await Store.saveSettings();
    Store.emit('settings');
  };

  /* ---------------- 假期 ----------------
     寒暑假、国庆这些时间人在家，校园里的花销口径对不上，
     所以可以让这段时间的账目不计入周/月/学期合计（明细里照常保留）。 */
  Store.vacations = function () { return Store.settings.vacations || []; };

  /* 这段时间落在哪个假期里（没有就返回 null） */
  Store.inVacation = function (time) {
    const t = Number(time) || 0;
    const list = Store.vacations();
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v || !v.start || !v.end) continue;
      const from = U.startOfDay(U.fromISO(v.start)).getTime();
      const to = U.endOfDay(U.fromISO(v.end)).getTime();
      if (t >= from && t <= to) return v;
    }
    return null;
  };

  Store.addVacation = async function (v) {
    const item = Object.assign({ id: U.uuid(), name: '假期' }, v);
    Store.settings.vacations = Store.vacations().concat([item]);
    await Store.saveSettings();
    Store.emit('settings');
    return item;
  };

  Store.updateVacation = async function (id, patch) {
    const list = Store.vacations();
    const item = list.find((x) => x.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    await Store.saveSettings();
    Store.emit('settings');
    return item;
  };

  Store.removeVacation = async function (id) {
    Store.settings.vacations = Store.vacations().filter((x) => x.id !== id);
    await Store.saveSettings();
    Store.emit('settings');
  };

  /* ---------------- 备份 / 导出 ---------------- */
  Store.exportObject = function () {
    return {
      app: '大学生活记账本',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      settings: Store.settings,
      categories: Store.categories,
      tx: Store.tx
    };
  };

  Store.exportJSON = function () {
    return JSON.stringify(Store.exportObject(), null, 2);
  };

  /* mode: 'merge' 合并（按 id 去重）| 'replace' 覆盖 */
  Store.importObject = async function (obj, mode) {
    if (!obj || typeof obj !== 'object') throw new Error('文件内容不是有效的备份格式');
    const txIn = Array.isArray(obj.tx) ? obj.tx : [];
    const catIn = Array.isArray(obj.categories) ? obj.categories : [];
    const setIn = obj.settings || null;

    if (mode === 'replace') {
      await Store.clearAllData();
    }

    // 分类：按 id 合并，同 id 覆盖
    const catMap = new Map(Store.categories.map((c) => [c.id, c]));
    const newCats = [];
    catIn.forEach((c) => {
      const nc = normalizeCategory(c);
      if (!catMap.has(nc.id) || mode === 'replace') { catMap.set(nc.id, nc); newCats.push(nc); }
    });
    Store.categories = Array.from(catMap.values());
    if (newCats.length) await DB.putMany('categories', newCats);

    // 账目：按 id 去重
    const txMap = new Map(Store.tx.map((t) => [t.id, t]));
    const newTx = [];
    let skipped = 0;
    txIn.forEach((t) => {
      const nt = normalizeTx(t);
      if (txMap.has(nt.id)) { skipped++; return; }
      txMap.set(nt.id, nt);
      newTx.push(nt);
    });
    Store.tx = Array.from(txMap.values());
    if (newTx.length) await DB.putMany('tx', newTx);

    // 设置
    if (setIn && mode === 'replace') {
      Store.settings = Object.assign({}, D.settings, setIn);
      await Store.saveSettings();
    }

    Store.reindex();
    Store.emit('all');
    return { categories: newCats.length, tx: newTx.length, skipped: skipped };
  };

  /* CSV 导出（可传入筛选后的账单） */
  Store.exportCSV = function (list) {
    list = list || Store.tx.slice().sort((a, b) => b.time - a.time);
    const rows = [['日期', '时间', '类型', '金额', '分类', '账户', '来源(交易对方)', '用途(商品/事项)', '备注', '是否计入统计', '排除原因', '报销状态', '标签', '导入来源']];
    list.forEach((t) => {
      const d = new Date(t.time);
      rows.push([
        U.toISODate(d),
        ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2),
        t.type === 'income' ? '收入' : '支出',
        t.type === 'income' ? t.amount : -t.amount,
        t.categoryName || '',
        t.account || '',
        t.counterparty || '',
        t.item || '',
        t.note || '',
        t.excludeStat ? '不计入' : '计入',
        t.excludeReason || '',
        t.reimburseStatus === 'pending' ? '待报销' : (t.reimburseStatus === 'done' ? '已报销' : ''),
        t.tags.join('|'),
        t.source || ''
      ]);
    });
    return U.toCSV(rows);
  };

  Store.stats = function () {
    const total = Store.tx.length;
    return {
      total: total,
      names: Store.categories.length,
      size: JSON.stringify(Store.exportObject()).length
    };
  };

  /* ============================================================
     设备同步支持
     规则：同一条数据按 updatedAt 比较，后修改的胜出；
          删除操作用「墓碑」记录，避免被另一台设备又把数据推回来。
     ============================================================ */

  Store.addTombstone = function (id) {
    if (!id) return;
    Store.tombstones[id] = Date.now();
    saveTombstonesSoon();
  };

  /* 打包本地数据，准备发给服务器 / 另一台设备 */
  Store.syncSnapshot = function (deviceId, deviceName) {
    const settings = {};
    SYNC_SETTING_KEYS.forEach((k) => { if (Store.settings[k] !== undefined) settings[k] = Store.settings[k]; });
    return {
      deviceId: deviceId || '',
      deviceName: deviceName || '',
      tx: Store.tx,
      categories: Store.categories,
      settings: settings,
      settingsUpdatedAt: Store.settingsUpdatedAt,
      tombstones: Object.keys(Store.tombstones).map((id) => ({ id: id, at: Store.tombstones[id] }))
    };
  };

  /* 统计将要发生的变动（在应用之前调用），用于显示同步结果 */
  Store.diffRemote = function (result) {
    const remoteTx = new Map();
    (result.tx || []).forEach((rt) => remoteTx.set(rt.id, rt));
    let willArrive = 0, willLeave = 0;
    remoteTx.forEach((rt, id) => {
      const cur = Store._txMap.get(id);
      if (!cur || (rt.updatedAt || 0) > (cur.updatedAt || 0)) willArrive++;
    });
    (result.tombstones || []).forEach((tb) => {
      if (tb && Store._txMap.has(tb.id) && (tb.at || 0) > (Store.tombstones[tb.id] || 0)) willLeave++;
    });
    return { willArrive: willArrive, willLeave: willLeave, remoteTotal: remoteTx.size };
  };

  /* 把远端合并结果并回本地 */
  Store.applyRemote = async function (result) {
    const stat = { added: 0, updated: 0, removed: 0, catAdded: 0, catUpdated: 0, catRemoved: 0, settings: false };

    /* 1. 删除（墓碑） */
    const removedIds = new Set();
    (result.tombstones || []).forEach((tb) => {
      if (!tb || !tb.id) return;
      if ((tb.at || 0) > (Store.tombstones[tb.id] || 0)) Store.tombstones[tb.id] = tb.at || 0;
      removedIds.add(tb.id);
    });
    if (removedIds.size) {
      const beforeTx = Store.tx.length;
      Store.tx = Store.tx.filter((t) => !removedIds.has(t.id));
      stat.removed = beforeTx - Store.tx.length;
      const beforeCat = Store.categories.length;
      Store.categories = Store.categories.filter((c) => !removedIds.has(c.id));
      stat.catRemoved = beforeCat - Store.categories.length;
    }

    /* 2. 账目 */
    const txMap = new Map(Store.tx.map((t) => [t.id, t]));
    const dirtyTx = [];
    (result.tx || []).forEach((rt) => {
      if (!rt || !rt.id) return;
      const cur = txMap.get(rt.id);
      if (!cur) { const v = normalizeTx(rt); txMap.set(v.id, v); dirtyTx.push(v); stat.added++; }
      else if ((rt.updatedAt || 0) > (cur.updatedAt || 0)) {
        const v = normalizeTx(rt); txMap.set(v.id, v); dirtyTx.push(v); stat.updated++;
      }
    });
    if (dirtyTx.length) {
      Store.tx = Array.from(txMap.values());
      await DB.putMany('tx', dirtyTx);
    }

    /* 3. 分类 */
    const catMap = new Map(Store.categories.map((c) => [c.id, c]));
    const dirtyCat = [];
    (result.categories || []).forEach((rc) => {
      if (!rc || !rc.id) return;
      const cur = catMap.get(rc.id);
      if (!cur) { const v = normalizeCategory(rc); catMap.set(v.id, v); dirtyCat.push(v); stat.catAdded++; }
      else if ((rc.updatedAt || 0) > (cur.updatedAt || 0)) {
        const v = normalizeCategory(rc); catMap.set(v.id, v); dirtyCat.push(v); stat.catUpdated++;
      }
    });
    if (dirtyCat.length) {
      Store.categories = Array.from(catMap.values());
      await DB.putMany('categories', dirtyCat);
    }

    /* 4. 设置 */
    if (result.settings && (result.settingsUpdatedAt || 0) > (Store.settingsUpdatedAt || 0)) {
      Object.assign(Store.settings, result.settings);
      Store.settingsUpdatedAt = result.settingsUpdatedAt || 0;
      await Store.saveSettings({ touch: false });
      stat.settings = true;
    }

    saveTombstonesSoon();
    Store.reindex();
    // 另一台设备可能推上来同一分类的另一份，这里再合并一次
    const fixed = await Store.normalizeCategories();
    if (fixed && fixed.changed) stat.catMerged = fixed.changed;
    Store.emit('all');
    return stat;
  };

  /* 清空业务数据（账单 / 分类 / 设置 / 删除记录）。
     刻意保留「应用内备份快照」，避免清空之后再也找不回来。 */
  Store.clearAllData = async function () {
    await DB.clear('tx');
    await DB.clear('categories');
    await DB.remove('meta', 'settings');
    await DB.remove('meta', 'tombstones');
    Store.tx = [];
    Store.categories = [];
    Store.settings = Object.assign({}, D.settings);
    Store.tombstones = {};
    Store.settingsUpdatedAt = 0;
    Store.reindex();
  };

  /* ============================================================
     分类整理：合并同名同类型的重复分类，并把 id 迁成固定值
     ============================================================ */
  Store.normalizeCategories = async function () {
    if (!Store.categories.length) return { changed: 0 };

    const remap = new Map();     // 旧 id -> 保留的 id
    const byKey = new Map();     // 类型|名称 -> 保留的那个分类
    const usedIds = new Set();
    const result = [];
    let changed = 0;

    // 排序保证两台设备挑中的「保留者」一致
    const sorted = Store.categories.slice().sort(function (a, b) {
      return (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name));
    });

    sorted.forEach(function (c) {
      const key = c.type + '|' + c.name;
      const kept = byKey.get(key);
      if (kept) {
        if (c.id !== kept.id) remap.set(c.id, kept.id);
        changed++;
        return;
      }

      const want = categoryIdOf(c.type, c.name);
      let finalId = c.id;
      if (!c.idMigrated) {
        if (want !== c.id && !usedIds.has(want)) finalId = want;
        c.idMigrated = true;
      }
      if (finalId !== c.id) { remap.set(c.id, finalId); changed++; }
      c.id = finalId;

      usedIds.add(finalId);
      byKey.set(key, c);
      result.push(c);
    });

    if (!changed) return { changed: 0 };

    // 1) 账单改指向保留下来的分类
    const byId = new Map(result.map(function (c) { return [c.id, c]; }));
    const dirtyTx = [];
    Store.tx.forEach(function (t) {
      const to = remap.get(t.categoryId);
      if (!to) return;
      t.categoryId = to;
      const c = byId.get(to);
      if (c) t.categoryName = c.name;
      t.updatedAt = Date.now();
      dirtyTx.push(t);
    });
    if (dirtyTx.length) await DB.putMany('tx', dirtyTx);

    // 2) 删掉被合并掉的旧分类，并留下删除标记（这样另一台设备也会一起合并）
    const keepIds = new Set(result.map(function (c) { return c.id; }));
    const dropIds = Array.from(remap.keys()).filter(function (id) { return !keepIds.has(id); });
    if (dropIds.length) {
      await DB.removeMany('categories', dropIds);
      dropIds.forEach(function (id) { Store.addTombstone(id); });
    }

    // 3) 写回整理后的分类
    await DB.putMany('categories', result);

    Store.categories = result;
    Store.reindex();
    return { changed: changed, dropped: dropIds.length };
  };

  /* ============================================================
     分级清理
     每一档只清掉指定的那部分，其余内容原样保留；都尽量保留
     「删除标记」并在同步时带到其它设备，避免清完又被同步回来。
     ============================================================ */

  /* 仅清空账单：分类、设置、备份都保留 */
  Store.clearTransactions = async function () {
    const ids = Store.tx.map((t) => t.id);
    await DB.clear('tx');
    ids.forEach((id) => Store.addTombstone(id));
    Store.tx = [];
    Store.reindex();
    Store.emit('tx');
    return ids.length;
  };

  /* 仅清空分类，随后自动装回一套默认分类，保证还能正常记账 */
  Store.clearCategories = async function () {
    const ids = Store.categories.map((c) => c.id);
    await DB.clear('categories');
    ids.forEach((id) => Store.addTombstone(id));
    Store.categories = [];
    Store.reindex();
    const added = await Store.applyPack('college', true);
    Store.emit('categories');
    return { removed: ids.length, added: added };
  };

  /* 仅恢复默认设置（账目与分类保留） */
  Store.resetSettings = async function () {
    Store.settings = Object.assign({}, D.settings);
    const g = D.guessSemester(new Date());
    const sem = { id: U.uuid(), name: g.name, start: g.start, end: g.end };
    Store.settings.semesters = [sem];
    Store.settings.activeSemesterId = sem.id;
    await Store.saveSettings();
    Store.emit('settings');
  };

  /* 清除所有数据：账目、分类、设置、备份快照全部清掉。
     但会保留「删除标记」，这样如果其它设备还连着同步，
     下次同步时它们上面的数据也会被一并删除，而不是又倒灌回来。 */
  Store.wipeAll = async function () {
    const txIds = Store.tx.map((t) => t.id);
    const catIds = Store.categories.map((c) => c.id);

    await DB.clearAll();

    Store.tx = [];
    Store.categories = [];
    Store.settings = Object.assign({}, D.settings);
    const g = D.guessSemester(new Date());
    const sem = { id: U.uuid(), name: g.name, start: g.start, end: g.end };
    Store.settings.semesters = [sem];
    Store.settings.activeSemesterId = sem.id;
    Store.settingsUpdatedAt = 0;

    Store.tombstones = {};
    const now = Date.now();
    txIds.concat(catIds).forEach((id) => { Store.tombstones[id] = now; });

    Store.reindex();
    await Store.saveSettings();
    await DB.put('meta', { key: 'tombstones', value: Store.tombstones });
    Store.emit('all');
    return { tx: txIds.length, categories: catIds.length };
  };

  global.Store = Store;
})(window);