/**
 * beta2 实机自检（页面侧）— 2026-11-14（2026-11-15 新增人类可读报告接口）
 * 注入后调用：
 *   await window.__beta2SelfCheck()            // 只读：读取票价/排班/额度/客流/换乘/几何/入口/函数
 *   await window.__beta2SelfCheck({live:true}) // 实机：记录 paused/simSpeed→暂停→快照→排班往返/票价幂等/只读换乘审计/托管状态→finally 恢复
 * live 证据：旧字段 steps/scheduleRestored/fareSame/lines 保留；新增 originalPaused/originalSpeed/pausedAfter/speedAfter/
 *           pausedRestored/speedRestored/stateRestored/transferAudit/restoreErrors。
 * 返回：{ pass, fail, results:[{name, ok, v|e}], liveEvidence? }
 *     以上返回结构保持不变。
 * 人类可读报告（独立接口，不改变返回结构、不写 console）：
 *   var r = await window.__beta2SelfCheck({live:true});
 *   window.__beta2SelfCheckReport(r)      // 返回报告文本（通过/失败/跳过/livePass/失败详情）
 *   window.__beta2SelfCheckText()         // 运行只读自检并直接返回报告文本
 *   window.__beta2SelfCheckText({live:true})
 *   window.__beta2SelfCheckSummary === window.__beta2SelfCheckReport
 * 用途：发版前实机验收（见 references/beta2-acceptance.md）。
 */
