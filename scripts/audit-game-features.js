/**
 * 页面侧功能自检（只读）— game features audit
 * 注入后调用：window.__gameFeatureAudit()
 * 返回：引擎/模式/线路数 + 导航入口 + 菜单开关 + 功能全局/API 可用性 + 缺失清单。
 * 用途：新版本上线后先跑一次，确认技能矩阵（references/game-features.md）仍对应。
 */
(function () {
  if (window.__gameFeatureAudit) return;
  var NAV = [
    'nav-btn-add-line', 'nav-btn-control-center', 'nav-btn-flow-dashboard', 'nav-btn-flow-reload',
    'nav-btn-mapstyle', 'nav-btn-diagram-style', 'nav-btn-metro-diagram', 'nav-btn-metro-diagram-v2',
    'nav-btn-metro-diagram-v3', 'nav-btn-metro-diagram-v4', 'nav-btn-metro-diagram-v5',
    'nav-btn-transit-map', 'nav-btn-diagram-redraw', 'nav-btn-station-tour', 'nav-btn-metro-search',
    'nav-btn-hsr-search', 'nav-btn-hsr-booking', 'nav-btn-flight-booking', 'nav-btn-guide', 'nav-btn-more'
  ];
  var MENU = [
    'game-menu-economy-mode-money', 'game-menu-economy-mode-no-money',
    'game-menu-toggle-perf-on', 'game-menu-toggle-perf-off', 'game-menu-sound-on', 'game-menu-sound-off',
    'game-menu-events-on', 'game-menu-events-off', 'game-menu-weekly-demand-on', 'game-menu-weekly-demand-off',
    'game-menu-aviation-competition-on', 'game-menu-aviation-competition-off',
    'game-menu-toggle-radius-on', 'game-menu-toggle-radius-off',
    'game-menu-toggle-station-distance-on', 'game-menu-toggle-station-distance-off',
    'game-menu-unit-metric', 'game-menu-unit-imperial'
  ];
  var GLOBALS = [
    'MetroEconomy', 'MetroEconomyRules', 'MetroFarePolicy', 'MetroSaveModePolicy',
    'HsrEconomyRules', 'HsrAmbience', 'HsrAnnouncements', 'AviationEconomyRules',
    'MetroEventStationCatalog', 'MetroStorageAccess', 'MetroUII18n'
  ];
  var FNS = [
    'openMetroDiagramView', 'initFlowChordPanel', 'openFlightPlannerPanel', 'openFlightRouteSearchPanel',
    'metroEnterAnyCityPointFromPixelMap', 'metroEnterAnyCity', 'metroOpenAnycityRegions',
    'setMetroPerformanceMode', 'getMetroCacheAudit', 'getMetroLoadingAudit',
    'metroPassportGetAnchor', 'metroVoyagerActivityStatus', 'metroLogout'
  ];

  function fnCount(o) {
    if (!o) return 0;
    try { return Object.keys(o).filter(function (k) { return typeof o[k] === 'function'; }).length; } catch (e) { return 0; }
  }
  function sel(id) { return '#' + id; }

  window.__gameFeatureAudit = function () {
    var G = window.G || {};
    var nav = {}, menu = {}, globals = {}, fns = {}, missing = [];
    NAV.forEach(function (id) {
      var el = document.querySelector(sel(id));
      nav[id] = el ? { present: true, visible: el.getBoundingClientRect().width > 0 } : false;
      if (!el) missing.push(id);
    });
    MENU.forEach(function (id) {
      var el = document.querySelector(sel(id));
      menu[id] = !!el;
    });
    GLOBALS.forEach(function (k) {
      globals[k] = window[k] ? { present: true, fns: fnCount(window[k]) } : { present: false, fns: 0 };
      if (!window[k]) missing.push(k);
    });
    FNS.forEach(function (k) {
      fns[k] = typeof window[k] === 'function';
      if (typeof window[k] !== 'function') missing.push(k);
    });
    var MT = window.__metroToolkit;
    return {
      ts: new Date().toISOString(),
      engine: G.mapEngine || 'amap',
      engineProfile: MT && MT.engineProfile ? MT.engineProfile() : null,
      mode: G.gameMode || null,
      economyMode: G.economyMode || null,
      city: G.city ? (G.city.name || G.city.tag || null) : null,
      lines: (G.lines || []).length,
      toolkit: { MT: MT && MT.__version, OD: window.__officialDraw && window.__officialDraw.__version, K: window.CityMetroKit && window.CityMetroKit.__version },
      nav: nav, menu: menu, globals: globals, functions: fns,
      missing: missing,
      ok: missing.length === 0
    };
  };
  if (window.console && console.log) console.log('[audit] window.__gameFeatureAudit() ready');
})();
