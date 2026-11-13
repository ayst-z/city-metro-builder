/**
 * MT 查询工具箱 · amap（3.0）
 * ─────────────────────────────────────────────────────────────
 * 注入: window.__metroToolkit（与 mt-core / mt-node 共享同一对象）
 * 职责: 高德查询核心 + OSM 数据源（POI/换乘/单站/整线/在建线/srhdata/bus/OSM/有轨电车/完整性检查/表格/坐标错位检测）
 * 依赖: mt-core（resolveCityKey/officialColors/matchOfficial/lineSpec/endpointsOf/withTimeout/...）、
 *       mt-node（fitSegmentNodes/curvatureThin）、
 *       mt-data（window.__MT_SUBMETRO_DATA 内置官方数据集，queryLine 优先命中省 token）
 * 加载顺序: 必须在 mt-core / mt-node / mt-data 之后注入
 * 公开 API:
 *   placeSearch / transferSearch / resolveCoord / queryTransferStops / queryLineStopsByPOI /
 *   getLines / findLine / queryAMapSubwayWeb / queryLineByBusAPI / parseAMapSubwayData /
 *   subwayDataUrl / CITY_ADCODE / parseOsmMetroData / queryOsmOverpass / queryLineOsm / compareSources /
 *   queryTramLine / resolveTramCoord / checkLineCompleteness / formatLineTable / queryLine /
 *   detectOsmShift / fixOsmShift
 * OSM 说明: queryOsmOverpass 为 OSM 线路查询——优先游戏内 OSM API（maplibre querySourceFeatures 读
 *           urban_rail_lines/urban_rail_stations 层，站点+真实走向，国际城市 0-7ms），
 *           无数据回退公共 Overpass（带串行/限流/多镜像/缓存）；queryLineOsm/parseOsmMetroData 解析外部 OSM JSON。
 * 坐标说明: detectOsmShift/fixOsmShift 检测修复切换地图（高德↔OSM）导致的坐标系错位
 *           （用 mt-data 官方高德 GCJ02 坐标对比，偏差>150m 判错位，coordToGameNative 转换修复）。
 */
