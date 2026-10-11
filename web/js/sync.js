/* ============================================================
   sync.js - 设备同步（电脑 <-> 手机）
   规则：双方各自保留一份数据，同步时逐条比较 updatedAt，
        后修改的一方胜出；删除操作通过「墓碑」同步，不会被推回来。
   两种使用场景：
     1) 浏览器打开电脑上的服务   -> 同源请求，用 Cookie 自动登录
     2) 安卓 App 连电脑的服务器 -> 跨源请求，用令牌（Token）认证
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U, Store = global.Store;
  const LS_KEY = 'jzb:sync';

  const Sync = {
    config: { url: '', token: '', autoSync: true, deviceName: '', lastSyncAt: 0, lastResult: null },
    status: 'idle',
    message: '',
    /* 同步进度：让用户看得见「现在做到哪一步了」 */
    progress: { running: false, percent: 0, step: '', detail: '' },
    _busy: false,
    _busyAt: 0,
    _timer: null,
    _listeners: []
  };

  /* ---------------- 配置读写 ---------------- */
  Sync.load = function () {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) Object.assign(Sync.config, JSON.parse(raw));
    } catch (e) { /* 忽略 */ }
    if (!Sync.config.deviceName) Sync.config.deviceName = Sync.guessDeviceName();
    Sync.syncHostToNative();
  };

  Sync.save = function () {
    try { localStorage.setItem(LS_KEY, JSON.stringify(Sync.config)); } catch (e) { /* 忽略 */ }
    Sync.syncHostToNative();
  };

  /* 把配置里的电脑地址告诉安卓外壳。
     外壳默认只放行常见私有网段（10./192.168./172.16-31.），
     但校园网等环境可能分配其它网段的地址，那样请求会被外壳拦掉。
     这里把用户自己填的地址报上去，外壳就会精确放行它。 */
  Sync.syncHostToNative = function () {
    if (!global.AndroidApp || typeof global.AndroidApp.setSyncHost !== 'function') return;
    let host = '';
    try {
      const u = Sync.normalizeUrl(Sync.config.url || '');
      if (u && typeof URL !== 'undefined') host = new URL(u).hostname;
    } catch (e) { host = ''; }
    try { global.AndroidApp.setSyncHost(host || ''); } catch (e) { /* 忽略 */ }
  };

  Sync.guessDeviceName = function () {  /* 把「电脑地址」和「AI 接口地址」一起报给安卓外壳。
     外壳只放行白名单里的主机，AI 服务地址不报上去，请求就会被拦掉。 */
  global.updateNativeHosts = function () {
    if (!global.AndroidApp) return;
    Sync.syncHostToNative();
    const ai = global.AI;
    if (ai && typeof ai.syncHostToNative === "function") ai.syncHostToNative();
  };


    const ua = String(navigator.userAgent || '');
    if (global.AndroidApp) return '安卓手机';
    if (/Android/i.test(ua)) return '安卓设备';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone / iPad';
    if (/Windows/i.test(ua)) return 'Windows 电脑';
    if (/Mac OS X/i.test(ua)) return 'Mac 电脑';
    if (/Linux/i.test(ua)) return 'Linux 电脑';
    return '未知设备';
  };

  /* 是否具备同步条件 */
  Sync.available = function () {
    if (Sync.isApp()) return !!Sync.config.url;
    return location.protocol === 'http:' || location.protocol === 'https:';
  };

  /* 规范化用户填写的地址 */
  Sync.normalizeUrl = function (raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    return s.replace(/\/+$/, '');
  };

  /* 请求用的基地址：App 用配置的地址，浏览器用当前站点（同源） */
  Sync.baseUrl = function () {
    return Sync.isApp() ? Sync.normalizeUrl(Sync.config.url) : '';
  };

  Sync.apiUrl = function (p) { return Sync.baseUrl() + p; };

  Sync.headers = function (extra) {
    const h = Object.assign({}, extra || {});
    if (Sync.config.token) h['Authorization'] = 'Bearer ' + Sync.config.token;
    return h;
  };

  /* ---------------- 状态通知 ---------------- */
  Sync.subscribe = function (fn) { Sync._listeners.push(fn); return () => { Sync._listeners = Sync._listeners.filter((f) => f !== fn); }; };
  Sync.setStatus = function (s, msg) {
    Sync.status = s;
    Sync.message = msg || '';
    Sync._listeners.forEach((fn) => { try { fn(s, msg); } catch (e) { /* 忽略 */ } });
  };

  /* ---------------- 进度 ---------------- */
  Sync.setProgress = function (percent, step, detail) {
    Sync.progress.running = percent > 0 && percent < 100;
    Sync.progress.percent = Math.max(0, Math.min(100, Math.round(percent)));
    Sync.progress.step = step || '';
    Sync.progress.detail = detail || '';
    Sync._listeners.forEach(function (fn) { try { fn(Sync.status, Sync.message); } catch (e) { /* 忽略 */ } });
  };

  Sync.clearProgress = function () {
    Sync.setProgress(0, '', '');
  };

  /* ---------------- 连接状态 ---------------- */
  Sync.isApp = function () { return !!global.AndroidApp; };

  /* 是否已经连上电脑：浏览器同源靠 Cookie，安卓 App 需要有地址 + 口令换来的令牌 */
  Sync.isConnected = function () {
    if (!Sync.isApp()) return true;
    return !!(Sync.config.url && Sync.config.token);
  };

  /* 安卓 App 且还没拿到令牌时，才需要用户输入口令 */
  Sync.needsPassword = function () {
    return Sync.isApp() && !Sync.config.token;
  };

  /* ---------------- 带超时的请求 ----------------
     没有超时的话，手机连不上电脑时 fetch 会一直挂着，
     「立即同步」按钮就会永远停在「同步中…」点不动。 */
  function fetchWithTimeout(url, options, ms) {
    const limit = ms || 20000;
    const opts = Object.assign({}, options || {});
    let timer = null;

    if (typeof AbortController !== 'undefined') {
      const ctrl = new AbortController();
      opts.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, limit);
    }

    return fetch(url, opts).then(function (r) { return r; }, function (e) {
      if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
        throw new Error('连接超时（' + Math.round(limit / 1000) + ' 秒没有响应）。请检查：电脑是否开着并运行着服务、手机和电脑是否在同一 WiFi、地址有没有填对');
      }
      throw new Error('连不上电脑。请确认手机和电脑在同一 WiFi，且地址填写正确（' + (e && e.message ? e.message : '网络错误') + '）');
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  /* ---------------- 与服务器交互 ---------------- */
  Sync.login = async function (password) {
    const res = await fetchWithTimeout(Sync.apiUrl('/api/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ password: String(password || '').trim(), remember: true })
    }, 20000);
    let j = {};
    try { j = await res.json(); } catch (e) { j = {}; }
    if (!res.ok || !j.ok) throw new Error(j.error || '口令不正确');
    if (j.token) { Sync.config.token = j.token; Sync.save(); }
    return true;
  };

  /* 测试连接：返回服务器信息 */
  Sync.test = async function () {
    const res = await fetchWithTimeout(Sync.apiUrl('/api/ping'), {
      headers: Sync.headers(), credentials: 'include'
    }, 15000);
    if (res.status === 401) { Sync.setStatus('auth'); throw new Error('需要访问口令'); }
    if (!res.ok) throw new Error('服务器返回 HTTP ' + res.status);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || '连接异常');
    Sync.setStatus('ok');
    return j;
  };

  /* 执行一次完整同步：上传本地 -> 服务器合并 -> 取回并合并到本地 */
  Sync.sync = async function (opts) {
    opts = opts || {};

    if (Sync._busy) {
      // 上一次同步如果卡住超过 60 秒，就当作已经失效，允许重新发起，
      // 避免按钮永远停在「同步中」点不动
      if (Date.now() - Sync._busyAt < 60000) return null;
      Sync._busy = false;
    }
    if (!Sync.available()) {
      throw new Error(Sync.isApp() ? '还没有填写电脑的地址' : '当前页面不是通过服务器打开的，无法同步');
    }

    Sync._busy = true;
    Sync._busyAt = Date.now();
    Sync.setStatus('syncing', '正在同步…');
    Sync.setProgress(5, '正在整理本机数据…', '本机共 ' + Store.tx.length + ' 条账目');

    try {
      const payload = Store.syncSnapshot(Sync.deviceId(), Sync.config.deviceName);

      Sync.setProgress(20, '正在上传到电脑…', '本机 ' + payload.tx.length + ' 条');
      const res = await fetchWithTimeout(Sync.apiUrl('/api/sync'), {
        method: 'POST',
        headers: Sync.headers({ 'Content-Type': 'application/json' }),
        credentials: 'include',
        body: JSON.stringify(payload)
      }, 30000);

      if (res.status === 401) {
        Sync.clearProgress();
        Sync.setStatus('auth', '需要访问口令');
        throw new Error('需要访问口令：请重新输入电脑上显示的口令');
      }
      if (!res.ok) throw new Error('电脑上的服务返回 HTTP ' + res.status);

      Sync.setProgress(60, '电脑正在合并数据…', '');
      const result = await res.json();
      if (!result.ok) throw new Error(result.error || '同步失败');

      Sync.setProgress(80, '正在比对两边差异…', '');
      const diff = Store.diffRemote(result);

      Sync.setProgress(90, '正在写入本机…', '要更新 ' + (diff.willArrive || 0) + ' 项');
      Sync._applying = true;
      try { await Store.applyRemote(result); }
      finally { Sync._applying = false; }

      Sync.config.lastSyncAt = Date.now();
      Sync.config.lastResult = {
        pushed: (result.stats && result.stats.pushed) || 0,
        pulled: diff.willArrive || 0,
        removed: diff.willLeave || 0,
        serverTotal: (result.stats && result.stats.serverTx) || 0
      };
      Sync.save();

      Sync.setProgress(100, '同步完成',
        '上传 ' + Sync.config.lastResult.pushed + ' 项　下载 ' + Sync.config.lastResult.pulled +
        ' 项　电脑上共 ' + Sync.config.lastResult.serverTotal + ' 条');
      Sync.setStatus('ok', '同步完成');

      if (opts.toast && global.UI) {
        global.UI.toast('同步完成：上传 ' + Sync.config.lastResult.pushed +
          ' 项，下载 ' + Sync.config.lastResult.pulled + ' 项', 'ok');
      }
      return Sync.config.lastResult;
    } catch (e) {
      Sync.clearProgress();
      if (Sync.status !== 'auth') Sync.setStatus('error', e.message);
      if (opts.toast && global.UI) global.UI.toast('同步失败：' + e.message, 'err');
      throw e;
    } finally {
      Sync._busy = false;
    }
  };
  /* ---------------- 设备标识 ---------------- */
  Sync.deviceId = function () {
    let id = '';
    try { id = localStorage.getItem('jzb:deviceId') || ''; } catch (e) { /* 忽略 */ }
    if (!id) {
      id = U.uuid();
      try { localStorage.setItem('jzb:deviceId', id); } catch (e) { /* 忽略 */ }
    }
    return id;
  };

  /* ---------------- 自动同步 ---------------- */
  /* 数据变动后延迟触发，避免连续操作时反复请求 */
  Sync.onDataChanged = function () {
    if (!Sync.config.autoSync || !Sync.available()) return;
    if (Sync._busy || Sync._applying) return;
    if (Sync._timer) clearTimeout(Sync._timer);
    Sync._timer = setTimeout(() => {
      Sync._timer = null;
      Sync.sync().catch(() => { /* 静默失败，状态已在界面上体现 */ });
    }, 4000);
  };

  /* 打开应用时自动同步一次 */
  Sync.autoSyncOnStart = function () {
    if (!Sync.config.autoSync || !Sync.available()) return;
    setTimeout(() => { Sync.sync().catch(() => {}); }, 1200);
  };

  Sync.statusText = function () {
    if (!Sync.available()) return '未配置';
    if (Sync.status === 'syncing') return '同步中…';
    if (Sync.status === 'auth') return '需要口令';
    if (Sync.status === 'error') return '连接失败';
    if (!Sync.config.lastSyncAt) return '尚未同步';
    return '正常';
  };

  Sync.lastSyncText = function () {
    if (!Sync.config.lastSyncAt) return '从未同步';
    const d = new Date(Sync.config.lastSyncAt);
    return U.fmtDate(d, 'ymd') + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  };

  global.Sync = Sync;
})(window);