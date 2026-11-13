#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const sources = ['mt-core.js', 'mt-amap.js'].map(name => ({
  name, code: fs.readFileSync(path.join(ROOT, 'scripts/funcs/query', name), 'utf8'),
}));
const METRO = '交通设施服务;地铁站;地铁站';
function poi(name, address = '', extra = {}) {
  return { name, address, type: METRO, typecode: '150500', location: [118.8, 32.05], ...extra };
}
function harness(pois = [], opts = {}) {
  const calls = [], requests = [];
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout,
    G: { lines: [], currentCity: 'nanjing', mapEngine: 'amap' },
    fetch: async url => {
      requests.push(url);
      assert.ok(opts.freePois, 'Unexpected fetch: only mocked free POIs are allowed');
      return { json: async () => ({ status: '1', pois: opts.freePois }) };
    },
  });
  ctx.window = ctx;
  if (!opts.noAmap) ctx.AMap = {
    plugin(names, ready) { ready(); },
    PlaceSearch: class {
      constructor(config) { this.config = config; }
      search(keyword, done) {
        calls.push({ keyword, ...this.config });
        done(opts.status || 'complete', { poiList: { pois } });
      }
    },
  };
  for (const src of sources) vm.runInContext(src.code, ctx, { filename: src.name });
  const MT = ctx.__metroToolkit;
  if (opts.freePois) MT.webKey('mock-only');
  if (opts.srh) ctx.__MT_SUBMETRO_DATA = { nanjing: { l: opts.srh } };
  return { ctx, MT, calls, requests, query: (line, options) => MT.queryLineStopsByPOI('nanjing', line, options) };
}
const names = result => Array.from(result.stops, s => s.name);
const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('keyword searches cannot authorize Nanjing railway/unrelated metro POIs', async () => {
  const h = harness([
    poi('南京站', '', { type: '交通设施服务;火车站;火车站', typecode: '150200' }),
    poi('南京南站', '', { type: '交通设施服务;火车站;火车站', typecode: '150200' }),
    poi('南京交院(地铁站)', '地铁1号线'),
    poi('南京南(地铁站)', '地铁S1号线;地铁3号线'),
  ]);
  const result = await h.query('16');
  assert.equal(result.ok, false);
  assert.equal(result.count, 0);
  assert.equal(h.calls.length, 5);
  assert.ok(h.calls.every(c => c.keyword.includes('16') && c.pageSize === 25));
  assert.equal(result.rejectedCount, 4, 'Repeated keywords must not inflate rejection counts');
  assert.ok(result.rejected.some(p => p.name === '南京交院(地铁站)' && p.address === '地铁1号线'));
});

test('public game POIs retain address and typecode', async () => {
  const h = harness([poi('甲(地铁站)', '地铁16号线')]);
  const result = await h.MT.placeSearch('nanjing', '16号线');
  assert.equal(result.pois[0].address, '地铁16号线');
  assert.equal(result.pois[0].typecode, '150500');
  assert.equal(result.pois[0].lng, 118.8);
});

test('public free POIs retain address/typecode and provide line evidence', async () => {
  const freePois = ['甲', '乙'].map(n => poi(n + '(地铁站)', '地铁16号线', { location: '118.8,32.05' }));
  const h = harness([], { noAmap: true, freePois });
  const result = await h.MT.placeSearch('nanjing', '16号线', { via: 'free' });
  assert.equal(result.pois[0].address, '地铁16号线');
  assert.equal(result.pois[0].typecode, '150500');
  assert.equal((await h.query('16')).ok, true);
  assert.equal(h.requests.length, 6);
});

