# 快速开始（3 分钟）

目标：跑通「查询 → 绘制 → 检查 → 汇报」一条线。示例用上海 17 号线，城市/线路可换。

## 0. 前置条件

- 游戏 [Cities Designers](https://www.citiesdesigners.com) 已进入城市、存档就绪；**模式/存档界面由用户自己选**，AI 不代点。
- 能把 `scripts/funcs/*.js` 注入页面（浏览器控制台、CDP `Runtime.evaluate`、宿主 Agent 的脚本工具均可）。
- 能访问高德：默认数据源链是 srhdata → 游戏内高德 → 免费 Web → POI。

## 1. 按顺序注入

顺序不能乱（几何依赖 MT，OD 依赖 MT，K 依赖 OD）；同版本重复注入会被版本守卫跳过。

| 顺序 | 文件 | 注入后全局 |
|---|---|---|
| 1 | `query/mt-core.js` | `__metroToolkit` |
| 2 | `query/mt-node.js` | 同上（几何） |
| 3 | `query/mt-amap.js` | 同上（数据源） |
| 4 | `draw/od.js` | `__officialDraw` |
| 5 | `manage/k.js` | `CityMetroKit` |
| 6（可选） | `ops/ops.js` → `ops/autopilot.js` | `MetroOps` / `MetroAutopilot` |
| 7（可选） | `manage/official-edit.js`、`manage/fare-lab.js` | `OfficialEdit` / `FareLab` |
| 8（可选） | `modes/mode-registry.js` 等 | `CityTransportModes` 等 |
| 9（可选） | `draw/plan-map.js` + 离线 `scripts/plan-map.py` | `PlanMap` |

## 2. 查真实线位

```js
const r = await MT.queryLine('上海', '17', { stationFrom: '西岑', stationTo: '虹桥火车站' });
if (!r.ok) throw new Error(r.reason);
console.log(r.stations.length, r.pathQuality, r.dataSource, r.warnings);
```

- `warnings` 里的起讫点必须核对；终点不一致时显式传 `stationFrom` / `stationTo`（17 号线默认只回 13 站，指定后 14 站）。
- `pathQuality: 'straight'` 表示没有真实 path、节点是直线兜底，需要按图/走廊再精化。
- 环线用 `MT.queryRingLine`；未开通用 `MT.queryLineStopsByPOI`（必须带站表白名单或正向线证据）。

## 3. 绘制

```js
const fit = MT.fitSegmentNodes(r.stations, r.paths);        // 贴真实 path
const nodes = fit.map((seg) => MT.curvatureThin(seg));      // 抽稀（弯道加密、直线稀疏）
const lineId = await OD.createLine('17号线');
await OD.drawLine(lineId, r.stations, nodes, {});
OD.setLineProps(lineId, { color: r.color, trainType: r.trainType, trainCars: r.trainCars, maxSpeedKmh: r.maxSpeedKmh });
```

直写 `segmentAnchors` 的自定义流程（如 `OE.redrawAsSingle`）必须先 `MT.padSegmentNodes(stations, nodes, { endPadM: 100 })`。

## 4. 四检

```js
OD.checkLine3x(lineId, { strict: 'strict' });   // 结构 / 坐标 / 视觉 / 走向
```

节点乱序（折返 > 120° 或中点偏离首尾连线 > 500m）用 `OD.hasNodeOrderIssue` 定位、`OD.fixNodeOrder` 修复，修完复扫到 0 再收尾。

## 5. 汇报

按 `SKILL.md` §0.5 输出：做了什么 → 站数/节点数/颜色 → 检查结果 → 下一步建议；结尾给一个恰当的问题（确认/下一条/换城市/微调）。

## 6. 回滚与安全

```js
K.snapshot('绘制前');   // 改线前深拷贝站/节点/换乘
K.rollback(0);         // 需要时按索引回滚
K.listAudit();         // 改动审计
```

RED 风险（删整线、跨城覆盖、批量删除）未确认不执行；未知线路/自绘内容一律保留。
