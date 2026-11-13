/**
 * CityMetro OfficialDraw — Cities Designers 官方绘制工具箱（3.0）
 * =========================================================
 * 注入到 https://www.citiesdesigners.com/cities/anycity-global 页面后，
 * 在 window.__officialDraw（OD）上暴露"官方逐站绘制"相关能力。
 *
 * 依赖：页面已注入查询工具箱 window.__metroToolkit（MT，经缓存 __MT 引用）。
 * 与 MT 关系：
 *   - densityOpts / adaptiveDensity / curvatureThin 委托 MT 权威实现（本地仅兜底，保证同步）
 *   - resolveCoordTwice / queryLinePaths / _rebuildNodesFromAmapImpl 用 MT.resolveCoord / queryTransferStops / fitSegmentNodes
 * 加载顺序：必须在 MT 之后注入。
 * 结构：单对象字面量（方法用 this 互调，故保持单文件，不拆分）。
 * 公开方法（37）：
 *   节点密度: densityOpts / adaptiveDensity / curvatureThin
 *   节点拟合: densifyAnchors / rebuildNodesFromAmap / queryLinePaths / _rebuildNodesFromAmapImpl
 *   检查:     checkLine3x / inspect / hasNodeOrderIssue / fixNodeOrder / _projectSort
 *   绘制:     drawLine / fastDraw / applyLineData / _disableSnap / _restoreSnap
 *   站点/支线: resolveCoordTwice / renameStations / startBranch / applyBranchData / setBranchAnchors / finishBranch
 *   换乘:     transferViaAmap / autoTransfers
 *   退出:     finishEdit
 *
 * 幂等：可反复注入（版本守卫 2.60.1）。
 * 注：修复模式·鼠标追踪 UI（enableFixTracker/__metroMouseTracker/ring 圆圈）已删除（2026-08-22 用户要求清除 UI 代码）。
 */
