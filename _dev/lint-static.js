#!/usr/bin/env node
/* 静态一致性检查（无依赖）：
 * 1) OD/K 的 this.xxx() 调用是否都有对应导出键
 * 2) MT 跨文件 MT.xxx() 调用是否都有赋值
 * 3) 文档 §10 提到的关键函数是否在运行时导出（由 smoke.js 覆盖）
 * 运行：node _dev/lint-static.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function exportKeys(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) return new Set();
  const keys = new Set();
  const body = src.slice(start);
  const re = /^\s{2,8}(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*(?:async\s+)?function\b|:\s*\{|:\s*[^,\n]+|\((?:[^)]*)\)\s*\{)/gm;
  let m;
  while ((m = re.exec(body))) keys.add(m[1]);
  return keys;
}

function thisCalls(src) {
  const out = new Set();
  const re = /\bthis\.([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return out;
}

const failures = [];
const od = read('scripts/funcs/draw/od.js');
const k = read('scripts/funcs/manage/k.js');
const odKeys = exportKeys(od, 'window.__officialDraw = {');
const kKeys = exportKeys(k, 'window.CityMetroKit = {');

for (const [name, src, keys] of [['OD', od, odKeys], ['K', k, kKeys]]) {
  const missing = [...thisCalls(src)].filter((n) => !keys.has(n) && !['constructor', 'hasOwnProperty'].includes(n));
  // 只报告看起来像本对象方法的调用（排除原生/局部变量误报：要求名称在 keys 附近出现过定义才算）
  const likelyMissing = missing.filter((n) => new RegExp('\\b' + n + '\\s*:\\s*function|^\\s{2,8}' + n + '\\s*:', 'm').test(src) === false);
  console.log(`${name}: export keys=${keys.size}, this-calls=${thisCalls(src).size}, unresolved=${likelyMissing.length}`);
  for (const n of likelyMissing) failures.push(`${name}.this.${n}() 无对应导出键`);
}

const mtFiles = ['scripts/funcs/query/mt-core.js', 'scripts/funcs/query/mt-node.js', 'scripts/funcs/query/mt-amap.js'];
const assigned = new Set();
for (const f of mtFiles) {
  const src = read(f);
  const re = /MT\.([A-Za-z_$][\w$]*)\s*=/g;
  let m;
  while ((m = re.exec(src))) assigned.add(m[1]);
}
const mtUses = new Set();
for (const f of mtFiles) {
  const src = read(f);
  const re = /\bMT\.([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src))) mtUses.add(m[1]);
}
const mtMissing = [...mtUses].filter((n) => !assigned.has(n));
console.log(`MT: assigned=${assigned.size}, called=${mtUses.size}, unresolved=${mtMissing.length}`);
for (const n of mtMissing) failures.push(`MT.${n}() 无赋值`);

if (failures.length) {
  console.error('LINT FAIL:\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log('LINT PASS');
