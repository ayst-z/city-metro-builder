# 一键批量操作指南（CityMetroKit）

本文档整合本 skill 全部**一键批量操作**的操作指南（原 `scripts/import-city.js`、`add-nodes.js`、`apply-colors.js` 内容 + `core.js` 全功能）。前置：`scripts/core.js` 已注入，`K = window.CityMetroKit`。所有操作脚本绕过 UI，最后自动刷新画面（不刷新网址）。

> ⚠️ **使用原则（用户定义）**：
> - **默认全部使用官方接口**；批量/一键操作用脚本前，**必须先询问用户是否使用脚本**，未获确认不用脚本。
> - **脚本仅用于"绘制完整线路"**（一次性放完车站+节点）。其他操作（导入/配色/节点/站名/修复/换乘等）默认官方接口逐步执行，用户明确要求脚本时才用脚本。
> - 本节的脚本片段仅供用户确认使用脚本时参考。

**触发文本 → 操作对照**（用户一句话即可对应执行）：

| 用户说的话 | 执行操作 |
|---|---|
| "导入上海地铁线路" | 第 1 节：**多次导入单条线**（逐条导入，不批量） |
| "导入上海地铁，只选已建成" / "在建+规划" | 第 1 节 + 状态筛选 |
| "应用官方配色" / "修改14号线为官方颜色" | 第 2 节：官方标准颜色 |
| "添加实际走向节点" / "为12号线补节点" | 第 3 节：走向节点 |
| "实施官方站名" / "改站名" | 第 4 节：官方站名 |
| "修复地铁线路" / "修一下线路" | 第 5 节：修复线路 |
| "修复换乘关系" / "修复换乘" | 第 6 节：修复换乘 |
| "选择命名规则 cn_metro" / "改成上海地铁X号线" | 第 7 节：命名规则 |
| "只要在建 / 只看已建成 / 隐藏规划线" | 第 8 节：分类筛选 |
| "显示上海状态 / 按地区分组" | 第 9 节：地区识别+状态报告 |

---

## 1. 多次导入单条线（不再支持一键批量导入多条）

> ⚠️ **设计变更（2026-08）**：**删除"批量导入多条线"功能**。导入一律**多次导入单条线**——一次只导入 1 条完整线路（站+站名+节点+颜色+命名），导入多条 = 重复执行多次单条导入。原因：批量导入易混淆命名/状态、出错难定位，逐条导入可每条独立校验、符合"绘制必检"原则。

**数据来源**：`references/` 下的城市线路数据文件（结构见下），或用户提供。**每条一个对象**（不是数组）。

```js
// 单条线路数据结构示例（一次只处理一条）：
const LINE = {
  name: '上海地铁14号线',        // 最终线路名
  short: '14',                   // UI 创建时输入的短名
  color: '#626020',              // 官方颜色
  status: 'built',               // built=已建成 / under_construction=在建 / planned=规划
  stations: ['封浜', '乐秀路', '临洮路', '曹杨路', ...]  // 官方站名（顺序）
};
```

**流程**（agent 用浏览器工具操作，**一次只导入一条，导入完再处理下一条**）：
1. **UI 创建空线路**：`click_element('添加地铁线路')` → `type_in_page(名称框, 短名如 "14")` → `click_element('开始铺设轨道')`。
2. **evaluate 顺序取坐标 + 铺站**（关键：高德顺序查询，勿并发）：
```js
const r = await page.evaluate(async () => {
  const l = G.lines.find(x => x.stations && x.stations.length === 0);
  if (!l) return { err: 'no new line' };
  l.name = '上海地铁14号线'; l.nameEn = 'Shanghai Metro Line 14';
  l.color = '#626020'; l._lineNameCustomizedByUser = true;
  const res = await CityMetroKit.geocode(['封浜', '乐秀路', '临洮路', ...]); // 批量顺序查
  const placed = CityMetroKit.placeStations(l.id, res.filter(r => r.ok).map(r => ({ name: r.name, lat: r.lat, lng: r.lng })));
  return { id: l.id, placed: placed.placed, failed: res.filter(r => !r.ok).map(r => r.name) };
});
```
3. **收尾**（结束放置 + 节点 + 修复）：
```js
const r = await page.evaluate((id) => {
  if (typeof confirmCreateLine === 'function') confirmCreateLine();
  const l = G.lines.find(x => x.id === id);
  CityMetroKit.addNodes(l.id, 2500, { density: 'standard' });  // 节点密度档：sparse/standard/dense
  return CityMetroKit.fixLine(l.id);
}, '线路id');
```
4. **换乘**：本条线导入完成后立即 `fixTransfers()`（换乘全库修复，一条一修复，勿攒批）。
5. **校验**：本条线 `OD.checkLine3x` 通过后，才进行下一条。
6. **保存**：全部导入完 `page.keyboard.press('Control+s')`。

