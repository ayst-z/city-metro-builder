/* official-edit.js — 官方编辑组件（经营模式）
 * v1.0.0（2026-11-10）
 * 职责：
 *  - 线路官方配色/车型/编组确认与应用（setLineProps）
 *  - 官方延长接口（startExtendLine + executePlaceModeStationClick + finishEdit）
 *  - 官方支线入口（OD.startBranch）
 *  - 断线/分段线按官方全线数据重绘为单线（批量放站，默认不开性能模式）
 * 依赖：window.__metroToolkit(MT) / window.__officialDraw(OD) / window.G
 */
(function () {
  'use strict';
  var OE = window.OfficialEdit = window.OfficialEdit || {};
  OE.version = '1.1.8';

  function MT() { return window.__metroToolkit; }
  function OD() { return window.__officialDraw; }
  function lines() { return (window.G && window.G.lines) || []; }
  function lineOf(id) { return lines().find(function (l) { return String(l.id) === String(id); }); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 官方配置：{trainType,trainCars,maxSpeedKmh}
  OE.officialSpec = function (city, no) {
    try { return MT().lineSpec(city, String(no)); } catch (e) { return null; }
  };

  // 应用官方配色/车型/编组，并回读线路实际值
  OE.applyProps = function (lineId, city, no) {
    var res = null;
    try { res = OD().setLineProps(lineId, city, String(no)); } catch (e) { res = { error: String(e && e.message || e) }; }
    var l = lineOf(lineId);
    return {
      ok: !!(res && !res.error && res.ok !== false),
      props: res,
      color: l && l.color,
      trainType: l && l.trainType,
      trainCars: l && l.trainCars,
      maxSpeedKmh: l && l.maxSpeedKmh,
    };
  };

  // 全量校正：按线路名前缀解析线号，逐条 setLineProps
  OE.auditConfigs = function (city, prefix) {
    var out = [];
    var pre = prefix || (city === '苏州' ? '苏州轨道交通' : '上海地铁');
    lines().forEach(function (l) {
      if (String(l.name || '').indexOf(pre) !== 0) return;
      var m = String(l.name).match(/([0-9]+)号线/);
      if (!m) return;
      var a = OE.applyProps(l.id, city, m[1]);
      out.push({ line: l.name, no: m[1], color: a.color, trainType: a.trainType, trainCars: a.trainCars, maxSpeedKmh: a.maxSpeedKmh, ok: a.ok });
    });
    return out;
  };

  // 官方延长：从首/末站延长；stations = [{name,lat,lng}]
  OE.extendAtTerminal = async function (lineId, terminalName, stations, opts) {
    opts = opts || {};
    var l = lineOf(lineId);
    if (!l) return { error: 'line not found' };
    var terminal = (l.stations || []).find(function (s) { return s.name === terminalName; });
    if (!terminal) return { error: 'terminal not found: ' + terminalName };
    if (typeof top.startExtendLine !== 'function') return { error: 'startExtendLine unavailable' };
    top.startExtendLine(l, terminal);
    await wait(opts.startDelay != null ? opts.startDelay : 300);
    var placed = [];
    for (var i = 0; i < (stations || []).length; i++) {
      var s = stations[i];
      if (typeof top.executePlaceModeStationClick !== 'function') return { error: 'executePlaceModeStationClick unavailable', placed: placed };
      top.executePlaceModeStationClick({ latlng: { lat: s.lat, lng: s.lng } });
      placed.push(s.name);
      await wait(opts.stationDelay != null ? opts.stationDelay : 700);
    }
    try { OD().finishEdit(lineId); } catch (e) {}
    return { ok: true, placed: placed, stations: (l.stations || []).map(function (s) { return s.name; }), extendFromStart: !!G.extendFromStart };
  };

  // 官方支线入口（会打开支线方向模态；后续按官方 UI 完成）
  OE.branchStart = function (mainLineId, stationName) {
    try { return OD().startBranch(mainLineId, stationName); } catch (e) { return { error: String(e && e.message || e) }; }
  };

  // 断线重绘为单线：删除旧线 → 官方全线查询 → createLine → setLineProps → 批量放站 → 改名/节点/交路/换乘 → 四检
  OE.redrawAsSingle = async function (cfg) {
    cfg = cfg || {};
    var city = cfg.city || '上海';
    var cityCN = cfg.cityCN || city;
    var no = String(cfg.no || '');
    var name = cfg.name || ((city === '苏州' ? '苏州轨道交通' : '上海地铁') + no + '号线');
    var batch = cfg.batch || 6;
    var delay = cfg.stationDelay != null ? cfg.stationDelay : 2;
    var engine = cfg.engine || 'amap';
    if (!cfg.from || !cfg.to) return { error: 'from/to required' };
    (cfg.deleteNames || []).forEach(function (n) {
      var old = lines().find(function (l) { return l.name === n; });
      if (old) { try { top.deleteLine(old.id); } catch (e) {} }
    });
    await wait(300);
    var q = await MT().queryLine(cfg.queryCity || city, no, { engine: engine, stationFrom: cfg.from, stationTo: cfg.to });
    if (!q || !q.ok) return { error: 'query failed: ' + (q && q.reason) };
    var created = await OD().createLine(name);
    var l = lineOf(created.lineId);
    var props = OE.applyProps(l.id, city, no);
    for (var i = 0; i < q.stations.length; i += batch) {
      var chunk = q.stations.slice(i, i + batch).map(function (s) { return { name: s.name, lat: s.lat, lng: s.lng }; });
      await OD().drawStations(l.id, chunk, { stationDelay: delay });
      await wait(80);
    }
    OD().renameStations(l.id, q.stations.slice(0, (l.stations || []).length).map(function (s) { return s.name; }));
    window.__DANGEROUS_CONFIRM = window.__DANGEROUS_CONFIRM || {};
    window.__DANGEROUS_CONFIRM.drawNodes = true;
    var _mt = MT();
    var _nodes = (_mt && typeof _mt.padSegmentNodes === 'function')
      ? _mt.padSegmentNodes(q.stations, q.nodes || [], { endPadM: cfg.endPadM != null ? cfg.endPadM : 100 })
      : (q.nodes || []);
    await OD().drawNodes(l.id, _nodes, {});
    try {
      var dl = top.getDefaultRouteLegsForLine(l);
      l.routeLegs = dl.map(function (x) { return { id: x.id, startIdx: x.startIdx, endIdx: x.endIdx, freqPeak: 1, freqOff: 1, freqLow: 1 }; });
      top.persistRouteLegsOnLine(l);
    } catch (e) {}
    var transfers = OE.autoTransfers(l.id, cfg.transferTolM != null ? cfg.transferTolM : 350);
    var chk = null;
    try { chk = await OD().checkLine3x(l.id, { city: cityCN }); } catch (e) { chk = { pass: false, problems: [String(e)] }; }
    return {
      ok: true, lineId: l.id, name: l.name, n: (l.stations || []).length,
      color: l.color, trainCars: l.trainCars, props: props,
      legs: (l.routeLegs || []).map(function (x) { return { a: x.startIdx, b: x.endIdx }; }),
      transfers: transfers, pass: chk && chk.pass, problems: (chk && chk.problems || []).slice(0, 8),
    };
  };

  // 新建整线：官方查询（整线或逐段）→ createLine → 配置 → 分批放站 → 改名 → 节点（站台避让）
  // → 默认交路 → 自动换乘 → 四检 → 清客流缺口。dryRun 只查询不建线。
  OE.buildLine = async function (cfg) {
    cfg = cfg || {};
    var city = cfg.city || '苏州';
    var no = String(cfg.no || '');
    var name = cfg.name || ((city === '苏州' ? '苏州轨道交通' : '上海地铁') + no + '号线');
    var batch = cfg.batch || 6;
    var delay = cfg.stationDelay != null ? cfg.stationDelay : 0.1;
    var warnings = [];
    var q = cfg.query || null;
    if (!q) {
      if (!cfg.useSegments) {
        q = await MT().queryLine(cfg.queryCity || city, no, {
          engine: cfg.engine || 'amap', stationFrom: cfg.from, stationTo: cfg.to
        });
        if (!q || !q.ok || (q.stations || []).length < 2) {
          warnings.push('整线查询失败/不完整，改逐段拼接');
          q = null;
        }
      }
      if (!q) {
        q = await MT().queryLineBySegments(cfg.queryCity || city, no, {
          stations: cfg.stations, stationNames: cfg.stationNames, alias: cfg.alias,
          lineFilter: cfg.lineFilter || (no + '号线'), fallback: cfg.fallback || 'spline',
          endPadM: cfg.endPadM != null ? cfg.endPadM : 100
        });
      }
    }
    if (!q || !q.ok || !(q.stations || []).length) return { ok: false, reason: 'query failed', warnings: warnings.concat((q && q.warnings) || []) };
    if (cfg.dryRun) return { ok: true, dryRun: true, n: q.stations.length, nodes: (q.nodes || []).length, segStatus: q.segStatus || null, estimated: q.estimated, warnings: warnings.concat(q.warnings || []) };
    var created = await OD().createLine(name);
    var l = lineOf(created && created.lineId);
    if (!l) return { ok: false, reason: 'createLine failed', created: created };
    var props = OE.applyProps(l.id, city, no);
    for (var i = 0; i < q.stations.length; i += batch) {
      var chunk = q.stations.slice(i, i + batch).map(function (s) { return { name: s.name, lat: s.lat, lng: s.lng }; });
      await OD().drawStations(l.id, chunk, { stationDelay: delay });
      await wait(80);
    }
    OD().renameStations(l.id, q.stations.slice(0, (l.stations || []).length).map(function (s) { return s.name; }));
    // 完整性：官方整线落站可能少尾部（实测苏 11 少 4 站）；尾部缺失用官方延长补齐，再统一改名/画节点
    var officialNames = q.stations.map(function (s) { return s.name; });
    var placedNames = (l.stations || []).map(function (s) { return s.name; });
    var prefix = 0;
    while (prefix < placedNames.length && prefix < officialNames.length && placedNames[prefix] === officialNames[prefix]) prefix++;
    if (placedNames.length < officialNames.length && prefix === placedNames.length && cfg.autoExtendMissing !== false) {
      var missingTail = q.stations.slice(placedNames.length).map(function (s) { return { name: s.name, lat: s.lat, lng: s.lng }; });
      try {
        var ex = await OE.extendAtTerminal(l.id, placedNames[placedNames.length - 1], missingTail, { stationDelay: 0.9, startDelay: 400 });
        if (ex && ex.ok) {
          OD().renameStations(l.id, officialNames.slice(0, (l.stations || []).length));
          warnings.push('尾部缺 ' + missingTail.length + ' 站，已用官方延长补齐');
        } else warnings.push('尾部缺 ' + missingTail.length + ' 站，官方延长失败');
      } catch (e) { warnings.push('尾部延长异常: ' + String(e && e.message || e)); }
    } else if (placedNames.length < officialNames.length) {
      warnings.push('落站 ' + placedNames.length + '/' + officialNames.length + ' 且非尾部缺失，需重绘');
    }
    window.__DANGEROUS_CONFIRM = window.__DANGEROUS_CONFIRM || {};
    window.__DANGEROUS_CONFIRM.drawNodes = true;
    var _mt = MT();
    var _nodes = (_mt && typeof _mt.padSegmentNodes === 'function')
      ? _mt.padSegmentNodes(q.stations, q.nodes || [], { endPadM: cfg.endPadM != null ? cfg.endPadM : 100 })
      : (q.nodes || []);
    await OD().drawNodes(l.id, _nodes, {});
    try {
      var dl = top.getDefaultRouteLegsForLine(l);
      l.routeLegs = dl.map(function (x) { return { id: x.id, startIdx: x.startIdx, endIdx: x.endIdx, freqPeak: 1, freqOff: 1, freqLow: 1 }; });
      top.persistRouteLegsOnLine(l);
    } catch (e) {}
    var transfers = OE.autoTransfers(l.id, cfg.transferTolM != null ? cfg.transferTolM : 350);
    var chk = null;
    try { chk = await OD().checkLine3x(l.id, { city: city }); } catch (e) { chk = { pass: false, problems: [String(e)] }; }
    try { top.metroFinishPassengerAuthorityGap(); } catch (e) {}
    try { top.metroShouldSuspendPassengerGeneration(); } catch (e) {}
    try { if (window.MetroOps && MetroOps.refreshFlow) await MetroOps.refreshFlow(); } catch (e) {}
    return {
      ok: true, lineId: l.id, name: l.name, n: (l.stations || []).length,
      color: l.color, trainCars: l.trainCars, props: props,
      legs: (l.routeLegs || []).map(function (x) { return { a: x.startIdx, b: x.endIdx }; }),
      transfers: transfers, pass: chk && chk.pass, problems: (chk && chk.problems || []).slice(0, 8),
      estimated: q.estimated, warnings: warnings.concat(q.warnings || [])
    };
  };

  // 游戏内通知：钩住 notify，记录最近 80 条
  OE.installNotifyLog = function () {
    if (window.__oeNotifyHooked && typeof window.notify === 'function') return { hooked: true, count: (window.__oeNotices || []).length };
    var orig = window.notify;
    window.__oeNotices = window.__oeNotices || [];
    if (typeof orig === 'function') {
      window.notify = function (msg) {
        try {
          var text = typeof msg === 'string' ? msg : JSON.stringify(msg);
          window.__oeNotices.push({ t: Date.now(), text: String(text).slice(0, 300) });
          if (window.__oeNotices.length > 80) window.__oeNotices.shift();
        } catch (e) {}
        return orig.apply(this, arguments);
      };
      window.__oeNotifyHooked = true;
    }
    return { hooked: !!window.__oeNotifyHooked, count: (window.__oeNotices || []).length };
  };

  OE.notifications = function (limit) {
    var n = limit != null ? limit : 20;
    return (window.__oeNotices || []).slice(-n);
  };

  // 读取当前可见 toast/notify 文本
  OE.readToasts = function () {
    var out = [];
    var nodes = document.querySelectorAll('[class*=toast],[class*=notify],[id*=toast],[id*=notify]');
    for (var i = 0; i < nodes.length && i < 40; i++) {
      var e = nodes[i];
      var st = getComputedStyle(e);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
      var txt = String(e.textContent || '').trim();
      if (txt) out.push(txt.slice(0, 200));
    }
    return out;
  };

  // 当前动态报价（km/stations/cars/express）
  OE.quotes = function () {
    var out = {};
    try {
      metroQuotaPurchaseCatalogItems().forEach(function (it) {
        out[it.quotaKey] = MetroEconomy.metroPurchaseQuote(it, 1).amount;
      });
    } catch (e) {}
    return out;
  };

  // 全量监测：经济/配额/报价/客流/ledger/排班/通知/模态/可见性
  OE.observe = function () {
    var s = MetroEconomy.getFinanceSnapshot();
    var rep = null, fs = null, pending = null;
    try { rep = flowDashboardBuildEconomyReport(); } catch (e) {}
    try { fs = MetroOps.flowStatus(); } catch (e) {}
    try { pending = MetroOps.revenueSnapshot().pending; } catch (e) {}
    var nets = ((rep && rep.ledger) || []).filter(function (x) { return x.source === 'metro_hourly_net'; }).slice(-5).map(function (x) {
      return { day: x.simDay, min: x.simMin, net: x.amount, revenue: x.groups && x.groups.revenue, ops: x.groups && x.groups.operations, trains: x.ref && x.ref.trainCount };
    });
    var lineState = ((window.G && G.lines) || []).map(function (l) {
      return { name: l.name, stations: (l.stations || []).length, color: l.color, trainCars: l.trainCars, flow24h: l.flow24h, peak: (l.routeLegs || []).map(function (x) { return x.freqPeak; }) };
    });
    return {
      at: Date.now(), simDay: G.simDay, simMin: G.simMin, paused: G.paused, speed: G.simSpeed,
      visibility: document.visibilityState, performanceMode: !!G.metroPerformanceMode,
      balance: s.balance, quotas: s.quotas.metro, quotes: OE.quotes(),
      flow: fs, pending: pending, lastNets: nets, lines: lineState,
      notices: OE.notifications(20), toasts: OE.readToasts(),
      editing: { mode: G.editMode, currentLineId: G.currentLineId },
    };
  };

  OE.startMonitor = function (intervalMs) {
    OE.installNotifyLog();
    window.__oeMonitor = window.__oeMonitor || [];
    if (window.__oeMonitorTimer) clearInterval(window.__oeMonitorTimer);
    var push = function () {
      try {
        window.__oeMonitor.push(OE.observe());
        if (window.__oeMonitor.length > 40) window.__oeMonitor.shift();
      } catch (e) {}
    };
    push();
    window.__oeMonitorTimer = setInterval(push, Math.max(1000, intervalMs || 5000));
    return { running: true, interval: intervalMs || 5000, count: window.__oeMonitor.length };
  };

  OE.stopMonitor = function () {
    if (window.__oeMonitorTimer) clearInterval(window.__oeMonitorTimer);
    window.__oeMonitorTimer = null;
    return { running: false, count: (window.__oeMonitor || []).length };
  };

  // 综合投资规划：车厢/里程/车站/快线联合，收益优先
  OE.economyPlan = function (opts) {
    opts = opts || {};
    var s = MetroEconomy.getFinanceSnapshot();
    var q = OE.quotes();
    var qsAll = s.quotas || {};
    var qs = qsAll.metro || qsAll;
    var ledger = s.ledger || [];
    var dailyByDay = {};
    ledger.forEach(function (x) {
      if (String(x.source || '').indexOf('metro_daily_') === 0 && Number(x.amount) < 0) {
        dailyByDay[x.simDay] = (dailyByDay[x.simDay] || 0) + Math.abs(Number(x.amount));
      }
    });
    var dailyDays = Object.keys(dailyByDay).map(Number).sort(function (a, b) { return b - a; });
    var dailyReserve = dailyDays.length ? dailyByDay[dailyDays[0]] : (opts.dailyReserve != null ? opts.dailyReserve : 1200000);
    var usable = Number(s.balance || 0) - dailyReserve;
    var free = {
      cars: Math.max(0, ((qs.cars && qs.cars.total) || 0) - ((qs.cars && qs.cars.used) || 0)),
      stations: Math.max(0, ((qs.stations && qs.stations.total) || 0) - ((qs.stations && qs.stations.used) || 0)),
      km: +Math.max(0, ((qs.km && qs.km.total) || 0) - ((qs.km && qs.km.used) || 0)).toFixed(2)
    };
    var next = opts.nextLine || { name: '苏州轨道交通7号线', stations: 25, km: 35, cars: 6, reserve: 500000 };
    var need = {
      stations: Math.max(0, (next.stations || 0) - free.stations),
      km: Math.max(0, (next.km || 0) - free.km),
      cars: Math.max(0, (next.cars || 0) - free.cars)
    };
    var packs = {
      stations: Math.ceil(need.stations / 5),
      km: Math.ceil(need.km / 10),
      cars: Math.ceil(need.cars / 6)
    };
    var needTrains = null, needCars = 0, crowded = null;
    if (opts.includeOperations !== false) try {
      needTrains = 0;
      crowded = 0;
      (G.lines || []).forEach(function (l) {
        var r = MetroOps.recommendSchedule(l, { maxTrains: 40 });
        if (r && r.ok && r.recommendation) {
          var cur = (l.routeLegs || []).reduce(function (a, x) { return Math.max(a, Number(x.freqPeak) || 0); }, 0);
          var extra = Math.max(0, (r.recommendation.peak || 0) - cur);
          needTrains += extra;
          needCars += extra * (Number(l.trainCars) || 0);
        }
      });
      var fs = MetroOps.flowStatus();
      crowded = (fs && fs.crowdedStations) || 0;
    } catch (e) {}
    var rec = [];
    if (packs.stations > 0) rec.push({ key: 'stations', priority: 2, packs: packs.stations, quoteOne: q.stations, reason: next.name + ' 缺 ' + need.stations + ' 站（' + packs.stations + ' 包）' });
    if (packs.cars > 0) rec.push({ key: 'cars', priority: 3, packs: packs.cars, quoteOne: q.cars, reason: next.name + ' 缺 ' + need.cars + ' 车厢（' + packs.cars + ' 包）' });
    if (packs.km > 0) rec.push({ key: 'km', priority: 4, packs: packs.km, quoteOne: q.km, reason: next.name + ' 缺 ' + need.km + 'km（' + packs.km + ' 包）' });
    rec.forEach(function (item) {
      item.quote = MetroEconomy.metroPurchaseQuote({ system: 'metro', quotaKey: item.key }, item.packs).amount;
      item.affordableOne = usable >= item.quoteOne + (next.reserve || 0);
      item.affordable = usable >= item.quote + (next.reserve || 0);
    });
    if (!rec.length) rec.push({ key: 'build', priority: 1, packs: 0, quote: next.reserve || 0, quoteOne: 0, affordable: usable >= (next.reserve || 0), reason: '额度齐备，可开始建 ' + next.name });
    rec.sort(function (a, b) { return a.priority - b.priority; });
    var first = rec[0];
    var recommendation = first;
    if (first && first.key !== 'build' && !first.affordableOne) {
      recommendation = { key: 'save', priority: 9, packs: first.packs, quote: first.quoteOne, quoteTotal: first.quote, affordable: false, reason: '距离下一包' + first.key + '还差 ' + Math.max(0, first.quoteOne + (next.reserve || 0) - usable) };
    }
    return {
      balance: s.balance, usable: usable, dailyReserve: dailyReserve, quotes: q, free: free, nextLine: next, need: need, packs: packs, hsrQuotas: qsAll.hsr || null, aviationQuotas: qsAll.aviation || null,
      needTrains: needTrains, crowdedStations: crowded,
      needCarPacks: needTrains == null ? null : Math.max(0, Math.ceil(Math.max(0, needCars - free.cars) / 6)),
      recommendation: recommendation, all: rec
    };
  };

  // 车站/车厢额度自动购买循环：只用经营余额、保留日结安全线、达到目标空闲量即停。
  // cfg: { quotaKey:'stations'|'cars'|'km', targetFree, maxPacks, intervalMs, beforeSettleBuffer }
  OE.startQuotaBuyLoop = function (cfg) {
    cfg = cfg || {};
    var steps = (cfg.steps && cfg.steps.length) ? cfg.steps.map(function (s) {
      return { quotaKey: s.quotaKey || 'stations', targetFree: s.targetFree != null ? s.targetFree : 30, maxPacks: s.maxPacks != null ? s.maxPacks : 6 };
    }) : [{ quotaKey: cfg.quotaKey || 'stations', targetFree: cfg.targetFree != null ? cfg.targetFree : 30, maxPacks: cfg.maxPacks != null ? cfg.maxPacks : 6 }];
    var intervalMs = cfg.intervalMs || 60000;
    var beforeBuffer = cfg.beforeSettleBuffer != null ? cfg.beforeSettleBuffer : 700000;
    if (window.__oeBuyTimer) clearInterval(window.__oeBuyTimer);
    var state = window.__oeBuyLoop = { running: true, steps: steps, stepIndex: 0, packsByKey: {}, packs: 0, log: [], started: Date.now() };
    function syncCurrent() {
      var st = steps[state.stepIndex];
      state.key = st ? st.quotaKey : null;
      state.targetFree = st ? st.targetFree : null;
      state.maxPacks = st ? st.maxPacks : null;
    }
    syncCurrent();
    function log(x) { state.log.push(x); if (state.log.length > 30) state.log.shift(); }
    function stop(reason, free) {
      state.running = false;
      if (window.__oeBuyTimer) clearInterval(window.__oeBuyTimer);
      window.__oeBuyTimer = null;
      log({ at: Date.now(), event: 'stop', reason: reason, free: free, packs: state.packs, packsByKey: state.packsByKey });
    }
    function tick() {
      if (!state.running) return;
      var g = window.G;
      if (!g || document.hidden || g.paused) return;
      var step = steps[state.stepIndex];
      if (!step) { stop('all_steps_done'); return; }
      var key = step.quotaKey;
      var s = MetroEconomy.getFinanceSnapshot();
      var qs = (s.quotas && s.quotas.metro) || s.quotas || {};
      var q = qs[key] || {};
      var free = Math.max(0, (Number(q.total) || 0) - (Number(q.used) || 0));
      var packs = state.packsByKey[key] || 0;
      if (free >= step.targetFree || packs >= step.maxPacks) {
        state.stepIndex++;
        syncCurrent();
        log({ at: Date.now(), event: 'step', done: key, free: free, packs: packs, next: state.key });
        if (state.stepIndex >= steps.length) { stop('target_reached', free); return; }
        return tick();
      }
      var quote = MetroEconomy.metroPurchaseQuote({ system: 'metro', quotaKey: key }, 1);
      if (!quote || !quote.amount) return;
      var plan = OE.economyPlan({ includeOperations: false });
      var buffer = Math.max(beforeBuffer, plan.dailyReserve);
      if (s.balance - buffer >= quote.amount) {
        var r = MetroEconomy.dispatch('quota.purchase', { system: 'metro', quotaKey: key, quantity: 1, simDay: g.simDay, simMin: g.simMin });
        if (r && r.ok) {
          state.packsByKey[key] = packs + 1;
          state.packs++;
          log({ at: Date.now(), event: 'buy', key: key, amount: quote.amount, balance: r.balance, freeBefore: free, packs: state.packs, day: g.simDay, min: Math.round(g.simMin) });
        } else {
          log({ at: Date.now(), event: 'fail', key: key, reason: r && (r.blockedReason || r.message) });
        }
      }
    }
    window.__oeBuyTimer = setInterval(tick, intervalMs);
    tick();
    return { ok: true, state: state };
  };
  OE.stopQuotaBuyLoop = function () {
    if (window.__oeBuyTimer) clearInterval(window.__oeBuyTimer);
    window.__oeBuyTimer = null;
    if (window.__oeBuyLoop) window.__oeBuyLoop.running = false;
    return { ok: true };
  };
  OE.quotaBuyLoopStatus = function () { return window.__oeBuyLoop || null; };

  // 同名且距离 < tolM 自动建换乘；返回成功配对
  OE.autoTransfers = function (lineId, tolM) {
    var l = lineOf(lineId);
    if (!l) return [];
    var tol = tolM != null ? tolM : 350;
    var R = 6371000, rad = function (x) { return x * Math.PI / 180; };
    function dist(a, b) {
      if (!a || !b) return Infinity;
      var dla = rad(b.lat - a.lat), dlo = rad(b.lng - a.lng);
      var h = Math.sin(dla / 2) * Math.sin(dla / 2) + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dlo / 2) * Math.sin(dlo / 2);
      return 2 * R * Math.asin(Math.sqrt(h));
    }
    var made = [];
    (l.stations || []).forEach(function (s) {
      for (var i = 0; i < lines().length; i++) {
        var o = lines()[i];
        if (String(o.id) === String(l.id)) continue;
        var t = (o.stations || []).find(function (x) { return x.name === s.name; });
        if (t && t !== s && dist(s.latlng, t.latlng) < tol) {
          try { top._applyAutoPassageTransferBetweenStations(s, t, {}); } catch (e) {}
          made.push({ station: s.name, with: o.name });
          break;
        }
      }
    });
    return made;
  };
})();
