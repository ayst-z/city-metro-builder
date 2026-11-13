/**
 * MT 查询工具箱 · node（3.0）
 * ─────────────────────────────────────────────────────────────
 * 注入: window.__metroToolkit（与 mt-core / mt-amap 共享同一对象）
 * 职责: 节点拟合（Catmull-Rom 样条 + 曲率抽稀 + 自适应密度）
 * 依赖: mt-core 的 distM（经 MT._distM）/ haversine（经 MT.haversine）
 * 加载顺序: 必须先于 mt-amap 注入（mt-amap 的 queryLine 引用本文件的 fitSegmentNodes/curvatureThin）
 * 公开 API:
 *   catmullRom / sampleCatmull / adaptiveDensity / haversine / localTurn /
 *   curvatureThin / fitSegmentNodes / straightLineNodes / NODE_DENSITY
 */
(function () {
  'use strict';
  var MT = window.__metroToolkit = window.__metroToolkit || {};
  if (MT.__nodeVersion === '6.5.4') return; // 版本守卫：本拆分文件已注入
  // 跨文件依赖（独立 IIFE → 经 MT.* 共享；见 mt-core）
  var distM = MT._distM;        // lat,lng 兼容包装（mt-core）
  var haversine = MT.haversine; // [lng,lat] 权威实现（mt-core）

  // Catmull-Rom 样条插值：给定 4 控制点与参数 t，求平滑曲线上的点。
  //   - 调用方: sampleCatmull（每对相邻控制点间细分插值）
  //   - 签名: catmullRom(p0,p1,p2,p3,t) → [lng,lat]（t∈[0,1]）
  //   - 注意: 点格式为 [lng,lat]；p0/p3 为边界扩展点
  function catmullRom(p0, p1, p2, p3, t) {
    var t2 = t * t, t3 = t2 * t;
    return [
      0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
      0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
    ];
  }

  // 样条采样：每对相邻控制点间按 stepM 米间隔插值，返回密集拟合点（自适应最佳拟合）。
  //   - 调用方: fitSegmentNodes（首先生成密集点，再交 curvatureThin 抽稀）
  //   - 签名: sampleCatmull(pts, stepM) → [[lng,lat],...]
  //   - 逻辑链: catmullRom 逐段细分；点数=ceil(段距/stepM)
  //   - 注意: pts 需 ≥2 点，否则原样返回；stepM 越小越密
  function sampleCatmull(pts, stepM) {
    if (!pts || pts.length < 2) return pts ? pts.slice() : [];
    var out = [pts[0]];
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      var d = distM(p1[1], p1[0], p2[1], p2[0]);
      var n = Math.max(1, Math.round(d / stepM));
      for (var k = 1; k <= n; k++) out.push(catmullRom(p0, p1, p2, p3, k / n));
    }
    return out;
  }

  // ---------- 曲率感知节点抽稀（curvatureThin，与 OD 算法一致，MT 独立可用）----------
  // 三档密度参数（2026-08-16 统一为与 OD.NODE_DENSITY 一致：sparse=15m/standard=12m/dense=8m 容错）。
  //   - sparse: 较疏（devM 15 / 间隔 10500 / 最小间距 90）
  //   - standard: 标准（devM 12 / 间隔 8400 / 最小间距 72）
  //   - dense: 较密（devM 8 / 间隔 5600 / 最小间距 48）
  //   - 被 curvatureThin 在未传 tolerance 时按密度档位取参（传 tolerance 则走 adaptiveDensity）
  var _NODE_DENSITY = {
    sparse:   { devM: 15, maxSpacing: 10500, minGapM: 90,  turnDeg: 45, curvePadM: 80, curveGapM: 160, endPadM: 120 },
    standard: { devM: 12, maxSpacing: 8400,  minGapM: 72,  turnDeg: 45, curvePadM: 72, curveGapM: 160, endPadM: 100 },
    dense:    { devM: 8,  maxSpacing: 5600,  minGapM: 48,  turnDeg: 40, curvePadM: 48, curveGapM: 128, endPadM: 80 }
  };

  // 自适应密度（2026-08-16 用户要求）：按容错在「误差≤容错」内最小节点数；辅助参数随容错缩放；站台回避保留。
  //   - 调用方: curvatureThin / fitSegmentNodes（传 tolerance 时自动生成密度参数）
  //   - 签名: adaptiveDensity(tol=5, overrides?) → 密度参数对象
  //   - 逻辑链: 容错 tol → devM=tol；辅助参数随容错线性缩放并 clamp
  //   - 注意: 以 DP 贴合优先、放宽最小密度限制，尽可能保证节点最少；overrides 可覆盖任意字段
  function adaptiveDensity(tol, overrides) {
    tol = (tol == null) ? 5 : tol;
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    // 2026-08-16 用户要求：以最佳拟合为中心（DP 贴合优先），放宽最小密度限制，尽可能保证节点最少
    var out = {
      devM: tol, maxSpacing: clamp(tol * 700, 2500, 12000), minGapM: clamp(tol * 6, 20, 120),
      turnDeg: clamp(tol * 5, 20, 45), curvePadM: clamp(tol * 6, 30, 80), curveGapM: clamp(tol * 16, 60, 160),
      endPadM: 100
    };
    if (overrides) Object.keys(overrides).forEach(function (k) { out[k] = overrides[k]; });
    return out;
  }

  // 局部转角（度）：三点 p0→p1→p2 的航向变化。
  //   - 调用方: curvatureThin（判断弯道是否需要加密节点）
  //   - 签名: localTurn(p0,p1,p2) → 0~180 度
  //   - 注意: 点格式 [lng,lat]；转角>turnDeg 视为弯道
  function localTurn(p0, p1, p2) {
    function ang(a, b) {
      var dLat = b[1] - a[1], dLng = b[0] - a[0];
      var deg = Math.atan2(dLng * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180), dLat) * 180 / Math.PI;
      return (deg + 360) % 360;
    }
    var h1 = ang(p0, p1), h2 = ang(p1, p2);
    var d = Math.abs(h2 - h1); d = d % 360; if (d > 180) d = 360 - d;
    return d;
  }

  // 曲率感知抽稀：DP 贴合 + 弯道渐变加密 + 直线均匀化 + 全局间距平滑，生成最终节点序列。
  //   - 调用方: mt-amap 的 queryLine（对 fitSegmentNodes 结果再抽稀）；OD 共享
  //   - 签名: curvatureThin(pts, opts) → [[lng,lat],...]
  //   - opts: { density:'sparse'|'standard'|'dense' 或 tolerance(容错米), maxRatio=1.8, devM/maxSpacing/... 可覆盖 }
  //   - 逻辑链: DP(devM) → 弯道渐变(gradientPoints) → 均匀化(maxSpacing) → 过滤(minGapM) → 间距平滑(maxRatio)
  //   - 注意: 传 tolerance 用 adaptiveDensity 自动取参；否则按 density 档位；maxRatio 控制相邻间距比≤1.8（防突变）
  function curvatureThin(pts, opts) {
    if (typeof opts === 'string') opts = { density: opts };
    opts = opts || {};
    // 自适应密度：传 tolerance（容错，数字）→ 在容错内最小节点数；否则按密度档位
    var den = (opts.tolerance != null) ? adaptiveDensity(opts.tolerance, opts)
      : (_NODE_DENSITY[opts.density] || _NODE_DENSITY.standard);
    var devM = opts.devM != null ? opts.devM : den.devM;
    var maxSpacing = opts.maxSpacing != null ? opts.maxSpacing : den.maxSpacing;
    var turnDeg = opts.turnDeg != null ? opts.turnDeg : den.turnDeg;
    var curvePadM = opts.curvePadM != null ? opts.curvePadM : den.curvePadM;
    var curveGapM = opts.curveGapM != null ? opts.curveGapM : den.curveGapM;
    var minGapM = opts.minGapM != null ? opts.minGapM : den.minGapM;
    if (!pts || pts.length < 3) return pts ? pts.slice() : [];
    function distToSegM(p, A, B) {
      var px = p[0], py = p[1], ax = A[0], ay = A[1], bx = B[0], by = B[1];
      var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      var t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      var cx = ax + t * dx, cy = ay + t * dy;
      var dLat = (py - cy) * 110540, dLng = (px - cx) * 111320 * Math.cos(py * Math.PI / 180);
      return Math.sqrt(dLat * dLat + dLng * dLng);
    }
    function dp(list, eps) {
      if (list.length < 3) return list.slice();
      var dmax = 0, index = 0, A = list[0], B = list[list.length - 1];
      for (var i = 1; i < list.length - 1; i++) { var d = distToSegM(list[i], A, B); if (d > dmax) { index = i; dmax = d; } }
      if (dmax > eps) { var r1 = dp(list.slice(0, index + 1), eps); var r2 = dp(list.slice(index), eps); return r1.slice(0, -1).concat(r2); }
      return [list[0], list[list.length - 1]];
    }
    var res = dp(pts, devM);
    if (res.length < 3) return res;
    // 渐变密度（2026-08-16 用户要求）：弯道中心两侧，间距从 curveGapM 平滑渐增到 maxSpacing，
    // 密度均匀变化（不突变）、相邻间距均匀、弯道转角分摊到多个渐变节点（防尖角）
    function gradientPoints(P, Q, seg) {
      // 整段 P→Q 间距从 curveGapM 平滑渐增到 maxSpacing（弯道密→直线疏，不突变、防尖角）
      var pts2 = [];
      var dist = 0, gap = curveGapM;
      while (dist + gap <= seg - 0.001 && gap > 0) {
        dist += gap;
        var t = dist / seg;
        pts2.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
        gap = curveGapM + (maxSpacing - curveGapM) * Math.min(1, dist / seg); // 间距线性渐增（平滑过渡）
        if (gap < minGapM) gap = minGapM;
        if (gap > maxSpacing) gap = maxSpacing;
      }
      return pts2;
    }
    var out = [res[0]];
    // 每条边只遍历一次，合并两端弯道的加密点，避免重叠区折返。
    for (var c = 1; c < res.length; c++) {
      var P0 = res[c - 1], P1 = res[c], seg = haversine(P0, P1), candidates = [];
      if (c > 1 && localTurn(res[c - 2], P0, P1) > turnDeg) candidates = gradientPoints(P0, P1, seg);
      if (c + 1 < res.length && localTurn(P0, P1, res[c + 1]) > turnDeg) candidates = candidates.concat(gradientPoints(P1, P0, seg));
      candidates.sort(function (a, b) { return haversine(P0, a) - haversine(P0, b); });
      for (var p = 0; p < candidates.length; p++) out.push(candidates[p]);
      out.push(P1);
    }
    // 均匀化：直线长段按 maxSpacing 等分插点
    var uniform = [out[0]];
    for (var u = 1; u < out.length; u++) {
      var A2 = out[u - 1], B2 = out[u];
      var gap = haversine(A2, B2);
      if (gap > maxSpacing) {
        var parts = Math.ceil(gap / maxSpacing);
        for (var k = 1; k < parts; k++) uniform.push([A2[0] + (B2[0] - A2[0]) * k / parts, A2[1] + (B2[1] - A2[1]) * k / parts]);
      }
      uniform.push(B2);
    }
    // 密度控制：先过滤 < minGapM 的密集点（防过密），保留首末点
    var sparse = [];
    for (var s = 0; s < uniform.length; s++) { if (!sparse.length) { sparse.push(uniform[s]); continue; } if (haversine(sparse[sparse.length - 1], uniform[s]) >= minGapM) sparse.push(uniform[s]); }
    if (sparse.length > 1 && haversine(sparse[sparse.length - 1], uniform[uniform.length - 1]) < minGapM) { sparse[sparse.length - 1] = uniform[uniform.length - 1]; }
    else if (sparse.length === 1) { sparse.push(uniform[uniform.length - 1]); }
    // 全局间距渐变平滑（2026-08-16 用户要求：密度均匀变化不突变，相邻间距平滑，防尖角）：
    // 过滤后对最终节点迭代平滑——相邻间距比超 maxRatio（任意方向）时，在长段内插入等比渐变过渡点，
    // 使整条线间距平滑衔接弯道与直线（迭代 ≤3 次收敛，确保真实数据 maxRatio 达标）
    var maxRatio = opts.maxRatio != null ? opts.maxRatio : 1.8;
    var result = sparse;
    for (var iter = 0; iter < 3; iter++) {
      var smoothed = [result[0]];
      var changed = false;
      for (var v = 1; v < result.length; v++) {
        var A = result[v - 1], B = result[v];
        var dCur = haversine(A, B);
        var dPrev = (v > 1) ? haversine(result[v - 2], result[v - 1]) : dCur;
        var dNext = (v < result.length - 1) ? haversine(result[v], result[v + 1]) : dCur;
        if ((dPrev > 0 && dCur > maxRatio * dPrev) || (dNext > 0 && dCur > maxRatio * dNext)) {
          var shortGap = Math.max(Math.min(dPrev, dNext, dCur), minGapM);
          var g = shortGap, dist = 0, it2 = 300;
          while (dist + g <= dCur - minGapM && it2-- > 0) {
            dist += g;
            var t = dist / dCur;
            var pt = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
            if (haversine(smoothed[smoothed.length - 1], pt) >= minGapM) { smoothed.push(pt); changed = true; }
            g = Math.min(g * maxRatio, dCur);
          }
        }
        smoothed.push(B);
      }
      result = smoothed;
      if (!changed) break;
    }
    return result;
  }

  // 站间段节点拟合：站 + 高德 path → Catmull-Rom 密集拟合 + 站台避让 → 每站间段节点。
  //   - 调用方: mt-amap 的 queryLine（核心节点生成）
  //   - 签名: fitSegmentNodes(stations, path, opts) → [seg1, seg2, ...]，seg=[ [lng,lat],... ]
  //   - opts: { density:'sparse'|'standard'|'dense'（默认 standard）, endPadM: 站台避让半径, stepM: 采样间隔, tolerance }
  //   - 逻辑链: projIdx 将站投影到 path → 取段内 path 点 → sampleCatmull 密集采样 → 首末贴站 → padFilter 站台避让
  //   - 注意: 传 tolerance 时采样间隔随容错缩放；段内无节点时保留中点防空段
  function fitSegmentNodes(stations, path, opts) {
    // 自适应最佳拟合：站 + 高德参考点 → Catmull-Rom 样条按 stepM 间隔密集拟合，
    // 再交 curvatureThin 曲率抽稀（弯道密、直线疏，无固定节点数上限）
    // opts: { density: 'sparse'|'standard'|'dense'（默认 standard）, endPadM: 站台避让半径,
    //         stepM: 采样间隔 }（兼容旧数字 maxPerSeg 调用）
    var o = typeof opts === 'object' && opts ? opts : {};
    // 自适应密度（2026-08-16）：传 tolerance → 采样间隔随容错缩放（容错大→采样疏），站台回避 endPadM 保留
    var _t = (o.tolerance != null) ? adaptiveDensity(o.tolerance) : null;
    var _d = _t
      ? { stepM: Math.max(20, Math.min(80, o.tolerance * 8)), endPadM: _t.endPadM }
      : { sparse: { stepM: 60, endPadM: 120 }, standard: { stepM: 40, endPadM: 100 }, dense: { stepM: 25, endPadM: 80 } }[(o.density || 'standard')];
    var stepM = o.stepM != null ? o.stepM : _d.stepM;
    var endPadM = o.endPadM != null ? o.endPadM : _d.endPadM;
    function padFilter(pts, A, B) {
      var res = [];
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        if (distM(A.lat, A.lng, p[1], p[0]) > endPadM && distM(B.lat, B.lng, p[1], p[0]) > endPadM) res.push(p);
      }
      if (!res.length && pts.length) res = [pts[Math.floor(pts.length / 2)]]; // 防空段：保留中点
      return res;
    }
    var st = stations || [];
    if (!Array.isArray(st) || st.length < 2 || !path || path.length < 2) return [];
    function projIdx(lat, lng) {
      var best = 0, bd = Infinity;
      for (var j = 0; j < path.length; j++) {
        var d = Math.hypot((lng - path[j][0]) * 111320 * Math.cos(lat * Math.PI / 180), (lat - path[j][1]) * 110540);
        if (d < bd) { bd = d; best = j; }
      }
      return best;
    }
    var segs = [];
    for (var i = 0; i < st.length - 1; i++) {
      var A = st[i], B = st[i + 1];
      var ia = projIdx(A.lat, A.lng), ib = projIdx(B.lat, B.lng);
      var a = Math.min(ia, ib), b = Math.max(ia, ib);
      var pts = [[A.lng, A.lat]];
      for (var x = a + 1; x < b && x < path.length; x++) pts.push([path[x][0], path[x][1]]);
      pts.push([B.lng, B.lat]);
      var out = sampleCatmull(pts, stepM);
      // 首末贴站（采样点离站>60m 则贴到站上）
      if (out.length && distM(A.lat, A.lng, out[0][1], out[0][0]) > 60) out[0] = [A.lng, A.lat];
      if (out.length > 1 && distM(B.lat, B.lng, out[out.length - 1][1], out[out.length - 1][0]) > 60) out[out.length - 1] = [B.lng, B.lat];
      // 站台避让：车站站台范围（endPadM）内不放置节点（首末贴站点与近台点剔除；防空段保留中点）
      segs.push(padFilter(out, A, B));
    }
    return segs;
  }

  // 站间直线插值节点（无高德 path 时兜底）：每站间按 500m 等分生成 1~2 个中间节点。
  //   - 调用方: mt-amap 的 queryOsmOverpass/_queryLineLocal/queryLine 有轨电车（无走向 path 兜底）
  //   - 签名: straightLineNodes(stations) → [[[lng,lat],...],...]（每段一组节点）
  //   - 逻辑: 站间 haversine 距离 d → parts=max(1,min(2,round(d/500))) → 等分插值
  function straightLineNodes(stations) {
    var nodes = [];
    for (var k = 0; k < stations.length - 1; k++) {
      var a = stations[k], b = stations[k + 1];
      var d = MT.haversine([a.lng, a.lat], [b.lng, b.lat]);
      var parts = Math.max(1, Math.min(2, Math.round(d / 500)));
      var seg = [];
      for (var p = 1; p < parts; p++) seg.push([a.lng + (b.lng - a.lng) * p / parts, a.lat + (b.lat - a.lat) * p / parts]);
      nodes.push(seg);
    }
    return nodes;
  }

  // ===== 导出 =====
  // 样条插值：公开 API（OD 可引用）
  MT.catmullRom = catmullRom;
  // 样条采样：公开 API
  MT.sampleCatmull = sampleCatmull;
  // 自适应密度：公开 API（OD 委托，权威实现）
  MT.adaptiveDensity = adaptiveDensity;
  // 局部转角：公开 API（统一共享工具，引用 mt-core 的 haversine）
  MT.localTurn = localTurn;
  // 曲率抽稀：公开 API（OD 委托，权威实现）
  MT.curvatureThin = curvatureThin;
  // 站间段拟合：公开 API（mt-amap 的 queryLine 依赖）
  MT.fitSegmentNodes = fitSegmentNodes;
  // 站间直线插值节点：公开 API（无 path 兜底，mt-amap 三处复用）
  MT.straightLineNodes = straightLineNodes;
  // 站台避让：任何直写 segmentAnchors 的路径都必须先过此函数。
  // stations=[{lat,lng}]，segs=[[[lng,lat],...],...]（每段节点）；返回同结构。
  // 规则：距两端车站 < endPadM（默认 100m）的节点剔除；剔空则取段中点（绝不落在站点上）。
  function padSegmentNodes(stations, segs, opts) {
    var o = opts || {};
    var pad = o.endPadM != null ? o.endPadM : 100;
    var st = stations || [];
    var out = [];
    for (var i = 0; i < st.length - 1; i++) {
      var A = st[i], B = st[i + 1];
      var seg = (segs && segs[i]) || [];
      if (!A || !B) { out.push(seg); continue; }
      var kept = [];
      for (var j = 0; j < seg.length; j++) {
        var p = seg[j];
        if (distM(A.lat, A.lng, p[1], p[0]) >= pad && distM(B.lat, B.lng, p[1], p[0]) >= pad) kept.push(p);
      }
      if (!kept.length) kept.push([(A.lng + B.lng) / 2, (A.lat + B.lat) / 2]);
      out.push(kept);
    }
    return out;
  }
  MT.padSegmentNodes = padSegmentNodes;
  // 站间平滑插值（无高德 path 时的“拟合”回退）：向心 Catmull-Rom 过全部站，按 ~60m 采样，
  // 再做站台避让。输出与 fitSegmentNodes 相同的多段结构；仅用于未开通段，标记估算。
  function smoothLineNodes(stations, opts) {
    var o = opts || {};
    var pad = o.endPadM != null ? o.endPadM : 100;
    var stepM = o.stepM != null ? o.stepM : 60;
    var st = stations || [];
    if (!Array.isArray(st) || st.length < 2) return [];
    var P = st.map(function (s) { return [s.lng, s.lat]; });
    function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
    function cr(p0, p1, p2, p3, t) {
      var d01 = Math.pow(Math.max(1e-6, distM(p0[1], p0[0], p1[1], p1[0])), 0.5);
      var d12 = Math.pow(Math.max(1e-6, distM(p1[1], p1[0], p2[1], p2[0])), 0.5);
      var d23 = Math.pow(Math.max(1e-6, distM(p2[1], p2[0], p3[1], p3[0])), 0.5);
      var t0 = 0, t1 = d01, t2 = t1 + d12, t3 = t2 + d23;
      var u = t1 + (t2 - t1) * t;
      var A1 = lerp(p0, p1, (u - t0) / (t1 - t0));
      var A2 = lerp(p1, p2, (u - t1) / (t2 - t1));
      var A3 = lerp(p2, p3, (u - t2) / (t3 - t2));
      var B1 = lerp(A1, A2, (u - t0) / (t2 - t0));
      var B2 = lerp(A2, A3, (u - t1) / (t3 - t1));
      return lerp(B1, B2, (u - t1) / (t2 - t1));
    }
    var out = [];
    for (var i = 0; i < st.length - 1; i++) {
      var A = st[i], B = st[i + 1];
      var p0 = P[i - 1] || P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] || P[i + 1];
      var d = distM(p1[1], p1[0], p2[1], p2[0]);
      var n = Math.max(1, Math.ceil(d / stepM));
      var seg = [];
      for (var j = 1; j < n; j++) {
        var q = cr(p0, p1, p2, p3, j / n);
        if (distM(A.lat, A.lng, q[1], q[0]) >= pad && distM(B.lat, B.lng, q[1], q[0]) >= pad) seg.push(q);
      }
      if (!seg.length) seg.push([(A.lng + B.lng) / 2, (A.lat + B.lat) / 2]);
      out.push(seg);
    }
    return out;
  }
  MT.smoothLineNodes = smoothLineNodes;
  // 密度档位常量：共享（OD 可引用）
  MT.NODE_DENSITY = _NODE_DENSITY;
  MT.__nodeVersion = '6.5.4';
})();
