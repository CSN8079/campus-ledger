/* ============================================================
   app.js - 启动、路由、主题、离线缓存
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.U, Store = global.Store, UI = global.UI;
  const $ = U.$, $$ = U.$$;

  const TITLES = { home: '概览', list: '明细', stats: '统计', settings: '设置' };
  const SUBS = {
    home: '今天也好好记账',
    list: '所有收入与支出',
    stats: '周 / 月 / 学期合计',
    settings: '分类、报销、导入导出'
  };

  /* ---------------- 主题 ---------------- */
  UI.applyTheme = function () {
    const theme = Store.settings.theme || 'auto';
    let dark;
    if (theme === 'auto') {
      dark = global.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
    } else {
      dark = theme === 'dark';
    }
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0e1016' : '#4f46e5');
    const btn = $('#btnTheme');
    if (btn) btn.textContent = dark ? '☀' : '◐';

    // 安卓 App：告诉原生层当前是深色还是浅色，系统栏图标颜色才会跟着变
    if (global.AndroidApp && typeof global.AndroidApp.setDark === 'function') {
      try { global.AndroidApp.setDark(!!dark); } catch (e) { /* 忽略 */ }
    }
  };

  /* ---------------- 安全区（安卓系统栏） ----------------
     两套来源互为兜底：
       1. 浏览器自己报的 env(safe-area-inset-*) —— 有的话最准
       2. 安卓原生实测的高度（--inset-*-px）
     但第 2 套只有在「内容确实铺到了屏幕边缘」时才能用：
     如果 WebView 已经被系统挪进安全区（没有铺满全屏），
     再叠加一次边距就会出现上下各多一块空白。
     这里直接量一下视口和屏幕的差值来判断，差得多就说明没铺满。 */
  UI.applySafeArea = function () {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const nativeTop = parseFloat(cs.getPropertyValue('--inset-t-px')) || 0;
    const nativeBottom = parseFloat(cs.getPropertyValue('--inset-b-px')) || 0;

    function envInset(side) {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:env(safe-area-inset-' + side + ',0px);';
      root.appendChild(probe);
      const h = probe.getBoundingClientRect().height;
      probe.remove();
      return h;
    }

    const envTop = envInset('top');
    const envBottom = envInset('bottom');

    // 视口高度和屏幕高度差得不多，说明内容铺满了整屏
    const coveredBySystemBars = Math.max(0, Math.round(window.screen.height - window.innerHeight));
    const fillsScreen = coveredBySystemBars < 10;

    root.style.setProperty('--safe-t-native', (envTop > 0 || !fillsScreen ? 0 : nativeTop) + 'px');
    root.style.setProperty('--safe-b-native', (envBottom > 0 || !fillsScreen ? 0 : nativeBottom) + 'px');
  };

  UI.screenInfoText = function () {
    const cs = getComputedStyle(document.documentElement);
    const num = (k) => Math.round(parseFloat(cs.getPropertyValue(k)) || 0);
    return '视口 ' + window.innerWidth + '×' + window.innerHeight +
      '　屏幕 ' + window.screen.width + '×' + window.screen.height +
      '　原生边距 上' + num('--inset-t-px') + ' 下' + num('--inset-b-px') +
      '　实际生效 上' + num('--safe-t') + ' 下' + num('--safe-b');
  };

  /* ---------------- 路由 ---------------- */
  UI.go = function (tab) {
    UI.state.tab = tab;
    $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === tab));
    $$('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
    $('#pageTitle').textContent = TITLES[tab] || '记账本';
    $('#pageSubtitle').textContent = SUBS[tab] || '';
    UI.refresh();
    const main = $('.main');
    if (main) main.scrollTop = 0;
    global.scrollTo({ top: 0, behavior: 'instant' in document.documentElement.style ? 'instant' : 'auto' });
    try { localStorage.setItem('jzb:lastTab', tab); } catch (e) { /* ignore */ }
  };

  UI.refresh = function () {
    if (!Store.loaded) return;
    const tab = UI.state.tab;
    if (tab === 'home') UI.renderHome();
    else if (tab === 'list') UI.renderList();
    else if (tab === 'stats') UI.renderStats();
    else if (tab === 'settings') UI.renderSettings();
  };

  const refreshDebounced = U.debounce(() => UI.refresh(), 120);

  /* ---------------- 事件绑定 ---------------- */
  function wire() {
    $$('.tab').forEach((b) => b.addEventListener('click', () => UI.go(b.dataset.tab)));
    $('#btnAdd').addEventListener('click', () => UI.openTxSheet(null));
    $('#btnImport').addEventListener('click', () => UI.openImportSheet());
    $('#btnTheme').addEventListener('click', async () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      await Store.updateSettings({ theme: next });
      UI.applyTheme();
    });

    if (global.matchMedia) {
      const mq = matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => { if ((Store.settings.theme || 'auto') === 'auto') UI.applyTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }

    // 快捷键：桌面端 Ctrl/Cmd + N 记一笔
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'n') {
        e.preventDefault();
        UI.openTxSheet(null);
      }
      if (e.key === 'Escape') UI.closeSheet();
    });

    global.addEventListener('beforeunload', (e) => {
      // 有输入未保存的表单时给出提示比较打扰，这里只在有未完成导入时提醒
      if (UI.state.importResult && UI.state.importResult.items.some((it) => it.selected)) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  /* ---------------- 离线缓存 ---------------- */
  function registerSW() {
    // 安卓 App 里的资源来自安装包本身，天然离线，无需再缓存
    if (global.AndroidApp) return;
    if (!('serviceWorker' in navigator)) return;
    const okProto = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!okProto) return;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      console.log('[sw] 已注册，离线可用');
    }).catch((e) => console.log('[sw] 注册失败（不影响使用）', e && e.message));
  }

  /* ---------------- 首屏提示 ---------------- */
  function firstRunTips() {
    if (Store.settings.onboarded) return;
    Store.updateSettings({ onboarded: true });
    setTimeout(() => {
      UI.toast('欢迎使用！点右下角 ＋ 记一笔，或点右上角 ⤓ 导入微信/支付宝账单', 'ok');
    }, 700);
  }

  function persistStorage() {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persisted().then((already) => {
        if (!already) navigator.storage.persist().catch(() => {});
      }).catch(() => {});
    }
  }

  /* ---------------- 启动 ---------------- */
  async function boot() {
    const mode = await Store.init();
    console.log('[db] 存储模式：', mode);
    UI.applyTheme();
    UI.applySafeArea();
    global.addEventListener('resize', () => UI.applySafeArea());
    if (global.visualViewport) global.visualViewport.addEventListener('resize', () => UI.applySafeArea());
    UI.state.list.hideExcluded = !!Store.settings.hideExcludedInList;
    wire();

    Store.subscribe((reason) => {
      refreshDebounced();
      // 'all' 是同步合并后发出的，不再触发同步，避免来回循环
      if (reason === 'tx' || reason === 'categories' || reason === 'settings') {
        if (global.Sync) global.Sync.onDataChanged();
        if (global.Backup) global.Backup.onDataChanged();
      }
    });

    let last = 'home';
    try { last = localStorage.getItem('jzb:lastTab') || 'home'; } catch (e) { /* ignore */ }
    if (!TITLES[last]) last = 'home';
    UI.go(last);

    registerSW();
    persistStorage();
    firstRunTips();

    // 载入同步配置，并在后台自动同步一次
    if (global.Sync) {
      global.Sync.load();
      global.Sync.autoSyncOnStart();
    }
    // 启动时检查一次自动备份
    if (global.Backup) global.Backup.autoOnStart();

    if (mode === 'local') {
      UI.toast('提示：当前浏览器使用了降级存储，建议用 Chrome / Edge 打开以启用更稳定的存储', 'err');
    }
    document.body.classList.add('ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);