(function () {
  'use strict';
  var MT = window.__metroToolkit = window.__metroToolkit || {};
  if (MT.__amapVersion === '6.5.3') return; // 版本守卫：本拆分文件已注入
  // ===== 取 mt-core 共享依赖（拆分后独立 IIFE，经 MT 共享）=====
  var withTimeout = MT.withTimeout;
  var ensureAmap = MT.ensureAmap;
  var extractLngLat = MT.extractLngLat;
  var withFallback = MT.withFallback;
  var verifyMetroPOI = MT.verifyMetroPOI;
  var verifyTramPOI = MT.verifyTramPOI;
  var inCityBounds = MT.inCityBounds;
  var segInCity = MT.segInCity;
  var resolveCityKey = MT.resolveCityKey;
  var CITY_ALIASES = MT.CITY_ALIASES;
  // 取 mt-core 官方配色/车型/端点（queryLine 依赖）
  var officialColors = MT.officialColors;
  var matchOfficial = MT.matchOfficial;
  var lineSpec = MT.lineSpec;
  var endpointsOf = MT.endpointsOf;
  // 取 mt-node 节点拟合（queryLine 依赖）
  var fitSegmentNodes = MT.fitSegmentNodes;
  var curvatureThin = MT.curvatureThin;
  // 取 mt-core 球面距离（内置数据集节点生成用）
  var haversine = MT.haversine;
  // 取 mt-core 公共 helper（3.0 查重优化）
  var _normLineNo = MT._normLineNo;
  var _parseCoord = MT._parseCoord;
  var _parseSrhStops = MT._parseSrhStops;
  var G = window.G;
  // WEB_KEY 未直接导出，经 MT.webKey() 读取
  //   - 有轨电车: queryTramLine / resolveTramCoord / _tramCache（并入查询功能）

  // ===== POI 搜索 =====
  // 游戏内高德 POI 搜索（8s 超时防挂起）。
  //   - 调用方: placeSearch(via=game/auto)
  //   - 签名: _gamePlace(city, keyword, pageSize=5) → Promise<{ok, pois:[{name,type,address,typecode,lng,lat}]}>
  //   - 逻辑链: ensureAmap(['AMap.PlaceSearch']) → PlaceSearch.search → extractLngLat
  //   - 注意: 内部函数，勿直接调用；游戏内无该插件时返回 ok:false
  function _gamePlace(city, keyword, pageSize) {
    return withTimeout(new Promise(function (resolve) {
      ensureAmap(['AMap.PlaceSearch']).then(function (ok) {
        if (!ok || !window.AMap.PlaceSearch) return resolve({ ok: false, reason: '游戏内 AMap PlaceSearch 不可用' });
        var ps = new window.AMap.PlaceSearch({ city: city || '', pageSize: pageSize || 5 });
        ps.search(keyword, function (status, result) {
          var pois = (result && result.poiList && result.poiList.pois) || [];
          resolve({
            ok: status === 'complete',
            pois: pois.map(function (p) {
              var ll = extractLngLat(p.location);
              return { name: p.name, type: p.type || '', address: p.address || '', typecode: p.typecode || '', lng: ll ? ll[0] : null, lat: ll ? ll[1] : null };
            })
          });
        });
      });
    }), 8000, { ok: false, reason: '游戏内高德查询超时' });
  }

  // 高德免费 Web API POI 搜索（需 key，8s 超时）。
  //   - 调用方: placeSearch(via=free/auto)
  //   - 签名: _freePlace(city, keyword, pageSize=5) → Promise<{ok, pois}>
  //   - 逻辑链: 经 MT.webKey() 取 key → fetch restapi → 解析 location 为 lng/lat
  //   - 注意: 未配置 key 返回 ok:false（reason 提示配置）；内部函数
  function _freePlace(city, keyword, pageSize) {
    if (!MT.webKey()) return Promise.resolve({ ok: false, reason: '未配置高德免费 Web key（window.__MT_AMAP_WEB_KEY）' });
    var url = 'https://restapi.amap.com/v3/place/text?key=' + MT.webKey() +
      '&keywords=' + encodeURIComponent(keyword) + '&city=' + encodeURIComponent(city || '') + '&offset=' + (pageSize || 5) + '&extensions=base';
    return withTimeout(fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      if (j.status !== '1') return { ok: false, reason: j.info };
      return { ok: true, pois: (j.pois || []).map(function (p) { var ll = _parseCoord(p.location); return { name: p.name, type: p.type || '', address: p.address || '', typecode: p.typecode || '', lng: ll ? ll.lng : null, lat: ll ? ll.lat : null }; }) };
    }).catch(function (e) { return { ok: false, reason: String(e) }; }), 8000, { ok: false, reason: '免费API超时' });
  }

  // 统一 POI 搜索入口（公开 API）。
  //   - 调用方: resolveCoord / queryLineStopsByPOI / queryTramLine / resolveTramCoord 及外部
  //   - 签名: placeSearch(city, keyword, opts) → Promise<{ok, pois}>
  //   - opts: { pageSize=5, via:'game'(默认)|'free'|'auto' }
  //   - 逻辑链: via=free→_freePlace；auto→withFallback(_gamePlace,_freePlace)；默认→_gamePlace
  //   - 注意: auto 先 game 失败切 free；连续调用易触发高德频控，调用方需加延迟
  function placeSearch(city, keyword, opts) {
    opts = opts || {};
    var pageSize = (typeof opts === 'number') ? opts : (opts.pageSize || 5);
    var via = (typeof opts === 'object' && opts.via) || 'game';
    if (via === 'free') return _freePlace(city, keyword, pageSize);
    if (via === 'auto') {
      return withFallback(function () { return _gamePlace(city, keyword, pageSize); },
        function () { return _freePlace(city, keyword, pageSize); }, 1);
    }
    return _gamePlace(city, keyword, pageSize);
  }

  // ===== 换乘查询 =====
  // 游戏内高德换乘查询（10s 超时防挂起，含 stops + path）。
  //   - 调用方: transferSearch(via=game/auto)
  //   - 签名: _gameTransfer(city, fromLngLat, toLngLat) → Promise<{ok, plans:[{segments}]}>
  //   - 段结构: {mode, lines:[名], stops:[{name,_loc}], path:[{lng,lat}]}
  //   - 注意: 内部函数；stops 坐标暂存于 _loc（需经 extractLngLat 解出）；path 为线路坐标
  function _gameTransfer(city, fromLngLat, toLngLat) {
    return withTimeout(new Promise(function (resolve) {
      ensureAmap(['AMap.Transfer']).then(function (ok) {
        if (!ok || !window.AMap.Transfer) return resolve({ ok: false, reason: '游戏内 AMap Transfer 不可用' });
        var plan = new window.AMap.Transfer({ city: city || '', policy: 0 });
        plan.search(fromLngLat, toLngLat, function (status, result) {
          if (status !== 'complete' || !result.plans || !result.plans.length) return resolve({ ok: false, status: status });
          resolve({
            ok: true,
            plans: result.plans.map(function (p) {
              return {
                segments: (p.segments || []).map(function (sg) {
                  var t = sg.transit || null;
                  return {
                    mode: sg.transit_mode || 'TRANSIT',
                    lines: (t && t.lines || []).map(function (l) { return l.name; }),
                    stops: (function () {
                      var arr = [];
                      var add = function (s) { if (s && s.name) arr.push({ name: s.name, lng: null, lat: null, _loc: s.location }); };
                      add(t && t.on_station); (t && t.via_stops || []).forEach(add); add(t && t.off_station);
                      return arr;
                    })(),
                    path: (t && t.path || []).map(extractLngLat).filter(Boolean)
                  };
                })
              };
            })
          });
        });
      });
    }), 10000, { ok: false, reason: '游戏内高德查询超时' });
  }

  // 高德免费 Web API 换乘查询（需 key，8s 超时）。
  //   - 调用方: transferSearch(via=free/auto)
  //   - 签名: _freeTransfer(city, fromLngLat, toLngLat) → Promise<{ok, plans}>
  //   - 注意: 免费 API 段无 path（path:[]）；公交段 stops 直接含 lng/lat；内部函数
  function _freeTransfer(city, fromLngLat, toLngLat) {
    if (!MT.webKey()) return Promise.resolve({ ok: false, reason: '未配置高德免费 Web key' });
    var url = 'https://restapi.amap.com/v3/direction/transit/integrated?key=' + MT.webKey() +
      '&origin=' + fromLngLat.join(',') + '&destination=' + toLngLat.join(',') +
      '&city=' + encodeURIComponent(city || '') + '&strategy=0';
    return withTimeout(fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      if (j.status !== '1' || !j.route || !j.route.transits) return { ok: false, reason: j.info };
      return {
        ok: true,
        plans: (j.route.transits || []).map(function (tr) {
          return {
            segments: (tr.segments || []).map(function (sg) {
              var stops = [];
              if (sg.bus && sg.bus.buslines && sg.bus.buslines[0]) {
                var bl = sg.bus.buslines[0];
                stops.push({ name: bl.departure_stop && bl.departure_stop.name || '', lng: null, lat: null });
                (bl.via_stops || []).forEach(function (v) { stops.push({ name: v.name || '', lng: null, lat: null }); });
                stops.push({ name: bl.arrival_stop && bl.arrival_stop.name || '', lng: null, lat: null });
              }
              return {
                mode: sg.walking ? 'WALK' : 'BUS',
                lines: sg.bus && sg.bus.buslines && sg.bus.buslines[0] ? [sg.bus.buslines[0].name] : [],
                stops: stops,
                path: []
              };
            })
          };
        })
      };
    }).catch(function (e) { return { ok: false, reason: String(e) }; }), 8000, { ok: false, reason: '免费API超时' });
  }

  // 统一换乘查询入口（公开 API）。
  //   - 调用方: queryTransferStops / 外部
  //   - 签名: transferSearch(city, fromLngLat, toLngLat, opts) → Promise<{ok, plans}>
  //   - opts: { via:'game'(默认)|'free'|'auto' }
  //   - 逻辑链: 同 placeSearch（auto→withFallback 切换数据源）
  //   - 注意: from/to 为 [lng,lat]；返回 plans 原始结构供上层解析
  function transferSearch(city, fromLngLat, toLngLat, opts) {
    var via = (opts && opts.via) || 'game';
    if (via === 'free') return _freeTransfer(city, fromLngLat, toLngLat);
    if (via === 'auto') {
      return withFallback(function () { return _gameTransfer(city, fromLngLat, toLngLat); },
        function () { return _freeTransfer(city, fromLngLat, toLngLat); }, 1);
    }
    return _gameTransfer(city, fromLngLat, toLngLat);
  }

  // 解析单个站名坐标（公开 API）。多关键词自动重试 + 免费 API 兜底。
  //   - 调用方: queryLine（解析首末站）/ 外部
  //   - 签名: resolveCoord(city, name) → Promise<{ok, name, poiName, lng, lat, via}>
  //   - 逻辑链: keywords=[名+地铁站, 名+站, 名] → placeSearch → _pickMetroPoi(城市内地铁POI) → verifyMetroPOI → withFallback(free)
  //   - 注意: 优先城市内地铁站；城市内无匹配则尝试下一关键词；via 标记 game/free
  // 从 POI 结果中挑选：城市内地铁站优先，其次城市内任意 POI；无则 null（供 resolveCoord 复用）
  function _pickMetroPoi(city, r) {
    if (!r || !r.pois || !r.pois.length) return null;
    var metro = r.pois.find(function (p) { return /地铁|轨道交通/.test(p.type) && inCityBounds(city, p.lng, p.lat); });
    if (metro) return metro;
    return r.pois.find(function (p) { return inCityBounds(city, p.lng, p.lat); }) || null;
  }
  function resolveCoord(city, name) {
    var keywords = [name + '地铁站', name + '站', name];
    var kwIdx = 0;
    function attempt(via) {
      if (kwIdx >= keywords.length) return Promise.resolve({ ok: false });
      var kw = keywords[kwIdx++];
      var po = (via === 'free') ? { via: 'free' } : undefined;
      return placeSearch(city, kw, po || 5).then(function (r) {
        var poi = _pickMetroPoi(city, r);
        if (!poi) return attempt(via);
        var v = verifyMetroPOI(city, null, poi);
        if (!v.ok) return attempt(via);
        if (typeof poi.lng === 'number' && typeof poi.lat === 'number') {
          return { ok: true, name: name, poiName: poi.name, lng: poi.lng, lat: poi.lat, via: via };
        }
        return attempt(via);
      });
    }
    // 游戏内（多关键词，重试 2 次）→ 免费兜底
    return withFallback(function () { return attempt('game'); }, function () { return attempt('free'); }, 2);
  }

  // 相邻同名去重（供 queryTransferStops 的 game/free 复用）
  function _uniqStops(stops) {
    var uniq = [];
    for (var i = 0; i < stops.length; i++) if (!uniq.length || uniq[uniq.length - 1].name !== stops[i].name) uniq.push(stops[i]);
    return uniq;
  }

  // 获取线路整段 Transfer（公开 API）。含 stops 序列 + path + 目标线判断；SUBWAY 段优先，公交/步行段兜底。
  //   - 调用方: queryLine（核心数据来源）/ 换乘站坐标校准
  //   - 签名: queryTransferStops(city, from, to, lineFilter) → Promise<{ok, stops, path, lineNames, busFallback}>
  //   - 逻辑链: transferSearch → 按 lineFilter 匹配段 → SUBWAY 优先(segInCity 过滤跨城同名) → 无地铁退公交 → _uniqStops 去重
  //   - 返回: stops:[{name,lng,lat}] / path:[[lng,lat]] / busFallback: 是否仅公交段
  //   - 注意: lineFilter 为线名（如 '2号线'）；公交段说明该线可能为在建/规划
  function queryTransferStops(city, from, to, lineFilter) {
    function gameAttempt() {
      return transferSearch(city, from, to).then(function (r) {
        if (!r.ok) return { ok: false };
        var stops = [], path = [], lineNames = [], busStops = [], busPath = [], busLineNames = [];
        var subwayFound = false, busFallback = false;
        // 2026-08-22 修复：多 plan 拼接导致 path 乱序（如上海2号线 plan0=机场线+2号线混合、plan1=纯2号线完整走向）。
        //   原逻辑遍历所有 plan 把每个 plan 的 SUBWAY 段 path 都 push → 正反/换乘方案拼接乱序。
        //   改为选取"目标线 SUBWAY 站点数最多"的 plan（即完整的该线直达走向），只处理该 plan。
        var _plans = r.plans || [];
        var _bestPlan = null, _bestCnt = -1;
        for (var _pi = 0; _pi < _plans.length; _pi++) {
          var _p0 = _plans[_pi], _c0 = 0;
          (_p0.segments || []).forEach(function (_sg) {
            if (_sg.mode !== 'SUBWAY' || !_sg.lines || !_sg.lines.length) return;
            var _t0 = !lineFilter || _sg.lines.some(function (ln) { return ln.indexOf(lineFilter) >= 0; });
            if (_t0 && segInCity(city, _sg)) _c0 += (_sg.stops || []).length;
          });
          if (_c0 > _bestCnt) { _bestCnt = _c0; _bestPlan = _p0; }
        }
        if (!_bestPlan) _bestPlan = _plans[0];
        (_bestPlan.segments || []).forEach(function (sg) {
            if (!sg.lines || !sg.lines.length) return;
            var isTarget = !lineFilter || sg.lines.some(function (ln) { return ln.indexOf(lineFilter) >= 0; });
            if (!isTarget) return;
            if (sg.mode === 'SUBWAY') {
              if (!segInCity(city, sg)) return;
              subwayFound = true;
              (sg.lines || []).forEach(function (ln) { if (lineNames.indexOf(ln) < 0) lineNames.push(ln); });
              sg.stops.forEach(function (s) { var ll = extractLngLat(s._loc); if (ll) stops.push({ name: s.name, lng: ll[0], lat: ll[1] }); });
              sg.path.forEach(function (pt) { path.push(pt); });
            } else {
              (sg.lines || []).forEach(function (ln) { if (busLineNames.indexOf(ln) < 0) busLineNames.push(ln); });
              sg.stops.forEach(function (s) { var ll = extractLngLat(s._loc); if (ll) busStops.push({ name: s.name, lng: ll[0], lat: ll[1] }); });
              sg.path.forEach(function (pt) { busPath.push(pt); });
            }
        });
        if (!subwayFound || stops.length < 2) { stops = busStops; path = busPath; lineNames = busLineNames; busFallback = true; }
        return { ok: stops.length >= 2, stops: _uniqStops(stops), path: path, lineNames: lineNames, subwayFound: !busFallback, busFallback: busFallback };
      });
    }
    function freeAttempt() {
      return transferSearch(city, from, to, { via: 'free' }).then(function (r) {
        if (!r.ok) return { ok: false };
        var stops = [], lineNames = [];
        (r.plans || []).forEach(function (p) { (p.segments || []).forEach(function (sg) {
          (sg.lines || []).forEach(function (ln) { if (lineNames.indexOf(ln) < 0) lineNames.push(ln); });
          sg.stops.forEach(function (s) { stops.push({ name: s.name, lng: s.lng, lat: s.lat }); });
        }); });
        return { ok: stops.length >= 2, stops: _uniqStops(stops), path: [], lineNames: lineNames, subwayFound: lineNames.some(function (l) { return !lineFilter || l.indexOf(lineFilter) >= 0; }) };
      });
    }
    return withFallback(gameAttempt, freeAttempt, 2);
  }

  // 未开通/在建线路站点（公开 API）：搜索仅提供候选，不证明线路归属。
  //   - 签名: queryLineStopsByPOI(city, lineNo, opts) → Promise<{ok, city, lineNo, stops, count, rejectedCount, rejected}>
  //   - 归属证据: 名称/地址明确目标线号，或 opts.stations 精确归一站名白名单；仍须为非出入口地铁站。
  //   - opts.stations 同时限定返回站点及顺序；未传则无序。srhdata 兜底亦遵守显式站序。
  //   - rejected 按候选证据去重，最多 5 条截短样本；rejectedCount 为去重拒绝数（不按搜索次数累加）。
  function queryLineStopsByPOI(city, lineNo, opts) {
    opts = opts || {};
    function normLine(value) {
      return _normLineNo(String(value || '').replace(/\s+/g, '')).replace(/^(?:地铁|轨道交通)/, '').replace(/线$/, '');
    }
    var key = resolveCityKey(city) || city;
    var no = normLine(lineNo);
    var cityName = (CITY_ALIASES[key] && CITY_ALIASES[key][0]) || key;
    var keywords = [
      cityName + '地铁' + no + '号线', cityName + '轨道交通' + no + '号线',
      cityName + '地铁' + no + '线', no + '号线', cityName + no + '号线'
    ];
    // 数字/字母/连字符边界：S1 != 1，16 != 6，2-9 不拆成 2 或 9；裸数字不作线路证据。
    var linePattern = /^[A-Z]*\d+(?:-[A-Z]*\d+)*$/.test(no)
      ? new RegExp('(?:^|[^A-Z0-9-])' + no + '(?:号线|线)(?![A-Z0-9-])') : null;
    function hasLineEvidence(value) {
      var text = String(value || '').replace(/\s+/g, '').toUpperCase();
      if (!no) return false;
      if (linePattern) return linePattern.test(text);
      return text.split(/[;；,，、/()（）]/).some(function (part) {
        return /线$/.test(part) && normLine(part) === no;
      });
    }
    var order = Array.isArray(opts.stations) ? opts.stations.map(MT._normStopName) : null;
    var whitelist = Object.create(null);
    (order || []).forEach(function (name) { if (name) whitelist[name] = true; });
    function orderStops(stops) {
      if (!order) return stops;
      var byName = Object.create(null), ordered = [];
      stops.forEach(function (s) { byName[MT._normStopName(s.name)] = s; });
      order.forEach(function (name) {
        if (byName[name]) { ordered.push(byName[name]); delete byName[name]; }
      });
      return ordered;
    }
    var rejected = [], rejectedCount = 0, rejectedSeen = Object.create(null);
    function reject(p, reason) {
      var id = JSON.stringify([p.name, p.address, p.type, p.typecode, p.lng, p.lat, reason]);
      if (rejectedSeen[id]) return;
      rejectedSeen[id] = true;
      rejectedCount++;
      if (rejected.length < 5) rejected.push({
        name: String(p.name || '').slice(0, 80), address: String(p.address || '').slice(0, 100),
        type: String(p.type || '').slice(0, 80), typecode: String(p.typecode || '').slice(0, 20), reason: reason
      });
    }
    function withEvidence(result) {
      result.rejectedCount = rejectedCount;
      result.rejected = rejected;
      return result;
    }
    // srhdata 自带明确线路归属；无走向，且不得绕过调用方的显式站序。
    var srhFallback = function () {
      var lines = _srhLinesFor(city);
      if (!lines || !no) return null;
      var best = null;
      for (var i = 0; i < lines.length; i++) {
        if (normLine(lines[i].ln) !== no) continue;
        if (!best || (lines[i].st || []).length > (best.st || []).length) best = lines[i];
      }
      if (!best || !best.st || best.st.length < 2) return null;
      var st = orderStops(MT._parseSrhStops(best.st).map(function (s) { return { name: s.name, lng: s.lng, lat: s.lat }; }));
      return st.length >= 2 ? st : null;
    };
    var canAmap = (typeof window.AMap !== 'undefined') || !!(MT.webKey && MT.webKey());
    if (!canAmap) {
      var s0 = srhFallback();
      if (s0) return Promise.resolve(withEvidence({ ok: true, city: city, lineNo: no, stops: s0, count: s0.length, dataSource: 'srhdata', warning: 'AMap 未加载/无 key，使用注入 srhdata 站表（官方坐标，走向需另取）' }));
      return Promise.resolve(withEvidence({ ok: false, city: city, lineNo: no, stops: [], count: 0, reason: 'AMap 未加载且未配置 Web key，且无匹配 srhdata 站表；请切换高德引擎/MT.webKey(k)/注入 srhdata', dataSource: 'none' }));
    }
    var found = Object.create(null);
    var list = [];
    function collect(r) {
      (r.pois || []).forEach(function (p) {
        var nm = String(p.name || '').replace(/\s+/g, ''), ty = String(p.type || ''), code = String(p.typecode || '');
        // 先拒绝出入口（含 9A出口/9A口）及铁路/公交类别，白名单不可豁免。
        if (/出入口|入口|出口|号(?:东|西|南|北)?口|[A-Z0-9]+(?:号)?口/i.test(nm) || /出入口|入口|出口/.test(ty) || /(?:^|[|;,])150501(?:$|[|;,])/.test(code)) return reject(p, 'exit_noise');
        if (/火车|铁路|公交|长途汽车|汽车站|客运站/.test(ty) || /(?:^|[|;,])150[237]\d{2}(?:$|[|;,])/.test(code)) return reject(p, 'not_metro');
        var metroCode = /(?:^|[|;,])150[56]00(?:$|[|;,])/.test(code);
        if (!/地铁|轨道交通/.test(ty) && !metroCode) return reject(p, 'not_metro');
        // core 仅复用坐标/城市/占位符检查；不使用其数字子串线号检查，避免 S1 被误作 1。
        var v = verifyMetroPOI(city, null, { name: p.name, type: metroCode ? '地铁站' : ty, lng: p.lng, lat: p.lat });
        if (!v.ok) return reject(p, v.reason);
        var name = MT._normStopName(p.name);
        if (!name) return reject(p, 'empty_name');
        if (order && !whitelist[name]) return reject(p, 'not_in_station_order');
        if (!whitelist[name] && !hasLineEvidence(p.name) && !hasLineEvidence(p.address)) return reject(p, 'no_target_line_evidence');
        if (found[name]) return;
        found[name] = true;
        list.push({ name: name, lng: p.lng, lat: p.lat });
      });
    }
    function attempt(idx) {
      if (idx >= keywords.length) return Promise.resolve(list);
      // via:'auto'：游戏内 AMap 优先，不可用(OSM模式)切免费 Web API
      return placeSearch(city, keywords[idx], { pageSize: 25, via: 'auto' }).then(function (r) {
        if (r && r.ok) collect(r);
        return attempt(idx + 1);
      });
    }
    return attempt(0).then(function (stops) {
      stops = orderStops(stops);
      if (stops.length < 2) {
        var s1 = srhFallback();
        if (s1) return withEvidence({ ok: true, city: city, lineNo: no, stops: s1, count: s1.length, dataSource: 'srhdata', warning: '高德 POI 证据不足，使用注入 srhdata 站表（官方坐标，走向需另取）' });
      }
      return withEvidence({
        ok: stops.length >= 2, city: city, lineNo: no, stops: stops, count: stops.length,
        reason: stops.length >= 2 ? undefined : '高德 POI 未找到足够的该线地铁站证据（需名称/地址明确线号或 opts.stations 精确匹配；可能未开通/规划）',
        dataSource: 'amap-poi'
      });
    });
  }

  // 用高德搜索提示 API（poiTipsSearchlite，无需 key）查询未开通/在建线路的站点与线路信息。
  //   - 调用方: 绘制未开通/在建线前确认站点/端点/状态（补充 queryLineStopsByPOI 的坐标查询）
  //   - 签名: queryUnopenedLine(city, lineNo, opts?) → Promise<{ok, city, lineNo, lineName, terminals, status, distanceM, stops, count}>
  //   - 逻辑链: 拼 poiTipsSearchlite URL(城市 adcode+00) → fetch → 提取站点tip(地铁站)/线路tip(号线)
  //   - 注意: ① 接口为"搜索提示"，站点按相关性返回(非完整顺序)，走向需配合官方站名排序+直线插值
  //           ② 需高德域名上下文或 CORS 允许环境(fetch 带 Referer) ③ alias_en 含"(Zaijian)"=在建
  //           ④ terminals 为端点(如"虹建路-上海宝山站")；status 来自 taginfo(建设中)
  function queryUnopenedLine(city, lineNo, opts) {
    opts = opts || {};
    var key = resolveCityKey(city) || String(city || '').toLowerCase();
    var no = _normLineNo(lineNo);
    var cityName = (CITY_ALIASES[key] && CITY_ALIASES[key][0]) || key;
    var adcode = (CITY_ADCODE[key] || '') + '00';
    var kw = cityName + '地铁' + no + '号线';
    var url = 'https://www.amap.com/service/poiTipsSearchlite?&city=' + adcode + '&words=' + encodeURIComponent(kw);
    return fetch(url, { headers: { 'Referer': 'https://www.amap.com/' } })
      .then(function (r) { if (!r.ok) throw new Error('http_' + r.status); return r.json(); })
      .then(function (j) {
        var tips = (j && j.data && j.data.tip_list || []).map(function (t) { return t.tip || t; });
        var stops = [];
        tips.forEach(function (t) {
          if (/地铁站/.test(t.name || '')) {
            var n = String(t.name).replace(/[（(]地铁站[)）]/g, '');
            if (n) stops.push(n);
          }
        });
        var line = null;
        // 优先精确线路名("地铁X号线")；否则匹配含"号线"且非施工标段(项目部/工程/标/集团/公司)且有 terminals 的
        tips.forEach(function (t) {
          var nm = t.name || '';
          if (line) return;
          var isExact = nm === ('地铁' + no + '号线');
          var isLine = /地铁.*号线/.test(nm) && !/项目部|工程|标|集团|公司/.test(nm);
          if (isExact || (isLine && t.terminals)) line = t;
        });
        var terminals = line ? String(line.terminals || '').trim() : '';
        var status = (line && line.taginfo) ? String(line.taginfo).replace(/<[^>]+>/g, '') : '';
        var dist = line ? parseFloat(line.line_distance) : NaN;
        return {
          ok: stops.length >= 1, city: city, lineNo: no,
          lineName: line ? line.name : (city + '地铁' + no + '号线'),
          terminals: terminals, status: status,
          distanceM: isFinite(dist) ? dist : null, stops: stops, count: stops.length,
          dataSource: 'poiTipsSearchlite'
        };
      })
      .catch(function (e) {
        var msg = String(e && e.message || e);
        return { ok: false, reason: /Failed to fetch|NetworkError/i.test(msg) ? 'cors_or_net' : msg.slice(0, 40) };
      });
  }

  // 游戏线路只读（公开 API / 统一共享工具：OD/K 引用 MT）。
  //   - 调用方: findLine / OD / K 枚举游戏内已画线路
  //   - 签名: getLines() → 游戏线路数组（G.lines）
  function getLines() { return (G && G.lines) || []; }
  // 按 id / 名 / 模糊 找线（公开 API）。
  //   - 调用方: 绘制前判断线路是否已存在 / 换乘匹配
  //   - 签名: findLine(q) → 线路对象 | null
  //   - 逻辑链: id精确 → 名精确 → 去噪(地铁/号线)模糊包含
  //   - 注意: q 不区分大小写；找不到返回 null
  function findLine(q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return null;
    var lines = getLines();
    for (var i = 0; i < lines.length; i++) if (lines[i].id === q) return lines[i];
    for (i = 0; i < lines.length; i++) if (String(lines[i].name || '').toLowerCase() === q) return lines[i];
    var core = q.replace(/地铁|轨道交通|线路|号线|line/g, '');
    for (i = 0; i < lines.length; i++) { var nm = String(lines[i].name || '').toLowerCase(); if (core && nm.indexOf(core) >= 0) return lines[i]; }
    return null;
  }

  // ===== srhdata 高德地铁专题（已开通线官方全量）=====
  // 城市 adcode 表（供 subwayDataUrl 生成 srhdata URL）。
  //   - 被 subwayDataUrl 使用
  var CITY_ADCODE = {
    shanghai: '3100', suzhou: '3205', wuxi: '3202', changzhou: '3204', nanjing: '3201',
    yangzhou: '3210', zhenjiang: '3211', maanshan: '3405', chuzhou: '3411', taizhou: '3212', wuhu: '3402',
    beijing: '1100', wuhan: '4201', chengdu: '5101', shenzhen: '4403', tianjin: '1200', hangzhou: '3301',
    chongqing: '5000', xian: '6101', guangzhou: '4401', foshan: '4406', dongguan: '4419', xiamen: '3502',
    dalian: '2102', shenyang: '2101', qingdao: '3702', zhengzhou: '4101', nanning: '4501',
    hongkong: '8100', macau: '8200'
  };
  // 生成 srhdata 专题 URL（公开 API）。
  //   - 签名: subwayDataUrl(city) → URL 字符串
  //   - 格式: https://map.amap.com/service/subway?srhdata=<adcode前4位>_drw_<城市拼音>.json
  function subwayDataUrl(city) {
    var key = resolveCityKey(city) || String(city || '').toLowerCase();
    return 'https://map.amap.com/service/subway?srhdata=' + (CITY_ADCODE[key] || '') + '_drw_' + key.toLowerCase() + '.json';
  }
  // 解析高德地铁专题 JSON（公开 API）。raw 可为字符串或已 parse 对象 → 目标线路站点+官方色。
  //   - 调用方: queryAMapSubwayWeb / 本地脚本抓取后解析
  //   - 签名: parseAMapSubwayData(raw, lineNo) → {ok, city, lineNo, lineName, color, stops, count}
  //   - 返回字段: stops:[{name,lng,lat,poiid,isTransfer}]；color 为官方色 hex
  //   - 注意: 需先有 window.__SUBMETRO_DATA 对应 JSON；线未收录返回 ok:false + available 列表
  function parseAMapSubwayData(raw, lineNo) {
    var j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!j || !j.l) return { ok: false, reason: 'no_data' };
    var lines = j.l || [];
    var no = _normLineNo(lineNo);
    var match = null;
    for (var i = 0; i < lines.length; i++) {
      var ln = _normLineNo(lines[i].ln);
      if (ln === no) { match = lines[i]; break; }
    }
    if (!match) return { ok: false, reason: 'line_not_found', lineNo: no, available: lines.map(function (x) { return x.ln; }) };
    var stops = _parseSrhStops(match.st);
    return {
      ok: stops.length >= 2, city: j.s, lineNo: no,
      lineName: match.kn || match.ln, color: match.cl, stops: stops, count: stops.length
    };
  }
  // 页面 fetch srhdata（公开 API）。CORS 风险，受限环境可能失败→cors_or_net。
  //   - 调用方: 查询官方全量站点（需 CORS 环境）
  //   - 签名: queryAMapSubwayWeb(city, lineNo, opts) → Promise<{ok, ...}>
  //   - 逻辑链: subwayDataUrl → fetch → parseAMapSubwayData
  //   - 注意: 页面 fetch 受 CORS 限制，失败返回 reason='cors_or_net'；建议用本地脚本抓 JSON
  function queryAMapSubwayWeb(city, lineNo, opts) {
    opts = opts || {};
    var url = subwayDataUrl(city);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('http_' + r.status);
      return r.json();
    }).then(function (j) {
      var r = parseAMapSubwayData(j, lineNo);
      r.url = url;
      if (!r.city) r.city = city;
      return r;
    }).catch(function (e) {
      var msg = String(e && e.message || e);
      return { ok: false, reason: /Failed to fetch|NetworkError/i.test(msg) ? 'cors_or_net' : msg.slice(0, 40), url: url };
    });
  }

  // 高德 Web API v3/bus/line（公开 API，需用户 key）。单线查询含完整站点顺序+坐标。
  //   - 调用方: 用户/外部脚本提供 key 时查询单条地铁线路（备选数据源）
  //   - 签名: queryLineByBusAPI(city, lineName, key, opts) → Promise<{ok, lineName, citycode, stops, count}>
  //   - 逻辑链: 拼 v3/bus/line URL → fetch → 过滤地铁线 → 取 busstops 坐标(经 _parseCoord)
  //   - opts: 预留（当前未用，保留签名兼容）
  //   - 注意: 页面 fetch 受 CORS 限制；建议本地脚本抓 JSON 再传页面解析
  function queryLineByBusAPI(city, lineName, key, opts) {
    opts = opts || {};
    var ck = resolveCityKey(city);
    var cityName = (CITY_ALIASES[ck] && CITY_ALIASES[ck][0]) || city;
    var url = 'https://restapi.amap.com/v3/bus/line?key=' + encodeURIComponent(key || '') +
      '&city=' + encodeURIComponent(cityName) + '&name=' + encodeURIComponent(lineName || '') + '&offset=50';
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('http_' + r.status);
      return r.json();
    }).then(function (j) {
      var lines = j.buslines || [];
      var metro = lines.filter(function (l) { return /地铁/.test(l.name || ''); });
      var target = metro[0] || lines[0];
      if (!target) return { ok: false, reason: 'no_line', raw: j };
      var stops = (target.busstops || []).map(function (s) {
        var ll = _parseCoord(s.location);
        return { name: s.name, lng: ll ? ll.lng : NaN, lat: ll ? ll.lat : NaN, sequence: s.sequence };
      }).filter(function (s) { return isFinite(s.lng) && isFinite(s.lat); });
      return { ok: stops.length >= 2, lineName: target.name, citycode: target.citycode, stops: stops, count: stops.length };
    }).catch(function (e) {
      var msg = String(e && e.message || e);
      return { ok: false, reason: /Failed to fetch|NetworkError/i.test(msg) ? 'cors_or_net' : msg.slice(0, 40) };
    });
  }

  // ===== OSM 数据源（3.0 新增：与高德 queryLine 功能同步，可切换/相互验证）=====
  // OSM 查询缓存（5 分钟；key=城市|线号），供 queryLineOsm / queryOsmOverpass 秒回
  var _osmCache = {};
  // Overpass API 镜像列表（公共实例，常 504/429/超时/CORS 差异 → 需多镜像重试 + 限流保护）。
  //   - 被 queryOsmOverpass 的 _ovFetch 使用；顺序即优先度
  //   - 实测（2026-08-22）：overpass-api.de 常 504；kumi 会被 CORS 拦截(无 ACAO 头)；osm.ch 相对可用
  //   - 故 de 在前（多数可成功），kumi 在后（CORS 失败会快速跳过，不阻塞）
  var _OV_MIRRORS = [
    'https://overpass-api.de/api/interpreter?data=',
    'https://overpass.osm.ch/api/interpreter?data=',
    'https://overpass.kumi.systems/api/interpreter?data='
  ];


  // JS 版 OSM 查询工具（公开 API）：浏览器直接 fetch Overpass API（CORS 允许），
  // 替代会卡死的 Python 抓取脚本（query_osm_metro.py 已废弃删除）。串行 + 限流 + 多镜像重试 + 缓存。
  //   - 调用方: OSM 模式（无需 Python，页面内直接查询）；compareSources 可选
  //   - 签名: queryOsmOverpass(city, lineNo, opts) → Promise<{ok, city, lineNo, lineName, color,
  //            trainType, trainCars, maxSpeedKmh, stations, nodes, totalNodes, table, dataSource:'osm', osmRef, osmName, bbox}>
  //   - opts: {
  //       bbox: [lngMin,lngMax,latMin,latMax]（默认取 CITY_BOUNDS[cityKey]），
  //       network: '合肥轨道交通'（默认自动推断 city 名 + 轨道交通/地铁，可显式覆盖），
  //       ref: '1'（线号，默认取 lineNo），
  //       density / tolerance / endPadM / stepM（节点拟合，与 queryLine 一致），
  //       noCache: true 跳过缓存，
  //       delayMs: 请求间隔（默认 300，防 429 限流），maxRetry: 每镜像重试次数（默认 2），
  //       timeoutMs: 单请求超时（默认 12000），overallTimeoutMs: 整体快速失败（默认 15000）
  //     }
  //   - 逻辑链: resolveCityKey → bbox(默认 CITY_BOUNDS) → 查 rel["route"="subway"] 匹配 network+ref
  //            → 单次组合查 node(r)["railway"="station"] + way(r)["railway"="subway"] out geom
  //            → 站点按关系 member 顺序、path 按 way 几何链式拼接(chainWays)
  //            → parseOsmMetroData 标准化 → fitSegmentNodes + curvatureThin 节点 → formatLineTable → 缓存
  //   - 注意: ① Overpass 公共 API 限流(429/504) → 串行 + delayMs + 多镜像 + 重试，绝不并发轰炸
  //           ② 坐标 WGS-84（与游戏 GCJ02 不同），放置前需坐标转换；dataSource='osm'
  //           ③ 关系含正反两个方向成员（ref 相同）→ 取第一个可用（站序一致即可）
  function queryOsmOverpass(city, lineNo, opts) {
    opts = opts || {};
    var no = _normLineNo(lineNo);
    var key = resolveCityKey(city) || city;
    // 缓存（5 分钟）：key 含 bbox 防不同范围误命中
    var bbox = opts.bbox || (MT.CITY_BOUNDS && MT.CITY_BOUNDS[key]);
    var ck = 'osm|' + key + '|' + no + '|' + (bbox ? bbox.join(',') : '');
    if (!opts.noCache) { var hit = _cacheGet(_osmCache, ck); if (hit) return Promise.resolve(hit); }

    // ===== 优先使用游戏内 OSM API（2026-08-22 用户要求：优化速度，优先游戏内 osmapi）=====
    // 游戏内置 OSM 城市轨道交通数据包（OFFICIAL_TRANSIT_LOCAL_PACKS + STATION_NAMING_CITY_COUNTRY），
    // 经 stationNamingLoadCompleteCityUrbanRail(city) 从同源 www.citiesdesigners.com 加载（无 CORS/504/429）。
    // 实测：伦敦 106 cells / 新加坡 200ms / 香港 293ms——比公共 Overpass(40s+) 快 100 倍。
    // 仅国际城市有 OSM 数据（新加坡/香港/伦敦/首尔等）；国内城市服务端返回空 → 自动回退 Overpass/高德。
    //   - 签名: _queryOsmGameApi(city, key, no, opts) → {stations:[{name,lng,lat,isTransfer}], lineName} | null
    //   - 逻辑链: 检测 window.stationNamingLoadCompleteCityUrbanRail + STATION_NAMING_CITY_COUNTRY[city]
    //            → 加载全城站点(缓存) → 按 refs 匹配线号/线路名 → 去重相邻同名 → 返回有序站点
    //   - 注意: ① 站点已按线方向有序（游戏返回顺序）② refs 匹配：数字线号精确；英文名(如 Central)模糊
    //           ③ 无走向 path → 上层用站间直线插值节点（同 _queryLineLocal）④ 坐标视城市(wgs84/gcj02)
    var _queryOsmGameApi = function (city, key, no, opts) {
      var W = window;
      var loader = W.stationNamingLoadCompleteCityUrbanRail;
      var cityCountry = W.STATION_NAMING_CITY_COUNTRY;
      if (typeof loader !== 'function' || !cityCountry) return Promise.resolve(null);
      var ck2 = String(key || city || '').toLowerCase();
      var cc = cityCountry[ck2];
      if (!cc) return Promise.resolve(null); // 城市未被游戏 OSM 数据覆盖
      return loader(ck2, {}).then(function () {
        // 从缓存读站点（city:<城市>:<coordProfile>）
        var G = W.G;
        var cache = G && G._stationNamingRealUrbanRailCellCache;
        if (!cache) return null;
        var cellKey = null;
        for (var k in cache) { if (k.indexOf('city:' + ck2 + ':') === 0) { cellKey = k; break; } }
        if (!cellKey) return null;
        var all = [];
        var cells = cache[cellKey];
        for (var k2 in cells) { var arr = cells[k2]; if (Array.isArray(arr)) all = all.concat(arr); }
        if (!all.length) return null;
        // 按 refs 匹配目标线（no 为线号；国际线路常为英文名，需同时匹配）
        function matchesRef(refs, target) {
          if (!refs) return false;
          var parts = String(refs).split(/[\/;]/).map(function (x) { return x.trim(); });
          var t = String(target).trim();
          // 精确
          if (parts.indexOf(t) >= 0) return true;
          // 数字线号：t 是数字时精确匹配；t 是英文名时模糊包含
          if (/^\d+$/.test(t)) return parts.some(function (p) { return p === t; });
          return parts.some(function (p) { return p.toLowerCase() === t.toLowerCase(); });
        }
        var lineSt = all.filter(function (s) { return matchesRef(s.refs, no) || matchesRef(s.refs, opts.ref); });
        if (lineSt.length < 2) return null;
        // 过滤平台/方向/编号等非正式站名（游戏 OSM 数据含 Platform/Eastbound/纯数字 等平台节点）
        //   - 保留带中文/正式英文名的站；排除 Platform/Direction/纯数字 站名
        var badName = /platform|eastbound|westbound|northbound|southbound|^\d+$/i;
        var cleanSt = lineSt.filter(function (s) {
          var nm = s.name || s.zh || '';
          return nm && !badName.test(nm);
        });
        if (cleanSt.length < 2) return null;
        // 全局去重同名（非仅相邻——游戏返回可能穿插平台/重复），保留第一个
        var uniq = [];
        var seenName = {};
        cleanSt.forEach(function (s) {
          var nm = s.name || s.zh || '';
          if (seenName[nm]) return;
          seenName[nm] = true;
          uniq.push({ name: nm, lng: s.lng, lat: s.lat, isTransfer: !!s.isTransfer });
        });
        if (uniq.length < 2) return null;
        return { stations: uniq, lineName: (city + '地铁' + no + '号线'), dataSource: 'osm-game' };
      }).catch(function () { return null; });
    };

    // 游戏内读取 OSM 线路走向 path（2026-08-22 新增）：用 maplibre querySourceFeatures 读
    // urban_rail_lines 矢量层（游戏已加载的 pmtiles），按线路 ref/name/network 匹配，提取 LineString 走向。
    //   - 签名: _queryOsmGameLinePath(city, key, no, opts) → Promise<[[lng,lat],...] | null>
    //   - 逻辑链: 找 maplibre 的 OSM 交通 source(metro-osm-official-transit-pmtiles-*) → querySourceFeatures
    //            → 匹配 lineKey/ref/name 目标线 → 取 geometry.coordinates（LineString）
    //   - 注意: ① 仅返回当前视口内可见的线路（超出视口返回 null → 上层直线插值兜底）
    //           ② 坐标 WGS-84（OSM），与站点一致；国内城游戏用 GCJ-02 存储则同源（无需转换）
    //           ③ 匹配优先 lineKey（subway|network|ref|colour）精确，再 name/ref
    var _queryOsmGameLinePath = function (city, key, no, opts) {
      var G = window.G;
      var ml = G && G.mlMap;
      if (!ml || typeof ml.querySourceFeatures !== 'function') return Promise.resolve(null);
      try {
        // 找 OSM 官方交通 pmtiles source
        var style = ml.getStyle ? ml.getStyle() : null;
        var sources = (style && style.sources) || {};
        var osmSrcId = null;
        for (var sid in sources) {
          if (/metro-osm-official-transit-pmtiles/i.test(sid)) { osmSrcId = sid; break; }
        }
        if (!osmSrcId) return Promise.resolve(null);
        // 读线路层
        var feats = ml.querySourceFeatures(osmSrcId, { sourceLayer: 'urban_rail_lines' });
        if (!feats || !feats.length) return Promise.resolve(null);
        var tgt = String(opts.ref || no);
        var tgtLower = tgt.toLowerCase();
        var match = null;
        for (var i = 0; i < feats.length; i++) {
          var f = feats[i], p = f.properties || {};
          if (f.geometry && f.geometry.type === 'LineString') {
            // 优先 lineKey 精确（subway|network|ref|colour）
            var lk = String(p.lineKey || '');
            var lkRef = lk.split('|')[2] || '';
            if (lkRef === tgt || String(p.ref || '') === tgt || String(p.name || '').indexOf(tgt) >= 0 ||
                (p.nameZh && String(p.nameZh).indexOf(tgt) >= 0)) {
              match = f; break;
            }
          }
        }
        if (!match) return Promise.resolve(null);
        var coords = match.geometry.coordinates || [];
        if (coords.length < 2) return Promise.resolve(null);
        return Promise.resolve(coords.map(function (c) { return [c[0], c[1]]; }));
      } catch (e) { return Promise.resolve(null); }
    };

    // 尝试游戏内 OSM API（仅当 city 在 STATION_NAMING_CITY_COUNTRY 且返回站点数≥2）
    // 整体快速失败：游戏内无数据时，不让公共 Overpass 的多镜像重试拖到 25s+
    var overallMs = opts.overallTimeoutMs != null ? opts.overallTimeoutMs : 15000;
    var pipeline = _queryOsmGameApi(city, key, no, opts).then(function (g) {
      if (g && g.stations && g.stations.length >= 2) {
        var st = g.stations;
        // 尝试游戏内读取真实走向 path（querySourceFeatures urban_rail_lines 层，视口内可见才取到）
        //   - 取到则用 fitSegmentNodes+curvatureThin 拟合真实节点；否则直线插值兜底
        return _queryOsmGameLinePath(city, key, no, opts).then(function (path) {
          var nodes;
          var warn = '游戏内 OSM 数据源（国际城市，坐标 WGS-84/GCJ02 视城市';
          if (path && path.length >= 2) {
            nodes = fitSegmentNodes(st, path, { density: opts.density, tolerance: opts.tolerance, endPadM: opts.endPadM, stepM: opts.stepM });
            nodes = nodes.map(function (seg) { return curvatureThin(seg, { density: opts.density || 'standard', tolerance: opts.tolerance }); });
            warn += '，走向为游戏内真实 OSM 线路)';
          } else {
            // 直线插值兜底（无走向 path，复用 MT.straightLineNodes）
            nodes = MT.straightLineNodes(st);
            warn += '，走向为直线插值可精化)';
          }
          var spec = lineSpec(city, no);
          var palette = officialColors(city);
          var color = null;
          if (palette) { var m = matchOfficial(palette, no + '号线'); if (m) color = '#' + m.color; }
          var result = {
            ok: true, city: city, lineNo: no, lineName: g.lineName || (city + '地铁' + no + '号线'),
            color: color || '#888888', trainType: spec.trainType, trainCars: spec.trainCars, maxSpeedKmh: spec.maxSpeedKmh,
            stations: st, nodes: nodes,
            totalNodes: nodes.reduce(function (n, s) { return n + s.length; }, 0),
            warnings: [warn], dataSource: 'osm-game',
            bbox: bbox
          };
          result.table = formatLineTable(result);
          if (!opts.noCache) _cacheSet(_osmCache, ck, result);
          return result;
        });
      }
      return null; // 游戏内 API 无数据 → 回退 Overpass
    }).then(function (r) {
      if (r) return r;
      // ---- 回退：公共 Overpass API ----
      if (!bbox) return { ok: false, reason: '无该城市 bbox（opts.bbox 或 CITY_BOUNDS）且游戏内 OSM 无数据', lineNo: no, dataSource: 'osm' };
      return queryOsmOverpassViaOverpass(city, no, opts, bbox, ck);
    });
    return withTimeout(pipeline, overallMs, {
      ok: false, reason: 'OSM 查询超时（快速失败 ' + overallMs + 'ms；游戏内 OSM 无数据且 Overpass 未响应）',
      city: city, lineNo: no, dataSource: 'osm'
    });
  }

  // 公共 Overpass 回退实现（从原 queryOsmOverpass 提取）：游戏内 API 无数据时才走这里。
  //   - 签名: queryOsmOverpassViaOverpass(city, no, opts, bbox, ck) → Promise<result>
  //   - 逻辑链: 与原 queryOsmOverpass 相同（Overpass 请求/chainWays/站点过滤/投影排序）
  function queryOsmOverpassViaOverpass(city, no, opts, bbox, ck) {
    var key = resolveCityKey(city) || city;
    var delayMs = opts.delayMs != null ? opts.delayMs : 300;
    var maxRetry = opts.maxRetry != null ? opts.maxRetry : 2;
    var timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 12000;
    var _sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    function _ovFetch(query) {
      function one(mirror, attempt) {
        var url = mirror + encodeURIComponent(query);
        var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var t = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, timeoutMs) : null;
        return fetch(url, ctrl ? { signal: ctrl.signal } : {}).then(function (r) {
          if (t) clearTimeout(t);
          if (r.status === 429 || r.status >= 500) {
            var back = Math.min(6000, 800 * Math.pow(2, attempt));
            return _sleep(back).then(function () {
              if (attempt < maxRetry) return one(mirror, attempt + 1);
              return Promise.resolve(null);
            });
          }
          return r.text().then(function (txt) {
            try { var j = JSON.parse(txt); return (j && j.elements) || null; }
            catch (e) {
              return _sleep(back2(attempt)).then(function () {
                if (attempt < maxRetry) return one(mirror, attempt + 1);
                return Promise.resolve(null);
              });
            }
          });
        }).catch(function (e) { if (t) clearTimeout(t); return Promise.resolve(null); });
      }
      function back2(attempt) { return Math.min(5000, 600 * Math.pow(2, attempt)); }
      function loop(i) {
        if (i >= _OV_MIRRORS.length) return Promise.resolve(null);
        return one(_OV_MIRRORS[i], 0).then(function (el) {
          if (el) return el;
          return _sleep(delayMs).then(function () { return loop(i + 1); });
        });
      }
      return loop(0);
    }
    function _chainWays(ways) {
      if (!ways || !ways.length) return [];
      var used = new Array(ways.length).fill(false);
      function d(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
      var start = 0;
      for (var i = 1; i < ways.length; i++) if (Math.min(ways[i][0][1], ways[i][ways[i].length - 1][1]) < Math.min(ways[start][0][1], ways[start][ways[start].length - 1][1])) start = i;
      var w = ways[start].slice();
      if (w[0][1] > w[w.length - 1][1]) w = w.reverse();
      used[start] = true;
      var chain = w.slice();
      while (used.indexOf(false) >= 0) {
        var tail = chain[chain.length - 1], best = -1, bd = 1e18, rev = false;
        for (var j = 0; j < ways.length; j++) {
          if (used[j]) continue;
          var wj = ways[j];
          var dd0 = d(tail, wj[0]), dd1 = d(tail, wj[wj.length - 1]);
          if (dd0 < bd) { bd = dd0; best = j; rev = false; }
          if (dd1 < bd) { bd = dd1; best = j; rev = true; }
        }
        if (best < 0) break;
        wj = ways[best].slice();
        if (rev) wj = wj.reverse();
        if (bd < 80 / 111000.0) chain = chain.concat(wj.slice(1)); else chain = chain.concat(wj);
        used[best] = true;
      }
      return chain;
    }

    var network = opts.network;
    if (!network) {
      var cityName = (MT.CITY_ALIASES && MT.CITY_ALIASES[key]) ? MT.CITY_ALIASES[key][0] : city;
      var cands = [cityName + '轨道交通', cityName + '地铁', cityName];
      network = null;
    }
    var refQ = opts.ref || no;
    var bboxStr = bbox[2] + ',' + bbox[0] + ',' + bbox[3] + ',' + bbox[1];
    var networkCands = network ? [network] : cands;
    var queryRel = function (net) {
      return '[out:json][timeout:60];rel["route"="subway"]["network"="' + net + '"]["ref"="' + refQ + '"](' + bboxStr + ');out tags;';
    };
    return (function fetchLine() {
      function tryNet(i) {
        if (i >= networkCands.length) return Promise.resolve(null);
        var net = networkCands[i];
        return _ovFetch(queryRel(net)).then(function (rels) {
          if (!rels || !rels.length) return _sleep(delayMs).then(function () { return tryNet(i + 1); });
          var rel = rels[0];
          var rid = rel.id;
          var qWays = '[out:json][timeout:60];rel(' + rid + ');way(r)["railway"="subway"];out geom;';
          return _ovFetch(qWays).then(function (els) {
            if (!els) return _sleep(delayMs).then(function () { return tryNet(i + 1); });
            var ways = els.filter(function (e) { return e.type === 'way' && e.geometry && e.geometry.length; })
              .map(function (e) { return e.geometry.map(function (p) { return [p.lon, p.lat]; }); });
            var path = _chainWays(ways);
            if (!path.length) return _sleep(delayMs).then(function () { return tryNet(i + 1); });
            var pad = opts.pathPad != null ? opts.pathPad : 0.02;
            var minLng = 1e9, maxLng = -1e9, minLat = 1e9, maxLat = -1e9;
            path.forEach(function (p) {
              if (p[0] < minLng) minLng = p[0]; if (p[0] > maxLng) maxLng = p[0];
              if (p[1] < minLat) minLat = p[1]; if (p[1] > maxLat) maxLat = p[1];
            });
            var stBbox = (minLat - pad) + ',' + (minLng - pad) + ',' + (maxLat + pad) + ',' + (maxLng + pad);
            var qSt = '[out:json][timeout:60];node["railway"="station"](' + stBbox + ');out body;';
            return _ovFetch(qSt).then(function (snodes) {
              if (!snodes) return _sleep(delayMs).then(function () { return tryNet(i + 1); });
              var stns = snodes.filter(function (e) { return e.type === 'node'; })
                .map(function (e) { return { name: (e.tags && e.tags.name) || '', lng: e.lon, lat: e.lat }; })
                .filter(function (s) { return s.name && typeof s.lng === 'number' && isFinite(s.lng) && typeof s.lat === 'number' && isFinite(s.lat); });
              function distToPathM(lng, lat) {
                var bd = 1e18, bi = 0;
                for (var k = 0; k < path.length; k++) {
                  var dx = path[k][0] - lng, dy = path[k][1] - lat;
                  var d2 = dx * dx + dy * dy;
                  if (d2 < bd) { bd = d2; bi = k; }
                }
                return { distM: Math.sqrt(bd) * 111320, idx: bi };
              }
              var keep = [];
              var maxDist = opts.maxStationDistM != null ? opts.maxStationDistM : 500;
              stns.forEach(function (s) {
                var pr = distToPathM(s.lng, s.lat);
                if (pr.distM <= maxDist) { s._idx = pr.idx; keep.push(s); }
              });
              keep.sort(function (a, b) { return a._idx - b._idx; });
              var uniqSt = [];
              keep.forEach(function (s) { if (!uniqSt.length || uniqSt[uniqSt.length - 1].name !== s.name) uniqSt.push(s); delete s._idx; });
              if (uniqSt.length < 2) return _sleep(delayMs).then(function () { return tryNet(i + 1); });
              var raw = { ref: refQ, name: (rel.tags && (rel.tags.name || rel.tags['name:en'])) || (city + '地铁' + no + '号线'), stations: uniqSt, path: path };
              var d = parseOsmMetroData(raw);
              if (!d.ok || !d.path.length) return _sleep(delayMs).then(function () { return tryNet(i + 1); });
              return d;
            });
          });
        });
      }
      return tryNet(0);
    })().then(function (d) {
      if (!d) return { ok: false, reason: 'OSM 未查到该线（网络名/ref 不匹配或 Overpass 超时）', lineNo: no, dataSource: 'osm' };
      var spec = lineSpec(city, no);
      var palette = officialColors(city);
      var color = null;
      if (palette) { var m = matchOfficial(palette, no + '号线'); if (m) color = '#' + m.color; }
      var nodes = d.path && d.path.length >= 2 ? fitSegmentNodes(d.stations, d.path, { density: opts.density, tolerance: opts.tolerance, endPadM: opts.endPadM, stepM: opts.stepM }) : [];
      nodes = nodes.map(function (seg) { return curvatureThin(seg, { density: opts.density || 'standard', tolerance: opts.tolerance }); });
      var result = {
        ok: true, city: city, lineNo: no, lineName: d.name || (city + '地铁' + no + '号线'),
        color: color || '#888888', trainType: spec.trainType, trainCars: spec.trainCars, maxSpeedKmh: spec.maxSpeedKmh,
        stations: d.stations, nodes: nodes,
        totalNodes: nodes.reduce(function (n, s) { return n + s.length; }, 0),
        warnings: ['OSM 数据源（WGS-84，放置需坐标转换）'], dataSource: 'osm',
        osmRef: d.ref, osmName: d.name, bbox: bbox
      };
      result.table = formatLineTable(result);
      if (!opts.noCache) _cacheSet(_osmCache, ck, result);
      return result;
    });
  }

  // 解析 OSM 地铁数据（公开 API）：解析外部 OSM JSON → 站点+走向。
  //   - 调用方: queryLineOsm / queryOsmOverpass / 外部（OSM 模式传入抓取结果）
  //   - 签名: parseOsmMetroData(raw, opts?) → {ok, ref, name, stations, path, count, source:'osm'}
  //   - 数据结构: raw = {ref, name, stations:[{name,lng,lat}], path:[[lng,lat],...]}（WGS-84，Overpass/外部输出）
  //   - 逻辑链: JSON.parse → 过滤非法坐标(isFinite) → 返回站点+path
  //   - 注意: OSM 坐标为 WGS-84（与游戏 GCJ02 不同），如需放置需转换；path 为完整连续走向
  function parseOsmMetroData(raw, opts) {
    opts = opts || {};
    var d = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!d) return { ok: false, reason: 'no_data' };
    var okC = function (lng, lat) { return typeof lng === 'number' && typeof lat === 'number' && isFinite(lng) && isFinite(lat); };
    var stations = (d.stations || []).map(function (s) {
      return { name: s.name, lng: s.lng, lat: s.lat };
    }).filter(function (s) { return okC(s.lng, s.lat); });
    var path = (d.path || []).map(function (p) { return [p[0], p[1]]; })
      .filter(function (p) { return okC(p[0], p[1]); });
    return { ok: stations.length >= 2, ref: d.ref, name: d.name, stations: stations, path: path, count: stations.length, source: 'osm' };
  }

  // 完整 OSM 线路查询（公开 API）：与高德 queryLine 返回结构完全一致，支持切换与验证。
  //   - 调用方: 外部（OSM 模式，传入 parseOsmMetroData 输出或原始 OSM JSON）；
  //             页面内无需外部数据时请用 queryOsmOverpass（直接查 Overpass，免手动抓取）
  //   - 签名: queryLineOsm(city, lineNo, osmData, opts?) → Promise<{ok, city, lineNo, lineName, color,
  //            trainType, trainCars, maxSpeedKmh, stations, nodes, totalNodes, table, dataSource:'osm'}>
  //   - osmData: parseOsmMetroData 输出 或 原始 OSM JSON（自动解析）
  //   - opts: { density, tolerance, endPadM, stepM, noCache }（节点拟合，与 queryLine 一致）
  //   - 逻辑链: 缓存命中?→秒回 : parseOsmMetroData → fitSegmentNodes(节点拟合) → curvatureThin(抽稀)
  //            → formatLineTable(表格) → 缓存
  //   - 与高德同步: 返回结构 / 节点生成（fitSegmentNodes+curvatureThin）/ 配色（officialColors）/ 车型（lineSpec）完全一致
  //   - 注意: OSM 坐标为 WGS-84（与高德/游戏 GCJ02 不同），放置前需坐标转换；dataSource='osm' 供区分
  function queryLineOsm(city, lineNo, osmData, opts) {
    opts = opts || {};
    var no = _normLineNo(lineNo);
    var key = resolveCityKey(city) || city;
    // 缓存（3.0 优化）：同城市同线 5 分钟秒回，降重复重算（OSM path 点多，重算慢）
    var ck = 'osm|' + key + '|' + no;
    if (!opts.noCache) { var hit = _cacheGet(_osmCache, ck); if (hit) return Promise.resolve(hit); }
    // 自动解析：若传入原始 OSM JSON（含 stations），先 parse
    var d = (osmData && osmData.stations && osmData.stations.length) ? osmData : parseOsmMetroData(osmData, opts);
    if (!d || !d.ok) return Promise.resolve({ ok: false, reason: d && d.reason || 'osm_no_data', lineNo: no, dataSource: 'osm' });
    var spec = lineSpec(city, no);
    var palette = officialColors(city);
    var color = null;
    if (palette) { var m = matchOfficial(palette, no + '号线'); if (m) color = '#' + m.color; }
    // 节点拟合（与 queryLine 高德路径一致：fitSegmentNodes → curvatureThin）
    var nodes = d.path && d.path.length >= 2 ? fitSegmentNodes(d.stations, d.path, { density: opts.density, tolerance: opts.tolerance, endPadM: opts.endPadM, stepM: opts.stepM }) : [];
    nodes = nodes.map(function (seg) { return curvatureThin(seg, { density: opts.density || 'standard', tolerance: opts.tolerance }); });
    var result = {
      ok: true, city: city, lineNo: no, lineName: d.name || (city + '地铁' + no + '号线'),
      color: color || '#888888', trainType: spec.trainType, trainCars: spec.trainCars, maxSpeedKmh: spec.maxSpeedKmh,
      stations: d.stations, nodes: nodes,
      totalNodes: nodes.reduce(function (n, s) { return n + s.length; }, 0),
      warnings: ['OSM 数据源（WGS-84，放置需坐标转换）'], dataSource: 'osm'
    };
    result.table = formatLineTable(result);
    if (!opts.noCache) _cacheSet(_osmCache, ck, result);
    return Promise.resolve(result);
  }

  // 多数据源对比验证（公开 API）：对比 OSM / 高德(或本地内置) 站点差异，供相互验证。
  //   - 调用方: 外部（OSM vs 高德核对，确保数据一致）
  //   - 签名: compareSources(city, lineNo, osmData, opts?) → {ok, source, osmCount, amapCount, match, osmOnly, amapOnly}
  //   - opts: { localOnly: true(仅对比本地内置数据集，更快/省 token；默认 false 走高德) }
  //   - 逻辑链: queryLineOsm(OSM) vs queryLine(高德/本地) → 按站名(去'站'后缀)求差集
  //   - 注意: localOnly=true 时高德侧用 _queryLineLocal（仅内置数据，未命中则 amapCount=0 提示无数据）
  function compareSources(city, lineNo, osmData, opts) {
    opts = opts || {};
    var no = _normLineNo(lineNo);
    var key = resolveCityKey(city) || city;
    return queryLineOsm(city, no, osmData, opts).then(function (osm) {
      var amapP = opts.localOnly
        ? Promise.resolve(_queryLineLocal(city, no, {}))   // 仅内置数据（更快）
        : queryLine(city, no, { density: opts.density, tolerance: opts.tolerance });  // 走高德/本地
      return amapP.then(function (amap) {
        var norm = function (n) { return MT._normStopName(n); };
        var osmSet = {}, amapSet = {}, osmOnly = [], amapOnly = [];
        (osm.stations || []).forEach(function (s) { osmSet[norm(s.name)] = true; });
        (amap.stations || []).forEach(function (s) { amapSet[norm(s.name)] = true; });
        Object.keys(osmSet).forEach(function (k) { if (!amapSet[k]) osmOnly.push(k); });
        Object.keys(amapSet).forEach(function (k) { if (!osmSet[k]) amapOnly.push(k); });
        return {
          ok: true, source: 'osm_vs_' + (amap.dataSource || 'amap'),
          osmCount: (osm.stations || []).length, amapCount: (amap.stations || []).length,
          match: (osm.stations || []).length - osmOnly.length, osmOnly: osmOnly, amapOnly: amapOnly,
          osmDataSource: osm.dataSource, amapDataSource: amap.dataSource
        };
      });
    }).catch(function (e) { return { ok: false, reason: String(e) }; });
  }

  // ===== 坐标系统错位检测与修复（2026-08-22 新增）=====
  // 背景: 游戏内高德用 GCJ-02、OSM 用 WGS-84；切换地图（高德↔OSM）或跨数据源绘制后，
  //       线路站点坐标可能用了错误的坐标系（如 OSM WGS-84 坐标直接写入 GCJ-02 城市），
  //       导致整条线相对真实位置错位 ~500m。需检测并修复。
  // 检测原理: 对线路每个站点坐标，分别计算其在 GCJ-02 / WGS-84 两个解释下距 CITY_BOUNDS
  //          中心/范围的贴合度。若"把坐标解释为游戏原生坐标系"时贴合、解释为另一系时不贴合，
  //          说明坐标本身就是原生系（无误）；反之说明错位。更实用：把坐标经 coordToGameNative
  //          转成游戏原生系后，若多数站落入 CITY_BOUNDS 而原坐标多数不落入 → 判定错位。
  //   - 调用方: 绘制后检查 / 用户主动检测
  //   - 签名: detectOsmShift(city, lineId, opts) → {ok, city, lineId, lineName, mismatch:boolean,
  //            stationCount, insideNative, insideAsIs, detail}
  //   - opts: { lineFilter? }；lineId 可省略则遍历全部线路（返回数组）
  //   - 注意: 需游戏线路对象（G.lines）；城市无 bounds 无法判定（返回 mismatch:false）
  function detectOsmShift(city, lineId, opts) {
    opts = opts || {};
    var G = window.G;
    var lines = (G && G.lines) || [];
    var targets = lineId
      ? lines.filter(function (l) { return l.id === lineId; })
      : lines;
    if (!targets.length) return { ok: false, reason: 'line_not_found', lineId: lineId };
    var b = MT.CITY_BOUNDS && MT.CITY_BOUNDS[resolveCityKey(city)];
    if (!b) return { ok: false, reason: 'no_city_bounds', lineId: lineId };
    var cityKey = resolveCityKey(city) || city;
    var nativeWgs = MT.isWgsNativeCity(city);
    // 官方基准坐标（高德 srhdata，GCJ-02）：mt-data 已注入时用同名站坐标对比（最准）。
    //   结构 {cityKey: {l:[{st:[{n,sl}]}]}}；取同线官方站 → 同名站坐标作为 GCJ 基准
    var officialStations = null;
    var sd = window.__MT_SUBMETRO_DATA;
    if (sd && sd[cityKey] && sd[cityKey].l) {
      var no = _normLineNo((opts.ref || lineId) !== lineId ? (opts.ref || '') : '');
      var cityLines = sd[cityKey].l;
      // 无法确定线号 → 用全部官方站（仅用于同名匹配坐标对比）
      var best = null;
      cityLines.forEach(function (l0) { if (!best || (l0.st || []).length > (best.st || []).length) best = l0; });
      if (best && best.st) officialStations = _parseSrhStops(best.st);
    }
    function distM(lng1, lat1, lng2, lat2) { return MT.haversine([lng1, lat1], [lng2, lat2]); } // 委托 MT 权威（2026-11-12 去重）
    function normName(n) { return MT._normStopName(n); }
    var out = targets.map(function (l) {
      var sts = (l.stations || []).filter(function (s) { return s && s.latlng && typeof s.latlng.lng === 'number'; });
      if (!sts.length) return { ok: true, city: city, lineId: l.id, lineName: l.name, stationCount: 0, mismatch: false, detail: '无站点坐标' };
      // 检测1：与官方高德坐标对比（mt-data 已注入时）——同名站偏差若 ~500m(GCJ偏移) 且转换后贴合 → 错位
      var offDiffs = [], offConvDiffs = [], matched = 0;
      if (officialStations) {
        var offByName = {};
        officialStations.forEach(function (o) { offByName[normName(o.name)] = o; });
        sts.forEach(function (s) {
          var o = offByName[normName(s.name)];
          if (!o) return;
          matched++;
          offDiffs.push(distM(o.lng, o.lat, s.latlng.lng, s.latlng.lat));
          var conv = MT.coordToGameNative(city, s.latlng.lng, s.latlng.lat, !nativeWgs);
          offConvDiffs.push(distM(o.lng, o.lat, conv[0], conv[1]));
        });
      }
      var officialMismatch = false, byOfficial = null;
      if (matched >= 2 && offDiffs.length) {
        var avgOff = offDiffs.reduce(function (a, c) { return a + c; }, 0) / offDiffs.length;
        var avgConv = offConvDiffs.reduce(function (a, c) { return a + c; }, 0) / offConvDiffs.length;
        byOfficial = { matched: matched, avgDiffAsIsM: Math.round(avgOff), avgDiffNativeM: Math.round(avgConv) };
        // 若当前坐标与官方高德基准偏差 >150m（正确时应 <150m，同一 GCJ 坐标）→ 判错位。
        //   ⚠️ 注意：官方基准是 GCJ-02。若城市原生是 GCJ（nativeWgs=false），线路坐标应贴合官方；
        //   偏差 ~500m(GCJ 偏移量级) 说明坐标被错误地存成了 WGS-84。
        if (nativeWgs) {
          // 城市原生 WGS：官方是 GCJ。线路坐标若贴合官方(GCJ)反而错位（应 WGS）。
          // 此时转换到原生(WGS)后偏差应减小 → 用转换后偏差小判断错位
          officialMismatch = avgConv < avgOff * 0.5;
        } else {
          // 城市原生 GCJ：线路坐标应贴合官方。当前偏差大(>150m) → 错位（被存成 WGS）
          officialMismatch = avgOff > 150;
        }
      }
      // 检测2（弱）：距 bounds 中心距离（无官方数据时兜底）
      var cLng = (b[0] + b[1]) / 2, cLat = (b[2] + b[3]) / 2;
      var insideAsIs = 0, insideNative = 0, sumDAsIs = 0, sumDNative = 0;
      sts.forEach(function (s) {
        var lng = s.latlng.lng, lat = s.latlng.lat;
        if (lng >= b[0] && lng <= b[1] && lat >= b[2] && lat <= b[3]) insideAsIs++;
        sumDAsIs += distM(cLng, cLat, lng, lat);
        var conv = MT.coordToGameNative(city, lng, lat, !nativeWgs);
        if (conv[0] >= b[0] && conv[0] <= b[1] && conv[1] >= b[2] && conv[1] <= b[3]) insideNative++;
        sumDNative += distM(cLng, cLat, conv[0], conv[1]);
      });
      var avgDAsIs = sumDAsIs / sts.length, avgDNative = sumDNative / sts.length;
      var boundsMismatch = avgDAsIs > 0 && avgDNative < avgDAsIs * 0.8;
      // 综合：官方对比优先；无官方数据用 bounds 兜底；支持 opts.fromWgs 显式声明来源
      var mismatch = officialMismatch || boundsMismatch;
      if (opts.fromWgs != null) mismatch = MT.isWgsNativeCity(city) !== opts.fromWgs; // 显式声明
      var detail;
      if (byOfficial) detail = '官方高德对比：当前偏差 ' + byOfficial.avgDiffAsIsM + 'm，转换后 ' + byOfficial.avgDiffNativeM + 'm';
      else detail = '距城市中心 ' + Math.round(avgDAsIs) + 'm（转换后 ' + Math.round(avgDNative) + 'm）';
      return {
        ok: true, city: city, lineId: l.id, lineName: l.name, stationCount: sts.length,
        mismatch: mismatch, nativeWgs: nativeWgs,
        byOfficial: byOfficial, insideNative: insideNative, insideAsIs: insideAsIs,
        avgDistAsIsM: Math.round(avgDAsIs), avgDistNativeM: Math.round(avgDNative),
        firstCoord: sts[0] ? [sts[0].latlng.lng, sts[0].latlng.lat] : null,
        detail: (mismatch ? '⚠️ 检测到坐标与游戏原生坐标系不一致，可能因切换地图导致错位：' : '坐标与游戏原生坐标系一致：') + detail
      };
    });
    return lineId ? out[0] : { ok: true, city: city, checked: out.length, results: out, mismatched: out.filter(function (r) { return r.mismatch; }) };
  }

  // 修复坐标系统错位（公开 API）：把线路站点坐标统一转换到游戏原生坐标系（GCJ-02/WGS-84）。
  //   - 调用方: 检测到错位后调用；用户主动修复
  //   - 签名: fixOsmShift(city, lineId, opts) → {ok, city, lineId, lineName, fixed, stations, reason}
  //   - opts: { force:true 强制转换（不检测直接转）；lineFilter? }
  //   - 逻辑链: 可选先 detectOsmShift → 对每个站点 latlng/latlngWgs 用 coordToGameNative 转原生系
  //   - 注意: ① 直接改游戏线路对象坐标（需后续重绘刷新）② 默认仅修复 mismatch=true 的线路；
  //           ③ force=true 无条件转换（用于已知来源强制对齐）
  function fixOsmShift(city, lineId, opts) {
    opts = opts || {};
    var G = window.G;
    var lines = (G && G.lines) || [];
    var targets = lineId
      ? lines.filter(function (l) { return l.id === lineId; })
      : lines;
    if (!targets.length) return { ok: false, reason: 'line_not_found', lineId: lineId };
    var nativeWgs = MT.isWgsNativeCity(city);
    var results = [];
    targets.forEach(function (l) {
      var sts = (l.stations || []).filter(function (s) { return s && s.latlng && typeof s.latlng.lng === 'number'; });
      var fixed = 0;
      // 统一转换到游戏原生坐标系（fixOsmShift 只做转换；是否错位由 detectOsmShift 检测。
      // coordToGameNative 幂等，重复转换无副作用，故始终执行）
      sts.forEach(function (s) {
        var conv = MT.coordToGameNative(city, s.latlng.lng, s.latlng.lat, !nativeWgs);
        // 转换后若差异明显才更新（避免微小浮点）
        var dl = Math.abs(conv[0] - s.latlng.lng), dt = Math.abs(conv[1] - s.latlng.lat);
        if (dl > 0.0001 || dt > 0.0001) {
          s.latlng.lng = conv[0]; s.latlng.lat = conv[1];
          if (s.latlngWgs) { s.latlngWgs.lng = conv[0]; s.latlngWgs.lat = conv[1]; }
          fixed++;
        }
      });
      results.push({ ok: true, city: city, lineId: l.id, lineName: l.name, fixed: fixed, stations: sts.length, reason: '已转换到游戏原生坐标系(' + (nativeWgs ? 'WGS-84' : 'GCJ-02') + ')' });
    });
    return lineId ? results[0] : { ok: true, city: city, fixed: results.reduce(function (n, r) { return n + r.fixed; }, 0), results: results };
  }

  // ===== 有轨电车（并入查询功能）=====
  // 通用 5 分钟缓存（3.0 优化）：统一 _tramCache/_qCache 的过期判断。
  //   - 用法: var hit = _cacheGet(cache, key); if (hit) return ...; ... _cacheSet(cache, key, data)
  var _cacheTtl = 300000;
  function _cacheGet(cache, key) {
    var h = cache[key];
    return (h && Date.now() - h.t < _cacheTtl) ? h.data : null;
  }
  function _cacheSet(cache, key, data) { cache[key] = { t: Date.now(), data: data }; }
  // 有轨电车查询缓存（key=城市|线路名），供 queryTramLine 秒回
  var _tramCache = {};
  // 解析单个有轨电车站坐标（公开 API）。关键词：名+站 / 名+有轨电车站 / 名。
  //   - 调用方: 有轨电车线路绘制前单站定位
  //   - 签名: resolveTramCoord(city, name) → Promise<{ok, name, poiName, lng, lat, via}>
  //   - 逻辑链: 关键词依次 placeSearch → verifyTramPOI → withFallback
  //   - 注意: 有轨电车站需用 verifyTramPOI（verifyMetroPOI 不识别电车 type）
  function resolveTramCoord(city, name) {
    var keywords = [name + '站', name + '有轨电车站', name];
    var kwIdx = 0;
    function attempt() {
      if (kwIdx >= keywords.length) return Promise.resolve({ ok: false, name: name });
      var kw = keywords[kwIdx++];
      return placeSearch(city, kw, 8).then(function (r) {
        if (!r.ok || !r.pois.length) return new Promise(function (res) { setTimeout(res, 200); }).then(attempt);
        var poi = r.pois.find(function (p) { return verifyTramPOI(city, p).ok; });
        if (!poi) return new Promise(function (res) { setTimeout(res, 200); }).then(attempt);
        return { ok: true, name: name, poiName: poi.name, lng: poi.lng, lat: poi.lat, via: 'game-tram' };
      });
    }
    return withFallback(attempt, function () { return Promise.resolve({ ok: false, name: name }); }, 1);
  }
  // 查询整条有轨电车线路站点（公开 API）。POI 搜索 + 官方站名表过滤，5 分钟缓存。
  //   - 调用方: 有轨电车线路绘制
  //   - 签名: queryTramLine(city, lineName, opts) → Promise<{ok, city, lineName, stops, count}>
  //   - opts: { stations:[官方站名数组] } —— 传入则只保留目标站并按官方站序排列
  //   - 逻辑链: 多关键词(线路名变体) → placeSearch → verifyTramPOI → cleanName → (opts.stations 排序) → 缓存
  //   - 注意: ① 混入其他线站需官方站名表过滤 ② 连续调用限流→需缓存+重试 ③ 关键词间 250ms 延迟防频控
  function queryTramLine(city, lineName, opts) {
    opts = opts || {};
    var ck = (resolveCityKey(city) || city) + '|' + lineName;
    var hit = _cacheGet(_tramCache, ck);
    if (hit) return Promise.resolve(hit);
    var keywords = [lineName, lineName.replace(/号线/, '线'), '苏州有轨电车', '有轨电车'];
    var found = {}, list = [];
    function cleanName(p) {
      return String(p.name)
        .replace(/\(有轨电车站\)|（有轨电车站）$/, '')
        .replace(/\(.*?\)|（.*?）/g, '')
        .replace(/^有轨电车/, '');
    }
    function matchName(clean, official) {
      var c2 = clean.replace(/站$/, ''), o2 = official.replace(/站$/, '');
      return clean === official || c2 === official || clean === o2 || c2 === o2;
    }
    function collect(r) {
      (r.pois || []).forEach(function (p) {
        var v = verifyTramPOI(city, p);
        if (!v.ok) return;
        var nm = cleanName(p);
        if (found[nm]) return;
        found[nm] = true;
        list.push({ name: nm, lng: p.lng, lat: p.lat });
      });
    }
    function attempt(idx, retried) {
      if (idx >= keywords.length) return Promise.resolve(list);
      return placeSearch(city, keywords[idx], { pageSize: 25 }).then(function (r) {
        if (r && r.ok) collect(r);
        if ((!r || !r.pois || !r.pois.length) && !retried) {
          return new Promise(function (res) { setTimeout(res, 600); }).then(function () { return attempt(idx, true); });
        }
        return new Promise(function (res) { setTimeout(res, 250); }).then(function () { return attempt(idx + 1); });
      });
    }
    return attempt(0).then(function (stops) {
      if (opts.stations && opts.stations.length) {
        var ordered = [];
        opts.stations.forEach(function (n) {
          var hit2 = null;
          for (var i = 0; i < stops.length; i++) {
            if (stops[i].__used) continue;
            if (matchName(stops[i].name, n)) { hit2 = stops[i]; break; }
          }
          if (hit2) { hit2.__used = true; ordered.push({ name: n, lng: hit2.lng, lat: hit2.lat }); }
        });
        stops = ordered;
      }
      var result = { ok: stops.length >= 2, city: city, lineName: lineName, stops: stops, count: stops.length };
      _cacheSet(_tramCache, ck, result);
      return result;
    });
  }

  // 线路查询完整性检查（公开 API）：用本地官方全量站名表核对某线官方站序。
  //   - 调用方: queryLine（自动核对缺失区段）/ 外部
  //   - 签名: checkLineCompleteness(city, lineNo) → {ok, names, count, lineName} | {ok:false, reason}
  //   - 逻辑链: 优先内置 __MT_SUBMETRO_DATA[cityKey].l → 兜底 __SUBMETRO_DATA.l → 匹配线号(取站数最多) → 返回官方站名数组
  //   - 注意: 两种数据源结构均为 {l:[{ln,kn,st:[{n}]}]}；无数据返回 ok:false
  function checkLineCompleteness(city, lineNo) {
    var no = String(lineNo || '').replace(/号线/g, '').toUpperCase();
    var lines = null;
    // 优先内置完整数据集（3.0 新增）
    var localKey = resolveCityKey(city) || city;
    var local = window.__MT_SUBMETRO_DATA && window.__MT_SUBMETRO_DATA[localKey];
    if (local && local.l) lines = local.l;
    // 兜底旧全局 srhdata
    if (!lines) { var sd = window.__SUBMETRO_DATA; if (sd && sd.l) lines = sd.l; }
    if (!lines || !lines.length) return { ok: false, reason: 'no_subway_data' };
    var best = null;
    lines.forEach(function (l) {
      var ln = String(l.ln || '').replace(/号线/g, '').toUpperCase();
      if (ln !== no) return;
      if (!best || (l.st || []).length > (best.st || []).length) best = l;
    });
    if (!best) return { ok: false, reason: 'line_not_found', lineNo: no };
    var names = (best.st || []).map(function (s) { return String(s.n || '').replace(/站$/, ''); });
    return { ok: true, names: names, count: names.length, lineName: best.kn || best.ln };
  }

  // 查询结果转 Markdown 表格（公开 API）。站名/坐标/下段节点坐标。
  //   - 调用方: queryLine（result.table 生成）/ 展示查询结果
  //   - 签名: formatLineTable(r) → Markdown 表格字符串（r 非 ok 返回空）
  //   - 注意: r 需含 stations 与 nodes（每站下段节点数组）
  function formatLineTable(r) {
    if (!r || !r.ok) return '';
    var L = [];
    L.push('| 站名 | 坐标(lng, lat) | 节点坐标(下段) |');
    L.push('|------|----------------|----------------|');
    var st = r.stations, nodes = r.nodes || [];
    for (var i = 0; i < st.length; i++) {
      var seg = (nodes[i] || []).map(function (p) { return '(' + p[0].toFixed(5) + ',' + p[1].toFixed(5) + ')'; }).join(' ');
      L.push('| ' + st[i].name + ' | ' + st[i].lng.toFixed(6) + ', ' + st[i].lat.toFixed(6) + ' | ' + (seg || '—') + ' |');
    }
    return L.join('\n');
  }

  // ---------- 核心：查询线路（公开 API，整个工具箱入口）----------
  //   - 调用方: dialog 流程 / OD 绘制前查询 / 外部
  //   - 签名: queryLine(city, lineNo, opts) → Promise<{ok, ...}>
  //   - opts: { stationFrom, stationTo, lineFilter, density, tolerance, endPadM, stepM }（无节点数限制）
  //   - 逻辑链: 优先本地内置数据集(window.__MT_SUBMETRO_DATA) → 未命中再走高德
  //     [本地] resolveCityKey → __MT_SUBMETRO_DATA 匹配线号 → 组装 result（站间直线插值节点）
  //     [高德] resolveCityKey → endpointsOf → officialColors → lineSpec → resolveCoord → queryTransferStops
  //       → fitSegmentNodes → curvatureThin → checkLineCompleteness → formatLineTable → 缓存
  //   - 返回: { ok, city, lineNo, lineName, color, trainType, trainCars, maxSpeedKmh,
  //            stations, nodes, totalNodes, lineNames, warnings, dataSource, completeness?, table }
  //   - 注意: ① 5 分钟缓存（key 含起讫点，防环线/分段误命中）② 在建/规划线可能仅返回公交段(busFallback)
  //           ③ 本地命中 dataSource='local'（站点为官方坐标，节点为直线插值，可 K.addNodes 精化）
  //           ④ 高德路径节点需经 curvatureThin 抽稀防过密

  // 内置数据集快速查询（3.1 增强）：优先命中 window.__MT_SUBMETRO_DATA，避免高德 API（省 token/提速）。
  //   - 调用方: queryLine（优先走此，未命中返回 null 再走高德）
  //   - 签名: _queryLineLocal(city, lineNo, opts) → result | null
  //   - 逻辑链: resolveCityKey → __MT_SUBMETRO_DATA[cityKey] → l[] 匹配线号(取站数最多) → 组装 result
  //   - 数据结构: cityKey → {l:[{ln:线号,kn:线名,cl:色,status:'open'|'unopened'|'planned',
  //            st:[{n:站名,sl:"lng,lat",t:换乘}], path:[[lng,lat],...]（未开通/规划线固化走向，可选）}]}
  //   - 注意: 覆盖已开通+未开通/规划线；有固化 path（poi 瓦片解码，最高精度）时优先用作走向节点，
  //           否则站间直线插值（可 K.addNodes 精化）；按 status 提示线路状态
  function _queryLineLocal(city, lineNo, opts) {
    opts = opts || {};
    var key = resolveCityKey(city) || city;
    var no = _normLineNo(lineNo);
    var sd = window.__MT_SUBMETRO_DATA;
    var cityData = sd && sd[key];
    var cityLines = (cityData && cityData.l) || [];
    if (!cityLines.length) return null;
    var best = null;
    for (var i = 0; i < cityLines.length; i++) {
      var ln = _normLineNo(cityLines[i].ln);
      if (ln !== no) continue;
      if (!best || (cityLines[i].st || []).length > (best.st || []).length) best = cityLines[i];
    }
    if (!best) return null;
    var status = best.status || 'open';
    var warnings = [];
    var pathQuality = 'amap';
    if (status !== 'open') warnings.push('线路状态: ' + (status === 'unopened' ? '未开通/在建' : '规划中'));
    var stations = (best.st && best.st.length) ? _parseSrhStops(best.st).map(function (s) { return { name: s.name, lng: s.lng, lat: s.lat }; }) : [];
    var nodes;
    if (best.path && best.path.length) {
      // 固化走向节点（高德/OSM，最高精度）：path 单段 → 按站切分为多段（每站一段，匹配 drawLine 期望格式）
      //   2026-08-22 修复：原返回单段 [整线path] 与 drawLine 期望的多段不匹配 → 节点错乱
      nodes = fitSegmentNodes(stations, best.path, { density: opts.density, tolerance: opts.tolerance, endPadM: opts.endPadM });
      nodes = nodes.map(function (seg) { return curvatureThin(seg, { density: opts.density || 'standard', tolerance: opts.tolerance }); });
      warnings.push('走向节点已固化（' + (best.pathSrc || '高德') + '）');
    } else {
      if (stations.length < 2) return null;
      nodes = MT.straightLineNodes(stations);
      pathQuality = 'straight';
      warnings.push('内置数据集命中（官方坐标，节点为直线插值；绘制后必须 OD.rebuildNodesFromAmap 精化）');
    }
    var spec = lineSpec(city, no);
    var color = null;
    if (best.cl) color = '#' + best.cl;
    else { var palette = officialColors(city); var m = palette && matchOfficial(palette, no + '号线'); if (m) color = '#' + m.color; }
    var result = {
      ok: true, city: city, lineNo: no, lineName: best.kn || no + '号线',
      color: color || '#888888', trainType: spec.trainType, trainCars: spec.trainCars, maxSpeedKmh: spec.maxSpeedKmh,
      stations: stations, nodes: nodes,
      totalNodes: nodes.reduce(function (n, s) { return n + s.length; }, 0),
      warnings: warnings, dataSource: 'local',
      pathQuality: pathQuality, needsPath: pathQuality === 'straight'
    };
    result.table = formatLineTable(result);
    return result;
  }

  // ---------- queryLine 端点自动解析（2026-09-06：消除"端点表仅上海"限制）----------
  // 取注入 srhdata 的线列表（优先 __MT_SUBMETRO_DATA[cityKey].l，兜底旧 __SUBMETRO_DATA.l）
  function _srhLinesFor(city) {
    var key = resolveCityKey(city) || city;
    var local = window.__MT_SUBMETRO_DATA && window.__MT_SUBMETRO_DATA[key];
    if (local && local.l && local.l.length) return local.l;
    var sd = window.__SUBMETRO_DATA;
    if (sd && sd.l && sd.l.length) return sd.l;
    return null;
  }
  // 从注入 srhdata 官方站表取该线首末端点（任意城市：st[0]/st[last]，同线取站数最多者）
  function _srhEndpointsFor(city, no) {
    var lines = _srhLinesFor(city);
    if (!lines) return null;
    var best = null;
    for (var i = 0; i < lines.length; i++) {
      var ln = _normLineNo(lines[i].ln);
      if (ln !== no) continue;
      if (!best || (lines[i].st || []).length > (best.st || []).length) best = lines[i];
    }
    if (!best || !best.st || best.st.length < 2) return null;
    var first = String(best.st[0].n || '').trim(), last = String(best.st[best.st.length - 1].n || '').trim();
    if (!first || !last) return null;
    return { from: first, to: last };
  }
  // 自动 fetch 该城 srhdata 全量并缓存到 __MT_SUBMETRO_DATA[cityKey]（页面 fetch；跨域受限返回 false 静默，
  //   不阻塞调用方——调用方落回可操作错误提示跑本地脚本）
  var _autoSrhBusy = {};
  function _autoFetchSrhData(city) {
    var key = resolveCityKey(city) || city;
    if (window.__MT_SUBMETRO_DATA && window.__MT_SUBMETRO_DATA[key] && window.__MT_SUBMETRO_DATA[key].l) return Promise.resolve(true);
    if (_autoSrhBusy[key]) return _autoSrhBusy[key];
    var url = subwayDataUrl(city);
    _autoSrhBusy[key] = fetch(url)
      .then(function (r) { if (!r.ok) throw new Error('http_' + r.status); return r.json(); })
      .then(function (j) {
        if (!j || !j.l || !j.l.length) return false;
        window.__MT_SUBMETRO_DATA = window.__MT_SUBMETRO_DATA || {};
        window.__MT_SUBMETRO_DATA[key] = { s: j.s || key, l: j.l, auto: true };
        return true;
      })
      .catch(function () { return false; })
      .then(function (ok) { delete _autoSrhBusy[key]; return ok; });
    return _autoSrhBusy[key];
  }

  // 本地 srhdata 命中但无 path：用高德换乘接口取整线 path 精化节点（失败保留直线节点）。
  //   - opts.refine === false 可跳过；opts.pathTimeoutMs 默认 10000
  //   - OSM 引擎下精化后自动转 WGS-84（MT.toGameCoords）
  function _refineLocalResult(city, no, local, opts) {
    var st = local.stations || [];
    if (st.length < 2) return Promise.resolve(local);
    var a = st[0], b = st[st.length - 1];
    var filter = /^\d+$/.test(no) ? no + '号线' : no;
    var p = queryTransferStops(city, [a.lng, a.lat], [b.lng, b.lat], filter);
    return withTimeout(p, opts.pathTimeoutMs != null ? opts.pathTimeoutMs : 10000, null).then(function (qr) {
      if (!qr || !qr.ok || !qr.path || qr.path.length < 2) {
        local.warnings = (local.warnings || []).concat(['高德 path 精化失败，保留直线节点']);
        return local;
      }
      var nodes = fitSegmentNodes(st, qr.path, { density: opts.density, tolerance: opts.tolerance, endPadM: opts.endPadM });
      nodes = nodes.map(function (seg) { return curvatureThin(seg, { density: opts.density || 'standard', tolerance: opts.tolerance }); });
      var warns = (local.warnings || []).filter(function (w) { return !/直线插值/.test(w); });
      local.nodes = nodes;
      local.totalNodes = nodes.reduce(function (n, s) { return n + s.length; }, 0);
      local.pathQuality = 'amap';
      local.needsPath = false;
      local.dataSource = 'local+amap-path';
      local.warnings = warns.concat(['节点已用高德 path 精化']);
      var prof = MT.engineProfile ? MT.engineProfile() : null;
      if (prof && prof.convertAmapToGame && MT.toGameCoords) {
        var g = MT.toGameCoords(local.stations, local.nodes);
        local.stations = g.stations; local.nodes = g.nodes;
        local.dataSource = 'local+amap-path(wgs84)';
        local.warnings.push('坐标已转 WGS-84');
      }
      local.table = formatLineTable(local);
      return local;
    }).catch(function (e) {
      local.warnings = (local.warnings || []).concat(['高德 path 精化异常: ' + String(e && e.message || e)]);
      return local;
    });
  }

  // 查询缓存（同城市同线路 5 分钟内秒回；key 含起讫点防误命中）
  var _qCache = {};  // 查询缓存：同城市同线路 5 分钟内秒回（提升响应，降重复请求）
  function queryLine(city, lineNo, opts) {
    opts = opts || {};
    var key = resolveCityKey(city) || city;
    var no = _normLineNo(lineNo);
    // 非传统地铁识别（2026-08-22）：磁悬浮/机场联络线/浦江线等非纯数字线号（无"X号线"命名）
    //   → 线路名/配色匹配/线路筛不使用'号线'后缀；端点/车型从新增端点表/车型表取
    var isNonStd = no !== '' && !/^[A-Za-z]?\d+$/.test(no);
    // 缓存 key 含起讫点（2026-08-16 稳定性优化）：避免环线/分段查询命中错误缓存
    //（原 key 仅 城市|线号，不含 stationFrom/to，会导致环线反方向/支线/分段命中旧缓存返回错误数据）
    var _cf = opts.stationFrom || '', _ct = opts.stationTo || '';
    var ck = key + '|' + no + '|' + _cf + '|' + _ct;
    var hit = _cacheGet(_qCache, ck);
    if (hit) return Promise.resolve(hit);
    // 有轨电车自动识别（2026-08-22 完善）：线路名含"有轨电车"/"tram"（如 苏州有轨电车1号线），
    // 或 opts.isTram=true，走 queryTramLine（POI 搜索，地铁换乘接口查不到电车）。
    //   - 返回结构对齐 queryLine：{ok, city, lineNo, lineName, color, stations, nodes, totalNodes, dataSource:'tram'}
    //   - 节点：无走向 path → 站间直线插值
    var isTramReq = opts.isTram || /有轨电车|tram/i.test(String(lineNo));
    if (isTramReq) {
      var lineName = String(lineNo);
      var keyCk = ck + '|tram';
      return queryTramLine(city, lineName, { stations: opts.stations }).then(function (tr) {
        if (!tr.ok || tr.stops.length < 2) return { ok: false, reason: '未获取到有轨电车线路站点（' + lineName + '）', lineNo: no, city: city, dataSource: 'tram' };
        var st = tr.stops;
        // 有轨电车无走向 path，节点为站间直线插值（复用 MT.straightLineNodes）
        var nodes = MT.straightLineNodes(st);
        var spec = lineSpec(city, no);
        var palette = officialColors(city);
        var color = null;
        if (palette) { var m = matchOfficial(palette, no + '号线'); if (m) color = '#' + m.color; }
        var result = {
          ok: true, city: city, lineNo: no, lineName: lineName,
          color: color || '#888888', trainType: spec.trainType, trainCars: spec.trainCars, maxSpeedKmh: spec.maxSpeedKmh,
          stations: st, nodes: nodes,
          totalNodes: nodes.reduce(function (n, s) { return n + s.length; }, 0),
          warnings: ['有轨电车数据源（POI 搜索，节点为直线插值可精化）'], dataSource: 'tram'
        };
        result.table = formatLineTable(result);
        _cacheSet(_qCache, keyCk, result);
        return result;
      });
    }
    // 环线（2026-08-23 新增）：已知环线 → 走 queryRingLine 组装完整闭环（不逐段只回局部）
    if (MT.isRingLine && MT.isRingLine(city, no) && !_cf && !_ct) {
      return queryRingLine(city, no, opts).then(function (rr) {
        if (rr && rr.ok) _cacheSet(_qCache, ck, rr);
        return rr;
      });
    }
    // 优先本地内置数据集（3.0 新增）：整线查询未指定起讫点时直接命中，省 token/提速
    if (!_cf && !_ct) {
      var local = _queryLineLocal(city, no, opts);
      if (local) {
        var canAmapPath = (typeof window.AMap !== 'undefined') || !!(MT.webKey && MT.webKey());
        if (local.needsPath && opts.refine !== false && canAmapPath) {
          return _refineLocalResult(city, no, local, opts).then(function (r) { _cacheSet(_qCache, ck, r); return r; });
        }
        _cacheSet(_qCache, ck, local); return Promise.resolve(local);
      }
    }
    // 非标准线高德线路名映射（2026-08-22）：高德线路名 ≠ 我方线号，须映射否则 queryTransferStops 匹配不到
    //   （如 机场联络线 高德名 '市域机场线'，用 '机场联络线' 匹配失败→走 endpoint-fallback；用 '机场线' 能查到完整 7 站）
    var _nonStdFilter = { '机场联络线': '机场线', '机场线': '机场线', '市域机场线': '机场线' };
    var filter = isNonStd ? (_nonStdFilter[no] || no) : (opts.lineFilter || no + '号线');
    // ⚠️ 2026-09-06 端点解析（消除"端点表仅上海"限制）：内置端点表 → 注入 srhdata 官方站表首末
    //   （任意已注入 srhdata 的城市全通）；两者均无 → 下方自动 fetch 该城 srhdata 后取端点递归整线查询
    var ep = opts.stationFrom && opts.stationTo ? { from: opts.stationFrom, to: opts.stationTo } : (endpointsOf(city, no) || _srhEndpointsFor(city, no));

    var warnings = [];
    var palette = officialColors(city);
    var color = null;
    if (palette) {
      var m = matchOfficial(palette, isNonStd ? no : (no + '号线'));
      if (m) color = '#' + m.color; else warnings.push('官方颜色库未收录 ' + no + (isNonStd ? '' : '号线'));
    }
    var spec = lineSpec(city, no);

    // ⚠️ 2026-09-06 端点仍无 → 自动 fetch 该城 srhdata 全量（成功后端点从官方站表取，递归整线高德查询）；
    //   页面跨域受限(CORS)拉取失败时返回可操作错误（不再裸报"无内置端点表"死路）
    if (!ep && !(opts.stationFrom && opts.stationTo)) {
      return _autoFetchSrhData(city).then(function (ok) {
        var e2 = ok ? _srhEndpointsFor(city, no) : null;
        if (!e2) {
          return { ok: false, reason: '端点无法自动解析（' + (resolveCityKey(city) || city) + ' 该线未收录端点表，且页面 fetch srhdata 被跨域拦截）。请任选其一：① 先运行本地 scripts/fetch_subway_data.py ' + city + ' 注入 srhdata（推荐，一次全量后该城任意线路免起讫）② 调用时传 opts.stationFrom/stationTo（如 queryLine(\'' + city + '\',\'' + no + '\',{stationFrom:\'起站\',stationTo:\'终站\'})）③ 在 mt-core.js LINE_ENDPOINTS 补录该线端点', lineNo: no, color: color, trainType: spec.trainType, trainCars: spec.trainCars, warnings: warnings };
        }
        return queryLine(city, lineNo, { stationFrom: e2.from, stationTo: e2.to });
      });
    }
    if (!ep) return Promise.resolve({ ok: false, reason: '未提供首末站（opts.stationFrom/stationTo）且端点自动解析未命中', lineNo: no, color: color, trainType: spec.trainType, trainCars: spec.trainCars, warnings: warnings });

    return Promise.all([resolveCoord(city, ep.from), resolveCoord(city, ep.to)]).then(function (arr) {
      var f = arr[0], t = arr[1];
      if (!f.ok || !t.ok) {
        return { ok: false, reason: '端点解析失败: ' + ep.from + ' / ' + ep.to, lineNo: no, color: color, trainType: spec.trainType, trainCars: spec.trainCars };
      }
      if (f.via === 'free' || t.via === 'free') warnings.push('端点经免费 Web API 解析');
      return queryTransferStops(city, [f.lng, f.lat], [t.lng, t.lat], filter).then(function (qr) {
        if (!qr.ok || qr.stops.length < 2) {
          // 非传统地铁兜底（2026-08-22 更新：优先高德）——磁悬浮等换乘接口不返回 SUBWAY 段（busFallback）。
          //   ① 高德 POI 搜索沿线站点（queryLineStopsByPOI，去入口/出口/交叉口噪音）
          //   ② 用 queryTransferStops 的 bus path 拟合节点（贴合实际走向，如磁悬浮沿 S1 高速）
          //   ③ POI 也失败才回退端点直查（endpoint-fallback，仅两端点+直线）
          if (isNonStd) {
            return queryLineStopsByPOI(city, no, {}).then(function (p) {
              var stops = (p && p.ok && p.stops) ? p.stops.slice() : [];
              stops = stops.filter(function (s) { return !/号口|入口|出口|交叉口/.test(s.name); });
              var _seen = {}; stops = stops.filter(function (s) { if (_seen[s.name]) return false; _seen[s.name] = true; return true; });
              if (stops.length < 2) {
                // 回退端点直查（endpoint-fallback）
                return Promise.all([resolveCoord(city, ep.from), resolveCoord(city, ep.to)]).then(function (a2) {
                  var _f = a2[0], _t = a2[1];
                  if (!_f.ok || !_t.ok) return { ok: false, reason: '未获取到 ' + filter + ' 的站点（该线可能为在建/规划或高德无数据）', lineNo: no, color: color, trainType: spec.trainType, trainCars: spec.trainCars, warnings: warnings };
                  var st2 = [{ name: ep.from, lng: _f.lng, lat: _f.lat, isTransfer: false }, { name: ep.to, lng: _t.lng, lat: _t.lat, isTransfer: false }];
                  var nd2 = (MT.straightLineNodes ? MT.straightLineNodes(st2) : []) || [];
                  var r2 = { ok: true, city: city, lineNo: no, lineName: isNonStd ? ((city || '') + no) : ((city || '') + '地铁' + no + '号线'), color: color || '#888888', trainType: spec.trainType, trainCars: spec.trainCars, maxSpeedKmh: spec.maxSpeedKmh, stations: st2, nodes: nd2, totalNodes: nd2.reduce(function (n, s) { return n + s.length; }, 0), warnings: warnings.concat(['高德换乘接口未返回该线 SUBWAY 段，已用端点直查兜底（仅两端点）']), dataSource: 'endpoint-fallback' };
                  r2.table = formatLineTable(r2); _cacheSet(_qCache, ck, r2); return r2;
                });
              }
              // 用 qr.path（bus path）拟合节点，贴合实际走向
              var _path = (qr && qr.path && qr.path.length >= 2) ? qr.path : null;
              var nodes = _path ? fitSegmentNodes(stops, _path, { density: opts.density, tolerance: opts.tolerance, endPadM: opts.endPadM }) : [];
              nodes = nodes.map(function (seg) { return curvatureThin(seg, { density: opts.density || 'standard', tolerance: opts.tolerance }); });
              var totalN = nodes.reduce(function (n, s) { return n + s.length; }, 0);
              var r3 = { ok: true, city: city, lineNo: no, lineName: isNonStd ? ((city || '') + no) : ((city || '') + '地铁' + no + '号线'), color: color || '#888888', trainType: spec.trainType, trainCars: spec.trainCars, maxSpeedKmh: spec.maxSpeedKmh, stations: stops, nodes: nodes, totalNodes: totalN, warnings: warnings.concat(['高德 POI 沿线站点 + 公交 path 走向（非 SUBWAY，走向可精化）']), dataSource: 'amap-poi' };
              r3.table = formatLineTable(r3); _cacheSet(_qCache, ck, r3); return r3;
            });
          }
          return { ok: false, reason: '未获取到 ' + filter + ' 的站点（该线可能为在建/规划或高德无数据）', lineNo: no, color: color, trainType: spec.trainType, trainCars: spec.trainCars, warnings: warnings };
        }
        if (qr.lineNames && qr.lineNames.length) warnings.push('高德线路名: ' + qr.lineNames.join('、'));
        if (qr.busFallback) warnings.push('⚠️ 高德仅返回公交段（该线可能为在建/规划，非地铁段数据）');
        // 密度档位透传（opts.density: 'sparse'|'standard'|'dense'）
        // ⚠️ 2026-08 修复节点过密：fitSegmentNodes 为 40m 密集拟合（每段 20-50 个），
        //    必须再交 curvatureThin 曲率抽稀（弯道密直线疏，误差≤devM）后才返回
        var nodes = qr.path && qr.path.length >= 2 ? fitSegmentNodes(qr.stops, qr.path, { density: opts.density, tolerance: opts.tolerance, endPadM: opts.endPadM, stepM: opts.stepM }) : [];
        nodes = nodes.map(function (seg) { return curvatureThin(seg, { density: opts.density || 'standard', tolerance: opts.tolerance }); });
        var totalNodes = nodes.reduce(function (n, s) { return n + s.length; }, 0);
        var result = {
          ok: true,
          city: city, lineNo: no, lineName: isNonStd ? ((city || '') + no) : ((city || '') + '地铁' + no + '号线'),
          color: color || '#888888',
          trainType: spec.trainType, trainCars: spec.trainCars, maxSpeedKmh: spec.maxSpeedKmh,
          stations: qr.stops,
          nodes: nodes,
          totalNodes: totalNodes,
          lineNames: qr.lineNames,
          warnings: warnings,
          dataSource: (f.via === 'free' || t.via === 'free') ? 'free-web-api' : 'game-amap',
          pathQuality: 'amap', needsPath: false
        };
        // 线路查询完整性检查（2026-08-16 用户要求）：用本地 srhdata 官方全量站名表核对，
        // 若查询返回站数 < 官方站数（如 9号线只查到松江新城而漏了松江体育中心/醉白池/上海松江站），
        // 在 result.completeness 中提示缺失区段，供绘制前检查是否查询完整。
        if (window.__SUBMETRO_DATA && !isNonStd) {
          try {
            var _official = checkLineCompleteness(city, no);
            if (_official && _official.ok) {
              var _oStops = _official.names;
              // 官方与查询站名都去掉尾'站'后比较（容错 '上海松江站'/'上海松江' 差异），显示用官方原始名
              var _qRaw = (qr.stops || []).map(function (s) { return String(s.name || ''); });
              var _oKey = _oStops.map(function (n) { return n.replace(/站$/, ''); });
              var _qKey = _qRaw.map(function (n) { return n.replace(/站$/, ''); });
              var _oSet = {};
              _oKey.forEach(function (n) { _oSet[n] = true; });
              var _qSet = {};
              _qKey.forEach(function (n) { _qSet[n] = true; });
              var _missing = _oStops.filter(function (n, i) { return !_qSet[_oKey[i]]; });
              var _extra = _qRaw.filter(function (n, i) { return !_oSet[_qKey[i]]; });
              result.completeness = {
                officialCount: _oStops.length,
                queriedCount: (qr.stops || []).length, // 3.0 修复：原 v2 误用未定义 _qStops 导致完整性检查被 catch 静默失败
                complete: _missing.length === 0 && _extra.length === 0,
                missing: _missing,
                extra: _extra
              };
              if (_missing.length) warnings.push('⚠️ 线路查询不完整：官方 ' + _oStops.length + ' 站，仅查到 ' + (qr.stops || []).length + ' 站，缺失 ' + _missing.length + ' 站: ' + _missing.join('、'));
            }
          } catch (e) { /* 完整性检查失败不影响主查询 */ }
        }
        result.table = formatLineTable(result);
        _cacheSet(_qCache, ck, result);  // 缓存成功结果（5 分钟内秒回）
        return result;
      });
    });
  }

  // ---------- 环线完整闭环查询（2026-08-23 新增）----------
  //   - 调用方: queryLine（isRingLine 且未指定起讫点时走此）
  //   - 签名: queryRingLine(city, no, opts) → Promise<{ok, stations, nodes, isRing, ...}>
  //   - 逻辑链: 取官方站序（RING_STATIONS > 本地 __MT_SUBMETRO_DATA > POI+两对相对站排序）
  //     → 逐站 resolveCoord 解析坐标 → 逐段（含末站→首站闭合段）queryTransferStops 取 SUBWAY path
  //     → fitSegmentNodes + curvatureThin → 返回完整闭环 stations+nodes
  //   - 返回: { ok, city, lineNo, lineName, isRing:true, color, trainType, stations, nodes, totalNodes, warnings, dataSource }
  function queryRingLine(city, no, opts) {
    opts = opts || {};
    var k = resolveCityKey(city) || city;
    var rk = k + ':' + no;
    var palette = officialColors(city);
    var color = null;
    if (palette) { var m = matchOfficial(palette, no + '号线'); if (m) color = '#' + m.color; }
    var spec = lineSpec(city, no);
    var filter = opts.lineFilter || no + '号线';
    var warnings = [];
    function fail(reason) { return { ok: false, reason: reason, lineNo: no, color: color, trainType: spec.trainType, trainCars: spec.trainCars, warnings: warnings }; }
    function assemble(stops) {
      if (!stops || stops.length < 3) return Promise.resolve(fail('环线站点不足（' + (stops ? stops.length : 0) + '）'));
      var n = stops.length;
      var segPromises = [];
      for (var i = 0; i < n; i++) {
        (function (idx) {
          var A = stops[idx], B = stops[(idx + 1) % n];
          segPromises.push(queryTransferStops(city, [A.lng, A.lat], [B.lng, B.lat], filter).then(function (qr) {
            if (qr && qr.ok && qr.path && qr.path.length >= 2) {
              var fit = fitSegmentNodes([A, B], qr.path, { density: opts.density, tolerance: opts.tolerance, endPadM: opts.endPadM });
              var seg = (fit && fit[0]) ? fit[0] : [];
              return curvatureThin(seg, { density: opts.density || 'standard', tolerance: opts.tolerance });
            }
            return [[(A.lng + B.lng) / 2, (A.lat + B.lat) / 2]];
          }).catch(function () {
            return [[(A.lng + B.lng) / 2, (A.lat + B.lat) / 2]];
          }));
        })(i);
      }
      return Promise.all(segPromises).then(function (nodes) {
        var totalNodes = nodes.reduce(function (a, s) { return a + s.length; }, 0);
        var result = {
          ok: true, city: city, lineNo: no, lineName: (city || '') + '地铁' + no + '号线',
          isRing: true, color: color || '#888888', trainType: spec.trainType, trainCars: spec.trainCars, maxSpeedKmh: spec.maxSpeedKmh,
          stations: stops, nodes: nodes, totalNodes: totalNodes,
          lineNames: [no + '号线'], warnings: warnings.concat(['环线完整闭环（' + stops.length + '站）']),
          dataSource: 'game-amap'
        };
        result.table = formatLineTable(result);
        return result;
      });
    }
    // ① 官方站序（name 数组，按优先级取：RING_STATIONS > 本地 srhdata）
    var order = null;
    var RS = MT.RING_STATIONS || {};
    if (RS[rk] && RS[rk].length) order = RS[rk].slice();
    // 坐标表：优先本地 srhdata 官方坐标（避免逐站 resolveCoord 被限流导致环线站点缺失）
    var coordMap = {};
    var sd = window.__MT_SUBMETRO_DATA;
    var cd = sd && sd[k];
    var cl = (cd && cd.l) || [];
    var bestLocal = null;
    for (var i = 0; i < cl.length; i++) { var ln = _normLineNo(cl[i].ln); if (ln === no && (!bestLocal || (cl[i].st || []).length > (bestLocal.st || []).length)) bestLocal = cl[i]; }
    if (bestLocal && bestLocal.st) {
      bestLocal.st.forEach(function (s) {
        var c = String(s.sl || '').split(',');
        var lng = parseFloat(c[0]), lat = parseFloat(c[1]);
        // 用原始官方站名作 key（勿剥尾'站'：RING_STATIONS 与 srhdata 同为官方全名，如 上海火车站）
        if (isFinite(lng) && isFinite(lat)) coordMap[String(s.n || '')] = { lng: lng, lat: lat };
      });
    }
    if (!order && bestLocal && bestLocal.st && bestLocal.st.length) order = bestLocal.st.map(function (s) { return String(s.n || ''); });
    // ② 无官方站序 → POI + 两对相对站排序（拼接全圈）
    if (!order) {
      return MT.queryLineStopsByPOI(city, no).then(function (p) {
        var stops = (p && p.ok && p.stops) ? p.stops.slice() : [];
        if (stops.length < 3) return fail('环线 POI 站点不足');
        stops = stops.filter(function (s) { return !/号口|入口|出口|交叉口/.test(s.name); });
        var _s2 = {}; stops = stops.filter(function (s) { if (_s2[s.name]) return false; _s2[s.name] = true; return true; });
        if (stops.length < 3) return fail('环线 POI 站点不足（去重后）');
        function d(a, b2) { return MT._distM(a.lat, a.lng, b2.lat, b2.lng); }
        var ref = stops[0];
        var far1 = stops.reduce(function (a, b) { return d(b, ref) > d(a, ref) ? b : a; });
        var midLat = (ref.lat + far1.lat) / 2, midLng = (ref.lng + far1.lng) / 2;
        var far2 = stops.reduce(function (a, b) { return d(b, { lat: midLat, lng: midLng }) > d(a, { lat: midLat, lng: midLng }) ? b : a; });
        return Promise.all([
          queryTransferStops(city, [ref.lng, ref.lat], [far1.lng, far1.lat], filter),
          queryTransferStops(city, [far2.lng, far2.lat], [ref.lng, ref.lat], filter)
        ]).then(function (arr) {
          var pathA = (arr[0] && arr[0].ok) ? arr[0].path : [];
          var pathB = (arr[1] && arr[1].ok) ? arr[1].path : [];
          var fullPath = pathA.concat(pathB);
          if (fullPath.length < 2) return fail('环线全圈 path 获取失败');
          function projIdx(lat, lng) { var b = 0, bd = Infinity; for (var j = 0; j < fullPath.length; j++) { var d2 = Math.hypot((lng - fullPath[j][0]) * 111320 * Math.cos(lat * Math.PI / 180), (lat - fullPath[j][1]) * 110540); if (d2 < bd) { bd = d2; b = j; } } return b; }
          stops.sort(function (a, b2) { return projIdx(a.lat, a.lng) - projIdx(b2.lat, b2.lng); });
          return assemble(stops);
        });
      });
    }
    // ③ 有官方站序 → 解析坐标（本地 srhdata 自带坐标直接用，缺失才逐站 resolveCoord）
    var resolved = [];
    var seq = Promise.resolve();
    order.forEach(function (nm) {
      var c = coordMap[nm];
      if (c) { resolved.push({ name: nm, lng: c.lng, lat: c.lat }); return; }
      seq = seq.then(function () {
        return resolveCoord(city, nm).then(function (r) { if (r && r.ok && typeof r.lng === 'number') resolved.push({ name: nm, lng: r.lng, lat: r.lat }); return r; });
      });
    });
    return seq.then(function () { return assemble(resolved); });
  }

  // ===== 导出 =====
  // 统一 POI 搜索：公开 API
  MT.placeSearch = placeSearch;
  // 统一换乘查询：公开 API
  MT.transferSearch = transferSearch;
  // 单站坐标：公开 API
  MT.resolveCoord = resolveCoord;
  // 段查询：公开 API
  MT.queryTransferStops = queryTransferStops;
  // 在建线 POI 搜索：公开 API
  MT.queryLineStopsByPOI = queryLineStopsByPOI;
  // 环线完整闭环查询（2026-08-23 新增）：公开 API
  MT.queryRingLine = queryRingLine;
  // 清查询缓存（2026-08-23 新增）：开发/会话中清掉旧的环线缓存等。公开 API
  MT.clearQueryCache = function () { _qCache = {}; return true; };
  // 游戏线路只读：公开 API（统一共享）
  MT.getLines = getLines;
  // 找线：公开 API
  MT.findLine = findLine;
  // srhdata：公开 API
  MT.CITY_ADCODE = CITY_ADCODE;
  MT.subwayDataUrl = subwayDataUrl;
  MT.parseAMapSubwayData = parseAMapSubwayData;
  MT.queryAMapSubwayWeb = queryAMapSubwayWeb;
  // v3/bus/line：公开 API
  MT.queryLineByBusAPI = queryLineByBusAPI;
  // OSM：公开 API（解析外部 OSM JSON，供 queryLineOsm / queryOsmOverpass / 外部传入）
  MT.parseOsmMetroData = parseOsmMetroData;
  // JS 版 OSM Overpass 查询（公开 API）：浏览器直接 fetch Overpass，替代已删除的 Python 抓取脚本
  MT.queryOsmOverpass = queryOsmOverpass;
  // OSM 完整线路查询（与 queryLine 结构同步）：公开 API（传入外部 OSM 数据）
  MT.queryLineOsm = queryLineOsm;
  // OSM vs 高德/本地 对比验证：公开 API
  MT.compareSources = compareSources;
  // 坐标系统错位检测（2026-08-22 新增）：检测线路坐标是否与游戏原生坐标系错位
  MT.detectOsmShift = detectOsmShift;
  // 坐标系统错位修复（2026-08-22 新增）：批量转换线路坐标为游戏原生坐标系
  MT.fixOsmShift = fixOsmShift;
  // 有轨电车：公开 API（并入查询功能）
  MT.resolveTramCoord = resolveTramCoord;
  MT.queryTramLine = queryTramLine;
  // 未开通/在建线信息（poiTipsSearchlite 搜索提示）：公开 API（2026-08-22 新增）
  MT.queryUnopenedLine = queryUnopenedLine;
  // 解码高德 poi 瓦片几何为经纬度走向（2026-08-22 逆向成功）：公开 API
  //   - 调用方: 未开通线走向查询（poi_region_road_transit 瓦片 f3 字段）
  //   - 签名: decodeTileGeom(hex, xTile, yTile, n) → [[lng,lat],...]
  //   - 投影(等距圆柱 Plate Carrée): lng=(xTile+x/4096)*360/2^n-180; lat=90-(yTile+y/4096)*180/2^n
  //   - 几何编码: zigzag delta → 瓦片内坐标(0-4096)
  //   - 注意: hex 为瓦片内线路 f3 几何 hex；xTile/yTile/n 为瓦片编号(z=0 层级的 x_y_n)
  MT.decodeTileGeom = function (hex, xTile, yTile, n) {
    function rv(b, i) { var r = 0, s = 0; while (i < b.length) { var x = b[i++]; r |= (x & 0x7f) << s; if (!(x & 0x80)) break; s += 7; } return { v: r, i: i }; }
    function zig(v) { return (v >> 1) ^ -(v & 1); }
    var b = typeof hex === 'string' ? (hex.match(/.{1,2}/g) || []).map(function (h) { return parseInt(h, 16); }) : hex;
    var vals = [], i = 0;
    while (i < b.length) { var t = rv(b, i); vals.push(t.v); i = t.i; }
    var scale = 1 << n, out = [], cx = 0, cy = 0;
    for (var k = 0; k < vals.length - 1; k += 2) {
      cx += zig(vals[k]); cy += zig(vals[k + 1]);
      var lng = (xTile + cx / 4096) * 360 / scale - 180;
      var lat = 90 - (yTile + cy / 4096) * 180 / scale;
      out.push([lng, lat]);
    }
    return out;
  };

  // 解析高德 poi 瓦片字节，提取各线路走向并解码为经纬度（2026-08-22 自动化）。
  //   - 调用方: 未开通/在建线走向查询（自动下载瓦片后解析）
  //   - 签名: parsePoiTileForLines(tileBytes, xTile, yTile, n) → Promise<[{name, path, isUnopened},...]>
  //   - 逻辑链: gzip解压(跳4字节前缀) → protobuf解析(field1[4][5][1]features→每条线路f4→f4→f1线路名+f3几何) → decodeTileGeom
  //   - 注意: tileBytes 为瓦片响应 ArrayBuffer；xTile/yTile/n 为瓦片编号(z=0层级的 x_y_n)；isUnopened=(线路名含"在建")
  MT.parsePoiTileForLines = async function (tileBytes, xTile, yTile, n) {
    function rv(b, i) { var r = 0, s = 0; while (i < b.length) { var x = b[i++]; r |= (x & 0x7f) << s; if (!(x & 0x80)) break; s += 7; } return { v: r, i: i }; }
    function parseFields(b, s, e) { var out = [], i = s; while (i < e) { var t = rv(b, i); i = t.i; var fn = t.v >> 3, wire = t.v & 7; if (wire === 2) { var l = rv(b, i); i = l.i; out.push([fn, 'b', i, l.v]); i += l.v; } else if (wire === 0) { i = rv(b, i).i; out.push([fn, 'v']); } else if (wire === 5) { i += 4; } else if (wire === 1) { i += 8; } else break; } return out; }
    function getStr(b, o, l) { try { return new TextDecoder('utf-8').decode(b.subarray(o, o + l)); } catch (e) { return null; } }
    function collectStrs(b, s, e, out, d) { d = d || 0; var i = s; while (i < e) { var t = rv(b, i); i = t.i; var wire = t.v & 7; if (wire === 2) { var l = rv(b, i); i = l.i; if (i > e) break; var str = getStr(b, i, l.v); if (str) out.push(str); if (d < 8 && l.v > 0 && !str) collectStrs(b, i, i + l.v, out, d + 1); i += l.v; } else if (wire === 0) { i = rv(b, i).i; } else if (wire === 5) { i += 4; } else if (wire === 1) { i += 8; } else break; } }
    try {
      var buf = new Uint8Array(tileBytes);
      var data;
      try {
        var ds = new DecompressionStream('gzip');
        data = new Uint8Array(await new Response(new Blob([buf.subarray(4)]).stream().pipeThrough(ds)).arrayBuffer());
      } catch (e) { data = buf; }
      var top = parseFields(data, 0, data.length);
      var f1 = null; for (var i = 0; i < top.length; i++) if (top[i][1] === 'b') { f1 = top[i]; break; }
      if (!f1) return [];
      var inner = parseFields(data, f1[2], f1[2] + f1[3]);
      var lines = [];
      for (var b4 = 0; b4 < inner.length; b4++) {
        var blk = inner[b4];
        if (blk[1] !== 'b' || blk[0] !== 4) continue;
        var f5s = parseFields(data, blk[2], blk[2] + blk[3]);
        for (var f5i = 0; f5i < f5s.length; f5i++) {
          var f5 = f5s[f5i];
          if (f5[1] !== 'b') continue;
          var feats = parseFields(data, f5[2], f5[2] + f5[3]);
          for (var fi = 0; fi < feats.length; fi++) {
            var feat = feats[fi];
            if (feat[1] !== 'b' || feat[0] !== 1) continue;
            var strs = [];
            collectStrs(data, feat[2], feat[2] + feat[3], strs);
            if (!strs.some(function (s) { return /号线/.test(s); })) continue;
            var fof = parseFields(data, feat[2], feat[2] + feat[3]);
            for (var foi = 0; foi < fof.length; foi++) {
              var fo = fof[foi];
              if (fo[1] !== 'b' || fo[0] !== 4) continue;
              var foIn = parseFields(data, fo[2], fo[2] + fo[3]);
              for (var li = 0; li < foIn.length; li++) {
                var lf = foIn[li];
                if (lf[1] !== 'b' || lf[0] !== 4) continue;
                var lfIn = parseFields(data, lf[2], lf[2] + lf[3]);
                var name = null, geom = null;
                for (var xi = 0; xi < lfIn.length; xi++) {
                  var xf = lfIn[xi];
                  if (xf[0] === 1 && xf[1] === 'b') { var ns = []; collectStrs(data, xf[2], xf[2] + xf[3], ns); if (ns.length) name = ns[0]; }
                  if (xf[0] === 3 && xf[1] === 'b') { var hex = ''; for (var h = xf[2]; h < xf[2] + xf[3]; h++) hex += ('0' + data[h].toString(16)).slice(-2); geom = hex; }
                }
                if (geom && name) {
                  lines.push({ name: name, isUnopened: /在建/.test(name) || /Zaijian/i.test(name), path: MT.decodeTileGeom(geom, xTile, yTile, n) });
                }
              }
            }
          }
        }
      }
      return lines;
    } catch (e) { return { error: String(e) }; }
  };

  // 完整性检查：公开 API
  MT.checkLineCompleteness = checkLineCompleteness;
  // 表格输出：公开 API
  MT.formatLineTable = formatLineTable;
  // 核心查询：公开 API
  // 已知延伸站后处理：把 LINE_ENDPOINTS/官方新站补进整线结果
  function applyKnownExtensions(city, lineNo, r, opts) {
    if (!r || !r.ok || !Array.isArray(r.stations) || !r.stations.length) return r;
    var key = (resolveCityKey(city) || city) + '|' + _normLineNo(lineNo);
    var ext = (MT.KNOWN_EXTENSIONS || {})[key];
    if (!ext) return r;
    var list = [];
    (ext.head || []).forEach(function (x) { list.push({ where: 'head', name: x.name }); });
    (ext.tail || []).forEach(function (x) { list.push({ where: 'tail', name: x.name }); });
    if (!list.length) return r;
    var pending = list.map(function (x) {
      return resolveCoord(city, x.query || x.name).then(function (c) {
        if (!c || !c.ok) return null;
        return { where: x.where, name: x.name, lng: c.lng, lat: c.lat, via: c.via || 'known' };
      });
    });
    return Promise.all(pending).then(function (rows) {
      var warnings = (r.warnings || []).slice();
      rows.filter(Boolean).forEach(function (row) {
        var first = r.stations[0], last = r.stations[r.stations.length - 1];
        if (row.where === 'head') {
          if (r.stations.some(function (s) { return s.name === row.name; })) return;
          r.stations.unshift({ name: row.name, lat: row.lat, lng: row.lng, isTransfer: false, _knownExtension: true });
          r.nodes = r.nodes || [];
          r.nodes.unshift([[row.lng, row.lat], [first.lng, first.lat]]);
          warnings.push('已补known head站 ' + row.name + '（高德整线接口未收录）');
        } else {
          if (r.stations.some(function (s) { return s.name === row.name; })) return;
          r.stations.push({ name: row.name, lat: row.lat, lng: row.lng, isTransfer: false, _knownExtension: true });
          r.nodes = r.nodes || [];
          r.nodes.push([[last.lng, last.lat], [row.lng, row.lat]]);
          warnings.push('已补known tail站 ' + row.name + '（高德整线接口未收录）');
        }
      });
      r.totalNodes = (r.nodes || []).reduce(function (n, seg) { return n + seg.length; }, 0);
      try { r.table = formatLineTable(r); } catch (e) {}
      return r;
    });
  }

  // 逐段拼接走向：站点序列 → 相邻两站查询地铁 path（queryTransferStops，逐段而不是整线端点）
  //   - 未开通/数据不全的线路：整线端点查询常只返回部分区段（实测苏州8号线 28 站只回 6 站），
  //     但相邻两站的地铁 path 往往仍可用；逐段查询可补齐 22 站。
  //   - 无地铁 path 的段（真正未开通）：用 smoothLineNodes（向心 Catmull-Rom 过站）拟合，标记 estimated。
  //   - 每段都做绕路比护栏 + 站台避让；返回 segStatus: 'subway'|'spline'|'straight'。
  function _pool(items, limit, fn) {
    var i = 0, out = new Array(items.length);
    function worker() {
      if (i >= items.length) return Promise.resolve();
      var idx = i++;
      return Promise.resolve(fn(items[idx], idx)).then(function (r) { out[idx] = r; return worker(); });
    }
    var n = Math.min(limit, items.length), arr = [];
    for (var k = 0; k < n; k++) arr.push(worker());
    return Promise.all(arr).then(function () { return out; });
  }
  function _pathLen(path) {
    var s = 0;
    for (var i = 0; i < path.length - 1; i++) s += MT.haversine([path[i][0], path[i][1]], [path[i + 1][0], path[i + 1][1]]);
    return s;
  }
  var _segCache = {};
  function _segCacheKey(city, A, B, filter) {
    return (resolveCityKey(city) || city) + '|' + filter + '|' + Number(A.lng).toFixed(5) + ',' + Number(A.lat).toFixed(5) + '|' + Number(B.lng).toFixed(5) + ',' + Number(B.lat).toFixed(5);
  }
  function _stitchNodes(city, stations, opts) {
    opts = opts || {};
    var st = (stations || []).slice();
    if (st.length < 2) return Promise.resolve({ ok: false, reason: 'stations_required' });
    var filter = opts.lineFilter || '';
    var pad = opts.endPadM != null ? opts.endPadM : 100;
    var maxRatio = opts.maxRouteRatio != null ? opts.maxRouteRatio : 2.2;
    var fallback = opts.fallback || 'spline';
    var smooth = (fallback === 'straight' || !MT.smoothLineNodes) ? null : MT.smoothLineNodes(st, { endPadM: pad });
    var pairs = [];
    for (var i = 0; i < st.length - 1; i++) pairs.push({ i: i, A: st[i], B: st[i + 1] });
    var retries = opts.retries != null ? opts.retries : 2;
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    return _pool(pairs, opts.concurrency || 2, function (p) {
      var A = p.A, B = p.B;
      function attempt(n) {
        var ck = _segCacheKey(city, A, B, filter);
        var hit = !opts.noCache && _segCache[ck];
        if (hit && (Date.now() - hit.t) < 600000) {
          return Promise.resolve({ i: p.i, kind: 'subway', nodes: hit.nodes.map(function (q) { return [q[0], q[1]]; }), ratio: hit.ratio, cached: true });
        }
        return queryTransferStops(city, [A.lng, A.lat], [B.lng, B.lat], filter).then(function (qr) {
          var straight = MT.haversine([A.lng, A.lat], [B.lng, B.lat]);
          var okPath = qr && qr.ok && qr.path && qr.path.length >= 2 && !qr.busFallback;
          if (okPath && filter) {
            var names = qr.lineNames || [];
            var hitName = names.some(function (nm) { return String(nm).indexOf(filter) >= 0; });
            if (!hitName) okPath = false;
          }
          var ratio = okPath ? _pathLen(qr.path) / Math.max(1, straight) : null;
          if (okPath && straight > 300 && ratio > maxRatio) okPath = false;
          if (okPath) {
            var fit = fitSegmentNodes([A, B], qr.path, { density: opts.density, tolerance: opts.tolerance, endPadM: pad });
            var seg = (fit && fit[0]) ? fit[0] : [];
            seg = curvatureThin(seg, { density: opts.density || 'standard', tolerance: opts.tolerance });
            if (seg.length) {
              _segCache[ck] = { t: Date.now(), nodes: seg.map(function (q) { return [q[0], q[1]]; }), ratio: +ratio.toFixed(2) };
              return { i: p.i, kind: 'subway', nodes: seg, ratio: +ratio.toFixed(2) };
            }
          }
          if (n > 0) return sleep(300).then(function () { return attempt(n - 1); });
          return { i: p.i, kind: fallback, ratio: ratio == null ? null : +ratio.toFixed(2) };
        }).catch(function () {
          if (n > 0) return sleep(300).then(function () { return attempt(n - 1); });
          return { i: p.i, kind: fallback, ratio: null };
        });
      }
      return attempt(retries);
    }).then(function (rows) {
      var segs = [], kinds = [], fitted = 0, estimated = 0;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r.kind === 'subway') { segs.push(r.nodes); fitted++; }
        else {
          var seg = smooth ? smooth[i] : (fallback === 'straight' && MT.straightLineNodes ? (MT.straightLineNodes([st[i], st[i + 1]])[0] || []) : []);
          if (!seg || !seg.length) seg = [[(st[i].lng + st[i + 1].lng) / 2, (st[i].lat + st[i + 1].lat) / 2]];
          segs.push(seg); estimated++;
        }
        kinds.push({ i: i, a: st[i].name, b: st[i + 1].name, kind: r.kind, ratio: r.ratio });
      }
      var total = segs.reduce(function (n, s) { return n + s.length; }, 0);
      return {
        ok: true, stations: st, nodes: segs, segStatus: kinds,
        fitted: fitted, estimated: estimated, totalNodes: total,
        dataSource: 'segment-stitch',
        warnings: estimated ? ['有 ' + estimated + ' 段无地铁 path，已用 ' + fallback + ' 拟合（估算走向）'] : []
      };
    });
  }
  // 未开通/数据不全线路查询：站点来源优先级 opts.stations > opts.stationNames(别名解析) > 本地 srhdata 全量站表
  function queryLineBySegments(city, lineNo, opts) {
    opts = opts || {};
    var no = _normLineNo(lineNo);
    var key = resolveCityKey(city) || city;
    var spec = lineSpec(city, no);
    var color = null;
    var palette = officialColors(city);
    if (palette) { var m = matchOfficial(palette, no + '号线'); if (m) color = '#' + m.color; }
    var lineName = opts.lineName || ((city || '') + '地铁' + no + '号线');
    function finish(st, extra) {
      return _stitchNodes(city, st, { lineFilter: opts.lineFilter || (no + '号线'), density: opts.density, tolerance: opts.tolerance, endPadM: opts.endPadM, fallback: opts.fallback, maxRouteRatio: opts.maxRouteRatio, concurrency: opts.concurrency, retries: opts.retries, noCache: opts.noCache }).then(function (r) {
        if (!r.ok) return r;
        r.city = city; r.lineNo = no; r.lineName = lineName; r.color = opts.color || color || '#888888';
        r.trainType = spec.trainType; r.trainCars = opts.trainCars || spec.trainCars; r.maxSpeedKmh = spec.maxSpeedKmh;
        if (extra && extra.warnings) r.warnings = (r.warnings || []).concat(extra.warnings);
        if (extra && extra.source) r.stationSource = extra.source;
        try { r.table = formatLineTable(r); } catch (e) {}
        return r;
      });
    }
    if (opts.stations && opts.stations.length >= 2) {
      return finish(opts.stations.map(function (s) { return { name: s.name, lng: s.lng, lat: s.lat }; }), { source: 'opts.stations' });
    }
    if (opts.stationNames && opts.stationNames.length >= 2) {
      var alias = opts.alias || {};
      var pending = opts.stationNames.map(function (name) {
        return resolveCoord(city, alias[name] || name).then(function (c) {
          if (!c || !c.ok) return { name: name, missing: true };
          return { name: name, lng: c.lng, lat: c.lat };
        });
      });
      return Promise.all(pending).then(function (rows) {
        var missing = rows.filter(function (x) { return x.missing; }).map(function (x) { return x.name; });
        var st = rows.filter(function (x) { return !x.missing; });
        if (st.length < 2) return { ok: false, reason: '站点解析不足: ' + missing.join('、') };
        return finish(st, { source: 'stationNames', warnings: missing.length ? ['缺站: ' + missing.join('、')] : [] });
      });
    }
    var lines = _srhLinesFor(city);
    if (lines) {
      var best = null;
      for (var i = 0; i < lines.length; i++) {
        if (_normLineNo(lines[i].ln) !== no) continue;
        if (!best || ((lines[i].st || []).length > (best.st || []).length)) best = lines[i];
      }
      if (best && best.st && best.st.length >= 2) {
        var st2 = _parseSrhStops(best.st).map(function (s) { return { name: s.name, lng: s.lng, lat: s.lat }; });
        if (best.kn) lineName = (city === '苏州' || /苏州/.test(city) ? '苏州轨道交通' : (city || '') + '地铁') + no + '号线';
        return finish(st2, { source: 'srhdata:local' });
      }
    }
    return Promise.resolve({ ok: false, reason: '无站点来源：请传 opts.stations / opts.stationNames，或先注入该城 srhdata' });
  }
  MT.queryLineBySegments = queryLineBySegments;

  // 在建线路位置读取：官方站序 + POI 坐标 + 逐段地铁 path（缺失段样条拟合）
  // stationNames = 官方顺序站名数组；opts.alias = {官方名: POI查询名}
  // opts.fallback: 'spline'（默认）|'straight'；opts.lineFilter 建议传线号。
  function queryConstructionLine(city, stationNames, opts) {
    opts = opts || {};
    var names = (stationNames || []).slice();
    if (!names.length) return Promise.resolve({ ok: false, reason: 'stationNames required' });
    var alias = opts.alias || {};
    var pending = names.map(function (name) {
      return resolveCoord(city, alias[name] || name).then(function (c) {
        if (!c || !c.ok) return { name: name, missing: true };
        return { name: name, lat: c.lat, lng: c.lng, via: c.via || 'poi' };
      });
    });
    return Promise.all(pending).then(function (rows) {
      var missing = rows.filter(function (x) { return x.missing; }).map(function (x) { return x.name; });
      var st = rows.filter(function (x) { return !x.missing; });
      if (opts.order === 'nearest' && st.length > 2) {
        var rest = st.slice(1), out = [st[0]];
        while (rest.length) {
          var last = out[out.length - 1], best = 0, bd = Infinity;
          rest.forEach(function (x, i) {
            var d = MT.haversine([last.lng, last.lat], [x.lng, x.lat]);
            if (d < bd) { bd = d; best = i; }
          });
          out.push(rest.splice(best, 1)[0]);
        }
        st = out;
      }
      return _stitchNodes(city, st, { lineFilter: opts.lineFilter, density: opts.density, tolerance: opts.tolerance, endPadM: opts.endPadM, fallback: opts.fallback, maxRouteRatio: opts.maxRouteRatio, concurrency: opts.concurrency, retries: opts.retries, noCache: opts.noCache }).then(function (r) {
        r.city = city; r.lineName = opts.lineName || '';
        r.missing = missing; r.dataSource = 'construction-segment-stitch';
        if (missing.length) r.warnings = (r.warnings || []).concat(['在建线缺站: ' + missing.join('、')]);
        return r;
      });
    });
  }
  MT.queryConstructionLine = queryConstructionLine;

  var _rawQueryLine = queryLine;
  MT.queryLine = function (city, lineNo, opts) {
    return _rawQueryLine(city, lineNo, opts).then(function (r) { return applyKnownExtensions(city, lineNo, r, opts); });
  };
  MT.__amapVersion = '6.5.3';
})();
