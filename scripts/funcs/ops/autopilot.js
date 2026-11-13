/**
 * MetroAutopilot · 全自动经营托管（0.3.0 · 自递归优化 + AI 分析升级）
 * 注入: window.MetroAutopilot（依赖 MetroOps / OfficialEdit / CityMetroKit）
 * 闭环: 测量(区间营收)→分析(规则+恰当时机 AI 智能体)→调整策略→再测量→自递归优化直至收敛/预算/挂起。
 * 自递归: optimizeCycle({maxDepth,intervalMs,eps}) 异步递归；每层 tick→adaptStrategy(爬山/坐标下降)→
 *         收敛(连续 eps 内无改进)或达 maxDepth 或 pendingAnalysis 时返回；宿主 resolveAnalysis 后可再递归。
 * AI 升级: 营收劣化/客流未加载/周期巡检/连续劣化 → pendingAnalysis + opts.onAnalysis；宿主 spawn 智能体，
 *         resolveAnalysis(result) 应用建议并可回写 strategy（受安全边界）。
 * 硬约束: 仅 management+metro+非编辑态；不切模式/不改资金/不绕配额；不存档/不下载/不抢前台；
 *         递归深度/增班/快车小交路/配额均有上限；劣化收缩+回滚；分析未决不改数据；K.snapshot 前置。
 * 公开 API: start/stop/status/tick/resolveAnalysis/optimizeCycle/strategy()
 */
