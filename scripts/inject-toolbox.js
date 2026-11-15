#!/usr/bin/env node
/**
 * inject-toolbox.js — 城市地铁工具箱「一次注入」编排器（Node 侧驱动 CDP）
 * =====================================================================
 * 稳定依赖顺序（依赖先于被依赖，按 dependsOn 拓扑排序；声明顺序已按此排列）：
 *   mt-core → mt-node → mt-amap → od → k
 *   → plan-map → ops → official-edit → fare-lab → autopilot
 *   → mode-registry → hsr-probe → air-probe
 *   注意：autopilot 依赖 Ops/OfficialEdit/K，必须排在 official-edit 之后（原 §2.4 列表顺序相反）。
 *   本清单只含 13 个「核心工具箱模块」（5 必需 + 8 可选）；不含可选数据注入
 *   metro-unopened-paths.js，也不含 srhdata（__SUBMETRO_DATA / __MT_SUBMETRO_DATA）——二者按需单独注入。
 *
 * 设计约束（与文档口径一致）：
 *   1. 幂等：页面已是期望版本 → skip，不重复注入；模块自带的同版守卫是第二道保险。
 *   2. 不半装、不假装成功：本地缺文件 / 页面版本比期望更新 → 注入前就失败退出；
 *      必需模块注入后版本不符 → 立即中止后续，报告 partial=true 与已装清单。
 *   3. 每模块注入后立刻读回版本，按模块归属失败，不靠"脚本执行完就当成功"；
 *      收尾读取失败时回退逐模块/预检值，仍无法确认则标 unverified 并判降级/失败（绝不 ok=true + 版本全空）。
 *   4. 报告齐全：加载结果 + 版本表（含 source：final/per-module/preflight/unverified）+ 缺失清单 +
 *      版本不符清单 + 退化标记；结论写回页面 window.__metroToolboxInjection，供事后核对。
 *   5. partial 只表示「必需模块失败导致中止」；可选模块缺失/失败只算 degraded（exit 2）。
 *   6. 不改动既有全局 API（__metroToolkit / __officialDraw / CityMetroKit / ...），
 *      只新增 __metroToolboxInjection（页面报告）与 __metroToolboxManifest / __metroToolboxVerify（只读自检）。
 *
 * Node 用法（驱动 CDP 控制服务；仓库 browser/cdp.mjs 提供 POST /script {file}、POST /eval {expr}）：
 *   node skills/city-metro-builder/scripts/inject-toolbox.js --cdp <控制服务地址>
 *   node ... --dry-run            # 只预检+读版本表，不注入
 *   node ... --json               # 机器可读报告（stdout 仅 JSON）
 *   node ... --required-only      # 只装 5 个必需模块
 *   node ... --optional ops,fare-lab
 *   node ... --allow-downgrade    # 允许覆盖比期望更新的页面版本（默认拒绝）
 * 退出码：0 全绿 · 2 降级（必需全绿、可选有失败）· 1 失败或中止 · 64 用法错误
 *
 * 页面内注入本文件时只安装只读助手，不做任何安装：
 *   window.__metroToolboxManifest()   // 清单（顺序/分组/期望版本/依赖）
 *   window.__metroToolboxVerify()     // 只读版本核对 → 与 Node 端同结构报告
 */
