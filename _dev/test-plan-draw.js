'use strict';

// Synthetic, offline regressions. Run: node --test test-plan-draw.js
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scripts = path.resolve(__dirname, '../scripts/funcs');
const sources = ['query/mt-core.js', 'query/mt-node.js', 'draw/plan-map.js'].map(file => ({
  filename: path.resolve(scripts, file),
  code: fs.readFileSync(path.resolve(scripts, file), 'utf8')
}));
const clone = value => JSON.parse(JSON.stringify(value));

function sandbox() {
  const calls = [];
  const forbidden = name => () => {
    calls.push(name);
    throw new Error('unexpected side effect: ' + name);
  };
  const context = vm.createContext({
    console,
    G: { cityKey: 'synthetic', economyMode: 'free', mapEngine: 'amap', editMode: null, lines: [] },
    __MT_DEBUG: false,
    _metroCloudAutosaveTimer: null,
    _metroCloudAutosaveInFlight: false,
    CityMetroKit: { snapshot: forbidden('snapshot') },
    __officialDraw: { createLine: forbidden('createLine') },
    document: { getElementById: forbidden('DOM') },
    setTimeout: forbidden('timer'),
    fetch: forbidden('network')
  });
  context.window = context;
  context.top = context;
  for (const source of sources) vm.runInContext(source.code, context, { filename: source.filename });
  return { context, MT: context.__metroToolkit, PlanMap: context.PlanMap, calls };
}

function sine(count = 121) {
  return Array.from({ length: count }, (_, i) => [i * .0002, Math.sin(i / 6) * .002]);
}

// Project onto the original polyline and measure progress along it. Latitude
// and longitude may legitimately reverse; neither is a path-order oracle.
function project(point, polyline) {
  let best = { distance: Infinity, progress: 0 };
  let traversed = 0;
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1], b = polyline[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    const t = length ? Math.max(0, Math.min(1,
      ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (length * length))) : 0;
    const distance = Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
    if (distance < best.distance) best = { distance, progress: traversed + t * length };
    traversed += length;
  }
  return best;
}

function assertPathOrder(points, original) {
  const projections = points.map(p => project(p, original));
  for (let i = 1; i < projections.length; i++) {
    assert.ok(projections[i].progress + 1e-10 >= projections[i - 1].progress,
      `path backtracking at ${i}: ${projections[i - 1].progress} -> ${projections[i].progress}`);
  }
}

function assertSpacing(MT, points, gap = 30) {
  for (let i = 1; i < points.length; i++) {
    const actual = MT.haversine(points[i - 1], points[i]);
    assert.ok(actual >= gap - 1e-6, `near-duplicate at ${i}: ${actual}m < ${gap}m`);
  }
}

function compiledFixture() {
  const points = sine().map(([lng, lat]) => [116 + lng, 39 + lat]);
  return {
    ok: true, fit: { ok: true, maxErrorM: 3 }, crs: 'gcj02',
    lines: [{
      name: 'Synthetic planning line', color: '#AABBCC',
      spec: { trainType: 'B', trainCars: 6, maxSpeedKmh: 80 }, specSource: 'synthetic test specification',
      stations: [0, 60, 120].map((i, n) => ({ name: `Synthetic ${n}`, lng: points[i][0], lat: points[i][1] })),
      paths: [points.slice(0, 61), points.slice(60)]
    }]
  };
}

function checkedFixture() {
  const env = sandbox();
  const plan = env.PlanMap.prepare(compiledFixture(), 0);
  const line = {
    id: 'synthetic-line', name: plan.name, color: plan.color, ...clone(plan.spec),
    stations: plan.stations.map(s => ({ name: s.name, latlng: { lng: s.lng, lat: s.lat } })),
    segmentAnchors: plan.nodes.map(segment => segment.map(([lng, lat]) => ({ lng, lat }))),
    pendingAnchors: [], isRing: false, branchRootId: null
  };
  env.context.G.lines.push(line);
  return { ...env, plan, line };
}

test('curvatureThin: sine tolerance 6 preserves endpoints, 30m gaps and path order', () => {
  const { MT } = sandbox();
  assert.equal(MT.__nodeVersion, '6.5.4');
  const points = sine(), before = clone(points);
  const result = MT.curvatureThin(points, { tolerance: 6, minGapM: 30 });
  assert.ok(result.length > 2, 'curvature must not collapse to the endpoint chord');
  assert.deepEqual(clone(result[0]), points[0]);
  assert.deepEqual(clone(result.at(-1)), points.at(-1));
  assert.deepEqual(points, before, 'input must not be changed');
  assertSpacing(MT, result);
  assertPathOrder(result, points);
});

