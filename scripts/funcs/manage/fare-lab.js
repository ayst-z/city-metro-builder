/* fare-lab.js — 票价实验与记录组件
 * v1.0.0（2026-11-10）
 * 职责：
 *  - 读取/应用地铁票价规则（distanceStep 分段）
 *  - 记录每次调价时的规则、整点净额、票款/人次/运营成本
 *  - 提供候选票价方案（官方五段/温和阶梯/中价/高价）并切换
 *  - 历史保存在 localStorage('metroFareLab.v1') 与 window.__fareLab
 * 依赖：window.MetroOps / window.MetroEconomy / window.G
 */
(function () {
  'use strict';
  var FL = window.FareLab = window.FareLab || {};
  FL.version = '1.0.1';
  var KEY = 'metroFareLab.v1';

  function OPS() { return window.MetroOps; }
  function store() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } }
  function save(list) {
    window.__fareLab = list;
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(-120))); } catch (e) {}
  }

  FL.current = function () {
    try { return OPS().readFares(); } catch (e) { return null; }
  };

  FL.setBands = function (bands) {
    var bad = (bands || []).filter(function (b) { return !b || !isFinite(b.fare) || b.fare < 1 || Math.round(b.fare) !== Number(b.fare); });
    if (bad.length) return { ok: false, reason: 'fare_must_be_integer', note: '当前游戏按整数结算，小数票价会被截断（实测 1.2/1.4/1.6/1.8 会退化），已拒绝写入', bad: bad };
    var cur = FL.current() || { policyVersion: 'metro-economy-20260919-v2' };
    return OPS().applyFares({ policyVersion: cur.policyVersion, mode: 'distanceStep', distanceBands: bands });
  };

  // 最近一条整点地铁净额
  FL.latestNet = function () {
    try {
      var rep = flowDashboardBuildEconomyReport();
      var L = (rep.ledger || []).filter(function (x) { return x.source === 'metro_hourly_net'; });
      var x = L[L.length - 1];
      if (!x) return null;
      return {
        simDay: x.simDay, simMin: x.simMin, net: x.amount,
        revenue: x.groups && x.groups.revenue, subsidy: x.groups && x.groups.subsidy,
        operations: x.groups && x.groups.operations, maintenance: x.groups && x.groups.maintenance,
        fareTrips: x.ref && x.ref.fareTrips, passengers: x.ref && x.ref.passengers,
        trainCount: x.ref && x.ref.trainCount,
      };
    } catch (e) { return null; }
  };

  // 记录一次快照（规则 + 余额 + 最新整点净额）
  FL.snapshot = function (label) {
    var s = null;
    try { s = MetroEconomy.getFinanceSnapshot(); } catch (e) {}
    var rec = {
      t: Date.now(), label: label || '',
      simDay: G.simDay, simMin: G.simMin,
      balance: s && s.balance,
      fares: FL.current(),
      latest: FL.latestNet(),
    };
    var list = store();
    list.push(rec);
    save(list);
    return rec;
  };

  FL.history = function (n) { var l = store(); return l.slice(-(n || 20)); };
  FL.clear = function () { save([]); return { ok: true }; };
  FL.exportJson = function () { return JSON.stringify(store(), null, 2); };

  // 候选票价方案（禁止低于成本的补贴套利，最低 1.05）
  FL.candidates = function () {
    return [
      { id: 'official5', name: '官方五段 1/2/3/4/5', bands: [
        { fromKm: 0, toKm: 6, fare: 1 }, { fromKm: 6, toKm: 12, fare: 2 },
        { fromKm: 12, toKm: 22, fare: 3 }, { fromKm: 22, toKm: 32, fare: 4 },
        { fromKm: 32, toKm: null, fare: 5 }] },
      { id: 'int2', name: '整数上调 2/3/4/5/6（实测客流下降，不推荐）', note: '2026-11-10 早高峰实测净额低于官方五段', bands: [
        { fromKm: 0, toKm: 6, fare: 2 }, { fromKm: 6, toKm: 12, fare: 3 },
        { fromKm: 12, toKm: 22, fare: 4 }, { fromKm: 22, toKm: 32, fare: 5 },
        { fromKm: 32, toKm: null, fare: 6 }] },
      { id: 'mid2', name: '中价 2/3/4（未推荐）', note: '高于官方五段，可能压制短途客流', bands: [
        { fromKm: 0, toKm: 6, fare: 2 }, { fromKm: 6, toKm: 12, fare: 3 },
        { fromKm: 12, toKm: null, fare: 4 }] },
      { id: 'high3', name: '高价 3/4/5（未推荐）', note: '高于官方五段，可能压制客流', bands: [
        { fromKm: 0, toKm: 6, fare: 3 }, { fromKm: 6, toKm: 12, fare: 4 },
        { fromKm: 12, toKm: null, fare: 5 }] },
      { id: 'official3', name: '官方三段 1/2/3', bands: [
        { fromKm: 0, toKm: 6, fare: 1 }, { fromKm: 6, toKm: 12, fare: 2 },
        { fromKm: 12, toKm: null, fare: 3 }] },
    ];
  };

  FL.applyCandidate = function (id) {
    var c = FL.candidates().find(function (x) { return x.id === id; });
    if (!c) return { ok: false, reason: 'unknown candidate: ' + id };
    var before = FL.snapshot('before:' + id);
    var ap = FL.setBands(c.bands);
    var after = FL.snapshot('after:' + id);
    return { ok: !!(ap && ap.ok), candidate: c, before: before, after: after };
  };

  // 对比两条记录（净额/票款/人次）
  FL.compare = function (a, b) {
    if (!a || !b || !a.latest || !b.latest) return null;
    var keys = ['net', 'revenue', 'subsidy', 'operations', 'maintenance', 'fareTrips', 'passengers'];
    var d = {};
    keys.forEach(function (k) { d[k] = +(Number(b.latest[k] || 0) - Number(a.latest[k] || 0)).toFixed(2); });
    return d;
  };
})();
