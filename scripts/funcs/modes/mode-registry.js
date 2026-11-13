(function () {
  'use strict';
  var M = window.CityTransportModes = window.CityTransportModes || {};
  if (M.__version === '0.1.0') return;
  M.__version = '0.1.0';

  var registry = {};

  M.register = function (def) {
    if (!def || !def.id) return false;
    registry[def.id] = def;
    return true;
  };
  M.get = function (id) { return registry[id] || null; };
  M.require = function (id) {
    var m = registry[id];
    if (!m) throw new Error('transport mode not registered: ' + id);
    return m;
  };
  M.ids = function () { return Object.keys(registry); };
  M.list = function () {
    return M.ids().map(function (id) {
      var m = registry[id];
      var available = null;
      try { available = m.available ? !!m.available() : null; } catch (e) { available = false; }
      return { id: id, label: m.label || id, reserved: !!m.reserved, available: available };
    });
  };
  M.detect = function () {
    var g = window.G || {};
    return {
      current: g.transportMode || null,
      gameMode: g.gameMode || null,
      economyMode: g.economyMode || null,
      supported: M.list().filter(function (x) { return x.available; }).map(function (x) { return x.id; })
    };
  };

  M.register({
    id: 'metro',
    label: '地铁',
    reserved: false,
    available: function () { return !!window.__metroToolkit; },
    state: function () {
      var g = window.G || {};
      return { lines: (g.lines || []).length, transportMode: g.transportMode || null, economyMode: g.economyMode || null };
    },
    api: function () {
      return {
        query: window.__metroToolkit || null,
        draw: window.__officialDraw || null,
        manage: window.CityMetroKit || null,
        ops: window.MetroOps || null,
        edit: window.OfficialEdit || null,
        fare: window.FareLab || null
      };
    }
  });

  M.register({
    id: 'hsr',
    label: '高铁',
    reserved: true,
    available: function () {
      try { return typeof top.isHsrTransportMode === 'function' || typeof top.citySupportsHsrTransportMode === 'function'; } catch (e) { return false; }
    },
    state: function () { return window.HsrProbe ? window.HsrProbe.state() : null; },
    opts: function () { return window.HsrProbe ? window.HsrProbe.opts() : null; }
  });

  M.register({
    id: 'air',
    label: '飞机',
    reserved: true,
    available: function () {
      try { return typeof top.openFlightPlannerPanel === 'function' || typeof top.isFlightTransportMode === 'function'; } catch (e) { return false; }
    },
    state: function () { return window.AirProbe ? window.AirProbe.state() : null; }
  });
})();