test('curvatureThin: overlapping gradients at adjacent sharp bends stay in path order', () => {
  const { MT } = sandbox();
  const points = [[0, 0], [.006, 0], [.006, .004], [.002, .004], [.002, .008], [.008, .008]];
  // Also reverse the route: neither increasing longitude nor latitude is required.
  for (const original of [points, points.slice().reverse()]) {
    const result = MT.curvatureThin(original, { tolerance: 6, minGapM: 30 });
    assert.ok(result.length > original.length, 'fixture must exercise gradient insertion');
    assert.deepEqual(clone(result[0]), original[0]);
    assert.deepEqual(clone(result.at(-1)), original.at(-1));
    assertSpacing(MT, result);
    assertPathOrder(result, original);
    for (const bend of original.slice(1, -1)) {
      assert.ok(result.some(p => MT.haversine(p, bend) < 1e-6), 'sharp bend must survive');
    }
  }
});

for (const engine of ['amap', 'osm']) {
  for (const crs of ['gcj02', 'wgs84']) {
    test(`prepare: explicit ${crs} source on ${engine} converts stations and paths consistently`, () => {
      const { context, MT, PlanMap, calls } = sandbox();
      context.G.mapEngine = engine;
      const compiled = compiledFixture();
      compiled.crs = crs;
      const before = clone(compiled);
      const plan = PlanMap.prepare(compiled, 0);
      const target = engine === 'osm' ? 'wgs84' : 'gcj02';
      const convert = p => crs === target ? p : target === 'wgs84'
        ? MT.gcj02ToWgs84(...p) : MT.wgs84ToGcj02(...p);
      assert.equal(plan.crs, target);
      assert.equal(plan.color, '#aabbcc');
      assert.equal(plan.registrationMaxM, 3);
      assert.deepEqual(clone(plan.spec), compiled.lines[0].spec);
      assert.equal(plan.specSource, compiled.lines[0].specSource);
      plan.stations.forEach((station, i) => {
        const source = compiled.lines[0].stations[i];
        assert.deepEqual([station.lng, station.lat], clone(convert([source.lng, source.lat])));
      });
      plan.paths.forEach((segment, i) => {
        assert.deepEqual(clone(segment), compiled.lines[0].paths[i].map(p => clone(convert(p))));
        assert.ok(plan.nodes[i].length > 0);
        const a = plan.stations[i], b = plan.stations[i + 1];
        for (const p of plan.nodes[i]) {
          assert.ok(MT.haversine(p, [a.lng, a.lat]) >= 100);
          assert.ok(MT.haversine(p, [b.lng, b.lat]) >= 100);
        }
        assertPathOrder(plan.nodes[i], segment);
      });
      assert.deepEqual(compiled, before);
      assert.deepEqual(calls, []);
    });
  }
}

const invalidPreparations = [
  ['unverified compilation', c => { c.ok = false; }, /unverified/],
  ['unverified registration', c => { c.fit.ok = false; }, /unverified/],
  ['missing CRS', c => { delete c.crs; }, /explicit source CRS/],
  ['unsupported CRS', c => { c.crs = 'guess'; }, /explicit source CRS/],
  ['missing spec', c => { delete c.lines[0].spec; }, /train specification/],
  ['missing spec source', c => { delete c.lines[0].specSource; }, /train specification/],
  ['missing path', c => { c.lines[0].paths.pop(); }, /invalid line shape/],
  ['empty path', c => { c.lines[0].paths[0] = []; }, /missing image segment/],
  ['wrong starting endpoint', c => { c.lines[0].paths[0][0][0] += .001; }, /endpoint\/order mismatch/],
  ['wrong ending endpoint', c => { c.lines[0].paths[0].at(-1)[0] += .001; }, /endpoint\/order mismatch/],
  ['reversed path', c => { c.lines[0].paths[0].reverse(); }, /endpoint\/order mismatch/],
  ['nonfinite path', c => { c.lines[0].paths[0][10][0] = NaN; }, /non-finite/],
  ['no node beyond 100m platforms', c => {
    const line = c.lines[0];
    line.stations = [{ name: 'A', lng: 116, lat: 39 }, { name: 'B', lng: 116.001, lat: 39 }];
    line.paths = [[[116, 39], [116.0005, 39.00001], [116.001, 39]]];
  }, /no image-derived node outside platforms/]
];
for (const [name, mutate, expected] of invalidPreparations) {
  test(`prepare rejects ${name}`, () => {
    const { PlanMap, calls } = sandbox();
    const compiled = compiledFixture();
    mutate(compiled);
    assert.throws(() => PlanMap.prepare(compiled, 0), expected);
    assert.deepEqual(calls, []);
  });
}

