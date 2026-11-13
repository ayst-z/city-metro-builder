(function () {
  'use strict';
  var H = window.HsrProbe = window.HsrProbe || {};
  if (H.__version === '0.1.0') return;
  H.__version = '0.1.0';

  function count(v) {
    if (!v) return 0;
    if (Array.isArray(v)) return v.length;
    if (typeof v === 'object') return Object.keys(v).length;
    return 1;
  }
  function call(name) {
    try { return typeof top[name] === 'function' ? top[name]() : null; } catch (e) { return { error: String(e && e.message || e) }; }
  }

  H.available = function () {
    try { return typeof top.isHsrTransportMode === 'function' || typeof top.citySupportsHsrTransportMode === 'function'; } catch (e) { return false; }
  };
  H.supported = function (cityKey) {
    try {
      if (typeof top.citySupportsHsrTransportMode !== 'function') return null;
      return cityKey ? top.citySupportsHsrTransportMode(cityKey) : call('citySupportsHsrTransportMode');
    } catch (e) { return null; }
  };
  H.state = function () {
    var g = window.G || {};
    return {
      transportMode: g.transportMode || null,
      isHsrMode: (function () { try { return !!top.isHsrTransportMode(); } catch (e) { return null; } })(),
      routes: count(g.hsrRealworldMyRoutes),
      runtimeTrains: count(g.hsrRuntimeTrains),
      liveStations: count(g._hsrLiveStations),
      liveSectionLoads: count(g._hsrLiveSectionLoads),
      economyInput: g._hsrLiveEconomyInput || null,
      addStationMode: !!g.hsrAddStationMode,
      routeInfo: g._hsrRouteInfo || null,
      quotas: (function(){ try { return top.MetroEconomy.getFinanceSnapshot().quotas.hsr; } catch (e) { return null; } })()
    };
  };
  H.opts = function () {
    return {
      trainTypes: top.HSR_TRAIN_TYPE_OPTS || null,
      cars: top.HSR_TRAIN_CARS_OPTS || null,
      capacity: top.HSR_TRAIN_CARS_CAPACITY || null,
      speeds: top.HSR_TRAIN_SPEED_OPTS || null
    };
  };
  H.snapshot = function () {
    return { at: Date.now(), state: H.state(), opts: H.opts() };
  };
  H.reserved = function (action) {
    return { ok: false, reserved: true, action: action || null, reason: 'HSR 自动化尚未实现；当前仅提供只读探测与官方入口索引' };
  };
})();
