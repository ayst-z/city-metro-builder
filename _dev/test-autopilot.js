#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const load = (ctx, rel) => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel });

function sandbox(mode) {
  const bands = [{ fromKm: 0, toKm: 6, fare: 1 }, { fromKm: 6, toKm: 12, fare: 2 }, { fromKm: 12, toKm: 22, fare: 3 }, { fromKm: 22, toKm: 32, fare: 4 }, { fromKm: 32, toKm: null, fare: 5 }];
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    G: { economyMode: mode, transportMode: 'metro', editMode: 'select', paused: false, lines: [], simDay: 1, simMin: 0 },
    MetroEconomy: {
      getFareRules: () => ({ metro: { policyVersion: 'v2', mode: 'distanceStep', distanceBands: bands } }),
      setFareRules: () => {}, getState: () => ({ balance: 1000000, metro: { pending: {} } }),
      getFinanceSnapshot: () => ({ quotas: { metro: {} } }),
      metroPurchaseQuote: () => ({ amount: 100000 }), dispatch: () => ({ ok: true }),
    },
    MetroFarePolicy: { demand: (r) => 1 },
    readRouteLegsFromLine: (l) => l.routeLegs || [],
    OfficialEdit: { economyPlan: () => ({ recommendation: { key: 'save', affordableOne: false }, usable: 0, nextLine: null }) },
    CityMetroKit: { snapshot: () => {} },
    top: { togglePause: () => {} },
  });
  ctx.window = ctx;
  load(ctx, 'scripts/funcs/ops/ops.js');
  load(ctx, 'scripts/funcs/ops/autopilot.js');
  return ctx;
}
const tests = [];
const test = (n, f) => tests.push({ n, f });

test('management mode recommends official five-band', () => {
  const c = sandbox('management');
  const r = c.MetroOps.recommendFares({});
  assert.equal(r.ok, true); assert.equal(r.official5, true);
  assert.equal(JSON.stringify(r.recommendation.distanceBands.map(b => b.fare)), JSON.stringify([1, 2, 3, 4, 5]));
});
test('creative mode keeps demand-based ladder', () => {
  const c = sandbox('free');
  const r = c.MetroOps.recommendFares({});
  assert.equal(r.ok, true); assert.notEqual(r.official5, true);
});
test('management can opt into creative curve explicitly', () => {
  const c = sandbox('management');
  const r = c.MetroOps.recommendFares({ creative: true });
  assert.notEqual(r.official5, true);
});
test('autopilot refuses creative mode', () => {
  const c = sandbox('free');
  assert.equal(c.MetroAutopilot.start({}).ok, false);
  assert.equal(c.MetroAutopilot.tick({}).ok, false);
});
test('autopilot refuses edit mode', () => {
  const c = sandbox('management'); c.G.editMode = 'place';
  assert.equal(c.MetroAutopilot.start({}).ok, false);
});
test('autopilot dryRun tick in management is side-effect free', () => {
  const c = sandbox('management');
  const r = c.MetroAutopilot.tick({ dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(c.MetroAutopilot.status().running, false);
});
test('autopilot start/stop bounded and idempotent', () => {
  const c = sandbox('management');
  const s = c.MetroAutopilot.start({ intervalMs: 100000, maxTicks: 2 });
  assert.equal(s.ok, true);
  assert.equal(c.MetroAutopilot.start({}).ok, false); // already running
  const st = c.MetroAutopilot.stop();
  assert.equal(st.running, false);
});
test('periodic analysis escalates and pauses mutations', () => {
  const c = sandbox('management');
  let notified = null;
  c.MetroAutopilot.tick({ analysisEvery: 1, onAnalysis: (r) => { notified = r; } }); // tick0 -> ticks becomes1
  const r2 = c.MetroAutopilot.tick({ analysisEvery: 1, onAnalysis: (r) => { notified = r; } }); // ticks1 %1==0 -> escalate
  assert.equal(r2.ok, true);
  assert.ok(r2.analysisRequested, 'should request analysis');
  assert.ok(notified && notified.reasons.includes('periodic-analysis'));
  const r3 = c.MetroAutopilot.tick({}); // pending -> paused, no mutations
  assert.equal(r3.pausedForAnalysis, true);
  const res = c.MetroAutopilot.resolveAnalysis({});
  assert.equal(res.ok, true);
  assert.equal(c.MetroAutopilot.status().pendingAnalysis, null);
});
test('resolveAnalysis without pending refuses', () => {
  const c = sandbox('management');
  assert.equal(c.MetroAutopilot.resolveAnalysis({}).ok, false);
});
test('optimizeCycle bounded self-recursion', async () => {
  const c = sandbox('management');
  const r = await c.MetroAutopilot.optimizeCycle({ maxDepth: 2, intervalMs: 1 });
  assert.ok(Array.isArray(r.steps) && r.steps.length <= 2);
  assert.ok(r.strategy && typeof r.strategy.perLineCap === 'number');
});
test('resolveAnalysis clamps strategy to safety limits', () => {
  const c = sandbox('management');
  c.MetroAutopilot.tick({ analysisEvery: 1 });
  c.MetroAutopilot.tick({ analysisEvery: 1 }); // escalate
  const res = c.MetroAutopilot.resolveAnalysis({ strategy: { perLineCap: 999, perLineInc: 999, maxNewExpressShort: 99 } });
  assert.equal(res.ok, true);
  const s = c.MetroAutopilot.strategy();
  assert.ok(s.perLineCap <= 16 && s.perLineInc <= 8 && s.maxNewExpressShort <= 2);
});
test('revenue regression triggers auto-rollback of fare', () => {
  const c = sandbox('management');
  const applied = [];
  c.MetroEconomy.setFareRules = (mode, rules) => { applied.push(rules); };
  c.MetroOps.flowStatus = () => ({ ok: true });
  let call = 0;
  c.MetroEconomy.getState = () => ({ balance: 1000000, metro: { pending: { fareRevenue: call++ === 0 ? 1000000 : 0 } } });
  // tick1: snapshot high, captures preTick
  c.MetroAutopilot.tick({});
  // tick2: snapshot low -> negative interval delta -> rollback
  const r = c.MetroAutopilot.tick({ regressionThreshold: 100 });
  assert.equal(r.rolledBack, true);
  assert.ok(applied.length >= 1, 'rollback should re-apply pre-tick fare');
});

(async () => {
  let pass = 0, fail = 0;
  for (const t of tests) {
    try { await t.f(); pass++; console.log('PASS', t.n); }
    catch (e) { fail++; console.log('FAIL', t.n, String(e.message || e).slice(0, 120)); }
  }
  console.log(`autopilot: ${pass}/${pass + fail} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
