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
    'autoClassifyOnImport', 'dedupeOnImport', 'lastAccount'];

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
      excludeReason: t.excludeReason || '',
      reimburseGroupId: t.reimburseGroupId || '',
      reimburseStatus: t.reimburseStatus || '',
      reimburseRole: t.reimburseRole || '',
      hidden: !!t.hidden,
      source: t.source || 'manual',
      externalId: t.externalId || '',
      createdAt: t.createdAt || Date.now(),
      updatedAt: t.updatedAt || Date.now()
    };
  }

  function normalizeCategory(c, i) {
    return {
      id: c.id || ('cat_' + U.uuid()),
      name: c.name || '未命名',
      type: c.type === 'income' ? 'income' : (c.type === 'both' ? 'both' : 'expense'),
      icon: c.icon || '🏷️',
      color: c.color || U.colorFromString(c.name),
      hidden: !!c.hidden,
      excludeByDefault: !!c.excludeByDefault,
      builtin: !!c.builtin,
      order: typeof c.order === 'number' ? c.order : (i || 0) * 10,
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

  Store.allCategoriesFor = function (type) {
    return Store.categories
      .filter((c) => !type || c.type === type || c.type === 'both')
      .sort((a, b) => a.order - b.order);
  };

  Store.addCategory = async function (data) {
    const maxOrder = Store.categories.reduce((m, c) => Math.max(m, c.order || 0), 0);
    const cat = normalizeCategory(Object.assign({ order: maxOrder + 10 }, data));
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
      created.push(normalizeCategory({ name: name, icon: def.icon, color: def.color, type: 'expense', builtin: true, order: order }));
    });
    pack.income.forEach((name) => {
      if (byName.has('income|' + name)) return;
      const def = incomeDefs.find((d) => d.name === name) || { name: name, icon: '🏷️', color: U.colorFromString(name) };
      order += 10;
      created.push(normalizeCategory({ name: name, icon: def.icon, color: def.color, type: 'income', builtin: true, order: order }));
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

  /* 收到报销款：生成一笔关联的收入，并把两笔都设为「已报销·不计入统计」 */
  Store.settleReimburse = async function (expenseId, opts) {
    opts = opts || {};
    const exp = Store.getTx(expenseId);
    if (!exp) throw new Error('找不到该笔支出');
    const groupId = exp.reimburseGroupId || U.uuid();
    const catName = opts.categoryName || '报销';
    let cat = Store.categories.find((c) => c.name === catName && c.type === 'income');
    if (!cat) cat = await Store.addCategory({ name: catName, type: 'income', icon: '🎫', color: '#8b5cf6' });

    await Store.updateTx(expenseId, {
      excludeStat: true,
      excludeReason: '报销',
      reimburseGroupId: groupId,
      reimburseStatus: 'done',
      reimburseRole: 'out'
    });

    const inc = await Store.addTx({
      type: 'income',
      amount: opts.amount !== undefined ? opts.amount : exp.amount,
      time: opts.time ? U.fromISO(opts.time).getTime() : Date.now(),
      categoryId: cat.id,
      categoryName: cat.name,
      account: opts.account || exp.account,
      counterparty: opts.counterparty || '',
      item: '报销款：' + (exp.item || exp.categoryName || '支出'),
      note: opts.note || '',
      excludeStat: true,
      excludeReason: '报销',
      reimburseGroupId: groupId,
      reimburseStatus: 'done',
      reimburseRole: 'in',
      source: 'manual'
    });
    return inc;
  };

  /* 取消报销标记：恢复计入统计 */
  Store.cancelReimburse = async function (id) {
    const t = Store.getTx(id);
    if (!t) return;
    const group = t.reimburseGroupId;
    const toRemove = [];
    if (group) {
      Store.tx.forEach((x) => { if (x.reimburseGroupId === group && x.id !== id) toRemove.push(x.id); });
      if (toRemove.length) await Store.removeManyTx(toRemove);
    }
    await Store.updateTx(id, {
      excludeStat: false,
      excludeReason: '',
      reimburseGroupId: '',
      reimburseStatus: '',
      reimburseRole: ''
    });
    if (Store._catMap.size === 0) Store.reindex();
    return true;
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