test('check accepts exact synthetic line and reports counts, distances and registration', () => {
  const { PlanMap, plan, line } = checkedFixture();
  const result = PlanMap.check(line.id, plan);
  assert.equal(result.ok, true);
  assert.deepEqual(clone(result.errors), []);
  assert.equal(result.stations, plan.stations.length);
  assert.equal(result.nodes, plan.nodes.reduce((n, segment) => n + segment.length, 0));
  assert.equal(result.maxStationM, 0);
  assert.equal(result.maxNodeM, 0);
  assert.ok(result.minPlatformM >= 100);
  assert.equal(result.registrationMaxM, 3);
  assert.deepEqual(clone(PlanMap.check('absent', plan)), { ok: false, errors: ['line missing'] });
});

const invalidChecks = [
  ['station count', l => { l.stations.pop(); }, 'station count'],
  ['station order', l => { l.stations.reverse(); }, 'station name/order 0'],
  ['station coordinates', l => { l.stations[0].latlng.lng += .001; }, 'station coordinates'],
  ['segment count', l => { l.segmentAnchors.pop(); }, 'segment count'],
  ['node count', l => { l.segmentAnchors[0].pop(); }, 'node count 0'],
  ['node order', l => { l.segmentAnchors[0].reverse(); }, 'node coordinates/order'],
  ['node coordinates', l => { l.segmentAnchors[0][0].lng += .001; }, 'node coordinates/order'],
  ['platform clearance', l => { l.segmentAnchors[0][0] = { ...l.stations[0].latlng }; }, 'platform clearance'],
  ['color', l => { l.color = '#000000'; }, 'color'],
  ['train type', l => { l.trainType = 'A'; }, 'trainType'],
  ['train cars', l => { l.trainCars++; }, 'trainCars'],
  ['speed', l => { l.maxSpeedKmh++; }, 'maxSpeedKmh'],
  ['ring topology', l => { l.isRing = true; }, 'unexpected topology'],
  ['branch topology', l => { l.branchRootId = 'other'; }, 'unexpected topology'],
  ['pending nodes', l => { l.pendingAnchors.push({ lng: 116, lat: 39 }); }, 'pending nodes']
];
for (const [name, mutate, expected] of invalidChecks) {
  test(`check rejects ${name}`, () => {
    const { PlanMap, plan, line } = checkedFixture();
    mutate(line);
    const before = clone(line);
    const result = PlanMap.check(line.id, plan);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes(expected), JSON.stringify(result));
    assert.deepEqual(clone(line), before, 'check must be read-only');
  });
}

const preflights = [
  ['old business mode', c => { c.G.economyMode = 'business'; }, /isolated creative city/],
  ['wrong city', c => { c.G.cityKey = 'old-city'; }, /isolated creative city/],
  ['implicit city', (c, o) => { delete o.cityKey; }, /isolated creative city/],
  ['implicit local scope', (c, o) => { delete o.localOnly; }, /local test-save scope/],
  ['existing place edit', c => { c.G.editMode = 'place'; }, /finish existing edit/],
  ['existing add-station edit', c => { c.G.editMode = 'add-station'; }, /finish existing edit/],
  ['cloud timer', c => { c._metroCloudAutosaveTimer = 123; }, /disable cloud autosave/],
  ['cloud save in flight', c => { c._metroCloudAutosaveInFlight = true; }, /cloud save in flight/],
  ['changed map engine', c => { c.G.mapEngine = 'osm'; }, /map engine changed/],
  ['same line name', (c, o, p) => { c.G.lines.push({ id: 'existing', name: p.name }); }, /line already exists/]
];
for (const [name, mutate, expected] of preflights) {
  test(`draw preflight refuses ${name} before any side effect`, async () => {
    const { context, PlanMap, calls } = sandbox();
    const plan = PlanMap.prepare(compiledFixture(), 0);
    const opts = { cityKey: 'synthetic', localOnly: true };
    mutate(context, opts, plan);
    const before = clone(context.G), planBefore = clone(plan);
    await assert.rejects(() => PlanMap.draw(plan, opts), expected);
    assert.deepEqual(calls, [], 'must not snapshot, draw, touch DOM, schedule timers or fetch');
    assert.deepEqual(clone(context.G), before);
    assert.deepEqual(clone(plan), planBefore);
  });
}