test('exact line boundaries distinguish S1/1, 16/6 and composite labels', async () => {
  for (const [evidence, target] of [['S1', '1'], ['1', 'S1'], ['16', '6'], ['6', '16'], ['116', '16'], ['S16', '16'], ['2-9', '9'], ['2-9', '2'], ['2', '2-9'], ['9', '2-9']]) {
    for (const field of ['name', 'address']) {
      const candidates = ['甲', '乙'].map(n => field === 'name'
        ? poi(n + '(地铁' + evidence + '号线)') : poi(n + '(地铁站)', '地铁' + evidence + '号线'));
      const result = await harness(candidates).query(target);
      assert.equal(result.ok, false, `${field}: ${evidence} must not prove ${target}`);
      assert.equal(result.count, 0);
    }
  }
});

test('positive address evidence and transfer lines are accepted', async () => {
  const result = await harness([
    poi('甲(地铁站)', '南京市地铁16号线'),
    poi('乙(地铁站)', '地铁6号线;地铁16号线'),
    poi('丙(地铁站)', '地铁6号线'),
  ]).query('16号线');
  assert.equal(result.ok, true);
  assert.deepEqual(names(result), ['甲', '乙']);
  assert.equal(result.rejectedCount, 1);
});

test('normalized S1 name/address evidence is accepted without numeric core mismatch', async () => {
  const result = await harness([
    poi('甲(地铁S1号线)'), poi('乙(地铁站)', '轨道交通 s1 线'),
  ]).query(' 地铁 s1 号线 ');
  assert.equal(result.ok, true);
  assert.equal(result.lineNo, 'S1');
  assert.deepEqual(names(result), ['甲', '乙']);
});

test('empty/missing/array addresses and repeated result counts prove no line', async () => {
  const candidates = ['', null, undefined, []].map((address, i) => poi('测试' + i + '(地铁站)', address));
  const result = await harness(candidates).query('16');
  assert.equal(result.ok, false);
  assert.equal(result.count, 0);
  assert.equal(result.rejectedCount, 4);
});

test('9A exits and entrance categories are rejected even with evidence and whitelist', async () => {
  const candidates = ['元通地铁站9A出口', '元通地铁站9A口', '元通地铁站A9口', '元通地铁站A出口', '元通地铁站入口', '元通地铁站1号口', '元通地铁站9A出入口'].map(n => poi(n, '地铁2-9号线'));
  candidates.push(poi('甲(地铁站)', '地铁2-9号线', { typecode: '150501' }));
  candidates.push(poi('乙(地铁站)', '地铁2-9号线', { type: '交通设施服务;地铁站;出入口' }));
  for (const options of [undefined, { stations: candidates.map(p => p.name) }]) {
    const result = await harness(candidates).query('2-9', options);
    assert.equal(result.ok, false);
    assert.equal(result.count, 0);
    assert.equal(result.rejectedCount, candidates.length);
    assert.ok(result.rejected.every(p => p.reason === 'exit_noise'));
  }
});

test('railway/bus categories cannot be authorized by line text or whitelist', async () => {
  const candidates = [
    poi('铁路甲', '地铁16号线', { typecode: '150200' }),
    poi('公交乙', '地铁16号线', { typecode: '150700' }),
    poi('汽车丙', '地铁16号线', { typecode: '150300' }),
    poi('铁路丁', '地铁16号线', { type: '交通设施服务;火车站', typecode: '' }),
    poi('公交戊', '地铁16号线', { type: '交通设施服务;公交车站', typecode: '' }),
    poi('商店', '地铁16号线', { type: '购物服务', typecode: '060000' }),
  ];
  const result = await harness(candidates).query('16', { stations: candidates.map(p => p.name) });
  assert.equal(result.ok, false);
  assert.equal(result.count, 0);
  assert.equal(result.rejectedCount, candidates.length);
});

test('metro typecode is positive category evidence when textual type is absent', async () => {
  const result = await harness(['甲', '乙'].map(n => poi(n, '地铁16号线', { type: '' }))).query('16');
  assert.equal(result.ok, true);
});

