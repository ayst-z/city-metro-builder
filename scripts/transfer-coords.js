/**
 * 换乘站独立坐标：审计 + 修复（页面侧辅助，2026-11-14）
 * 注入顺序：mt-* → od → k 之后注入本文件。
 * API：
 *   await window.__transferCoordAudit({city?})  // 只读：逐线投影换乘站，返回 dev>阈值/out_of_path 清单 + 共享坐标组
 *   await window.__transferCoordFix({city?, maxDevM=30, guardDevM=300, rebuildNodes=true, dryRun=false})
 *       // 逐线修复：dev>maxDev 的站按本线 path 投影校准；out_of_path 用相邻站局部 path 投影并重设相邻 segmentAnchors；
 *       // 与伙伴线 >150m 的换乘组置 transferSpatiallyUnlinked；可选 OD.rebuildNodesFromAmap 重生成节点。
 * 口径见 SKILL.md §6.4 / references/beta2-acceptance.md。
 */
(function () {
  if (window.__transferCoordAudit) return;
  var K = window.CityMetroKit, OD = window.__officialDraw, MT = window.__metroToolkit;

  function cityOf(name) {
    var m = /^(上海|苏州|无锡|常州|南京|宁波|杭州|武汉|广州|成都|深圳|重庆)/.exec(String(name || ''));
    return m ? m[1] : '';
  }
  function lineNoOf(name) {
    var m = /(\d+[A-Za-z]*|[A-Za-z]+\d+)号线/.exec(String(name || ''));
    return m ? m[1].toUpperCase() : '';
  }
  function distM(a, b) {
    var R = 6371000, p = Math.PI / 180;
    var dLat = (b.lat - a.lat) * p, dLng = (b.lng - a.lng) * p;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function asMap(r, names) {
    if (!r) return {};
    if (names.length === 1) { var o = {}; o[names[0]] = r; return o; }
    return r;
  }
  function transferNames(line) {
    return (line.stations || []).filter(function (s) { return s && s.isTransfer; }).map(function (s) { return s.name; });
  }

  // 只读审计
  window.__transferCoordAudit = async function (opts) {
    opts = opts || {};
    var maxDev = opts.maxDevM != null ? opts.maxDevM : 30;
    var issues = [], errors = [], lines = [];
    var all = (window.G && G.lines) || [];
    for (var i = 0; i < all.length; i++) {
      var l = all[i];
      if (opts.city && cityOf(l.name) !== opts.city) continue;
      var names = transferNames(l);
      if (!names.length) continue;
      var city = cityOf(l.name);
      var r;
      try { r = await K.resolveLineCoord(city, l.id, names); } catch (e) { errors.push({ line: l.name, e: String(e && e.message || e).slice(0, 120) }); continue; }
      var map = asMap(r, names);
      lines.push({ line: l.name, transfers: names.length });
      for (var j = 0; j < names.length; j++) {
        var nm = names[j], o = map[nm];
        if (!o) { errors.push({ line: l.name, station: nm, e: 'no result' }); continue; }
        if (o.error) { issues.push({ line: l.name, station: nm, dev: o.devM, type: 'out_of_path' }); continue; }
        if (o.devM > maxDev) issues.push({ line: l.name, station: nm, dev: o.devM, type: 'dev' });
      }
      if (i % 4 === 3) await new Promise(function (res) { setTimeout(res, 120); });
    }
    // 共享对象/同坐标组
    var groups = {}, shared = [];
    var objMap = new Map();
    all.forEach(function (l) { (l.stations || []).forEach(function (s) { if (!objMap.has(s)) objMap.set(s, []); objMap.get(s).push(l.name); }); });
    objMap.forEach(function (ls, s) { if (new Set(ls).size > 1) shared.push({ station: s.name, lines: ls.slice(0, 3) }); });
    return { lines: lines.length, issues: issues, errors: errors, sharedObjs: shared.length, sharedSample: shared.slice(0, 5) };
  };

  // 修复
  window.__transferCoordFix = async function (opts) {
    opts = opts || {};
    var maxDev = opts.maxDevM != null ? opts.maxDevM : 30;
    var guardDev = opts.guardDevM != null ? opts.guardDevM : 300;
    var dryRun = opts.dryRun === true;
    var rebuild = opts.rebuildNodes !== false;
    var out = { planned: [], calibrated: [], fallback: [], skipped: [], rebuilt: [], groupsUnlinked: 0 };
    if (!dryRun && typeof window.__separateSharedStations === 'function') { try { out.separated = window.__separateSharedStations(); } catch (e) {} }
    var all = (window.G && G.lines) || [];
    if (!dryRun) { try { K.snapshot('transfer-coord-fix'); } catch (e) {} }

    for (var i = 0; i < all.length; i++) {
      var l = all[i];
      if (opts.city && cityOf(l.name) !== opts.city) continue;
      var names = transferNames(l);
      if (!names.length) continue;
      var city = cityOf(l.name), no = lineNoOf(l.name);
      var r;
      try { r = await K.resolveLineCoord(city, l.id, names); } catch (e) { out.skipped.push({ line: l.name, e: String(e && e.message || e).slice(0, 100) }); continue; }
      var map = asMap(r, names);
      var coords = [];
      for (var j = 0; j < names.length; j++) {
        var nm = names[j], o = map[nm];
        if (!o) continue;
        if (o.error) {
          // out_of_path → 相邻站局部 path 投影
          if (!dryRun) {
            var idx = (l.stations || []).findIndex(function (s) { return s.name === nm; });
            if (idx > 0 && idx < l.stations.length - 1) {
              var A = l.stations[idx - 1].latlng, B = l.stations[idx + 1].latlng, st = l.stations[idx];
              try {
                var q = await MT.queryTransferStops(city, [A.lng, A.lat], [B.lng, B.lat], no + '号线');
                if (q && q.ok && q.path && q.path.length >= 2) {
                  var best = null, bd = Infinity;
                  for (var k = 0; k < q.path.length; k++) {
                    var d = distM({ lat: st.latlng.lat, lng: st.latlng.lng }, { lat: q.path[k][1], lng: q.path[k][0] });
                    if (d < bd) { bd = d; best = k; }
                  }
                  if (best != null && bd <= guardDev) {
                    st.latlng = { lat: q.path[best][1], lng: q.path[best][0] };
                    try { if (st.latlngWgs && typeof gcj02ToWgs84 === 'function') { var w = gcj02ToWgs84(st.latlng.lng, st.latlng.lat); st.latlngWgs = { lat: w[1], lng: w[0] }; } } catch (e) {}
                    l.segmentAnchors = l.segmentAnchors || [];
                    // 用最近点索引把局部 path 分成前后两段
                    var segA = [], segB = [];
                    for (var k2 = 0; k2 < q.path.length; k2++) {
                      var p = { lat: q.path[k2][1], lng: q.path[k2][0] };
                      if (k2 > 0 && k2 < best) segA.push(p);
                      else if (k2 > best && k2 < q.path.length - 1) segB.push(p);
                    }
                    l.segmentAnchors[idx - 1] = segA;
                    l.segmentAnchors[idx] = segB;
                    out.fallback.push({ line: l.name, station: nm, fromDevM: Math.round(bd) });
                  } else out.skipped.push({ line: l.name, station: nm, reason: 'fallback_dev_too_large', dev: Math.round(bd) });
                } else out.skipped.push({ line: l.name, station: nm, reason: 'no_local_path' });
              } catch (e) { out.skipped.push({ line: l.name, station: nm, reason: 'fallback_error' }); }
            } else out.skipped.push({ line: l.name, station: nm, reason: 'no_neighbors' });
          }
          continue;
        }
        if (o.devM > maxDev && o.devM <= guardDev) coords.push({ name: nm, lat: o.lat, lng: o.lng });
      }
      if (coords.length) {
        out.planned.push({ line: l.name, count: coords.length, names: coords.map(function (c) { return c.name; }) });
        if (!dryRun) {
          try { var cal = K.calibrateCoordinates(l.id, coords); out.calibrated.push({ line: l.name, updated: cal && cal.updated ? cal.updated.length : 0 }); } catch (e) { out.skipped.push({ line: l.name, reason: 'calibrate_error' }); }
        }
      }
      if ((coords.length || out.fallback.some(function (f) { return f.line === l.name; })) && rebuild && !dryRun) {
        try { await OD.rebuildNodesFromAmap(city, l.id, { density: 'standard' }); out.rebuilt.push(l.name); } catch (e) {}
      }
      if (i % 3 === 2) await new Promise(function (res) { setTimeout(res, 120); });
    }
    // 长通道换乘组：>150m 置 spatiallyUnlinked
    if (!dryRun) {
      var groups = {};
      all.forEach(function (l) { (l.stations || []).forEach(function (s) { if (s.isTransfer && s.transferGroupId) (groups[s.transferGroupId] = groups[s.transferGroupId] || []).push(s); }); });
      Object.keys(groups).forEach(function (tg) {
        var m = groups[tg]; if (m.length < 2) return;
        var far = false;
        for (var a = 0; a < m.length; a++) for (var b = a + 1; b < m.length; b++) if (distM(m[a].latlng, m[b].latlng) > 150) far = true;
        if (far) { m.forEach(function (s) { s.transferSpatiallyUnlinked = true; }); out.groupsUnlinked++; }
      });
    }
    return out;
  };
  // 按对象身份彻底分离跨线共享站（不依赖 transferGroupId；K.separateTransferStations 仅在同组内生效）
  window.__separateSharedStations = function () {
    var lines = (window.G && G.lines) || [];
    var map = new Map();
    lines.forEach(function (l) { (l.stations || []).forEach(function (s, i) { if (!map.has(s)) map.set(s, []); map.get(s).push({ l: l, i: i }); }); });
    var separated = 0, affected = new Set();
    map.forEach(function (refs, s) {
      if (refs.length < 2) return;
      for (var k = 1; k < refs.length; k++) {
        var clone = Object.assign({}, s);
        clone.latlng = Object.assign({}, s.latlng);
        if (s.latlngWgs) clone.latlngWgs = Object.assign({}, s.latlngWgs);
        refs[k].l.stations[refs[k].i] = clone;
        separated++; affected.add(refs[k].l.id);
      }
    });
    try { if (typeof metroInvalidateTransferVisualGeometryCaches === 'function') metroInvalidateTransferVisualGeometryCaches(); } catch (e) {}
    lines.forEach(function (l) {
      if (!affected.has(l.id)) return;
      ['_curvePts', '_curvePtsWgs', '_segAnchSaveCache'].forEach(function (k) { try { l[k] = null; } catch (e) {} });
      try { if (typeof window.redrawLine === 'function') window.redrawLine(l); } catch (e) {}
      try { if (typeof window.refreshStationDots === 'function') window.refreshStationDots(l); } catch (e) {}
    });
    return { separated: separated, affected: affected.size };
  };

  console.log('[transfer-coords] audit/fix injected');
})();
