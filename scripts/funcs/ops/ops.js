/**
 * MetroOps — 客流驱动的排班/票价优化（只读计算 + 受控写入）
 * =========================================================
 * 注入: window.MetroOps
 * 依赖: G.lines / readRouteLegsFromLine / applyRouteLegSlotCount / calcLineHeadwayMin /
 *       getTrainCap / MetroFarePolicy / MetroEconomy / metroApplyFareRulesChanged
 * 加载顺序: 在 K 之后（可选，不注入也能绘线）
 * 公开 API:
 *   hourlyDemand(lineId) / recommendSchedule(lineId,opts) / applySchedule(lineId,rec) / restoreSchedule(lineId,original)
 *   readFares() / recommendFares(opts) / applyFares(rules) / audit()
 * 说明:
 *   - 排班按 24h 客流（station.flowByLine[lineId].boardedWindow 1440 分钟）分 peak/off/low 三档
 *   - 需求→列车数: ceil(peakHourDemand * roundTripMin / (60 * trainCap * loadFactor))，再用官方函数钳制
 *   - 票价是全网 metro 规则（MetroEconomy.getFareRules().metro），不是单线
 *   - 所有写入前建议 K.snapshot；applySchedule 返回 original 便于 restoreSchedule
 */
(function () {
  'use strict';
  if (window.MetroOps && window.MetroOps.__version === '1.3.5') return;

  var SLOTS = ['peak', 'off', 'low'];
  var OPS = window.MetroOps = { __version: '1.3.5' };

  function lineOf(idOrLine) {
    if (!idOrLine) return null;
    if (typeof idOrLine === 'string') return ((window.G && window.G.lines) || []).find(function (l) { return l.id === idOrLine; }) || null;
    return idOrLine;
  }
  function legsOf(line) {
    try { return readRouteLegsFromLine(line) || []; } catch (e) { return []; }
  }
  function roundTripMin(line) {
    try { return calcLineHeadwayMin(1, line); } catch (e) { return null; }
  }
  function capacityOf(line) {
    try { return getTrainCap(line) || null; } catch (e) { return null; }
  }
  function headwayOf(trains, line) {
    if (!(trains > 0)) return null;
    try { return calcLineHeadwayMin(trains, line); } catch (e) { return null; }
  }
  function loadFactor() {
    var v = Number(window.METRO_TRAIN_OPERATIONAL_LOAD_FACTOR);
    return (isFinite(v) && v > 0) ? v : 1.1;
  }

  // 24h 客流：优先 boardedWindow（1440 分钟，按站聚合），回退 flow.byHour
  OPS.hourlyDemand = function (idOrLine) {
    var line = lineOf(idOrLine);
    if (!line) return { ok: false, reason: 'line not found' };
    var agg = new Array(24).fill(0);
    var winLen = 0;
    (line.stations || []).forEach(function (s) {
      var w = s.flowByLine && s.flowByLine[line.id] && s.flowByLine[line.id].boardedWindow;
      if (!Array.isArray(w) || !w.length) return;
      winLen = Math.max(winLen, w.length);
      var step = Math.max(1, Math.floor(w.length / 24));
      for (var h = 0; h < 24; h++) {
        var sum = 0, end = Math.min(w.length, (h + 1) * step);
        for (var i = h * step; i < end; i++) sum += (w[i] || 0);
        agg[h] += sum;
      }
    });
    if (!winLen && line.flow && Array.isArray(line.flow.byHour)) {
      line.flow.byHour.forEach(function (x, h) {
        if (x) agg[h] += (x.on || 0) + (x.in || 0);
      });
    }
    var total = agg.reduce(function (a, b) { return a + b; }, 0);
    var peak = agg.reduce(function (a, b) { return Math.max(a, b); }, 0);
    return { ok: true, lineId: line.id, hours: agg, total: total, peakHourDemand: peak, minuteWindow: winLen, dataSource: winLen ? 'boardedWindow' : 'flow.byHour' };
  };

  function classifyHours(hours) {
    var service = [];
    for (var h = 0; h < 24; h++) if (hours[h] > 0) service.push({ hour: h, demand: hours[h] });
    if (!service.length) return { peak: { hours: [], maxDemand: 0 }, off: { hours: [], maxDemand: 0 }, low: { hours: [], maxDemand: 0 } };
    var vals = service.map(function (x) { return x.demand; }).sort(function (a, b) { return a - b; });
    var q = function (p) { return vals[Math.min(vals.length - 1, Math.floor((vals.length - 1) * p))]; };
    var p25 = q(0.25), p75 = q(0.75);
    var out = { peak: { hours: [], maxDemand: 0 }, off: { hours: [], maxDemand: 0 }, low: { hours: [], maxDemand: 0 } };
    service.forEach(function (x) {
      var slot = x.demand >= p75 ? 'peak' : (x.demand <= p25 ? 'low' : 'off');
      out[slot].hours.push(x.hour);
      out[slot].maxDemand = Math.max(out[slot].maxDemand, x.demand);
    });
    return out;
  }

  // 排班推荐：三档列车数 + 对应间隔
  OPS.recommendSchedule = function (idOrLine, opts) {
    opts = opts || {};
    var line = lineOf(idOrLine);
    if (!line) return { ok: false, reason: 'line not found' };
    var demand = OPS.hourlyDemand(line);
    if (!demand.ok) return demand;
    var cap = capacityOf(line);
    var rt = roundTripMin(line);
    var lf = opts.loadFactor || loadFactor();
    var slots = classifyHours(demand.hours);
    var current = legsOf(line).map(function (x) { return { peak: x.freqPeak, off: x.freqOff, low: x.freqLow }; });
    var unobservedSlots = SLOTS.filter(function (slot) { return !slots[slot].hours.length; });
    var rec = {};
    SLOTS.forEach(function (slot) {
      var d = slots[slot].maxDemand || 0;
      var n = (d > 0 && cap > 0 && rt > 0) ? Math.ceil(d * rt / (60 * cap * lf)) : 0;
      n = Math.max(0, Math.min(opts.maxTrains != null ? opts.maxTrains : 40, n));
      if (d > 0 && n < 1) n = 1;
      if (!slots[slot].hours.length) {
        n = current.reduce(function (max, leg) { return Math.max(max, Number(leg[slot]) || 0); }, 0);
      }
      rec[slot] = n;
    });
    // 保证高峰不少于平峰、平峰不少于低峰（有服务时）
    if (rec.peak < rec.off) rec.peak = rec.off;
    if (rec.off < rec.low) rec.off = rec.low;
    var hw = {};
    SLOTS.forEach(function (s) { hw[s] = headwayOf(rec[s], line); });
    return {
      ok: true, lineId: line.id, lineName: line.name,
      capacity: cap, roundTripMin: rt, loadFactor: lf,
      demand: demand, slots: slots, recommendation: rec, headway: hw,
      current: current, unobservedSlots: unobservedSlots
    };
  };

  // 应用排班：返回 original 便于还原
  OPS.applySchedule = function (idOrLine, rec, opts) {
    opts = opts || {};
    var line = lineOf(idOrLine);
    if (!line) return { ok: false, reason: 'line not found' };
    if (!rec || typeof rec !== 'object') return { ok: false, reason: 'rec required' };
    var legs = legsOf(line);
    if (legs.length > 1 && opts.legIndex == null) return { ok: false, reason: 'multi-leg requires legIndex' };
    var legIndex = opts.legIndex == null ? 0 : opts.legIndex;
    if (!Number.isInteger(legIndex) || legIndex < 0 || legIndex >= legs.length) return { ok: false, reason: 'invalid legIndex' };
    var original = legs.map(function (x) { return { peak: x.freqPeak, off: x.freqOff, low: x.freqLow }; });
    var applied = [];
    SLOTS.forEach(function (slot) {
      if (rec[slot] == null) return;
      var v = applyRouteLegSlotCount(line, legIndex, slot, 'local', rec[slot]);
      applied.push({ leg: legIndex, slot: slot, wanted: rec[slot], actual: v });
    });
    var after = legsOf(line).map(function (x) { return { peak: x.freqPeak, off: x.freqOff, low: x.freqLow }; });
    return { ok: true, lineId: line.id, original: original, applied: applied, after: after };
  };

  OPS.restoreSchedule = function (idOrLine, original) {
    var line = lineOf(idOrLine);
    if (!line || !original || !original.length) return { ok: false, reason: 'line/original required' };
    var legs = legsOf(line);
    for (var i = 0; i < legs.length && i < original.length; i++) {
      if (original[i].peak != null) applyRouteLegSlotCount(line, i, 'peak', 'local', original[i].peak);
      if (original[i].off != null) applyRouteLegSlotCount(line, i, 'off', 'local', original[i].off);
      if (original[i].low != null) applyRouteLegSlotCount(line, i, 'low', 'local', original[i].low);
    }
    return { ok: true, after: legsOf(line).map(function (x) { return { peak: x.freqPeak, off: x.freqOff, low: x.freqLow }; }) };
  };

  // 票价需求模型：官方 metroFareDemandPenaltyForFare(fare, baseline)
  //   - 国内基准 0.75；票价/基准 <=1 时需求最高 +12%，>1 时指数衰减（fare=2 只剩 ~24%，fare=3 ~4%）
  function fareBaseline() {
    try {
      if (typeof metroFareDemandBaselineForCity === 'function') return metroFareDemandBaselineForCity((window.G && window.G.cityKey) || '');
    } catch (e) {}
    return 0.75;
  }
  function demandPenalty(fare) {
    var base = fareBaseline();
    try {
      if (typeof metroFareDemandPenaltyForFare === 'function') return metroFareDemandPenaltyForFare(fare, base);
    } catch (e) {}
    var d = window.MetroFarePolicy && window.MetroFarePolicy.demand;
    return typeof d === 'function' ? d(fare / base) : 1;
  }
  function revenueCurve(maxFare) {
    var out = [];
    var max = Math.max(3, Number(maxFare) || 3);
    for (var f = 0.5; f <= max + 0.001; f += 0.05) {
      var fare = +f.toFixed(2);
      var p = demandPenalty(fare);
      out.push({ fare: fare, penalty: +p.toFixed(3), revenueIndex: +(fare * p).toFixed(3) });
    }
    return out;
  }
  function bestFareForBand(baseFare, goal) {
    var curve = revenueCurve(Math.max(3, Number(baseFare) * 1.5 || 3));
    var pick = curve[0];
    curve.forEach(function (c) {
      if (goal === 'ridership') { if (c.penalty > pick.penalty) pick = c; }
      else if (goal === 'balance') { if (c.revenueIndex * c.penalty > pick.revenueIndex * pick.penalty) pick = c; }
      else if (c.revenueIndex > pick.revenueIndex) pick = c;
    });
    return { pick: pick, curve: curve };
  }

  // 票价：读取/推荐/应用（全网 metro）
  OPS.readFares = function () {
    try {
      var r = window.MetroEconomy && window.MetroEconomy.getFareRules && window.MetroEconomy.getFareRules();
      return (r && r.metro) || null;
    } catch (e) { return null; }
  };

  function defaultLadder(n) {
    var base = [1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35];
    return base.slice(0, Math.max(1, Math.min(base.length, n)));
  }

  OPS.recommendFares = function (opts) {
    opts = opts || {};
    var cur = OPS.readFares();
    if (!cur || !Array.isArray(cur.distanceBands) || !cur.distanceBands.length) return { ok: false, reason: 'fare rules unavailable' };
    var goal = opts.goal || 'revenue';
    var baseline = fareBaseline();
    // 经营模式（management）默认官方五段：与成本带/补贴对齐才是利润最优；
    // 需求弹性 1.05/阶梯只适用于忽略成本补贴的创意小网络（opts.creative 显式启用）。
    var business = (window.G && G.economyMode === 'management');
    if (business && opts.creative !== true) {
      var officialBands = [
        { fromKm: 0, toKm: 6, fare: 1 }, { fromKm: 6, toKm: 12, fare: 2 },
        { fromKm: 12, toKm: 22, fare: 3 }, { fromKm: 22, toKm: 32, fare: 4 },
        { fromKm: 32, toKm: null, fare: 5 }
      ];
      return {
        ok: true, goal: goal, mode: 'official5', official5: true, baseline: baseline, current: cur,
        recommendation: { policyVersion: cur.policyVersion, mode: 'distanceStep', distanceBands: officialBands },
        note: '经营模式默认官方五段 1/2/3/4/5（边界 0/6/12/22/32/∞，与成本带 0.45/1.30/2.15/3.00/3.80 及补贴对齐，利润最优）；创意小网络才用需求弹性 1.05/阶梯（opts.creative:true）'
      };
    }
    var tiered = opts.tiered !== false;
    var flatFare = 1.05;
    var flatPenalty = demandPenalty(flatFare);
    var wid = function (b) { return (b.toKm == null ? 10 : Math.max(1, Number(b.toKm) - Number(b.fromKm || 0))); };
    var flatRev = cur.distanceBands.reduce(function (a, b) { return a + wid(b) * flatFare * flatPenalty; }, 0);
    var ladder = null;
    var bands;
    if (tiered) {
      ladder = opts.ladder || defaultLadder(cur.distanceBands.length);
      bands = cur.distanceBands.map(function (b, i) {
        var fare = Number(ladder[Math.min(i, ladder.length - 1)]) || flatFare;
        return { fromKm: b.fromKm, toKm: b.toKm, fare: fare, _penalty: demandPenalty(fare), _weight: wid(b) };
      });
    } else {
      bands = cur.distanceBands.map(function (b) {
        var best = bestFareForBand(Number(b.fare) || 1, goal);
        return { fromKm: b.fromKm, toKm: b.toKm, fare: best.pick.fare, _penalty: best.pick.penalty, _weight: wid(b) };
      });
    }
    var rev = bands.reduce(function (a, b) { return a + b._weight * b.fare * b._penalty; }, 0);
    var rid = bands.reduce(function (a, b) { return a + b._weight * b._penalty; }, 0);
    var maxCur = cur.distanceBands.reduce(function (m, b) { return Math.max(m, Number(b.fare) || 0); }, 0);
    return {
      ok: true, goal: goal, mode: tiered ? 'tiered' : 'flat', baseline: baseline, current: cur,
      recommendation: { policyVersion: cur.policyVersion, mode: cur.mode, distanceBands: bands.map(function (b) { return { fromKm: b.fromKm, toKm: b.toKm, fare: b.fare }; }) },
      revenueIndex: +rev.toFixed(3), ridershipIndex: +rid.toFixed(3),
      ladder: ladder, flatOptimal: flatFare, flatPenalty: +flatPenalty.toFixed(3), flatRevenueIndex: +flatRev.toFixed(3),
      curve: revenueCurve(Math.max(3, maxCur * 1.5)),
      demandModel: 'metroFareDemandPenaltyForFare(fare,' + baseline + ')',
      note: tiered
        ? '阶梯票价：短途 1.05、长途逐级递增（默认 1.05/1.10/1.15/1.20/1.25（温和阶梯））；官方弹性下单程收入上限仍是 1.05，阶梯用于长途收益/公平；OD overlay 激活后需复核长途需求'
        : '平票收入最优约 1.05；票价 2 时需求约 24%，3 时约 4%'
    };
  };

  // 票价-需求-收入曲线（只读）
  OPS.fareModel = function (maxFare) {
    return { baseline: fareBaseline(), curve: revenueCurve(maxFare || 5) };
  };

  OPS.applyFares = function (rules) {
    if (!rules || !Array.isArray(rules.distanceBands)) return { ok: false, reason: 'rules.distanceBands required' };
    try {
      if (!window.MetroEconomy || typeof window.MetroEconomy.setFareRules !== 'function') return { ok: false, reason: 'MetroEconomy.setFareRules unavailable' };
      window.MetroEconomy.setFareRules('metro', rules);
      if (typeof metroApplyFareRulesChanged === 'function') metroApplyFareRulesChanged();
      var g = window.G || {};
      return { ok: true, rules: OPS.readFares(), overlayActive: !!g._metroFareDemandOverlayActive, odReady: !!g.hourlyODBase };
    } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
  };

  // ===== 综合收益优化：票价 + 列车数 + 快车 + 短交路 =====
  function stationWeight(s, line) {
    var f = s && s.flowByLine && s.flowByLine[line.id];
    var samples = f && f.boardedWindow;
    return Array.isArray(samples) ? samples.reduce(function (sum, value) { return sum + (Number(value) || 0); }, 0) : 0;
  }
  function busiestWindow(line, frac) {
    var st = (line && line.stations) || [];
    var n = st.length;
    if (n < 4) return null;
    var w = Math.max(3, Math.min(n, Math.ceil(n * frac)));
    var weights = st.map(function (s) { return stationWeight(s, line); });
    var sum = weights.slice(0, w).reduce(function (a, b) { return a + b; }, 0);
    var best = { startIdx: 0, endIdx: w - 1, sum: sum };
    for (var i = 1; i + w <= n; i++) {
      sum += weights[i + w - 1] - weights[i - 1];
      if (sum > best.sum) best = { startIdx: i, endIdx: i + w - 1, sum: sum };
    }
    return best.sum > 0 ? best : null;
  }
  function hasExpress(line) {
    try { return typeof lineHasExpress === 'function' ? !!lineHasExpress(line) : !!(line.expressStops && line.expressStops.length >= 2); } catch (e) { return false; }
  }
  function expressQuotaLeft() {
    try { var q = window.MetroEconomy.getFinanceSnapshot().quotas.metro.expressLines || {}; return Math.max(0, Number(q.total || 0) - Number(q.used || 0)); } catch (e) { return 0; }
  }

  // 只读：每条线的排班/快车/短交路建议（票价全网一次）
  OPS.recommendNetwork = function (opts) {
    opts = opts || {};
    var lines = opts.lineIds ? opts.lineIds.map(lineOf).filter(Boolean) : (((window.G && G.lines) || []).slice());
    var fare = OPS.recommendFares({ goal: opts.fareGoal || 'revenue' });
    var out = { ok: true, fare: fare.recommendation, fareDetail: fare, lines: [] };
    var exprLeft = expressQuotaLeft();
    lines.forEach(function (l) {
      var s = OPS.recommendSchedule(l, { maxTrains: opts.maxTrains || 30 });
      var expr = null;
      if (s.demand.total > 0 && !hasExpress(l) && l.stations && l.stations.length >= 3 && exprLeft > 0) {
        var n = l.stations.length;
        var idx = [0, n - 1];
        l.stations.map(function (st, i) { return { i: i, w: stationWeight(st, l) }; })
          .sort(function (a, b) { return b.w - a.w; }).slice(0, 3)
          .forEach(function (x) { if (idx.indexOf(x.i) < 0) idx.push(x.i); });
        idx.sort(function (a, b) { return a - b; });
        expr = { stops: idx, caps: { peak: 1, off: 0, low: 0 } };
        exprLeft--;
      }
      var shortTurn = null;
      var legs = [];
      try { legs = readRouteLegsFromLine(l) || []; } catch (e) { legs = []; }
      if (legs.length <= 1 && l.stations && l.stations.length >= 6) {
        var bw = busiestWindow(l, 0.6);
        if (bw && (bw.startIdx > 0 || bw.endIdx < l.stations.length - 1)) {
          shortTurn = { startIdx: bw.startIdx, endIdx: bw.endIdx, freqPeak: 2, freqOff: 0, freqLow: 0 };
        }
      }
      out.lines.push({ id: l.id, name: l.name, schedule: s.recommendation, current: s.current, demand: s.demand, express: expr, shortTurn: shortTurn });
    });
    return out;
  };

  // 应用单线快车（官方快车配置；不改变排班）
  OPS.applyExpress = function (lineId, stops, caps) {
    var l = lineOf(lineId);
    if (!l) return { ok: false, reason: 'line not found' };
    if (hasExpress(l)) return { ok: true, already: true, stops: l.expressStops };
    if (!stops || stops.length < 2) return { ok: false, reason: 'stops required' };
    l.expressStops = stops.slice();
    l.expressCaps = caps || { peak: 1, off: 0, low: 0 };
    try { if (typeof migrateLineExpressConfig === 'function') migrateLineExpressConfig(l); } catch (e) {}
    try { if (typeof rebuildLineExpressPreference === 'function') rebuildLineExpressPreference(l); } catch (e) {}
    return { ok: true, stops: l.expressStops, caps: getExpressCaps(l), has: hasExpress(l) };
  };

  // 应用单线小交路（官方交路写入；只允许单交路线）
  OPS.applyShortTurn = function (lineId, st) {
    var l = lineOf(lineId);
    if (!l) return { ok: false, reason: 'line not found' };
    if (!st) return { ok: false, reason: 'shortTurn required' };
    var legs = readRouteLegsFromLine(l) || [];
    if (legs.length > 1) return { ok: false, reason: 'already multi-leg' };
    var newLeg = { id: 'rl_short_' + st.startIdx + '_' + st.endIdx, startIdx: st.startIdx, endIdx: st.endIdx, freqPeak: st.freqPeak, freqOff: st.freqOff, freqLow: st.freqLow };
    l.routeLegs = legs.concat([newLeg]);
    if (typeof ensureRouteLegIds === 'function') ensureRouteLegIds(l.routeLegs);
    var cov = typeof validateRouteLegsCoverage === 'function' ? validateRouteLegsCoverage(l, l.routeLegs) : null;
    if (cov) { l.routeLegs = legs; return { ok: false, reason: 'coverage', detail: cov }; }
    applyRouteLegSlotCount(l, l.routeLegs.length - 1, 'peak', 'local', newLeg.freqPeak);
    applyRouteLegSlotCount(l, l.routeLegs.length - 1, 'off', 'local', newLeg.freqOff);
    applyRouteLegSlotCount(l, l.routeLegs.length - 1, 'low', 'local', newLeg.freqLow);
    return { ok: true, legs: readRouteLegsFromLine(l) };
  };

  // 应用综合方案（票价全网 + 每线排班/快车/短交路）；短交路覆盖不连续会回滚
  OPS.applyRevenuePlan = function (plan) {
    if (!plan || !plan.lines) return { ok: false, reason: 'plan required' };
    var ambiguous = plan.lines.filter(function (p) {
      var line = lineOf(p.id);
      return line && legsOf(line).length > 1 && p.legIndex == null;
    });
    if (ambiguous.length) return { ok: false, reason: 'multi-leg requires legIndex', lineIds: ambiguous.map(function (p) { return p.id; }) };
    var applied = { fare: null, lines: [] };
    if (plan.fare) applied.fare = OPS.applyFares(plan.fare);
    plan.lines.forEach(function (p) {
      var l = lineOf(p.id);
      if (!l) return;
      var a = null;
      try { a = OPS.applySchedule(l, p.schedule, { legIndex: p.legIndex }); } catch (e) { a = { err: String(e && e.message || e) }; }
      var ex = null;
      if (p.express && !hasExpress(l)) {
        try {
          l.expressStops = p.express.stops;
          l.expressCaps = p.express.caps;
          if (typeof migrateLineExpressConfig === 'function') migrateLineExpressConfig(l);
          if (typeof rebuildLineExpressPreference === 'function') rebuildLineExpressPreference(l);
          ex = { stops: l.expressStops, caps: getExpressCaps(l), has: hasExpress(l) };
        } catch (e) { ex = { err: String(e && e.message || e) }; }
      }
      var st = null;
      if (p.shortTurn) {
        try {
          var legs = readRouteLegsFromLine(l) || [];
          if (legs.length <= 1) {
            var newLeg = { id: 'rl_short_' + p.shortTurn.startIdx + '_' + p.shortTurn.endIdx, startIdx: p.shortTurn.startIdx, endIdx: p.shortTurn.endIdx, freqPeak: p.shortTurn.freqPeak, freqOff: p.shortTurn.freqOff, freqLow: p.shortTurn.freqLow };
            l.routeLegs = legs.concat([newLeg]);
            if (typeof ensureRouteLegIds === 'function') ensureRouteLegIds(l.routeLegs);
            var cov = typeof validateRouteLegsCoverage === 'function' ? validateRouteLegsCoverage(l, l.routeLegs) : null;
            if (cov) { l.routeLegs = legs; st = { error: cov }; }
            else {
              applyRouteLegSlotCount(l, l.routeLegs.length - 1, 'peak', 'local', newLeg.freqPeak);
              applyRouteLegSlotCount(l, l.routeLegs.length - 1, 'off', 'local', newLeg.freqOff);
              applyRouteLegSlotCount(l, l.routeLegs.length - 1, 'low', 'local', newLeg.freqLow);
              st = { legs: readRouteLegsFromLine(l) };
            }
          }
        } catch (e) { st = { err: String(e && e.message || e) }; }
      }
      applied.lines.push({ id: p.id, name: l.name, schedule: a, express: ex, shortTurn: st });
    });
    return { ok: true, applied: applied };
  };

  OPS.optimizeRevenue = function (opts) {
    var plan = OPS.recommendNetwork(opts);
    var ap = OPS.applyRevenuePlan(plan);
    return { ok: ap.ok, plan: plan, applied: ap.applied };
  };

  OPS.revenueSnapshot = function () {
    try {
      var me = window.MetroEconomy;
      return { simMin: (window.G && G.simMin) || 0, pending: me.getState().metro.pending, balance: me.getState().balance, quotas: me.getFinanceSnapshot().quotas.metro };
    } catch (e) { return { err: String(e && e.message || e) }; }
  };

  OPS.revenueDelta = function (a, b) {
    if (!a || !b || !a.pending || !b.pending) return null;
    var d = {};
    ['fareRevenue', 'fareTrips', 'transferBoarded', 'passengers', 'departures', 'serviceCost', 'carKm', 'penaltyCost', 'operatingSubsidy'].forEach(function (k) {
      d[k] = +(Number(b.pending[k] || 0) - Number(a.pending[k] || 0)).toFixed(2);
    });
    d.balanceDelta = +(Number(b.balance || 0) - Number(a.balance || 0)).toFixed(2);
    d.net = +(d.fareRevenue + d.operatingSubsidy - d.serviceCost).toFixed(2);
    return d;
  };

  // 客流健康检查：活跃站/分钟客流窗口/零客流站/加载提示/OD
  OPS.flowStatus = function () {
    var g = window.G || {};
    var lines = g.lines || [];
    var active = g._flowActiveStations || [];
    var total = 0, ready = 0, zero = 0;
    lines.forEach(function (l) {
      (l.stations || []).forEach(function (s) {
        total++;
        var w = s.flowByLine && s.flowByLine[l.id] && s.flowByLine[l.id].boardedWindow;
        if (Array.isArray(w) && w.length >= 1440) ready++;
        var f = s.flow || {};
        if (!(Number(f.in) || Number(f.on) || Number(f.out) || Number(f.off))) zero++;
      });
    });
    var loading = /正在加载客流|客流数据加载|加载客流/.test((document.body && document.body.innerText) || '');
    return {
      ok: active.length > 0 && ready > 0 && !loading,
      activeStations: active.length, stations: total, boardedWindowReady: ready,
      zeroFlowStations: zero, hourlyOD: !!g.hourlyODBase, overlay: !!g._metroFareDemandOverlayActive,
      simDay: g.simDay, simMin: g.simMin, loading: loading
    };
  };

  // 客流刷新修复：优先点“重新加载客流”，再全量重绘/重算
  OPS.refreshFlow = function () {
    var out = { clicked: false, redraw: false, calc: false, method: null };
    try {
      var b = document.getElementById('nav-btn-flow-reload');
      if (b) { b.click(); out.clicked = true; out.method = 'nav-btn-flow-reload'; }
    } catch (e) {}
    try { if (typeof redrawAllMetroOverlays === 'function') { redrawAllMetroOverlays(); out.redraw = true; } } catch (e) {}
    try { if (typeof calcFlows === 'function') { calcFlows(); out.calc = true; } } catch (e) {}
    return out;
  };

  // 全网审计：每条线的客流/容量/当前排班/推荐排班（只读）
  OPS.audit = function () {
    var lines = ((window.G && window.G.lines) || []).slice();
    return {
      ok: true, fares: OPS.readFares(),
      lines: lines.map(function (l) {
        var rec = OPS.recommendSchedule(l, { maxTrains: 40 });
        var d = rec.demand;
        return {
          id: l.id, name: l.name, stations: (l.stations || []).length,
          peakHourDemand: d.peakHourDemand, dailyDemand: d.total,
          capacity: rec.capacity, roundTripMin: rec.roundTripMin,
          current: rec.current, recommendation: rec.recommendation, headway: rec.headway
        };
      })
    };
  };
})();