(function () {
  // 重复注入：主检查已存在时也补装报告接口，避免页面沿用旧注入后没有人类可读入口。
  if (window.__beta2SelfCheck) { installReportApi(); return; }
  function safe(fn) { try { return { ok: true, v: fn() }; } catch (e) { return { ok: false, e: String(e && e.message || e).slice(0, 180) }; } }
  function vis(id) { var e = document.getElementById(id); if (!e) return false; var s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && e.getBoundingClientRect().width > 0; }

  function readOnly() {
    var R = [];
    var K = window.CityMetroKit, OD = window.__officialDraw, O = window.MetroOps, OE = window.OfficialEdit, MT = window.__metroToolkit, FL = window.FareLab;
    var l0 = (window.G && G.lines && G.lines[0]) || null;
    var t = function (name, fn) { var r = safe(fn); R.push({ name: name, ok: r.ok, v: r.v, e: r.e }); };
    t('engine', function () { return { engine: G.mapEngine, city: G.cityKey, lines: (G.lines || []).length, economyMode: G.economyMode }; });
    t('fares.read', function () { var f = O.readFares(); return f && { mode: f.mode, bands: (f.distanceBands || []).map(function (b) { return b.fare; }) }; });
    t('fares.economyRules', function () { return { version: window.MetroEconomy.metroRules().version, active: window.MetroEconomy.metroRulesActive() }; });
    t('schedule.legs', function () { var legs = readRouteLegsFromLine(l0); return { line: l0.name, legs: legs.length, slots: getRouteLegSlotCounts(l0, 0) }; });
    t('schedule.recommend', function () { var r = O.recommendSchedule(l0, { maxTrains: 30 }); return { ok: r.ok, rec: r.recommendation, unobserved: r.unobservedSlots }; });
    t('express.config', function () { var ex = (G.lines || []).filter(function (l) { return typeof lineHasExpress === 'function' && lineHasExpress(l); }); return { linesWithExpress: ex.length, sample: ex.slice(0, 3).map(function (l) { return l.name; }) }; });
    t('quota.snapshot', function () { var q = window.MetroEconomy.getFinanceSnapshot().quotas.metro; return Object.keys(q).map(function (k) { return k + ':' + q[k].used + '/' + q[k].total; }); });
    t('oe.economyPlan', function () { var p = OE.economyPlan({ includeOperations: false }); return p && { usable: p.usable, rec: p.recommendation && p.recommendation.key, free: p.free }; });
    t('ops.flow', function () { var f = O.flowStatus(); return { ok: f.ok, zero: f.zeroFlowStations, stations: f.stations, hourlyOD: f.hourlyOD }; });
    t('ops.revenue', function () { var r = O.revenueSnapshot(); return { balance: r.balance, passengers: r.pending.passengers, fareRevenue: r.pending.fareRevenue }; });
    t('ops.hourlyDemand', function () { var h = O.hourlyDemand(l0); return { ok: h.ok, total: h.total, peak: h.peakHourDemand, src: h.dataSource }; });
    t('k.snapshotList', function () { return K.listSnapshots().map(function (s) { return s.label; }).slice(-4); });
    t('k.transferGroups', function () { var g = {}; (G.lines || []).forEach(function (l) { (l.stations || []).forEach(function (s) { if (s.isTransfer && s.transferGroupId) g[s.transferGroupId] = (g[s.transferGroupId] || 0) + 1; }); }); return { groups: Object.keys(g).length, maxMembers: Math.max.apply(null, Object.keys(g).map(function (k) { return g[k]; })) }; });
    t('geometry.emptyAnchors', function () { var empty = 0, total = 0; (G.lines || []).forEach(function (l) { (l.segmentAnchors || []).forEach(function (a) { total++; if (!a || !a.length) empty++; }); }); return { segments: total, empty: empty }; });
    t('nav.entries', function () { return ['nav-btn-add-line', 'nav-btn-flow-dashboard', 'nav-btn-metro-diagram', 'nav-btn-metro-search', 'nav-btn-guide'].map(function (id) { return id + ':' + !!document.getElementById(id); }); });
    t('fn.diagram', function () { return { open: typeof window.openMetroDiagramView, close: typeof window.closeMetroDiagramView, flowClose: typeof window.closeFlowDashboardPanel }; });
    t('fn.transfer', function () { return { applyAutoPassage: typeof top._applyAutoPassageTransferBetweenStations, newGroupId: typeof top._newTransferGroupId }; });
    t('fn.save', function () { return { downloadLocalSave: typeof top.downloadLocalSave, togglePause: typeof top.togglePause, setSpeed: typeof top.setSpeed }; });
    t('fl.api', function () { return { version: FL && FL.version, snapshot: typeof (FL && FL.snapshot) }; });
    return R;
  }

  // ---- 人类可读报告接口（独立纯函数：不写 console、不触碰游戏状态、不改变主检查返回结构） ----
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function clockText() {
    try {
      var d = new Date();
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
        pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    } catch (e) { return ''; }
  }
  function oneLine(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function clipText(s, n) {
    s = oneLine(s);
    n = n || 180;
    return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s;
  }
  function jsonText(v, n) {
    if (v === undefined) return '';
    var s;
    if (typeof v === 'string') s = v;
    else {
      try { s = JSON.stringify(v); } catch (e) { s = String(v); }
      if (s === undefined) s = String(v);
    }
    return clipText(s, n);
  }
  function padRight(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
  function okMark(ok) { return ok === true ? '✅' : (ok === false ? '❌' : '⏭'); }
  function stepDetail(step) {
    var o = {};
    Object.keys(step || {}).forEach(function (k) {
      if (k !== 'n' && k !== 'ok' && k !== 'e') o[k] = step[k];
    });
    var s = jsonText(o, 160);
    return s === '{}' ? '' : s;
  }
  function valText(v) {
    if (v === undefined) return '未记录';
    if (v === null) return 'null';
    return String(v);
  }
  function formatReport(result, options) {
    options = options || {};
    if (!result || typeof result !== 'object') {
      return '[beta2] 报告无法生成：请传入 await window.__beta2SelfCheck() 的返回值。';
    }
    var items = Array.isArray(result.results) ? result.results : [];
    var emptyResults = items.length === 0;
    var requestedLive = !!result.live;
    var pass = 0, fail = 0, skippedChecks = 0;
    items.forEach(function (x) {
      if (x && x.ok === true) pass++;
      else if (x && x.ok === false) fail++;
      else skippedChecks++;
    });
    var hasLive = !!(result.liveEvidence && typeof result.liveEvidence === 'object');
    var ev = hasLive ? result.liveEvidence : null;
    var livePass = result.livePass;
    if (typeof livePass !== 'boolean') {
      if (hasLive) {
        var steps0 = Array.isArray(ev.steps) ? ev.steps : [];
        var pausedOk = typeof ev.pausedRestored === 'boolean' ? ev.pausedRestored : true;
        var speedOk = ev.speedRestored === null ? true : (typeof ev.speedRestored === 'boolean' ? ev.speedRestored : true);
        var stateOk = typeof ev.stateRestored === 'boolean' ? ev.stateRestored : (pausedOk && speedOk);
        var transferOk = !ev.transferAudit || ev.transferAudit.unchanged === true;
        livePass = steps0.every(function (s) { return s && s.ok !== false; }) && !!ev.scheduleRestored && !!ev.fareSame && stateOk && transferOk &&
          (!ev.restoreErrors || ev.restoreErrors.length === 0);
      } else {
        livePass = null;
      }
    }
    var verdict;
    if (emptyResults) verdict = '❌ FAIL（无只读检查结果）';
    else if (fail > 0) verdict = '❌ FAIL';
    else if (requestedLive && !hasLive) verdict = '❌ FAIL（实机层缺少 liveEvidence）';
    else if (hasLive && livePass !== true) verdict = '❌ FAIL（实机层）';
    else if (livePass === true) verdict = '✅ PASS';
    else verdict = '✅ PASS（只读层；实机层未运行）';

    var out = [];
    out.push('beta2 自检报告  ' + clockText());
    out.push('模式：' + (requestedLive || hasLive ? '实机（只读 + 往返）' : '只读') + '    结论：' + verdict);
    out.push('只读检查：' + items.length + ' 项' + (emptyResults ? '（无结果）' : '') + ' · 通过 ' + pass + ' · 失败 ' + fail + ' · 跳过 ' + skippedChecks);
    out.push('');
    out.push('【只读检查】');
    var width = 12;
    items.forEach(function (x) {
      var n = String((x && x.name) || '');
      if (n.length > width && n.length <= 28) width = n.length;
    });
    if (!items.length) out.push('  （无检查结果）');
    items.forEach(function (x, i) {
      var name = String((x && x.name) || ('#' + (i + 1)));
      var extra = '';
      if (x && x.ok === false) {
        extra = x.e ? oneLine(x.e) : '未知错误';
      } else if (x && x.ok === true) {
        extra = options.details === false ? '' : jsonText(x.v, options.maxValue || 180);
      } else {
        extra = x && (x.e || x.skippedReason || x.reason) ? oneLine(x.e || x.skippedReason || x.reason) : '未执行';
      }
      out.push('  ' + okMark(x && x.ok) + ' ' + padRight(name, width) + (extra ? '  ' + extra : ''));
    });

    out.push('');
    var liveFailSteps = [];
    var scheduleSeen = false, fareSeen = false;
    if (!hasLive) {
      if (requestedLive) {
        out.push('【实机往返】 ❌ FAIL（请求 live 但缺少 liveEvidence）');
        out.push('  未产出可验证的实机证据，不能判定 livePass；检查 live 执行异常或结果被截断。');
      } else {
        out.push('【实机往返】 ⏭ SKIP  livePass=未验证');
        out.push('  未运行：await window.__beta2SelfCheck({live:true}) 执行暂停→快照→排班往返→票价幂等→只读换乘审计→托管状态→恢复。');
      }
    } else {
      out.push('【实机往返】 ' + (livePass === true ? '✅ PASS' : '❌ FAIL') + '  livePass=' + String(livePass));
      var steps = Array.isArray(ev.steps) ? ev.steps : [];
      if (!steps.length) out.push('  （无步骤记录）');
      steps.forEach(function (s, i) {
        var name = String((s && s.n) || ('step-' + (i + 1)));
        var d;
        if (s && s.ok === false) {
          liveFailSteps.push(s);
          d = s.e ? oneLine(s.e) : '未知错误';
        } else {
          d = options.details === false ? '' : stepDetail(s);
        }
        out.push('  ' + (s && s.ok === false ? '❌' : '✅') + ' ' + padRight(name, width) + (d ? '  ' + d : ''));
      });
      scheduleSeen = steps.some(function (s) { return s && s.n === 'schedule.roundtrip'; });
      fareSeen = steps.some(function (s) { return s && s.n === 'fare.reapply'; });
      out.push('  恢复校验：scheduleRestored=' + (scheduleSeen ? String(!!(ev && ev.scheduleRestored)) : '未验证') +
        ' · fareSame=' + (fareSeen ? String(!!(ev && ev.fareSame)) : '未验证') +
        ' · lines=' + String(ev && ev.lines != null ? ev.lines : '?'));
      var hasState = ev.originalPaused !== undefined || ev.pausedRestored !== undefined || ev.speedRestored !== undefined;
      if (hasState) {
        out.push('  暂停/速度：paused ' + valText(ev.originalPaused) + '→' + valText(ev.pausedAfter) +
          '（restored=' + (typeof ev.pausedRestored === 'boolean' ? ev.pausedRestored : '未记录') + '） · speed ' +
          valText(ev.originalSpeed) + '→' + valText(ev.speedAfter) +
          '（restored=' + (ev.speedRestored === null ? '未记录' : (typeof ev.speedRestored === 'boolean' ? ev.speedRestored : '未记录')) + '）');
      } else {
        out.push('  暂停/速度：未记录（旧结果）');
      }
      if (ev.transferAudit) {
        var ta = ev.transferAudit || {};
        var tb = ta.before || {}, taAfter = ta.after || {};
        out.push('  换乘审计（只读）：groups ' + valText(tb.groups) + '→' + valText(taAfter.groups) +
          ' · members ' + valText(tb.members) + '→' + valText(taAfter.members) +
          ' · unchanged=' + (ta.unchanged === true ? 'true' : (ta.unchanged === false ? 'false' : '未记录')));
      } else {
        out.push('  换乘审计（只读）：未记录（旧结果）');
      }
    }

    out.push('');
    out.push('【关键失败详情】');
    var failureCount = 0;
    if (emptyResults) {
      failureCount++;
      out.push('  ' + failureCount + ') 只读检查结果为 0 项：不能判定 PASS，需重新运行自检。');
    }
    if (requestedLive && !hasLive) {
      failureCount++;
      out.push('  ' + failureCount + ') 请求了 live 但缺少 liveEvidence：不能判定实机通过。');
    }
    items.forEach(function (x, i) {
      if (!x || x.ok !== false) return;
      failureCount++;
      out.push('  ' + failureCount + ') ' + String(x.name || ('#' + (i + 1))) + '：' + (x.e ? oneLine(x.e) : '未知错误'));
      if (x.v !== undefined) out.push('     证据：' + jsonText(x.v, options.maxFailureValue || 300));
    });
    liveFailSteps.forEach(function (s) {
      failureCount++;
      out.push('  ' + failureCount + ') 实机·' + String(s.n || 'step') + '：' + (s.e ? oneLine(s.e) : '未知错误'));
    });
    if (hasLive && (ev.stateRestored === false || ev.pausedRestored === false || ev.speedRestored === false)) {
      failureCount++;
      out.push('  ' + failureCount + ') 暂停/速度未恢复：paused ' + valText(ev.originalPaused) + '→' + valText(ev.pausedAfter) +
        '（restored=' + (typeof ev.pausedRestored === 'boolean' ? ev.pausedRestored : '未记录') + '） · speed ' +
        valText(ev.originalSpeed) + '→' + valText(ev.speedAfter) +
        '（restored=' + (typeof ev.speedRestored === 'boolean' ? ev.speedRestored : '未记录') + '）');
    }
    if (hasLive && ev.transferAudit && ev.transferAudit.unchanged !== true) {
      var taBad = ev.transferAudit, tbBad = taBad.before || {}, taBadAfter = taBad.after || {};
      failureCount++;
      out.push('  ' + failureCount + ') 换乘组前后不一致（疑似写操作）：groups ' + valText(tbBad.groups) + '→' + valText(taBadAfter.groups) +
        ' · members ' + valText(tbBad.members) + '→' + valText(taBadAfter.members) +
        ' · fp ' + valText(tbBad.fingerprint) + '→' + valText(taBadAfter.fingerprint));
    }
    if (hasLive && livePass !== true && ((scheduleSeen && !ev.scheduleRestored) || (fareSeen && !ev.fareSame))) {
      failureCount++;
      out.push('  ' + failureCount + ') 实机恢复校验未通过：scheduleRestored=' + (scheduleSeen ? String(!!(ev && ev.scheduleRestored)) : '未验证') +
        ' · fareSame=' + (fareSeen ? String(!!(ev && ev.fareSame)) : '未验证'));
    }
    if (hasLive && livePass !== true && !failureCount) {
      failureCount++;
      out.push('  ' + failureCount + ') 实机往返未通过：liveEvidence 缺少可判定字段或步骤。');
    }
    if (!failureCount) out.push('  无（没有失败项）');

    var skippedNames = [];
    items.forEach(function (x, i) {
      if (!x || (x.ok !== true && x.ok !== false)) {
        var reason = x && (x.e || x.skippedReason || x.reason) ? '（' + oneLine(x.e || x.skippedReason || x.reason) + '）' : '';
        skippedNames.push(String((x && x.name) || ('#' + (i + 1))) + reason);
      }
    });
    if (!hasLive && !requestedLive) skippedNames.push('实机往返（live 未开启）');
    if (skippedNames.length) {
      out.push('');
      out.push('【跳过项】');
      skippedNames.forEach(function (n) { out.push('  - ' + n); });
    }

    out.push('');
    if (emptyResults) {
      out.push('判定：只读检查结果为 0 项，需重新运行自检，不能视为 PASS。' + (requestedLive && !hasLive ? ' 实机层也缺少 liveEvidence。' : ''));
    } else if (requestedLive && !hasLive) {
      out.push(fail > 0 ? '判定：只读层存在失败项，且请求了实机自检但缺少 liveEvidence。' : '判定：请求了实机自检但缺少 liveEvidence，不能判定通过。');
    } else if (fail > 0) {
      out.push(hasLive && livePass !== true ? '判定：只读层与实机层均有失败项，先修复再复跑。' : '判定：只读层存在失败项，先修复再复跑。');
    } else if (hasLive && livePass !== true) out.push('判定：实机往返未通过，检查 steps / scheduleRestored / fareSame / 状态恢复 / 换乘审计。');
    else if (livePass === true) out.push('判定：只读层与实机往返均通过，可进入下一层验收。');
    else out.push('判定：只读层通过；实机层未运行（livePass 未验证）。');
    return out.join('\n');
  }

  function installReportApi() {
    window.__beta2SelfCheckReport = function (result, options) { return formatReport(result, options); };
    window.__beta2SelfCheckSummary = window.__beta2SelfCheckReport;
    window.__beta2SelfCheckText = async function (options) {
      var result = await window.__beta2SelfCheck(options);
      return window.__beta2SelfCheckReport(result);
    };
    if (window.__beta2SelfCheck) window.__beta2SelfCheck.report = window.__beta2SelfCheckReport;
  }

  // ---- 只读换乘审计（live 前后对比用；只读取 K.getLines()/G.lines，绝不调用 fixTransfers/separateTransferStations/applyTransfer） ----
  function coordText(c) {
    if (!c) return '';
    if (Array.isArray(c)) return String(c[0]) + ',' + String(c[1]);
    if (typeof c === 'object') return String(c.lat) + ',' + String(c.lng);
    return String(c);
  }
  function hashText(s) {
    var h = 2166136261;
    s = String(s == null ? '' : s);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }
  function auditTransferGroups(K) {
    var lines = [];
    var source = 'G.lines';
    try {
      if (K && typeof K.getLines === 'function') { lines = K.getLines(); source = 'K.getLines'; }
      else if (window.G && Array.isArray(window.G.lines)) lines = window.G.lines;
    } catch (e) {
      lines = (window.G && Array.isArray(window.G.lines)) ? window.G.lines : [];
    }
    if (!Array.isArray(lines)) lines = [];
    var groupNames = {}, transferStations = 0, members = 0, orphans = 0, fingerprint = [];
    lines.forEach(function (l) {
      if (!l || !Array.isArray(l.stations)) return;
      l.stations.forEach(function (s) {
        if (!s) return;
        fingerprint.push([
          String(l.id || ''), String(l.name || ''), String(s.name || ''),
          s.isTransfer ? '1' : '0', String(s.transferGroupId || ''),
          coordText(s.latlng), coordText(s.latlngWgs)
        ].join('|'));
        if (!s.isTransfer) return;
        transferStations++;
        if (!s.transferGroupId) { orphans++; return; }
        (groupNames[s.transferGroupId] = groupNames[s.transferGroupId] || []).push(l.name || '');
        members++;
      });
    });
    var keys = Object.keys(groupNames), crossLineGroups = 0, maxMembers = 0;
    keys.forEach(function (k) {
      var names = {}, n = groupNames[k].length;
      groupNames[k].forEach(function (name) { names[name] = 1; });
      if (Object.keys(names).length > 1) crossLineGroups++;
      if (n > maxMembers) maxMembers = n;
    });
    return {
      source: source,
      lines: lines.length,
      stations: fingerprint.length,
      transferStations: transferStations,
      groups: keys.length,
      members: members,
      maxMembers: maxMembers,
      orphans: orphans,
      crossLineGroups: crossLineGroups,
      fingerprint: hashText(fingerprint.join('\n'))
    };
  }

  window.__beta2SelfCheck = async function (opts) {
    opts = opts || {};
    var results = readOnly();
    var out = { live: !!opts.live, results: results };
    if (opts.live) {
      var K = window.CityMetroKit, O = window.MetroOps, g = window.G || {};
      var steps = [];
      var log = function (n, v) { steps.push(Object.assign({ n: n }, v || {})); };
      var restoreErrors = [];
      var liveError = '';
      var l = null, orig = null, curF = null;
      var scheduleRestored = false, fareSame = false;
      var beforePaused = !!g.paused;
      var beforeSpeed = g.simSpeed !== undefined ? g.simSpeed : null;
      var transferBefore = null;
      var scanStep = null;
      var pausedAfter = beforePaused, speedAfter = beforeSpeed;
      var pausedRestored = false, speedRestored = null;
      try {
        if (!g.paused) {
          if (typeof top.togglePause !== 'function') throw new Error('togglePause 不可用，无法暂停实机自检');
          top.togglePause();
        }
        if (!g.paused) throw new Error('实机自检未能暂停模拟，已中止');
        if (typeof top.setSpeed === 'function') {
          try { top.setSpeed(1, document.body); } catch (e) { steps.push({ n: 'speed.set', ok: false, e: String(e && e.message || e).slice(0, 120) }); }
        } else {
          steps.push({ n: 'speed.set', ok: false, e: 'setSpeed 不可用' });
        }
        log('paused', { paused: g.paused, speed: g.simSpeed, originalPaused: beforePaused, originalSpeed: beforeSpeed });
        transferBefore = auditTransferGroups(K);
        try { if (K && typeof K.snapshot === 'function') K.snapshot('beta2-selfcheck'); } catch (e) {}
        l = (g.lines || []).find(function (x) { return /17号线/.test(x.name || ''); }) || (g.lines || [])[0];
        if (!l) throw new Error('无线路可用于实机排班往返');
        orig = readRouteLegsFromLine(l).map(function (x) { return { peak: x.freqPeak, off: x.freqOff, low: x.freqLow }; });
        try {
          O.applySchedule(l, { peak: (orig[0] && orig[0].peak || 0) + 1, off: 2, low: 1 }, orig.length > 1 ? { legIndex: 0 } : {});
          O.restoreSchedule(l, orig);
          steps.push({ n: 'schedule.roundtrip', ok: true });
        } catch (e) { steps.push({ n: 'schedule.roundtrip', ok: false, e: String(e && e.message || e).slice(0, 120) }); }
        curF = O.readFares();
        try { O.applyFares(curF); steps.push({ n: 'fare.reapply', ok: true }); } catch (e) { steps.push({ n: 'fare.reapply', ok: false, e: String(e && e.message || e).slice(0, 120) }); }
        scanStep = { n: 'transfer.scan', ok: true, readOnly: true, total: transferBefore.groups, groups: transferBefore.groups, members: transferBefore.members, orphans: transferBefore.orphans };
        steps.push(scanStep);
        try { var st = window.MetroAutopilot.status(); steps.push({ n: 'autopilot.status', ok: true, running: st.running, ticks: st.ticks }); } catch (e) { steps.push({ n: 'autopilot.status', ok: false, e: String(e && e.message || e).slice(0, 120) }); }
        var after = readRouteLegsFromLine(l).map(function (x) { return { peak: x.freqPeak, off: x.freqOff, low: x.freqLow }; });
        scheduleRestored = JSON.stringify(after) === JSON.stringify(orig);
        fareSame = JSON.stringify(O.readFares().distanceBands) === JSON.stringify(curF.distanceBands);
      } catch (e) {
        liveError = String(e && e.message || e).slice(0, 180);
        steps.push({ n: 'live.error', ok: false, e: liveError });
      } finally {
        try {
          if (g.paused !== beforePaused) {
            if (typeof top.togglePause === 'function') top.togglePause();
            else restoreErrors.push('paused: togglePause 不可用');
          }
        } catch (e) { restoreErrors.push('paused: ' + String(e && e.message || e).slice(0, 100)); }
        try {
          if (beforeSpeed !== null) {
            if (typeof top.setSpeed === 'function') top.setSpeed(beforeSpeed, document.body);
            else restoreErrors.push('speed: setSpeed 不可用');
          }
        } catch (e) { restoreErrors.push('speed: ' + String(e && e.message || e).slice(0, 100)); }
        pausedAfter = !!g.paused;
        speedAfter = g.simSpeed !== undefined ? g.simSpeed : null;
        pausedRestored = pausedAfter === beforePaused;
        speedRestored = beforeSpeed === null ? null : speedAfter === beforeSpeed;
        if (orig && !scheduleRestored) {
          try { O.restoreSchedule(l, orig); } catch (e) { restoreErrors.push('schedule: ' + String(e && e.message || e).slice(0, 100)); }
          try {
            var afterRetry = readRouteLegsFromLine(l).map(function (x) { return { peak: x.freqPeak, off: x.freqOff, low: x.freqLow }; });
            scheduleRestored = JSON.stringify(afterRetry) === JSON.stringify(orig);
          } catch (e) {}
        }
        if (curF && !fareSame) {
          try { O.applyFares(curF); } catch (e) { restoreErrors.push('fare: ' + String(e && e.message || e).slice(0, 100)); }
          try { fareSame = JSON.stringify(O.readFares().distanceBands) === JSON.stringify(curF.distanceBands); } catch (e) {}
        }
        var transferAfter;
        try { transferAfter = auditTransferGroups(K); }
        catch (e) { transferAfter = { source: 'unavailable', lines: 0, stations: 0, transferStations: 0, groups: 0, members: 0, maxMembers: 0, orphans: 0, crossLineGroups: 0, fingerprint: '', error: String(e && e.message || e).slice(0, 120) }; }
        var transferUnchanged = transferBefore ? JSON.stringify(transferBefore) === JSON.stringify(transferAfter) : null;
        if (scanStep) {
          scanStep.afterGroups = transferAfter.groups;
          scanStep.afterFingerprint = transferAfter.fingerprint;
          scanStep.unchanged = transferUnchanged;
          if (transferUnchanged !== true) { scanStep.ok = false; scanStep.e = '换乘组/坐标前后不一致或审计未完成'; }
        }
        if (restoreErrors.length) steps.push({ n: 'restore.errors', ok: false, e: restoreErrors.join('; ').slice(0, 180) });
        out.liveEvidence = {
          steps: steps,
          scheduleRestored: scheduleRestored,
          fareSame: fareSame,
          lines: Array.isArray(g.lines) ? g.lines.length : 0,
          originalPaused: beforePaused,
          originalSpeed: beforeSpeed,
          pausedAfter: pausedAfter,
          speedAfter: speedAfter,
          pausedRestored: pausedRestored,
          speedRestored: speedRestored,
          stateRestored: pausedRestored && (speedRestored === true || speedRestored === null),
          transferAudit: { before: transferBefore, after: transferAfter, unchanged: transferUnchanged },
          restoreErrors: restoreErrors
        };
        if (liveError) out.liveEvidence.error = liveError;
      }
    }
    var passed = out.results.filter(function (x) { return x.ok; }).length;
    out.pass = passed;
    out.fail = out.results.length - passed;
    if (out.liveEvidence) {
      var lev = out.liveEvidence;
      var stateOk = typeof lev.stateRestored === 'boolean' ? lev.stateRestored : (lev.pausedRestored === true && (lev.speedRestored === true || lev.speedRestored === null));
      var transferOk = !lev.transferAudit || lev.transferAudit.unchanged === true;
      out.livePass = lev.steps.every(function (s) { return s && s.ok !== false; }) &&
        lev.scheduleRestored && lev.fareSame && stateOk && transferOk &&
        (!lev.restoreErrors || lev.restoreErrors.length === 0);
    }
    return out;
  };
  installReportApi();
  console.log('[beta2] selfcheck injected');
})();
