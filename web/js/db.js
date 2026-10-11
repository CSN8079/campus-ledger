/* ============================================================
   db.js - 数据持久层
   首选 IndexedDB；若浏览器禁用（隐私模式等）自动降级到 localStorage。
   对外暴露统一 Promise API，调用方无需关心底层实现。
   ============================================================ */
(function (global) {
  'use strict';

  const DB_NAME = 'daxue-jizhangben';
  const DB_VER = 1;

  /* 表结构：key 主键字段，idx 需建索引的字段 */
  const SCHEMA = {
    tx: { key: 'id', idx: { time: 'time', type: 'type', categoryId: 'categoryId', externalId: 'externalId', dateKey: 'dateKey' } },
    categories: { key: 'id', idx: { type: 'type', order: 'order' } },
    meta: { key: 'key' }
  };

  const LS_PREFIX = 'jzb:';
  let backend = null;
  let idbHandle = null;

  /* ---------------- 工具 ---------------- */
  function req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB 操作失败'));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务被中止'));
    });
  }

  /* ---------------- localStorage 降级实现 ---------------- */
  const LS = {
    read(store) {
      try {
        const raw = localStorage.getItem(LS_PREFIX + store);
        if (!raw) return [];
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v : Object.values(v || {});
      } catch (e) { return []; }
    },
    write(store, arr) {
      try { localStorage.setItem(LS_PREFIX + store, JSON.stringify(arr)); }
      catch (e) { throw new Error('本地存储写入失败（可能空间已满），请先导出备份并清理数据。'); }
    },
    keyOf(store, obj) { return obj[SCHEMA[store].key]; }
  };

  /* ---------------- IndexedDB 实现 ---------------- */
  function openIDB() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) return reject(new Error('浏览器不支持 IndexedDB'));
      let openReq;
      try { openReq = indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { return reject(e); }

      openReq.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        Object.keys(SCHEMA).forEach((name) => {
          const def = SCHEMA[name];
          let os;
          if (!db.objectStoreNames.contains(name)) os = db.createObjectStore(name, { keyPath: def.key });
          else os = ev.target.transaction.objectStore(name);
          if (def.idx) {
            Object.keys(def.idx).forEach((idxName) => {
              if (!os.indexNames.contains(idxName)) os.createIndex(idxName, def.idx[idxName], { unique: false });
            });
          }
        });
      };
      openReq.onsuccess = () => resolve(openReq.result);
      openReq.onerror = () => reject(openReq.error || new Error('IndexedDB 打开失败'));
      openReq.onblocked = () => reject(new Error('IndexedDB 被其它标签页占用，请关闭其它记账本页面后重试'));
    });
  }

  function idbAll(store) {
    const tx = idbHandle.transaction(store, 'readonly');
    return req(tx.objectStore(store).getAll());
  }

  /* ---------------- 统一 API ---------------- */
  const DB = {};

  DB.init = async function () {
    try {
      idbHandle = await openIDB();
      backend = 'idb';
      // 自检：能正常读一次才算可用
      await idbAll('meta');
    } catch (e) {
      idbHandle = null;
      backend = 'local';
      console.warn('[db] 降级到 localStorage：', e && e.message);
    }
    return backend;
  };

  DB.mode = () => backend;
  DB.modeLabel = () => (backend === 'idb' ? 'IndexedDB（推荐）' : '本地存储 localStorage（降级模式）');

  DB.all = async function (store) {
    if (backend === 'idb') return (await idbAll(store)) || [];
    return LS.read(store);
  };

  DB.get = async function (store, key) {
    if (backend === 'idb') {
      const tx = idbHandle.transaction(store, 'readonly');
      const v = await req(tx.objectStore(store).get(key));
      return v === undefined ? null : v;
    }
    const keyField = SCHEMA[store].key;
    return LS.read(store).find((x) => x[keyField] === key) || null;
  };

  DB.put = async function (store, obj) {
    if (backend === 'idb') {
      const tx = idbHandle.transaction(store, 'readwrite');
      tx.objectStore(store).put(obj);
      await txDone(tx);
      return obj;
    }
    const keyField = SCHEMA[store].key;
    const arr = LS.read(store);
    const i = arr.findIndex((x) => x[keyField] === obj[keyField]);
    if (i >= 0) arr[i] = obj; else arr.push(obj);
    LS.write(store, arr);
    return obj;
  };

  DB.putMany = async function (store, list) {
    if (!list || !list.length) return 0;
    if (backend === 'idb') {
      const tx = idbHandle.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      list.forEach((obj) => os.put(obj));
      await txDone(tx);
      return list.length;
    }
    const keyField = SCHEMA[store].key;
    const map = new Map(LS.read(store).map((x) => [x[keyField], x]));
    list.forEach((obj) => map.set(obj[keyField], obj));
    LS.write(store, Array.from(map.values()));
    return list.length;
  };

  DB.remove = async function (store, key) {
    if (backend === 'idb') {
      const tx = idbHandle.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      await txDone(tx);
      return true;
    }
    const keyField = SCHEMA[store].key;
    LS.write(store, LS.read(store).filter((x) => x[keyField] !== key));
    return true;
  };

  DB.removeMany = async function (store, keys) {
    if (!keys || !keys.length) return 0;
    if (backend === 'idb') {
      const tx = idbHandle.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      keys.forEach((k) => os.delete(k));
      await txDone(tx);
      return keys.length;
    }
    const keyField = SCHEMA[store].key;
    const set = new Set(keys);
    LS.write(store, LS.read(store).filter((x) => !set.has(x[keyField])));
    return keys.length;
  };

  DB.clear = async function (store) {
    if (backend === 'idb') {
      const tx = idbHandle.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      await txDone(tx);
      return true;
    }
    LS.write(store, []);
    return true;
  };

  DB.clearAll = async function () {
    await Promise.all(Object.keys(SCHEMA).map((s) => DB.clear(s)));
  };

  DB.STORES = Object.keys(SCHEMA);
  DB.estimate = async function () {
    if (global.navigator && navigator.storage && navigator.storage.estimate) {
      try {
        const e = await navigator.storage.estimate();
        return { usage: e.usage, quota: e.quota };
      } catch (err) { /* ignore */ }
    }
    return null;
  };

  global.DB = DB;
})(window);