(function () {
  'use strict';
  if (window.MetroAutopilot && window.MetroAutopilot.version === '0.3.1') return;
  var AP = { version: '0.3.1' };
  var DEFAULT_STRATEGY = { perLineCap: 12, perLineInc: 4, maxNewExpressShort: 1, regressionThreshold: 50000, analysisEvery: 10, buyPacks: 1 };
  var LIMITS = { perLineCap: [4, 16], perLineInc: [1, 8], maxNewExpressShort: [0, 2], buyPacks: [1, 3] };
  var state = { running: false, ticks: 0, log: [], timer: null, opts: null, last: null, prevSnapshot: null, pendingAnalysis: null, preTick: null, strategy: Object.assign({}, DEFAULT_STRATEGY), history: [], converge: 0, lastNet: null, regressStreak: 0 };

  function ops() { return window.MetroOps; }
  function oe() { return window.OfficialEdit; }
  function kit() { return window.CityMetroKit; }
  function log(ev, detail) { state.log.push({ t: Date.now(), tick: state.ticks, ev: ev, detail: detail }); if (state.log.length > 500) state.log.shift(); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function guard() {
    var g = window.G || {};
    if (g.economyMode !== 'management') return 'requires management (business) mode';
    if ((g.transportMode || 'metro') !== 'metro') return 'metro only';
    if (g.editMode === 'place' || g.editMode === 'add-station') return 'finish editing first';
    var missing = [];
    if (!ops()) missing.push('MetroOps');
    if (!oe()) missing.push('OfficialEdit');
    if (missing.length) return 'not injected: ' + missing.join(',');
    return null;
  }
  function legsOf(l) { try { return window.readRouteLegsFromLine(l) || []; } catch (e) { return l.routeLegs || []; } }
  function strat(opts) { return Object.assign({}, state.strategy, opts || {}); }

  function ensureFare(dry) {
    var O = ops(); var rec = O.recommendFares({});
    if (!rec.ok || !rec.official5) return { skipped: true, reason: rec.reason || 'not official5' };
    var cur = O.readFares();
    if (cur && JSON.stringify(cur.distanceBands) === JSON.stringify(rec.recommendation.distanceBands)) return { skipped: true, reason: 'already official5' };
    if (dry) return { would: 'apply official5' };
    var a = O.applyFares(rec.recommendation); log('fare', a); return a;
  }

  function ensureSchedule(dry, S) {
    if (!S.optimizeOperations) return [];
    var O = ops(); var g = window.G || {}; var out = [];
    var plan = oe().economyPlan({ includeOperations: false });
    var carsFree = (plan && plan.free && Number(plan.free.cars)) || 0;
    var budget = Math.floor(carsFree / 6);
    (g.lines || []).forEach(function (l) {
      var legs = legsOf(l);
      var applyOne = function (legIdx) {
        var s = O.recommendSchedule(l, legIdx == null ? {} : { legIndex: legIdx });
        if (!s.ok || !s.recommendation) return;
        var cur = s.current || {}; var rec = s.recommendation;
        var capped = { peak: rec.peak, off: rec.off, low: rec.low };
        ['peak', 'off', 'low'].forEach(function (k) {
          var c = Number(cur[k]) || 0;
          if (capped[k] > c) { var inc = Math.min(capped[k] - c, S.perLineInc, budget); capped[k] = c + Math.max(0, inc); if (k === 'peak') budget -= Math.max(0, inc); }
          capped[k] = Math.min(capped[k], S.perLineCap);
        });
        if (JSON.stringify(capped) === JSON.stringify(cur)) return;
        if (dry) { out.push({ id: l.id, leg: legIdx, would: capped }); return; }
        var a = O.applySchedule(l, capped, legIdx == null ? {} : { legIndex: legIdx });
        out.push({ id: l.id, leg: legIdx, applied: a }); log('schedule', { id: l.id, leg: legIdx, a: a });
      };
      if (legs.length > 1) legs.forEach(function (leg, i) { applyOne(i); });
      else applyOne(null);
    });
    return out;
  }

  function ensureExpressShort(dry, S) {
    if (!S.optimizeOperations) return [];
    var O = ops(); var net = O.recommendNetwork({}); var out = []; var left = S.maxNewExpressShort;
    (net.lines || []).forEach(function (p) {
      if (left <= 0) return;
      if (p.express) { if (dry) out.push({ id: p.id, wouldExpress: p.express }); else { var e = O.applyExpress(p.id, p.express.stops, p.express.caps); out.push({ id: p.id, express: e }); log('express', { id: p.id, e: e }); } left--; }
      else if (p.shortTurn) { if (dry) out.push({ id: p.id, wouldShort: p.shortTurn }); else { var s = O.applyShortTurn(p.id, p.shortTurn); out.push({ id: p.id, short: s }); log('shortTurn', { id: p.id, s: s }); } left--; }
    });
    return out;
  }

  function ensureQuota(dry, S) {
    var E = oe(); var plan = E.economyPlan({ includeOperations: false });
    if (!plan || !plan.recommendation) return { skipped: true };
    var rec = plan.recommendation; var out = [];
    if (rec.key === 'save' || rec.key === 'build' || !rec.affordableOne) return { skipped: true, reason: rec.key, usable: plan.usable };
    var n = Math.min(S.buyPacks, rec.packs || 1);
    for (var i = 0; i < n; i++) {
      var q = window.MetroEconomy.metroPurchaseQuote({ system: 'metro', quotaKey: rec.key }, 1);
      var p2 = E.economyPlan({ includeOperations: false });
      if (!(p2.usable >= q.amount + ((p2.nextLine && p2.nextLine.reserve) || 0))) break;
      if (dry) { out.push({ would: rec.key, quote: q.amount }); continue; }
      var d = window.MetroEconomy.dispatch('quota.purchase', { system: 'metro', quotaKey: rec.key, quantity: 1, simDay: (window.G || {}).simDay, simMin: (window.G || {}).simMin });
      out.push({ bought: rec.key, quote: q.amount, d: d }); log('quota', { key: rec.key, quote: q.amount });
    }
    return out;
  }

  function analysisReasons(delta, flow, S) {
    var r = [];
    if (delta && delta.net < -Math.abs(S.regressionThreshold)) r.push('revenue-regression');
    if (flow && flow.ok === false) r.push('flow-not-loaded');
    if (state.regressStreak >= 2) r.push('repeated-regression');
    if (S.analysisEvery && state.ticks > 0 && state.ticks % S.analysisEvery === 0) r.push('periodic-analysis');
    return r;
  }

  // 自递归优化的策略自适应：爬山/坐标下降 + 收敛判定 + 劣化收缩
  function adaptStrategy(delta, eps) {
    if (!delta) return { changed: false };
    var net = delta.net; var before = Object.assign({}, state.strategy); var changed = false;
    state.history.push({ tick: state.ticks, net: net, strategy: before });
    if (state.history.length > 200) state.history.shift();
    if (state.lastNet == null) { state.lastNet = net; return { changed: false }; }
    var improve = net - state.lastNet;
    if (Math.abs(improve) < eps) { state.converge++; }
    else {
      state.converge = 0;
      if (improve > 0) {
        state.regressStreak = 0;
        state.strategy.perLineInc = clamp(state.strategy.perLineInc + 1, LIMITS.perLineInc[0], LIMITS.perLineInc[1]);
        state.strategy.perLineCap = clamp(state.strategy.perLineCap + 1, LIMITS.perLineCap[0], LIMITS.perLineCap[1]);
        changed = true;
      } else {
        state.regressStreak++;
        state.strategy.perLineInc = clamp(state.strategy.perLineInc - 1, LIMITS.perLineInc[0], LIMITS.perLineInc[1]);
        state.strategy.perLineCap = clamp(state.strategy.perLineCap - 1, LIMITS.perLineCap[0], LIMITS.perLineCap[1]);
        state.strategy.maxNewExpressShort = clamp(state.strategy.maxNewExpressShort - 1, LIMITS.maxNewExpressShort[0], LIMITS.maxNewExpressShort[1]);
        changed = true;
      }
    }
    state.lastNet = net;
    if (changed) log('strategy-adapt', { from: before, to: Object.assign({}, state.strategy), improve: improve });
    return { changed: changed, converged: state.converge >= 3, improve: improve };
  }

  // 营收劣化自动回滚（2026-11-13 安全闭环）：记录改动前配置，区间净额劣化超阈值则恢复
  function captureConfig() {
    var O = ops(); var g = window.G || {};
    return { fare: O.readFares(), lines: (g.lines || []).map(function (l) { return { id: l.id, legs: legsOf(l).map(function (x) { return { peak: x.freqPeak, off: x.freqOff, low: x.freqLow }; }) }; }) };
  }
  function rollback(cfg) {
    var O = ops(); var g = window.G || {};
    if (cfg.fare) O.applyFares(cfg.fare);
    (cfg.lines || []).forEach(function (pl) {
      var l = (g.lines || []).find(function (x) { return x.id === pl.id; });
      if (!l) return;
      pl.legs.forEach(function (v, i) { try { O.applySchedule(l, { peak: v.peak, off: v.off, low: v.low }, { legIndex: i }); } catch (e) {} });
    });
    log('rollback', { lines: (cfg.lines || []).length });
  }

  AP.tick = function (opts) {
    opts = opts || state.opts || {};
    var err = guard(); if (err) return { ok: false, reason: err };
    if (state.pendingAnalysis) return { ok: true, pausedForAnalysis: true, pendingAnalysis: state.pendingAnalysis };
    var dry = !!opts.dryRun;
    var S = strat(opts);
    var O = ops();
    var cur = O.revenueSnapshot();
    var delta = state.prevSnapshot ? O.revenueDelta(state.prevSnapshot, cur) : null;
    if (!dry && state.preTick && delta && delta.net < -Math.abs(S.regressionThreshold)) {
      rollback(state.preTick); state.preTick = null; state.prevSnapshot = cur; state.regressStreak = 0;
      return { ok: true, rolledBack: true, delta: delta };
    }
    var flow = null; try { flow = O.flowStatus ? O.flowStatus() : null; } catch (e) { flow = null; }
    var reasons = analysisReasons(delta, flow, S);
    if (reasons.length && !dry) {
      state.pendingAnalysis = { reasons: reasons, tick: state.ticks, requestedAt: Date.now(), context: { delta: delta, flowOk: flow ? flow.ok : null, strategy: Object.assign({}, state.strategy) } };
      log('analysis-request', state.pendingAnalysis);
      if (typeof opts.onAnalysis === 'function') { try { opts.onAnalysis(state.pendingAnalysis); } catch (e) { log('onAnalysis-error', String(e)); } }
      state.prevSnapshot = cur;
      return { ok: true, analysisRequested: state.pendingAnalysis };
    }
    if (!dry) state.preTick = captureConfig();
    if (!dry && kit()) kit().snapshot('autopilot-tick-' + state.ticks);
    var fare = ensureFare(dry);
    var sched = ensureSchedule(dry, S);
    var ex = ensureExpressShort(dry, S);
    var quota = ensureQuota(dry, S);
    var g = window.G || {};
    if (!dry && g.paused && typeof top.togglePause === 'function') { top.togglePause(); log('resume', {}); }
    state.ticks++;
    state.prevSnapshot = cur;
    var adapt = dry ? { changed: false } : adaptStrategy(delta, opts.eps || 1000);
    state.last = { fare: fare, schedule: sched, expressShort: ex, quota: quota, delta: delta, adapt: adapt };
    log('tick', { delta: delta, adapt: adapt });
    return { ok: true, tick: state.ticks, last: state.last };
  };

  // 自递归优化循环：tick→测量→自适应→递归，直至收敛/深度/挂起
  AP.optimizeCycle = async function (opts) {
    opts = opts || {};
    var maxDepth = opts.maxDepth || 5;
    var interval = opts.intervalMs || 30000;
    var eps = opts.eps || 1000;
    var steps = [];
    async function step(depth) {
      var r = AP.tick(Object.assign({}, opts, { eps: eps }));
      steps.push({ depth: depth, ok: r.ok, tick: r.tick, analysis: r.analysisRequested || null, adapt: r.last && r.last.adapt });
      if (!r.ok) return { stopped: 'error', reason: r.reason, steps: steps };
      if (r.pausedForAnalysis || r.analysisRequested) return { pausedForAnalysis: r.pendingAnalysis || state.pendingAnalysis, steps: steps };
      if (r.last && r.last.adapt && r.last.adapt.converged) return { converged: true, steps: steps };
      if (depth + 1 >= maxDepth) return { maxDepth: true, steps: steps };
      await new Promise(function (res) { setTimeout(res, interval); });
      return step(depth + 1);
    }
    var out = await step(0);
    out.strategy = Object.assign({}, state.strategy);
    out.ticks = state.ticks;
    log('optimize-cycle', out);
    return out;
  };

  AP.resolveAnalysis = function (result) {
    if (!state.pendingAnalysis) return { ok: false, reason: 'no pending analysis' };
    result = result || {};
    var applied = {};
    if (result.fare) applied.fare = ops().applyFares(result.fare);
    if (result.schedule && Array.isArray(result.schedule)) {
      applied.schedule = result.schedule.map(function (s) { return ops().applySchedule(s.id, s.rec, s.legIndex == null ? {} : { legIndex: s.legIndex }); });
    }
    if (result.strategy) {
      Object.keys(LIMITS).forEach(function (k) {
        if (typeof result.strategy[k] === 'number') state.strategy[k] = clamp(result.strategy[k], LIMITS[k][0], LIMITS[k][1]);
      });
      applied.strategy = Object.assign({}, state.strategy);
    }
    log('analysis-resolved', { reasons: state.pendingAnalysis.reasons, applied: applied });
    state.pendingAnalysis = null; state.regressStreak = 0;
    return { ok: true, applied: applied };
  };

  AP.start = function (opts) {
    opts = opts || {};
    var err = guard(); if (err) return { ok: false, reason: err };
    if (state.running) return { ok: false, reason: 'already running' };
    state.opts = opts; state.running = true; state.ticks = 0; state.log = []; state.prevSnapshot = null; state.pendingAnalysis = null; state.preTick = null;
    state.strategy = Object.assign({}, DEFAULT_STRATEGY); state.history = []; state.converge = 0; state.lastNet = null; state.regressStreak = 0;
    var maxTicks = opts.maxTicks || 240;
    var interval = opts.intervalMs || 60000;
    log('start', { interval: interval, maxTicks: maxTicks, dryRun: !!opts.dryRun, optimizeOperations: !!opts.optimizeOperations, analysisEvery: opts.analysisEvery || null });
    state.timer = setInterval(function () {
      if (!state.running) return;
      if (state.ticks >= maxTicks) { AP.stop(); log('maxTicks', {}); return; }
      var r = AP.tick(state.opts);
      if (!r.ok) { AP.stop(); log('stop-on-error', r); }
    }, interval);
    return { ok: true, running: true, interval: interval, maxTicks: maxTicks };
  };
  AP.stop = function () { if (state.timer) clearInterval(state.timer); state.timer = null; state.running = false; log('stop', {}); return { ok: true, running: false, ticks: state.ticks }; };
  AP.strategy = function () { return Object.assign({}, state.strategy); };
  AP.status = function () { return { running: state.running, ticks: state.ticks, pendingAnalysis: state.pendingAnalysis, strategy: Object.assign({}, state.strategy), converge: state.converge, last: state.last, log: state.log.slice(-50) }; };
  window.MetroAutopilot = AP;
})();