test('explicit station order is an exact whitelist; unmatched POIs are not appended', async () => {
  const result = await harness([
    poi('甲(地铁站)'), poi('乙地铁站', '地铁6号线'),
    poi('乙东(地铁站)', '地铁16号线'), poi('丙(地铁站)', '地铁16号线'),
    poi('甲(地铁站)'),
  ]).query('16', { stations: ['乙（地铁站）', '甲站', '甲', '未解析'] });
  assert.equal(result.ok, true);
  assert.deepEqual(names(result), ['乙', '甲']);
  assert.equal(result.count, 2);
  assert.equal(result.rejectedCount, 2);
  assert.ok(result.rejected.every(p => p.reason === 'not_in_station_order'));
});

test('explicit empty station order admits nothing', async () => {
  const result = await harness(['甲', '乙'].map(n => poi(n, '地铁16号线'))).query('16', { stations: [] });
  assert.equal(result.ok, false);
  assert.equal(result.count, 0);
});

test('city, coordinate and placeholder checks remain enforced', async () => {
  const result = await harness([
    poi('甲', '地铁16号线', { location: null }),
    poi('乙', '地铁16号线', { location: [0, 0] }),
    poi('站1', '地铁16号线'),
  ]).query('16', { stations: ['甲', '乙', '站1'] });
  assert.equal(result.ok, false);
  assert.equal(result.count, 0);
  assert.equal(result.rejectedCount, 3);
});

test('rejection diagnostics are deduplicated, capped and truncated', async () => {
  const result = await harness(Array.from({ length: 25 }, (_, i) => poi('噪声' + i + '长'.repeat(200), '地址'.repeat(300)))).query('16');
  assert.equal(result.ok, false);
  assert.equal(result.rejectedCount, 25);
  assert.ok(result.rejected.length > 0 && result.rejected.length <= 5);
  assert.ok(JSON.stringify(result.rejected).length < 2000);
  assert.ok(result.reason.includes('证据'));
});

test('no data and one proven station remain unresolved', async () => {
  for (const h of [harness(), harness([], { status: 'no_data' }), harness([], { noAmap: true }), harness([poi('甲', '地铁16号线')])]) {
    const result = await h.query('16');
    assert.equal(result.ok, false);
    assert.ok(result.count < 2);
    assert.equal(result.rejectedCount, 0);
    assert.equal(result.rejected.length, 0);
    assert.ok(result.reason);
  }
});

test('srhdata fallback preserves explicit order and exact line identity', async () => {
  const srh = [{ ln: 'S1号线', st: ['甲', '乙', '丙'].map(n => ({ n, sl: '118.8,32.05' })) }];
  for (const noAmap of [true, false]) {
    const h = harness([poi('无关站')], { noAmap, srh });
    const result = await h.query('S1', { stations: ['乙', '甲'] });
    assert.equal(result.ok, true);
    assert.equal(result.dataSource, 'srhdata');
    assert.deepEqual(names(result), ['乙', '甲']);
    assert.equal(result.rejectedCount, noAmap ? 0 : 1);
    assert.equal((await h.query('1')).ok, false);
    assert.equal((await h.query('S1', { stations: ['甲', '未解析'] })).ok, false);
  }
});

test('amap 6.5.3 guard replaces 6.5.2 and stays idempotent', () => {
  const h = harness();
  assert.equal(h.MT.__amapVersion, '6.5.3');
  const current = h.MT.queryLineStopsByPOI;
  vm.runInContext(sources[1].code, h.ctx);
  assert.equal(h.MT.queryLineStopsByPOI, current);
  h.MT.__amapVersion = '6.5.2';
  vm.runInContext(sources[1].code, h.ctx);
  assert.equal(h.MT.__amapVersion, '6.5.3');
  assert.notEqual(h.MT.queryLineStopsByPOI, current);
});

(async () => {
  let passed = 0;
  for (const { name, run } of tests) {
    try { await run(); passed++; console.log('PASS ' + name); }
    catch (error) { console.error('FAIL ' + name + '\n' + error.stack); }
  }
  console.log(`plan-poi: ${passed}/${tests.length} passed, ${tests.length - passed} failed`);
  if (passed !== tests.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