(function () {
  'use strict';

  // Node / 页面判定：Electron 渲染进程同时有 process 和 window，必须走页面分支（只装只读助手），
  // 否则会在没有 require 的渲染进程里抛错；Electron 主进程（无 window）仍按 Node 处理。
  const HAS_WINDOW = typeof window !== 'undefined';
  const PROC = typeof process !== 'undefined' ? process : null;
  const HAS_NODE_MODULE = typeof module === 'object' && !!module && typeof require === 'function';
  const IS_ELECTRON_RENDERER = !!PROC && !!(PROC.versions && PROC.versions.electron) && HAS_WINDOW;
  const IS_NODE = !!PROC && !!(PROC.versions && PROC.versions.node) && HAS_NODE_MODULE && !IS_ELECTRON_RENDERER;
  const EXIT = { OK: 0, FAIL: 1, DEGRADED: 2, USAGE: 64 };

  /** 注入清单：id / 分组 / 路径（相对技能根）/ 期望全局与版本 / 依赖。顺序即权威注入顺序。 */
  const MANIFEST = [
    { id: 'mt-core', label: 'MT core', group: 'required', file: 'scripts/funcs/query/mt-core.js', global: '__metroToolkit', versionPath: ['__metroToolkit', '__coreVersion'], expect: '6.5.3', dependsOn: [] },
    { id: 'mt-node', label: 'MT node', group: 'required', file: 'scripts/funcs/query/mt-node.js', global: '__metroToolkit', versionPath: ['__metroToolkit', '__nodeVersion'], expect: '6.5.4', dependsOn: ['mt-core'] },
    { id: 'mt-amap', label: 'MT amap', group: 'required', file: 'scripts/funcs/query/mt-amap.js', global: '__metroToolkit', versionPath: ['__metroToolkit', '__amapVersion'], expect: '6.5.3', dependsOn: ['mt-core'] },
    { id: 'od', label: 'OD', group: 'required', file: 'scripts/funcs/draw/od.js', global: '__officialDraw', versionPath: ['__officialDraw', '__version'], expect: '2.60.3', dependsOn: ['mt-core', 'mt-node', 'mt-amap'] },
    { id: 'k', label: 'K', group: 'required', file: 'scripts/funcs/manage/k.js', global: 'CityMetroKit', versionPath: ['CityMetroKit', '__version'], expect: '2.9', dependsOn: ['mt-core', 'od'] },
    { id: 'plan-map', label: 'PlanMap', group: 'optional', file: 'scripts/funcs/draw/plan-map.js', global: 'PlanMap', versionPath: ['PlanMap', 'version'], expect: '1.1.1', dependsOn: ['mt-core', 'od', 'k'] },
    { id: 'ops', label: 'Ops', group: 'optional', file: 'scripts/funcs/ops/ops.js', global: 'MetroOps', versionPath: ['MetroOps', '__version'], expect: '1.3.5', dependsOn: ['k'] },
    { id: 'official-edit', label: 'OfficialEdit', group: 'optional', file: 'scripts/funcs/manage/official-edit.js', global: 'OfficialEdit', versionPath: ['OfficialEdit', 'version'], expect: '1.1.8', dependsOn: ['mt-core', 'od'] },
    { id: 'fare-lab', label: 'FareLab', group: 'optional', file: 'scripts/funcs/manage/fare-lab.js', global: 'FareLab', versionPath: ['FareLab', 'version'], expect: '1.0.1', dependsOn: ['ops'] },
    { id: 'autopilot', label: 'Autopilot', group: 'optional', file: 'scripts/funcs/ops/autopilot.js', global: 'MetroAutopilot', versionPath: ['MetroAutopilot', 'version'], expect: '0.3.2', dependsOn: ['ops', 'official-edit', 'k'] },
    { id: 'mode-registry', label: 'Modes', group: 'optional', file: 'scripts/funcs/modes/mode-registry.js', global: 'CityTransportModes', versionPath: ['CityTransportModes', '__version'], expect: '0.1.0', dependsOn: [] },
    { id: 'hsr-probe', label: 'HsrProbe', group: 'optional', file: 'scripts/funcs/modes/hsr-probe.js', global: 'HsrProbe', versionPath: ['HsrProbe', '__version'], expect: '0.1.0', dependsOn: [] },
    { id: 'air-probe', label: 'AirProbe', group: 'optional', file: 'scripts/funcs/modes/air-probe.js', global: 'AirProbe', versionPath: ['AirProbe', '__version'], expect: '0.1.0', dependsOn: [] },
  ];

  const clone = (v) => JSON.parse(JSON.stringify(v));

  function compareVersions(a, b) {
    const pa = String(a == null ? '' : a).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
    const pb = String(b == null ? '' : b).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  /** 读页面某个版本路径的表达式（只读，绝不写页面状态）；phase 只作注释标记，便于 CDP 日志分辨预检/逐模块/收尾。 */
  function versionExpr(pairs, phase) {
    const expr = '(() => { var out = {}; var pairs = ' + JSON.stringify(pairs) +
      '; for (var i = 0; i < pairs.length; i++) { var v = window; var p = pairs[i][1];' +
      ' for (var j = 0; j < p.length; j++) { if (v == null) { v = null; break; } v = v[p[j]]; }' +
      ' out[pairs[i][0]] = (v == null ? null : String(v)); } return out; })()';
    const tag = phase ? String(phase).replace(/[^a-z0-9_-]/gi, '') : '';
    return tag ? expr + ' /* phase:' + tag + ' */' : expr;
  }

  /** 按清单核对页面全局版本（页面侧与 Node 侧共用）。 */
  function verifyAgainst(modules, readLive) {
    const versionTable = [];
    const missing = [];
    const mismatched = [];
    for (const m of modules) {
      const actual = readLive(m);
      versionTable.push({ id: m.id, label: m.label, group: m.group, global: m.global, versionKey: m.versionPath.join('.'), expected: m.expect, actual: actual, status: statusOf(m, actual) });
      if (actual == null) missing.push({ id: m.id, global: m.global });
      else if (String(actual) !== String(m.expect)) mismatched.push({ id: m.id, expected: m.expect, actual: String(actual) });
    }
    const coreBad = versionTable.filter((r) => r.group === 'required' && r.status !== 'ok');
    const anyBad = versionTable.filter((r) => r.status !== 'ok');
    return {
      ok: anyBad.length === 0,
      coreOk: coreBad.length === 0,
      degraded: coreBad.length === 0 && anyBad.length > 0,
      versionTable: versionTable,
      missing: missing,
      mismatched: mismatched,
    };
  }

  function statusOf(m, actual) {
    if (actual == null) return 'unverified';
    const cmp = compareVersions(actual, m.expect);
    if (cmp === 0) return 'ok';
    return cmp < 0 ? 'outdated' : 'newer';
  }

  /**
   * 稳定拓扑排序：依赖先于被依赖；同一就绪层保持声明顺序。
   * 声明顺序已是依赖序，这里再排一次是为了让未来改 MANIFEST 也不会把 official-edit 排到 autopilot 之后。
   */
  function dependencyOrder(modules) {
    const byId = new Map(modules.map((m) => [m.id, m]));
    const visited = new Set();
    const temp = new Set();
    const cycles = [];
    const out = [];
    const visit = (m) => {
      if (visited.has(m.id)) return;
      if (temp.has(m.id)) { cycles.push(m.id); return; }
      temp.add(m.id);
      for (const dep of (m.dependsOn || [])) {
        const d = byId.get(dep);
        if (d) visit(d);
      }
      temp.delete(m.id);
      visited.add(m.id);
      out.push(m);
    };
    for (const m of modules) visit(m);
    const declared = modules.map((m) => m.id);
    const ordered = out.map((m) => m.id);
    const orderViolations = ordered.filter((id, i) => declared[i] !== id);
    const missingDeps = [];
    for (const m of modules) {
      for (const dep of (m.dependsOn || [])) if (!byId.has(dep)) missingDeps.push(m.id + '->' + dep);
    }
    return { order: out, cycles: Array.from(new Set(cycles)), orderViolations, missingDeps };
  }

  // ── 页面侧：只读助手（不安装任何模块） ──────────────────────────────────
  if (!IS_NODE) {
    if (typeof window === 'undefined') return;
    const w = window;
    const publicEntry = (m) => ({
      id: m.id, label: m.label, group: m.group, file: m.file, global: m.global,
      versionPath: m.versionPath, expect: m.expect, dependsOn: m.dependsOn,
    });
    w.__metroToolboxManifest = function () {
      return {
        source: 'inject-toolbox.js',
        scope: {
          coreModules: MANIFEST.length,
          required: MANIFEST.filter((m) => m.group === 'required').length,
          optional: MANIFEST.filter((m) => m.group === 'optional').length,
          excludes: [
            'scripts/funcs/query/metro-unopened-paths.js（可选数据注入，不在本清单，按需单独注入）',
            'srhdata（window.__SUBMETRO_DATA / window.__MT_SUBMETRO_DATA，运行时注入数据，不在本清单）',
          ],
        },
        order: dependencyOrder(MANIFEST).order.map((m) => m.id),
        required: MANIFEST.filter((m) => m.group === 'required').map(publicEntry),
        optional: MANIFEST.filter((m) => m.group === 'optional').map(publicEntry),
        dependencies: MANIFEST.filter((m) => (m.dependsOn || []).length).map((m) => ({ id: m.id, dependsOn: m.dependsOn })),
      };
    };
    w.__metroToolboxVerify = function () {
      const read = (m) => {
        try {
          let v = w;
          for (let i = 0; i < m.versionPath.length; i++) {
            if (v == null) return null;
            v = v[m.versionPath[i]];
          }
          return v == null ? null : String(v);
        } catch (e) {
          return null;
        }
      };
      const r = verifyAgainst(MANIFEST, read);
      r.source = 'inject-toolbox.js';
      r.at = new Date().toISOString();
      return r;
    };
    return;
  }

  // ── Node 侧：CDP 编排 ────────────────────────────────────────────────────
  const fs = require('node:fs');
  const path = require('node:path');

  // 默认控制服务 = 本机 CDP 控制端口（仓库 browser/cdp.mjs 的默认端口）；用 --cdp 或 $CDP_URL 覆盖。
  const DEFAULT_CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'; // 代码默认值；帮助文本与文档不写具体地址
  const DEFAULT_TIMEOUT = 15000;

  function usage() {
    return [
      'inject-toolbox.js — 地铁工具箱一次注入（幂等，稳定依赖顺序）',
      '',
      '范围: 13 个核心模块（5 必需 + 8 可选）；不含可选数据注入 metro-unopened-paths.js，',
      '      也不含 srhdata（__SUBMETRO_DATA / __MT_SUBMETRO_DATA）——二者按需单独注入。',
      '',
      '用法: node scripts/inject-toolbox.js [选项]',
      '',
      '  --cdp <url>            CDP 控制服务地址（默认 $CDP_URL；未设置时用本机 CDP 默认端口）',
      '  --root <dir>           技能根目录（默认本文件上一级）',
      '  --dry-run              只预检并打印版本表，不注入',
      '  --json                 输出 JSON 报告（stdout 仅 JSON）',
      '  --required-only        只注入 5 个必需模块',
      '  --optional <spec>      all（默认）| none | 逗号分隔的 id 列表',
      '  --skip <ids>           跳过指定 id（逗号分隔）',
      '  --allow-downgrade      允许覆盖比期望更新的页面版本（默认拒绝）',
      '  --force                忽略页面未就绪/需登录的检查',
      '  --timeout <ms>         单次 CDP 请求超时（默认 15000）',
      '  --quiet                只打印结论与失败项',
      '  --help                 显示本帮助',
      '',
      '语义: partial 只表示「必需模块失败导致中止」；可选模块缺失/失败只算 degraded。',
      '退出码: 0 全绿 · 2 降级（可选模块失败）· 1 失败/中止 · 64 用法错误',
    ].join('\n');
  }

  function parseArgs(argv) {
    const o = {
      cdp: DEFAULT_CDP, root: null, dryRun: false, json: false, requiredOnly: false,
      optional: 'all', skip: [], allowDowngrade: false, force: false,
      timeout: DEFAULT_TIMEOUT, quiet: false, help: false,
    };
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      const next = () => {
        const v = argv[++i];
        if (v == null) throw new Error('缺少取值: ' + a);
        return v;
      };
      if (a === '--help' || a === '-h') o.help = true;
      else if (a === '--cdp') o.cdp = next();
      else if (a === '--root') o.root = next();
      else if (a === '--dry-run') o.dryRun = true;
      else if (a === '--json') o.json = true;
      else if (a === '--required-only') o.requiredOnly = true;
      else if (a === '--optional') o.optional = next();
      else if (a === '--skip') o.skip = next().split(',').map((s) => s.trim()).filter(Boolean);
      else if (a === '--allow-downgrade') o.allowDowngrade = true;
      else if (a === '--force') o.force = true;
      else if (a === '--timeout') o.timeout = parseInt(next(), 10) || DEFAULT_TIMEOUT;
      else if (a === '--quiet') o.quiet = true;
      else throw new Error('未知参数: ' + a);
    }
    return o;
  }

  function selectModules(o) {
    const warnings = [];
    const skip = new Set(o.skip);
    let optional = o.optional;
    if (o.requiredOnly) optional = 'none';
    let optSet;
    if (optional === 'all') optSet = new Set(MANIFEST.filter((m) => m.group === 'optional').map((m) => m.id));
    else if (optional === 'none' || optional === '') optSet = new Set();
    else {
      const asked = String(optional).split(',').map((s) => s.trim()).filter(Boolean);
      const known = new Set(MANIFEST.map((m) => m.id));
      optSet = new Set();
      for (const id of asked) {
        if (!known.has(id)) throw new Error('--optional 里的未知模块: ' + id + '（可用: ' + MANIFEST.map((m) => m.id).join(',') + '）');
        const m = MANIFEST.find((x) => x.id === id);
        if (m.group === 'optional') optSet.add(id);
        else warnings.push('--optional 忽略必需模块 ' + id + '（必需模块总会注入）');
      }
    }
    const selected = MANIFEST.filter((m) => !skip.has(m.id) && (m.group === 'required' || optSet.has(m.id)));
    for (const id of skip) {
      const m = MANIFEST.find((x) => x.id === id);
      if (m && m.group === 'required') warnings.push('已按要求跳过必需模块 ' + id + '：依赖它的模块会标记 skipped-dependency');
    }
    return { selected, warnings };
  }

  async function requestJson(url, init, timeout) {
    const res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(timeout) }, init));
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('非 JSON 响应 (HTTP ' + res.status + '): ' + text.slice(0, 200)); }
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (data && data.error ? data.error : text.slice(0, 200)));
    return data;
  }

  function makeClient(o) {
    const cdp = String(o.cdp).replace(/\/+$/, '');
    return {
      cdp,
      async eval(expr) {
        const r = await requestJson(cdp + '/eval', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expr }),
        }, o.timeout);
        if (!r || r.ok !== true) throw new Error('页面 eval 失败: ' + ((r && r.error) || '未知错误'));
        return r.value;
      },
      async injectFile(absFile) {
        const r = await requestJson(cdp + '/script', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: absFile }),
        }, o.timeout);
        if (r && r.ok === false) throw new Error('脚本执行异常: ' + (r.error || '未知错误'));
        return r;
      },
      async status() {
        try {
          return await requestJson(cdp + '/status', { method: 'GET' }, o.timeout);
        } catch (e) {
          return null; // /status 缺失不致命，/eval 能通即可
        }
      },
    };
  }

  function modulePath(root, m) {
    return path.join(root, m.file);
  }

  function missingReport(selected, root) {
    const missing = [];
    for (const m of selected) {
      const abs = modulePath(root, m);
      if (!fs.existsSync(abs)) missing.push({ id: m.id, group: m.group, file: m.file });
      else if (!fs.statSync(abs).isFile() || fs.statSync(abs).size === 0) missing.push({ id: m.id, group: m.group, file: m.file, reason: '空文件' });
    }
    return missing;
  }

  function fmtTable(rows, widths) {
    return rows.map((cells) => cells.map((c, i) => padRight(String(c), widths[i])).join('  ')).join('\n');
  }

  function padRight(s, n) {
    const len = [...s].length; // 按码点算，避免中文错位
    return len >= n ? s : s + ' '.repeat(n - len);
  }

  async function main(argv) {
    let o;
    try {
      o = parseArgs(argv);
    } catch (e) {
      console.error('参数错误: ' + e.message);
      console.error(usage());
      return EXIT.USAGE;
    }
    if (o.help) {
      console.log(usage());
      return EXIT.OK;
    }

    const root = path.resolve(o.root || path.resolve(__dirname, '..'));
    let selection;
    try {
      selection = selectModules(o);
    } catch (e) {
      console.error('参数错误: ' + e.message);
      return EXIT.USAGE;
    }
    const depOrder = dependencyOrder(selection.selected);
    if (depOrder.cycles.length) {
      console.error('MANIFEST 依赖成环，拒绝注入: ' + depOrder.cycles.join(' -> '));
      return EXIT.FAIL;
    }
    const selected = depOrder.order;
    const warnings = selection.warnings.slice();
    if (depOrder.orderViolations.length) {
      warnings.push('MANIFEST 声明顺序与依赖序不一致，已按依赖序注入: ' + depOrder.orderViolations.join(','));
    }
    if (depOrder.missingDeps.length) {
      warnings.push('MANIFEST 声明了不存在的依赖（视为不满足）: ' + depOrder.missingDeps.join(','));
    }
    const startedAt = Date.now();
    const moduleReport = [];
    const say = (line) => { if (!o.quiet && !o.json) console.log(line); };

    // ① 本地预检：缺文件先停，绝不"注入一部分再说"
    const missing = missingReport(selected, root);
    const reqMissing = missing.filter((m) => m.group === 'required');
    const optMissing = missing.filter((m) => m.group === 'optional');
    if (reqMissing.length) {
      const report = {
        ok: false, coreOk: false, degraded: false, partial: false, aborted: true,
        reason: 'missing-files', root: root, at: new Date().toISOString(), durationMs: Date.now() - startedAt,
        missing: missing, mismatched: [], versionTable: [], modules: [],
        warnings: warnings,
      };
      if (o.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.error('预检失败：必需模块文件缺失或为空，未注入任何模块');
        for (const m of missing) console.error('  - ' + m.id + '  ' + m.file + (m.reason ? '（' + m.reason + '）' : ''));
        console.error('修复文件后重跑；可选模块缺失不会中止。');
      }
      return EXIT.FAIL;
    }
    let runSelected = selected;
    if (optMissing.length) {
      for (const m of optMissing) warnings.push('可选模块缺失已跳过: ' + m.id + '（' + m.file + '）');
      const drop = new Set(optMissing.map((m) => m.id));
      runSelected = selected.filter((m) => !drop.has(m.id));
    }

    // ② 连 CDP 读现有版本（读不到就是环境问题，直接失败）
    const client = makeClient(o);
    const st = await client.status();
    if (st && st.needsLogin && !o.force) {
      const msg = '页面未登录（needsLogin=true），不注入。完成登录/进入主界面后重跑，或用 --force 强制。';
      if (o.json) console.log(JSON.stringify({ ok: false, coreOk: false, reason: 'page-not-ready', message: msg }, null, 2));
      else console.error(msg);
      return EXIT.FAIL;
    }
    if (st && !st.ready) warnings.push('页面 /status 未报 ready（可能仍在加载或宿主页面是 iframe）；继续注入，失败项会在报告里列出');

    let live;
    try {
      live = await client.eval(versionExpr(runSelected.map((m) => [m.id, m.versionPath]), 'preflight'));
    } catch (e) {
      const msg = 'CDP 不可用（' + client.cdp + '）：' + e.message + '\n检查控制服务是否已启动，以及 --cdp 是否正确。';
      if (o.json) console.log(JSON.stringify({ ok: false, coreOk: false, reason: 'cdp-unreachable', message: msg }, null, 2));
      else console.error(msg);
      return EXIT.FAIL;
    }

    // ③ 计划：skip / load / 版本不符预检
    const plan = [];
    const blockers = [];
    for (const m of runSelected) {
      const actual = live && live[m.id] != null ? String(live[m.id]) : null;
      const status = statusOf(m, actual);
      let action;
      if (status === 'ok') action = 'skip';
      else if (status === 'newer' && !o.allowDowngrade) {
        action = 'blocked';
        blockers.push({ id: m.id, group: m.group, expected: m.expect, actual: actual, reason: '页面版本比期望更新（默认不覆盖），确认要降级时加 --allow-downgrade' });
      } else action = 'load';
      plan.push({ m, actual: actual, action: action });
    }

    const reqBlocked = blockers.filter((b) => b.group === 'required');
    if (reqBlocked.length) {
      const report = {
        ok: false, coreOk: false, degraded: false, partial: false, aborted: true,
        reason: 'version-blocked', root: root, at: new Date().toISOString(), durationMs: Date.now() - startedAt,
        missing: optMissing, mismatched: blockers.map((b) => ({ id: b.id, expected: b.expected, actual: b.actual })), versionTable: [], modules: [], warnings: warnings,
      };
      if (o.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.error('预检失败：必需模块版本与页面不符，未注入任何模块');
        for (const b of reqBlocked) console.error('  - ' + b.id + '  期望 ' + b.expected + ' / 页面 ' + b.actual + '（页面更新）');
        console.error('确认要覆盖为 ' + reqBlocked.map((b) => b.expected).join('/') + ' 时加 --allow-downgrade。');
      }
      return EXIT.FAIL;
    }
    for (const b of blockers) warnings.push(b.id + ' 页面版本 ' + b.actual + ' 比期望 ' + b.expected + ' 新，已跳过（不降级）');

    if (o.dryRun) {
      const report = {
        ok: plan.every((p) => p.action !== 'blocked'),
        coreOk: true, degraded: plan.some((p) => p.action === 'blocked'), partial: false, dryRun: true,
        root: root, at: new Date().toISOString(), durationMs: Date.now() - startedAt,
        missing: optMissing, mismatched: blockers.map((b) => ({ id: b.id, expected: b.expected, actual: b.actual })),
        scope: {
          coreModules: MANIFEST.length,
          required: MANIFEST.filter((m) => m.group === 'required').length,
          optional: MANIFEST.filter((m) => m.group === 'optional').length,
          excludes: [
            'scripts/funcs/query/metro-unopened-paths.js（可选数据注入，不在本清单）',
            'srhdata（window.__SUBMETRO_DATA / window.__MT_SUBMETRO_DATA，运行时注入数据，不在本清单）',
          ],
        },
        order: plan.map((p) => p.m.id),
        versionTable: plan.map((p) => ({ id: p.m.id, label: p.m.label, group: p.m.group, global: p.m.global, versionKey: p.m.versionPath.join('.'), expected: p.m.expect, actual: p.actual, status: statusOf(p.m, p.actual), source: p.actual == null ? 'unverified' : 'preflight' })),
        plan: plan.map((p) => ({ id: p.m.id, action: p.action, actual: p.actual })), modules: [], warnings: warnings,
      };
      if (o.json) console.log(JSON.stringify(report, null, 2));
      else {
        say('一次注入（dry-run）· 根目录 ' + root);
        say(fmtTable([['#', 'id', '文件', '计划']].concat(plan.map((p, i) => [i + 1, p.m.id, p.m.file, p.action === 'load' ? 'load（现 ' + (p.actual || '无') + '）' : p.action === 'skip' ? 'skip（已 ' + p.actual + '）' : 'blocked（页面 ' + p.actual + ' 更新）'])), [3, 14, 38, 24]));
        if (warnings.length) say('\n警告:\n  - ' + warnings.join('\n  - '));
        say('\n结论: dry-run，未写入页面（' + plan.filter((p) => p.action === 'load').length + ' 个待注入）');
      }
      return report.ok ? EXIT.OK : EXIT.DEGRADED;
    }

    say('一次注入 · 根目录 ' + root);
    say('CDP ' + client.cdp + ' · 清单 ' + runSelected.length + ' 个（必需 ' + runSelected.filter((m) => m.group === 'required').length + ' / 可选 ' + runSelected.filter((m) => m.group === 'optional').length + '）');
    say('');

    // ④ 逐个注入 + 立即读回版本
    // 依赖按"本次计划"判定：§2.4 权威顺序里依赖可能排在后面（如 autopilot 依赖其后的 official-edit），
    // 所以只要依赖在本轮被选中且未因缺失/版本被拦，就算可满足；若依赖最终失败，收尾再逐条告警。
    const plannedOk = new Set(plan.filter((q) => q.action === 'load' || q.action === 'skip').map((q) => q.m.id));
    const okStatus = new Set(['loaded', 'skipped', 'upgraded']);
    const depSatisfied = (dep) => {
      const row = moduleReport.find((r) => r.id === dep);
      if (row) return okStatus.has(row.status);
      return plannedOk.has(dep);
    };
    let aborted = false;
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      const m = p.m;
      const row = { id: m.id, label: m.label, group: m.group, file: m.file, global: m.global, expected: m.expect, before: p.actual, after: p.actual, status: 'pending', ms: 0 };
      if (aborted) { row.status = 'aborted'; moduleReport.push(row); continue; }

      if (p.action === 'skip') { row.status = 'skipped'; moduleReport.push(row); continue; }
      if (p.action === 'blocked') { row.status = 'blocked'; moduleReport.push(row); continue; }

      const unmet = (m.dependsOn || []).filter((dep) => !depSatisfied(dep));
      if (unmet.length) {
        row.status = 'skipped-dependency';
        row.error = '依赖未就绪: ' + unmet.join(',');
        warnings.push(m.id + ' 跳过：依赖未就绪 ' + unmet.join(','));
        moduleReport.push(row);
        continue;
      }

      const t0 = Date.now();
      try {
        await client.injectFile(modulePath(root, m));
        row.ms = Date.now() - t0;
        const got = await client.eval(versionExpr([[m.id, m.versionPath]], 'module-' + m.id));
        const actual = got && got[m.id] != null ? String(got[m.id]) : null;
        row.after = actual;
        if (actual == null) {
          row.status = 'failed';
          row.error = '注入后未读到 ' + m.global + '（全局或版本路径缺失）';
        } else if (compareVersions(actual, m.expect) !== 0) {
          row.status = 'failed';
          row.error = '版本不符：期望 ' + m.expect + ' / 实际 ' + actual;
        } else {
          row.status = p.actual == null ? 'loaded' : 'upgraded';
        }
      } catch (e) {
        row.ms = Date.now() - t0;
        row.status = 'failed';
        row.error = String((e && e.message) || e);
      }
      moduleReport.push(row);

      if (row.status === 'failed' && m.group === 'required') {
        aborted = true; // 必需模块失败 → 立即中止，剩余标记 aborted
      }
      if (!o.quiet && !o.json) {
        const mark = row.status === 'loaded' ? 'loaded ' : row.status === 'skipped' ? 'skip   ' : row.status === 'upgraded' ? 'upgrade' : row.status === 'failed' ? 'FAILED ' : row.status;
        console.log(padRight('[' + (i + 1) + '/' + plan.length + ']', 9) + padRight(m.id, 14) + padRight(m.file.replace('scripts/funcs/', ''), 30) + mark + '  ' + (row.error ? row.error : (row.after || '')));
      }
    }

    // ④b 依赖复核：已装载但依赖最终失败的模块，逐条告警（不改其本身状态，避免把"装了"说成"没装"）
    for (const row of moduleReport) {
      if (!okStatus.has(row.status)) continue;
      const mm = MANIFEST.find((x) => x.id === row.id);
      const badDeps = (mm.dependsOn || []).filter((dep) => {
        const depRow = moduleReport.find((x) => x.id === dep);
        return depRow && !okStatus.has(depRow.status);
      });
      if (badDeps.length) {
        row.depMissing = badDeps;
        warnings.push(row.id + ' 已装载，但依赖最终未就绪: ' + badDeps.join(',') + '（调用相关能力前先修好）');
      }
    }

    // ⑤ 汇总 + 版本表
    // 版本证据优先级：收尾读取 > 逐模块注入时读回（row.after）> 预检读取 > unverified。
    // 收尾读取失败时绝不把已确认的 row.after 清空；仍无法确认的模块标 unverified 并拉低结论。
    const readForReport = moduleReport.map((r) => {
      const m = MANIFEST.find((x) => x.id === r.id);
      return [m.id, m.versionPath];
    });
    let finalLive = null;
    let finalReadFailed = false;
    try {
      finalLive = await client.eval(versionExpr(readForReport, 'closing'));
    } catch (e) {
      finalReadFailed = true;
      warnings.push('收尾版本读取失败（' + String((e && e.message) || e) + '），已回退到逐模块/预检读回值');
    }
    const versionTable = moduleReport.map((r) => {
      const m = MANIFEST.find((x) => x.id === r.id);
      const fromFinal = finalLive && finalLive[m.id] != null ? String(finalLive[m.id]) : null;
      const fromRow = r.after != null ? String(r.after) : null;
      const fromPreflight = live && live[m.id] != null ? String(live[m.id]) : null;
      const actual = fromFinal != null ? fromFinal : (fromRow != null ? fromRow : fromPreflight);
      const source = fromFinal != null ? 'final' : (fromRow != null ? 'per-module' : (fromPreflight != null ? 'preflight' : 'unverified'));
      if (actual != null) r.after = actual; // 只覆盖为已确认值，避免把确认结果写成空
      r.versionSource = source;
      if (actual == null) warnings.push(r.id + ' 版本未能确认（收尾读取失败且无逐模块/预检值）');
      return { id: m.id, label: m.label, group: m.group, global: m.global, versionKey: m.versionPath.join('.'), expected: m.expect, actual: actual, status: statusOf(m, actual), source: source };
    });
    const requiredRows = moduleReport.filter((r) => r.group === 'required');
    const optionalRows = moduleReport.filter((r) => r.group === 'optional');
    const rowOk = (r) => okStatus.has(r.status);
    const requiredVersionBad = versionTable.filter((v) => v.group === 'required' && v.status !== 'ok');
    const optionalVersionBad = versionTable.filter((v) => v.group === 'optional' && v.status !== 'ok');
    const coreOk = requiredRows.every(rowOk) && requiredVersionBad.length === 0;
    const optionalBad = optionalRows.filter((r) => !rowOk(r));
    const ok = coreOk && optionalBad.length === 0 && optionalVersionBad.length === 0 && missing.length === 0;
    // partial 严格=「必需模块失败导致中止」；可选缺失/失败只算 degraded。
    const partial = aborted;
    const degraded = coreOk && !ok;
    const unverified = versionTable.filter((v) => v.status === 'unverified').map((v) => v.id);
    const mismatched = versionTable.filter((r) => r.status === 'outdated' || r.status === 'newer').map((r) => ({ id: r.id, expected: r.expected, actual: r.actual }));

    const report = {
      ok: ok, coreOk: coreOk, degraded: degraded, partial: partial, aborted: aborted,
      abortReason: aborted ? 'required-failure' : null,
      versionRead: { finalReadFailed: finalReadFailed, unverified: unverified },
      scope: {
        coreModules: MANIFEST.length,
        required: MANIFEST.filter((m) => m.group === 'required').length,
        optional: MANIFEST.filter((m) => m.group === 'optional').length,
        excludes: [
          'scripts/funcs/query/metro-unopened-paths.js（可选数据注入，不在本清单）',
          'srhdata（window.__SUBMETRO_DATA / window.__MT_SUBMETRO_DATA，运行时注入数据，不在本清单）',
        ],
      },
      order: moduleReport.map((r) => r.id),
      root: root, cdp: client.cdp, at: new Date().toISOString(), durationMs: Date.now() - startedAt,
      counts: {
        selected: moduleReport.length,
        loaded: moduleReport.filter((r) => r.status === 'loaded').length,
        upgraded: moduleReport.filter((r) => r.status === 'upgraded').length,
        skipped: moduleReport.filter((r) => r.status === 'skipped').length,
        failed: moduleReport.filter((r) => r.status === 'failed').length,
        failedRequired: requiredRows.filter((r) => r.status === 'failed').length,
        failedOptional: optionalRows.filter((r) => r.status === 'failed').length,
        unverified: unverified.length,
        notRun: moduleReport.filter((r) => r.status === 'aborted' || r.status === 'skipped-dependency' || r.status === 'blocked').length,
        requiredOk: requiredRows.filter(rowOk).length,
        requiredTotal: requiredRows.length,
        optionalOk: optionalRows.filter(rowOk).length,
        optionalTotal: optionalRows.length,
      },
      missing: missing,
      mismatched: mismatched,
      modules: moduleReport,
      versionTable: versionTable,
      warnings: warnings,
    };

    // ⑥ 页面记录（best-effort；不改既有全局）
    try {
      await client.eval('(() => { window.__metroToolboxInjection = ' + JSON.stringify(report) + '; return true; })()');
    } catch (e) {
      warnings.push('页面报告写入失败: ' + String((e && e.message) || e));
    }

    if (o.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      say('');
      say('版本表');
      say(fmtTable([['id', '版本路径', '期望', '实际', '状态', '来源']].concat(versionTable.map((r) => [r.id, r.versionKey, r.expected, r.actual == null ? '—' : r.actual, r.status, r.source])), [14, 34, 8, 8, 11, 11]));
      if (mismatched.length) {
        say('');
        say('版本不符');
        for (const x of mismatched) say('  - ' + x.id + '  期望 ' + x.expected + ' / 实际 ' + x.actual);
      }
      if (warnings.length) {
        say('');
        say('警告');
        for (const w of warnings) say('  - ' + w);
      }
      say('');
      const c = report.counts;
      if (ok) {
        say('结论: 成功 · 必需 ' + c.requiredOk + '/' + c.requiredTotal + '，可选 ' + c.optionalOk + '/' + c.optionalTotal + '（新装 ' + c.loaded + ' / 升级 ' + c.upgraded + ' / 跳过 ' + c.skipped + '）');
      } else if (coreOk) {
        say('结论: 降级 · 必需全绿（' + c.requiredOk + '/' + c.requiredTotal + '），可选 ' + c.optionalOk + '/' + c.optionalTotal + ' 通过');
        for (const r of optionalBad) say('  可选未装: ' + r.id + (r.error ? ' —— ' + r.error : '（' + r.status + '）'));
        for (const m of optMissing) say('  可选缺失: ' + m.id + ' —— ' + m.file);
        say('  页面可用（核心功能不受影响）；需要该可选能力时修好原因后重跑，同版本会跳过。');
      } else {
        say('结论: 失败 · 必需 ' + c.requiredOk + '/' + c.requiredTotal + ' 通过' + (aborted
          ? '，必需模块失败已中止（partial=true，页面处于部分注入状态）'
          : '，但版本未能全部确认（unverified=' + c.unverified + '）'));
        for (const r of moduleReport.filter((x) => x.status === 'failed')) say('  失败: ' + r.id + ' —— ' + r.error);
        for (const r of moduleReport.filter((x) => x.status === 'skipped-dependency' || x.status === 'blocked')) say('  未装: ' + r.id + ' —— ' + (r.error || r.status));
        for (const v of versionTable.filter((x) => x.status === 'unverified')) say('  版本未确认: ' + v.id + '（' + v.versionKey + '）');
        if (aborted) say('  后续模块已中止（未执行），不是全部装好。');
        say('  修复后直接重跑：已装同版本会自动跳过，不会重复注入。');
      }
    }

    return ok ? EXIT.OK : (coreOk ? EXIT.DEGRADED : EXIT.FAIL);
  }

  if (require.main === module) {
    main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((e) => {
      console.error('注入器异常: ' + String((e && e.stack) || e));
      process.exitCode = EXIT.FAIL;
    });
  }

  module.exports = { MANIFEST, main, compareVersions, statusOf, verifyAgainst, versionExpr, dependencyOrder };
})();