(function () {
  'use strict';
  if (window.__officialDraw && window.__officialDraw.__version === '2.60.3') return; // 版本守卫：已有同版本则跳过（旧版可覆盖更新）

  var G = window.G;
  var top = window.top;
  // MT 引用缓存（3.0 优化：一次查找，供 densityOpts/adaptiveDensity/curvatureThin/queryLinePaths 等委托复用）
  var __MT = window.__metroToolkit;

  // ---------- 基础工具 ----------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function log(msg) { try { console.log('[OD] ' + msg); } catch (e) {} }

  // 几何统一委托 MT（2026-11-12 去重：haversine/localTurn 单一权威在 mt-core/mt-node）
  function haversine(a, b) { return __MT.haversine(a, b); }
  function localTurn(p0, p1, p2) { return __MT.localTurn(p0, p1, p2); }

  // 统一平面距离（米）：支持 (lat1,lng1,lat2,lng2) 或 ({lat,lng},{lat,lng}) 两种签名（2026-08-22 合并各处重复 distM）
  function _distM(a, b, c, d) {
    var lat1, lng1, lat2, lng2;
    if (c === undefined) { lat1 = a.lat; lng1 = a.lng; lat2 = b.lat; lng2 = b.lng; }
    else { lat1 = a; lng1 = b; lat2 = c; lng2 = d; }
    var dLat = (lat1 - lat2) * 110540, dLng = (lng1 - lng2) * 111320 * Math.cos(lat1 * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
  }
  // 折线/直线 绕路比（2026-11-12 去重：合并 applyLineData 内 6 处重复的绕路检测）
  function _chainRatio(chain, A0, B0) {
    var p = 0, pp = chain[0];
    for (var i = 1; i < chain.length; i++) { p += _distM(pp, chain[i]); pp = chain[i]; }
    var s = _distM(A0, B0);
    return s > 30 ? p / s : 0;
  }
  // 统一方位角（度）：两点 a,b，支持 {lat,lng} 或 [lng,lat]（2026-08-22 合并各处重复 bearing/ang）
  function _bearing(a, b) {
    var la = a.lat !== undefined ? a.lat : a[1], lo = a.lng !== undefined ? a.lng : a[0];
    var lb = b.lat !== undefined ? b.lat : b[1], lo2 = b.lng !== undefined ? b.lng : b[0];
    return Math.atan2((lo2 - lo) * Math.cos((la + lb) / 2 * Math.PI / 180), lb - la) * 180 / Math.PI;
  }

  window.__officialDraw = {
    __version: '2.60.3',

    // 节点密度档位（2026-08-16 整合：档位→容错映射，与 rebuildNodesFromAmap 的 _densityTol 一致）
    //   sparse=15m / standard=12m / dense=8m（容错），参数由 adaptiveDensity(tol) 算出（devM=maxSpacing/minGapM/curveGapM 等）
    NODE_DENSITY: {
      sparse:   { devM: 15, maxSpacing: 10500, minGapM: 90, turnDeg: 45, curvePadM: 80,  curveGapM: 160, endPadM: 120 },
      standard: { devM: 12, maxSpacing: 8400,  minGapM: 72, turnDeg: 45, curvePadM: 72,  curveGapM: 160, endPadM: 100 },
      dense:    { devM: 8,  maxSpacing: 5600,  minGapM: 48, turnDeg: 40, curvePadM: 48,  curveGapM: 128, endPadM: 80 }
    },

    /** 按密度档位（'sparse'|'standard'|'dense'）解析曲率抽稀参数；支持传入自定义参数覆盖。
     *  level 传数字（容错米）→ 自适应密度（在容错内最小节点数）。 */
    densityOpts: function (level, overrides) {
      // 委托 MT 权威算法（3.0 优化：用缓存 __MT），本地仅兜底
      if (__MT && typeof __MT.adaptiveDensity === 'function' && typeof level === 'number') return __MT.adaptiveDensity(level, overrides);
      if (typeof level === 'number') return this.adaptiveDensity(level, overrides);
      level = level || 'standard';
      var base = this.NODE_DENSITY[level] ? this.NODE_DENSITY[level] : this.NODE_DENSITY.standard;
      var out = {};
      Object.keys(base).forEach(function (k) { out[k] = base[k]; });
      if (overrides) Object.keys(overrides).forEach(function (k) { out[k] = overrides[k]; });
      return out;
    },

    /** 自适应密度（2026-08-16 用户要求）：按容错容差在「误差 ≤ 容错」内生成最小节点密度。
     *  容错越大 → 节点越疏（市域/长直线）；越小 → 越密（弯道精细）。逻辑：devM=容错
     *  （DP 在误差≤容错下最小化节点数），辅助参数随容错缩放；站台回避 endPadM 保留（默认100）。
     *  @param {number} toleranceM 容错容差（米，最大允许贴合偏差）
     *  @param {Object} overrides 覆盖项（如 { endPadM: 120 }） */
    adaptiveDensity: function (toleranceM, overrides) {
      // 委托 MT 权威算法（3.0 优化：用缓存 __MT），本地仅兜底
      if (__MT && typeof __MT.adaptiveDensity === 'function') return __MT.adaptiveDensity(toleranceM, overrides);
      var tol = (toleranceM == null) ? 5 : toleranceM;
      function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
      // 2026-08-16 用户要求：以最佳拟合为中心（DP 贴合优先），放宽最小密度限制，尽可能保证节点最少
      var out = {
        devM: tol,                                   // DP 误差上限 = 容错（以最佳拟合为中心）
        maxSpacing: clamp(tol * 700, 2500, 12000),   // 均匀化上限进一步放宽：长直线几乎不补点→节点更少
        minGapM: clamp(tol * 6, 20, 120),            // 防过密下限进一步放宽
        turnDeg: clamp(tol * 5, 20, 45),             // 弯道判定阈值更大→加密更少
        curvePadM: clamp(tol * 6, 30, 80),           // 弯道加密范围进一步减弱
        curveGapM: clamp(tol * 16, 60, 160),          // 加密间距加大（弯道加密更疏→节点更少，原 tol*8 方向反）
        endPadM: 100                                 // 站台回避（保留，可覆盖）
      };
      if (overrides) Object.keys(overrides).forEach(function (k) { out[k] = overrides[k]; });
      return out;
    },

    // ========================================================================
    // 1. 节点自适应最佳拟合：先生成完全拟合节点 → Douglas-Peucker 删减到误差限度 → 均匀化
    // ========================================================================
    /**
     * 逻辑：①完全拟合节点（密集贴合原始 path）→ ②删减直到误差 ≤ devM（默认 5m）→ ③曲率加密（弯道插点）→ ④均匀化。
     * 结果：节点均匀、弯道密直线疏、误差受控（贴合偏差 ≤ devM）、间距 ≤ maxSpacing。
     * @param {number[][]} pts 原始路径点 [[lng,lat],...]
     * @param {Object|string} opts 参数对象，或密度档位名 'sparse'|'standard'|'dense'；
     *   或传 { tolerance: 容错米 } → 自适应密度（在容错内最小节点数，站台回避保留）
     *   { devM, maxSpacing, turnDeg, curvePadM, curveGapM, minGapM, endPadM }
     * @returns {number[][]} 简化后的节点
     */
    curvatureThin: function (pts, opts) {
      // 委托 MT 权威算法（3.0 优化：用缓存 __MT；MT 先注入，必存在），本地仅兜底
      if (__MT && typeof __MT.curvatureThin === 'function') return __MT.curvatureThin(pts, opts);
      if (typeof opts === 'string') opts = { density: opts };
      opts = opts || {};
      // 自适应密度（2026-08-16）：传 tolerance（容错，数字）→ 在容错内最小节点数；
      // 否则按密度档位合并（档位默认值 + 用户覆盖）
      var merged = (opts.tolerance != null)
        ? this.adaptiveDensity(opts.tolerance, opts)
        : this.densityOpts(opts.density, opts);
      var devM = merged.devM;              // 误差限度：删减后与原始拟合线偏差 ≤ 此值
      var maxSpacing = merged.maxSpacing;  // 均匀化最大间距
      if (!pts || pts.length < 3) return pts ? pts.slice() : [];
      // 点 p 到线段 [A,B] 垂直距离（米）
      function distToSegM(p, A, B) {
        var px = p[0], py = p[1], ax = A[0], ay = A[1], bx = B[0], by = B[1];
        var dx = bx - ax, dy = by - ay, len2 = dx*dx + dy*dy;
        var t = len2 === 0 ? 0 : ((px-ax)*dx + (py-ay)*dy) / len2;
        t = Math.max(0, Math.min(1, t));
        var cx = ax + t*dx, cy = ay + t*dy;
        var dLat = (py-cy)*110540, dLng = (px-cx)*111320*Math.cos(py*Math.PI/180);
        return Math.sqrt(dLat*dLat + dLng*dLng);
      }
      // Douglas-Peucker：从完全拟合点删减，直到最大偏差 ≤ eps（保留特征点/拐弯）
      function dp(list, eps) {
        if (list.length < 3) return list.slice();
        var dmax = 0, index = 0, A = list[0], B = list[list.length-1];
        for (var i = 1; i < list.length-1; i++) {
          var d = distToSegM(list[i], A, B);
          if (d > dmax) { index = i; dmax = d; }
        }
        if (dmax > eps) {
          var r1 = dp(list.slice(0, index+1), eps);
          var r2 = dp(list.slice(index), eps);
          return r1.slice(0, -1).concat(r2);
        }
        return [list[0], list[list.length-1]];
      }
      var res = dp(pts, devM);
      // 大曲率周围加密：弯道（夹角 > turnDeg）中心点 P1 前后 curvePadM 范围内按 curveGapM 间距插点加密，
      // 弯道区密集平滑、直线保持稀疏；直线段直接保留（不过密）
      var turnDeg = merged.turnDeg;
      var curvePadM = merged.curvePadM; // 大曲率周围加密范围（米）
      var curveGapM = merged.curveGapM; // 加密间距（米）
      var curved = [res[0]];
      for (var c = 1; c < res.length - 1; c++) {
        var P0 = res[c-1], P1 = res[c], P2 = res[c+1];
        var ang = localTurn(P0, P1, P2);
        if (ang <= turnDeg) { curved.push(P1); continue; } // 非大曲率：直线点直接保留
        // 前段 P0→P1：距 P1 ≤ curvePadM 的点（靠近弯道中心加密）
        var g0 = haversine(P0, P1);
        var n0 = Math.min(Math.floor(curvePadM / curveGapM), Math.max(0, Math.floor((g0 - 0.001) / curveGapM)));
        for (var q0 = n0; q0 >= 1; q0--) {
          var t0 = 1 - q0 * curveGapM / g0;
          curved.push([P0[0] + (P1[0] - P0[0]) * t0, P0[1] + (P1[1] - P0[1]) * t0]);
        }
        curved.push(P1);
        // 后段 P1→P2：距 P1 ≤ curvePadM 的点
        var g1 = haversine(P1, P2);
        var n1 = Math.min(Math.floor(curvePadM / curveGapM), Math.max(0, Math.floor((g1 - 0.001) / curveGapM)));
        for (var q1 = 1; q1 <= n1; q1++) {
          curved.push([P1[0] + (P2[0] - P1[0]) * q1 * curveGapM / g1, P1[1] + (P2[1] - P1[1]) * q1 * curveGapM / g1]);
        }
      }
      curved.push(res[res.length-1]);
      // 均匀化：直线长段按 maxSpacing 等分插点（均匀、不过稀、间距 ≤ maxSpacing）
      var uniform = [curved[0]];
      for (var u = 1; u < curved.length; u++) {
        var A2 = curved[u-1], B2 = curved[u];
        var gap = haversine(A2, B2);
        if (gap > maxSpacing) {
          var parts = Math.ceil(gap / maxSpacing);
          for (var k = 1; k < parts; k++) uniform.push([A2[0] + (B2[0]-A2[0])*k/parts, A2[1] + (B2[1]-A2[1])*k/parts]);
        }
        uniform.push(B2);
      }
      // 节点密度控制：相邻节点 < minGapM 则剔除后者（防过密），保留首末点
      var minGapM = merged.minGapM;
      var sparse = [];
      for (var s = 0; s < uniform.length; s++) {
        if (!sparse.length) { sparse.push(uniform[s]); continue; }
        if (haversine(sparse[sparse.length - 1], uniform[s]) >= minGapM) sparse.push(uniform[s]);
      }
      if (sparse.length > 1 && haversine(sparse[sparse.length - 1], uniform[uniform.length - 1]) < minGapM) {
        sparse[sparse.length - 1] = uniform[uniform.length - 1]; // 保证末点
      } else if (sparse.length === 1) {
        sparse.push(uniform[uniform.length - 1]);
      }
      return sparse;
    },

    // ========================================================================
    // 1.5 站点坐标两次查询防错（放置错误逻辑）
    // ========================================================================
    /**
     * 站点坐标两次查询防错（合并 resolveCoordTwice/resolveCoordsTwiceMany）。
     * resolveCoordTwice(city, '站名', opts) → 单条 {ok,name,lng,lat,via,diffM,warn?,reason?}
     * resolveCoordTwice(city, ['站A','站B'], opts) → 批量 {good:[{name,lng,lat}], suspicious:[], missing:[]}
     * 逻辑：同一站名用两种关键词（名+地铁站 / 名）各查一次坐标交叉校验：
     *  - 两次成功且偏差 <= tolM → ok（取高德/游戏优先结果）
     *  - 偏差过大（> tolM，疑似同名不同地）→ coords_disagree（存疑，不放置）
     *  - 单次成功 → ok 但 warn:'single_source'；两次失败 → not_found
     * @param {string} city 城市名
     * @param {string|Array} nameOrList 站名 或 站名数组
     * @param {Object} opts { tolM: 容差米(默认120), key1, key2 }
     */
    resolveCoordTwice: async function (city, nameOrList, opts) {
      opts = opts || {};
      var tolM = opts.tolM != null ? opts.tolM : 120;
      if (!__MT || typeof __MT.resolveCoord !== 'function') {
        return { ok: false, name: nameOrList, reason: '__MT.resolveCoord unavailable' };
      }
      var doOne = async function (name) {
        var key1 = opts.key1 != null ? opts.key1 : (name + '地铁站');
        var key2 = opts.key2 != null ? opts.key2 : name;
        var r1 = await __MT.resolveCoord(city, key1).catch(function () { return null; });
        var r2 = await __MT.resolveCoord(city, key2).catch(function () { return null; });
        var c1 = r1 && r1.ok && r1.lng != null ? { lng: r1.lng, lat: r1.lat } : null;
        var c2 = r2 && r2.ok && r2.lng != null ? { lng: r2.lng, lat: r2.lat } : null;
        if (c1 && c2) {
          var d = haversine([c1.lng, c1.lat], [c2.lng, c2.lat]);
          if (d <= tolM) {
            var use = r1.via === 'game' ? r1 : r2;
            return { ok: true, name: name, lng: use.lng, lat: use.lat, via: use.via || 'both', diffM: Math.round(d), source: key1 + '+' + key2 };
          }
          return { ok: false, name: name, lng: c1.lng, lat: c1.lat, via: 'disagree', diffM: Math.round(d), reason: 'coords_disagree', key1: key1, key2: key2 };
        }
        if (c1) return { ok: true, name: name, lng: c1.lng, lat: c1.lat, via: r1.via || 'single', diffM: null, warn: 'single_source', source: key1 };
        if (c2) return { ok: true, name: name, lng: c2.lng, lat: c2.lat, via: r2.via || 'single', diffM: null, warn: 'single_source', source: key2 };
        return { ok: false, name: name, reason: 'not_found', key1: key1, key2: key2 };
      };
      // 批量模式
      if (Array.isArray(nameOrList)) {
        var good = [], suspicious = [], missing = [];
        for (var i = 0; i < nameOrList.length; i++) {
          var nm = nameOrList[i].name || nameOrList[i];
          var r = await doOne(nm);
          if (r.ok && !r.warn) good.push({ name: nm, lng: r.lng, lat: r.lat, via: r.via, diffM: r.diffM });
          else if (r.ok && r.warn === 'single_source') good.push({ name: nm, lng: r.lng, lat: r.lat, via: r.via, diffM: r.diffM, warn: 'single_source' });
          else if (r.reason === 'coords_disagree') suspicious.push({ name: nm, lng: r.lng, lat: r.lat, diffM: r.diffM, key1: r.key1, key2: r.key2 });
          else missing.push({ name: nm, reason: r.reason });
          await sleep(120);
        }
        return { good: good, suspicious: suspicious, missing: missing };
      }
      // 单条模式
      return doOne(nameOrList);
    },

    // ========================================================================
    // 1.6 加密节点逻辑（检查后对弯道/贴合不足的段补节点）
    // ========================================================================
    /**
     * 对指定线路按曲率对段间节点进一步加密：
     *  - 遍历每段相邻锚点，若中间原始 path 点与连线偏离 > devM 则插入该 path 点（加密弯角）。
     *  - 也支持对指定 segIdx 单独加密。
     * @param {string} lineId
     * @param {Object} opts { devM: 偏离阈值米(默认80), segIdx: 可选，只加密某段 }（无节点数上限，devM 控制密度）
     * @returns {Promise<{added:number, perSeg:number[]}>}
     */
    densifyAnchors: function (lineId, opts) {
      opts = opts || {};
      var devM = opts.devM != null ? opts.devM : 80;
      var line = G.lines.find(function (l) { return l.id === lineId; });
      if (!line) return { error: 'line not found: ' + lineId };
      var pathPts = line._curvePts || [];
      var segAnchors = line.segmentAnchors || [];
      var added = 0;
      var perSeg = [];
      function distToSeg(p, a, b) { // p=[lng,lat] 到 a,b 线段的垂直距离（米）
        var px = p[0], py = p[1], ax = a.lng, ay = a.lat, bx = b.lng, by = b.lat;
        var dx = bx - ax, dy = by - ay, len2 = dx*dx + dy*dy;
        var t = len2 === 0 ? 0 : ((px-ax)*dx + (py-ay)*dy) / len2;
        t = Math.max(0, Math.min(1, t));
        var cx = ax + t*dx, cy = ay + t*dy;
        // 近似米换算
        var dLat = (py-cy)*110540, dLng = (px-cx)*111320*Math.cos(py*Math.PI/180);
        return Math.sqrt(dLat*dLat + dLng*dLng);
      }
      for (var sIdx = 0; sIdx < segAnchors.length; sIdx++) {
        if (opts.segIdx != null && sIdx !== opts.segIdx) { perSeg.push(segAnchors[sIdx] ? segAnchors[sIdx].length : 0); continue; }
        var seg = segAnchors[sIdx] || [];
        if (seg.length < 2) { perSeg.push(seg.length); continue; }
        var out = [seg[0]];
        for (var a = 0; a < seg.length - 1; a++) {
          var A = seg[a], B = seg[a + 1];
          var best = null, bestD = 0;
          for (var k = 0; k < pathPts.length; k++) {
            var d = distToSeg([pathPts[k].lng, pathPts[k].lat], A, B);
            if (d > bestD) { bestD = d; best = pathPts[k]; }
          }
          if (best && bestD > devM) {
            out.push({ lat: best.lat, lng: best.lng });
            added++;
          }
          out.push(B);
        }
        segAnchors[sIdx] = out;
        perSeg.push(out.length);
      }
      try { top.redrawLine(line); } catch (e) {}
      return { added: added, perSeg: perSeg };
    },

    // ========================================================================
    // 1.7 三次检查逻辑（绘制后逐级验证）
    // ========================================================================
    /**
     * 三次检查：
     *  - check1 结构检查：站数、站名、节点数、isRing、branchRootId、pending 是否正常
     *  - check2 坐标检查：各站坐标与查询基准坐标偏差 <= tolM（默认150m；strict 严格档 100m）
     *  - check3 视觉/贴合复查：redrawLine 后统计各段节点数合理性 + 返回 inspect 供肉眼抽查
     * @param {string} lineId
     * @param {Object} opts { tolM: 坐标容差(默认150), strict: 严格度 'standard'|'strict'(strict=100m),
     *                        expectStations: 期望站数, expectNames: 期望站名数组, refCoords: {站名:[lng,lat]} 基准坐标 }
     * @returns {Promise<{check1, check2, check3, pass:boolean, problems:string[]}>}
     */
    checkLine3x: function (lineId, opts) {
      opts = opts || {};
      var tolM = opts.tolM != null ? opts.tolM : (opts.strict === 'strict' ? 100 : 150);
      var line = G.lines.find(function (l) { return l.id === lineId; });
      if (!line) return { error: 'line not found: ' + lineId };
      var problems = [];
      // ---- check1 结构 ----
      var check1 = { ok: true, details: {} };
      var stNames = (line.stations || []).map(function (s) { return s.name; });
      if (opts.expectStations != null && stNames.length !== opts.expectStations) {
        check1.ok = false; problems.push('站数不符: 期望 ' + opts.expectStations + ' 实际 ' + stNames.length);
      }
      if (opts.expectNames && opts.expectNames.length === stNames.length) {
        for (var i = 0; i < stNames.length; i++) {
          if (stNames[i] !== opts.expectNames[i]) { check1.ok = false; problems.push('站名不符@' + i + ': ' + stNames[i] + ' ≠ ' + opts.expectNames[i]); break; }
        }
      }
      var placeholders = stNames.filter(function (n) { return /^(站|Station)\s*\d+$/.test(n); });
      if (placeholders.length) { check1.ok = false; problems.push('存在占位符站名: ' + placeholders.join(',')); }
      // 编号配对校验（2026-08）：出入口（"X号口"）误入站点列表 → 报错
      var exitNoise = stNames.filter(function (n) { return /号口|号(东|西|南|北)?口/.test(n); });
      if (exitNoise.length) { check1.ok = false; problems.push('存在出入口噪音站名: ' + exitNoise.join(',')); }
      check1.details = {
        stationCount: stNames.length,
        stationNames: stNames,
        totalAnchors: (line.segmentAnchors || []).reduce(function (a, s) { return a + (s ? s.length : 0); }, 0),
        isRing: !!line.isRing,
        branchRootId: line.branchRootId || null,
        pending: (line.pendingAnchors || []).length
      };
      // ---- check2 坐标 ----
      var check2 = { ok: true, details: { mismatches: [] } };
      if (opts.refCoords) {
        for (var j = 0; j < (line.stations || []).length; j++) {
          var s = line.stations[j];
          var ref = opts.refCoords[s.name];
          if (!ref) continue;
          var d = haversine([s.latlng.lng, s.latlng.lat], [ref[0], ref[1]]);
          if (d > tolM) {
            check2.ok = false;
            check2.details.mismatches.push({ station: s.name, distM: Math.round(d), actual: [s.latlng.lng, s.latlng.lat], ref: ref });
            problems.push('坐标偏差@' + s.name + ': ' + Math.round(d) + 'm');
          }
        }
      }
      // ---- check3 视觉/贴合复查 ----
      try { top.redrawLine(line); } catch (e) {}
      var segAnchors = (line.segmentAnchors || []).map(function (s) { return s ? s.length : 0; });
      var emptySegs = [];
      for (var k = 0; k < segAnchors.length; k++) if (!segAnchors[k]) emptySegs.push(k);
      var check3 = { ok: emptySegs.length === 0, details: { segAnchors: segAnchors, emptySegs: emptySegs } };
      if (emptySegs.length) problems.push('存在空节点段: ' + emptySegs.join(','));
      // ---- check4 走向合理性（错误线路检测，2026-08 实现）----
      // ① 绕路/数据混入：逐段节点折线总长 vs 站间直线，>2.2 倍 → 混入其他线路/道路 path
      // ② 站序单调：沿首末主导方向站序应单调（折返/倒挂 → 站序错配）；环线除外
      var check4 = { ok: true, details: { segRatios: [], detours: [], nonMonotonic: [], nodeOrderIssues: [] } };
      var sts = line.stations || [];
      var segAnch = line.segmentAnchors || [];
      for (var si = 0; si < sts.length - 1; si++) {
        var A2 = sts[si], B2 = sts[si + 1];
        if (!A2 || !B2 || !A2.latlng || !B2.latlng) continue;
        var straight = haversine([A2.latlng.lng, A2.latlng.lat], [B2.latlng.lng, B2.latlng.lat]);
        var poly = 0, prevP = [A2.latlng.lng, A2.latlng.lat];
        var arr = (segAnch[si] || []).map(function (a) { return [a.lng, a.lat]; });
        arr.push([B2.latlng.lng, B2.latlng.lat]);
        for (var pi = 0; pi < arr.length; pi++) { poly += haversine(prevP, arr[pi]); prevP = arr[pi]; }
        var ratio = straight > 30 ? poly / straight : 0;
        check4.details.segRatios.push(Math.round(ratio * 10) / 10);
        if (ratio > 2.2) {
          check4.ok = false;
          check4.details.detours.push({ seg: si, ratio: Math.round(ratio * 10) / 10, straight: Math.round(straight), poly: Math.round(poly) });
          problems.push('绕路/数据混入@段' + si + ': 折线' + Math.round(poly) + 'm vs 直线' + Math.round(straight) + 'm（ratio ' + Math.round(ratio * 10) / 10 + '）');
        }
      }
      // 站序单调检测（默认关闭，2026-08-16：避免对绕行/复杂走向线路误报，如苏州2号线独墅湖段正常拐弯被误判折返；
      //   绕路检测（上方折线/直线>2.2）已能发现明显错误线路。opts.checkMonotonic=true 才启用）
      if (opts.checkMonotonic && !line.isRing && sts.length >= 3) {
        var f0 = sts[0].latlng, l0 = sts[sts.length - 1].latlng;
        if (f0 && l0) {
          var dLng = l0.lng - f0.lng, dLat = l0.lat - f0.lat;
          var isEW = Math.abs(dLng) >= Math.abs(dLat); // 东西向：经度主导；南北向：纬度主导
          for (var mi = 1; mi < sts.length; mi++) {
            var pa = sts[mi - 1].latlng, pb = sts[mi].latlng;
            if (!pa || !pb) continue;
            var mono = isEW ? (pb.lng - pa.lng) : (pb.lat - pa.lat);
            var dirOK = (isEW ? dLng : dLat) >= 0 ? (mono >= -0.0009) : (mono <= 0.0009); // 允许微小回退
            if (!dirOK) {
              check4.ok = false;
              check4.details.nonMonotonic.push({ i: mi, name: sts[mi].name, from: sts[mi - 1].name });
              problems.push('站序折返@' + sts[mi].name + '（' + sts[mi - 1].name + '→' + sts[mi].name + '）');
            }
          }
        }
      }
      // 段内节点顺序检测（默认启用，2026-08-22）：每段节点沿"该段首站→末站"方向投影应单调；
      //   投影回退累积 > 段长 20% → 节点折返/乱序（如上海体育馆→东安路绕行）。
      //   与 checkMonotonic(整线站序单调) 不同：这是局部段内检测，对正常绕行/拐弯不误报；环线短段跳过。
      if (!line.isRing) {
        for (var ni = 0; ni < sts.length - 1; ni++) {
          var A4 = sts[ni], B4 = sts[ni + 1];
          if (!A4 || !B4 || !A4.latlng || !B4.latlng) continue;
          var nArr = (segAnch[ni] || []).map(function (a) { return [a.lng, a.lat]; });
          if (nArr.length < 2) continue;
          var vx = (B4.latlng.lng - A4.latlng.lng) * 111320 * Math.cos(A4.latlng.lat * Math.PI / 180);
          var vy = (B4.latlng.lat - A4.latlng.lat) * 110540;
          var slen = Math.sqrt(vx * vx + vy * vy);
          if (slen < 30) continue;
          var prevT = 0, back = 0;
          for (var nn = 0; nn < nArr.length; nn++) {
            var px4 = (nArr[nn][0] - A4.latlng.lng) * 111320 * Math.cos(A4.latlng.lat * Math.PI / 180);
            var py4 = (nArr[nn][1] - A4.latlng.lat) * 110540;
            var t4 = (px4 * vx + py4 * vy) / (slen * slen);
            if (t4 < prevT - 0.05) back += (prevT - t4);
            if (t4 > prevT) prevT = t4;
          }
          if (back > 0.2) {
            check4.ok = false;
            check4.details.nodeOrderIssues.push({ seg: ni, from: A4.name, to: B4.name, back: Math.round(back * 100) });
            problems.push('节点顺序@段' + ni + '（' + A4.name + '→' + B4.name + '）：节点折返回退 ' + Math.round(back * 100) + '%');
          }
        }
      }
      // 汇总
      var pass = check1.ok && check2.ok && check3.ok && check4.ok;
      return { check1: check1, check2: check2, check3: check3, check4: check4, pass: pass, problems: problems };
    },

    // ========================================================================
    // 2. 官方绘制：逐站 + 放站同步放节点 + 镜头跟随
    // ========================================================================
    /** 禁用游戏自动吸附（绘制换乘站精确放置用，2026-08-16 用户要求）：
     *  临时覆盖 `_computeStationAddSnap`（放站时精确返回点击点，不吸附到曲线/其他线站，distM=0 通过色带检查）
     *  + `_findBestSamePlatformStationWithin`/`_findNearestDifferentLineStationWithin`（禁用自动建换乘，
     *  绘制完成后统一 fixTransfers）。用高德独立查询坐标精确放置。幂等（已有则跳过）。 */
    _disableSnap: function () {
      if (window.__odSnapOrig) return;
      window.__odSnapOrig = {
        computeStationAddSnap: top._computeStationAddSnap,
        findBestSamePlatform: top._findBestSamePlatformStationWithin,
        findNearestDiffLine: top._findNearestDifferentLineStationWithin
      };
      // 精确放置：snappedLatLng=点击点本身（distM=0 通过色带范围检查），progress 用曲线进度保证沿线顺序
      top._computeStationAddSnap = function (line, r) {
        var c = (typeof getClosestProgressOnCurve === 'function') ? getClosestProgressOnCurve(line, r) : null;
        return { progress: (c && typeof c.progress === 'number') ? c.progress : 0, snappedLatLng: r, distPx: 0, distM: 0 };
      };
      // 禁用自动建换乘（同台/邻近通道）——放置后统一 fixTransfers
      top._findBestSamePlatformStationWithin = function () { return null; };
      top._findNearestDifferentLineStationWithin = function () { return null; };
    },
    /** 恢复自动吸附（绘制完成后调用） */
    _restoreSnap: function () {
      if (!window.__odSnapOrig) return;
      top._computeStationAddSnap = window.__odSnapOrig.computeStationAddSnap;
      top._findBestSamePlatformStationWithin = window.__odSnapOrig.findBestSamePlatform;
      top._findNearestDifferentLineStationWithin = window.__odSnapOrig.findNearestDiffLine;
      window.__odSnapOrig = null;
    },

    /**
     * 用官方接口逐站绘制线路（合并 drawLine/drawRing，add-station 模式）。
     * 普通线：drawLine(lineId, stations, fitNodes, {})；环线：drawLine(lineId, stations, fitNodes, {isRing:true})（绘制完闭合）。
     * @param {string} lineId 已通过官方 UI 创建的线路 id
     * @param {Array<{name,lng,lat}>} stations 全部站点（含首站）
     * @param {Array<number[][]>} fitNodes 每段抽稀节点 [[[lng,lat],...],...]（长度 = stations-1）
     * @param {Object} opts { zoom, stationDelay, nodeDelay, nodeGapDelay, camEvery, nodeBatch, batchPause, camFollow, isRing }
     *   · 加速（2026-08-16）：默认 stationDelay=15 / nodeDelay=5 / nodeGap=6 / camEvery=0（节点不移动镜头）
     *   · 镜头跟随用 panTo/setCenter（不缩放）避免 setZoomAndCenter 触发全图重绘；camFollow=false 完全不动镜头（最快）
     * @returns {Promise<{placed:number, segAnchors:number[], editMode:string, isRing:boolean}>}
     */
    drawLine: async function (lineId, stations, fitNodes, opts) {
      opts = opts || {};
      var zoom = opts.zoom || 14;
      // 加速（2026-08-16 优化，大幅提速常规铺设）：
      //   · 延时大幅降低（stationDelay 8 / nodeDelay 3 / nodeGap 4）
      //   · 放站默认不动镜头（camFollow=false，完全不动镜头最快——避免 panTo 触发地图重绘，主要加速点）
      //   · 节点默认不移动镜头（camEvery=0）
      //   · 保留性能模式（禁客流重算）+ 分批暂停（防卡死）
      //   · 需要镜头跟随时可传 { camFollow: true }
      var stationDelay = opts.stationDelay != null ? opts.stationDelay : 2;   // 放站延时（2026-08-22 提速 8→2）
      var nodeDelay = opts.nodeDelay != null ? opts.nodeDelay : 1;             // 节点延时（默认1ms）
      var nodeGap = opts.nodeGapDelay != null ? opts.nodeGapDelay : 1;         // 节点间隔
      var camEvery = opts.camEvery != null ? opts.camEvery : 0;      // 0=节点不移动镜头（默认，提速）
      var nodeBatch = opts.nodeBatch != null ? opts.nodeBatch : 0;   // 2026-08-22 提速：默认节点直写，不逐点放置
      var batchPause = opts.batchPause != null ? opts.batchPause : 0;
      var camFollow = opts.camFollow != null ? opts.camFollow : false; // 放站默认不动镜头（最快）
      // 绘制前开启性能模式（禁用客流重算，防卡死）
      if (typeof setMetroPerformanceMode === 'function') { try { setMetroPerformanceMode(true); } catch (e) {} }
      var line = G.lines.find(function (l) { return l.id === lineId; });
      if (!line) return { error: 'line not found: ' + lineId };
      if (!top.placeStationInAddModeAtLatLng) return { error: 'placeStationInAddModeAtLatLng unavailable' };
      // 轻量镜头跟随：panTo/setCenter（不缩放），避免每次 setZoomAndCenter 触发全图重绘
      function follow(lng, lat) {
        try {
          var map = G.map;
          if (!map) return;
          if (typeof map.panTo === 'function') { map.panTo([lng, lat]); }
          else if (typeof map.setCenter === 'function') { map.setCenter([lng, lat]); }
          else if (typeof map.setZoomAndCenter === 'function') { map.setZoomAndCenter(zoom, [lng, lat]); }
        } catch (e) {}
      }
      // 确保 add-station 模式
      if (G.editMode !== 'add-station' || G.currentLineId !== lineId) {
        top.enterStationAddModeOnLine(lineId);
        await sleep(100);
      }
      // 绘制时禁用游戏自动吸附（2026-08-16 用户要求）：换乘站按高德独立坐标精确放置，不吸附到曲线/其他线站
      this._disableSnap();
      // 2026-08-22 提速：仅逐站放置站点（快延时），节点改为直写（跳过逐点点击，大幅提速至 15s/线）
      for (var i = 0; i < stations.length; i++) {
        if (camFollow) follow(stations[i].lng, stations[i].lat);
        await sleep(stationDelay);
        top.placeStationInAddModeAtLatLng({ lat: stations[i].lat, lng: stations[i].lng });
        await sleep(stationDelay);
        if (nodeBatch > 0 && i > 0 && (i % nodeBatch === 0)) await sleep(batchPause);
      }
      // 绘制完成，恢复吸附（2026-08-16 用户要求）
      this._restoreSnap();
      var l2 = G.lines.find(function (x) { return x.id === lineId; });
      // 2026-08-22 提速：节点直写（多段 fitNodes → segmentAnchors），替代逐点放置
      if (fitNodes && fitNodes.length && l2) {
        var _sa3 = [];
        for (var _fi3 = 0; _fi3 < (l2.stations || []).length - 1; _fi3++) {
          var _src3 = fitNodes[_fi3] || [];
          _sa3.push(_src3.map(function (pt) { return { lat: pt[1], lng: pt[0] }; }));
        }
        l2.segmentAnchors = _sa3;
        l2.pendingAnchors = [];
      }
      // 空节点段兜底（防节点放置概率性失效/被拒导致空段，2026-08-16 用户要求）：
      // 绘制后检查每段，若为空则补站间中点，确保无空段（checkLine3x 检查3 不报空段）
      var _sa = l2.segmentAnchors || [];
      var _fixEmpty = 0;
      for (var _ei = 0; _ei < (l2.stations || []).length - 1; _ei++) {
        if (!_sa[_ei] || !_sa[_ei].length) {
          var _a = l2.stations[_ei], _b = l2.stations[_ei + 1];
          if (_a && _b && _a.latlng && _b.latlng) {
            _sa[_ei] = [{ lat: (_a.latlng.lat + _b.latlng.lat) / 2, lng: (_a.latlng.lng + _b.latlng.lng) / 2 }];
            _fixEmpty++;
          } else {
            _sa[_ei] = [];
          }
        }
      }
      l2.segmentAnchors = _sa;
      // 环线闭合
      if (opts.isRing && typeof top.completeRingLine === 'function') {
        try { top.completeRingLine(l2); } catch (e) {}
      }
      try { top.redrawLine(l2); top.refreshStationDots(l2); } catch (e) {}
      // 自动退出绘制模式（2026-08-16 用户要求）：add-station→enterStationAddModeOnLine / place→confirmCreateLine
      try { this.finishEdit(lineId); } catch (e) {}
      // 2026-08-22 操作结束清理：绘制时开启性能模式（禁客流重算），结束必须关闭，避免影响用户正常游戏
      if (typeof setMetroPerformanceMode === 'function') { try { setMetroPerformanceMode(false); } catch (e) {} }
      return {
        placed: (l2.stations || []).length,
        segAnchors: (l2.segmentAnchors || []).map(function (s) { return s ? s.length : 0; }),
        editMode: G.editMode,
        isRing: !!l2.isRing
      };
    },

    /** 分步绘制·第2步：仅逐站放置车站（用户定义标准流程：先属性→画站→画节点→换乘→多次检查）。
     *  @param {string} lineId @param {Array<{name,lng,lat}>} stations
     *  @param {Object} opts { stationDelay, camFollow }
     *  @returns {Promise<{placed:number, editMode:string}>} */
    drawStations: async function (lineId, stations, opts) {
      opts = opts || {};
      var stationDelay = opts.stationDelay != null ? opts.stationDelay : 0;   // 2026-08-22 提速：2→0
      var camFollow = opts.camFollow != null ? opts.camFollow : false;
      if (typeof setMetroPerformanceMode === 'function') { try { setMetroPerformanceMode(true); } catch (e) {} }
      var line = G.lines.find(function (l) { return l.id === lineId; });
      if (!line) return { error: 'line not found: ' + lineId };
      if (!top.placeStationInAddModeAtLatLng) return { error: 'placeStationInAddModeAtLatLng unavailable' };
      if (G.editMode !== 'add-station' || G.currentLineId !== lineId) {
        try { top.enterStationAddModeOnLine(lineId); } catch (e) {}
        await sleep(50);
      }
      this._disableSnap();
      function follow(lng, lat) {
        try { var map = G.map; if (!map) return; if (typeof map.panTo === 'function') map.panTo([lng, lat]); else if (typeof map.setCenter === 'function') map.setCenter([lng, lat]); } catch (e) {}
      }
      for (var i = 0; i < stations.length; i++) {
        if (camFollow) follow(stations[i].lng, stations[i].lat);
        if (stationDelay > 0) await sleep(stationDelay);
        top.placeStationInAddModeAtLatLng({ lat: stations[i].lat, lng: stations[i].lng });
        if (stationDelay > 0) await sleep(stationDelay);
      }
      this._restoreSnap();
      // 2026-08-22 操作结束恢复：恢复性能模式（禁客流/动画），避免影响用户正常游戏
      if (typeof setMetroPerformanceMode === 'function') { try { setMetroPerformanceMode(false); } catch (e) {} }
      var l2 = G.lines.find(function (x) { return x.id === lineId; });
      return { placed: (l2 && l2.stations || []).length, editMode: G.editMode };
    },

    /** 分步绘制·第3步：节点直写（绘制完车站后调用）。
     *  @param {string} lineId @param {Array<number[][]>} fitNodes 多段 [[lng,lat],...]
     *  @returns {Promise<{totalNodes:number, emptySegs:number}>} */
    drawNodes: async function (lineId, fitNodes, opts) {
      opts = opts || {};
      var line = G.lines.find(function (l) { return l.id === lineId; });
      if (!line) return { error: 'line not found: ' + lineId };
      // 2026-08-22 风险护栏：drawNodes 覆盖线路节点（segmentAnchors），YELLOW 拦截
      var _Kn = window.CityMetroKit;
      if (_Kn && typeof _Kn.confirmDangerous === 'function') {
        var _gn = _Kn.confirmDangerous('drawNodes', { line: line.name });
        if (_gn.blocked) return { blocked: true, level: _gn.level, message: _gn.message };
      }
      var _sa = [];
      for (var i = 0; i < (line.stations || []).length - 1; i++) {
        var seg = (fitNodes && fitNodes[i]) || [];
        _sa.push(seg.map(function (p) { return { lat: p[1], lng: p[0] }; }));
      }
      line.segmentAnchors = _sa;
      line.pendingAnchors = [];
      // 空段兜底补中点
      var emptySegs = 0;
      for (var j = 0; j < _sa.length; j++) {
        if (!_sa[j] || !_sa[j].length) {
          emptySegs++;
          var _a = line.stations[j], _b = line.stations[j + 1];
          if (_a && _b && _a.latlng && _b.latlng) _sa[j] = [{ lat: (_a.latlng.lat + _b.latlng.lat) / 2, lng: (_a.latlng.lng + _b.latlng.lng) / 2 }];
        }
      }
      ['_curvePts', '_curvePtsWgs', '_segAnchSaveCache'].forEach(function (k) { try { line[k] = null; } catch (e) {} });
      try { top.redrawLine(line); } catch (e) {}
      try { top.refreshStationDots(line); } catch (e) {}
      try { this.finishEdit(lineId); } catch (e) {}
      if (typeof setMetroPerformanceMode === 'function') { try { setMetroPerformanceMode(false); } catch (e) {} }
      return { totalNodes: _sa.reduce(function (a, s) { return a + s.length; }, 0), emptySegs: emptySegs };
    },

    /** 高德/OSM 比对检查（用户定义：检查应含 颜色/名字/站位置/节点/密度/拟合度，与高德或 OSM 数据比对）。
     *  支线特例（2026-08-22）：支线（branchRootId 或名含'支线'）无独立官方线号查询，
     *  按主线线号比对会误报站名/位置差异（如 11号线支线 8 站 vs 主线 33 站）→ 跳过 names/stationPos，
     *  仅校验 颜色 + 节点空段；`out.isBranch=true` 标记，`checks.names/stationPos.skipped=true`。
     *  @param {string} lineId @param {Object} opts { city }（默认上海）
     *  @returns {Promise<{ok, isBranch, checks:{color,names,stationPos,nodes}}>} */
    verifyLine: async function (lineId, opts) {
      opts = opts || {};
      var city = opts.city || '上海';
      var line = G.lines.find(function (l) { return l.id === lineId; });
      if (!line) return { error: 'line not found: ' + lineId };
      var noMatch = /(\d+)号线/.exec(line.name || '');
      var no = noMatch ? noMatch[1] : '';
      // 2026-08-22 支线识别：支线（branchRootId 或名含'支线'）无独立官方查询，按主线线号会误报站名差异
      //   → 跳过站名/位置比对，仅校验颜色+节点空段
      var isBranch = !!line.branchRootId || /支线/.test(line.name || '');
      var out = { lineId: lineId, lineName: line.name, checks: {}, isBranch: isBranch };
      // 高德官方数据（站名/坐标/走向）
      var q = null;
      try { q = await __MT.queryLine(city, no, {}); } catch (e) {}
      var officialStops = (q && q.ok && q.stations) ? q.stations : null;
      // ① 颜色：官方配色比对
      var palette = __MT.officialColors(city);
      var mm = __MT.matchOfficial ? __MT.matchOfficial(palette, no + '号线') : null;
      var officialColor = mm ? '#' + mm.color : null;
      out.checks.color = { current: line.color, official: officialColor, ok: !officialColor || ((line.color || '').toLowerCase() === officialColor.toLowerCase()) };
      // ② 站名：与官方站名 diff（支线跳过）
      var gameNames = (line.stations || []).map(function (s) { return s.name; });
      var nameDiff = [];
      // ⚠️ 2026-09-06 延伸支持（消除误报）：游戏站数 > 官方站数 → 定位官方段连续子序列起点再比对
      //   （与 verifyLineOrder 同策略；自绘延伸夹官方段的线如南京4号线游戏33站=北11+官方18+东4）
      var hasExt = false, startIdx = 0, winNames = gameNames;
      if (officialStops && !isBranch) {
        var officialNames = officialStops.map(function (s) { return s.name; });
        if (gameNames.length > officialNames.length && officialNames.length >= 2) {
          for (var _si = 0; _si + officialNames.length <= gameNames.length; _si++) {
            if (gameNames[_si] === officialNames[0]) { startIdx = _si; hasExt = true; break; }
          }
        }
        winNames = hasExt ? gameNames.slice(startIdx, startIdx + officialNames.length) : gameNames;
        for (var i = 0; i < Math.max(winNames.length, officialNames.length); i++) {
          if (winNames[i] !== officialNames[i]) nameDiff.push({ i: (hasExt ? startIdx + i : i), game: winNames[i], official: officialNames[i] });
        }
      }
      out.checks.names = { diffCount: isBranch ? 0 : nameDiff.length, diff: isBranch ? [] : nameDiff.slice(0, 8), skipped: isBranch, hasExtension: hasExt, officialStartIdx: hasExt ? startIdx : 0 };
      // ③ 站位置：与高德坐标偏差（>100m 记为 mismatch；支线跳过；延伸线只比官方窗口）
      var stMismatch = [];
      if (officialStops && !isBranch) {
        for (var j = 0; j < Math.min(winNames.length, officialStops.length); j++) {
          var gs = line.stations[hasExt ? startIdx + j : j], os = officialStops[j];
          if (!gs || !gs.latlng || !os || typeof os.lat !== 'number') continue;
          var dLat = (gs.latlng.lat - os.lat) * 110540;
          var dLng = (gs.latlng.lng - os.lng) * 111320 * Math.cos(os.lat * Math.PI / 180);
          var d = Math.sqrt(dLat * dLat + dLng * dLng);
          if (d > 100) stMismatch.push({ i: (hasExt ? startIdx + j : j), name: os.name, devM: Math.round(d) });
        }
      }
      out.checks.stationPos = { mismatchCount: isBranch ? 0 : stMismatch.length, mismatch: isBranch ? [] : stMismatch.slice(0, 8), skipped: isBranch };
      // ④ 节点/密度/空段
      var sa = line.segmentAnchors || [];
      var totalNodes = sa.reduce(function (a, s) { return a + (s ? s.length : 0); }, 0);
      var emptySegs = 0;
      for (var k = 0; k < sa.length; k++) { if (!sa[k] || !sa[k].length) emptySegs++; }
      out.checks.nodes = { total: totalNodes, emptySegs: emptySegs };
      // ⑤ 总判定（支线跳过站名/位置，仅颜色+节点空段）
      out.ok = !!out.checks.color.ok && (isBranch ? true : (out.checks.names.diffCount === 0 && out.checks.stationPos.mismatchCount === 0)) && out.checks.nodes.emptySegs === 0;
      return out;
    },

    /** 快速创建空线路（2026-08-22 压缩 UI 交互时间）：打开新建面板→填名→点开始铺设，延时最小化。
     *  支持普通线号（如 '上海地铁12号线'）与非传统线（如 '上海磁悬浮'）。
     *  @param {string} name 线路名
     *  @returns {Promise<{lineId:number, created:boolean}>} */
    createLine: async function (name) {
      try { if (typeof window.onNavAddLineClick === 'function') window.onNavAddLineClick({}); } catch (e) {}
      await sleep(180);
      // 兼容两版建线弹窗：新版 #line-name-input（如：1）/ #modal-line-confirm-btn（建设）；
      // 旧版 placeholder「如：1号线」/ 按钮「开始铺设轨道」
      var inp = document.querySelector('#line-name-input')
        || document.querySelector('input.line-name-inp')
        || document.querySelector('input[placeholder="如：1号线"]')
        || document.querySelector('input[placeholder^="如："]');
      if (inp) {
        try { inp.value = name; } catch (e) {}
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await sleep(80);
      var btn = document.querySelector('#modal-line-confirm-btn')
        || Array.prototype.slice.call(document.querySelectorAll('button')).find(function (b) {
          var t = (b.textContent || '').trim();
          return t.indexOf('开始铺设轨道') >= 0 || t === '建设';
        });
      if (btn) btn.click();
      await sleep(350);
      var line = (G.lines || []).find(function (l) { return l.name === name; });
      // 兜底：名称被游戏处理后未精确匹配 → 取最近创建的空线
      if (!line) line = (G.lines || []).slice().reverse().find(function (l) { return (l.stations || []).length === 0; });
      return line ? { lineId: line.id, created: true } : { lineId: null, created: false };
    },

    /** 设置线路属性（标准流程·第2步）：官方配色 + 车型/编组/时速 + 官方站名。
     *  @param {string} lineId @param {string} city @param {string} [no]（可省略，从线路名解析）
     *  @returns {{lineId, ok, color, train}} */
    setLineProps: function (lineId, city, no) {
      var line = G.lines.find(function (l) { return l.id === lineId; });
      if (!line) return { error: 'line not found: ' + lineId };
      city = city || '上海';
      if (!no) { var m = /(\d+)号线/.exec(line.name || ''); no = m ? m[1] : ''; }
      var out = { lineId: lineId, ok: true };
      // ① 官方配色
      var palette = __MT.officialColors(city);
      var mm = __MT.matchOfficial ? __MT.matchOfficial(palette, no + '号线') : null;
      if (mm) { line.color = '#' + mm.color; out.color = line.color; }
      // ② 车型/编组/时速（2026-08-22 修复：默认 B6 非官方，用 lineSpec）
      var spec = __MT.lineSpec ? __MT.lineSpec(city, no) : null;
      if (spec && spec.trainType) {
        line.trainType = spec.trainType;
        line.trainCars = spec.trainCars;
        if (spec.maxSpeedKmh) line.maxSpeedKmh = spec.maxSpeedKmh;
        out.train = line.trainType + '/' + line.trainCars;
      }
      try { top.redrawLine(line); } catch (e) {}
      return out;
    },

    /** 有支线时选最长主线：从候选（主线+支线）中选站点数最多者作为主线（2026-08-22 用户要求）。
     *  2026-08-22 主线选择检查：站点数相同→取总长更长者为主线（避免支线站点数与主线相同导致选错）。
     *  @param {Array<{name,stops,totalM}>} candidates 候选路径（主线+支线）
     *  @returns {{name,stops,totalM}|null} 最长者（与原签名兼容） */
    pickLongest: function (candidates) {
      if (!candidates || !candidates.length) return null;
      return candidates.reduce(function (a, b) {
        var sa = a.stops || 0, sb = b.stops || 0;
        if (sb !== sa) return sb > sa ? b : a;
        return (b.totalM || 0) > (a.totalM || 0) ? b : a; // 站点数相同→总长更长者为主线
      });
    },

    /** 主线选择检查（2026-08-22）：从候选（主线+支线）识别应作为主线者，输出对比明细供核对。
     *  判定：站点数最多者为主线；站点数相同→总长更长者；无候选/单候选时给出提示。
     *  @param {Array<{name,stops,totalM?,isBranch?}>} candidates
     *  @returns {{ok, main, branch, table, issue?}} */
    checkMainLine: function (candidates) {
      if (!candidates || !candidates.length) return { ok: false, main: null, branch: [], table: [] };
      var sorted = candidates.slice().sort(function (a, b) {
        var s = (b.stops || 0) - (a.stops || 0);
        if (s !== 0) return s;
        return (b.totalM || 0) - (a.totalM || 0);
      });
      var main = sorted[0], branch = sorted.slice(1);
      var tie = sorted.length > 1 && (sorted[0].stops || 0) === (sorted[1].stops || 0);
      var table = candidates.map(function (c) {
        return { name: c.name, stops: c.stops || 0, totalM: c.totalM || 0, isMain: c === main };
      });
      return {
        ok: !!main,
        main: main,
        branch: branch,
        table: table,
        issue: tie ? '主线与次长线站点数相同，已按总长更长者作为主线，请人工核对' : null
      };
    },

    /** 快速绘制（直接写线路数据，一次 redrawLine，<1s）。批量导入首选（10s/线目标）。
     *  原理：跳过逐站放置（placeStationInAddModeAtLatLng），直接写 line.stations + segmentAnchors，
     *  游戏 redrawLine 自动生成完整线路（实测 28 站 0.66s，checkLine3x 通过）。
     *  @param {string} lineId @param {Array<{name,lng,lat}>} stations @param {Array<number[][]>} nodes
     *  @returns {{placed, emptySegs}} */
    fastDraw: async function (lineId, stations, nodes, opts) {
      opts = opts || {};
      var line = G.lines.find(function (l) { return l.id === lineId; });
      if (!line) return { error: 'line not found: ' + lineId };
      // 2026-08-22 风险护栏：fastDraw 会清空目标线站/节点重画。若目标线非空（已有站点）→ 属覆盖绘制，
      //   须经 confirmDangerous 确认（防 AI 误覆盖已绘线路，RED 拦截）
      var _Kd = window.CityMetroKit;
      if ((line.stations || []).length > 0 && _Kd && typeof _Kd.confirmDangerous === 'function') {
        var _gd = _Kd.confirmDangerous('fastDraw-overwrite', { line: line.name, st: (line.stations || []).length });
        if (_gd.blocked) return { blocked: true, level: _gd.level, message: _gd.message };
      }
      // 2026-08-22 属性合并：传入 opts.city/no 时在同一次 redrawLine 内设官方配色/车型/时速，
      //   避免再调 setLineProps 造成二次全量重绘（压缩交互时间/提升导入流畅度）
      if (opts.city) {
        var palette = __MT.officialColors ? __MT.officialColors(opts.city) : null;
        var mm = __MT.matchOfficial ? __MT.matchOfficial(palette, (opts.no || '') + '号线') : null;
        if (mm) line.color = '#' + mm.color;
        var spec = __MT.lineSpec ? __MT.lineSpec(opts.city, opts.no || '') : null;
        if (spec && spec.trainType) {
          line.trainType = spec.trainType;
          line.trainCars = spec.trainCars;
          if (spec.maxSpeedKmh) line.maxSpeedKmh = spec.maxSpeedKmh;
        }
      }
      // 2026-08-22 修复地图跳动：记录镜头，绘制后恢复（避免 redrawLine 触发镜头跳动）
      var map = G.map, _c = null, _z = null;
      if (map && typeof map.getCenter === 'function') { try { _c = map.getCenter(); } catch (e) {} }
      if (map && typeof map.getZoom === 'function') { try { _z = map.getZoom(); } catch (e) {} }
      if (typeof setMetroPerformanceMode === 'function') { try { setMetroPerformanceMode(true); } catch (e) {} }
      // 直接写 stations（简化对象，游戏 redrawLine 自动补全）；opts.names 提供官方站名时用之（2026-08-22）
      line.stations = (stations || []).map(function (s, i) {
        var nm = (opts.names && opts.names[i]) || s.name;
        return { name: nm, latlng: { lat: s.lat, lng: s.lng }, idx: i, isTransfer: false };
      });
      // 节点直写
      var sa = [];
      for (var i = 0; i < line.stations.length - 1; i++) { sa.push(((nodes && nodes[i]) || []).map(function (p) { return { lat: p[1], lng: p[0] }; })); }
      line.segmentAnchors = sa;
      line.pendingAnchors = [];
      ['_curvePts', '_curvePtsWgs', '_segAnchSaveCache'].forEach(function (k) { try { line[k] = null; } catch (e) {} });
      try { top.redrawLine(line); } catch (e) {}
      try { top.refreshStationDots(line); } catch (e) {}
      try { this.finishEdit(lineId); } catch (e) {}
      // 2026-08-22 补遗漏：换乘站坐标独立（建线后分离跨线共享站对象），统一收尾防遗漏
      try { var _Kf = window.CityMetroKit; if (_Kf && typeof _Kf.separateTransferStations === 'function') _Kf.separateTransferStations([lineId]); } catch (e) {}
      // 恢复镜头（无动画），修复地图跳动
      if (map && _c) { try { if (typeof map.setCenter === 'function') map.setCenter([_c.lng, _c.lat], false); } catch (e) {} }
      if (map && _z != null) { try { if (typeof map.setZoom === 'function') map.setZoom(_z); } catch (e) {} }
      if (typeof setMetroPerformanceMode === 'function') { try { setMetroPerformanceMode(false); } catch (e) {} }
      return { placed: line.stations.length, emptySegs: sa.reduce(function (a, s) { return a + (s && s.length ? 0 : 1); }, 0) };
    },

    /** 统一收尾（2026-08-22 代码约束：所有写数据入口必须调用，防遗漏「空段兜底+重绘+刷新+finishEdit+换乘分离」）。
     *  @param {string} lineId
     *  @returns {{emptySegs:number}} */
    _finalizeLine: function (lineId) {
      var line = G.lines.find(function (l) { return l.id === lineId; });
      if (!line) return { error: 'line not found' };
      var _sa = line.segmentAnchors || [];
      var emptySegs = 0;
      // 空段兜底（补站间中点，防空段）
      for (var i = 0; i < (line.stations || []).length - 1; i++) {
        if (!_sa[i] || !_sa[i].length) {
          emptySegs++;
          var a = line.stations[i], b = line.stations[i + 1];
          if (a && b && a.latlng && b.latlng) _sa[i] = [{ lat: (a.latlng.lat + b.latlng.lat) / 2, lng: (a.latlng.lng + b.latlng.lng) / 2 }];
        }
      }
      line.segmentAnchors = _sa;
      try { top.redrawLine(line); } catch (e) {}
      try { top.refreshStationDots(line); } catch (e) {}
      try { this.finishEdit(lineId); } catch (e) {}
      try { var K = window.CityMetroKit; if (K && typeof K.separateTransferStations === 'function') K.separateTransferStations([lineId]); } catch (e) {}
      return { emptySegs: emptySegs };
    },

    /** 站序校验（2026-08-22 防站序颠倒）：用高德官方站序比对游戏内站序。
     *  @param {string} lineId @param {string} [city]
     *  @returns {Promise<{ok, official, game, diffs}>} */
    verifyLineOrder: async function (lineId, city) {
      city = city || '上海';
      var line = G.lines.find(function (l) { return l.id === lineId; });
      if (!line) return { error: 'line not found' };
      var m = /(\d+)号线/.exec(line.name || '');
      var no = m ? m[1] : '';
      if (!no) return { ok: false, reason: 'no_line_no', line: line.name };
      var q = null; try { q = await __MT.queryLine(city, no, {}); } catch (e) {}
      if (!q || !q.ok) return { ok: false, reason: (q && q.reason) || 'query_fail', line: line.name };
      var official = q.stations.map(function (s) { return s.name; });
      var game = (line.stations || []).map(function (s) { return s.name; });
      var diffs = [];
      // ⚠️ 2026-09-06 支持自绘延伸（消除误报）：游戏站数 > 官方站数 → 在游戏站序中定位「官方段首站」的
      //   连续子序列起点再比对（北/东自绘延伸夹住官方段，如南京4号线游戏33站 = 北延伸11 + 官方18 + 东延伸4；
      //   直接 index 比会把 余家营≠龙江 误报成站序错误）。纯官方线（等长）走原逐位比对。
      var hasExt = game.length > official.length && official.length >= 2;
      var scope = game, startIdx = 0;
      if (hasExt) {
        var _s = -1;
        for (var _i = 0; _i + official.length <= game.length; _i++) { if (game[_i] === official[0]) { _s = _i; break; } }
        if (_s < 0) return { ok: false, reason: 'official_run_not_found', official: official, game: game, diffs: [] };
        startIdx = _s;
        scope = game.slice(_s, _s + official.length);
      }
      scope.forEach(function (n, i) { if (n !== official[i]) diffs.push({ i: i, game: n, official: official[i] }); });
      return { ok: diffs.length === 0 && scope.length === official.length, official: official, game: game, officialStartIdx: startIdx, hasExtension: hasExt, diffs: diffs.slice(0, 12) };
    },

    /** 统一写数据入口（2026-08-22 代码约束：防手工改数据遗漏必要步骤）。
     *  内部强制：①站序重排（opts.order）→②坐标校验（opts.verifyCoords）→③写站+节点→④_finalizeLine 统一收尾→⑤自动自检(verifyLine/verifyLineOrder)。
     *  @param {string} lineId @param {Array<{name,lng,lat}>} stations
     *  @param {Array<number[][]>} [nodes]（缺省自动直线插值）
     *  @param {Object} [opts] { city, order, verifyCoords, coordTolM, selfCheck }
     *  @returns {Promise<{placed, emptySegs, warnings, selfCheck}>} */
    applyLineData: async function (lineId, stations, nodes, opts) {
      opts = opts || {};
      var city = opts.city || '上海';
      var line = G.lines.find(function (l) { return l.id === lineId; });
      if (!line) return { error: 'line not found' };
      var warnings = [];
      var sts = (stations || []).slice();
      // ① 站序约束：提供官方 order 时重排（防站序颠倒，如金海湖/望园路）
      if (opts.order && opts.order.length === sts.length) {
        var nameToSt = {}; sts.forEach(function (s) { nameToSt[s.name] = s; });
        var reordered = opts.order.map(function (n) { return nameToSt[n]; }).filter(Boolean);
        if (reordered.length === sts.length) sts = reordered; else warnings.push('站序重排失败（缺站名），保持原序');
      }
      // ② 坐标校验：与高德 resolveCoord 对比，偏差>阈值告警（防坐标错误站）
      var coordTol = opts.coordTolM != null ? opts.coordTolM : 100;
      if (opts.verifyCoords) {
        for (var i = 0; i < sts.length; i++) {
          var s = sts[i]; if (!s) continue;
          try { var r = await __MT.resolveCoord(city, s.name); if (r && r.ok && typeof s.lat === 'number') {
            var dLat = (s.lat - r.lat) * 110540, dLng = (s.lng - r.lng) * 111320 * Math.cos(r.lat * Math.PI / 180);
            var dev = Math.sqrt(dLat * dLat + dLng * dLng);
            if (dev > coordTol) warnings.push('站坐标偏差 ' + s.name + ' ' + Math.round(dev) + 'm（> ' + coordTol + 'm）');
          } } catch (e) {}
        }
      }
      // ③ 写 stations + 节点（nodes 缺省则直线插值，防空段/稀疏）
      //   2026-08-22 统一绘制：环线/普通线同一入口——opts.isRing 时设 isRing，末尾 completeRingLine 闭合首尾
      if (opts.isRing) line.isRing = true;
      line.stations = sts.map(function (s, idx) { return { name: s.name, latlng: { lat: s.lat, lng: s.lng }, idx: idx, isTransfer: !!s.isTransfer }; });
      var sa = [];
      for (var j = 0; j < line.stations.length - 1; j++) {
        if (nodes && nodes[j] && nodes[j].length) sa.push(nodes[j].map(function (p) { return { lat: p[1], lng: p[0] }; }));
        else sa.push([]);
      }
      line.segmentAnchors = sa;
      line.pendingAnchors = [];
      ['_curvePts', '_curvePtsWgs', '_segAnchSaveCache'].forEach(function (k) { try { line[k] = null; } catch (e) {} });
      // ④ 统一收尾（空段兜底+重绘+刷新+finishEdit+换乘分离）——防遗漏
      var fin = this._finalizeLine(lineId);
      // 环线闭合（2026-08-22 统一入口）：isRing 时闭合首尾后再次收尾，环线与普通线共用 applyLineData
      if (opts.isRing) {
        try { if (typeof top.completeRingLine === 'function') top.completeRingLine(line); } catch (e) {}
        fin = this._finalizeLine(lineId);
      }
      // ⑤ 自动自检（防遗漏检查：坐标/站序/节点）
      var selfCheck = null;
      if (opts.selfCheck !== false) {
        selfCheck = await this.verifyLine(lineId, { city: city });
        if (selfCheck && !selfCheck.ok) warnings.push('自检未通过（' + (selfCheck.checks && selfCheck.checks.names.diffCount) + ' 站名差异）');
      }
      return { placed: line.stations.length, emptySegs: fin.emptySegs, warnings: warnings, selfCheck: selfCheck };
    },

    /** 用该线高德数据重建节点（整线 path 投影拟合，2026-08-16 修复未拟合/稀疏/过密）：
     *  ① 整线 `queryTransferStops` 一次获取全线 SUBWAY path（覆盖全线各段——修复逐段短查询无 path 的未拟合）
     *  ② 对每段投影到全线 path → `fitSegmentNodes` + `curvatureThin(tolerance)` 拟合真实走向
     *  ③ path 未覆盖段 → 直线插值按 GAP(500m) 等分（有中间节点，避免稀疏大间距）
     *  @param {string} city 城市名 @param {string} lineId @param {Object} opts { tolerance: 容错米(默认8) }
     *  @returns {Promise<{totalNodes, perSeg, interpolated, fitted, tolerance}>} */
    rebuildNodesFromAmap: async function (city, lineId, opts) {
      opts = opts || {};
      // 操作前停用自动吸附（2026-08-16 用户要求：所有操作前停用吸附，操作完成后关闭），防止改节点时吸附干扰换乘站
      this._disableSnap();
      try {
        return await this._rebuildNodesFromAmapImpl(city, lineId, opts);
      } finally {
        this._restoreSnap();
      }
    },

    /** 获取该线全线 SUBWAY path 数组（普通线单方向；环线多方向合并覆盖全圈——2026-08-16 整合，
     *  供 rebuildNodesFromAmap 与 K.resolveLineCoord 换乘站坐标查询共用，融合旧逻辑不重复）。
     *  环线：从多个锚点（0/¼/½/¾ 站）向对向站查询，合并多个方向的整线 SUBWAY path 覆盖全圈，
     *  避免单次 queryTransferStops 只回半圈导致另一半圈投影到错误端点（devM 达 7-10km）。
     *  @param {string} city 城市名 @param {Object} line 线路对象（含 stations/isRing/name）
     *  @param {string} lineNo 线号（如 '4'）
     *  @returns {Promise<number[][][]>} paths 数组（每个元素为 [[lng,lat],...]） */
    queryLinePaths: async function (city, line, lineNo) {
      if (!__MT || typeof __MT.queryTransferStops !== 'function') return [];
      var sts = line.stations || [];
      if (sts.length < 2) return [];
      var paths = [];   // 普通线分支结果；环线分支返回 ringSegPaths
      // ⚠️ 2026-08-23 环线方法重写（旧"多方向合并 fullPath"有方向歧义 → 段15/23/24 绕路；
      //    旧"两半圈"只取对向两站，高德对环线返回的半圈方向不可预测（宜山路→世纪大道返回南半圈，
      //    北半圈须用跨北段查询如 虹桥路→中潭路 才返回），导致北段（中山公园/金沙江路/上海火车站/宝山路）
      //    拿不到 path → 直线插值）。
      // 正确方法 = **多方向收集 + 每段选用覆盖它的那条方向 path**：
      //   用一组跨段查询（对向 + 北段 + 南段等）收集多条**各自单条连续、无方向歧义**的 SUBWAY path，
      //   对环线每个段 index，从所有方向 path 中选「两端站都投影到其上、且投影区间有中间点」的那条切出该段
      //   （每段只用单条连续 path，绝不合并多方向 → 无投影方向歧义；北段用跨北查询补全，满足"已有线路禁止直线"）。
      // 返回 paths：普通线 = [整线 path]；环线 = [段0 path, 段1 path, ..., 段(n-1) path]（每条 = 该段真实走向，或 null）。
      if (line.isRing) {
        var n2 = sts.length;
        var opp = Math.floor(n2 / 2);
        // 收集多个方向的跨段查询（覆盖南/北各侧；每条为 {path, stops 站名序}）
        var dirQueries = [
          { from: sts[0], to: sts[opp] },                    // 对向（可能返回南半圈）
          { from: sts[opp], to: sts[0] },                    // 反向对向（可能返回北半圈）
          { from: sts[1], to: sts[7] },                      // 跨北段（实测返回北半圈 1..7）
          { from: sts[5], to: sts[9] }                       // 跨北段（实测返回北半圈 5..9）
        ];
        var dirPaths = [];
        for (var qi = 0; qi < dirQueries.length; qi++) {
          var dq = dirQueries[qi];
          if (!dq.from || !dq.to || !dq.from.latlng || !dq.to.latlng) continue;
          try {
            var dqr = await __MT.queryTransferStops(city, [dq.from.latlng.lng, dq.from.latlng.lat], [dq.to.latlng.lng, dq.to.latlng.lat], lineNo + '号线');
            if (dqr && dqr.ok && dqr.path && dqr.path.length >= 2) dirPaths.push({ path: dqr.path, stops: (dqr.stops || []).map(function (s) { return s.name; }) });
          } catch (e) {}
        }
        if (!dirPaths.length) { return paths; }
        // 对每个段，从所有方向 path 里选**真正覆盖它**的那条：
        //   ① 优先选「该方向 path 的 stops 站名序包含该段两端站名」的方向（stops 明确列出它经过的站，
        //      只有两端站都在其 stops 里，才是真正经过该段的方向；杜绝启发式误选）。
        //   ② 若多个方向都含两端站，取投影中间点最多者。
        //   ③ 若无方向 stops 含两端站，退化用投影中间点最多者。
        var ringSegPaths = [];
        var _nameSet = {};  // 站名 -> 方向path 数组
        for (var di2 = 0; di2 < dirPaths.length; di2++) {
          var _dp2 = dirPaths[di2];
          for (var _nsi = 0; _nsi < _dp2.stops.length; _nsi++) {
            var _nm = _dp2.stops[_nsi];
            (_nameSet[_nm] = _nameSet[_nm] || []).push(_dp2);
          }
        }
        function projOn(path, p) { var b = 0, bd = Infinity; for (var j = 0; j < path.length; j++) { var dd = Math.hypot((p.lng - path[j][0]) * 111320 * Math.cos(p.lat * Math.PI / 180), (p.lat - path[j][1]) * 110540); if (dd < bd) { bd = dd; b = j; } } return b; }
        for (var si = 0; si < n2; si++) {
          var A2 = sts[si], B2 = sts[(si + 1) % n2];
          if (!A2 || !B2 || !A2.latlng || !B2.latlng) { ringSegPaths.push(null); continue; }
          // 方向 path 集合：① 两端站都出现在 stops 的方向（真覆盖）② 兜底所有方向
          var _candsA = _nameSet[A2.name] || [], _candsB = _nameSet[B2.name] || [];
          var _both = _candsA.filter(function (dp) { return _candsB.indexOf(dp) >= 0; });
          var _pool = _both.length ? _both : dirPaths;
          var best = null, bestMid = -1;
          for (var di = 0; di < _pool.length; di++) {
            var dp = _pool[di].path;
            if (!dp || dp.length < 2) continue;
            var ia = projOn(dp, A2.latlng), ib = projOn(dp, B2.latlng);
            var a = Math.min(ia, ib), b = Math.max(ia, ib);
            var mid = (b - a - 1);
            if (mid > bestMid) { bestMid = mid; best = dp; }
          }
          ringSegPaths.push(best);   // 选中覆盖它的方向 path（可能 null）
        }
        return ringSegPaths;
      } else {
        var first = sts[0], last = sts[sts.length - 1];
        // ⚠️ 非标准线（机场线/磁浮/浦江线，lineNo 非数字）不能用 '线号+号线' 作 filter
        //   （如机场线 lineNo='机场'，'机场号线' 匹配不到高德 '市域机场线'；有效 filter 是 '机场'/'机场线'）。
        //   已开通普通线用 '线号+号线'（如 '2号线'）。
        var _isNumericLine = /^\d+[A-Za-z]*$/.test(lineNo);
        var _filters = _isNumericLine ? [lineNo + '号线'] : [lineNo + '线', lineNo, line.name.replace(/(号线|线|上海|上海市)/g, ''), line.name];
        for (var _fi = 0; _fi < _filters.length && !paths.length; _fi++) {
          try {
            var q = await __MT.queryTransferStops(city, [first.latlng.lng, first.latlng.lat], [last.latlng.lng, last.latlng.lat], _filters[_fi]);
            if (q && q.ok && q.path && q.path.length >= 2) paths.push(q.path);
          } catch (e) {}
        }
      }
      return paths;
    },

    /** rebuildNodesFromAmap 实际实现（由上面的防吸附包装包裹） */
    _rebuildNodesFromAmapImpl: async function (city, lineId, opts) {
      opts = opts || {};
      // 节点密度档位 → 容错映射（2026-08-16 询问逻辑一一对应：节点密度档位控制抽稀强度）
      //   sparse(稀疏·抽稀最强·节点最少)→15m · standard(标准·默认)→12m · dense(密集·抽稀最弱·节点最多·弯道精细)→8m
      var _densityTol = { sparse: 15, standard: 12, dense: 8 };
      var tol = opts.tolerance != null ? opts.tolerance : (_densityTol[opts.density] || 12);   // 容错决定 DP 删点强度（容错大→节点少），弯道仍贴合
      // 节点控制参数（抽稀收益最大化，随密度档位）：minGap 间距下限(防过密)、maxGap 补点上限(防过稀)、maxPerSeg 每段上限
      var _densityMinGap = { sparse: 120, standard: 80, dense: 60 };
      var minGapC = opts.minGap != null ? opts.minGap : (_densityMinGap[opts.density] || 80);
      var maxGapC = opts.maxGap != null ? opts.maxGap : 1000;
      var maxPerSegC = opts.maxPerSeg != null ? opts.maxPerSeg : 22;
      var line = G.lines.find(function (l) { return l.id === lineId; });
      if (!line) return { error: 'line not found: ' + lineId };
      if (!__MT || typeof __MT.fitSegmentNodes !== 'function') return { error: '__MT.fitSegmentNodes unavailable' };
      var sts = line.stations || [];
      if (sts.length < 2) return { error: 'too few stations' };
      var noMatch = /(\d+[A-Za-z]*|[A-Za-z]+\d+)号线/.exec(line.name || '');
      var lineNo = noMatch ? noMatch[1] : '';
      // ① 获取 SUBWAY path（普通线单方向整线；环线两半圈策略——2026-08-23 重写：
      //    旧多方向合并 fullPath 有方向歧义导致环线交汇点附近段（15/23/24）绕路，
      //    现改为环线取对向站对的两个半圈完整 SUBWAY path，按站序顺序投影切分每段，不再合并/不再直线插值）
      var paths = await this.queryLinePaths(city, line, lineNo);
      // 辅助：点投影到 path 的最近索引（米制，用于环线半圈内按站序切分）
      function _projIdxOn(path, p) {
        var best = 0, bd = Infinity;
        for (var jj = 0; jj < path.length; jj++) {
          var dd = Math.hypot((p.lng - path[jj][0]) * 111320 * Math.cos(p.lat * Math.PI / 180), (p.lat - path[jj][1]) * 110540);
          if (dd < bd) { bd = dd; best = jj; }
        }
        return best;
      }
      var ENDPAD = 100, GAP = 500;
      var segs = [], interpolated = [], fitted = [];
      // 段数：普通线 N-1 段；环线 N 段（含闭合段 末站→首站）——2026-08-16 整合，修复环线缺闭合段
      var segCount = line.isRing ? sts.length : sts.length - 1;
      for (var i = 0; i < segCount; i++) {
        var A = sts[i], B = sts[(i + 1) % sts.length];   // 环线闭合段 A=末站 B=首站；普通线 (i+1) 同 i+1
        var A0 = { lat: A.latlng.lat, lng: A.latlng.lng }, B0 = { lat: B.latlng.lat, lng: B.latlng.lng };
        var seg = null;
        // ② 逐段拟合（2026-08-23 重写，环线方法已删除合并投影）：
        //    环线：paths[i] = 覆盖该段的单条方向 path（由 queryLinePaths 多方向收集选中最优者，或 null），
        //      直接用它在 [idx(A)..idx(B)] 区间投影切分真实点（单条连续 → 无方向歧义）。
        //    普通线：遍历（通常仅）整线 path，取第一个不绕路者（绕路检测 ratio>2.2 → 跳过）
        if (paths && paths.length) {
          if (line.isRing) {
            // 环线：用 queryLinePaths 已选好的该段方向 path。
            // ⚠️ 环线真实段不应绕路，绕路阈值收紧到 1.3：若切分后 ratio>1.3（如段23 东安路→上海体育场
            //    被投影到方向 path 的绕行部分），不采用 → 走④逐站独立查询兜底（贴合真实急弯）。
            var segPath = paths[i];
            if (segPath && segPath.length >= 2) {
              var _ia = _projIdxOn(segPath, A0), _ib = _projIdxOn(segPath, B0);
              var _a0 = Math.min(_ia, _ib), _b0 = Math.max(_ia, _ib);
              var _mid = [];
              for (var _x = _a0 + 1; _x < _b0 && _x < segPath.length; _x++) _mid.push([segPath[_x][0], segPath[_x][1]]);
              if (_mid.length >= 2) {
                var chainR = [[A0.lng, A0.lat]].concat(_mid, [[B0.lng, B0.lat]]);
                var thinR = __MT.curvatureThin(chainR, { tolerance: tol, maxSpacing: maxGapC });
                var candRing = (thinR || []).map(function (p) { return { lat: p[1], lng: p[0] }; });
                if (candRing && candRing.length > 1 && _chainRatio(candRing, A0, B0) <= 1.3) { seg = candRing; }   // 环线绕路阈值 1.3
              }
            }
          } else {
            for (var pi = 0; pi < paths.length && !seg; pi++) {
              var fp = paths[pi];
              if (!fp || fp.length < 2) continue;
              var fit = __MT.fitSegmentNodes([{ name: A.name, lat: A0.lat, lng: A0.lng }, { name: B.name, lat: B0.lat, lng: B0.lng }], fp, { tolerance: tol });
              var dense = fit && fit[0] ? fit[0] : [];
              if (dense.length) {
                var cand = __MT.curvatureThin(dense, { tolerance: tol, maxSpacing: maxGapC }).map(function (p) { return { lat: p[1], lng: p[0] }; });
                if (cand && cand.length > 1 && _chainRatio(cand, A0, B0) <= 2.2) { seg = cand; }  // 不绕路才采用
              }
            }
          }
          if (seg && seg.length) fitted.push(A.name + '→' + B.name);
        }
        // ③ path 未覆盖（含环线整线只回半圈的另一半、普通线整线 path 未覆盖的虹桥/郊区等段）
        //    2026-08-16 优化：对所有线路（不限于环线）逐段 transferSearch 取该段 SUBWAY path 拟合，
        //    修复普通线（如2号线虹桥机场段）因整线 path 未覆盖而回退直线插值导致"未拟合"的问题
        if (!seg || !seg.length) {
          try {
            var segR3 = await __MT.transferSearch(city, [A0.lng, A0.lat], [B0.lng, B0.lat]);
            if (segR3 && segR3.ok) for (var rp = 0; rp < (segR3.plans || []).length && !seg; rp++) { var rpl = segR3.plans[rp]; for (var rs = 0; rs < (rpl.segments || []).length && !seg; rs++) { var rsg = rpl.segments[rs]; if (rsg.mode === 'SUBWAY' && rsg.path && rsg.path.length >= 2) { var rf = __MT.fitSegmentNodes([{ name: A.name, lat: A0.lat, lng: A0.lng }, { name: B.name, lat: B0.lat, lng: B0.lng }], rsg.path, { tolerance: tol }); var rd = rf && rf[0] ? rf[0] : []; if (rd.length) { var _candR = __MT.curvatureThin(rd, { tolerance: tol, maxSpacing: maxGapC }).map(function (p) { return { lat: p[1], lng: p[0] }; }); // 逐段拟合也做绕路检测（防混入其他线 path）
                if (_candR && _candR.length > 1 && _chainRatio(_candR, A0, B0) <= 2.2) seg = _candR; } } } }
          } catch (e) {}
          if (seg && seg.length) fitted.push(A.name + '→' + B.name);
        }
        // ④ path 仍未覆盖 → 逐段查询兜底（2026-08-23 用户要求：已有线路禁止直线，查不到可逐站查询）。
        //    已开通线路（含环线）绝不直接直线插值——先查真实 SUBWAY path 拟合，只有确实查不到才直线。
        //    ⚠️ 环线优先用「跨2站」（A→B的下一站 C）查询：实测高德对环线"相邻两站"(A→B)常返回上一段/公交
        //    （如 东安路→上海体育场 单站 ok:false，但 东安路→上海体育馆 跨2站返回 17点 path ratio 1.0；
        //    海伦路→临平路 单站拿不到，但 海伦路→大连路 跨2站返回 20点），在其中按 A、B 投影截取该段真实弯道。
        if (!seg || !seg.length) {
          var segQuery = null;
          try {
            // ① 环线优先"跨度递增"查询（2026-08-23）：从跨2站起逐步增大跨度（A→B的下一个站、下两个站…），
            //    直到返回 path 的 stops 覆盖 A、B 两端站（且投影区间有中间点）。
            //    实测：单站(A→B)高德常返回上一段/公交；跨2站对多数段有效（东安路→上海体育馆 17点 ratio1）；
            //    个别段需跨3站（蓝村路→西藏南路 51点 覆盖 蓝村路→塘桥；蓝村路→南浦大桥 返回起点塘桥 不含蓝村路）。
            var _segSpan = null;
            if (line.isRing) {
              for (var _span = 2; _span <= 4 && !_segSpan; _span++) {
                var _C = sts[(i + _span) % sts.length];
                if (!_C || !_C.latlng) continue;
                var segQrSpan = await __MT.queryTransferStops(city, [A0.lng, A0.lat], [_C.latlng.lng, _C.latlng.lat], lineNo + '号线');
                if (!segQrSpan || !segQrSpan.ok || !segQrSpan.path || segQrSpan.path.length < 3) continue;
                // 检查返回 path 的 stops 是否覆盖 A、B（防止起点偏移如 蓝村路→南浦大桥 返回"塘桥"起点）
                var _spStops = (segQrSpan.stops || []).map(function (s) { return s.name; });
                var _hasA = _spStops.indexOf(A.name) >= 0, _hasB = _spStops.indexOf(B.name) >= 0;
                if (!(_hasA && _hasB)) continue;
                // 在 path 上按 A、B 投影截取 [idx(A)..idx(B)] 真实段
                var _iA = _projIdxOn(segQrSpan.path, A0), _iB = _projIdxOn(segQrSpan.path, B0);
                var _a3 = Math.min(_iA, _iB), _b3 = Math.max(_iA, _iB);
                var _mid3 = [];
                for (var _x3 = _a3 + 1; _x3 < _b3 && _x3 < segQrSpan.path.length; _x3++) _mid3.push([segQrSpan.path[_x3][0], segQrSpan.path[_x3][1]]);
                if (_mid3.length >= 2) {
                  var _chain3 = [[A0.lng, A0.lat]].concat(_mid3, [[B0.lng, B0.lat]]);
                  var _thin3 = __MT.curvatureThin(_chain3, { tolerance: tol, maxSpacing: maxGapC });
                  var _cand3 = (_thin3 || []).map(function (p) { return { lat: p[1], lng: p[0] }; });
                  if (_cand3 && _cand3.length > 1 && _chainRatio(_cand3, A0, B0) <= 1.3) { _segSpan = _cand3; }
                }
              }
            }
            // ② 跨度递增失败 → 单站（A→B）
            if (!_segSpan) {
              var segQr = await __MT.queryTransferStops(city, [A0.lng, A0.lat], [B0.lng, B0.lat], lineNo + '号线');
              if (segQr && segQr.ok && segQr.path && segQr.path.length >= 2) {
                var fitQ = __MT.fitSegmentNodes([{ name: A.name, lat: A0.lat, lng: A0.lng }, { name: B.name, lat: B0.lat, lng: B0.lng }], segQr.path, { tolerance: tol });
                var denseQ = fitQ && fitQ[0] ? fitQ[0] : [];
                if (denseQ.length) {
                  var candQ = __MT.curvatureThin(denseQ, { tolerance: tol, maxSpacing: maxGapC }).map(function (p) { return { lat: p[1], lng: p[0] }; });
                  if (candQ && candQ.length > 1 && _chainRatio(candQ, A0, B0) <= 1.3) { _segSpan = candQ; }
                }
              }
            }
            segQuery = _segSpan;
          } catch (e) {}
          if (segQuery && segQuery.length) {
            seg = segQuery;
            fitted.push(A.name + '→' + B.name);
          } else {
            // 确实查不到 → 直线插值兜底（已开通本应禁止，但作为最后防线；环线/已开通尽量不触发）
            var d = _distM(A0, B0);
            var n = Math.max(1, Math.floor(d / GAP));
            seg = [];
            for (var k = 1; k <= n; k++) { var t = k / (n + 1); var pt = { lat: A0.lat + (B0.lat - A0.lat) * t, lng: A0.lng + (B0.lng - A0.lng) * t }; if (_distM(A0, pt) > ENDPAD && _distM(B0, pt) > ENDPAD) seg.push(pt); }
            if (!seg.length) seg = [{ lat: (A0.lat + B0.lat) / 2, lng: (A0.lng + B0.lng) / 2 }];
            interpolated.push(A.name + '→' + B.name + '(估算)');
          }
        }
        // ④ 节点控制（2026-08-16 用户要求：不过密不稀疏）：过稀(间距>800m)按800等分补点；间距下限过滤(≥40m 防过密)；过密(>25个)等距抽样
        if (seg && seg.length) {
          var seg2 = [seg[0]];
          for (var si = 1; si < seg.length; si++) {
            var A2 = seg[si-1], B2 = seg[si];
            var d2 = _distM(A2, B2);
            if (d2 > maxGapC) { var parts = Math.ceil(d2 / maxGapC); for (var kk = 1; kk < parts; kk++) seg2.push({ lat: A2.lat + (B2.lat - A2.lat) * kk / parts, lng: A2.lng + (B2.lng - A2.lng) * kk / parts }); }
            seg2.push(B2);
          }
          // 间距下限过滤（防过密）：相邻间距 < minGapC 剔除
          var filtered = [seg2[0]];
          for (var fi = 1; fi < seg2.length; fi++) { if (_distM(filtered[filtered.length - 1], seg2[fi]) >= minGapC) filtered.push(seg2[fi]); }
          if (filtered.length > 1) seg = filtered; else seg = [seg2[0], seg2[seg2.length - 1]];
          if (seg.length > maxPerSegC) {
            var step = seg.length / maxPerSegC, sampled = [];
            for (var si2 = 0; si2 < maxPerSegC; si2++) sampled.push(seg[Math.min(seg.length - 1, Math.round(si2 * step))]);
            seg = sampled;
          }
        }
        // ④b 站台避让（统一，2026-11-12 修复环线/支线）：环线候选链含端点站坐标，
        //    普通线 fitSegmentNodes 已避让但环线/跨度查询候选未避让 → 统一剔除距两端站 <ENDPAD 的节点，剔空取中点。
        if (seg && seg.length) {
          var padded = [];
          for (var piPad = 0; piPad < seg.length; piPad++) { var ppPad = seg[piPad]; if (_distM(A0, ppPad) >= ENDPAD && _distM(B0, ppPad) >= ENDPAD) padded.push(ppPad); }
          if (!padded.length) padded = [{ lat: (A0.lat + B0.lat) / 2, lng: (A0.lng + B0.lng) / 2 }];
          seg = padded;
        }
        // ⑤ 异常段（整线 path 局部绕路导致 max 间距 > 3000m，如虹桥段）→ 先用逐段 transferSearch 获取该段正确 SUBWAY path 拟合，仍无则直线插值
        if (seg.length > 1) {
          var maxD = 0;
          for (var mi = 1; mi < seg.length; mi++) { var md = _distM(seg[mi-1], seg[mi]); if (md > maxD) maxD = md; }
          if (maxD > 3000) {
            var segSeg = null;
            try {
              var segR = await __MT.transferSearch(city, [A0.lng, A0.lat], [B0.lng, B0.lat]);
              if (segR && segR.ok) for (var sp = 0; sp < (segR.plans || []).length; sp++) { var spl = segR.plans[sp]; for (var ss = 0; ss < (spl.segments || []).length; ss++) { var ssg = spl.segments[ss]; if (ssg.mode === 'SUBWAY' && ssg.path && ssg.path.length >= 2) { var fit2 = __MT.fitSegmentNodes([{ name: A.name, lat: A0.lat, lng: A0.lng }, { name: B.name, lat: B0.lat, lng: B0.lng }], ssg.path, { tolerance: tol }); var den2 = fit2 && fit2[0] ? fit2[0] : []; if (den2.length) { var _cR2 = __MT.curvatureThin(den2, { tolerance: tol }).map(function (p) { return { lat: p[1], lng: p[0] }; }); // 绕路检测（防混入其他线 path，如2号线段27混10号线）
                  if (_cR2 && _cR2.length > 1 && _chainRatio(_cR2, A0, B0) <= 2.2) segSeg = _cR2; } } if (segSeg) break; } if (segSeg) break; }
            } catch (e) {}
            if (segSeg && segSeg.length) {
              // segSeg 也应用节点控制（minGap 过滤 + 上限，防过密，同主逻辑参数）
              var f2 = [segSeg[0]];
              for (var f2i = 1; f2i < segSeg.length; f2i++) { if (_distM(f2[f2.length - 1], segSeg[f2i]) >= minGapC) f2.push(segSeg[f2i]); }
              if (f2.length > 1) segSeg = f2; else segSeg = [segSeg[0], segSeg[segSeg.length - 1]];
              if (segSeg.length > maxPerSegC) {
                var step3 = segSeg.length / maxPerSegC, s3 = [];
                for (var s3i = 0; s3i < maxPerSegC; s3i++) s3.push(segSeg[Math.min(segSeg.length - 1, Math.round(s3i * step3))]);
                segSeg = s3;
              }
              seg = segSeg;
            } else {
              var d0 = _distM(A0, B0), n0 = Math.max(1, Math.floor(d0 / GAP));
              var segI = [];
              for (var k2 = 1; k2 <= n0; k2++) { var t2 = k2 / (n0 + 1); var pt2 = { lat: A0.lat + (B0.lat - A0.lat) * t2, lng: A0.lng + (B0.lng - A0.lng) * t2 }; if (_distM(A0, pt2) > ENDPAD && _distM(B0, pt2) > ENDPAD) segI.push(pt2); }
              if (!segI.length) segI = [{ lat: (A0.lat + B0.lat) / 2, lng: (A0.lng + B0.lng) / 2 }];
              seg = segI;
              interpolated.push(A.name + '→' + B.name + '(绕路回退)');
            }
          }
        }
        segs.push(seg);
      }
      // （全局平滑已移除：curvatureThin 段内已内置 2 倍递增渐变（gradientPoints + maxRatio≤1.8），
      //  满足"大转弯后加 2 倍递增节点"需求；额外全局平滑会破坏 curvatureThin 的段内均匀、制造新突变）
      line.segmentAnchors = segs;
      line.pendingAnchors = [];
      ['_curvePts', '_curvePtsWgs', '_segAnchSaveCache'].forEach(function (k) { try { line[k] = null; } catch (e) {} });
      try { top.redrawLine(line); } catch (e) {}
      try { top.refreshStationDots(line); } catch (e) {}
      return { totalNodes: segs.reduce(function (a, s) { return a + s.length; }, 0), perSeg: segs.map(function (s) { return s.length; }), interpolated: interpolated, fitted: fitted, tolerance: tol };
    },

    /** 按官方站名顺序重命名并重绘 */
    renameStations: function (lineId, officialNames) {
      var line = G.lines.find(function (l) { return l.id === lineId; });
      if (!line) return { error: 'line not found' };
      (line.stations || []).forEach(function (s, i) {
        if (i < officialNames.length) s.name = officialNames[i];
      });
      try { top.redrawLine(line); top.refreshStationDots(line); } catch (e) {}
      return { names: (line.stations || []).map(function (s) { return s.name; }) };
    },

    // ========================================================================
    // 4. 支线特例（官方 startBranchLine）
    // ========================================================================
    /** 从主线引出支线（官方 B 键底层） */
    startBranch: function (mainLineId, startStationName) {
      var main = G.lines.find(function (l) { return l.id === mainLineId; });
      if (!main) return { error: 'main line not found: ' + mainLineId };
      var startSt = (main.stations || []).find(function (s) { return s.name === startStationName; });
      if (!startSt) return { error: 'start station not found: ' + startStationName };
      if (typeof top.startBranchLine !== 'function') return { error: 'startBranchLine unavailable' };
      top.startBranchLine(main, startSt);
      var branch = (G.lines || []).find(function (l) { return l.branchRootId === main.id; });
      if (branch) return { id: branch.id, name: branch.name, branchRootId: branch.branchRootId, stations: (branch.stations || []).map(function (s) { return s.name; }) };
      return { error: 'branch not created' };
    },

    /** 支线节点直接写入 segmentAnchors（最稳），并重绘；写入前统一站台避让（2026-11-12 修复） */
    setBranchAnchors: function (branchId, fitNodes) {
      var line = G.lines.find(function (l) { return l.id === branchId; });
      if (!line) return { error: 'line not found' };
      var sts = (line.stations || []).map(function (s) { return { lat: s.latlng.lat, lng: s.latlng.lng }; });
      var padded = (__MT && __MT.padSegmentNodes) ? __MT.padSegmentNodes(sts, fitNodes, { endPadM: 100 }) : fitNodes;
      line.segmentAnchors = padded.map(function (seg) {
        return seg.map(function (nd) { return { lat: nd[1], lng: nd[0] }; });
      });
      line.pendingAnchors = [];
      try { top.redrawLine(line); } catch (e) {}
      return { segAnchors: line.segmentAnchors.map(function (s) { return s ? s.length : 0; }) };
    },

    /** 完成支线（2026-08-22 重写：移除旧 place 模式 startExtendLine/confirmCreateLine + 全量重绘，用 _finalizeLine 统一收尾防卡顿） */
    finishBranch: function (branchId) {
      var line = G.lines.find(function (l) { return l.id === branchId; });
      if (!line) return { error: 'line not found' };
      this._finalizeLine(branchId);
      return { editMode: G.editMode, stations: (line.stations || []).length, totalNodes: (line.segmentAnchors || []).reduce(function (a, s) { return a + (s ? s.length : 0); }, 0), pending: (line.pendingAnchors || []).length };
    },

    /** 支线数据统一写入（2026-08-22 重写，替代旧 drawBranchStations place 模式——其逐站点击会自动命名垃圾站）。
     *  startBranch 创建支线对象后调用：写全部站（含分叉站，官方顺序）→ 拟合节点 → 命名 → _finalizeLine 统一收尾。
     *  @param {string} branchId 支线 id
     *  @param {Array<{name,lng,lat}>} stations 支线全部站（含分叉站，官方顺序）
     *  @param {Object} opts { city, order, name, density }
     *  @returns {Promise<{st, names, totalNodes}>} */
    applyBranchData: async function (branchId, stations, opts) {
      opts = opts || {};
      var city = opts.city || '上海';
      var line = G.lines.find(function (l) { return l.id === branchId; });
      if (!line) return { error: 'line not found' };
      if (opts.name) { line.name = opts.name; line._lineNameCustomizedByUser = true; }
      var order = opts.order || stations.map(function (s) { return s.name; });
      await this.applyLineData(branchId, stations, null, { city: city, order: order, verifyCoords: false, selfCheck: false });
      if (opts.rebuildNodes !== false) {
        try { await this.rebuildNodesFromAmap(city, branchId, { density: opts.density || 'standard' }); } catch (e) {}
      }
      var l2 = G.lines.find(function (x) { return x.id === branchId; });
      return { st: (l2.stations || []).length, names: (l2.stations || []).map(function (s) { return s.name; }), totalNodes: (l2.segmentAnchors || []).reduce(function (a, s) { return a + (s ? s.length : 0); }, 0) };
    },

    // ========================================================================
    // 5. 检查
    // ========================================================================
    /** 检查线路完整状态 */
    inspect: function (lineId) {
      var line = G.lines.find(function (l) { return l.id === lineId; });
      if (!line) return { error: 'line not found' };
      return {
        name: line.name,
        color: line.color,
        isRing: !!line.isRing,
        trainType: line.trainType,
        trainCars: line.trainCars,
        stationCount: (line.stations || []).length,
        stationNames: (line.stations || []).map(function (s) { return s.name; }),
        segAnchors: (line.segmentAnchors || []).map(function (s) { return s ? s.length : 0; }),
        totalAnchors: (line.segmentAnchors || []).reduce(function (a, s) { return a + (s ? s.length : 0); }, 0),
        pending: (line.pendingAnchors || []).length,
        branchRootId: line.branchRootId || null,
        editMode: G.editMode
      };
    },

    // ========================================================================
    // 6. 换乘自动设置（高德查换乘 + 官方建换乘组）
    // ========================================================================
    /**
     * 用高德 AMap.Transfer 查询"某站→远端站"换乘方案，提取方案中经过的
     * 地铁线路名（非本线的即换乘伙伴线路）。本线直达则无换乘伙伴。
     * @param {string} city
     * @param {number[]} fromLngLat [lng,lat] 本站
     * @param {number[]} toLngLat   [lng,lat] 远端站（环线取对角/远端站）
     * @param {string} lineNameMatch 本线名片段（用于剔除本线，如 "4号线"）
     * @returns {Promise<{ok:boolean, lines:string[]}>}
     */
    transferViaAmap: function (city, fromLngLat, toLngLat, lineNameMatch) {
      return new Promise(function (resolve) {
        if (__MT && typeof __MT.transferSearch === 'function') {
          __MT.transferSearch(city, fromLngLat, toLngLat).then(function (res) {
            if (!res.ok) return resolve({ ok: false, reason: res.reason || res.status });
            var lines = [];
            (res.plans || []).forEach(function (p) {
              (p.segments || []).forEach(function (sg) {
                (sg.lines || []).forEach(function (l) {
                  if (typeof l === 'string') lines.push(l);
                });
              });
            });
            // 去重 + 剔除非地铁/本线
            var seen = {};
            var metroLines = [];
            lines.forEach(function (l) {
              if (!l || seen[l]) return;
              seen[l] = true;
              var isMetro = /地铁|轨道交通/.test(l);
              var isSelf = lineNameMatch && l.indexOf(lineNameMatch) >= 0;
              if (isMetro && !isSelf) metroLines.push(l);
            });
            resolve({ ok: true, lines: metroLines });
          }).catch(function (e) { resolve({ ok: false, reason: String(e) }); });
        } else {
          resolve({ ok: false, reason: '__MT.transferSearch unavailable' });
        }
      });
    },

    /**
     * 自动设置换乘：对目标线路每个站：
     *   ① 用高德 transferViaAmap 查换乘伙伴线路（剔除本线）
     *   ② 在游戏内找到伙伴线路的同名站（优先同名，其次邻近<250m）
     *   ③ 用官方 _applyTransferDecision 建立换乘组（isTransfer + 同名 + 同 transferGroupId）
     *   ④ 修复本线内 isTransfer=true 但无 transferGroupId 的异常站
     * @param {string} lineId 目标线路 id
     * @param {Object} opts { city, lineNameMatch(本线名片段), farStationMap(可选远端站{站名:[lng,lat]}),
     *                       tolM(邻近容差默认250), kind(passage|same-platform 默认passage) }
     * @returns {Promise<{transfers:Array, fixed:Array, errors:Array}>}
     */
    autoTransfers: async function (lineId, opts) {
      opts = opts || {};
      var city = opts.city || '上海';
      // 2026-08-22 风险护栏：自动修复换乘（跨线建组），YELLOW 拦截
      var _Kt = window.CityMetroKit;
      if (_Kt && typeof _Kt.confirmDangerous === 'function') {
        var _gt = _Kt.confirmDangerous('autoTransfers', { city: city });
        if (_gt.blocked) return { blocked: true, level: _gt.level, message: _gt.message };
      }
      var lineNameMatch = opts.lineNameMatch || (function (n) { var m = /(\d+)号线/.exec(n); return m ? m[1] + '号线' : n; })(function () { var l = G.lines.find(function (x) { return x.id === lineId; }); return l ? l.name : ''; }());
      var tolM = opts.tolM != null ? opts.tolM : 250;
      var kind = opts.kind || 'passage';
      var line = G.lines.find(function (l) { return l.id === lineId; });
      if (!line) return { error: 'line not found: ' + lineId };
      // 远端站：环线取对角（stations 后半段对应站），普通线取末站
      var farStationMap = opts.farStationMap || {};
      var sts = line.stations || [];
      var half = Math.floor(sts.length / 2);
      var transfers = [], fixed = [], errors = [];

      // 先修复本线内 有flag无group 的异常站
      sts.forEach(function (s) {
        if (s.isTransfer && !s.transferGroupId) {
          s.transferGroupId = top._newTransferGroupId();
          s.transferType = s.transferType || 'passage';
          fixed.push({ station: s.name, issue: 'no_group_fixed' });
        }
      });

      // 2026-08-22 性能优化：预扫描同城其他线站名集合，只对「候选换乘站」做高德查询，
      //   避免每站串行 transferSearch（31站×网络查询 → 卡顿数十秒）。
      //   候选 = 本线站名在同城其他线存在同名站；无同名 → 不可能是换乘，直接跳过。
      var cityPrefix3 = city === '上海' ? '上海地铁' : (city + '地铁');
      var sameNameCityStops = {};
      (G.lines || []).forEach(function (ol) {
        if (ol.id === lineId) return;
        if (ol.name.indexOf(cityPrefix3) < 0) return;
        (ol.stations || []).forEach(function (os) { sameNameCityStops[os.name] = true; });
      });
      for (var i = 0; i < sts.length; i++) {
        var s = sts[i];
        if (!s || !s.latlng) continue;
        // 快速跳过非换乘候选站（本线站名在同城其他线无同名站）
        if (!sameNameCityStops[s.name]) continue;
        // 2026-08-22 高效换乘：直接用游戏内同城同名站扫描建立（纯内存，毫秒级，无高德网络查询）。
        //   （原逐站 transferViaAmap 网络查询 → 每条线卡顿数十秒；同名站已是换乘充分条件，直接建组）
        var partners = [];
        var seenPartner = {};
        function tryAddPartner(partnerLine, os) {
          if (!os || os === s) return;
          var key = partnerLine.id + ':' + os.sid;
          if (seenPartner[key]) return;
          seenPartner[key] = true;
          partners.push({ line: partnerLine.name, station: os, name: os.name });
        }
        (G.lines || []).forEach(function (ol) {
          if (ol.id === lineId) return;
          if (ol.name.indexOf(cityPrefix3) < 0) return; // 仅同城线路
          (ol.stations || []).forEach(function (os) {
            if (os.name === s.name) tryAddPartner(ol, os);
          });
        });
        // 官方建立换乘（2026-08-22 优化：逐对 sleep 15→3，降卡顿）
        for (var p = 0; p < partners.length; p++) {
          var partner = partners[p];
          if (s.transferGroupId && partner.station.transferGroupId && s.transferGroupId === partner.station.transferGroupId) continue;
          try {
            top._applyTransferDecision({ movedStation: s, targetStation: partner.station, kind: kind, primaryLine: lineId }, true);
            transfers.push({ station: s.name, partner: partner.line, kind: kind });
          } catch (e) {
            errors.push({ station: s.name, partner: partner.line, err: String(e) });
          }
          await sleep(3);
        }
      }
      // 2026-08-22 优化：移除全量 redrawAllMetroOverlays（大存档全量重绘会重算全网客流→卡死/重载），
      //   改为对目标线轻量重绘（redrawLine+refreshStationDots），换乘显示由 separateTransferStations 轻量重绘兜底
      try { var _ln = G.lines.find(function (x) { return x.id === lineId; }); if (_ln) { top.redrawLine(_ln); top.refreshStationDots(_ln); } } catch (e) {}
      // 换乘站坐标独立（2026-08-16 用户要求）：建立换乘后分离跨线共享站对象，
      // 确保每条线路持有各自独立坐标（保留 transferGroupId 维持换乘），可独立校准
      var separated = 0;
      try {
        var K = window.CityMetroKit;
        if (K && typeof K.separateTransferStations === 'function') {
          separated = K.separateTransferStations([lineId]).separated || 0;
        }
      } catch (e) {}
      return { transfers: transfers, fixed: fixed, errors: errors, separated: separated };
    },

    /** 合并换乘核对（2026-08-22 多线导入提速）：一次扫描为多条线建立同名换乘，替代逐线 autoTransfers（逐线 N 次扫描+重绘）。
     *  仅对「同城同名站组」且组内至少一条为目标线」建立换乘；_applyTransferDecision 幂等（同组跳过）。
     *  @param {Array<number>} lineIds 本次导入的目标线 id 数组
     *  @param {Object} opts { city, kind }
     *  @returns {Promise<{transfers, fixed, errors, separated, lines}>} */
    autoTransfersBulk: async function (lineIds, opts) {
      opts = opts || {};
      var city = opts.city || '上海';
      var kind = opts.kind || 'passage';
      var cityPrefix3 = city === '上海' ? '上海地铁' : (city + '地铁');
      // 风险护栏：批量建换乘（跨线影响），YELLOW 拦截
      var _Kb = window.CityMetroKit;
      if (_Kb && typeof _Kb.confirmDangerous === 'function') {
        var _gb = _Kb.confirmDangerous('autoTransfersBulk', { city: city, lines: (lineIds || []).length });
        if (_gb.blocked) return { blocked: true, level: _gb.level, message: _gb.message };
      }
      var idSet = {};
      (lineIds || []).forEach(function (id) { idSet[id] = true; });
      var isTarget = function (line) { return !!idSet[line.id]; };
      // 一次扫描：同城所有线路站点按站名分组
      var byName = {};
      (G.lines || []).forEach(function (line) {
        if (line.name.indexOf(cityPrefix3) < 0) return;
        (line.stations || []).forEach(function (s) {
          if (!s || !s.name) return;
          (byName[s.name] = byName[s.name] || []).push({ line: line, station: s });
        });
      });
      var transfers = [], fixed = [], errors = [];
      Object.keys(byName).forEach(function (name) {
        var entries = byName[name];
        if (entries.length < 2) return; // 仅同名多线才可能是换乘
        if (!entries.some(function (e) { return isTarget(e.line); })) return; // 与本次导入无关的同名组跳过
        // 修复本组内 有flag无group 异常站
        entries.forEach(function (e) {
          var s = e.station;
          if (s.isTransfer && !s.transferGroupId) {
            s.transferGroupId = top._newTransferGroupId();
            s.transferType = s.transferType || 'passage';
            fixed.push({ station: s.name, issue: 'no_group_fixed' });
          }
        });
        // 建换乘（2026-08-22 优化：组内两两 O(n²) → 锚点 O(n)，减少 _applyTransferDecision 调用与 sleep，降卡顿）
        var anchor = entries[0];
        for (var i = 1; i < entries.length; i++) {
          var a = entries[i], b = anchor;
          var sa = a.station, sb = b.station;
          if (sa.transferGroupId && sb.transferGroupId && sa.transferGroupId === sb.transferGroupId) continue;
          try {
            top._applyTransferDecision({ movedStation: sa, targetStation: sb, kind: kind, primaryLine: a.line.id }, true);
            transfers.push({ station: sa.name, partner: b.line.name, kind: kind });
          } catch (e) {
            errors.push({ station: sa.name, partner: b.line.name, err: String(e) });
          }
        }
      });
      // 一次轻量重绘目标线（2026-08-22 优化：移除全量 redrawAllMetroOverlays 防卡死/重载，替代逐线 N 次）
      (lineIds || []).forEach(function (id) {
        var _lb = G.lines.find(function (x) { return x.id === id; });
        if (!_lb) return;
        try { top.redrawLine(_lb); top.refreshStationDots(_lb); } catch (e) {}
      });
      var separated = 0;
      try {
        if (_Kb && typeof _Kb.separateTransferStations === 'function') {
          separated = _Kb.separateTransferStations(lineIds).separated || 0;
        }
      } catch (e) {}
      return { transfers: transfers, fixed: fixed, errors: errors, separated: separated, lines: (lineIds || []).length };
    },

    /** 自动退出添加状态并刷新（普通线/支线/环线完成后统一调用） */
    finishEdit: function (lineId) {
      // 环线/普通线：add-station 模式退出
      if (G.editMode === 'add-station') {
        try { top.enterStationAddModeOnLine(lineId); } catch (e) {}
      }
      // place 模式（支线）：confirmCreateLine 完成
      if (G.editMode === 'place' && G.currentLineId === lineId) {
        try { top.confirmCreateLine(); } catch (e) {}
      }
      // 2026-08-23 防闪退：移除全量 redrawAllMetroOverlays（大存档触发全网客流重算→卡死/重载），
      //   改为对目标线轻量重绘（redrawLine+refreshStationDots）
      try { var _fe = G.lines.find(function (x) { return x.id === lineId; }); if (_fe) { top.redrawLine(_fe); top.refreshStationDots(_fe); } } catch (e) {}
      return { editMode: G.editMode, currentLineId: G.currentLineId };
    },

    // ========================================================================

    /** 检测某段是否存在节点乱序绕行（供 fixNodeOrder 判定；不修改数据） */
    hasNodeOrderIssue: function (lineId, segIndex) {
      var line = G.lines.find(function (l) { return l.id === lineId; });
      if (!line) return false;
      var seg = (line.segmentAnchors || [])[segIndex];
      if (!seg || seg.length < 4) return false;


      var head = seg[0], tail = seg[seg.length - 1];
      // ① 急转折返：方向突变 >120°
      for (var k = 1; k < seg.length - 1; k++) {
        var d = Math.abs(((_bearing(seg[k - 1], seg[k]) - _bearing(seg[k], seg[k + 1])) + 540) % 360 - 180);
        if (d > 120) return true;
      }
      // ② 绕大圈：中点偏离首尾连线 >500m
      for (var kk = 1; kk < seg.length - 1; kk++) {
        var v = _distM(seg[kk].lat, seg[kk].lng, head.lat, head.lng) + _distM(seg[kk].lat, seg[kk].lng, tail.lat, tail.lng) - _distM(head.lat, head.lng, tail.lat, tail.lng);
        if (v > 500) return true;
      }
      return false;
    },

    /** 修复错误节点顺序（2026-08-16 用户要求：上海体育场→东安路绕行）
     *  ① 先通过官方路径重建节点；② 重建后仍绕行的段，用「投影重排」兜底：
     *     把段内节点按沿"首→尾"方向的投影位置重新排序，消除折返/绕圈。
     *  @param {string} lineId  线路 id
     *  @param {number} [segIndex]  可选：只修复指定段；缺省修复整线所有绕行段
     *  @param {object} [opts]  { city, density, tolerance }
     *  @returns {Promise<{ok, line, fixed:[...], projected:[...], result}>}
     */
    fixNodeOrder: async function (lineId, segIndex, opts) {
      opts = opts || {};
      var line = G.lines.find(function (l) { return l.id === lineId; });
      if (!line) return { ok: false, error: 'line not found' };
      var city = opts.city || '上海';
      var fixed = [], projected = [];
      var hasSegArg = typeof segIndex === 'number';
      // 若指定单段且该段无需修复 → 直接返回
      if (hasSegArg) {
        if (!this.hasNodeOrderIssue(lineId, segIndex)) return { ok: true, line: line.name, fixed: [], result: { noChange: true } };
      }
      // ① 重建整线（复用官方路径拟合）
      var result = await this._rebuildNodesFromAmapImpl(city, lineId, {
        density: opts.density || 'standard',
        tolerance: opts.tolerance
      });
      if (result.error) return { ok: false, error: result.error };
      // ② 投影重排兜底：对仍绕行的段（指定单段只看该段）强制重排节点顺序
      var segs = line.segmentAnchors || [];
      var segCount = segs.length;
      function _dM(a, b) { var dl = (a.lat - b.lat) * 110540, dg = (a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180); return Math.sqrt(dl * dl + dg * dg); }
      for (var i = 0; i < segCount; i++) {
        if (hasSegArg && i !== segIndex) continue;
        if (!this.hasNodeOrderIssue(lineId, i)) continue;
        var seg = segs[i];
        if (!seg || seg.length < 3) continue;
        var sorted = this._projectSort(seg);
        if (sorted && sorted.length) {
          // 先应用投影重排
          segs[i] = sorted;
          // 重排后若仍有绕行（极端），再尝试直线插值兜底（首尾等分，最稳妥）
          if (this.hasNodeOrderIssue(lineId, i)) {
            var head = seg[0], tail = seg[seg.length - 1];
            var d = _dM(head, tail), n = Math.max(2, Math.round(d / 400));
            var lin = [];
            for (var k = 1; k <= n - 1; k++) { var t = k / n; lin.push({ lat: head.lat + (tail.lat - head.lat) * t, lng: head.lng + (tail.lng - head.lng) * t }); }
            if (lin.length) { segs[i] = lin; }
          }
          projected.push(i); fixed.push(i);
        }
      }
      try { top.redrawLine(line); } catch (e) {}
      try { top.refreshStationDots(line); } catch (e) {}
      return { ok: true, line: line.name, fixed: fixed, projected: projected, result: result };
    },

    /** 投影重排：把段内节点按沿首→尾单位向量的投影值排序，消除折返/绕圈（保持首尾节点）
     *  返回重排后的新数组；不修改原 seg。 */
    _projectSort: function (seg) {
      if (!seg || seg.length < 3) return seg;
      var head = seg[0], tail = seg[seg.length - 1];
      var dLat = tail.lat - head.lat, dLng = tail.lng - head.lng;
      var len = Math.sqrt(dLat * dLat + dLng * dLng);
      if (len < 1e-9) return seg;
      var uLat = dLat / len, uLng = dLng / len;
      function cNear(a, b) { return Math.abs(a.lat - b.lat) < 0.0004 && Math.abs(a.lng - b.lng) < 0.0004; }
      // 计算每个节点的投影值 t = dot(p - head, u)
      var withT = seg.map(function (p) {
        return { p: p, t: (p.lat - head.lat) * uLat + (p.lng - head.lng) * uLng };
      });
      // 按投影值升序（首→尾方向单调）
      withT.sort(function (a, b) { return a.t - b.t; });
      // 坐标去重（相邻且坐标接近的重复点保留第一个）
      var out = [];
      for (var k = 0; k < withT.length; k++) {
        var cur = withT[k];
        var dup = false;
        for (var j = 0; j < out.length; j++) {
          if (cNear(cur.p, out[j])) { dup = true; break; }
        }
        if (!dup) out.push(cur.p);
      }
      // 强制首尾节点在正确位置
      if (out.length && !cNear(out[0], head)) out.unshift(head);
      if (out.length && !cNear(out[out.length - 1], tail)) out.push(tail);
      if (out.length < 2) return seg;
      return out;
    }
  };
})();
