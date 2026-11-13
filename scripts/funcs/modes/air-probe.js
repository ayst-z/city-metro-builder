(function () {
  'use strict';
  var A = window.AirProbe = window.AirProbe || {};
  if (A.__version === '0.1.0') return;
  A.__version = '0.1.0';

  function count(v) {
    if (!v) return 0;
    if (Array.isArray(v)) return v.length;
    if (typeof v === 'object') return Object.keys(v).length;
    return 1;
  }
  function call(name) {
    try { return typeof top[name] === 'function' ? top[name]() : null; } catch (e) { return { error: String(e && e.message || e) }; }
  }

  A.available = function () {
    try { return typeof top.openFlightPlannerPanel === 'function' || typeof top.isFlightTransportMode === 'function'; } catch (e) { return false; }
  };
  A.state = function () {
    var g = window.G || {};
    return {
      transportMode: g.transportMode || null,
      isFlightMode: (function () { try { return !!top.isFlightTransportMode(); } catch (e) { return null; } })(),
      flightLayerVisible: !!g.flightLayerVisibility,
      airportColors: count(g.flightAirportColors),
      airportPA: typeof top.AirportPA !== 'undefined' ? 'available' : 'missing',
      plannerApi: typeof top.openFlightPlannerPanel === 'function',
      routeSearchApi: typeof top.openFlightRouteSearchPanel === 'function',
      quotas: (function(){ try { return top.MetroEconomy.getFinanceSnapshot().quotas.aviation; } catch (e) { return null; } })()
    };
  };
  A.entrypoints = function () {
    return {
      planner: typeof top.openFlightPlannerPanel === 'function' ? 'openFlightPlannerPanel' : null,
      routeSearch: typeof top.openFlightRouteSearchPanel === 'function' ? 'openFlightRouteSearchPanel' : null,
      defaultMapName: typeof top.applyFlightEntryMapNameDefault === 'function' ? 'applyFlightEntryMapNameDefault' : null
    };
  };
  A.snapshot = function () { return { at: Date.now(), state: A.state(), entrypoints: A.entrypoints() }; };
  A.reserved = function (action) {
    return { ok: false, reserved: true, action: action || null, reason: '飞机模式自动化尚未实现；当前仅提供只读探测与官方入口索引' };
  };
})();
