# 使用指南

> 一篇看完：快速上手 → 架构与不变量 → 排障。技能 v4.3 · 发行 beta1.2。

## 快速开始

目标：跑通「查询 → 绘制 → 检查 → 汇报」一条线。示例用上海 17 号线，城市/线路可换。

### 0. 前置条件

- 游戏 [Cities Designers](https://www.citiesdesigners.com) 已进入城市、存档就绪；**模式/存档界面由用户自己选**，AI 不代点。
- 能把 `scripts/funcs/*.js` 注入页面（浏览器控制台、CDP `Runtime.evaluate`、宿主 Agent 的脚本工具均可）。
- 能访问高德：默认数据源链是 srhdata → 游戏内高德 → 免费 Web → POI。

### 1. 按顺序注入

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

### 2. 查真实线位

```js
const r = await MT.queryLine('上海', '17', { stationFrom: '西岑', stationTo: '虹桥火车站' });
if (!r.ok) throw new Error(r.reason);
console.log(r.stations.length, r.pathQuality, r.dataSource, r.warnings);
```

- `warnings` 里的起讫点必须核对；终点不一致时显式传 `stationFrom` / `stationTo`（17 号线默认只回 13 站，指定后 14 站）。
- `pathQuality: 'straight'` 表示没有真实 path、节点是直线兜底，需要按图/走廊再精化。
- 环线用 `MT.queryRingLine`；未开通用 `MT.queryLineStopsByPOI`（必须带站表白名单或正向线证据）。

### 3. 绘制

```js
const fit = MT.fitSegmentNodes(r.stations, r.paths);        // 贴真实 path
const nodes = fit.map((seg) => MT.curvatureThin(seg));      // 抽稀（弯道加密、直线稀疏）
const lineId = await OD.createLine('17号线');
await OD.drawLine(lineId, r.stations, nodes, {});
OD.setLineProps(lineId, { color: r.color, trainType: r.trainType, trainCars: r.trainCars, maxSpeedKmh: r.maxSpeedKmh });
```

直写 `segmentAnchors` 的自定义流程（如 `OE.redrawAsSingle`）必须先 `MT.padSegmentNodes(stations, nodes, { endPadM: 100 })`。

### 4. 四检

```js
OD.checkLine3x(lineId, { strict: 'strict' });   // 结构 / 坐标 / 视觉 / 走向
```

节点乱序（折返 > 120° 或中点偏离首尾连线 > 500m）用 `OD.hasNodeOrderIssue` 定位、`OD.fixNodeOrder` 修复，修完复扫到 0 再收尾。

### 5. 汇报

按 `SKILL.md` §0.5 输出：做了什么 → 站数/节点数/颜色 → 检查结果 → 下一步建议；结尾给一个恰当的问题（确认/下一条/换城市/微调）。

### 6. 回滚与安全

```js
K.snapshot('绘制前');   // 改线前深拷贝站/节点/换乘
K.rollback(0);         // 需要时按索引回滚
K.listAudit();         // 改动审计
```

RED 风险（删整线、跨城覆盖、批量删除）未确认不执行；未知线路/自绘内容一律保留。

## 架构

> 代码基线：`scripts/funcs/`（拆分架构，唯一权威）。几何单一权威是 MT，OD / K / PlanMap / mt-amap 全部委托它，不本地复制。

### 分层

| 层 | 模块 | 全局对象 | 职责 |
|---|---|---|---|
| 基础设施 | `query/mt-core.js` | `__metroToolkit` | 坐标转换、城市/规格/配色、超时降级、POI 校验 |
| 几何 | `query/mt-node.js` | 同上 | Catmull-Rom 采样、`curvatureThin` 抽稀、`fitSegmentNodes` 拟合、`padSegmentNodes` 避让 |
| 数据源 | `query/mt-amap.js` | 同上 | 高德 srhdata / POI / SUBWAY path、OSM、有轨、瓦片、缓存 |
| 绘制 | `draw/od.js` | `__officialDraw` | 官方逐站绘制、支线、环线、换乘、四检 |
| 管理 | `manage/k.js` | `CityMetroKit` | 批量、快照回滚、风险拦截、命名、地区、校准 |
| 运营 | `ops/ops.js` | `MetroOps` | 客流、排班、票价、收益 |
| 托管 | `ops/autopilot.js` | `MetroAutopilot` | 有界循环、自递归优化、营收劣化回滚 |
| 经营编辑 | `manage/official-edit.js` | `OfficialEdit` | 配色/编组确认、官方延长/支线、额度报价 |
| 票价实验 | `manage/fare-lab.js` | `FareLab` | 调价记录、候选方案、前后对比 |
| 规划图 | `draw/plan-map.js` | `PlanMap` | 图纸 → 几何 → 官方绘制（离线管线 `scripts/plan-map.py`） |
| 多模式 | `modes/*` | `CityTransportModes` 等 | 高铁/航空适配器契约与只读探测 |

### 注入与版本守卫

```
mt-core → mt-node → mt-amap → od → k
        → (可选) ops → autopilot → official-edit → fare-lab → modes → plan-map
```

- 每个模块自带 `__version`，同版本重复注入直接跳过（版本守卫）。
- 改脚本必须同时：① bump 模块版本；② 同步 `_dev/smoke.js` 的 `EXPECT_VERSION`；③ 更新 `SKILL.md` §2.4 版本表。

### 数据流

```
高德/OSM 数据  ──queryLine──▶  站表 + SUBWAY path
                                   │
                         fitSegmentNodes（站投影 + 样条拟合 + 站台避让）
                                   │
                         curvatureThin（DP 保形 → 弯道加密 → 直线均匀 → minGap 过滤）
                                   │
                         OD.drawLine / applyLineData（官方接口逐站写入）
                                   │
                         checkLine3x（结构/坐标/视觉/走向）+ 节点顺序复扫
                                   │
                         汇报 / 快照回滚
```

### 关键不变量（改代码必须满足）

1. **几何单一权威 = MT**：距离、样条、抽稀、避让只允许一处实现。
2. **节点贴 path**：每段节点到本线 path 最大偏差 ≤ 30 m，超了必须重建该段。
3. **站台避让**：首末节点距两端车站 ≥ 100 m（`endPadM`）；剔空取两站中点，不回退站点。
4. **站序/节点顺序**：允许整线镜像，不允许相对乱序；乱序修完复扫到 0 才能补点。
5. **空段 = 用户设计**：无节点段视为有意直连，不自动补点。
6. **改数据先快照**：任何写线路数据的操作先 `K.snapshot`，可 `K.rollback`。
7. **官方接口优先**：绘制/增删改走 `top.*` 官方接口，脚本只做只读查询与计算。
8. **不抢前台**：禁止 `Page.bringToFront` / `SetForegroundWindow` 等，后台节流就如实报告倍率。

### 目录

```
SKILL.md              主指南（§0 全局硬规则 → §1-8 板块 → §9 特例 → §10 函数速查）
references/           专题文档（api-reference / official-draw / operations / plan-map-draw …）
scripts/funcs/        注入工具箱
scripts/plan-map.py   离线配准 + 追线
_dev/                 回归测试（lint / smoke / 几何 / POI / 支线环线 / Autopilot）
docs/                 本文档集（quickstart / architecture / FAQ / privacy / THIRD_PARTY）
```

### 扩展点

- 新交通模式：实现 `modes/mode-registry.js` 的适配器契约（`id` / 名称 / 探测 / 绘制能力），`hsr-probe.js`、`air-probe.js` 是只读样板。
- 新数据源：在 mt-amap 里加 `queryXxx` 并接入 `queryLine` 降级链，返回值保持 `{ ok, stations, nodes, pathQuality, dataSource }` 形状。
- 新检查项：加在 `OD.checkLine3x` 的对应维度，返回 `{ pass, detail }`，并补 `_dev/test-plan-draw.js` 用例。

### 回归

改几何/数据源/绘制必跑：`node _dev/smoke.js`、`node _dev/test-plan-draw.js`、`node _dev/test-plan-poi.js`、`node _dev/lint-static.js`；规划图改动加跑 `python _dev/test-plan-map.py`（需要 OpenCV）。

## 常见问题与排障

### 数据

**Q1. `queryLine` 查不到 / 站表不全？**

- 按降级链排查：srhdata → 游戏内高德 → 免费 Web → POI → OSM；`dataSource` 字段会写明实际用的源。
- 核对 `warnings` 的起讫点：高德同线多 plan 会少站（17 号线默认 13 站，指定西岑—虹桥火车站才 14 站）。延长段要用官方 `startExtendLine`。
- 环线只回半圈：改 `queryRingLine` 或逐段 `queryLineBySegments`。
- 未开通/在建：`queryLineStopsByPOI` / `queryUnopenedLine`；POI 必须有正向线证据或带 `opts.stations` 白名单，出入口/铁路/公交一律拒绝。
- 实在没有数据：按图/走廊/估算降级，但必须汇报数据源与冲突，不能默默用直线。

**Q2. 节点乱序、折返、绕路怎么办？**

- 先判：`OD.hasNodeOrderIssue(segments)` — 折返 > 120° 或中点偏离首尾连线 > 500 m 即乱序。
- 再修：`OD.fixNodeOrder`；修复后**必须复扫到 remaining = 0** 才能补点/收尾。置空段 = 两站直线直连，是安全的中间态。
- 绕路比异常：`OD.checkLine3x` 走向检查会给出折线/直线比（普通线 > 2.2 报警），重新按 path 拟合而不是硬删点。

**Q3. 节点钻进站台？**

- 所有直写 `segmentAnchors` 的路径先调 `MT.padSegmentNodes(stations, nodes, { endPadM: 100 })`；`fitSegmentNodes` 与 `applyLineData` ④b 已内置。
- 验收：每段首末节点到对应车站 ≥ 100 m；剔空段取中点，不要回退到站点本身。

### 绘制

**Q4. 环线 / 支线怎么画？**

- 环线：`OD.drawLine(id, stations, nodes, { isRing: true })`，`completeRingLine` 负责闭合，环线闭合段数 = 站数 N。
- 支线：走官方 `startBranchLine`（`startBranch → applyBranchData → setBranchAnchors → finishBranch`），取最长支为主线；支线直写节点前同样要避让。
- 延长：官方 `startExtendLine`，不要拆成两条独立线路。

**Q5. 重绘后线位变差 / 想整体重来？**

- 调整位置先删全部节点再重绘（`segmentAnchors` 置空 + `rebuildGeometry`），不要在旧节点上叠加。
- 重绘单条线 = 删整条旧线 + 完整重绘；**删线前备份换乘**（`window.__lineTransferBackup`，完成后按备份 `K.applyTransfer` 恢复并比对数量）。

### 规划图

**Q6. 按图绘制为什么要「客观第一」？**

- 图纸只作大致参考（站名/站序/颜色/走廊）；几何要结合真实地理自主设计，**不做像素拟合**。
- 像素拟合管线（`plan-map.py` 的 trace/`PlanMap.prepare` 图纸平滑链）保留给能力较弱的小模型，只在显式选择时启用。
- 验收用真实证据：站落路口/真实站台、线位到道路中心线中位 ≤ 30 m、到图纸走廊 ≤ 40 m 且弯点拓扑同构、最小曲线半径 ≥ 车型困难值。

### 运行环境

**Q7. 注入后没反应 / 版本没更新？**

- 版本守卫：同版本重复注入会被跳过。改脚本后必须 bump 版本（`__version`）再注入，否则页面还是旧逻辑。
- 核对目标页面是否同一个（多标签页各自独立）。

**Q8. 页面卡死 / 重载后线路没了？**

- 存档在 IndexedDB，数据不会丢；**模式/存档界面由用户自己选**，AI 不代点。
- `G.lines` 为空时，清掉恢复守卫（`_localDraftNoFlowRestoreGuard = {}` 等）再调 `tryRestoreLocalDraftNoFlowForCity('anycity-global')`；`metroSafeStartSkipsLocalDraft` 是函数，不要覆盖成布尔。
- 刷新一律 `redrawAllMetroOverlays`，不要 `location.reload()`。

**Q9. 中文变成乱码？**

- Windows Git Bash 的 curl 内联中文会按 GBK 发送。改用 CDP `/eval {b64}`、`browser_evaluate` 或 Node/Playwright 直传 UTF-8。

**Q10. 回归测试跑不起来？**

- `test-plan-map.py` 需要 OpenCV（`pip install opencv-python`）；纯 JS 用例（smoke / lint / plan-draw / plan-poi / branch-ring / autopilot）不需要 Python。

### 经营

**Q11. 票价默认多少？**

- 经营模式默认官方五段 `1/2/3/4/5`（边界 0/6/12/22/32/∞，对齐成本带与补贴）；创意模式的小网络才用需求弹性。
- 购配额必须用官方递增报价 `metroPurchaseQuote(item, 数量)`，每次购买前重新报价，并留日结与建设缓冲。

**Q12. Autopilot 怎么用，会不会乱来？**

- 仅经营模式：`MetroAutopilot.start({ intervalMs, maxTicks, buyPacks, dryRun, analysisEvery })`。
- 有界循环 + LIMITS 安全边界 + 营收劣化自动回滚；不存档、不抢前台、不绕配额。建议先 `dryRun: true` 观察一轮日志。

### 安全

**Q13. 误删 / 改错能回滚吗？**

- 改前 `K.snapshot('标签')`，改后 `K.listAudit()` 可查，`K.rollback(索引或 id)` 即时回滚；`deleteLine` / `deleteCityLine` 内置自动快照。
- 未知线路（数据源不认识的线）坐标/走向/颜色/命名**全部保留**，只有可证同一的官方站才动。