**状态筛选**：用户说"只选已建成/在建/规划"时按 `status` 过滤数据源（单条判断）：
```js
['built', 'under_construction'].includes(LINE.status)  // 已建成+在建才导入
```

---

## 2. 一键修改官方标准颜色

**触发**："应用官方配色" / "修改X号线为官方颜色" / "只改已建成"。

**获取官方调色板**（游戏内置）：
```js
const r = await page.evaluate(() => typeof getOfficialMetroPaletteRaw === 'function' ? getOfficialMetroPaletteRaw() : null);
// 结构：{ shanghai: { '1号线': '#E3002B', '2号线': '#82BF25', ... } }
```

**一键应用到全部/部分线路**（推荐：从数据文件读取配色映射）：
```js
const r = await page.evaluate(() => {
  const colorMap = {
    '上海地铁1号线': '#E3002B', '上海地铁2号线': '#82BF25',
    '上海地铁3号线': '#FCD600', '上海地铁4号线': '#461D84',
    '上海地铁5号线': '#944D9A', '上海地铁6号线': '#D40068',
    '上海地铁7号线': '#ED6F00', '上海地铁8号线': '#0094D8',
    '上海地铁9号线': '#87CAED', '上海地铁10号线': '#C6AFD4',
    '上海地铁11号线': '#871C2B', '上海地铁12号线': '#007B61',
    '上海地铁13号线': '#E999C0', '上海地铁14号线': '#626020',
    '上海地铁15号线': '#BCA886', '上海地铁16号线': '#98D1C0',
    '上海地铁17号线': '#BC796F', '上海地铁18号线': '#C4984F',
    '上海磁悬浮线': '#008B9A', '上海市域机场线': '#3D6B8A'
  };
  return CityMetroKit.applyOfficialColors(colorMap);  // 批量：内部已 K.repaint()
});
```
**单条快速改色**（同一函数，传 (线路名/id, 颜色)）：
```js
const r = await page.evaluate(() => CityMetroKit.applyOfficialColors('上海地铁14号线', '#626020'));
```
自动刷新 UI，无需额外操作；可用 `screenshot_page` 确认。

---

## 3. 一键添加实际走向节点

**触发**："添加实际走向节点"（全部）/ "为X号线添加走向节点"（单条）/ "补全所有线路的节点"。

说明：`segmentAnchors[i]` 对应 `stations[i]`↔`stations[i+1]` 之间的节点数组；空数组 = 两站间直线。算法：长段(>2500m)在 1/3、2/3 处各加 1 节点，短段在中点加 1 节点。

```js
// 单条（默认标准密度）
const r = await page.evaluate(() => CityMetroKit.addNodes('上海地铁12号线'));
// 返回：{ nodes: 27, perSeg: [1,2,1,...] }

// 节点密度档位（2026-08 新增）：sparse=稀疏(长段多1节点) / standard=标准(默认) / dense=密集
const r = await page.evaluate(() => CityMetroKit.addNodes('上海地铁17号线', null, { density: 'dense' }));

// 自定义长段阈值（米）
const r = await page.evaluate(() => CityMetroKit.addNodes('上海地铁17号线', 3000));  // 3km 以上才 2 节点
```
> `addNodes` 内部自动 `rebuildGeometry()`（重绘全部），无需额外刷新。完成后 Ctrl+S 保存。

**⚠️ 防卡死（修复大量线路的节点时必用）**：
批量（`addNodes('all', ...)`）内部逐条轻量重绘 + 分批间隔 + 最后统一刷新一次，避免一次性大量全量重绘触发客流重算/卡死。**优先逐条补节点**（每次一条，完成校验后再下一条），仅在用户明确要求"全部线路补节点"时才用批量版。

