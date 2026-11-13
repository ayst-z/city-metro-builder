(function () {
  'use strict';
  if (window.PlanMap && window.PlanMap.version === '1.1.1') return;
  var MT = window.__metroToolkit;
  var wait = function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
  var distance = function (a, b) { return MT.haversine(a, b); };
  var finitePair = function (p) { return Array.isArray(p) && p.length === 2 && p.every(Number.isFinite); };
  var api = { version: '1.1.1' };

  // real: {stations:{name:[lng,lat]}, nodes:[seg|null], paths:[seg|null]}（与 compiled 同 CRS）。
  // 几何优先级：真实节点 > 真实 path > 图纸角点平滑；图纸只决定意图与无数据段走向。
  api.prepare = function (compiled, index, real) {
    if (!compiled || !compiled.ok || !compiled.fit || !compiled.fit.ok) throw new Error('unverified image compilation');
    if (compiled.crs !== 'gcj02' && compiled.crs !== 'wgs84') throw new Error('explicit source CRS required');
    var source = compiled.lines[index];
    if (!source || source.stations.length < 2 || source.paths.length !== source.stations.length - 1) throw new Error('invalid line shape');
    if (!/^#[0-9a-f]{6}$/i.test(source.color) || !source.name) throw new Error('invalid plan name/color');
    if (!source.spec || !source.specSource) throw new Error('declare train specification and its source before drawing');
    var gameCrs = MT.engineProfile().crs === 'wgs84' ? 'wgs84' : 'gcj02';
    var convert = function (p) {
      if (!finitePair(p)) throw new Error('non-finite coordinate');
      if (Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) throw new Error('coordinate out of range (pixel/geo mix?)');
      if (gameCrs === compiled.crs) return p.slice();
      return gameCrs === 'wgs84' ? MT.gcj02ToWgs84(p[0], p[1]) : MT.wgs84ToGcj02(p[0], p[1]);
    };
    real = real || {};
    var stations = source.stations.map(function (s) {
      if (!s.name) throw new Error('unnamed station');
      var rc = real.stations && real.stations[s.name];
      var c = convert(rc || [s.lng, s.lat]);
      return { name: s.name, lng: c[0], lat: c[1], coordSource: rc ? 'real' : 'plan-image' };
    });
    var paths = source.paths.map(function (path, i) {
      if (!Array.isArray(path) || path.length < 2) throw new Error('missing image segment ' + i);
      var converted = path.map(convert);
      var sa = convert([source.stations[i].lng, source.stations[i].lat]);
      var sb = convert([source.stations[i + 1].lng, source.stations[i + 1].lat]);
      if (distance(converted[0], sa) > 1 || distance(converted[converted.length - 1], sb) > 1) throw new Error('path endpoint/order mismatch ' + i);
      return converted;
    });
    var clear = function (p, a, b) { return distance(p, [a.lng, a.lat]) >= 100 && distance(p, [b.lng, b.lat]) >= 100; };
    var nodes = paths.map(function (path, i) {
      var a = stations[i], b = stations[i + 1];
      var rn = real.nodes && real.nodes[i];
      if (rn && rn.length) {
        var safeReal = rn.map(convert).filter(function (p) { return clear(p, a, b); });
        return safeReal; // 真实短段允许无节点（直线直连）
      }
      var rp = real.paths && real.paths[i];
      var fitPath = rp ? rp.map(convert) : ((source.cornerPaths && source.cornerPaths[i]) || source.paths[i]).map(convert);
      fitPath = fitPath.slice();
      fitPath[0] = [a.lng, a.lat];
      fitPath[fitPath.length - 1] = [b.lng, b.lat];
      var segs = MT.fitSegmentNodes(stations, fitPath, { tolerance: 6, endPadM: 100 });
      var thin = MT.curvatureThin(segs[i] || [], { tolerance: 6, minGapM: 30 });
      var safe = thin.filter(function (p) { return clear(p, a, b); });
      if (!safe.length) throw new Error('no image-derived node outside platforms in segment ' + i);
      if (safe.length > Math.ceil(distance([a.lng, a.lat], [b.lng, b.lat]) / 30) + 8) throw new Error('implausible node count in segment ' + i);
      return safe;
    });
    return { name: source.name, color: source.color.toLowerCase(), spec: source.spec, specSource: source.specSource,
      stations: stations, paths: paths, nodes: nodes, crs: gameCrs, registrationMaxM: compiled.fit.maxErrorM };
  };

  api.check = function (lineId, plan) {
    var line = G.lines.find(function (l) { return l.id === lineId; });
    if (!line) return { ok: false, errors: ['line missing'] };
    var errors = [], maxStationM = 0, maxNodeM = 0, minPlatformM = Infinity;
    if (line.stations.length !== plan.stations.length) errors.push('station count');
    if (String(line.color).toLowerCase() !== plan.color) errors.push('color');
    ['trainType', 'trainCars', 'maxSpeedKmh'].forEach(function (k) { if (line[k] !== plan.spec[k]) errors.push(k); });
    if (!!line.isRing || line.branchRootId) errors.push('unexpected topology');
    line.stations.forEach(function (s, i) {
      var target = plan.stations[i];
      if (!target) return;
      if (s.name !== target.name) errors.push('station name/order ' + i);
      maxStationM = Math.max(maxStationM, distance([s.latlng.lng, s.latlng.lat], [target.lng, target.lat]));
    });
    if ((line.segmentAnchors || []).length !== plan.nodes.length) errors.push('segment count');
    plan.nodes.forEach(function (expected, i) {
      var actual = (line.segmentAnchors || [])[i] || [];
      if (actual.length !== expected.length) errors.push('node count ' + i);
      actual.forEach(function (p, j) {
        if (!expected[j]) return;
        maxNodeM = Math.max(maxNodeM, distance([p.lng, p.lat], expected[j]));
        var a = plan.stations[i], b = plan.stations[i + 1];
        minPlatformM = Math.min(minPlatformM, distance([p.lng, p.lat], [a.lng, a.lat]), distance([p.lng, p.lat], [b.lng, b.lat]));
      });
    });
    if (maxStationM > 2) errors.push('station coordinates');
    if (maxNodeM > 2) errors.push('node coordinates/order');
    if (minPlatformM < 100) errors.push('platform clearance');
    if ((line.pendingAnchors || []).length) errors.push('pending nodes');
    return { ok: !errors.length, errors: errors, stations: line.stations.length,
      nodes: (line.segmentAnchors || []).reduce(function (n, a) { return n + a.length; }, 0),
      maxStationM: maxStationM, maxNodeM: maxNodeM, minPlatformM: minPlatformM,
      registrationMaxM: plan.registrationMaxM };
  };

  api.draw = async function (plan, opts) {
    opts = opts || {};
    if (G.cityKey !== opts.cityKey || G.economyMode !== 'free') throw new Error('requires explicit isolated creative city');
    if (opts.localOnly !== true) throw new Error('new local test-save scope must be explicit');
    if (typeof _metroCloudAutosaveInFlight !== 'undefined' && _metroCloudAutosaveInFlight) throw new Error('cloud save in flight');
    if (typeof _metroCloudAutosaveTimer !== 'undefined' && _metroCloudAutosaveTimer) throw new Error('disable cloud autosave in the test page first');
    if (G.editMode === 'place' || G.editMode === 'add-station') throw new Error('finish existing edit before drawing');
    if ((MT.engineProfile().crs === 'wgs84' ? 'wgs84' : 'gcj02') !== plan.crs) throw new Error('map engine changed; prepare again');
    if (G.lines.some(function (l) { return l.name === plan.name; })) throw new Error('line already exists; inspect instead of retrying');
    var before = G.lines.map(function (l) { return l.id; });
    window.CityMetroKit.snapshot('plan-image:' + plan.name);
    await window.__officialDraw.createLine(plan.name);
    var added = G.lines.filter(function (l) { return before.indexOf(l.id) < 0; });
    if (added.length !== 1 || added[0].stations.length) throw new Error('new empty line not uniquely identified');
    var line = added[0], id = line.id;
    try {
      if (G.editMode !== 'place' || G.currentLineId !== id) throw new Error('official place mode unavailable');
      G.lineInfoLineId = id;
      top.openLineEditFromInfoPanel();
      document.getElementById('line-edit-name-zh').value = plan.name;
      top.pickLineColor(null, plan.color);
      top.selectType({ dataset: { type: plan.spec.trainType } });
      top.selectCars({ dataset: { cars: String(plan.spec.trainCars) } });
      top.selectSpeed({ dataset: { speed: String(plan.spec.maxSpeedKmh) } });
      top.confirmLineEditFromInfoPanel();
      if (line.name !== plan.name || String(line.color).toLowerCase() !== plan.color) throw new Error('official property edit rejected');
      for (var i = 0; i < plan.stations.length; i++) {
        if (i) {
          for (var j = 0; j < plan.nodes[i - 1].length; j++) {
            var node = plan.nodes[i - 1][j], n = line.pendingAnchors.length;
            top.onMapRightclick({ latlng: { lng: node[0], lat: node[1] } });
            if (line.pendingAnchors.length !== n + 1) throw new Error('official node rejected ' + (i - 1) + '/' + j);
            await wait(25);
          }
        }
        var station = plan.stations[i], previous = line.stations.slice();
        if (!i) top.placeStation(id, { lng: station.lng, lat: station.lat }, station.name);
        else top.executePlaceModeStationClick({ latlng: { lng: station.lng, lat: station.lat } });
        if (line.stations.length !== i + 1 || previous.some(function (s, k) { return line.stations[k] !== s; })) throw new Error('official station rejected or reordered ' + i);
        if (line._autoNameQueuePromise) await line._autoNameQueuePromise;
        var actual = line.stations[i];
        if (distance([actual.latlng.lng, actual.latlng.lat], [station.lng, station.lat]) > 2) throw new Error('station snapped away from image ' + i);
        if (!top.syncTransferGroupStationName(actual, station.name)) throw new Error('station naming conflict ' + i);
        await wait(50);
      }
      top.confirmCreateLine();
      if (G.editMode === 'place') throw new Error('official completion rejected');
      var checked = api.check(id, plan);
      return { ok: checked.ok, lineId: id, name: plan.name, check: checked };
    } catch (error) {
      return { ok: false, lineId: id, name: plan.name, partialStations: line.stations.length,
        reason: String(error.message || error), action: 'inspect partial official edit; do not automatically delete or retry' };
    }
  };
  window.PlanMap = api;
})();
