#!/usr/bin/env node
/* v4 冒烟测试：Node VM 加载 MT/OD/K，校验版本与公开 API。
 * 运行：node _dev/smoke.js
 * 退出码：0 全过；1 有失败。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const LOAD_ORDER = [
  'scripts/funcs/query/mt-core.js',
  'scripts/funcs/query/mt-node.js',
  'scripts/funcs/query/mt-amap.js',
  'scripts/funcs/draw/od.js',
  'scripts/funcs/manage/k.js',
  'scripts/funcs/draw/plan-map.js',
  'scripts/funcs/ops/ops.js',
  'scripts/funcs/ops/autopilot.js',
  'scripts/funcs/manage/official-edit.js',
  'scripts/funcs/manage/fare-lab.js',
  'scripts/funcs/modes/mode-registry.js',
  'scripts/funcs/modes/hsr-probe.js',
  'scripts/funcs/modes/air-probe.js',
];

function el() {
  const node = {
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {}, appendChild() {}, insertBefore() {}, removeChild() {},
    addEventListener() {}, removeEventListener() {}, click() {}, focus() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    innerHTML: '', textContent: '', value: '', children: [],
  };
  return node;
}

function makeSandbox() {
  const store = new Map();
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Map, Set, WeakMap, WeakSet, Date, Math, JSON, RegExp, Error, Array, Object, String, Number, Boolean,
    performance: { now: () => Date.now() },
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }),
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  };
  sandbox.sessionStorage = sandbox.localStorage;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  sandbox.document = {
    createElement: el, createElementNS: el,
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    body: el(), head: el(), documentElement: el(),
    addEventListener() {}, removeEventListener() {}, cookie: '',
  };
  sandbox.location = {
    href: 'https://www.citiesdesigners.com/cities/anycity-global',
    hostname: 'www.citiesdesigners.com', origin: 'https://www.citiesdesigners.com',
    pathname: '/cities/anycity-global', search: '', hash: '', reload() {},
  };
  sandbox.navigator = { userAgent: 'node-smoke', language: 'zh-CN' };
  sandbox.G = {
    lines: [], mapEngine: 'amap', currentCity: 'anycity-global',
    map: { panTo() {}, setZoomAndCenter() {}, getZoom() { return 12; }, getCenter() { return { lat: 31.23, lng: 121.47 }; } },
  };
  return vm.createContext(sandbox);
}

const REQUIRED = {
  MT: [
    'queryLine', 'queryRingLine', 'queryUnopenedLine', 'queryLineStopsByPOI', 'queryOsmOverpass',
    'queryLineOsm', 'parseOsmMetroData', 'resolveCoord', 'resolveTramCoord', 'queryTransferStops',
    'queryTramLine', 'placeSearch', 'transferSearch', 'queryAMapSubwayWeb', 'queryLineByBusAPI',
    'parseAMapSubwayData', 'compareSources', 'detectOsmShift', 'fixOsmShift', 'fitSegmentNodes',
    'curvatureThin', 'adaptiveDensity', 'sampleCatmull', 'catmullRom', 'localTurn', 'straightLineNodes',
    'checkLineCompleteness', 'verifyMetroPOI', 'verifyTramPOI', 'inCityBounds', 'segInCity',
    'officialColors', 'matchOfficial', 'extractLineNo', 'resolveCityKey', 'lineSpec', 'endpointsOf',
    'getLines', 'findLine', 'webKey', 'webApiReady', 'ensureAmap', 'extractLngLat', 'withTimeout',
    'withFallback', 'formatLineTable', 'subwayDataUrl', 'isRingLine', 'coordToGameNative',
    'gcj02ToWgs84', 'wgs84ToGcj02', 'outOfChina', 'isWgsNativeCity', 'clearQueryCache',
    '_distM', 'haversine', 'log', '__version',
    'mapEngine', 'engineProfile', 'toGameCoords', 'dataSourceStatus', 'injectSrhData',
    'CITY_ADCODE', 'CITY_ALIASES', 'CITY_BOUNDS', 'LINE_ENDPOINTS', 'NODE_DENSITY',
    'RING_LINES', 'RING_STATIONS', '__coreVersion', '__nodeVersion', '__amapVersion',
  ],
  OD: [
    'checkLine3x', 'verifyLine', 'verifyLineOrder', 'drawLine', 'fastDraw', 'applyLineData',
    'createLine', 'finishEdit', '_finalizeLine', 'rebuildNodesFromAmap', 'resolveCoordTwice',
    'autoTransfers', 'autoTransfersBulk', 'curvatureThin', 'queryLinePaths', '_disableSnap',
    '_restoreSnap', 'hasNodeOrderIssue', 'fixNodeOrder', 'densifyAnchors', 'renameStations',
    'inspect', 'transferViaAmap', 'startBranch', 'applyBranchData',
    'setBranchAnchors', 'finishBranch', 'checkMainLine', 'pickLongest', 'drawNodes', 'drawStations',
    'setLineProps', 'NODE_DENSITY', 'densityOpts', 'adaptiveDensity',
    '_projectSort', '_rebuildNodesFromAmapImpl',
  ],
  K: [
    'snapshot', 'listSnapshots', 'rollback', 'clearSnapshots', 'clearSnapshotsOnly', 'listAudit',
    'clearAudit', '_auditBefore', 'confirmDangerous', 'allowDangerous', 'resetDangerous',
    'riskLevel', 'riskDesc', 'riskRisks', 'confirmRisk', 'showRiskDialog', 'setOpts', 'opt',
    'resetOpts', 'getLines', 'getLine', 'findCityLine', 'applyOfficialColors', 'addNodes',
    'applyStationNames', 'calibrateCoordinates', 'calibrateFromAmap', 'resolveLineCoord',
    'calibrateStationToLine', 'configureLine', 'fixLine', 'fixTransfers', 'applyTransfer',
    'separateTransferStations', 'deleteLine', 'deleteCityLine', 'rebuildGeometry', 'repaint',
    'applyNaming', 'setLineStatus', 'regionOf', 'linesByRegion', 'status', 'regions', 'regionKeyOf',
    'REGIONS', 'SPECIAL_LINES', 'placeStations', 'geocode', 'log', '_copyLine', '_deepCopy',
    '_linesArr', '_haversineM', '_distM', '_snapshots', '_snapMax', '_audit', '_opts', '_RISK',
    '_transferTolM',
  ],
};

const EXPECT_VERSION = { MT: '6.5.3', OD: '2.60.3', K: '2.9' };

function main() {
  const ctx = makeSandbox();
  const failures = [];
  for (const rel of LOAD_ORDER) {
    const file = path.join(ROOT, rel);
    const code = fs.readFileSync(file, 'utf8');
    try {
      vm.runInContext(code, ctx, { filename: rel, timeout: 30000 });
    } catch (e) {
      failures.push(`LOAD ${rel}: ${e && e.stack || e}`);
    }
  }
  const w = ctx.window;
  const MT = w.__metroToolkit || {};
  const OD = w.__officialDraw || {};
  const K = w.CityMetroKit || {};
  const groups = { MT, OD, K };

  for (const [g, obj] of Object.entries(groups)) {
    const missing = REQUIRED[g].filter((k) => obj[k] === undefined);
    if (missing.length) failures.push(`${g} 缺少 ${missing.length} 键: ${missing.join(', ')}`);
  }
  for (const [g, ver] of Object.entries(EXPECT_VERSION)) {
    const actual = groups[g].__version;
    if (actual !== ver) failures.push(`${g} 版本 ${actual} != 期望 ${ver}`);
  }
  if (MT.__nodeVersion !== '6.5.4') failures.push('MT node version mismatch');
  if (!w.PlanMap || w.PlanMap.version !== '1.1.1' || ['prepare', 'draw', 'check'].some(k => typeof w.PlanMap[k] !== 'function')) failures.push('PlanMap API/version mismatch');
  const OPS = w.MetroOps || {};
  const OE = w.OfficialEdit || {};
  const FL = w.FareLab || {};
  const MODES = w.CityTransportModes || {};
  const HSR = w.HsrProbe || {};
  const AIR = w.AirProbe || {};
  const opsMissing = ['hourlyDemand', 'recommendSchedule', 'applySchedule', 'restoreSchedule', 'readFares', 'recommendFares', 'applyFares', 'audit', 'recommendNetwork', 'applyRevenuePlan', 'optimizeRevenue', 'revenueSnapshot', 'revenueDelta', 'applyExpress', 'applyShortTurn', 'flowStatus', 'refreshFlow'].filter((k) => typeof OPS[k] !== 'function');
  if (OPS.__version !== '1.3.5') failures.push(`OPS 版本 ${OPS.__version} != 期望 1.3.5`);
  const AP = w.MetroAutopilot || {};
  if (AP.version !== '0.3.0' || ['start', 'stop', 'status', 'tick'].some(k => typeof AP[k] !== 'function')) failures.push('MetroAutopilot API/version mismatch');
  if (opsMissing.length) failures.push('OPS 缺少: ' + opsMissing.join(', '));

  // 纯函数行为抽查
  try {
    const spec6 = MT.lineSpec('shanghai', '6');
    const spec17 = MT.lineSpec('shanghai', '17');
    if (spec6.trainType !== 'C' || spec6.trainCars !== 4) failures.push('上海6号线应为C4');
    if (spec17.trainType !== 'A' || spec17.trainCars !== 6 || spec17.maxSpeedKmh !== 100) failures.push('上海17号线应为A6/100kmh');
    if (MT.endpointsOf('shanghai', '17').from !== '西岑') failures.push('上海17号线遗漏西岑');
    if (typeof MT.haversine === 'function') {
      const d = MT.haversine([121.47, 31.23], [121.48, 31.23]);
      if (!(d > 900 && d < 1000)) failures.push(`MT.haversine 异常: ${d}`);
    }
    if (typeof MT.fitSegmentNodes === 'function') {
      const segs = MT.fitSegmentNodes(
        [{ lat: 31.23, lng: 121.47 }, { lat: 31.24, lng: 121.48 }],
        [[121.47, 31.23], [121.475, 31.235], [121.48, 31.24]],
        { density: 'sparse' }
      );
      if (!Array.isArray(segs) || segs.length !== 1 || !segs[0].length) failures.push('MT.fitSegmentNodes 未返回节点段');
    }
    if (typeof MT.engineProfile === 'function' && typeof MT.toGameCoords === 'function') {
      ctx.window.G.mapEngine = 'amap';
      const ap = MT.engineProfile();
      if (ap.engine !== 'amap' || ap.convertAmapToGame) failures.push('engineProfile(amap) 异常');
      const r1 = MT.toGameCoords([{ name: 'x', lng: 121.47, lat: 31.23 }], [[[121.47, 31.23]]]);
      if (r1.converted) failures.push('AMap 引擎不应转换坐标');
      ctx.window.G.mapEngine = 'osm';
      const op = MT.engineProfile();
      if (op.engine !== 'osm' || !op.convertAmapToGame) failures.push('engineProfile(osm) 异常');
      const r2 = MT.toGameCoords([{ name: 'x', lng: 121.47, lat: 31.23 }], [[[121.47, 31.23]]]);
      if (!r2.converted || Math.abs(r2.stations[0].lng - 121.47) < 1e-7) failures.push('OSM 引擎未转换坐标');
      ctx.window.G.mapEngine = 'amap';
    }
    if (typeof MT.injectSrhData === 'function') {
      const raw = { s: 'test', l: [{ ln: '1号线', st: [{ n: 'A', sl: '121.4,31.2' }, { n: 'B', sl: '121.5,31.3' }] }] };
      const ir = MT.injectSrhData(raw, 'testcity');
      const store = ctx.window.__MT_SUBMETRO_DATA && ctx.window.__MT_SUBMETRO_DATA.testcity;
      if (!ir.ok || !store || store.l.length !== 1) failures.push('injectSrhData 未写入');
      else delete ctx.window.__MT_SUBMETRO_DATA.testcity;
    }
    if (typeof K.snapshot === 'function' && typeof K.listSnapshots === 'function') {
      const before = K.listSnapshots().length;
      K.snapshot('smoke');
      if (K.listSnapshots().length !== before + 1) failures.push('K.snapshot 未入栈');
      K.clearSnapshots();
    }
    if (typeof OPS.hourlyDemand === 'function') {
      const fakeLine = {
        id: 'L1', name: 'test', trainCars: 6, trainType: 'B',
        stations: [{ flowByLine: { L1: { boardedWindow: new Array(1440).fill(1) } } }],
        routeLegs: [{ freqPeak: 1, freqOff: 1, freqLow: 0 }],
      };
      ctx.window.G.lines = [fakeLine];
      ctx.window.readRouteLegsFromLine = (line) => line.routeLegs || [];
      ctx.window.applyRouteLegSlotCount = (line, leg, slot, kind, count) => {
        line.routeLegs[leg][slot === 'peak' ? 'freqPeak' : slot === 'off' ? 'freqOff' : 'freqLow'] = count;
        return count;
      };
      ctx.window.calcLineHeadwayMin = (n) => (n > 0 ? 100 / n : null);
      ctx.window.getTrainCap = () => 1000;
      ctx.window.METRO_TRAIN_OPERATIONAL_LOAD_FACTOR = 1.1;
      ctx.window.MetroEconomy = {
        getFareRules: () => ({ metro: { policyVersion: 'v2', mode: 'distanceStep', distanceBands: [{ fromKm: 0, toKm: 6, fare: 1 }, { fromKm: 6, toKm: 12, fare: 2 }] } }),
        setFareRules() {},
      };
      ctx.window.MetroFarePolicy = { demand: (r) => (r <= 1 ? 1 + (1 - r) / (1 + 11.5 * (1 - r)) : Math.exp(1 - r)) };
      const d = OPS.hourlyDemand('L1');
      if (!d.ok || d.total !== 1440) failures.push(`Ops.hourlyDemand 异常 total=${d.total}`);
      const rs = OPS.recommendSchedule('L1', { maxTrains: 20 });
      if (!rs.ok || !rs.recommendation || !rs.recommendation.peak) failures.push('Ops.recommendSchedule 异常');
      const ap = OPS.applySchedule('L1', { peak: 2, off: 1, low: 0 });
      if (!ap.ok || fakeLine.routeLegs[0].freqPeak !== 2) failures.push('Ops.applySchedule 未写入');
      OPS.restoreSchedule('L1', ap.original);
      if (fakeLine.routeLegs[0].freqPeak !== 1) failures.push('Ops.restoreSchedule 未还原');
      const fr = OPS.recommendFares({});
      if (!fr.ok || !fr.recommendation) failures.push('Ops.recommendFares 异常');
      const af = OPS.applyFares({ policyVersion: 'v2', mode: 'distanceStep', distanceBands: [{ fromKm: 0, toKm: 6, fare: 1 }] });
      if (!af.ok) failures.push('Ops.applyFares 异常');
      fakeLine.routeLegs = [{ freqPeak: 2, freqOff: 2, freqLow: 1 }];
      const windowData = fakeLine.stations[0].flowByLine.L1.boardedWindow;
      windowData.fill(0);
      const empty = OPS.recommendSchedule('L1');
      if (JSON.stringify(empty.recommendation) !== JSON.stringify({ peak: 2, off: 2, low: 1 }) || empty.unobservedSlots.length !== 3) failures.push('无客流样本时未保留服务');
      windowData[660] = 3000;
      const partial = OPS.recommendSchedule('L1');
      if (partial.recommendation.off !== 2 || partial.recommendation.low !== 1 || partial.recommendation.peak < 2) failures.push('不完整客流样本导致停运');
      fakeLine.routeLegs.push({ freqPeak: 1, freqOff: 0, freqLow: 0 });
      const beforeMulti = JSON.stringify(fakeLine.routeLegs);
      if (OPS.applySchedule('L1', { peak: 8 }).ok || JSON.stringify(fakeLine.routeLegs) !== beforeMulti) failures.push('多交路未阻止统一排班');
      const target = OPS.applySchedule('L1', { peak: 3 }, { legIndex: 1 });
      if (!target.ok || fakeLine.routeLegs[0].freqPeak !== 2 || fakeLine.routeLegs[1].freqPeak !== 3) failures.push('指定交路排班影响其他交路');
      if (OPS.applySchedule('L1', { peak: 3 }, { legIndex: 5 }).ok) failures.push('无效交路索引未拒绝');
      const hourly = OPS.hourlyDemand;
      let demandCalls = 0;
      OPS.hourlyDemand = (...args) => { demandCalls++; return hourly(...args); };
      OPS.audit();
      if (demandCalls !== 1) failures.push('audit 重复聚合客流');
      OPS.hourlyDemand = hourly;
      const windowLine = { id: 'window', name: 'window', trainCars: 6, routeLegs: [{ freqPeak: 1, freqOff: 1, freqLow: 1 }], stations: [0, 0, 10, 20, 30, 40].map((value, i) => ({ flow: { on: i === 0 ? 1e9 : 0 }, flowByLine: { window: { boardedWindow: new Array(1440).fill(value) } } })) };
      ctx.window.G.lines = [windowLine];
      let network = OPS.recommendNetwork();
      if (network.lines[0].shortTurn.startIdx !== 2 || network.lines[0].shortTurn.endIdx !== 5) failures.push('小交路未使用本线客流滑窗');
      windowLine.stations.forEach(s => s.flowByLine.window.boardedWindow.fill(0));
      network = OPS.recommendNetwork();
      if (network.lines[0].shortTurn !== null || network.lines[0].express !== null) failures.push('无本线需求仍推荐新增服务');
      ctx.window.G.lines = [];
      ctx.window.metroQuotaPurchaseCatalogItems = () => ['stations', 'cars', 'km', 'expressLines'].map(quotaKey => ({ system: 'metro', quotaKey }));
      let balance = 500;
      ctx.window.MetroEconomy.getFinanceSnapshot = () => ({ balance, ledger: [], quotas: { metro: { stations: { total: 0, used: 0 }, km: { total: 100, used: 0 }, cars: { total: 100, used: 0 } } } });
      ctx.window.MetroEconomy.metroPurchaseQuote = (item, count) => ({ amount: 100 * count + 10 * count * (count - 1) / 2 });
      const budgetOpts = { dailyReserve: 100, nextLine: { name: 'test', stations: 30, km: 0, cars: 0, reserve: 50 } };
      let plan = OE.economyPlan(budgetOpts);
      if (plan.all[0].quote !== 750 || plan.all[0].affordable || !plan.all[0].affordableOne) failures.push('多包报价或整批负担判断错误');
      balance = 200;
      plan = OE.economyPlan(budgetOpts);
      if (plan.recommendation.key !== 'save' || plan.all[0].affordableOne) failures.push('购包未保留建设缓冲');
      balance = 900;
      plan = OE.economyPlan(budgetOpts);
      if (!plan.all[0].affordable) failures.push('足额预算未识别');
      const recommend = OPS.recommendSchedule;
      let scheduleCalls = 0;
      OPS.recommendSchedule = () => { scheduleCalls++; return { ok: true, recommendation: { peak: 5 } }; };
      fakeLine.routeLegs = [{ freqPeak: 2, freqOff: 2, freqLow: 1 }];
      ctx.window.G.lines = [fakeLine];
      plan = OE.economyPlan({ ...budgetOpts, includeOperations: false });
      if (scheduleCalls !== 0 || plan.needTrains !== null || plan.needCarPacks !== null) failures.push('轻量预算仍扫描客流或伪报零需求');
      ctx.window.MetroEconomy.getFinanceSnapshot = () => ({ balance, ledger: [], quotas: { metro: { stations: { total: 0, used: 0 }, km: { total: 100, used: 0 }, cars: { total: 0, used: 0 } } } });
      plan = OE.economyPlan(budgetOpts);
      if (plan.needTrains !== 3 || plan.needCarPacks !== 3) failures.push('列车缺口未按编组换算车厢');
      OPS.recommendSchedule = recommend;
      ctx.window.G.lines = [];
    }
  } catch (e) {
    failures.push(`行为抽查异常: ${e && e.message}`);
  }

  ['queryLineBySegments','queryConstructionLine','smoothLineNodes','padSegmentNodes','fitSegmentNodes'].forEach((k) => { if (typeof MT[k] !== 'function') failures.push(`MT.${k} 缺失`); });

  if (OE.version !== '1.1.8') failures.push(`OE.version 异常: ${OE.version}`);
  ['applyProps','auditConfigs','extendAtTerminal','redrawAsSingle','buildLine','startQuotaBuyLoop','stopQuotaBuyLoop','quotaBuyLoopStatus','branchStart','installNotifyLog','notifications','readToasts','observe','startMonitor','stopMonitor','quotes','economyPlan'].forEach((k) => { if (typeof OE[k] !== 'function') failures.push(`OfficialEdit.${k} 缺失`); });

  if (FL.version !== '1.0.1') failures.push(`FL.version 异常: ${FL.version}`);
  ['current','setBands','snapshot','history','candidates','applyCandidate','compare'].forEach((k) => { if (typeof FL[k] !== 'function') failures.push(`FareLab.${k} 缺失`); });

  const badFare = FL.setBands([{ fromKm: 0, toKm: 6, fare: 1.5 }]);
  if (!badFare || badFare.ok !== false || badFare.reason !== 'fare_must_be_integer') failures.push('FareLab 未拒绝小数票价');

  if (MODES.__version !== '0.1.0') failures.push(`CityTransportModes 版本异常: ${MODES.__version}`);
  ['register','get','list','detect','require','ids'].forEach((k) => { if (typeof MODES[k] !== 'function') failures.push(`CityTransportModes.${k} 缺失`); });
  const modeIds = typeof MODES.ids === 'function' ? MODES.ids() : [];
  if (!modeIds.includes('metro') || !modeIds.includes('hsr') || !modeIds.includes('air')) failures.push('模式注册缺少 metro/hsr/air');
  if (HSR.__version !== '0.1.0' || typeof HSR.state !== 'function' || typeof HSR.opts !== 'function') failures.push('HsrProbe 预留层异常');
  if (AIR.__version !== '0.1.0' || typeof AIR.state !== 'function' || typeof AIR.entrypoints !== 'function') failures.push('AirProbe 预留层异常');

  const summary = {
    files: LOAD_ORDER.length,
    MT: Object.keys(MT).length,
    OD: Object.keys(OD).length,
    K: Object.keys(K).length,
    versions: { OD: OD.__version, K: K.__version, OE: OE.version, FL: FL.version },
  };
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length) {
    console.error('FAIL:\n- ' + failures.join('\n- '));
    process.exit(1);
  }
  console.log('SMOKE PASS');
}

main();
