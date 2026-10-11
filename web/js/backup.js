/* ============================================================
   backup.js - 自动备份
   三层保障：
     1. 应用内快照：把整份数据存进本机数据库，可一键还原（所有环境都有）
     2. 手机文件备份：安卓 App 内自动把备份写到系统「下载」目录
     3. 电脑端备份：电脑上运行的服务会自动在 backups/ 目录留档（见 tools/serve.js）
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U, Store = global.Store, DB = global.DB;
  const LS_LAST = 'jzb:backupLastAt';
  const IDX_KEY = 'backupIndex';

  const Backup = {
    _busy: false
  };

  /* 备份相关设置存在 Store.settings 里，这样也能随同步带到另一台设备 */
  function cfg() {
    return {
      enabled: Store.settings.autoBackup !== false,
      keep: Math.max(2, Math.min(50, Store.settings.backupKeep || 10)),
      intervalHours: Math.max(1, Math.min(720, Store.settings.backupIntervalHours || 24))
    };
  }

  Backup.lastAt = function () {
    const v = Number(localStorage.getItem(LS_LAST) || 0);
    return isFinite(v) ? v : 0;
  };
  function setLastAt(t) {
    try { localStorage.setItem(LS_LAST, String(t)); } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 索引 ---------------- */
  async function readIndex() {
    const row = await DB.get('meta', IDX_KEY);
    const list = row && Array.isArray(row.value) ? row.value : [];
    return list.filter((x) => x && x.key);
  }
  async function writeIndex(list) {
    await DB.put('meta', { key: IDX_KEY, value: list });
  }

  Backup.list = function () { return readIndex(); };

  /* ---------------- 生成 / 删除 ---------------- */
  Backup.create = async function (reason) {
    const obj = Store.exportObject();
    const json = JSON.stringify(obj);
    const at = Date.now();
    const key = 'backup:' + at;
    await DB.put('meta', { key: key, value: json, at: at });
    const index = await readIndex();
    index.push({
      key: key, at: at, reason: reason || 'auto',
      txCount: Store.tx.length, catCount: Store.categories.length,
      size: json.length
    });
    await writeIndex(index);
    setLastAt(at);
    await Backup.prune();
    return index[index.length - 1];
  };

  Backup.remove = async function (key) {
    await DB.remove('meta', key);
    const index = (await readIndex()).filter((x) => x.key !== key);
    await writeIndex(index);
  };

  Backup.prune = async function () {
    const keep = cfg().keep;
    const index = await readIndex();
    index.sort((a, b) => a.at - b.at);
    const extra = index.slice(0, Math.max(0, index.length - keep));
    for (let i = 0; i < extra.length; i++) {
      await DB.remove('meta', extra[i].key);
    }
    if (extra.length) {
      await writeIndex(index.slice(index.length - keep));
    }
    return extra.length;
  };

  Backup.clearAll = async function () {
    const index = await readIndex();
    for (let i = 0; i < index.length; i++) await DB.remove('meta', index[i].key);
    await writeIndex([]);
    setLastAt(0);
    return index.length;
  };

  /* ---------------- 还原 ---------------- */
  Backup.restore = async function (key) {
    const row = await DB.get('meta', key);
    if (!row || !row.value) throw new Error('找不到这份备份');
    const obj = JSON.parse(typeof row.value === 'string' ? row.value : JSON.stringify(row.value));
    const r = await Store.importObject(obj, 'replace');
    return r;
  };

  Backup.read = async function (key) {
    const row = await DB.get('meta', key);
    if (!row || !row.value) throw new Error('找不到这份备份');
    return typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
  };

  /* ---------------- 自动执行 ---------------- */
  /* 判断当前是否到了该备份的时候 */
  Backup.due = function () {
    const c = cfg();
    if (!c.enabled) return false;
    if (!Store.tx.length) return false;
    const last = Backup.lastAt();
    if (!last) return true;
    return (Date.now() - last) > c.intervalHours * 3600 * 1000;
  };

  /* 执行一次自动备份。force=true 时忽略时间间隔。 */
  Backup.run = async function (force) {
    if (Backup._busy) return null;
    if (!force && !Backup.due()) return null;
    Backup._busy = true;
    try {
      const info = await Backup.create(force ? 'manual' : 'auto');

      // 在安卓 App 里，再往手机的「下载」目录写一份文件，
      // 这样即使应用数据被清除，文件还在。
      if (global.AndroidApp && global.AndroidApp.save) {
        const json = await Backup.read(info.key);
        const d = new Date(info.at);
        const name = '记账备份-' + U.toISODate(d) + '-' +
          ('0' + d.getHours()).slice(-2) + ('0' + d.getMinutes()).slice(-2) + '.json';
        try { U.download(name, json, 'application/json'); } catch (e) { /* 忽略 */ }
      }
      return info;
    } finally {
      Backup._busy = false;
    }
  };

  Backup.autoOnStart = function () {
    if (!Backup.due()) return;
    setTimeout(function () { Backup.run().catch(function () { /* 忽略 */ }); }, 4000);
  };

  /* 数据变动后延迟检查（不频繁写盘） */
  let timer = null;
  Backup.onDataChanged = function () {
    if (!Backup.due()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      Backup.run().catch(function () { /* 忽略 */ });
    }, 60000);
  };

  Backup.sizeText = function (bytes) {
    if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes > 1024) return Math.round(bytes / 1024) + ' KB';
    return bytes + ' B';
  };

  Backup.timeText = function (at) {
    const d = new Date(at);
    return U.fmtDate(d, 'ymd') + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  };

  global.Backup = Backup;
  if (typeof module !== 'undefined' && module.exports) module.exports = Backup;
})(typeof window !== 'undefined' ? window : globalThis);