**批量补节点 `addNodes('all', ...)`**（逐条补节点 + 轻量重绘不调全量 + 分批间隔 + 最后统一刷新一次）：
```js
// 防卡死批量补节点（建议配合性能模式 setMetroPerformanceMode(true)）
const r = await page.evaluate(async () => {
  const K = window.CityMetroKit;
  // 'all'=全部线路；batch=每10条暂停250ms 让浏览器喘息；支持 density 档位
  return await K.addNodes('all', 2500, { batch: 10, gapMs: 250, density: 'standard' });
});
// 指定线路数组：K.addNodes(['线A_id','线B_id'], 2500, {...})
```
**改善要点**：①性能模式禁用客流重算 ②逐条轻量重绘（`addNodes(id, longSeg, {light:true})` 不调 `redrawAllMetroOverlays`）③分批间隔 ④最后统一 `K.repaint()` 一次。

---

## 4. 一键实施官方站名

**触发**："实施官方站名" / "改站名"。

```js
const r = await page.evaluate(() =>
  CityMetroKit.applyStationNames('上海地铁14号线', ['封浜', '乐秀路', '临洮路', ...])  // 与 stations 等长
);
// 返回：{ changed: 17 }（坐标保留，只替换站名）
```

**坐标校准**（用高德准确坐标修正站点位置）：
```js
const r = await page.evaluate(() =>
  CityMetroKit.calibrateCoordinates('上海地铁14号线', [{ name: '封浜', lat: 31.23, lng: 121.34 }, ...])
);
// 返回：{ updated: [...], missing: [...] }
```

---

## 5. 一键修复地铁线路

**触发**："修复地铁线路" / "修一下线路"。

```js
// 单条：重建几何、清理缓存、恢复段锚点、保证站名唯一、重绘
const r = await page.evaluate(() => CityMetroKit.fixLine('上海地铁14号线'));
// 返回：{ ok, name, segmentAnchorsFixed?, geometry: [...], renamedDup? }

// 全部
const r = await page.evaluate(() => CityMetroKit.fixLine('all'));
```
删除线路：`CityMetroKit.deleteLine('上海地铁14号线')`（调用官方 `deleteLine`）。

---

## 6. 一键修复换乘关系

**触发**："修复换乘关系" / "修复换乘"。

```js
const r = await page.evaluate(() => CityMetroKit.fixTransfers());
// 同名站点跨线路自动标记 isTransfer + 同步换乘组名称 + 刷新换乘视觉缓存 + K.repaint()
// 返回：{ transfers: [{ name, lines, count }] }
```
> 进阶：绘制单条线路后自动精确换乘用 `OD.autoTransfers`（见 official-draw.md 第 3.5 节，高德查换乘伙伴 + 官方建组）。

---

## 7-10. 全局选项 / 命名规则 / 分类筛选 / 地区识别（与 SKILL.md 相同）

- **全局选项**：`K.setOpts({...})` / `K.opt()` / `K.resetOpts()`（density/dataSource/drawMode/autoTransfers/autoSave/checkStrict/namingRule/deleteOld/endPadM，详见 SKILL.md「批量管理功能」⓪）
- **命名规则**：`K.applyNaming(city, 线号或数组, rule)`（单条返回字符串、批量返回数组）
- **分类筛选**：`K.setLineStatus(id/'all', status)` 设置 / `K.setLineStatus(null, [status数组])` 筛选
- **地区识别**：`K.regionOf` / `K.linesByRegion` / `K.status` / `K.regions`
> 触发词："选择命名规则 / 改成上海地铁X号线 / 只要在建 / 只看已建成 / 隐藏规划线 / 显示上海状态 / 按地区分组 / 长三角有哪些线 / 密度dense / 严格检查"。

---

## 通用收尾

- **重绘**：`K.repaint()`（全部）/ `K.repaint(l)`（单条）/ `K.rebuildGeometry(l)`（清缓存重建）
- **弹窗**：绘制过程产生的侧栏/弹窗用 `read_page` 检查，必要时点"×"手动关闭
- **保存**：`page.keyboard.press('Control+s')`（= 官方 `downloadLocalSave()`）

